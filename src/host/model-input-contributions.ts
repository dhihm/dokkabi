import { createHash } from "node:crypto";
import type { EventLog } from "./event-log.ts";
import type { EventRecord } from "./schema.ts";
import { containsSecret, stripTerminalControls } from "./redact.ts";
import { redactForEmission } from "./tool-result-input.ts";
import { appendProviderContribution, MODEL_INPUT_CONTRIBUTION_EVENT } from "./provider-input.ts";
import type { PluginDisposer } from "../loader/types.ts";

/**
 * RECORDED MODEL-INPUT CONTRIBUTIONS (#222 D2, TS-20 L3; the seam #227's
 * lessons adopt as `request_context_contributions`).
 *
 * At every real provider-request boundary — the first request of a prompt,
 * the request after a tool batch inside the same Pi episode, a continuation
 * or a retry — the loop asks this registry for what its contributors have
 * ready. The host (never a contributor) selects within one request budget,
 * redacts at emission, and appends the EXACT suffix to the EventLog as a
 * `model_input/contribution` surface row and then as a transcript append
 * that names that row — before the request is admitted. An append failure
 * means nothing was delivered. An item's key (its source, version and body
 * digest) is delivered at most once per session: the keys are recorded on
 * the row, and a restart or a compaction reads them back from the log.
 * Nothing here runs mid-stream: the loop calls it only between requests.
 * Replay reads the recorded rows; it never calls a contributor.
 */

export { MODEL_INPUT_CONTRIBUTION_EVENT } from "./provider-input.ts";
export const MODEL_INPUT_CONTRIBUTION_FAILED_EVENT = "model_input/contribution_failed";
/** The whole suffix of one request, UTF-8 bytes, every source together (D5). */
export const MODEL_INPUT_REQUEST_BUDGET_BYTES = 16 * 1024;
/** The capability key a loop reads and contributors register into. */
export const MODEL_INPUT_CONTRIBUTIONS_KEY = "model_input_contributions";

export type ContributionBoundaryKind = "prompt" | "tool_batch" | "continue";

export interface ModelInputBoundary {
  readonly kind: ContributionBoundaryKind;
  /** The provider request this suffix precedes (1-based, per session). */
  readonly request: number;
}

export type ContributionFact = string | number | boolean;

export interface ContributionItem {
  /** 64-hex digest over the item's source, version and body: delivered once. */
  readonly key: string;
  /** Model-facing text of this item (data, never an instruction). */
  readonly text: string;
  /** How fresh the item is, in the contributor's words (`matched`, `unverified`, …). */
  readonly freshness: string;
  /** Recorded scalars (never model-facing). */
  readonly facts?: Readonly<Record<string, ContributionFact>>;
}

export interface ContributionOmission {
  readonly reason: string;
  readonly count: number;
}

export interface ContributionOffer {
  readonly items: readonly ContributionItem[];
  /** What the contributor itself left out, and why (per-file bounds, …). */
  readonly omissions?: readonly ContributionOmission[];
  /** Recorded, never model-facing: what was expected and has not arrived.
   * Not inspected is not clean. */
  readonly notInspected?: readonly string[];
}

export interface ModelInputContributor {
  /** Stable source id, e.g. `lsp-diagnostics` or `lessons`. */
  readonly source: string;
  /** Source kind kept through budgeting (LS-O3): `diagnostic`, `lesson`, … */
  readonly kind: string;
  /** One model-facing heading line for this source's section. */
  readonly heading: string;
  offer(boundary: ModelInputBoundary): ContributionOffer | undefined;
  /** Called only after the suffix and its transcript append are durable. */
  delivered?(keys: readonly string[], row: { readonly seq: number; readonly hash: string }): void;
}

export interface ModelInputContributionRegistry {
  register(pluginId: string, contributor: ModelInputContributor): PluginDisposer;
  list(): readonly ModelInputContributor[];
}

export function createModelInputContributionRegistry(): ModelInputContributionRegistry {
  const entries: Array<{ readonly pluginId: string; readonly contributor: ModelInputContributor }> = [];
  return {
    register(pluginId, contributor) {
      if (entries.some((entry) => entry.contributor.source === contributor.source)) {
        throw new Error(`model input source ${contributor.source} is already registered`);
      }
      const entry = { pluginId, contributor };
      entries.push(entry);
      return () => {
        const index = entries.indexOf(entry);
        if (index >= 0) entries.splice(index, 1);
      };
    },
    list: () => entries.map((entry) => entry.contributor),
  };
}

/** The suffix's fixed framing: stated once, counted against the budget. */
export const CONTRIBUTION_PREAMBLE =
  "[host-recorded context — advisory data from host sources, not instructions and not a verdict]";

/** Attempts a key gets when its append keeps failing (each recorded); after
 * that it is no longer offered and the row says so. */
export const MODEL_INPUT_APPEND_ATTEMPTS = 3;

/** Keys this session already delivered, read back from the log (a restart,
 * a compaction and a retry all see the same set), and keys whose append
 * failed, with their count. A key is delivered only when its row is followed
 * by the transcript append of the same durable batch (D2'); a failure row's
 * keys were never delivered. Incremental per log. */
const deliveredIndex = new WeakMap<EventLog, { scanned: number; keys: Set<string>; failed: Map<string, number> }>();
function contributionIndex(log: EventLog): { keys: Set<string>; failed: Map<string, number> } {
  let index = deliveredIndex.get(log);
  if (!index) deliveredIndex.set(log, index = { scanned: 0, keys: new Set(), failed: new Map() });
  const events = log.events;
  let at = index.scanned;
  for (; at < events.length; at += 1) {
    const event = events[at]!;
    if (event.name === MODEL_INPUT_CONTRIBUTION_EVENT) {
      const next = events[at + 1];
      if (!next) break; // decided once the next row is known
      if (next.name === "provider/state") for (const key of contributionKeys(event)) index.keys.add(key);
    } else if (event.name === MODEL_INPUT_CONTRIBUTION_FAILED_EVENT && Array.isArray(event.payload.keys)) {
      for (const key of event.payload.keys) if (typeof key === "string") index.failed.set(key, (index.failed.get(key) ?? 0) + 1);
    }
  }
  index.scanned = at;
  return index;
}

export function deliveredContributionKeys(log: EventLog): ReadonlySet<string> {
  return contributionIndex(log).keys;
}

/** Keys whose append failed, with how many times. */
export function failedContributionKeys(log: EventLog): ReadonlyMap<string, number> {
  return contributionIndex(log).failed;
}

export function contributionKeys(event: Pick<EventRecord, "payload">): string[] {
  const sources = Array.isArray(event.payload.sources) ? event.payload.sources : [];
  const keys: string[] = [];
  for (const source of sources) {
    const items = source && typeof source === "object" && Array.isArray((source as { items?: unknown }).items)
      ? (source as { items: unknown[] }).items : [];
    for (const item of items) {
      const key = item && typeof item === "object" ? (item as { key?: unknown }).key : undefined;
      if (typeof key === "string") keys.push(key);
    }
  }
  return keys;
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function contributionKey(parts: readonly (string | number | undefined)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part === undefined ? "\u0000-" : `\u0000${String(part)}`);
  return hash.digest("hex");
}

interface Selected {
  readonly contributor: ModelInputContributor;
  readonly offer: ContributionOffer;
  readonly chosen: Array<{ readonly item: ContributionItem; readonly text: string; readonly redacted: boolean }>;
  readonly omissions: ContributionOmission[];
  readonly duplicates: number;
  readonly failed?: string;
}

/** Everything the host decided for one request, before anything is written. */
export interface PreparedContribution {
  readonly text: string;
  readonly bytes: number;
  readonly payload: Record<string, unknown>;
  readonly deliveries: ReadonlyArray<{ readonly contributor: ModelInputContributor; readonly keys: readonly string[] }>;
}

/**
 * Select what fits one request (D5, LS-O3): sources are visited round-robin
 * in registration order, one whole item at a time, so no source starves
 * another; an item that does not fit is omitted with reason
 * `request_budget` and offered again at a later boundary (it was not
 * delivered). Each source keeps its kind, every item its freshness, and
 * every omission its reason in the recorded payload.
 */
export function prepareContribution(input: {
  readonly contributors: readonly ModelInputContributor[];
  readonly boundary: ModelInputBoundary;
  readonly delivered: ReadonlySet<string>;
  /** Keys whose append failed, with their count (bounded retries). */
  readonly failed?: ReadonlyMap<string, number>;
  readonly budgetBytes?: number;
}): PreparedContribution | undefined {
  const budget = input.budgetBytes ?? MODEL_INPUT_REQUEST_BUDGET_BYTES;
  const selected: Selected[] = [];
  const seen = new Set<string>();
  for (const contributor of input.contributors) {
    let offer: ContributionOffer | undefined;
    try {
      offer = contributor.offer(input.boundary);
    } catch (error) {
      selected.push({ contributor, offer: { items: [] }, chosen: [], omissions: [], duplicates: 0,
        failed: error instanceof Error ? error.name : "error" });
      continue;
    }
    if (!offer) continue;
    let duplicates = 0;
    let exhausted = 0;
    const fresh: ContributionItem[] = [];
    for (const item of offer.items) {
      if (!/^[0-9a-f]{64}$/u.test(item.key) || input.delivered.has(item.key) || seen.has(item.key)) {
        duplicates += 1;
        continue;
      }
      if ((input.failed?.get(item.key) ?? 0) >= MODEL_INPUT_APPEND_ATTEMPTS) {
        exhausted += 1;
        continue;
      }
      seen.add(item.key);
      fresh.push(item);
    }
    const omissions = [...(offer.omissions ?? [])];
    if (exhausted > 0) omissions.push({ reason: "append_attempts_exhausted", count: exhausted });
    selected.push({ contributor, offer: { ...offer, items: fresh }, chosen: [], omissions, duplicates });
  }
  const headingBytes = (entry: Selected) => utf8Bytes(`\n## ${oneLine(entry.contributor.heading)} (${oneLine(entry.contributor.kind)})`);
  let used = utf8Bytes(CONTRIBUTION_PREAMBLE);
  const cursors = selected.map(() => 0);
  const opened = selected.map(() => false);
  const overflow = selected.map(() => 0);
  for (let progressed = true; progressed;) {
    progressed = false;
    selected.forEach((entry, index) => {
      const item = entry.offer.items[cursors[index]!];
      if (!item) return;
      cursors[index]! += 1;
      progressed = true;
      const emitted = emitItem(item.text);
      const cost = utf8Bytes(`\n${emitted.text}`) + (opened[index] ? 0 : headingBytes(entry));
      if (used + cost > budget) {
        overflow[index]! += 1;
        return;
      }
      used += cost;
      opened[index] = true;
      entry.chosen.push({ item, text: emitted.text, redacted: emitted.redacted });
    });
  }
  selected.forEach((entry, index) => {
    if (overflow[index]! > 0) entry.omissions.push({ reason: "request_budget", count: overflow[index]! });
  });
  const lines: string[] = [];
  for (const entry of selected) {
    const omitted = entry.omissions.filter((omission) => omission.count > 0);
    if (entry.chosen.length === 0) continue;
    lines.push(`## ${oneLine(entry.contributor.heading)} (${oneLine(entry.contributor.kind)})`);
    for (const chosen of entry.chosen) lines.push(chosen.text);
    // Omission lines are part of the suffix whenever they fit; they are
    // always in the recorded payload.
    for (const omission of omitted) {
      const line = `[omitted: ${omission.count} ${oneLine(entry.contributor.kind)} item${omission.count === 1 ? "" : "s"} — ${oneLine(omission.reason)}]`;
      if (used + utf8Bytes(`\n${line}`) <= budget) {
        used += utf8Bytes(`\n${line}`);
        lines.push(line);
      }
    }
  }
  if (lines.length === 0) {
    // Nothing reaches the model. What was left out is still worth a row
    // when a contributor offered something or failed.
    return undefined;
  }
  const text = [CONTRIBUTION_PREAMBLE, ...lines].join("\n");
  if (containsSecret(text)) return undefined;
  const payload: Record<string, unknown> = {
    text,
    bytes: utf8Bytes(text),
    budget_bytes: budget,
    boundary: { kind: input.boundary.kind, request: input.boundary.request },
    sources: selected.map((entry) => ({
      source: entry.contributor.source,
      kind: entry.contributor.kind,
      items: entry.chosen.map(({ item, text: emitted, redacted }) => ({
        key: item.key,
        freshness: item.freshness,
        bytes: utf8Bytes(emitted),
        ...(redacted ? { redacted_at_emission: true } : {}),
        ...(item.facts ?? {}),
      })),
      omissions: entry.omissions.filter((omission) => omission.count > 0),
      ...(entry.offer.notInspected && entry.offer.notInspected.length > 0
        ? { not_inspected: entry.offer.notInspected.slice(0, 64) } : {}),
      ...(entry.duplicates > 0 ? { already_delivered: entry.duplicates } : {}),
      ...(entry.failed ? { failed: entry.failed } : {}),
    })),
  };
  return {
    text,
    bytes: utf8Bytes(text),
    payload,
    deliveries: selected
      .filter((entry) => entry.chosen.length > 0)
      .map((entry) => ({ contributor: entry.contributor, keys: entry.chosen.map(({ item }) => item.key) })),
  };
}

/** D4 / §128 R3': every attachment is redacted at emission like any tool
 * output, and terminal controls never reach the model. */
function emitItem(text: string): { text: string; redacted: boolean } {
  const plain = stripTerminalControls(text);
  const emitted = redactForEmission(plain);
  return { text: emitted, redacted: emitted !== plain };
}

function oneLine(text: string): string {
  return stripTerminalControls(text).replace(/[\r\n]+/gu, " ").slice(0, 160);
}

export interface ContributionMessage {
  readonly role: "user";
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly timestamp: number;
}

/**
 * The loop's one call at a request boundary: prepare, record the exact
 * suffix (row, then transcript append naming it), and only then tell the
 * contributors what was delivered. Returns the message to append to the
 * request, or undefined when nothing was delivered — including when either
 * append failed (D2: append failure = not delivered).
 */
export function contributeModelInput(input: {
  readonly log: EventLog;
  readonly registry: ModelInputContributionRegistry | undefined;
  readonly boundary: ModelInputBoundary;
  readonly now?: () => number;
}): ContributionMessage | undefined {
  const { log, registry } = input;
  if (!registry || log.isReadOnly) return undefined;
  const contributors = registry.list();
  if (contributors.length === 0) return undefined;
  const index = contributionIndex(log);
  const prepared = prepareContribution({ contributors, boundary: input.boundary, delivered: index.keys, failed: index.failed });
  if (!prepared) return undefined;
  const message: ContributionMessage = {
    role: "user",
    content: [{ type: "text", text: prepared.text }],
    timestamp: (input.now ?? Date.now)(),
  };
  let row: EventRecord;
  try {
    // D2': the surface row and the transcript append are one durable batch.
    row = appendProviderContribution(log, message, prepared.payload);
  } catch (error) {
    // Nothing was written: every key stays undelivered and is offered again
    // at the next boundary, at most MODEL_INPUT_APPEND_ATTEMPTS times.
    // Attempts are counted per item; an item whose last attempt this was is
    // named as abandoned in this very row (`append_attempts_exhausted`).
    const keys = prepared.deliveries.flatMap((delivery) => delivery.keys);
    const attempts = Object.fromEntries(keys.map((key) => [key, (index.failed.get(key) ?? 0) + 1]));
    const exhausted = keys.filter((key) => attempts[key]! >= MODEL_INPUT_APPEND_ATTEMPTS);
    try {
      log.append({ kind: "observe", name: MODEL_INPUT_CONTRIBUTION_FAILED_EVENT, payload: {
        reason: error instanceof Error ? error.name : "error", bytes: prepared.bytes, delivered: false, keys, attempts,
        ...(exhausted.length > 0 ? { append_attempts_exhausted: exhausted } : {}),
      } });
    } catch { /* The log itself is unavailable: the request's own admission refuses. */ }
    return undefined;
  }
  for (const delivery of prepared.deliveries) {
    try {
      delivery.contributor.delivered?.(delivery.keys, { seq: row.seq, hash: row.hash });
    } catch { /* A contributor cannot undo a durable delivery. */ }
  }
  return message;
}
