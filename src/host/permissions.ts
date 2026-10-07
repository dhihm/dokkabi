import type { EventLog } from "./event-log.ts";

/**
 * `auto` is the default. For approvals it is `ask`: every consumer asks
 * "is this bypass?", so auto widens no authority there. Where it differs is
 * how a step's tool profile treats a tool outside it (loader/tool-profile-policy.ts):
 * ask refuses and says how to widen, auto widens that step's profile and
 * records it, bypass runs the call and records it.
 */
export type PermissionMode = "ask" | "auto" | "bypass";
/**
 * Where the mode in force came from. `env` and `config` exist because an
 * unattended operator runs every command — chat, work, turn, resume, the
 * HEUNG children chat spawns — and every one of them opened in `ask`, where a
 * non-interactive process cannot ask anyone: each ssh call was refused on the
 * spot unless the flag was retyped on every invocation. The operator owns
 * the box and chose to stand bypass as the default; the record still says
 * which layer set it.
 */
export type PermissionModeSource = "default" | "cli" | "env" | "config" | "tui";

/** The environment variable an operator sets once for unattended runs. */
export const PERMISSION_MODE_ENV = "DOKKABI_PERMISSION_MODE";

export interface PermissionController {
  /** The authority currently in force for this process lifetime. */
  current(): PermissionMode;
  /** `/permissions` control surface. Mode changes are always attributed to the TUI. */
  control(command: string): string;
  /** Subscribe capability consumers after the mode effect is durable. */
  onChange(listener: (mode: PermissionMode) => void): () => void;
  /** Host-only explicit mode transition. */
  set(mode: PermissionMode, source: PermissionModeSource): string;
}

/**
 * Precedence, most explicit first: the dangerous flag, `--permission-mode`,
 * `DOKKABI_PERMISSION_MODE`, `permissions.default_mode` in the config file,
 * then `auto`. A value that is not ask, auto or bypass fails loudly at whichever
 * layer it came from — a typo in a standing default must not quietly mean ask.
 */
export function resolvePermissionMode(input: {
  value?: string;
  dangerouslyBypass?: boolean;
  env?: string;
  configured?: string;
} = {}): { mode: PermissionMode; source: PermissionModeSource } {
  const value = parseMode(input.value, "--permission-mode requires ask, auto or bypass");
  if (input.dangerouslyBypass && value !== undefined && value !== "bypass") {
    throw new Error("--permission-mode conflicts with --dangerously-bypass-permissions");
  }
  if (input.dangerouslyBypass) return { mode: "bypass", source: "cli" };
  if (value !== undefined) return { mode: value, source: "cli" };
  const env = parseMode(input.env, `${PERMISSION_MODE_ENV} must be ask, auto or bypass`);
  if (env !== undefined) return { mode: env, source: "env" };
  const configured = parseMode(input.configured, "permissions.default_mode in the config file must be ask, auto or bypass");
  if (configured !== undefined) return { mode: configured, source: "config" };
  return { mode: "auto", source: "default" };
}

function parseMode(raw: string | undefined, complaint: string): PermissionMode | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === "") return undefined;
  if (value !== "ask" && value !== "auto" && value !== "bypass") throw new Error(complaint);
  return value;
}

export function createPermissionController(input: {
  log: EventLog;
  mode?: PermissionMode;
  source?: PermissionModeSource;
}): PermissionController {
  let mode: PermissionMode = "auto";
  const listeners = new Set<(mode: PermissionMode) => void>();

  const record = (next: PermissionMode, source: PermissionModeSource): void => {
    // This is an authority change, not presentation state. Appending first
    // means a failed audit write can never widen what a capability may do.
    input.log.append({
      kind: "effect",
      name: "permission/mode",
      payload: {
        mode: next,
        source,
        lifetime: "session",
        sandbox: "enforced",
      },
    });
    mode = next;
  };

  // Every process records its effective initial mode. In particular, a new
  // default process supersedes a bypass row left in a reused session log.
  record(input.mode ?? "auto", input.source ?? "default");

  const status = (): string => mode === "bypass"
    ? "permissions=bypass approvals=skipped lifetime=session-only sandbox=enforced"
    : `permissions=${mode} approvals=required lifetime=session-only sandbox=enforced`;

  const set = (next: PermissionMode, source: PermissionModeSource): string => {
    if (next === mode) return status();
    record(next, source);
    for (const listener of listeners) listener(mode);
    return status();
  };

  return {
    current: () => mode,
    control(command) {
      const normalized = command.trim().toLowerCase();
      if (normalized === "" || normalized === "status") return status();
      if (normalized === "ask" || normalized === "auto" || normalized === "bypass") return set(normalized, "tui");
      throw new Error("usage: /permissions [status|ask|auto|bypass]");
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set,
  };
}

export function permissionModeFromEvents(events: readonly { name: string; payload: Record<string, unknown> }[]): PermissionMode {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.name !== "permission/mode") continue;
    return event.payload.mode === "bypass" ? "bypass" : event.payload.mode === "auto" ? "auto" : "ask";
  }
  return "ask";
}
