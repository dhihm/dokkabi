import { codeSessionIsBound } from "../code-evolution/session-binding.ts";
import { realpathSync, statSync } from "node:fs";
import { z } from "zod";
import { canonicalJson } from "./canonical.ts";
import { EventLog } from "./event-log.ts";
import { containsSecret } from "./redact.ts";
import type { EventRecord } from "./schema.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reference = z.strictObject({ seq: z.number().int().positive(), hash: digest });
const fileVersion = z.strictObject({
  root: z.string().min(1).max(128),
  path: z.string().min(1).max(4096),
  digest,
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const requestSchema = z.strictObject({
  sessionId: z.string().min(1).max(256),
  source: reference,
  commit: reference,
  file: fileVersion,
});
export type MutationReceiptRequest = z.infer<typeof requestSchema>;

export class MutationReceiptRefusal extends Error {
  constructor(readonly code: string) {
    super(`Code evolution receipt refused: ${code}`);
    this.name = "MutationReceiptRefusal";
  }
}

function refuse(code: string): never {
  throw new MutationReceiptRefusal(code);
}
function ref(row: EventRecord) {
  return { seq: row.seq, hash: row.hash };
}
function matchingRow(
  rows: readonly EventRecord[],
  wanted: { seq: number; hash: string },
): EventRecord {
  const row = rows[wanted.seq - 1];
  if (!row || row.seq !== wanted.seq || row.hash !== wanted.hash) refuse("reference_mismatch");
  return row;
}
function pathIsSafe(path: string): boolean {
  return (
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
    !containsSecret(path)
  );
}
function sameVersion(a: unknown, b: unknown, identity: boolean): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  const x = a as Record<string, unknown>,
    y = b as Record<string, unknown>;
  return (
    digest.safeParse(x.digest).success &&
    x.digest === y.digest &&
    Number.isSafeInteger(x.bytes) &&
    Number(x.bytes) >= 0 &&
    x.bytes === y.bytes &&
    (!identity ||
      (typeof x.identity === "string" &&
        x.identity.length > 0 &&
        x.identity.length <= 256 &&
        x.identity === y.identity))
  );
}

/** Host-owned projection. It reads only its owner's durable EventLog, never a
 * caller-selected path or live source body. A link is not exclusive authorship. */
export class CodeEvolutionReceiptService {
  readonly #root: string;
  readonly #sessionId: string;
  readonly #logPath: string;
  #revoked = false;
  constructor(owner: { log: EventLog; sessionId: string; workspaceRoot: string }) {
    const stat = statSync(realpathSync(owner.workspaceRoot), { bigint: true });
    this.#root = `${stat.dev}:${stat.ino}`;
    this.#sessionId = owner.sessionId;
    this.#logPath = owner.log.path;
  }

  revoke(): void {
    this.#revoked = true;
  }

  read(input: unknown) {
    if (this.#revoked) refuse("revoked");
    return readRecordedMutation(
      { logPath: this.#logPath, sessionId: this.#sessionId, rootId: this.#root },
      input,
    );
  }
}

/** Cold historical verification uses the repository identity authenticated by
 * its recorded structural-version observation, never a renderer-selected root. */
export function readRecordedMutation(
  owner: { logPath: string; sessionId: string; rootId: string },
  input: unknown,
) {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) refuse("invalid_request");
  const request = parsed.data;
  if (request.sessionId !== owner.sessionId) refuse("foreign_session");
  if (request.file.root !== owner.rootId || !pathIsSafe(request.file.path))
    refuse("foreign_file_scope");
  let verified: EventLog;
  try {
    verified = new EventLog(owner.logPath, { readOnly: true });
  } catch {
    return refuse("retained_log_invalid");
  }
  const source = matchingRow(verified.events, request.source);
  const rows = verified.events.slice(0, source.seq);
  if (
    rows.some(
      (row) =>
        typeof row.name !== "string" ||
        row.payload === null ||
        typeof row.payload !== "object" ||
        Array.isArray(row.payload),
    )
  )
    refuse("retained_log_invalid");
  if (!codeSessionIsBound(rows, owner.sessionId)) refuse("session_binding_invalid");
  const commit = matchingRow(rows, request.commit);
  const p = commit.payload;
  if (commit.kind !== "observe" || commit.name !== "workspace/mutation_committed")
    refuse("not_committed");
  if (p.root !== request.file.root || p.path !== request.file.path) refuse("foreign_file_scope");
  const after = p.after as Record<string, unknown> | undefined;
  if (
    !after ||
    after.digest !== request.file.digest ||
    after.bytes !== request.file.bytes ||
    typeof after.identity !== "string" ||
    after.identity.length === 0 ||
    after.identity.length > 256
  )
    refuse("file_version_mismatch");
  if (
    p.guarantee !== "checked_native" ||
    typeof p.binding !== "string" ||
    !["linux_fd_anchored", "portable_link_safe"].includes(p.binding)
  )
    refuse("guarantee_unavailable");
  if (
    typeof p.kind !== "string" ||
    !["create", "write", "edit", "spans"].includes(p.kind) ||
    typeof p.route !== "string" ||
    !["native", "api", "promotion"].includes(p.route)
  )
    refuse("mutation_schema_invalid");
  if (
    typeof p.operation !== "string" ||
    !p.operation ||
    p.operation.length > 256 ||
    typeof p.tool !== "string" ||
    !p.tool ||
    p.tool.length > 128 ||
    typeof p.call !== "string" ||
    !p.call ||
    p.call.length > 256
  )
    refuse("completion_unbound");
  const operationRows = rows.filter(
    (row) => row.name.startsWith("workspace/mutation_") && row.payload.operation === p.operation,
  );
  const intents = operationRows.filter(
    (row) => row.name === "workspace/mutation_intent" && row.kind === "observe",
  );
  const closures = operationRows.filter((row) =>
    [
      "workspace/mutation_committed",
      "workspace/mutation_refused",
      "workspace/mutation_reconciled",
    ].includes(row.name),
  );
  if (
    operationRows.length !== 2 ||
    intents.length !== 1 ||
    closures.length !== 1 ||
    closures[0]?.seq !== commit.seq
  )
    refuse("operation_ambiguous");
  const intent = intents[0]!;
  const i = intent.payload;
  if (
    intent.seq >= commit.seq ||
    ["operation", "root", "path", "tool", "call", "kind", "route", "receipt"].some(
      (key) => canonicalJson(i[key]) !== canonicalJson(p[key]),
    ) ||
    !sameVersion(i.before, p.before, true) ||
    !sameVersion(i.after, p.after, false)
  )
    refuse("intent_mismatch");
  if (
    rows.some(
      (row) =>
        row.seq > commit.seq &&
        row.name.startsWith("workspace/mutation_") &&
        row.payload.root === p.root &&
        row.payload.path === p.path,
    )
  )
    refuse("superseded");

  // Call ids may be reused in later turns. Bind this exact outstanding call
  // interval; neither an old successful end nor a new call may settle it.
  const calls = rows.filter(
    (row) => row.kind === "observe" && row.name === "tool/call" && row.payload.id === p.call,
  );
  const call = calls.filter((row) => row.seq < intent.seq).at(-1);
  if (
    !call ||
    call.payload.name !== p.tool ||
    !digest.safeParse(call.payload.args_digest).success ||
    call.payload.parent !== undefined
  )
    refuse("completion_unbound");
  for (const earlier of calls.filter((row) => row.seq < call.seq)) {
    const boundary = calls.find((row) => row.seq > earlier.seq)!.seq;
    const settled = rows.filter(
      (row) =>
        row.seq > earlier.seq &&
        row.seq < boundary &&
        ["tool/result", "tool/end"].includes(row.name) &&
        row.payload.id === p.call,
    );
    const oldResult = settled[0],
      oldEnd = settled[1];
    if (
      settled.length !== 2 ||
      oldResult?.name !== "tool/result" ||
      oldResult.kind !== "surface" ||
      oldEnd?.name !== "tool/end" ||
      oldEnd.kind !== "observe" ||
      oldEnd.seq !== oldResult.seq + 1 ||
      typeof earlier.payload.name !== "string" ||
      oldResult.payload.tool !== earlier.payload.name ||
      oldEnd.payload.name !== earlier.payload.name ||
      typeof oldResult.payload.error !== "boolean" ||
      oldEnd.payload.error !== oldResult.payload.error
    )
      refuse("completion_ambiguous");
  }
  const next = calls.find((row) => row.seq > call.seq)?.seq ?? source.seq + 1;
  const completions = rows.filter(
    (row) =>
      row.seq > call.seq &&
      row.seq < next &&
      ["tool/result", "tool/end"].includes(row.name) &&
      row.payload.id === p.call,
  );
  const results = completions.filter((row) => row.name === "tool/result"),
    ends = completions.filter((row) => row.name === "tool/end");
  if (results.length !== 1 || ends.length !== 1) refuse("completion_unbound");
  const result = results[0]!,
    end = ends[0]!;
  if (
    result.seq <= commit.seq ||
    result.kind !== "surface" ||
    end.kind !== "observe" ||
    end.seq !== result.seq + 1 ||
    result.payload.tool !== p.tool ||
    end.payload.name !== p.tool ||
    result.payload.error !== false ||
    end.payload.error !== false ||
    typeof result.payload.text !== "string" ||
    result.payload.execution !== undefined ||
    end.payload.execution !== undefined ||
    (result.payload.exit_code !== undefined && result.payload.exit_code !== 0) ||
    (end.payload.exit_code !== undefined && end.payload.exit_code !== 0) ||
    (end.payload.args_digest !== undefined && end.payload.args_digest !== call.payload.args_digest)
  )
    refuse("completion_failed");

  // Fresh values on each read cannot mutate either cached or durable truth.
  const before = p.before as { digest: string; bytes: number; identity: string } | null;
  return {
    schemaVersion: 1 as const,
    verification: "linked_recorded_tool_change" as const,
    sessionId: request.sessionId,
    source: ref(source),
    file: { ...request.file },
    operation: p.operation,
    tool: p.tool,
    kind: p.kind,
    route: p.route,
    guarantee: "checked_native" as const,
    binding: p.binding,
    intent: ref(intent),
    commit: ref(commit),
    call: ref(call),
    result: ref(result),
    end: ref(end),
    before:
      before === null
        ? null
        : { digest: before.digest, bytes: before.bytes, identity: before.identity },
    exclusiveAuthorship: false as const,
    taskSuccess: "not_established" as const,
  };
}
