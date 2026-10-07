/**
 * R8-06j2 explicit session work mode (docs/desktop-coding-r8-work-mode.md).
 *
 * A narrow host-owned service the desktop kernel exposes optionally: the
 * conversation can read and explicitly select Default, Chat or Work for its
 * OWN harness session through the authenticated workbench surface. Selection
 * persists through the SAME session control file the turn router reads
 * ({enabled:boolean}, 0600, atomic rename) and lands as observe rows in the
 * session EventLog — there is no second planner, prefix seal or work loop
 * here, and nothing in this module certifies task completion.
 *
 * Durability rules (mirroring the workbench ledger contract):
 * - `read` is effect-free: a fresh control-file validation answering an
 *   opaque SHA-256 revision over trusted session scope, the exact bytes
 *   (or their absence) and the kernel standing default. A corrupt or unreadable control fails closed —
 *   it is never silently reported as Default, and read never appends.
 * - `set` deduplicates by command id against a FRESH EventLog read: the
 *   durable `work/mode_intent` (canonical fingerprint + owner) precedes
 *   every file effect, an append failure means zero file effects, the same
 *   id with a completed `work/mode_applied` returns its stored receipt
 *   without writing again, and an intent without a receipt — or a recorded
 *   `work/mode_unknown` — stays unknown across restarts, never replayed.
 *   The expected revision is rechecked directly before the effects; this is
 *   serialized host optimistic checking, not an OS atomic CAS against
 *   unrelated CLI writers. A post-effect mismatch is unknown; the next read
 *   exposes the actual host configuration.
 * - `work/mode_applied` lands only after the atomic write/remove AND its
 *   filesystem sync, carrying the exact post-effect selection. A failure
 *   after the intent records `work/mode_unknown` when possible; the outcome
 *   is never overstated as rejected or applied. A missing receipt is never
 *   inferred from the control file merely matching the requested mode.
 * - `status` is read-only and reconstructs its answer from the fresh
 *   EventLog alone.
 * - Reset to Default removes only this session's control path; changing the
 *   global standing config is outside this command.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  lstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { canonicalJson } from "../host/canonical.ts";
import { EventLog } from "../host/event-log.ts";
import type { EventInput, EventRecord } from "../host/schema.ts";
import { HEUNG_CONTROL_FILE, heungControlPath } from "../work/heung.ts";

/** The three explicit selections the conversation can make. */
export type WorkModeKind = "default" | "chat" | "work";

/** The host-owned snapshot: actual configuration for future routing, never
 * an execution truth verdict. */
export interface WorkModeSelection {
  readonly mode: WorkModeKind;
  readonly effective: "chat" | "work";
  readonly source: "default" | "session";
  /** Opaque SHA-256 over trusted session scope, exact control bytes (or
   * absence) and the kernel standing default. */
  readonly revision: string;
}

/** The binding that owns a work-mode command; never taken from wire input
 * directly — the authenticated gateway derives it. */
export interface WorkModeOwner {
  readonly clientId: string;
  readonly threadId: string;
}

/** Closed outcome for set/status: applied carries the durable receipt;
 * conflict names a stale revision or command reuse; unknown is the honest
 * never-replayed answer for an intent whose effect is unproven. */
export type WorkModeCommandOutcome =
  | {
    readonly state: "applied";
    readonly commandId: string;
    readonly selection: WorkModeSelection;
    readonly duplicate: boolean;
  }
  | { readonly state: "conflict"; readonly commandId: string; readonly reason: string }
  | { readonly state: "unknown"; readonly commandId: string; readonly reason: string };

/** The durable writer the service evidences through: the kernel's own
 * session EventLog. Structural so honest failure-injection doubles can
 * stand in; appendDurable must fsync before returning. */
export interface WorkModeEventWriter {
  readonly path: string;
  appendDurable(input: EventInput): unknown;
}

/** The narrow session work-mode capability kernel.workModeService() returns. */
export interface SessionWorkModeService {
  read(): WorkModeSelection;
  set(request: {
    commandId: string;
    expectedRevision: string;
    mode: WorkModeKind;
    owner: WorkModeOwner;
  }): WorkModeCommandOutcome;
  status(request: { commandId: string; owner: WorkModeOwner }): WorkModeCommandOutcome;
}

/** Canonical fingerprint for work-mode deduplication: id, expected revision,
 * mode and owning binding. Same id under a different owner, mode or expected
 * revision ALWAYS conflicts. */
export function workModeFingerprint(input: {
  commandId: string;
  expectedRevision: string;
  mode: WorkModeKind;
  owner: WorkModeOwner;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        operation: "work_mode",
        commandId: input.commandId,
        expectedRevision: input.expectedRevision,
        mode: input.mode,
        owner: { clientId: input.owner.clientId, threadId: input.owner.threadId },
      }),
    )
    .digest("hex");
}

type ModeCommandRecord = {
  fingerprint: string;
  owner: WorkModeOwner;
  mode: WorkModeKind;
} & (
  | { state: "intent" | "unknown" }
  | { state: "applied"; selection: WorkModeSelection }
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectionFromPayload(value: unknown): WorkModeSelection | undefined {
  if (!isRecord(value)) return undefined;
  const { mode, effective, source, revision } = value;
  if (
    (mode !== "default" && mode !== "chat" && mode !== "work") ||
    (effective !== "chat" && effective !== "work") ||
    (source !== "default" && source !== "session") ||
    typeof revision !== "string" || !/^[a-f0-9]{64}$/u.test(revision) ||
    Object.keys(value).some((key) => !["mode", "effective", "source", "revision"].includes(key)) ||
    (mode === "default" ? source !== "default" : source !== "session" || effective !== mode)
  ) {
    return undefined;
  }
  return { mode, effective, source, revision };
}

export function createSessionWorkModeService(input: {
  sessionDir: string;
  log: WorkModeEventWriter;
  /** The kernel standing default — the exact value given to
   * createChatTurnRouter, captured once at boot. */
  standingDefault: boolean;
}): SessionWorkModeService {
  const sessionDir = resolve(input.sessionDir);
  const log = input.log;
  const standingDefault = input.standingDefault;

  /** Fresh validated control state. Absence is Default; anything that is
   * present but unparsable, not {enabled:boolean}, or unreadable fails
   * closed — never a silent Default. */
  const readControlState = (): WorkModeSelection => {
    const path = heungControlPath(sessionDir);
    let bytes: Buffer | undefined;
    let present = true;
    try {
      lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      present = false;
    }
    if (present) {
      try {
        bytes = readFileSync(path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        throw new Error(`session work mode control is unreadable (${code}) — repair it through the harness CLI`);
      }
    }
    let enabled: boolean | undefined;
    if (bytes !== undefined) {
      try {
        const parsed: unknown = JSON.parse(bytes.toString("utf8"));
        if (isRecord(parsed) && typeof parsed.enabled === "boolean") {
          enabled = parsed.enabled;
        }
      } catch {
        enabled = undefined;
      }
      if (enabled === undefined) {
        throw new Error(
          'session work mode control is corrupt — it is not {"enabled":boolean}; repair or remove it through the harness CLI',
        );
      }
    }
    const revision = createHash("sha256")
      .update(
        canonicalJson({
          scope: sessionDir,
          control: bytes === undefined ? null : bytes.toString("hex"),
          standingDefault,
        }),
      )
      .digest("hex");
    if (enabled === undefined) {
      return {
        mode: "default",
        effective: standingDefault ? "work" : "chat",
        source: "default",
        revision,
      };
    }
    return enabled
      ? { mode: "work", effective: "work", source: "session", revision }
      : { mode: "chat", effective: "chat", source: "session", revision };
  };

  /** Fresh read-only reconstruction of one command's durable rows from the
   * session EventLog on disk — the same authority a restart would have. */
  const scanCommand = (commandId: string): ModeCommandRecord | undefined => {
    const events: readonly EventRecord[] = new EventLog(log.path, { readOnly: true }).events;
    let record: ModeCommandRecord | undefined;
    for (const event of events) {
      if (!["work/mode_intent", "work/mode_unknown", "work/mode_applied"].includes(event.name)) continue;
      const payload = event.payload as Record<string, unknown>;
      if (payload.command_id !== commandId) continue;
      const invalid = () => new Error(`invalid recorded work-mode command ${commandId} — refusing its receipt`);
      const fingerprint = payload.fingerprint;
      const owner = { clientId: payload.client_id, threadId: payload.thread_id };
      if (event.kind !== "observe" || typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(fingerprint) ||
          typeof owner.clientId !== "string" || typeof owner.threadId !== "string") throw invalid();
      const validOwner = { clientId: owner.clientId, threadId: owner.threadId };
      if (event.name === "work/mode_intent") {
        const mode = payload.mode;
        const expectedRevision = payload.expected_revision;
        if (record !== undefined || (mode !== "default" && mode !== "chat" && mode !== "work") ||
            typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/u.test(expectedRevision) ||
            workModeFingerprint({ commandId, mode, expectedRevision, owner: validOwner }) !== fingerprint) throw invalid();
        record = { state: "intent", fingerprint, owner: validOwner, mode };
        continue;
      }
      if (record === undefined || record.fingerprint !== fingerprint ||
          record.owner.clientId !== validOwner.clientId || record.owner.threadId !== validOwner.threadId) throw invalid();
      if (event.name === "work/mode_unknown") {
        if (typeof payload.reason !== "string") throw invalid();
        record = { ...record, state: "unknown" };
        continue;
      }
      const selection = selectionFromPayload(payload.selection);
      if (record.state !== "intent" || selection === undefined || payload.mode !== record.mode || selection.mode !== record.mode) throw invalid();
      record = { ...record, state: "applied", selection };
    }
    return record;
  };

  const appendRow = (name: string, payload: Record<string, unknown>): void => {
    log.appendDurable({ kind: "observe", name, payload });
  };

  const recordUnknown = (
    request: { commandId: string; owner: WorkModeOwner },
    fingerprint: string,
    reason: string,
  ): WorkModeCommandOutcome => {
    try {
      appendRow("work/mode_unknown", {
        command_id: request.commandId,
        fingerprint,
        client_id: request.owner.clientId,
        thread_id: request.owner.threadId,
        reason,
      });
    } catch {
      // The uncertainty row could not land either; the intent above still
      // stands as the durable unknown.
    }
    return { state: "unknown", commandId: request.commandId, reason };
  };

  /** Atomic durable control write: the existing {enabled:boolean} encoding,
   * 0600, atomic rename — plus the file and directory syncs this selection
   * path owes before it may claim a receipt. Only the owned unique temp
   * file is ever cleaned. */
  const writeControl = (enabled: boolean): void => {
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const path = heungControlPath(sessionDir);
    const temporary = join(sessionDir, `.${HEUNG_CONTROL_FILE}.${process.pid}.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify({ enabled })}\n`);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, path);
      const dirFd = openSync(sessionDir, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // The failing write already closed or lost the descriptor.
        }
      }
      try {
        unlinkSync(temporary);
      } catch {
        // The temporary may already have been atomically renamed.
      }
      throw error;
    }
  };

  /** Durable control removal (reset to Default): directory sync after the
   * unlink; an already-absent control is a completed no-op removal. */
  const removeControl = (): void => {
    const path = heungControlPath(sessionDir);
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      return;
    }
    const dirFd = openSync(sessionDir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  };

  const selectionMatchesTarget = (selection: WorkModeSelection, mode: WorkModeKind): boolean => {
    switch (mode) {
      case "work":
        return selection.mode === "work" && selection.source === "session" && selection.effective === "work";
      case "chat":
        return selection.mode === "chat" && selection.source === "session" && selection.effective === "chat";
      case "default":
        return selection.mode === "default" && selection.source === "default";
    }
  };

  return {
    read: () => readControlState(),

    set: (request) => {
      const fingerprint = workModeFingerprint(request);
      const prior = scanCommand(request.commandId);
      if (prior !== undefined) {
        if (prior.fingerprint !== fingerprint) {
          return {
            state: "conflict",
            commandId: request.commandId,
            reason:
              `command ${request.commandId} already exists with a different owner, mode or expected revision`,
          };
        }
        if (prior.state === "applied") {
          // Stored receipt, never a second write.
          return {
            state: "applied",
            commandId: request.commandId,
            selection: prior.selection,
            duplicate: true,
          };
        }
        return {
          state: "unknown",
          commandId: request.commandId,
          reason:
            prior.state === "unknown"
              ? `command ${request.commandId} ended unknown after its durable intent — it is never reapplied automatically`
              : `command ${request.commandId} carries a durable intent without a completed effect — unknown, never replayed`,
        };
      }
      const current = readControlState();
      if (current.revision !== request.expectedRevision) {
        return {
          state: "conflict",
          commandId: request.commandId,
          reason: "expected revision is stale — reread the current work mode and issue a new command",
        };
      }
      // Durable intent before any file effect; a failed append refuses with
      // zero effects by throwing before anything below runs.
      appendRow("work/mode_intent", {
        command_id: request.commandId,
        fingerprint,
        mode: request.mode,
        expected_revision: request.expectedRevision,
        client_id: request.owner.clientId,
        thread_id: request.owner.threadId,
      });
      // Serialized host optimistic recheck directly before the effects.
      let recheck: WorkModeSelection;
      try {
        recheck = readControlState();
      } catch {
        return recordUnknown(request, fingerprint, "the control could not be validated after the durable intent — the effect is unknown");
      }
      if (recheck.revision !== request.expectedRevision) {
        return recordUnknown(
          request,
          fingerprint,
          "the control state changed after the durable intent — the effect is unknown",
        );
      }
      try {
        if (request.mode === "default") {
          removeControl();
        } else {
          writeControl(request.mode === "work");
        }
      } catch {
        return recordUnknown(
          request,
          fingerprint,
          "the control write failed after the durable intent — the effect is unknown",
        );
      }
      let after: WorkModeSelection;
      try {
        after = readControlState();
      } catch {
        return recordUnknown(request, fingerprint, "the post-effect control could not be validated — the effect is unknown");
      }
      if (!selectionMatchesTarget(after, request.mode)) {
        return recordUnknown(
          request,
          fingerprint,
          "a post-effect reread no longer matches the requested selection — the effect is unknown",
        );
      }
      try {
        appendRow("work/mode_applied", {
          command_id: request.commandId,
          fingerprint,
          mode: request.mode,
          selection: {
            mode: after.mode,
            effective: after.effective,
            source: after.source,
            revision: after.revision,
          },
          client_id: request.owner.clientId,
          thread_id: request.owner.threadId,
        });
      } catch {
        // The effect happened but its receipt could not land: unknown, never
        // falsely applied — and never inferred from the file now matching.
        return recordUnknown(
          request,
          fingerprint,
          "the applied receipt could not be recorded — the effect is unknown",
        );
      }
      return { state: "applied", commandId: request.commandId, selection: after, duplicate: false };
    },

    status: (request) => {
      const prior = scanCommand(request.commandId);
      if (prior === undefined) {
        return {
          state: "unknown",
          commandId: request.commandId,
          reason: `command ${request.commandId} is not recorded`,
        };
      }
      if (
        (prior.owner.clientId !== request.owner.clientId || prior.owner.threadId !== request.owner.threadId)
      ) {
        return {
          state: "conflict",
          commandId: request.commandId,
          reason: `command ${request.commandId} belongs to another client/thread`,
        };
      }
      if (prior.state === "applied") {
        return {
          state: "applied",
          commandId: request.commandId,
          selection: prior.selection,
          duplicate: true,
        };
      }
      return {
        state: "unknown",
        commandId: request.commandId,
        reason:
          prior.state === "unknown"
            ? `command ${request.commandId} ended unknown after its durable intent`
            : `command ${request.commandId} carries a durable intent without a completed effect`,
      };
    },
  };
}
