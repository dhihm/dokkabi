import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { EventLog } from "./event-log.ts";
import type { EventRecord } from "./schema.ts";
import { deliverToolResult, RESULT_SOURCE_EVENT } from "./result-source.ts";
import { redactForEmission, safeToolResultInput } from "./tool-result-input.ts";
import { runInInvocation } from "./invocation-scope.ts";
import { toolArgumentsDigest } from "./tool-loop.ts";
import { canonicalJson } from "./canonical.ts";
import { containsPrivateInfrastructureValue, secretShapeClassInValue } from "./redact.ts";
import { producerCoverageOf, readResultProjection, sha256Text, TOOL_RESULT_MODEL_BUDGET, utf8Bytes, type ProducerCoverage } from "../tools/model-result.ts";
import { readIdentityKey } from "./read-identity.ts";
import { isSecretWorkspaceTarget } from "./workspace-secrets.ts";
import {
  isSecretPath,
  pathInsideWorkspace,
  workspaceToolPath,
  workspaceToolsGeneration,
  workspaceToolsReaders,
} from "../plugins/workspace-tools.ts";
import { isChildToolRow, READ_BATCH_CHILD_CALL_EVENT } from "./tool-rows.ts";

/**
 * Recorded read batches (#228, design memo §138, red team round 1 §139).
 *
 * A batch is a composition of independent, already-authorised reads whose
 * every child stays its own recorded invocation; the batch adds ordering and
 * a queue — never authority, never a snapshot, never a verdict.
 *
 * A1/A1' admission is a closed allowlist of reviewed adapters enrolled from
 *    the host-built tool OBJECTS at their generation; the whole request is
 *    decided before any child starts. Child args are own enumerable
 *    properties on a null-prototype copy, checked against the adapter's
 *    closed shape and then by the tool's own schema through the same
 *    validator a single call passes (`validateToolArguments`); an inherited
 *    or unknown key rejects the whole request.
 * A2/A2' every child executes through the registered tool object, as its
 *    own invocation (`rbi_…`) whose parent is the model's call, after the
 *    loop's own pre-call pipeline (`tool_call_pipeline`: profile, cooldown,
 *    per-turn budget — each child one call — container mapping); "the same
 *    read twice" is decided by the folded host path, not its spelling.
 * Q1/Q1'/Q2 one shared bounded queue per session (16 items, 4 concurrent,
 *    1 MiB pending preview); bounds refuse, never truncate; coverage is read
 *    only from the producer's structured statement (`details.coverage`),
 *    never inferred from a missing marker; an unresolved child returns its
 *    slot after the settle grace and is counted in a bounded unresolved set.
 * O1/O1' results are assembled in request ordinal order; the batch status
 *    is `readBatchStatus`, a pure function of the item statuses, and every
 *    terminal status carries a reason.
 * V1 per-item version binding through #223 sources; `snapshot` is refused
 *    as unsupported before execution and never downgraded.
 * C1/C1' the abort listener is registered before the aborted state is
 *    checked; a child that ends after the signal fired is `cancelled`; an
 *    unsettled child after the grace is `unresolved` with the batch as its
 *    recorded owner; a later settlement is recorded and discarded.
 * R1/R1' `read_batch/result` (every child source ref, the aggregate and the
 *    items digest) is appended before the aggregate is returned; replay
 *    preflight recomputes the status and the items digest from the child
 *    rows and checks duplicate execution by (parent, resource, args, digest,
 *    generation).
 * S1/S1' each child is redacted and delivered through #223 by itself; the
 *    aggregate is admitted against the tool-result budget before delivery —
 *    what does not fit is `omitted` by item status with the bytes retained
 *    as child sources and the omitted ids stated.
 * X1 the tool is not a speculation tier-1 name and children never pass
 *    through the loop's execution: nothing else can run the same child.
 */

export const READ_BATCH_ITEMS_MAX = 16;
export const READ_BATCH_CONCURRENCY = 4;
export const READ_BATCH_PENDING_PREVIEW_BYTES = 1024 * 1024;
/** How long a running child is waited for after cancellation before it is
 * `unresolved` (mirrors the kernel membership patience of sandbox runs). */
export const READ_BATCH_SETTLE_GRACE_MS = 2_000;
/** A local composition bound, not a task deadline: a batch that has not
 * settled by then stops starting children (the same path as a cancel). */
export const READ_BATCH_DEADLINE_MS = 60_000;
/** The smallest per-child projection budget; the aggregate shares the one
 * tool-result budget among its items so every item keeps a visible head. */
export const READ_BATCH_CHILD_BUDGET_MIN = 1_024;
/** What the aggregate spends per item and per batch besides the texts
 * (ids, sources, reasons), and the JSON escaping allowance the child budget
 * leaves; the exact guard is `admitReadBatchAggregate` (S1'), this only
 * makes omission the exception. */
export const READ_BATCH_AGGREGATE_ITEM_OVERHEAD = 450;
export const READ_BATCH_AGGREGATE_HEADER = 600;
export const READ_BATCH_ESCAPING_ALLOWANCE = 1.15;

/** The per-child projection budget for `n` items under `budget`. */
export function readBatchChildBudget(budget: number, n: number): number {
  return Math.max(READ_BATCH_CHILD_BUDGET_MIN, Math.floor((budget - READ_BATCH_AGGREGATE_HEADER - READ_BATCH_AGGREGATE_ITEM_OVERHEAD * n) / (READ_BATCH_ESCAPING_ALLOWANCE * n)));
}
/** Q2: how many unresolved children a session's queue remembers. */
export const READ_BATCH_UNRESOLVED_MAX = 64;

export const READ_BATCH_START_EVENT = "read_batch/start";
export const READ_BATCH_CHILD_EVENT = "read_batch/child";
export const READ_BATCH_RESULT_EVENT = "read_batch/result";
export const READ_BATCH_TOOLS_EVENT = "read_batch/tools";

export const READ_BATCH_ITEM_STATUSES = ["ok", "omitted", "error", "cancelled", "stale", "unsupported", "unresolved"] as const;
export type ReadBatchItemStatus = (typeof READ_BATCH_ITEM_STATUSES)[number];
export const READ_BATCH_STATUSES = ["complete", "partial", "cancelled", "rejected"] as const;
export type ReadBatchStatus = (typeof READ_BATCH_STATUSES)[number];
/** S1'': the closed reason vocabulary the aggregate carries — never free
 * text (a tool's refusal text lives on the child row as `detail`). */
export const READ_BATCH_REASON_CODES = [
  "complete", "partial_coverage", "unverified_coverage", "omitted_for_budget", "adapter_refused", "adapter_error",
  "preview_bound", "descriptor_unloaded", "pipeline_refused", "cancelled_before_start", "ended_by_signal", "unresolved", "unrecorded",
] as const;
export type ReadBatchReasonCode = (typeof READ_BATCH_REASON_CODES)[number];

export interface BatchReadSource {
  readonly rootId: string;
  readonly resource: string;
  readonly digest: string;
  /** `unverified`: the producer made no structured statement of coverage. */
  readonly coverage: "complete" | "partial" | "unverified";
}

export interface ReadBatchRequestItem {
  readonly id: string;
  readonly capabilityId: string;
  readonly args: unknown;
}

export interface ReadBatchRequest {
  readonly items: readonly ReadBatchRequestItem[];
  readonly consistency?: "per-item" | "snapshot";
}

export interface ReadBatchItemResult {
  readonly id: string;
  readonly invocationRef: string;
  readonly status: ReadBatchItemStatus;
  readonly sources: readonly BatchReadSource[];
  readonly consistency: "version-bound" | "unverified";
  /** The host handle of the child's recorded source (`blob:<digest>`). */
  readonly resultRef?: string;
  /** The child row that recorded it (`seq:<n>`). */
  readonly projectionRef?: string;
  readonly reason: string;
  /** The closed code the aggregate carries for `reason` (S1''). */
  readonly code?: ReadBatchReasonCode;
  /** The child's delivered text (its #223 projection), for `ok` items. */
  readonly text?: string;
  readonly bytes?: number;
  readonly omittedBytes?: number;
}

export interface ReadBatchResult {
  readonly batchRef: string;
  readonly items: readonly ReadBatchItemResult[];
  readonly status: ReadBatchStatus;
  readonly snapshotRef?: string;
  readonly reason: string;
  /** Ids whose text was left out of the aggregate for the delivery budget (S1'). */
  readonly omitted: readonly string[];
  /** Whether the aggregate row exists; false only when the log refused it,
   * in which case `items` carry no text. */
  readonly recorded: boolean;
}

export interface RecordedReadBatch {
  run(request: ReadBatchRequest, signal: AbortSignal, context: { readonly parent: string }): Promise<ReadBatchResult>;
}

/** The loop's pre-call pipeline as a read batch sees it (A2'): the same
 * function the loop's `beforeToolCall` uses, or none when no agent is live. */
export type ChildCallPipeline = (call: { readonly name: string; readonly id: string; readonly args: unknown; readonly parent: string }) =>
  { readonly block: false } | { readonly block: true; readonly reason: string; readonly terminate?: boolean };

// --- A1: adapters and enrolment ----------------------------------------------

export type ReadArgSpec =
  | { readonly kind: "string"; readonly required?: boolean; readonly maxLength?: number; readonly path?: boolean }
  | { readonly kind: "integer"; readonly min: number; readonly max: number }
  | { readonly kind: "boolean" };

export interface ReadAdapter {
  /** The capability id a request names (`read`, `repo.grep`, …). */
  readonly capability: string;
  /** The registered tool's name. */
  readonly descriptor: string;
  /** The operation within the descriptor (`read` for a single-op tool). */
  readonly operation: string;
  /** The registered tool object itself; execution goes through it. */
  readonly tool: AgentTool;
  /** The closed argument shape a request may supply. */
  readonly args: Readonly<Record<string, ReadArgSpec>>;
  /** Arguments the batch sets itself (a repo op's `op`); a request that
   * supplies one is refused. */
  readonly fixed?: Readonly<Record<string, string>>;
  /** Which root the item's source belongs to. */
  readonly rootId: (args: Record<string, unknown>) => string;
  /** The resource the item read, for its source (never a raw secret). */
  readonly resource: (args: Record<string, unknown>) => string;
}

export interface ReadAdapterEnrolment {
  readonly generation: string;
  readonly rootId: string;
  /** The workspace root the loop's own path predicates are asked about. */
  readonly root?: string;
  readonly adapters: ReadonlyMap<string, ReadAdapter>;
  /** False once the tool set behind the adapters is disposed or replaced. */
  live(): boolean;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const PATH_MAX = 4_096;

function rootIdentity(root: string): string {
  try {
    const stat = statSync(root, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return "unknown";
  }
}

/** A closed shape as a null-prototype object: a lookup finds only what the
 * adapter declared, never `constructor` or `__proto__`. */
function closedShape(shape: Readonly<Record<string, ReadArgSpec>>): Readonly<Record<string, ReadArgSpec>> {
  return Object.freeze(Object.assign(Object.create(null) as Record<string, ReadArgSpec>, shape));
}

/**
 * The v1 allowlist over the ACTUAL registered tools: the host's `read`,
 * `grep`, `glob`, `ls` and the read-only `repo` operations, each by the tool
 * object found in `tools` — only the host-built objects, never a tool that
 * merely carries the name. Undefined when the tools carry no generation.
 */
export function enrolWorkspaceReadAdapters(tools: readonly AgentTool[], root: string): ReadAdapterEnrolment | undefined {
  const generation = workspaceToolsGeneration(tools);
  const readers = workspaceToolsReaders(tools);
  if (generation === undefined || readers === undefined) return undefined;
  const rootId = rootIdentity(root);
  const byName = new Map<string, AgentTool>();
  for (const tool of tools) if (readers.has(tool) && !byName.has(tool.name)) byName.set(tool.name, tool);
  const adapters = new Map<string, ReadAdapter>();
  const workspace = (args: Record<string, unknown>) => { void args; return rootId; };
  const read = byName.get("read");
  if (read) {
    adapters.set("read", {
      capability: "read", descriptor: "read", operation: "read", tool: read,
      args: closedShape({ path: { kind: "string", required: true, maxLength: PATH_MAX, path: true }, offset: { kind: "integer", min: 1, max: 10_000_000 }, limit: { kind: "integer", min: 1, max: 100_000 } }),
      rootId: workspace, resource: (args) => String(args.path),
    });
  }
  const grep = byName.get("grep");
  if (grep) {
    adapters.set("grep", {
      capability: "grep", descriptor: "grep", operation: "grep", tool: grep,
      args: closedShape({ pattern: { kind: "string", required: true, maxLength: 1_024 }, path: { kind: "string", maxLength: PATH_MAX, path: true }, glob: { kind: "string", maxLength: 1_024 }, case_sensitive: { kind: "boolean" }, max_results: { kind: "integer", min: 1, max: 500 } }),
      rootId: workspace, resource: (args) => typeof args.path === "string" ? args.path : ".",
    });
  }
  const glob = byName.get("glob");
  if (glob) {
    adapters.set("glob", {
      capability: "glob", descriptor: "glob", operation: "glob", tool: glob,
      args: closedShape({ pattern: { kind: "string", required: true, maxLength: 1_024, path: true } }),
      rootId: workspace, resource: (args) => String(args.pattern),
    });
  }
  const ls = byName.get("ls");
  if (ls) {
    adapters.set("ls", {
      capability: "ls", descriptor: "ls", operation: "ls", tool: ls,
      args: closedShape({ path: { kind: "string", maxLength: PATH_MAX, path: true } }),
      rootId: workspace, resource: (args) => typeof args.path === "string" ? args.path : ".",
    });
  }
  const repo = byName.get("repo");
  if (repo) {
    const repoRoot = (args: Record<string, unknown>) => `repo:${String(args.repo)}`;
    const target = (args: Record<string, unknown>) => `${String(args.repo)}@${typeof args.ref === "string" ? args.ref : "default"}:${typeof args.path === "string" ? args.path : typeof args.pattern === "string" ? args.pattern : typeof args.glob === "string" ? args.glob : "."}`;
    const common: Record<string, ReadArgSpec> = { repo: { kind: "string", required: true, maxLength: 256 }, ref: { kind: "string", maxLength: 256 } };
    const ops: Record<string, Record<string, ReadArgSpec>> = {
      pin: {},
      grep: { pattern: { kind: "string", required: true, maxLength: 1_024 }, path: { kind: "string", maxLength: PATH_MAX }, glob: { kind: "string", maxLength: 1_024 }, case_sensitive: { kind: "boolean" }, max_results: { kind: "integer", min: 1, max: 500 } },
      glob: { glob: { kind: "string", required: true, maxLength: 1_024 } },
      ls: { path: { kind: "string", maxLength: PATH_MAX } },
      read: { path: { kind: "string", required: true, maxLength: PATH_MAX } },
    };
    for (const [op, args] of Object.entries(ops)) {
      adapters.set(`repo.${op}`, {
        capability: `repo.${op}`, descriptor: "repo", operation: op, tool: repo,
        args: closedShape({ ...common, ...args }), fixed: { op },
        rootId: repoRoot, resource: target,
      });
    }
  }
  return { generation, rootId, root, adapters, live: () => workspaceToolsGeneration(tools) === generation };
}

export interface AdmittedReadItem {
  readonly id: string;
  readonly ordinal: number;
  readonly adapter: ReadAdapter;
  /** The arguments as the tool's own validator returned them. */
  readonly args: Record<string, unknown>;
}

export type ReadBatchAdmission =
  | { readonly ok: true; readonly items: readonly AdmittedReadItem[]; readonly consistency: "per-item" }
  | { readonly ok: false; readonly reason: string; readonly snapshot?: "unsupported" };

/** A string that names another item or a template is child-dependent. */
function childDependent(value: string): boolean {
  return value.startsWith("$") || value.startsWith("@item") || value.includes("{{") || value.includes("${");
}

/** Q1''': a resource with control characters is refused at admission. */
const CONTROL = /[\u0000-\u001f\u007f]/u;

/**
 * The whole request, decided before any child starts (A1/A1'). Every refusal
 * is the request's, with a specific reason; the admitted items carry the
 * enrolled adapter and the validated arguments.
 */
export function admitReadBatchRequest(request: unknown, enrolment: ReadAdapterEnrolment): ReadBatchAdmission {
  const refuse = (reason: string, extra: { snapshot?: "unsupported" } = {}): ReadBatchAdmission => ({ ok: false, reason, ...extra });
  if (!request || typeof request !== "object" || Array.isArray(request)) return refuse("request must be an object with items");
  const record = request as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "items" && key !== "consistency") return refuse(`unknown request field ${key}; the host mints every reference`);
  }
  const consistency = Object.hasOwn(record, "consistency") ? record.consistency : "per-item";
  if (consistency !== "per-item" && consistency !== "snapshot") return refuse("consistency must be per-item or snapshot");
  const items = record.items;
  if (!Array.isArray(items)) return refuse("items must be an array");
  if (items.length === 0) return refuse("items must name at least one read");
  if (items.length > READ_BATCH_ITEMS_MAX) return refuse(`items exceed the batch bound of ${READ_BATCH_ITEMS_MAX}`);
  if (!enrolment.live()) return refuse(`the enrolled adapters are not live (generation ${enrolment.generation} was unloaded)`);
  const admitted: AdmittedReadItem[] = [];
  const ids = new Set<string>();
  const reads = new Set<string>();
  for (const [ordinal, raw] of items.entries()) {
    const at = `items[${ordinal}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return refuse(`${at} must be an object`);
    const item = raw as Record<string, unknown>;
    for (const key of Object.keys(item)) {
      if (key !== "id" && key !== "capabilityId" && key !== "args") return refuse(`${at}.${key} is not a request field; the host mints every reference`);
    }
    const id = item.id;
    if (typeof id !== "string" || !ID.test(id)) return refuse(`${at}.id must be a safe identifier of up to 64 characters`);
    if (ids.has(id)) return refuse(`duplicate item id ${id}`);
    ids.add(id);
    const capability = item.capabilityId;
    if (typeof capability !== "string") return refuse(`${at}.capabilityId must be a string`);
    const adapter = enrolment.adapters.get(capability);
    if (!adapter) {
      return refuse(`${at}: capability ${capability} is not an enrolled read adapter (enrolled: ${[...enrolment.adapters.keys()].sort().join(", ")})`);
    }
    const args = item.args;
    if (!args || typeof args !== "object" || Array.isArray(args)) return refuse(`${at}.args must be an object`);
    // A1': own enumerable properties only, on a null-prototype copy; the
    // closed shape is looked up by own key, never through a prototype.
    const own = Object.assign(Object.create(null) as Record<string, unknown>, args as Record<string, unknown>);
    const checked: Record<string, unknown> = Object.create(null);
    const folded: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(own)) {
      const value = own[key];
      if (adapter.fixed && Object.hasOwn(adapter.fixed, key)) return refuse(`${at}.args.${key} is set by the capability ${capability}`);
      if (!Object.hasOwn(adapter.args, key)) return refuse(`${at}.args.${key} is not an argument of ${capability}`);
      const spec = adapter.args[key]!;
      if (spec.kind === "string") {
        if (typeof value !== "string") return refuse(`${at}.args.${key} must be a string`);
        if (value.length === 0 || (spec.maxLength !== undefined && value.length > spec.maxLength)) return refuse(`${at}.args.${key} exceeds its bound`);
        if (CONTROL.test(value)) return refuse(`${at}.args.${key} carries a control character`);
        if (childDependent(value)) return refuse(`${at}.args.${key} depends on another item; child-dependent arguments are not composed`);
        if (spec.path) {
          // The loop's own predicates for a single read (loop-pi's pipeline):
          // A2''' — the container alias is mapped first, as the single call's
          // `guardedPath` is, and the mapped path is what is checked and folded.
          const guarded = key === "path" && enrolment.root !== undefined && adapter.descriptor !== "repo"
            && (process.env.DOKKABI_DOCKER_CONTAINER || process.env.DOKKABI_SWE_CONTAINER)
            ? workspaceToolPath(enrolment.root, value)
            : value;
          const secret = key === "path" && enrolment.root !== undefined && adapter.descriptor !== "repo"
            ? isSecretWorkspaceTarget(enrolment.root, guarded)
            : isSecretPath(guarded);
          if (secret) return refuse(`${at}.args.${key} names a secret file; refused as a single read would be`);
          if (key === "path" && enrolment.root !== undefined && !pathInsideWorkspace(enrolment.root, guarded)) {
            return refuse(`${at}.args.${key} is outside the workspace`);
          }
          if (key === "pattern" && (value.startsWith("/") || value.includes(".."))) return refuse(`${at}.args.${key} is outside the workspace`);
          folded[key] = guarded;
        } else {
          folded[key] = value;
        }
      } else if (spec.kind === "integer") {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
          return refuse(`${at}.args.${key} must be an integer in [${spec.min}, ${spec.max}]`);
        }
        folded[key] = value;
      } else if (typeof value !== "boolean") {
        return refuse(`${at}.args.${key} must be a boolean`);
      } else {
        folded[key] = value;
      }
      checked[key] = value;
    }
    for (const key of Object.keys(adapter.args)) {
      const spec = adapter.args[key]!;
      if (spec.kind === "string" && spec.required && !Object.hasOwn(checked, key)) return refuse(`${at}.args.${key} is required by ${capability}`);
    }
    const secretShape = secretShapeClassInValue({ ...checked });
    if (secretShape !== undefined) return refuse(`${at}.args carry ${secretShape}; remove the credential value`);
    // The loop protects a single read's arguments from private coordinates.
    if (adapter.descriptor === "read" && containsPrivateInfrastructureValue({ ...checked })) return refuse(`${at}.args carry a private infrastructure literal`);
    // A2'/A2'': the same read twice, by the ONE fold the loop's cooldown uses
    // (read-identity.ts): what the path reaches plus the other arguments.
    const key = `${capability}\u0000${readIdentityKey(adapter.descriptor, { ...folded }, adapter.descriptor === "repo" ? undefined : enrolment.root) ?? canonicalJson({ ...folded })}`;
    if (reads.has(key)) return refuse(`${at} repeats the read of an earlier item (${capability} with the same arguments)`);
    reads.add(key);
    // A1': the tool's own schema, through the validator a single call passes.
    const forwarded = { ...(adapter.fixed ?? {}), ...checked };
    let validated: Record<string, unknown>;
    try {
      validated = validateToolArguments(adapter.tool as never, { type: "toolCall", id: "admission", name: adapter.tool.name, arguments: forwarded }) as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return refuse(`${at}.args refused by the ${adapter.descriptor} tool's own schema: ${redactForEmission(message.split("\n").slice(0, 2).join(" ").trim()).slice(0, 200)}`);
    }
    if (!validated || typeof validated !== "object") return refuse(`${at}.args refused by the ${adapter.descriptor} tool's own schema`);
    for (const key of Object.keys(validated)) {
      if (!Object.hasOwn(forwarded, key)) return refuse(`${at}.args.${key} was not requested`);
    }
    admitted.push({ id, ordinal, adapter, args: Object.assign(Object.create(null) as Record<string, unknown>, validated) });
  }
  if (consistency === "snapshot") {
    return refuse("snapshot is unsupported: no enrolled adapter provides an immutable view; request consistency per-item (each source's own version)", { snapshot: "unsupported" });
  }
  return { ok: true, items: admitted, consistency: "per-item" };
}

// --- Q1/Q2: the session's shared bounded queue --------------------------------

export interface ReadQueueLimits {
  readonly concurrency: number;
  readonly pendingPreviewBytes: number;
}

interface Waiter {
  readonly resolve: (release: (() => void) | undefined) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

/** One queue per session: children of every batch (and any other host
 * caller that takes a slot) share its slots and its pending-preview budget.
 * Q2: a slot belongs to the child's owner while the child is awaited; an
 * unresolved child returns it and is remembered in a bounded set. */
export class SessionReadQueue {
  private running = 0;
  private pending = 0;
  private readonly waiters: Waiter[] = [];
  private readonly unresolvedChildren = new Map<string, { readonly owner: string; readonly since: number }>();
  /** Longest queue wait observed, for the dashboard. */
  private waits = 0;

  constructor(readonly limits: ReadQueueLimits = { concurrency: READ_BATCH_CONCURRENCY, pendingPreviewBytes: READ_BATCH_PENDING_PREVIEW_BYTES }) {}

  get snapshot(): { readonly running: number; readonly waiting: number; readonly pendingBytes: number; readonly waits: number; readonly unresolved: number } {
    return { running: this.running, waiting: this.waiters.length, pendingBytes: this.pending, waits: this.waits, unresolved: this.unresolvedChildren.size };
  }

  /** A slot, FIFO; undefined when the signal aborts first (no new start). */
  acquire(signal: AbortSignal): Promise<(() => void) | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    if (this.running < this.limits.concurrency && this.waiters.length === 0) {
      this.running += 1;
      return Promise.resolve(this.releaser());
    }
    this.waits += 1;
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve,
        signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve(undefined);
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running -= 1;
      this.grant();
    };
  }

  private grant(): void {
    while (this.running < this.limits.concurrency && this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      next.signal.removeEventListener("abort", next.onAbort);
      this.running += 1;
      next.resolve(this.releaser());
    }
  }

  /** Q2: an unresolved child, remembered with its owner; the oldest is
   * forgotten past the bound (the row is the record either way). */
  noteUnresolved(invocation: string, owner: string): void {
    this.unresolvedChildren.set(invocation, { owner, since: Date.now() });
    while (this.unresolvedChildren.size > READ_BATCH_UNRESOLVED_MAX) this.unresolvedChildren.delete(this.unresolvedChildren.keys().next().value!);
  }

  settleUnresolved(invocation: string): void {
    this.unresolvedChildren.delete(invocation);
  }

  /** Reserve pending preview bytes; false (nothing reserved) past the bound. */
  reservePreview(bytes: number): boolean {
    if (bytes < 0 || this.pending + bytes > this.limits.pendingPreviewBytes) return false;
    this.pending += bytes;
    return true;
  }

  releasePreview(bytes: number): void {
    this.pending = Math.max(0, this.pending - bytes);
  }
}

const QUEUES = new WeakMap<object, SessionReadQueue>();

/** The one queue of a session (keyed by its event log object). */
export function sessionReadQueue(log: object): SessionReadQueue {
  let queue = QUEUES.get(log);
  if (!queue) {
    queue = new SessionReadQueue();
    QUEUES.set(log, queue);
  }
  return queue;
}

// --- O1/O1': status ----------------------------------------------------------------

/**
 * The batch status as a pure function of item statuses: `rejected` iff no
 * child ran (no items, or every item `unsupported` before any start),
 * `cancelled` iff any item is `cancelled` or `unresolved`, `complete` iff
 * every item's child succeeded (`ok`, or `omitted` from the delivery for the
 * budget with its source recorded), else `partial`.
 */
export function readBatchStatus(statuses: readonly ReadBatchItemStatus[]): ReadBatchStatus {
  if (statuses.length === 0) return "rejected";
  if (statuses.every((status) => status === "unsupported")) return "rejected";
  if (statuses.some((status) => status === "cancelled" || status === "unresolved")) return "cancelled";
  if (statuses.every((status) => status === "ok" || status === "omitted")) return "complete";
  return "partial";
}

/** O1': the reason every terminal status carries. */
export function readBatchReason(status: ReadBatchStatus, statuses: readonly ReadBatchItemStatus[], cancelledBy?: string): string {
  const count = (wanted: ReadBatchItemStatus) => statuses.filter((candidate) => candidate === wanted).length;
  switch (status) {
    case "complete":
      return count("omitted") > 0 ? `every child succeeded; ${count("omitted")} of ${statuses.length} texts omitted for the delivery budget` : `every child succeeded (${statuses.length})`;
    case "partial":
      return `${count("ok") + count("omitted")} of ${statuses.length} children succeeded; error=${count("error")} unsupported=${count("unsupported")} stale=${count("stale")}`;
    case "cancelled":
      return `cancelled by ${cancelledBy ?? "signal"}; ok=${count("ok") + count("omitted")} cancelled=${count("cancelled")} unresolved=${count("unresolved")} error=${count("error")}`;
    case "rejected":
      return statuses.length === 0 ? "rejected at admission" : `no child ran: every item was unsupported before it started (${statuses.length})`;
  }
}

// --- S1': aggregate admission -------------------------------------------------------

/** S1'': the closed, fixed-size batch reason the aggregate carries. */
export const READ_BATCH_AGGREGATE_REASONS = ["all_children_succeeded", "some_children_failed", "cancelled_by_signal", "cancelled_by_deadline", "rejected"] as const;
export type ReadBatchAggregateReason = (typeof READ_BATCH_AGGREGATE_REASONS)[number];

export function readBatchAggregateReason(status: ReadBatchStatus, cancelledBy?: string): ReadBatchAggregateReason {
  if (status === "complete") return "all_children_succeeded";
  if (status === "partial") return "some_children_failed";
  if (status === "cancelled") return cancelledBy === "deadline" ? "cancelled_by_deadline" : "cancelled_by_signal";
  return "rejected";
}

/**
 * The exact aggregate: what the batch tool returns, recorded by digest.
 * S1'': bounded by construction — the fixed part is an id (≤ 64 B), a minted
 * invocation, closed-enum status and reason, a digest, a coverage word, a
 * source ref and numbers per item, plus a fixed header; never a path and
 * never free text (a resource path and a tool's refusal text live on the
 * child row). An omitted item differs from an `ok` one only by its status
 * and its missing `text`, so omitting strictly shrinks the aggregate.
 */
export function readBatchAggregateText(input: { batchRef: string; status: ReadBatchStatus; reason?: string; code?: ReadBatchAggregateReason; items: readonly ReadBatchItemResult[]; omitted?: readonly string[] }): string {
  return JSON.stringify({
    batch: input.batchRef,
    status: input.status,
    reason: input.code ?? readBatchAggregateReason(input.status),
    consistency: "per-item",
    omitted: input.items.filter((item) => item.status === "omitted").length,
    items: input.items.map((item) => ({
      id: item.id,
      invocation: item.invocationRef,
      status: item.status,
      reason: item.code ?? "unverified_coverage",
      ...(item.sources[0] ? { digest: item.sources[0].digest, coverage: item.sources[0].coverage } : {}),
      binding: item.consistency,
      ...(item.resultRef !== undefined ? { source_ref: item.resultRef } : {}),
      ...(item.bytes !== undefined ? { bytes: item.bytes } : {}),
      ...(item.text !== undefined ? { text: item.text } : {}),
    })),
    note: "Each item is its own recorded read bound to its own source version; not one snapshot, not a verdict.",
  }, null, 1);
}

/**
 * S1': admit the aggregate against the tool-result budget before delivery.
 * While the delivered text (escaping included) exceeds the budget, the
 * largest remaining text is left out — that item becomes `omitted`, its
 * bytes retained as its child source — and the omitted ids are stated.
 */
export function admitReadBatchAggregate(input: { batchRef: string; status: ReadBatchStatus; reason: string; items: readonly ReadBatchItemResult[]; budget?: number; cancelledBy?: string }): { items: ReadBatchItemResult[]; omitted: string[]; text: string; status: ReadBatchStatus; reason: string } {
  const budget = input.budget ?? TOOL_RESULT_MODEL_BUDGET;
  const items = [...input.items];
  const omitted: string[] = [];
  let status = input.status;
  let reason = input.reason;
  const render = () => readBatchAggregateText({ batchRef: input.batchRef, status, reason, code: readBatchAggregateReason(status, input.cancelledBy), items, omitted });
  let text = render();
  // S1'': largest text first, the lowest ordinal on a tie; a fixed-size
  // reason, so omitting never grows the aggregate and admission is verified
  // on the final bytes.
  while (utf8Bytes(text) > budget) {
    let largest = -1;
    for (const [index, item] of items.entries()) {
      if (item.text === undefined) continue;
      if (largest < 0 || utf8Bytes(item.text) > utf8Bytes(items[largest]!.text!)) largest = index;
    }
    if (largest < 0) break;
    const item = items[largest]!;
    const { text: dropped, ...rest } = item;
    void dropped;
    items[largest] = {
      ...rest,
      status: "omitted",
      reason: "text omitted for the delivery budget; the child succeeded and its bytes are recorded as its source",
      omittedBytes: item.bytes ?? 0,
    };
    omitted.push(item.id);
    const statuses = items.map((candidate) => candidate.status);
    status = readBatchStatus(statuses);
    reason = readBatchReason(status, statuses, input.cancelledBy);
    text = render();
  }
  return { items, omitted, text, status, reason };
}

// --- the service ----------------------------------------------------------------

type ToolResult = Awaited<ReturnType<AgentTool["execute"]>>;

interface ChildRun {
  readonly item: AdmittedReadItem;
  readonly invocation: string;
  result: ReadBatchItemResult;
  facts: Record<string, unknown>;
  previewBytes: number;
  /** The redacted result, kept until admission so an omitted item's bytes
   * can be materialised as a source whatever their size (S1''). */
  raw?: ToolResult;
  redactedStrings?: number;
}

function mint(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}

function boundedReason(text: string): string {
  const safe = redactForEmission(text.replace(/\s+/gu, " ").trim());
  return safe.length > 200 ? `${safe.slice(0, 197)}…` : safe;
}

function textOf(result: ToolResult | undefined): string {
  return (result?.content ?? []).map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : "")).join("");
}

type Settled<T> = { readonly settled: true; readonly value?: T; readonly error?: unknown; readonly failed: boolean } | { readonly settled: false };

/** Wait for `promise`; once `signal` aborts, at most `graceMs` longer. */
function settleWithin<T>(promise: Promise<T>, signal: AbortSignal, graceMs: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let arm: (() => void) | undefined;
  const settled = promise.then(
    (value): Settled<T> => ({ settled: true, value, failed: false }),
    (error): Settled<T> => ({ settled: true, error, failed: true }),
  );
  const grace = new Promise<Settled<T>>((resolve) => {
    arm = () => { timer = setTimeout(() => resolve({ settled: false }), graceMs); };
    // C1': the listener first, then the state — an abort between the two is
    // never missed.
    signal.addEventListener("abort", arm, { once: true });
    if (signal.aborted) {
      signal.removeEventListener("abort", arm);
      arm();
    }
  });
  return Promise.race([settled, grace]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (arm !== undefined) signal.removeEventListener("abort", arm);
  });
}

/** Q1': coverage from the producer's structured statement alone. */
function coverageOf(statement: ProducerCoverage | undefined, projectionOmitted: number, producerTruncated: boolean, hasImage: boolean): BatchReadSource["coverage"] {
  if (statement === undefined) {
    // No statement: pi's own structured truncation is still a statement of
    // omission; its absence proves nothing.
    return producerTruncated ? "partial" : "unverified";
  }
  return statement.complete && !producerTruncated && projectionOmitted === 0 && !hasImage ? "complete" : "partial";
}

export interface RecordedReadBatchOptions {
  readonly log: EventLog;
  readonly enrolment: ReadAdapterEnrolment;
  readonly queue?: SessionReadQueue;
  /** §133 R2: whether the current tool profile holds the session's reader. */
  readonly readerAuthorised?: () => boolean;
  /** A2': the loop's pre-call pipeline for the children, when an agent is live. */
  readonly pipeline?: () => ChildCallPipeline | undefined;
  readonly settleGraceMs?: number;
  readonly deadlineMs?: number;
  readonly budget?: number;
  readonly now?: () => number;
}

export class RecordedReadBatchService implements RecordedReadBatch {
  private readonly log: EventLog;
  private readonly enrolment: ReadAdapterEnrolment;
  private readonly queue: SessionReadQueue;
  private readonly readerAuthorised: () => boolean;
  private readonly pipeline: () => ChildCallPipeline | undefined;
  private readonly settleGraceMs: number;
  private readonly deadlineMs: number;
  private readonly budget: number;
  private readonly now: () => number;

  constructor(options: RecordedReadBatchOptions) {
    this.log = options.log;
    this.enrolment = options.enrolment;
    this.queue = options.queue ?? sessionReadQueue(options.log);
    this.readerAuthorised = options.readerAuthorised ?? (() => false);
    this.pipeline = options.pipeline ?? (() => undefined);
    this.settleGraceMs = options.settleGraceMs ?? READ_BATCH_SETTLE_GRACE_MS;
    this.deadlineMs = options.deadlineMs ?? READ_BATCH_DEADLINE_MS;
    this.budget = options.budget ?? TOOL_RESULT_MODEL_BUDGET;
    this.now = options.now ?? (() => performance.now());
  }

  async run(request: ReadBatchRequest, signal: AbortSignal, context: { readonly parent: string }): Promise<ReadBatchResult> {
    const batchRef = mint("rb");
    if (this.log.isReadOnly) {
      return { batchRef, items: [], status: "rejected", reason: "replay: recorded rows only; no live read is performed", omitted: [], recorded: false };
    }
    const admission = admitReadBatchRequest(request, this.enrolment);
    if (!admission.ok) {
      let recorded = true;
      try {
        this.log.append({
          kind: "observe",
          name: READ_BATCH_RESULT_EVENT,
          payload: {
            batch: batchRef, parent: context.parent, status: "rejected", reason: boundedReason(admission.reason),
            generation: this.enrolment.generation, items: [], ok: 0, omitted: 0, errors: 0, cancelled: 0, unresolved: 0, unsupported: 0, stale: 0,
            ...(admission.snapshot ? { snapshot: admission.snapshot } : {}),
          },
        });
      } catch {
        recorded = false;
      }
      return { batchRef, items: [], status: "rejected", reason: admission.reason, omitted: [], recorded };
    }
    const items = admission.items;
    const runs: ChildRun[] = items.map((item) => {
      const invocation = mint("rbi");
      return {
        item, invocation,
        result: { id: item.id, invocationRef: invocation, status: "cancelled", sources: [], consistency: "unverified", reason: "not started" },
        facts: {}, previewBytes: 0,
      };
    });
    const childBudget = readBatchChildBudget(this.budget, items.length);
    try {
      this.log.append({
        kind: "observe",
        name: READ_BATCH_START_EVENT,
        payload: {
          batch: batchRef, parent: context.parent, generation: this.enrolment.generation, root: this.enrolment.rootId,
          consistency: admission.consistency, owner: "read_batch", child_budget: childBudget, budget: this.budget,
          bounds: { items: READ_BATCH_ITEMS_MAX, concurrency: this.queue.limits.concurrency, pending_preview_bytes: this.queue.limits.pendingPreviewBytes },
          items: runs.map((run) => ({
            id: run.item.id, ordinal: run.item.ordinal, invocation: run.invocation, capability: run.item.adapter.capability,
            descriptor: run.item.adapter.descriptor, operation: run.item.adapter.operation, args_digest: toolArgumentsDigest({ ...run.item.args }),
          })),
        },
      });
    } catch {
      // Nothing started: the batch is refused for want of its record.
      return { batchRef, items: [], status: "rejected", reason: "the batch could not be recorded before execution; nothing was started", omitted: [], recorded: false };
    }
    // C1': the listener before the state check; the children's signal is the
    // caller's or the local bound, whichever fires first, and says which.
    const controller = new AbortController();
    let cancelledBy: "signal" | "deadline" | undefined;
    const onAbort = () => { cancelledBy ??= "signal"; controller.abort(); };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const deadline = setTimeout(() => { cancelledBy ??= "deadline"; controller.abort(); }, this.deadlineMs);
    const started = this.now();
    try {
      await Promise.all(runs.map((run) => this.runChild(run, batchRef, context.parent, controller.signal, childBudget, () => cancelledBy ?? "signal")));
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener("abort", onAbort);
    }
    const rawStatuses = runs.map((run) => run.result.status);
    const rawStatus = readBatchStatus(rawStatuses);
    const rawReason = readBatchReason(rawStatus, rawStatuses, cancelledBy);
    // S1': admitted against the delivery budget before anything is recorded
    // as delivered; the recorded aggregate is exactly the delivered one.
    const admitted = admitReadBatchAggregate({ batchRef, status: rawStatus, reason: rawReason, items: runs.map((run) => run.result), budget: this.budget, ...(cancelledBy ? { cancelledBy } : {}) });
    for (const [index, run] of runs.entries()) run.result = admitted.items[index]!;
    // S1'': every omitted item has a materialised source, whatever its size.
    for (const run of runs) {
      if (run.result.status !== "omitted" || run.result.resultRef !== undefined || run.raw === undefined) continue;
      const delivered = deliverToolResult({
        log: this.log, invocationId: run.invocation, tool: run.item.adapter.descriptor, result: run.raw,
        redactedStrings: run.redactedStrings ?? 0, readerAuthorised: this.readerAuthorised(), budget: this.budget, forceSource: true,
      });
      const projection = readResultProjection(delivered.details);
      if (projection && projection.source.source.kind === "blob" && projection.source.resultEvent > 0) {
        run.facts.source_seq = projection.source.resultEvent;
        run.facts.source = "blob";
        run.result = { ...run.result, resultRef: `blob:${projection.source.digest}` };
      }
    }
    for (const run of runs) { delete run.raw; delete run.redactedStrings; }
    let { text: aggregateText } = admitted;
    const { status, reason, omitted } = admitted;
    aggregateText = readBatchAggregateText({ batchRef, status, reason, code: readBatchAggregateReason(status, cancelledBy), items: runs.map((run) => run.result), omitted });
    const statuses = runs.map((run) => run.result.status);
    const count = (wanted: ReadBatchItemStatus) => statuses.filter((candidate) => candidate === wanted).length;
    const itemFacts = runs.map((run) => ({
      id: run.item.id, ordinal: run.item.ordinal, invocation: run.invocation, status: run.result.status, reason: run.result.reason,
      ...(typeof run.facts.source_seq === "number" ? { source_seq: run.facts.source_seq } : {}),
      ...(typeof run.facts.digest === "string" ? { digest: run.facts.digest } : {}),
      ...(typeof run.facts.child_seq === "number" ? { child_seq: run.facts.child_seq } : {}),
      ...(run.facts.unrecorded === true ? { unrecorded: true } : {}),
    }));
    let recorded = true;
    try {
      this.log.append({
        kind: "observe",
        name: READ_BATCH_RESULT_EVENT,
        payload: {
          batch: batchRef, parent: context.parent, status, reason, generation: this.enrolment.generation, consistency: admission.consistency,
          aggregate_digest: sha256Text(aggregateText), aggregate_bytes: utf8Bytes(aggregateText), budget: this.budget,
          items_digest: readBatchItemsDigest(itemFacts),
          duration_ms: Math.max(0, Math.round(this.now() - started)),
          ok: count("ok"), omitted: count("omitted"), errors: count("error"), cancelled: count("cancelled"), unresolved: count("unresolved"), unsupported: count("unsupported"), stale: count("stale"),
          bytes: runs.reduce((sum, run) => sum + (typeof run.facts.bytes === "number" ? run.facts.bytes : 0), 0),
          visible_bytes: runs.reduce((sum, run) => sum + (run.result.text !== undefined ? utf8Bytes(run.result.text) : 0), 0),
          omitted_bytes: runs.reduce((sum, run) => sum + (typeof run.facts.omitted_bytes === "number" ? run.facts.omitted_bytes : 0) + (run.result.status === "omitted" ? (run.result.omittedBytes ?? 0) : 0), 0),
          items: itemFacts,
        },
      });
    } catch {
      recorded = false;
    } finally {
      for (const run of runs) {
        if (run.previewBytes > 0) this.queue.releasePreview(run.previewBytes);
        run.previewBytes = 0;
      }
    }
    if (!recorded) {
      // R1: no unrecorded byte reaches the model. The child rows stand; the
      // aggregate is not published.
      return {
        batchRef, status, recorded: false, omitted,
        reason: "the aggregate could not be recorded; the child observations are recorded as read_batch/child rows and nothing was delivered",
        items: runs.map(({ result }) => { const { text, ...rest } = result; void text; return rest; }),
      };
    }
    return { batchRef, status, reason, items: runs.map((run) => run.result), omitted, recorded: true };
  }

  private async runChild(run: ChildRun, batchRef: string, parent: string, signal: AbortSignal, budget: number, cancelReason: () => string): Promise<void> {
    const { item, invocation } = run;
    const queuedAt = this.now();
    const release = await this.queue.acquire(signal);
    const queueMs = Math.max(0, Math.round(this.now() - queuedAt));
    const base = {
      batch: batchRef, parent, item: item.id, ordinal: item.ordinal, invocation, capability: item.adapter.capability,
      descriptor: item.adapter.descriptor, operation: item.adapter.operation, generation: this.enrolment.generation,
      args_digest: toolArgumentsDigest({ ...item.args }),
      queue_ms: queueMs, resource: redactForEmission(item.adapter.resource(item.args)), root: item.adapter.rootId(item.args),
    };
    const finish = (status: ReadBatchItemStatus, facts: Record<string, unknown>, result: Partial<ReadBatchItemResult> & { reason: string }) => {
      run.facts = { ...facts };
      let childSeq: number | undefined;
      try {
        childSeq = this.log.append({ kind: "observe", name: READ_BATCH_CHILD_EVENT, payload: { ...base, status, ...facts } }).seq;
      } catch {
        // The observation is unrecorded: its text is not delivered (R1).
        run.facts = { ...facts, unrecorded: true };
        run.result = { id: item.id, invocationRef: invocation, status: "error", sources: [], consistency: "unverified", code: "unrecorded", reason: "child observation could not be recorded; nothing of it is delivered" };
        return;
      }
      run.facts.child_seq = childSeq;
      run.result = { id: item.id, invocationRef: invocation, status, sources: [], consistency: "unverified", ...result, projectionRef: `seq:${childSeq}` };
    };
    if (release === undefined || signal.aborted) {
      // A cancel that raced the grant: the slot is given back unused.
      release?.();
      finish("cancelled", { reason: cancelReason(), termination: "not_started" }, { code: "cancelled_before_start", reason: `cancelled before start (${cancelReason()})` });
      return;
    }
    if (!this.enrolment.live()) {
      release();
      finish("unsupported", { reason: "descriptor_unloaded", termination: "not_started" }, { code: "descriptor_unloaded", reason: `the ${item.adapter.descriptor} descriptor of generation ${this.enrolment.generation} was unloaded before this item started; nothing was executed` });
      return;
    }
    // A2': the loop's own pre-call pipeline, as for a single call.
    const pipeline = this.pipeline();
    if (pipeline !== undefined) {
      let decision: ReturnType<ChildCallPipeline>;
      try {
        decision = pipeline({ name: item.adapter.descriptor, id: invocation, args: { ...item.args }, parent });
      } catch (error) {
        // A pipeline that fails admits nothing: the child is refused, the batch goes on.
        decision = { block: true, reason: `the tool-call pipeline failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (decision.block) {
        release();
        finish("error", { reason: "pipeline_refused", detail: boundedReason(decision.reason), termination: "not_started" }, { code: "pipeline_refused", reason: `refused before start by the tool-call pipeline: ${boundedReason(decision.reason)}` });
        return;
      }
    }
    const startedAt = this.now();
    const execution = Promise.resolve().then(() => runInInvocation(this.log, invocation, () => item.adapter.tool.execute(invocation, { ...item.args } as never, signal)).result);
    const outcome = await settleWithin(execution, signal, this.settleGraceMs);
    if (!outcome.settled) {
      // C1/Q2: a dropped promise proves nothing; the child is unresolved with
      // this batch as the recorded owner, its slot returned, its late
      // settlement recorded and discarded.
      release();
      this.queue.noteUnresolved(invocation, batchRef);
      finish("unresolved", { reason: cancelReason(), owner: batchRef, cleanup: "settles_in_process" }, { code: "unresolved", reason: `cancelled (${cancelReason()}) while running; termination not proven within ${this.settleGraceMs}ms — unresolved, owner ${batchRef}` });
      execution.then(
        () => { this.queue.settleUnresolved(invocation); this.late(base, "settled"); },
        () => { this.queue.settleUnresolved(invocation); this.late(base, "failed"); },
      );
      return;
    }
    release();
    const latencyMs = Math.max(0, Math.round(this.now() - startedAt));
    const endedBySignal = signal.aborted;
    if (outcome.failed) {
      const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      // C1': a child that ends after the signal fired ended because of it.
      if (endedBySignal) {
        finish("cancelled", { latency_ms: latencyMs, reason: cancelReason(), termination: "settled", detail: boundedReason(message) }, { code: "ended_by_signal", reason: `ended by ${cancelReason()} while running (${boundedReason(message)})` });
        return;
      }
      finish("error", { latency_ms: latencyMs, reason: "adapter_error", detail: boundedReason(message), termination: "settled" }, { code: "adapter_error", reason: boundedReason(message) });
      return;
    }
    const statementRead = producerCoverageOf(outcome.value);
    const safe = safeToolResultInput(outcome.value as ToolResult);
    const raw = safe.result;
    run.raw = raw;
    run.redactedStrings = safe.redactedStrings;
    const isError = (raw as { isError?: unknown }).isError === true;
    const rawDetails = raw.details && typeof raw.details === "object" ? raw.details as Record<string, unknown> : {};
    const producerCancelled = rawDetails.cancelled === true;
    const hasImage = (raw.content ?? []).some((part) => part.type === "image");
    const fullText = textOf(raw);
    const bytes = utf8Bytes(fullText);
    if (endedBySignal && (isError || producerCancelled)) {
      finish("cancelled", { latency_ms: latencyMs, reason: cancelReason(), termination: "settled", bytes }, { code: "ended_by_signal", reason: `ended by ${cancelReason()} while running; the partial output is not delivered` });
      return;
    }
    // Q1: the pending aggregate preview is bounded across the session; a
    // child past it is refused (its source still recorded), never truncated.
    const reserved = this.queue.reservePreview(Math.min(bytes, budget));
    if (reserved) run.previewBytes = Math.min(bytes, budget);
    const delivered = deliverToolResult({
      log: this.log, invocationId: invocation, tool: item.adapter.descriptor, result: raw,
      redactedStrings: safe.redactedStrings, readerAuthorised: this.readerAuthorised(), budget,
    });
    const projection = readResultProjection(delivered.details);
    const text = textOf(delivered);
    const digest = projection?.source.digest ?? sha256Text(fullText);
    const stored = projection?.source.source.kind === "blob";
    const producerTruncated = (projection ? projection.source.completeness === "producer_truncated" : false)
      || rawDetails.producer_truncated === true
      || (rawDetails.truncation !== null && typeof rawDetails.truncation === "object" && Reflect.get(rawDetails.truncation, "truncated") === true);
    const omitted = projection?.omittedBytes ?? 0;
    const coverage = coverageOf(statementRead, omitted, producerTruncated, hasImage);
    const source: BatchReadSource = { rootId: base.root, resource: base.resource, digest, coverage };
    const statement = statementRead;
    const facts: Record<string, unknown> = {
      latency_ms: latencyMs, bytes, visible_bytes: utf8Bytes(text), omitted_bytes: omitted, digest, coverage,
      ...(statement ? { producer_coverage: { complete: statement.complete, unit: statement.unit, ...(statement.kept !== undefined ? { kept: statement.kept } : {}), ...(statement.limit !== undefined ? { limit: statement.limit } : {}), ...(statement.reason ? { reason: statement.reason } : {}), ...(statement.range ? { range: statement.range } : {}), ...(statement.clamped !== undefined ? { clamped: statement.clamped, clamp: statement.clamp } : {}) } } : {}),
      ...(safe.redactedStrings > 0 ? { redacted_strings: safe.redactedStrings } : {}),
      ...(projection && projection.source.resultEvent > 0 ? { source_seq: projection.source.resultEvent } : {}),
      ...(projection ? { source: projection.source.source.kind, completeness: projection.source.completeness } : { source: "inline" }),
      ...(hasImage ? { image: true } : {}),
      termination: "settled",
    };
    if (isError) {
      finish("error", { ...facts, reason: "adapter_refused", detail: boundedReason(text) }, { code: "adapter_refused", reason: boundedReason(text) || "the adapter refused the read", sources: [source], consistency: "unverified" });
      return;
    }
    if (!reserved) {
      finish("error", { ...facts, reason: "preview_bound" }, {
        code: "preview_bound",
        reason: `the session's pending aggregate preview bound (${this.queue.limits.pendingPreviewBytes} bytes) would be exceeded; the observation is recorded${stored ? ` and readable as blob:${digest}` : ""} but not delivered here`,
        sources: [source], consistency: "version-bound", ...(stored ? { resultRef: `blob:${digest}` } : {}), bytes, omittedBytes: bytes,
      });
      return;
    }
    finish("ok", facts, {
      code: coverage === "complete" ? "complete" : coverage === "partial" ? "partial_coverage" : "unverified_coverage",
      reason: coverage === "complete" ? "read complete" : coverage === "partial" ? "read partial: the producer stated an omission" : "read delivered; the producer stated no coverage (unverified)",
      sources: [source], consistency: "version-bound", text, bytes, omittedBytes: omitted,
      ...(stored ? { resultRef: `blob:${digest}` } : {}),
    });
  }

  private late(base: Record<string, unknown>, how: "settled" | "failed"): void {
    try {
      this.log.append({ kind: "observe", name: READ_BATCH_CHILD_EVENT, payload: { ...base, status: "unresolved", outcome: "late_settled", late: how, delivered: false, reason: "late settlement of an unresolved child; discarded" } });
    } catch {
      // The late row is best effort; the unresolved row already stands.
    }
  }
}

/** R1': the items digest, recomputable from child rows alone: ordinal
 * order of (invocation, status, digest). */
export function readBatchItemsDigest(items: ReadonlyArray<{ readonly invocation: string; readonly status: string; readonly digest?: string }>): string {
  return sha256Text(canonicalJson(items.map((item) => [item.invocation, item.status, item.digest ?? ""])));
}

// --- RB-04: dashboard and replay projections ---------------------------------

export interface ReadBatchStats {
  batches: Record<string, number>;
  items: Record<string, number>;
  /** Batches with a start row and no result row (a crash before publication). */
  unpublished: number;
  bytes: number;
  visible_bytes: number;
  omitted_bytes: number;
  failures: number;
  cancellations: number;
  unresolved: number;
  late_settled: number;
  unrecorded: number;
  /** Coverage of ok/omitted items by the producer's statement. */
  coverage: Record<string, number>;
  /** The same (parent, resource, args, digest, generation) executed more than
   * once — always 0 unless the log lies. */
  duplicate_executions: number;
  /** Children admitted through the loop's pre-call pipeline (`read_batch/child_call`). */
  pipeline_calls: number;
  queue_p50_ms?: number;
  queue_max_ms?: number;
  latency_p50_ms?: number;
  latency_max_ms?: number;
}

function bump(record: Record<string, number>, key: string, by = 1): void {
  record[key] = (record[key] ?? 0) + by;
}

function percentiles(values: number[]): { p50?: number; max?: number } {
  if (values.length === 0) return {};
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: sorted[Math.floor((sorted.length - 1) / 2)], max: sorted.at(-1) };
}

/** R1': the execution identity of a child, never its minted id. */
function executionKey(p: Record<string, unknown>): string | undefined {
  if (typeof p.digest !== "string") return undefined;
  return canonicalJson([p.parent ?? "", p.resource ?? "", p.args_digest ?? "", p.digest, p.generation ?? ""]);
}

export function readBatchStats(events: readonly EventRecord[]): ReadBatchStats | undefined {
  const stats: ReadBatchStats = {
    batches: {}, items: {}, unpublished: 0, bytes: 0, visible_bytes: 0, omitted_bytes: 0, failures: 0, cancellations: 0,
    unresolved: 0, late_settled: 0, unrecorded: 0, coverage: {}, duplicate_executions: 0, pipeline_calls: 0,
  };
  const started = new Set<string>();
  const published = new Set<string>();
  const executed = new Map<string, number>();
  const queue: number[] = [];
  const latency: number[] = [];
  let seen = false;
  for (const event of events) {
    const p = event.payload;
    if (event.name === READ_BATCH_START_EVENT) {
      seen = true;
      if (typeof p.batch === "string") started.add(p.batch);
    } else if (event.name === READ_BATCH_CHILD_CALL_EVENT) {
      seen = true;
      stats.pipeline_calls += 1;
    } else if (event.name === READ_BATCH_CHILD_EVENT) {
      seen = true;
      if (p.outcome === "late_settled") {
        stats.late_settled += 1;
        continue;
      }
      const status = typeof p.status === "string" ? p.status : "unknown";
      bump(stats.items, status);
      const key = executionKey(p);
      if (key !== undefined && (status === "ok")) executed.set(key, (executed.get(key) ?? 0) + 1);
      if (typeof p.queue_ms === "number") queue.push(p.queue_ms);
      if (typeof p.latency_ms === "number") latency.push(p.latency_ms);
      if (typeof p.bytes === "number") stats.bytes += p.bytes;
      if (typeof p.visible_bytes === "number") stats.visible_bytes += p.visible_bytes;
      if (typeof p.omitted_bytes === "number") stats.omitted_bytes += p.omitted_bytes;
      if (status === "ok" && typeof p.coverage === "string") bump(stats.coverage, p.coverage);
      if (status === "error") stats.failures += 1;
      if (status === "cancelled") stats.cancellations += 1;
      if (status === "unresolved") stats.unresolved += 1;
    } else if (event.name === READ_BATCH_RESULT_EVENT) {
      seen = true;
      bump(stats.batches, typeof p.status === "string" ? p.status : "unknown");
      if (typeof p.batch === "string") published.add(p.batch);
      if (Array.isArray(p.items)) {
        for (const item of p.items as Array<Record<string, unknown>>) {
          if (!item || typeof item !== "object") continue;
          if (item.unrecorded === true) stats.unrecorded += 1;
          if (item.status === "omitted") bump(stats.items, "omitted");
        }
      }
    }
  }
  if (!seen) return undefined;
  for (const batch of started) if (!published.has(batch)) stats.unpublished += 1;
  for (const count of executed.values()) if (count > 1) stats.duplicate_executions += count - 1;
  const q = percentiles(queue);
  const l = percentiles(latency);
  if (q.p50 !== undefined) { stats.queue_p50_ms = q.p50; stats.queue_max_ms = q.max; }
  if (l.p50 !== undefined) { stats.latency_p50_ms = l.p50; stats.latency_max_ms = l.max; }
  return stats;
}

export function readBatchLine(stats: ReadBatchStats | undefined): string {
  if (!stats) return "";
  const map = (record: Record<string, number>) => Object.entries(record).map(([key, value]) => `${key}=${value}`).join(" ") || "none";
  return `read batches ${map(stats.batches)} unpublished=${stats.unpublished} · items ${map(stats.items)} · coverage ${map(stats.coverage)}`
    + ` · bytes=${stats.bytes}B visible=${stats.visible_bytes}B omitted=${stats.omitted_bytes}B`
    + ` · failures=${stats.failures} cancelled=${stats.cancellations} unresolved=${stats.unresolved} late=${stats.late_settled} unrecorded=${stats.unrecorded} duplicate_executions=${stats.duplicate_executions} pipeline_calls=${stats.pipeline_calls}`
    + (stats.queue_p50_ms !== undefined ? ` · queue p50=${stats.queue_p50_ms}ms max=${stats.queue_max_ms}ms` : "")
    + (stats.latency_p50_ms !== undefined ? ` · child latency p50=${stats.latency_p50_ms}ms max=${stats.latency_max_ms}ms` : "");
}

/**
 * Replay preflight (R1/R1'): every published batch names child rows that
 * exist before it with the same batch and invocation; a child invocation is
 * recorded once (late settlements aside) and never executed by the loop; a
 * child's `source_seq` names a `tool/source` row of that invocation and
 * digest before it; the result's status is recomputed from the recorded
 * item statuses (each consistent with its child row) and its `items_digest`
 * from the child rows; the same (parent, resource, args, digest, generation)
 * is never executed twice. Nothing here reads a file.
 */
export function validateRecordedReadBatches(events: readonly EventRecord[]): void {
  const fail = (seq: number, why: string): never => {
    throw new Error(`Error: recorded read batch at event seq #${seq} ${why}\nReplay aborted (fail-closed).`);
  };
  const starts = new Map<string, { seq: number; invocations: Set<string> }>();
  const children = new Map<string, { seq: number; batch: string; status: string; digest?: string; sourceSeq?: number }>();
  const sources = new Map<number, { id: string; digest: string }>();
  const loopStarts = new Set<string>();
  const childCalls = new Map<string, number>();
  const executed = new Set<string>();
  for (const event of events) {
    const p = event.payload;
    // X2': a loop row that claims a parent is malformed — a child is never a loop row.
    if (isChildToolRow(event)) fail(event.seq, "is a loop tool/call row claiming a parent");
    if (event.name === "tool/start" || event.name === "tool/call") {
      if (typeof p.id === "string") loopStarts.add(p.id);
      continue;
    }
    if (event.name === READ_BATCH_CHILD_CALL_EVENT) {
      const id = typeof p.id === "string" && typeof p.parent === "string" ? p.id : fail(event.seq, "is a child call row without an id or a parent");
      if (loopStarts.has(id)) fail(event.seq, "names an invocation the loop also ran");
      if (childCalls.has(id)) fail(event.seq, `admits child ${id} a second time`);
      childCalls.set(id, event.seq);
      continue;
    }
    if (event.name === RESULT_SOURCE_EVENT && typeof p.id === "string" && typeof p.digest === "string") {
      sources.set(event.seq, { id: p.id, digest: p.digest });
      continue;
    }
    if (event.name === READ_BATCH_START_EVENT) {
      if (typeof p.batch !== "string" || !Array.isArray(p.items)) fail(event.seq, "is malformed");
      const invocations = new Set<string>();
      for (const item of p.items as Array<Record<string, unknown>>) {
        if (!item || typeof item.invocation !== "string") fail(event.seq, "names an item without an invocation");
        invocations.add(item.invocation as string);
      }
      starts.set(p.batch as string, { seq: event.seq, invocations });
      continue;
    }
    if (event.name === READ_BATCH_CHILD_EVENT) {
      const batch = typeof p.batch === "string" ? p.batch : fail(event.seq, "is malformed");
      const invocation = typeof p.invocation === "string" ? p.invocation : fail(event.seq, "is malformed");
      const start = starts.get(batch);
      if (!start || !start.invocations.has(invocation)) fail(event.seq, "has no start row naming its invocation");
      if (loopStarts.has(invocation)) fail(event.seq, "names an invocation the loop also ran");
      // A child admitted through the pipeline has its call row before its result row.
      const admittedAt = childCalls.get(invocation);
      if (admittedAt !== undefined && admittedAt >= event.seq) fail(event.seq, "precedes its own child call row");
      if (p.outcome === "late_settled") continue;
      if (children.has(invocation)) fail(event.seq, `records invocation ${invocation} a second time`);
      const status = typeof p.status === "string" ? p.status : fail(event.seq, "has no status");
      const sourceSeq = typeof p.source_seq === "number" ? p.source_seq : undefined;
      if (sourceSeq !== undefined) {
        const source = sources.get(sourceSeq);
        if (!source || source.id !== invocation || source.digest !== p.digest || sourceSeq >= event.seq) fail(event.seq, "names a source row that is not its own");
      }
      if (status === "ok") {
        const key = executionKey(p);
        if (key !== undefined) {
          if (executed.has(key)) fail(event.seq, "executes the same read (parent, resource, args, digest, generation) a second time");
          executed.add(key);
        }
      }
      children.set(invocation, { seq: event.seq, batch, status, ...(typeof p.digest === "string" ? { digest: p.digest } : {}), ...(sourceSeq !== undefined ? { sourceSeq } : {}) });
      continue;
    }
    if (event.name === READ_BATCH_RESULT_EVENT) {
      if (typeof p.batch !== "string" || typeof p.status !== "string" || !Array.isArray(p.items)) fail(event.seq, "is malformed");
      const items = p.items as Array<Record<string, unknown>>;
      if (p.status === "rejected" && items.length === 0) continue;
      const start = starts.get(p.batch as string) ?? fail(event.seq, "has no start row");
      // R1'': the result names every started child, in the start row's order.
      const named = items.map((item) => (item && typeof item.invocation === "string" ? item.invocation : ""));
      const startedList = [...start.invocations];
      if (named.length !== startedList.length || named.some((invocation, index) => invocation !== startedList[index])) {
        fail(event.seq, "names a child set that differs from the started set (missing, extra or reordered)");
      }
      const facts: Array<{ invocation: string; status: string; digest?: string }> = [];
      for (const item of items) {
        if (!item || typeof item.invocation !== "string" || typeof item.status !== "string") fail(event.seq, "names an item without an invocation or status");
        const invocation = item.invocation as string;
        const status = item.status as string;
        const child = children.get(invocation);
        if (item.unrecorded === true) {
          // The child row was refused: the item delivered nothing, and the
          // result says so; a child row for it would be the lie.
          if (child !== undefined) fail(event.seq, `names invocation ${invocation} both unrecorded and recorded`);
          if (status !== "error") fail(event.seq, `names an unrecorded invocation ${invocation} with status ${status}`);
          facts.push({ invocation, status, ...(typeof item.digest === "string" ? { digest: item.digest } : {}) });
          continue;
        }
        const recorded = child !== undefined && child.batch === p.batch && child.seq < event.seq
          ? child
          : fail(event.seq, `names invocation ${invocation} without a child row before it`);
        // An item's status is its child's, or `omitted` for a child that succeeded.
        if (!(recorded.status === status || (recorded.status === "ok" && status === "omitted"))) fail(event.seq, `names invocation ${invocation} as ${status} but its child row says ${recorded.status}`);
        if (typeof item.digest === "string" && recorded.digest !== item.digest) fail(event.seq, `names invocation ${invocation} with a digest its child row does not carry`);
        // S1'': an omitted item's source materialised after its child row.
        if (status === "omitted" && typeof item.source_seq === "number" && item.source_seq !== recorded.sourceSeq) {
          const source = sources.get(item.source_seq);
          if (!source || source.id !== invocation || source.digest !== recorded.digest || item.source_seq <= recorded.seq || item.source_seq >= event.seq) fail(event.seq, `names invocation ${invocation} with a source row that is not its own`);
        }
        facts.push({ invocation, status, ...(recorded.digest !== undefined ? { digest: recorded.digest } : {}) });
      }
      if (!READ_BATCH_STATUSES.includes(p.status as ReadBatchStatus) || facts.some((fact) => !READ_BATCH_ITEM_STATUSES.includes(fact.status as ReadBatchItemStatus))) fail(event.seq, "carries a status outside the closed enumeration");
      const recomputed = readBatchStatus(facts.map((fact) => fact.status as ReadBatchItemStatus));
      if (recomputed !== p.status) fail(event.seq, `says ${String(p.status)} but its child rows give ${recomputed}`);
      if (typeof p.items_digest !== "string") fail(event.seq, "carries no items digest");
      if (p.items_digest !== readBatchItemsDigest(facts)) fail(event.seq, "carries an items digest its child rows do not give");
    }
  }
}

/** Exposed for tests and the tool description: the args a capability takes. */
export function describeReadAdapters(enrolment: ReadAdapterEnrolment): string {
  return [...enrolment.adapters.values()]
    .map((adapter) => `${adapter.capability}(${Object.entries(adapter.args).map(([key, spec]) => `${key}${spec.kind === "string" && spec.required ? "" : "?"}: ${spec.kind}`).join(", ")})`)
    .sort()
    .join("; ");
}
