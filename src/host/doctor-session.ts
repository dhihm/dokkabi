import { readSync } from "node:fs";
import { join } from "node:path";
import { openBeneath, readOpened, safeRoot } from "../work/link-safe-fs.ts";
import {
  digestOf,
  inventorySnapshotFromEvents,
  isSessionIdReference,
  type InventorySnapshot,
  type ReasonCode,
  type SessionIdentity,
} from "./doctor-report.ts";
import { dokkabiHome } from "./paths.ts";
import { parseReplayEvents } from "./replay-audit.ts";
import type { EventRecord } from "./schema.ts";
import { probeSessionLock, SESSION_LOCK_FILE } from "./session-lock.ts";

/**
 * A session, as a diagnosis may read it (#230 D4, round 3 D4'): the sessions
 * root pinned and every component opened without following a link, the log
 * bounded and parsed by the replay reader, and `live` only when the doctor's
 * own non-blocking attempt on the session's run lock FAILS because a holder
 * holds it and the holder the lock names is the process the kernel says it is
 * (pid + start time). A lock that can be taken belongs to nobody: the session
 * is `recorded`. A pid alone never makes a session live.
 */

export const MAX_SESSION_LOG_BYTES = 64 * 1024 * 1024;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export type SessionRead =
  | { readonly ok: true; readonly events: readonly EventRecord[]; readonly identity: SessionIdentity; readonly snapshot?: InventorySnapshot }
  | { readonly ok: false; readonly reasonCode: ReasonCode; readonly identity?: SessionIdentity };

export class DoctorSessionError extends Error {
  constructor(readonly code: "session_id_invalid" | "session_missing") {
    super(code === "session_id_invalid" ? "doctor --session takes a session id" : "doctor: no such session");
  }
}

/** Whether the session's own run lock is held by the process it names. */
function lockHeldByNamedHolder(root: ReturnType<typeof safeRoot>, id: string): boolean {
  let opened: ReturnType<typeof openBeneath>;
  try {
    opened = openBeneath(root, Buffer.from(`${id}/${SESSION_LOCK_FILE}`), "probe session lock");
  } catch {
    return false;
  }
  if (opened === undefined) return false;
  try {
    const probe = probeSessionLock(opened.fd);
    return probe.state === "held" && probe.identityMatches;
  } finally {
    opened.close();
  }
}

export function readSessionForDoctor(sessionId: string, home: string = dokkabiHome()): SessionRead {
  if (!SESSION_ID.test(sessionId)) throw new DoctorSessionError("session_id_invalid");
  let root: ReturnType<typeof safeRoot>;
  try {
    root = safeRoot(join(home, "sessions"), "sessions");
  } catch {
    return { ok: false, reasonCode: "session_log_unreadable" };
  }
  const rel = Buffer.from(`${sessionId}/events.jsonl`);
  let opened: ReturnType<typeof openBeneath>;
  try {
    opened = openBeneath(root, rel, "read session log");
  } catch {
    return { ok: false, reasonCode: "session_log_unreadable" };
  }
  if (opened === undefined) throw new DoctorSessionError("session_missing");
  let bytes: Buffer;
  let identityBase: { dev: bigint; ino: bigint; size: number };
  try {
    identityBase = { dev: opened.dev, ino: opened.ino, size: opened.size };
    if (opened.size > MAX_SESSION_LOG_BYTES) return { ok: false, reasonCode: "session_log_too_large" };
    bytes = readOpened(opened, opened.size);
    if (bytes.length !== opened.size || readSync(opened.fd, Buffer.alloc(1), 0, 1, opened.size) !== 0) {
      return { ok: false, reasonCode: "session_log_unreadable" };
    }
    opened.verify();
  } catch {
    return { ok: false, reasonCode: "session_log_unreadable" };
  } finally {
    opened.close();
  }
  let events: EventRecord[];
  try {
    const text = bytes.toString("utf8");
    // A running writer may be mid-append: read up to the last whole row.
    const whole = text.slice(0, text.lastIndexOf("\n") + 1);
    events = parseReplayEvents(whole);
  } catch {
    return { ok: false, reasonCode: "session_log_unreadable" };
  }
  const last = events.at(-1);
  let snapshot: InventorySnapshot | undefined;
  try {
    snapshot = inventorySnapshotFromEvents(events);
  } catch {
    return { ok: false, reasonCode: "session_log_unreadable" };
  }
  const identity: SessionIdentity = {
    ...(isSessionIdReference(sessionId) ? { id: sessionId } : {}),
    log: digestOf({ dev: String(identityBase.dev), ino: String(identityBase.ino), size: identityBase.size, head: last?.hash ?? "" }),
    lastSeq: last?.seq ?? 0,
    live: snapshot !== undefined && !snapshot.terminated && lockHeldByNamedHolder(root, sessionId),
  };
  return { ok: true, events, identity, ...(snapshot ? { snapshot } : {}) };
}
