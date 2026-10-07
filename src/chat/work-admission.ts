import { randomUUID } from "node:crypto";
import { EventLog, sha256Hex } from "../host/event-log.ts";
import type { EventLog as EventLogType } from "../host/event-log.ts";
import { appendUserMessageDurable, safeModelInputText } from "../host/model-input.ts";
import type { EventRecord } from "../host/schema.ts";
import { takeHeungSignal } from "../work/heung.ts";
import { takeRalphPlanSignal } from "../work/ralph-plan-signal.ts";

/**
 * The private parent/owned-child admission channel (R8-06j1).
 *
 * The interactive frontend's work children (HEUNG, Ralph Plan) are real
 * subprocesses on the SAME session the chat owns. Spawn alone was treated as
 * acceptance: the parent committed the operator's note and linked the newest
 * user/message row of its own stale in-memory log before the child had
 * recorded anything. This module coordinates the closed protocol that fixes
 * that:
 *
 * - The owned child records its genuine operator input durably — the exact
 *   safe normalized order every downstream provider will be fed — publishes a
 *   closed versioned receipt over the dedicated Bun IPC channel, and WAITS
 *   for a correlated release before any provider work.
 * - The parent verifies the receipt against a FRESH read of the session log:
 *   invocation correlation, exact session, raw stdin digest, effective input
 *   digest, the pre-spawn boundary head, and a NEW user/message row with
 *   source=operator. Only then does it run the accepted callback
 *   synchronously (inbox commit, kernel chat/turn_accepted durable row) and
 *   release that child. A callback that throws refuses the release.
 *
 * The EventLog stays the input authority; release is private IPC, not a synthetic log row.
 * Stdin remains the only task transport and stdout/stderr stay ignored. The
 * correlation id lives only in the narrow launch environment — removed
 * before boot, tools or any model surface — and in the IPC messages, never in
 * the model prefix, message text or the session log.
 */

/** The one environment marker that turns a work child into an owned one. The
 * value is the invocation correlation; the parent deletes it from the child
 * environment contract by having the child consume it before boot. */
export const OWNED_WORK_ADMISSION_ENV = "DOKKABI_OWNED_WORK_ADMISSION";

export const WORK_ADMISSION_PROTOCOL_VERSION = 1;

/** The exact durable row a verified admission points at. */
export interface WorkAdmissionMessageRef {
  readonly seq: number;
  readonly hash: string;
}

/** Canonical HEUNG -> Ralph -> nested-HEUNG order normalization, shared by
 * the CLI work path and the parent-side verifier so the effective input the
 * receipt binds can never drift from the order the child feeds providers. */
export interface NormalizedWorkOrder {
  /** The exact transport text as received, before any trimming. */
  readonly raw: string;
  /** The activation-stripped order, before sanitization. */
  readonly stripped: string;
  /** The safe text every model surface must be fed. */
  readonly order: string;
  readonly redacted: boolean;
  readonly heung: boolean;
  readonly ralph: boolean;
  readonly ralphPlanOnly: boolean;
}

export function normalizeWorkOrder(raw: string): NormalizedWorkOrder {
  const first = takeHeungSignal(raw.trim());
  const ralph = takeRalphPlanSignal(first.order);
  const nested = ralph.activated ? takeHeungSignal(ralph.order) : undefined;
  const stripped = nested?.order ?? ralph.order;
  const safe = safeModelInputText(stripped);
  return {
    raw,
    stripped,
    order: safe.text,
    redacted: safe.redacted,
    heung: first.activated || nested?.activated === true,
    ralph: ralph.activated,
    ralphPlanOnly: ralph.planOnly,
  };
}

/** Take (and remove) the owned-admission marker from the environment. The
 * value never reaches boot, tools or model surfaces. */
export function takeOwnedWorkAdmissionMarker(): string | undefined {
  const value = process.env[OWNED_WORK_ADMISSION_ENV];
  delete process.env[OWNED_WORK_ADMISSION_ENV];
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > 128) throw new Error("invalid owned work admission marker");
  return value;
}

export interface WorkAdmissionReceipt {
  readonly v: typeof WORK_ADMISSION_PROTOCOL_VERSION;
  readonly kind: "work_admission_receipt";
  readonly correlation: string;
  readonly session: string;
  readonly raw_input_sha256: string;
  readonly effective_input_sha256: string;
  readonly message_seq: number;
  readonly message_hash: string;
}

const RECEIPT_KEYS = [
  "correlation",
  "effective_input_sha256",
  "kind",
  "message_hash",
  "message_seq",
  "raw_input_sha256",
  "session",
  "v",
].join(",");

const RELEASE_KEYS = ["correlation", "kind", "v"].join(",");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** Closed receipt schema: exactly the known fields, nothing else. */
export function parseWorkAdmissionReceipt(value: unknown): WorkAdmissionReceipt | undefined {
  if (!isPlainObject(value)) return undefined;
  if (Object.keys(value).sort().join(",") !== RECEIPT_KEYS) return undefined;
  if (value.v !== WORK_ADMISSION_PROTOCOL_VERSION) return undefined;
  if (value.kind !== "work_admission_receipt") return undefined;
  if (typeof value.correlation !== "string" || value.correlation.length === 0 || value.correlation.length > 128) {
    return undefined;
  }
  if (typeof value.session !== "string" || value.session.length === 0 || value.session.length > 200) {
    return undefined;
  }
  if (!isSha256Hex(value.raw_input_sha256) || !isSha256Hex(value.effective_input_sha256)) return undefined;
  if (!isSha256Hex(value.message_hash)) return undefined;
  if (
    typeof value.message_seq !== "number"
    || !Number.isSafeInteger(value.message_seq)
    || value.message_seq <= 0
  ) return undefined;
  return value as unknown as WorkAdmissionReceipt;
}

export interface WorkAdmissionRelease {
  readonly v: typeof WORK_ADMISSION_PROTOCOL_VERSION;
  readonly kind: "work_admission_release";
  readonly correlation: string;
}

export function parseWorkAdmissionRelease(value: unknown): WorkAdmissionRelease | undefined {
  if (!isPlainObject(value)) return undefined;
  if (Object.keys(value).sort().join(",") !== RELEASE_KEYS) return undefined;
  if (value.v !== WORK_ADMISSION_PROTOCOL_VERSION) return undefined;
  if (value.kind !== "work_admission_release") return undefined;
  if (typeof value.correlation !== "string" || value.correlation.length === 0) return undefined;
  return value as unknown as WorkAdmissionRelease;
}

export type WorkAdmissionVerdict =
  | { ok: true; message: WorkAdmissionMessageRef }
  | { ok: false; reason: string };

/** Verify one receipt against a FRESH read of the exact session log. Every
 * identity the receipt binds must match, the pre-spawn boundary must still be
 * the durable head's prefix, and the referenced row must be a NEW
 * operator-authored user/message carrying the exact safe order text. */
export function verifyWorkAdmissionReceipt(input: {
  receipt: WorkAdmissionReceipt;
  correlation: string;
  sessionId: string;
  /** The exact stdin payload the parent wrote to the child. */
  stdinText: string;
  logPath: string;
  /** The log head captured before the child was spawned. */
  boundary: { seq: number; hash: string };
}): WorkAdmissionVerdict {
  const refuse = (reason: string): WorkAdmissionVerdict => ({ ok: false, reason });
  if (input.receipt.correlation !== input.correlation) {
    return refuse("receipt correlation does not match this invocation");
  }
  if (input.receipt.session !== input.sessionId) {
    return refuse("receipt names another session");
  }
  if (sha256Hex(input.stdinText) !== input.receipt.raw_input_sha256) {
    return refuse("receipt does not bind the transported stdin payload");
  }
  const normalized = normalizeWorkOrder(input.stdinText);
  if (sha256Hex(normalized.order) !== input.receipt.effective_input_sha256) {
    return refuse("receipt does not bind the effective operator input");
  }
  let events: readonly EventRecord[];
  try {
    events = new EventLog(input.logPath, { readOnly: true }).events;
  } catch {
    return refuse("the session log cannot be read for verification");
  }
  if (events.length < input.boundary.seq) {
    return refuse("the session log shrank below the captured start boundary");
  }
  if (
    input.boundary.seq > 0
    && events[input.boundary.seq - 1]?.hash !== input.boundary.hash
  ) {
    return refuse("the session log head moved before the captured start boundary");
  }
  const row = events.find((event) => event.seq === input.receipt.message_seq);
  if (!row) return refuse("receipt references an unknown message row");
  if (row.hash !== input.receipt.message_hash) return refuse("receipt row hash does not match the session log");
  if (row.name !== "user/message" || row.kind !== "surface") {
    return refuse("receipt row is not a model-facing user/message");
  }
  if (row.payload.source !== "operator") return refuse("recorded input is not operator-authored");
  if (row.payload.text !== normalized.order) return refuse("recorded input text differs from the verified order");
  if (row.seq <= input.boundary.seq) {
    return refuse("receipt references an input that predates this invocation");
  }
  return { ok: true, message: { seq: row.seq, hash: row.hash } };
}

/** The child side: record the genuine operator input durably, publish the
 * correlated receipt, and wait for the parent's verified release. Any
 * malformed or mismatched message, or a channel that closes first, rejects —
 * the caller must not reach a provider after that. */
export async function runOwnedWorkAdmission(input: {
  correlation: string;
  log: EventLogType;
  sessionId: string;
  /** The exact stdin payload the child received. */
  rawStdin: string;
  /** The safe normalized order the child will feed providers. */
  order: string;
}): Promise<{ message: WorkAdmissionMessageRef; text: string }> {
  if (typeof process.send !== "function" || process.connected !== true) {
    throw new Error("owned work admission requires the live parent IPC channel");
  }
  let recorded: ReturnType<typeof appendUserMessageDurable> | undefined;
  await waitForWorkAdmissionRelease(input.correlation, () => {
    recorded = appendUserMessageDurable(input.log, input.order, "operator");
    const receipt: WorkAdmissionReceipt = {
      v: WORK_ADMISSION_PROTOCOL_VERSION,
      kind: "work_admission_receipt",
      correlation: input.correlation,
      session: input.sessionId,
      raw_input_sha256: sha256Hex(input.rawStdin),
      effective_input_sha256: sha256Hex(recorded.text),
      message_seq: recorded.seq,
      message_hash: recorded.hash,
    };
    process.send!(receipt);
  });
  if (!recorded) throw new Error("owned work admission did not record its input");
  return { message: { seq: recorded.seq, hash: recorded.hash }, text: recorded.text };
}

async function waitForWorkAdmissionRelease(correlation: string, publish: () => void): Promise<void> {
  let onMessage: ((value: unknown) => void) | undefined;
  let onDisconnect: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      onMessage = (value: unknown): void => {
        const release = parseWorkAdmissionRelease(value);
        if (!release) {
          reject(new Error("owned admission channel delivered an unexpected message"));
          return;
        }
        if (release.correlation !== correlation) {
          reject(new Error("owned admission release does not match this invocation"));
          return;
        }
        resolve();
      };
      onDisconnect = (): void => reject(new Error("owned admission channel closed before release"));
      process.on("message", onMessage);
      process.on("disconnect", onDisconnect);
      // Listeners precede publication: even a synchronous release cannot be lost.
      try { publish(); } catch (error) { reject(error); }
    });
  } finally {
    if (onMessage) process.removeListener("message", onMessage);
    if (onDisconnect) process.removeListener("disconnect", onDisconnect);
    if (process.connected === true) process.disconnect?.();
  }
}

function safePreview(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "unserializable message";
  }
}

/** What the parent needs from the spawned child to talk back on the channel. */
export interface WorkAdmissionChannel {
  send(message: unknown): unknown;
  kill(signal?: string | number): unknown;
}

export interface WorkAdmissionCoordinator {
  /** Wire to Bun.spawn's `ipc` callback. */
  handleMessage(message: unknown, channel: WorkAdmissionChannel): void;
  /** Wire to Bun.spawn's `onDisconnect`. */
  handleDisconnect(channel?: WorkAdmissionChannel): void;
  /** The operator stopped the turn; no further admission or release. */
  abort(): void;
  /**
   * The admission outcome once the child is gone, after queued channel
   * messages had their chance to deliver: admitted, refused (with the typed
   * reason and any observer error), or exited without a valid admission.
   */
  settlement(): Promise<WorkAdmissionSettlement>;
}

export type WorkAdmissionSettlement =
  | { kind: "admitted" }
  | { kind: "refused"; reason: string; error?: unknown }
  | { kind: "unadmitted" };

type AdmissionPhase = "waiting" | "admitted" | "refused";

/**
 * The parent side. One coordinator owns one owned child: the first valid
 * receipt runs the accepted callback synchronously and only then releases the
 * child; an exact duplicate of that receipt is a no-op; anything else — a
 * malformed, misbinding or mismatched-duplicate receipt, a throwing accepted
 * callback — refuses the turn and stops the child.
 */
export function createWorkAdmissionCoordinator(input: {
  correlation: string;
  sessionId: string;
  stdinText: string;
  logPath: string;
  boundary: { seq: number; hash: string };
  /** Runs synchronously once the receipt is verified; a throw refuses the
   * release. The verified durable row reference is passed through. */
  onAdmitted: (message: WorkAdmissionMessageRef) => void;
}): WorkAdmissionCoordinator {
  let phase: AdmissionPhase = "waiting";
  let refusal: { reason: string; error?: unknown } | undefined;
  let acceptedReceiptJson: string | undefined;
  let channel: WorkAdmissionChannel | undefined;
  let aborted = false;
  // The message callbacks and the settlement await mutate `phase`; reading it
  // through a call keeps the type honest across those boundaries.
  const currentPhase = (): AdmissionPhase => phase;

  const stopChild = (): void => {
    try {
      channel?.kill();
    } catch {
      // Already gone: the settlement path owns the honest outcome.
    }
  };

  const refuse = (reason: string, error?: unknown): void => {
    if (phase === "refused") return;
    phase = "refused";
    refusal = error === undefined ? { reason } : { reason, error };
    stopChild();
  };

  return {
    handleMessage(message, wire) {
      if (aborted || phase === "refused") return;
      channel = wire;
      if (phase === "admitted") {
        // The admission already happened: an exact duplicate changes nothing;
        // anything else is a protocol violation and refuses the turn.
        if (canonicalJson(message) === acceptedReceiptJson) return;
        refuse("a later admission receipt differed from the admitted one");
        return;
      }
      const receipt = parseWorkAdmissionReceipt(message);
      if (!receipt) {
        refuse("malformed admission receipt");
        return;
      }
      const verdict = verifyWorkAdmissionReceipt({
        receipt,
        correlation: input.correlation,
        sessionId: input.sessionId,
        stdinText: input.stdinText,
        logPath: input.logPath,
        boundary: input.boundary,
      });
      if (!verdict.ok) {
        refuse(verdict.reason);
        return;
      }
      try {
        // Must finish before the release: the inbox commit and the kernel's
        // durable chat/turn_accepted row precede any provider release.
        input.onAdmitted(verdict.message);
      } catch (error) {
        refuse(`the accepted callback refused this turn: ${errorMessage(error)}`, error);
        return;
      }
      acceptedReceiptJson = canonicalJson(message);
      phase = "admitted";
      try {
        wire.send(releaseMessage(input.correlation));
      } catch (error) {
        refuse("the admission release could not be delivered", error);
      }
    },
    handleDisconnect(wire) {
      if (wire) channel = wire;
      if (phase === "waiting" && !aborted) refuse("owned admission channel closed before receipt");
    },
    abort() {
      aborted = true;
      stopChild();
    },
    async settlement(): Promise<WorkAdmissionSettlement> {
      if (phase !== "waiting") {
        return phase === "admitted"
          ? { kind: "admitted" }
          : { kind: "refused", ...refusal! };
      }
      // Called after the owned child exits. Drain queued callbacks without
      // waiting for EOF from descendants holding an inherited fd.
      await new Promise((resolve) => setImmediate(resolve));
      const settledPhase = currentPhase();
      if (settledPhase === "admitted") return { kind: "admitted" };
      if (settledPhase === "refused") return { kind: "refused", ...refusal! };
      return { kind: "unadmitted" };
    },
  };
}

function releaseMessage(correlation: string): WorkAdmissionRelease {
  return {
    v: WORK_ADMISSION_PROTOCOL_VERSION,
    kind: "work_admission_release",
    correlation,
  };
}

function canonicalJson(value: unknown): string {
  if (!isPlainObject(value)) return safePreview(value);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = value[key];
  return JSON.stringify(sorted) ?? "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The correlation id for one owned launch. Random, never derived from the
 * clock's meaning, pid or any model-visible value. */
export function newWorkAdmissionCorrelation(): string {
  return randomUUID();
}
