import { DEFAULT_MAX_BYTES, formatSize, type AgentTool } from "@earendil-works/pi-agent-core";
import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkspaceVersionHooks } from "../host/workspace-execution-env.ts";
import { attachProducerCoverage, type ProducerCoverage } from "../tools/model-result.ts";
import { createHash } from "node:crypto";
import { attachReadVersion } from "../host/received-calls.ts";
import {
  MutationRefusal,
  projectPiRead,
  withFileQueue,
  type CommitOutcome,
  type Decision,
  type DecisionPoint,
  type EditSpec,
  type MutationChange,
  type Operation,
  type WorkspaceVersions,
} from "../host/workspace-versions.ts";

/**
 * The registered read/write/edit tools on the version authority (#221).
 * The guards in workspace-tools.ts decide WHERE a path reaches; this decides
 * WHETHER the caller may change what is there, with what the model was shown.
 * The per-call hooks travel to the tool's environment in an async-local
 * context bound to the tool and the call id — never inside the arguments,
 * which the model wrote and the speculative runtime digests as they are.
 */

type ToolResult = Awaited<ReturnType<AgentTool["execute"]>>;

interface CallContext {
  readonly tool: string;
  readonly callId: string;
  readonly hooks: WorkspaceVersionHooks;
}

const CURRENT = new AsyncLocalStorage<CallContext>();

function runWith<T>(tool: string, callId: string, hooks: WorkspaceVersionHooks, run: () => T): T {
  return CURRENT.run({ tool, callId, hooks }, run);
}

/** The hooks of the operation this exact call belongs to, if any. */
export function versionHooksFor(tool: string, callId: string): WorkspaceVersionHooks | undefined {
  const current = CURRENT.getStore();
  return current !== undefined && current.tool === tool && current.callId === callId ? current.hooks : undefined;
}

function resultText(result: ToolResult | undefined): string {
  return (result?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

function refusalResult(tool: string, path: string, refusal: MutationRefusal): ToolResult {
  return {
    content: [{ type: "text", text: `${tool} refused (${refusal.code}): ${refusal.detail}. ${path} was not changed.` }],
    details: { refused: refusal.code, error: true },
    isError: true,
  } as ToolResult;
}

/** A read through the registered read tool (M1'): what it read and what
 * its text shows are held for the projection step — the receipt is minted
 * only if the loop delivers this text to the model for its own call. A line
 * longer than the read window is shown as a bounded window of its bytes
 * (M2'), where Pi alone would show none of it. */
export async function versionedRead(input: {
  readonly versions: WorkspaceVersions;
  readonly caller: AgentTool;
  readonly tool: string;
  readonly callId: string;
  readonly rel: string;
  readonly params: unknown;
  readonly run: () => Promise<ToolResult>;
}): Promise<ToolResult> {
  let seen: { bytes: Buffer; identity: string; rel: string } | undefined;
  let result = await runWith(input.tool, input.callId, {
    read: (bytes, identity, rel) => {
      seen = { bytes, identity, rel };
    },
  }, input.run);
  if (seen === undefined || (result as { isError?: unknown }).isError === true) return result;
  const params = (input.params ?? {}) as { offset?: unknown; limit?: unknown };
  const content = result.content ?? [];
  const hasImage = content.some((part) => part.type === "image");
  let window: { chars: number } | undefined;
  const truncation = (result.details as { truncation?: { firstLineExceedsLimit?: boolean; truncated?: boolean } } | undefined)?.truncation;
  if (!hasImage && truncation?.firstLineExceedsLimit === true) {
    const windowed = longLineWindow(seen.bytes, params);
    if (windowed !== undefined) {
      window = { chars: windowed.chars };
      result = { ...result, content: [{ type: "text", text: windowed.text }] } as ToolResult;
    }
  }
  const shown = projectPiRead(seen.bytes, params, resultText(result), hasImage, window);
  input.versions.shownBy({
    caller: input.caller,
    tool: input.tool,
    callId: input.callId,
    // The path the tool actually opened (a spelling variant after a race is
    // another file): the receipt names what was read.
    rel: seen.rel,
    bytes: seen.bytes,
    identity: seen.identity,
    shown,
  });
  // #228 Q1': the read states what of the file its text covers — the whole
  // body, or a window (offset/limit, pi's line/byte cap, a long line).
  const whole = shown !== undefined && shown.charStart === 0 && shown.charEnd === shown.body.length
    && truncation?.truncated !== true && truncation?.firstLineExceedsLimit !== true && window === undefined;
  // E1': pi owns this result's shape (`details` undefined when nothing was
  // truncated); the statement is attached to the result object, not written
  // into it. Q1''': a window states its range.
  let coverage: ProducerCoverage;
  if (shown === undefined) {
    coverage = { complete: false, unit: "bytes", reason: "producer" };
  } else {
    const kept = shown.text.length === 0 ? 0 : shown.text.split("\n").length;
    const total = shown.body.length === 0 ? 0 : shown.body.split("\n").length;
    const from = (shown.body.slice(0, shown.charStart).match(/\n/gu)?.length ?? 0) + 1;
    coverage = { complete: whole, unit: "lines", kept, ...(whole ? {} : { reason: "read_window", range: { from, to: from + Math.max(0, kept - 1), of: total } }) };
  }
  // #224 P1''': the version of the bytes THIS read returned, bound to the
  // exact result object — what an early lease compares its re-hash against.
  attachReadVersion(result, { digest: createHash("sha256").update(seen.bytes).digest("hex"), bytes: seen.bytes.length, identity: seen.identity });
  return attachProducerCoverage(result, coverage);
}

/** The first read window of a line longer than it: whole characters up to
 * DEFAULT_MAX_BYTES, then a notice saying exactly what is and is not shown. */
function longLineWindow(bytes: Buffer, params: { offset?: unknown }): { readonly chars: number; readonly text: string } | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
  const body = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const offset = typeof params.offset === "number" ? params.offset : undefined;
  const lines = body.split("\n");
  const index = Math.trunc(offset ? Math.max(0, offset - 1) : 0);
  const line = lines[index];
  if (line === undefined) return undefined;
  let chars = 0;
  let size = 0;
  for (const character of line) {
    const width = Buffer.byteLength(character, "utf8");
    if (size + width > DEFAULT_MAX_BYTES) break;
    size += width;
    chars += character.length;
  }
  const notice = `[Line ${index + 1} is ${formatSize(Buffer.byteLength(line, "utf8"))}; showing its first ${formatSize(size)}. The rest of this line is not shown by read: edit only within the shown bytes, or use bash for the rest.]`;
  return { chars, text: `${line.slice(0, chars)}\n\n${notice}` };
}

function changeOf(tool: "write" | "edit", params: unknown): MutationChange | undefined {
  const record = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
  if (tool === "write") return typeof record.content === "string" ? { kind: "write", content: record.content } : undefined;
  return Array.isArray(record.edits) ? { kind: "edit", edits: record.edits as EditSpec[] } : undefined;
}

/**
 * One write or edit through the authority (M2–M4): admitted into the path's
 * queue, refused early when no receipt could authorise it, then run with
 * hooks that make the environment's write the final boundary. A terminal
 * other than the native tool (the speculative promotion) is checked
 * synchronously right before it runs and its effect read back after.
 */
export async function versionedMutation(input: {
  readonly versions: WorkspaceVersions;
  readonly caller: AgentTool;
  readonly tool: "write" | "edit";
  readonly callId: string;
  readonly rel: string;
  readonly params: unknown;
  readonly native: boolean;
  readonly run: () => Promise<ToolResult>;
}): Promise<ToolResult> {
  const { versions, tool, callId, rel } = input;
  const change = changeOf(tool, input.params);
  // Malformed arguments reach no effect: the tool reports them itself, and
  // the hooks still guard its write.
  const refuse = (refusal: MutationRefusal, stage: "preflight" | "final" = "preflight"): ToolResult => {
    versions.refused({ rel, tool, callId, refusal, stage });
    return refusalResult(tool, rel, refusal);
  };
  let begun: { readonly key: string; readonly operationId: string; readonly point: DecisionPoint };
  try {
    begun = versions.begin({ caller: input.caller, tool, callId, rel, change: change ?? { kind: "write", content: "" }, route: input.native ? "native" : "promotion" });
  } catch (error) {
    if (error instanceof MutationRefusal) return refuse(error);
    throw error;
  }
  const { key, operationId, point } = begun;
  return await withFileQueue(versions.queueKey(key), async () => {
    const effective: MutationChange = change ?? (tool === "write" ? { kind: "write", content: "" } : { kind: "edit", edits: [] });
    // The existing guards first: a target that is a link, not a regular
    // file, or a file with a second name is refused before any version rule.
    const shape = targetShape(versions.root, rel);
    if (shape.state === "refused") {
      versions.refused({ rel, tool, callId, refusal: new MutationRefusal("target_changed", `${rel} ${shape.why}`) });
      throw boundaryError(tool, rel, shape.why);
    }
    // Preflight: no receipt of this path at all, and something is there.
    if (versions.receiptsOf(key).length === 0 && (tool === "edit" || shape.state === "file")) {
      return refuse(new MutationRefusal("read_required",
        `${key} exists and has not been read in this session; read it before you ${tool === "write" ? "overwrite" : "edit"} it`));
    }
    const state: { decision?: Decision; refusal?: MutationRefusal; outcome?: CommitOutcome; op?: Operation } = {};
    if (!input.native) {
      // The promotion route: decide on the live target and record the intent
      // in one synchronous run, then hand over to the terminal at once.
      try {
        const live = versions.io.inspect(rel);
        const decided = versions.decide(key, live, effective, undefined, point);
        state.decision = live.state === "file" ? { ...decided, beforeBytes: live.bytes } : decided;
        state.op = versions.openOperation({ operationId, key, rel, tool, callId, change: effective, decision: state.decision });
      } catch (error) {
        if (error instanceof MutationRefusal) return refuse(error, "final");
        throw error;
      }
    }
    const hooks: WorkspaceVersionHooks = {
      editRead: (bytes, identity, readRel) => {
        try {
          if (versions.key(readRel) !== key) throw new MutationRefusal("target_changed", `the edit reached ${readRel}, not ${key}`);
          const expected = state.decision;
          if (expected?.beforeBytes !== undefined) {
            if (identity !== expected.before?.identity) throw new MutationRefusal("target_changed", `${key} was replaced after it was checked; read it again`);
            if (!bytes.equals(expected.beforeBytes)) throw new MutationRefusal("stale_read", `${key} changed after it was checked; read it again`);
            return;
          }
          state.decision = { ...versions.decide(key, { state: "file", bytes, identity }, effective, undefined, point), beforeBytes: bytes };
        } catch (error) {
          if (error instanceof MutationRefusal) state.refusal = error;
          throw error;
        }
      },
      write: (io, writeRel, content) => {
        if (versions.key(writeRel) !== key) {
          const refusal = new MutationRefusal("target_changed", `the write reached ${writeRel}, not ${key}`);
          if (!state.op) versions.refused({ rel: writeRel, tool, callId, refusal, stage: "final" });
          state.outcome = { status: "refused", code: refusal.code, detail: refusal.detail };
          return "refused";
        }
        const outcome = versions.land({
          io,
          operationId,
          key,
          rel: writeRel,
          tool,
          callId,
          change: effective,
          route: state.op ? "promotion" : "native",
          ...(state.decision ? { expected: state.decision } : {}),
          writerFinal: content,
          point,
          ...(state.op ? { op: state.op } : {}),
        });
        state.outcome = outcome;
        return outcome.status === "refused" ? "refused" : "landed";
      },
    };
    let result: ToolResult | undefined;
    let thrown: unknown;
    try {
      result = await runWith(tool, callId, hooks, input.run);
    } catch (error) {
      thrown = error;
    }
    if (state.op && !versions.isClosed(state.op)) {
      // The promotion route: an operation whose intent is recorded closes
      // here unless the native boundary closed it. A success that did not
      // pass that boundary is read back; anything else wrote nothing.
      const succeeded = thrown === undefined && state.refusal === undefined && state.outcome === undefined
        && (result as { isError?: unknown } | undefined)?.isError !== true;
      const refusal = state.refusal
        ?? (state.outcome?.status === "refused" ? new MutationRefusal(state.outcome.code, state.outcome.detail) : undefined);
      if (succeeded) state.outcome = versions.adoptEffect(state.op, versions.io);
      else if (refusal) versions.refuseOperation(state.op, refusal);
      else versions.closeNotApplied(state.op, thrown instanceof Error ? thrown.message : resultText(result).slice(0, 200) || "the terminal failed");
    } else if (state.refusal) {
      return refuse(state.refusal);
    }
    if (state.refusal) return refusalResult(tool, rel, state.refusal);
    const outcome = state.outcome;
    if (outcome?.status === "refused" && outcome.boundary) throw boundaryError(tool, rel, outcome.detail);
    if (outcome?.status === "refused") return refusalResult(tool, rel, new MutationRefusal(outcome.code, outcome.detail));
    if (outcome?.status === "unresolved") {
      return {
        content: [{
          type: "text",
          text: `${tool} of ${rel} landed, but the host could not verify or record it (unresolved: ${outcome.detail.slice(0, 200)}). Read ${rel} before you change it again.`,
        }],
        details: { unresolved: outcome.operationId },
      } as ToolResult;
    }
    if (outcome?.status === "committed" && thrown !== undefined) {
      // The bytes are in and recorded: a later failure of the tool (an abort
      // after its write) is not a failed write.
      return {
        content: [{ type: "text", text: `${tool} of ${rel} was committed before the call ended (${thrown instanceof Error ? thrown.message : String(thrown)}).` }],
        details: { committed: outcome.receipt.operationId },
      } as ToolResult;
    }
    if (thrown !== undefined) throw thrown;
    return result!;
  });
}

/**
 * The target's shape, never following it (S1): what the tools' environments
 * refuse at the boundary — a link, anything but a regular file, a file with a
 * second name (which can lie outside the workspace) — is refused here too,
 * BEFORE any version decision, so a version refusal never masks it. Shared
 * by both bindings; the boundary checks the same again on the descriptor.
 */
export function targetShape(root: string, rel: string): { readonly state: "absent" | "file" } | { readonly state: "refused"; readonly why: string } {
  let entry;
  try {
    entry = lstatSync(resolve(root, rel), { bigint: true });
  } catch (error) {
    const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
    if (code === "ENOENT") return { state: "absent" };
    return { state: "refused", why: `cannot be examined (${String(code ?? error)})` };
  }
  if (entry.isSymbolicLink()) return { state: "refused", why: "is a symbolic link, which a write never follows" };
  if (!entry.isFile()) return { state: "refused", why: "is not a regular file" };
  if (entry.nlink !== 1n) return { state: "refused", why: "has more than one name; a write would reach every other name of it" };
  return { state: "file" };
}

/** A boundary refusal is thrown, as the tools' environments always threw
 * them; a version refusal is a result the model can act on. */
function boundaryError(tool: string, rel: string, detail: string): Error {
  return Object.assign(new Error(`${tool}: ${rel} ${detail}`), { code: "EPERM" });
}
