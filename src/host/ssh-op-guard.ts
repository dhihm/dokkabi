/**
 * op/argument coherence for the ssh tool.
 *
 * The live failure: the model sent `{op:"status", command:"echo HELLO"}`. The
 * plugin's status branch ignored the extra fields and returned the status
 * string, so the command never ran — but the model believed it had, and
 * looped forever "confirming" work that never happened. A status carries no
 * arguments; exec carries a command/script; the transfer ops carry
 * local/remote (or source/dest). When the fields do not match the op, refuse
 * with a message that names the mismatch, so the model corrects its `op`
 * instead of being silently swallowed.
 */

type SshParams = Record<string, unknown>;

const EXEC_FIELDS = ["command", "script", "timeout"] as const;
const TRANSFER_FIELDS = [
  "local", "remote", "source_target", "source_remote", "dest_target", "dest_remote", "recursive", "direction", "delete",
] as const;
const WAIT_FIELDS = ["probe", "until", "interval_ms", "deadline_ms"] as const;
const ENROLL_FIELDS = ["alias", "address"] as const;

function present(params: SshParams, fields: readonly string[]): string[] {
  return fields.filter((field) => params[field] !== undefined);
}

/** Returns a refusal message when the arguments do not fit the op, else undefined. */
export function sshOpMismatch(params: SshParams): string | undefined {
  const op = params.op;

  if (op === "status") {
    // A status carrying enroll fields is an enroll the model mislabelled —
    // say THAT, not the generic "status takes no arguments" (live: three
    // identical op=status calls with alias+address, each answered only by the
    // coordinate guard, which never mentions the op field).
    const enrollFields = present(params, ENROLL_FIELDS);
    if (enrollFields.length > 0) {
      return `ssh op=status takes no arguments — you passed ${enrollFields.join(", ")}, which belong to enrollment. `
        + "To register a host, send op=enroll with alias=<letter-led name> and address=<[user@]host[:port]>; then use op=exec target=<alias>.";
    }
    const stray = present(params, [...EXEC_FIELDS, ...TRANSFER_FIELDS, ...WAIT_FIELDS]);
    if (stray.length > 0) {
      return `ssh status takes no arguments — you set op=status but also passed ${stray.join(", ")}. `
        + "op=status only reports the SSH transport; to run a command use op=exec, to move files use op=put/get/copy/sync.";
    }
    return undefined;
  }

  if (op === "exec") {
    const enrollFields = present(params, ENROLL_FIELDS);
    if (enrollFields.length > 0) {
      return `ssh op=exec does not take ${enrollFields.join(", ")}. To register a host use op=enroll (alias, address); to run a command use op=exec with target=<alias> and command.`;
    }
    const stray = present(params, [...TRANSFER_FIELDS, ...WAIT_FIELDS]);
    if (stray.length > 0) {
      return `ssh op=exec runs a command and does not take ${stray.join(", ")}. `
        + "Use op=put/get/copy/sync for file transfer, or op=wait to poll a condition.";
    }
    return undefined;
  }

  if (op === "wait") {
    const stray = present(params, [...EXEC_FIELDS.filter((f) => f !== "timeout"), ...TRANSFER_FIELDS]);
    if (stray.length > 0) {
      return `ssh op=wait polls a probe and does not take ${stray.join(", ")}.`;
    }
    return undefined;
  }

  if (op === "put" || op === "get" || op === "sync" || op === "copy") {
    const stray = present(params, [...EXEC_FIELDS, ...WAIT_FIELDS]);
    if (stray.length > 0) {
      return `ssh op=${op} moves files and does not take ${stray.join(", ")}. Use op=exec to run a command.`;
    }
    return undefined;
  }

  return undefined;
}

/**
 * The op the arguments unambiguously describe, when that differs from the op
 * declared. Live, `{op:"status", target, command}` arrived 35 times in one run:
 * every refusal was correct and none of them taught, until the loop guard
 * tripped. When exactly one op family is present the intent is not a guess, so
 * the harness acts on it instead of spending a round trip saying no. Approval
 * still gates the call, so routing costs no safety.
 *
 * Returns undefined when the declared op already fits, when nothing identifies
 * another op, or when more than one family is present — an ambiguous call is
 * still the refusal's business.
 */
export function sshOpIntent(params: SshParams): string | undefined {
  const families: Array<{ op: string; fields: readonly string[] }> = [
    { op: "enroll", fields: ENROLL_FIELDS },
    { op: "wait", fields: WAIT_FIELDS },
    { op: "exec", fields: EXEC_FIELDS },
    { op: "transfer", fields: TRANSFER_FIELDS },
  ];
  const seen = families.filter((family) => present(params, family.fields).length > 0);
  if (seen.length !== 1) return undefined;
  const intended = seen[0]!.op;
  // Transfer spans four ops (put/get/copy/sync); which one is the model's to
  // say, so a transfer-shaped call is never rerouted on its behalf.
  if (intended === "transfer") return undefined;
  if (intended === params.op) return undefined;
  // A wait needs its whole shape before it can be run as one.
  if (intended === "wait" && present(params, WAIT_FIELDS).length < 3) return undefined;
  return intended;
}
