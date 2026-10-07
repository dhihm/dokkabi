import type { EventRecord } from "../host/schema.ts";
import { fixOrderCheckSpec } from "./ledger-check.ts";
import type { PropertyFields } from "./ledger-property.ts";
import type { LedgerCase } from "./plan-ledger.ts";
import { exactUtf8 } from "./path-bytes.ts";
import {
  failingRecheckRow,
  invalidationHolds,
  openRecheckKey,
  RECHECK_INVALIDATED_ROW,
  RECHECK_ROW_NAMES,
  RECHECK_UPHELD_ROW,
  recheckCallId,
  recheckRowsFromEvents,
  type OpenRecheck,
  type RecheckAdjudication,
  type RecheckCase,
  type RecheckDisputed,
  type RecheckKind,
  type RecheckRow,
  type RecheckRulingValue,
  type RecheckStatus,
} from "./recheck.ts";
import type { RecheckInputsRecord } from "./recheck-inputs.ts";
import type { CheckIdentity, VerifyOrderDispute, VerifyOrderEvidence } from "./verified-work.ts";

/**
 * ADJUDICATION (D54, design memo §106 Q1): the session side of a disputed
 * check.
 *
 * D50 left one gap on purpose: a check a later requirement (or a verifier's
 * mistake) made wrong stays open for good, and a person has to clear it. The
 * adjudication path closes that gap without letting any session close its own
 * work. A FIX session may dispute an open check its order states, through its
 * `dispute` tool: the check's identity, a reason, and the exact order text the
 * dispute relies on — one `work/dispute` row in that session. The
 * orchestrator records each dispute of an identity that was open when the fix
 * started (`recheck/disputed`, citing the row) and hands every open, unruled
 * dispute to the NEXT fresh verifier, in its order. That verifier neither
 * wrote the check (an earlier verifier or a work session did) nor disputed it
 * (the fix did); it rules on each one against the order through its `ruling`
 * tool (`work/ruling`: upheld | invalid, the order text, a reason). The
 * orchestrator records a ruling as `recheck/upheld` or `recheck/invalidated`,
 * citing its row, only when the ruling session is neither the check's source
 * nor the disputing session; the open set (recheck.ts) closes an identity only
 * on such an `invalid` ruling.
 *
 * EVIDENCE (D55): a check's command alone does not say what it asserts — a
 * `sh checks/x.sh` expecting exit 0 means whatever the script says, and the
 * verifier that wrote the script ran on a copy that is gone. So before the
 * ruling verifier starts, the orchestrator has the runner put each dispute's
 * evidence in THAT verifier's scratch, never in its workspace: the files the
 * check's verifier authored (as the keep recorded them, by digest, at their
 * paths in its tree), the check as recorded (command, dir, stdin, fixtures,
 * expectations) and the latest recheck of the identity (status, exit code,
 * the tail of what it printed), with a manifest of every file's sha256 and
 * size. The verifier's order says where it is and its digests, and carries
 * the authored files' text within its budget. A `recheck/evidence` row per
 * dispute records the delivery — where, the manifest's digest, and whether it
 * was complete — and an `invalid` ruling closes the identity only when the
 * evidence was delivered complete to the verifier that ruled (recheck.ts,
 * invalidationGap).
 *
 * SCRATCH EVIDENCE (D56): the check may assert through files in its
 * recording session's scratch, which the recheck binds; the scratch is part of
 * the evidence, delivered under `scratch/` at its scratch-relative paths, and
 * the order states the mapping (the source scratch, the directory it maps to)
 * and inlines the files' text within its budget like the authored files'.
 *
 * WHAT EXISTED BEFORE THE RUN (D57, E1): the evidence of a dispute is the
 * snapshot of what the check's FAILING run ran with, taken right before that
 * run (recheck-inputs.ts): of the identity's rows, the first red one since it
 * was last observed green (failingRecheckObservation). A later attempt that
 * found the inputs gone, or an inventory of the scratch after a run, is never
 * the evidence: a check that deletes or rewrites its own script while it runs
 * is ruled on as it ran. The order states that run and the latest one.
 *
 * Everything here is pure — rows in, rows or order data out — so a recorded
 * run re-derives the same disputes, rulings and open set from its logs; the
 * writing of the evidence is verifier-files.ts, behind the runner's
 * `evidence` seam.
 */

/** The event names of the two session rows. */
export const WORK_DISPUTE_ROW = "work/dispute";
export const WORK_RULING_ROW = "work/ruling";

/** The bound of a dispute's or a ruling's reason and quoted order text: a
 * paragraph each, as a defect statement is bounded. */
export const MAX_ADJUDICATION_TEXT = 2_000;

/** At most this many disputes enter one verifier's order. */
export const MAX_ORDER_DISPUTES = 32;

/** One `work/dispute` row of a fix session. */
export interface SessionDispute extends CheckIdentity {
  readonly id: string;
  readonly reason: string;
  readonly order_text: string;
  readonly seq: number;
  readonly hash: string;
}

/** One `work/ruling` row of a verifier session. */
export interface SessionRuling extends CheckIdentity {
  readonly id: string;
  readonly ruling: RecheckRulingValue;
  readonly order_text: string;
  readonly reason: string;
  readonly seq: number;
  readonly hash: string;
}

function identityOf(payload: Record<string, unknown>): CheckIdentity | undefined {
  const { source, case: caseId, spec } = payload;
  if (typeof source !== "string" || typeof caseId !== "string" || typeof spec !== "string") return undefined;
  return { source, case: caseId, spec };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function keyOf(item: CheckIdentity): string {
  return openRecheckKey(item);
}

/** The disputes a session recorded, in the order it recorded them. A row
 * missing any of its fields is not a dispute — the tool never writes one. */
export function sessionDisputes(events: readonly EventRecord[]): SessionDispute[] {
  const out: SessionDispute[] = [];
  for (const event of events) {
    if (event.name !== WORK_DISPUTE_ROW) continue;
    const identity = identityOf(event.payload);
    const reason = text(event.payload.reason);
    const orderText = text(event.payload.order_text);
    const id = text(event.payload.id);
    if (identity === undefined || reason === undefined || orderText === undefined || id === undefined) continue;
    out.push({ ...identity, id, reason, order_text: orderText, seq: event.seq, hash: event.hash });
  }
  return out;
}

/** The rulings a session recorded, in the order it recorded them. */
export function sessionRulings(events: readonly EventRecord[]): SessionRuling[] {
  const out: SessionRuling[] = [];
  for (const event of events) {
    if (event.name !== WORK_RULING_ROW) continue;
    const identity = identityOf(event.payload);
    const ruling = event.payload.ruling;
    const orderText = text(event.payload.order_text);
    const reason = text(event.payload.reason);
    const id = text(event.payload.id);
    if (identity === undefined || (ruling !== "upheld" && ruling !== "invalid") || orderText === undefined || reason === undefined || id === undefined) continue;
    out.push({ ...identity, id, ruling, order_text: orderText, reason, seq: event.seq, hash: event.hash });
  }
  return out;
}

/**
 * The `recheck/disputed` payloads for one fix session (D54): for every
 * identity that was open when the fix started — the ones its order stated —
 * the LAST dispute of it the fix recorded, citing that row. A dispute of any
 * other identity is not recorded: the fix was not given it.
 */
export function recheckDisputePayloads(input: {
  readonly round: number;
  readonly fix: string;
  readonly events: readonly EventRecord[];
  readonly open: readonly OpenRecheck[];
}): Record<string, unknown>[] {
  const disputes = sessionDisputes(input.events);
  if (disputes.length === 0) return [];
  const last = new Map<string, SessionDispute>();
  for (const item of disputes) last.set(keyOf(item), item);
  const out: Record<string, unknown>[] = [];
  for (const open of input.open) {
    const dispute = last.get(openRecheckKey(open));
    if (dispute === undefined) continue;
    out.push({
      round: input.round,
      fix: input.fix,
      kind: open.kind,
      source: open.source,
      case: open.case,
      spec: open.spec,
      command: open.command,
      ...(open.dir === undefined ? {} : { dir: open.dir }),
      reason: dispute.reason,
      order_text: dispute.order_text,
      dispute_id: dispute.id,
      dispute_seq: dispute.seq,
      dispute_hash: dispute.hash,
    });
  }
  return out;
}

/**
 * The disputes the next verifier rules on (D54): for every identity open now,
 * its latest `recheck/disputed` row, unless a ruling on that dispute was
 * recorded that settles it — upheld, or invalid and holding (then the
 * identity is no longer open). Since D55 an `invalid` ruling that does not
 * hold — its verifier was not given the check's complete evidence — settles
 * nothing: the dispute goes to the next verifier again. A later dispute of
 * the same identity is a new dispute, unruled until a verifier rules on it.
 */
export function unruledDisputes(open: readonly OpenRecheck[], adjudication: RecheckAdjudication): RecheckDisputed[] {
  const out: RecheckDisputed[] = [];
  for (const item of open) {
    const key = openRecheckKey(item);
    const latest = [...adjudication.disputes].reverse().find((dispute) => openRecheckKey(dispute) === key);
    if (latest === undefined) continue;
    const ruled = adjudication.rulings.some((ruling) =>
      openRecheckKey(ruling) === key && ruling.fix === latest.fix && ruling.dispute_id === latest.dispute_id &&
      (ruling.ruling === "upheld" || invalidationHolds(ruling, adjudication)));
    if (!ruled) out.push(latest);
  }
  return out;
}

// --- the evidence of a disputed check (D55) -------------------------------------

/** At most this much of what a recheck printed rides in the evidence and in
 * the order: the tail, where a failing command's verdict is. */
export const MAX_EVIDENCE_OUTPUT_TAIL = 2_000;

/** One recheck observation of an identity, as the run's own log holds it:
 * the round and fix it followed, its status, exit code and reason, the
 * receipt, a `check` case's expectation results, the tail of what the command
 * printed (the `tool/result` row of that run), and since D57 the snapshot of
 * what it ran with, taken before it ran. */
export interface RecheckObservationRecord {
  readonly round: number;
  readonly fix: string;
  readonly kind: RecheckKind;
  readonly status: RecheckStatus;
  readonly exit_code?: number;
  readonly reason?: string;
  readonly receipt?: string;
  readonly expectations?: readonly Record<string, unknown>[];
  readonly output_tail?: string;
  /** The snapshot of the run's inputs (D57), as its row names it. */
  readonly inputs?: RecheckInputsRecord;
  /** A property's run (D58): its counterexamples, each with the snapshot of
   * the input it generated. */
  readonly property?: PropertyFields;
}

/** The record of the recheck row at `at`. */
function observationRecord(events: readonly EventRecord[], at: number, row: RecheckRow): RecheckObservationRecord {
  // The run's rows of one round come before its recheck rows, and the call
  // id names the round: the nearest earlier `tool/result` of that id is it.
  const callId = recheckCallId(row.round, row.kind, row.source, row.case);
  let tail: string | undefined;
  for (let index = at - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.name !== "tool/result" || event.payload.id !== callId) continue;
    const text = typeof event.payload.text === "string" ? event.payload.text.trim() : "";
    tail = text.length <= MAX_EVIDENCE_OUTPUT_TAIL ? text : text.slice(-MAX_EVIDENCE_OUTPUT_TAIL);
    break;
  }
  const payload = events[at]!.payload;
  const expectations = Array.isArray(payload.expectations)
    ? payload.expectations.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
    : undefined;
  return {
    round: row.round,
    fix: row.fix,
    kind: row.kind,
    status: row.status,
    ...(row.exit_code === undefined ? {} : { exit_code: row.exit_code }),
    ...(row.reason === undefined ? {} : { reason: row.reason }),
    ...(row.receipt === undefined ? {} : { receipt: row.receipt }),
    ...(expectations === undefined ? {} : { expectations }),
    ...(tail === undefined ? {} : { output_tail: tail }),
    ...(row.inputs === undefined ? {} : { inputs: row.inputs }),
    ...(row.property === undefined ? {} : { property: row.property }),
  };
}

/** The latest observation of an identity in a run's own log (D55), or
 * undefined when none is recorded. Pure: rows in, record out. */
export function latestRecheckObservation(events: readonly EventRecord[], identity: CheckIdentity): RecheckObservationRecord | undefined {
  const key = openRecheckKey(identity);
  let found: { readonly at: number; readonly row: RecheckRow } | undefined;
  events.forEach((event, at) => {
    if (event.name !== RECHECK_ROW_NAMES.reported && event.name !== RECHECK_ROW_NAMES.kept) return;
    const row = recheckRowsFromEvents([event])[0];
    if (row !== undefined && openRecheckKey(row) === key) found = { at, row };
  });
  return found === undefined ? undefined : observationRecord(events, found.at, found.row);
}

/** The observation a dispute's evidence is taken from (D57, E1): the first
 * red one of the identity since it was last observed green
 * (failingRecheckRow), with the snapshot of what that run ran with; undefined
 * when no row of that episode is red. Pure: rows in, record out. */
export function failingRecheckObservation(events: readonly EventRecord[], identity: CheckIdentity): RecheckObservationRecord | undefined {
  const found = failingRecheckRow(events, identity);
  return found === undefined ? undefined : observationRecord(events, found.at, found.row);
}

/** One dispute's evidence as the orchestrator hands it to the runner: what
 * the run recorded of the check, to be written into the ruling verifier's
 * scratch. */
export interface DisputeEvidenceMaterial {
  /** Its place in the verifier's order, 1-based: its evidence directory is
   * `disputed-checks/<index>` in that verifier's scratch. */
  readonly index: number;
  readonly dispute: RecheckDisputed;
  /** The case as the run recorded it for its rechecks — its spec and, for a
   * reported case, its verifier's keep — when the run holds it. */
  readonly recorded?: RecheckCase;
  /** The observation the evidence is of (D57): the check's failing run, with
   * the snapshot of its inputs (failingRecheckObservation). */
  readonly observation?: RecheckObservationRecord;
}

/** One file of a dispute's evidence, as its manifest lists it. */
export interface DisputeEvidenceFile {
  /** Relative to the evidence directory: shown, and its exact bytes (D57). */
  readonly path: string;
  readonly path_bytes: Buffer;
  readonly sha256: string;
  readonly bytes: number;
  readonly mode?: number;
  /** A verifier file overlaid for the failing run: its path in that
   * verifier's tree. */
  readonly source_path?: string;
  readonly source_path_bytes?: Buffer;
  /** A file of the scratch the failing run bound (D56): its path there. */
  readonly scratch_path?: string;
  readonly scratch_path_bytes?: Buffer;
  /** A file of a property's counterexample input (D58): the counterexample
   * (1-based) and its path in that case's directory. */
  readonly counterexample?: number;
  readonly input_path?: string;
  readonly input_path_bytes?: Buffer;
  /** Its text, when it is UTF-8 without NUL bytes: what the order inlines
   * within its budget. */
  readonly text?: string;
}

/** One link of that run's inputs, delivered as a link with the same target
 * bytes (D56, D57), and since D57b with where that target was captured: the
 * evidence path of the entry it led to (`resolves_to`; `absent` when nothing
 * was there), or why it led outside what was snapshotted (`outside`). */
export interface DisputeEvidenceLink {
  /** Relative to the evidence directory. */
  readonly path: string;
  readonly path_bytes: Buffer;
  readonly target: string;
  readonly target_bytes: Buffer;
  readonly resolves_to?: string;
  readonly resolves_to_bytes?: Buffer;
  readonly absent?: boolean;
  readonly outside?: string;
  readonly source_path?: string;
  readonly source_path_bytes?: Buffer;
  readonly scratch_path?: string;
  readonly scratch_path_bytes?: Buffer;
  /** A link of a property's counterexample input (D58). */
  readonly counterexample?: number;
  readonly input_path?: string;
  readonly input_path_bytes?: Buffer;
}

/** Where the scratch the failing run bound is in its evidence (D56, D57):
 * that scratch (`source`, the run's `$DOKKABI_SCRATCH`) maps to `dir` inside
 * the evidence directory, every entry at its path there, as the snapshot
 * (`snapshot`) recorded it before the run. */
export interface DisputeEvidenceScratch {
  readonly source: string;
  readonly dir: string;
  readonly snapshot: string;
  readonly files: number;
  readonly links: number;
}

/** What the runner delivered for one dispute. */
export interface DisputeEvidence {
  readonly index: number;
  /** The evidence directory: absolute, and relative to the verifier's
   * scratch. */
  readonly dir?: string;
  readonly relative?: string;
  /** Every piece of the check's material — the record, and every input of
   * its failing run as the snapshot holds it — was written and read back by
   * digest; `missing` says what was not. */
  readonly complete: boolean;
  readonly missing: readonly string[];
  /** The manifest (`manifest.json`, not listed in itself): its sha256 and
   * the files and links it lists. */
  readonly manifest?: { readonly sha256: string; readonly files: readonly DisputeEvidenceFile[]; readonly links?: readonly DisputeEvidenceLink[] };
  /** The observation the evidence carries (`observation.json`): the failing
   * run's. */
  readonly observation?: RecheckObservationRecord;
  /** The snapshot delivered (D57): the round of the run it was taken
   * before, its digest, and the scratch that run bound. */
  readonly inputs?: { readonly round: number; readonly snapshot: string; readonly scratch?: string };
  /** The scratch the failing run bound, as delivered (D56). */
  readonly scratch?: DisputeEvidenceScratch;
}

/** The runner's evidence request: the verify round about to start, and one
 * material per dispute its order will list. */
export interface EvidenceRequest {
  readonly round: number;
  readonly items: readonly DisputeEvidenceMaterial[];
  readonly deadlineMs: number;
}

/** What the runner delivered: the verifier session the evidence was written
 * for (absent when the delivery failed before one was named), its scratch,
 * and one delivery per material, in order. */
export interface EvidenceDelivery {
  readonly session?: string;
  readonly scratch?: string;
  readonly items: readonly DisputeEvidence[];
}

/** At most this many reasons, of at most this many characters, ride on one
 * `recheck/evidence` row. */
const MAX_EVIDENCE_MISSING = 8;
const MAX_EVIDENCE_REASON = 300;

/** The `recheck/evidence` payload of one delivered dispute (D55); since D57
 * with the snapshot it delivered (`inputs_snapshot`) and the round of the
 * run that snapshot was taken before (`inputs_round`), and the scratch that
 * run bound (`scratch_source`). */
export function recheckEvidencePayload(input: {
  /** The verifier's round: the evidence precedes the ruling that follows fix
   * round `verifyRound - 1`. */
  readonly verifyRound: number;
  readonly verifier?: string;
  readonly dispute: RecheckDisputed;
  readonly evidence: DisputeEvidence;
}): Record<string, unknown> {
  const { dispute, evidence } = input;
  const files = evidence.manifest?.files ?? [];
  return {
    round: input.verifyRound - 1,
    verify_round: input.verifyRound,
    ...(input.verifier === undefined ? {} : { verifier: input.verifier }),
    fix: dispute.fix,
    dispute_id: dispute.dispute_id,
    kind: dispute.kind,
    source: dispute.source,
    case: dispute.case,
    spec: dispute.spec,
    command: dispute.command,
    ...(dispute.dir === undefined ? {} : { dir: dispute.dir }),
    complete: evidence.complete,
    ...(evidence.missing.length === 0
      ? {}
      : { missing: evidence.missing.slice(0, MAX_EVIDENCE_MISSING).map((item) => item.slice(0, MAX_EVIDENCE_REASON)) }),
    ...(evidence.dir === undefined ? {} : { evidence_dir: evidence.dir }),
    ...(evidence.manifest === undefined
      ? {}
      : {
        manifest_sha256: evidence.manifest.sha256,
        files: files.length,
        bytes: files.reduce((sum, item) => sum + item.bytes, 0),
      }),
    ...(evidence.inputs === undefined
      ? {}
      : {
        inputs_round: evidence.inputs.round,
        inputs_snapshot: evidence.inputs.snapshot,
        ...(evidence.inputs.scratch === undefined ? {} : { scratch_source: evidence.inputs.scratch }),
      }),
  };
}

/** A recheck observation as an order states it. */
function orderRecheck(observation: RecheckObservationRecord): Record<string, unknown> {
  return {
    round: observation.round,
    status: observation.status,
    ...(observation.exit_code === undefined ? {} : { exit_code: observation.exit_code }),
    ...(observation.reason === undefined ? {} : { reason: observation.reason }),
    ...(observation.output_tail === undefined ? {} : { output_tail: observation.output_tail }),
  };
}

/** A path's exact bytes, in the order only when its text is not exactly
 * them (D57): what a reader needs to find it byte for byte. */
function exactField(name: string, text: string | undefined, bytes: Buffer | undefined): Record<string, string> {
  if (text === undefined || bytes === undefined || exactUtf8(bytes) === text) return {};
  return { [`${name}_b64`]: bytes.toString("base64") };
}

/** The evidence as the verifier's order states it (D55, D57): where it is,
 * the manifest's digest, whether it is complete and what is missing, the run
 * it was taken before (`failing_recheck`, with the snapshot's digest) and the
 * latest recheck, and every file with its digest — the text of each input
 * file of that run while `budget.left` allows, every other file named by path
 * and digest (the check's own texts ride in `check`) — and the links. The
 * scratch that run bound maps to the evidence's `scratch/` (D56). */
function orderEvidence(
  evidence: DisputeEvidence,
  budget: { left: number },
  latest: RecheckObservationRecord | undefined,
): { readonly evidence: VerifyOrderEvidence; readonly omitted: readonly { readonly path: string; readonly bytes: number; readonly digest: string }[] } {
  const omitted: { path: string; bytes: number; digest: string }[] = [];
  const files = (evidence.manifest?.files ?? []).map((file) => {
    const authored = file.source_path !== undefined || file.scratch_path !== undefined || file.counterexample !== undefined;
    let content: string | undefined;
    if (authored && file.text !== undefined && file.bytes <= budget.left) {
      content = file.text;
      budget.left -= file.bytes;
    } else if (authored) {
      omitted.push({ path: file.path, bytes: file.bytes, digest: file.sha256 });
    }
    return {
      path: file.path,
      ...exactField("path", file.path, file.path_bytes),
      ...(file.source_path === undefined ? {} : { source_path: file.source_path }),
      ...exactField("source_path", file.source_path, file.source_path_bytes),
      ...(file.scratch_path === undefined ? {} : { scratch_path: file.scratch_path }),
      ...exactField("scratch_path", file.scratch_path, file.scratch_path_bytes),
      ...(file.counterexample === undefined ? {} : { counterexample: file.counterexample }),
      ...(file.input_path === undefined ? {} : { input_path: file.input_path }),
      ...exactField("input_path", file.input_path, file.input_path_bytes),
      sha256: file.sha256,
      bytes: file.bytes,
      ...(content === undefined ? {} : { content }),
    };
  });
  const links = (evidence.manifest?.links ?? []).map((link) => ({
    path: link.path,
    ...exactField("path", link.path, link.path_bytes),
    ...(link.source_path === undefined ? {} : { source_path: link.source_path }),
    ...exactField("source_path", link.source_path, link.source_path_bytes),
    ...(link.scratch_path === undefined ? {} : { scratch_path: link.scratch_path }),
    ...exactField("scratch_path", link.scratch_path, link.scratch_path_bytes),
    ...(link.counterexample === undefined ? {} : { counterexample: link.counterexample }),
    ...(link.input_path === undefined ? {} : { input_path: link.input_path }),
    ...exactField("input_path", link.input_path, link.input_path_bytes),
    target: link.target,
    ...exactField("target", link.target, link.target_bytes),
    ...(link.resolves_to === undefined ? {} : { resolves_to: link.resolves_to }),
    ...exactField("resolves_to", link.resolves_to, link.resolves_to_bytes),
    ...(link.absent === true ? { absent: true } : {}),
    ...(link.outside === undefined ? {} : { outside: link.outside }),
  }));
  const observation = evidence.observation;
  return {
    evidence: {
      ...(evidence.dir === undefined ? {} : { dir: evidence.dir }),
      ...(evidence.relative === undefined ? {} : { in_scratch: evidence.relative }),
      ...(evidence.manifest === undefined ? {} : { manifest: "manifest.json", manifest_sha256: evidence.manifest.sha256 }),
      complete: evidence.complete,
      ...(evidence.missing.length === 0 ? {} : { missing: [...evidence.missing] }),
      ...(evidence.scratch === undefined
        ? {}
        : { scratch: { source: evidence.scratch.source, dir: evidence.scratch.dir } }),
      ...(observation === undefined
        ? {}
        : { failing_recheck: { ...orderRecheck(observation), ...(evidence.inputs === undefined ? {} : { inputs_snapshot: evidence.inputs.snapshot }) } }),
      ...(latest === undefined ? {} : { latest_recheck: orderRecheck(latest) }),
      files,
      ...(links.length === 0 ? {} : { links }),
    },
    omitted,
  };
}

/**
 * One dispute as the verifier's order states it (D54): the identity, the
 * check as it was recorded — through the fix order's own rendering
 * (fixOrderCheckSpec: command, dir, stdin, fixtures, expectations; texts from
 * the recording session's store while the order's budget allows, the rest
 * named by digest) — and the dispute's reason and quoted order text. Since
 * D55, when the runner delivered its evidence, where that is and what it
 * holds (orderEvidence), within the same budget; since D57 with the latest
 * recheck of the check beside the failing run the evidence is of.
 */
export function verifyOrderDispute(
  dispute: RecheckDisputed,
  recorded: RecheckCase | undefined,
  budget: { left: number },
  evidence?: DisputeEvidence,
  latest?: RecheckObservationRecord,
): VerifyOrderDispute {
  const item: LedgerCase = {
    id: dispute.case,
    command: recorded?.command ?? dispute.command,
    ...((recorded?.dir ?? dispute.dir) === undefined ? {} : { dir: (recorded?.dir ?? dispute.dir)! }),
    ...(recorded?.stdin === undefined ? {} : { stdin: recorded.stdin }),
    ...(recorded?.files === undefined ? {} : { files: recorded.files }),
    ...(recorded?.expect === undefined ? {} : { expect: recorded.expect }),
    ...(recorded?.timeout_ms === undefined ? {} : { timeout_ms: recorded.timeout_ms }),
    ...(recorded?.property === undefined ? {} : { property: recorded.property }),
  };
  // A recorded case whose fields are not the shapes its tool records (V5')
  // is shown as its command alone.
  const check = fixOrderCheckSpec(item, recorded?.scratch, budget) ?? { spec: { id: item.id, command: item.command }, omitted: [] };
  const shown = evidence === undefined ? undefined : orderEvidence(evidence, budget, latest);
  return {
    identity: { source: dispute.source, case: dispute.case, spec: dispute.spec },
    check: check.spec,
    ...(check.omitted.length === 0 ? {} : { omitted: check.omitted }),
    disputed_by: dispute.fix,
    reason: dispute.reason,
    order_text: dispute.order_text,
    ...(shown === undefined ? {} : { evidence: shown.evidence }),
    ...(shown === undefined || shown.omitted.length === 0 ? {} : { evidence_omitted: shown.omitted }),
  };
}

/** Why a ruling session may not rule on a dispute, or undefined when it may:
 * it is the check's source, or the session that disputed it (D54). */
export function rulingConflict(verifier: string, dispute: RecheckDisputed): string | undefined {
  if (verifier === dispute.source) return "the check's source";
  if (verifier === dispute.fix) return "the disputing session";
  return undefined;
}

/**
 * The `recheck/upheld` and `recheck/invalidated` rows for one verifier (D54):
 * for every dispute it was given, its LAST ruling on that identity, recorded
 * only when the verifier is neither the check's source nor the disputing
 * session. A dispute it did not rule on stays unruled, and one it may not
 * rule on too: the next verifier is given it again.
 */
export function recheckRulingRows(input: {
  /** The verifier's round: the ruling follows fix round `verifyRound - 1`. */
  readonly verifyRound: number;
  readonly verifier: string;
  readonly events: readonly EventRecord[];
  readonly presented: readonly RecheckDisputed[];
}): { readonly name: string; readonly payload: Record<string, unknown> }[] {
  const rulings = sessionRulings(input.events);
  if (rulings.length === 0) return [];
  const last = new Map<string, SessionRuling>();
  for (const item of rulings) last.set(keyOf(item), item);
  const out: { name: string; payload: Record<string, unknown> }[] = [];
  for (const dispute of input.presented) {
    const ruling = last.get(openRecheckKey(dispute));
    if (ruling === undefined || rulingConflict(input.verifier, dispute) !== undefined) continue;
    out.push({
      name: ruling.ruling === "invalid" ? RECHECK_INVALIDATED_ROW : RECHECK_UPHELD_ROW,
      payload: {
        round: input.verifyRound - 1,
        verify_round: input.verifyRound,
        verifier: input.verifier,
        fix: dispute.fix,
        dispute_id: dispute.dispute_id,
        kind: dispute.kind,
        source: dispute.source,
        case: dispute.case,
        spec: dispute.spec,
        command: dispute.command,
        ...(dispute.dir === undefined ? {} : { dir: dispute.dir }),
        ruling: ruling.ruling,
        order_text: ruling.order_text,
        reason: ruling.reason,
        ruling_id: ruling.id,
        ruling_seq: ruling.seq,
        ruling_hash: ruling.hash,
      },
    });
  }
  return out;
}
