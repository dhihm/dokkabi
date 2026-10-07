import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { PluginModule } from "../loader/types.ts";
import type { EventLog } from "../host/event-log.ts";
import type { EventRecord } from "../host/schema.ts";
import { BlobStore } from "../host/blob-store.ts";
import { canonicalJson } from "../host/canonical.ts";
import { captureExecutionImage, observeImageTrees, materializeExecutionImage, assertMaterializedExecutionImage, disposeMaterializedExecutionImage, recoverExecutionImage, ExecutionViewError, type ExecutionImageResource, type MaterializedExecutionImage } from "../host/execution-image.ts";
import { appendSandboxExecutionEvent, createExecutionViewPolicyFrom, disposeSandboxPolicy, executionViewBoundary, policyDigest, spawnPreparedSandbox, type SandboxExecutionResult, type SandboxPolicy } from "../host/sandbox.ts";
import { composeExecutionImage, EXECUTION_VIEW_BODY_EVENTS, projectExecutionViews } from "../work/evidence/execution-view.ts";
import { workspaceToolsPolicy } from "./workspace-tools.ts";

type Unavailable = { status: "unavailable"; reason: string };
export interface ExecutionViews {
  capture(): { status: "retained"; digest: string } | Unavailable;
  observe(image: string): { status: "observed"; matched: boolean; reference: { seq: number; hash: string } } | Unavailable;
  compose(input: { candidate: string; checker: string; paths: readonly string[] }): { status: "retained"; digest: string } | Unavailable;
  execute(input: { image: string; command: string; timeoutMs?: number }): { status: "executed"; process: SandboxExecutionResult; changed: boolean; result: { seq: number; hash: string } } | Unavailable;
  recover(): { status: "recovered"; removed: number; active: number } | Unavailable;
  dispose(): void;
}
const reference = (row: EventRecord) => ({ seq: row.seq, hash: row.hash });
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/** This facade runs archived inputs, but grants no case verdict or role. */
export function createExecutionViews(input: { log: EventLog; policy?: SandboxPolicy; readOnly?: boolean }): ExecutionViews {
  let active = true, busy = false;
  const { log, policy } = input;
  const refused = (reason: string): Unavailable => {
    if (!input.readOnly) log.append({ kind: "observe", name: "execution_view/refused", payload: { reason } });
    return { status: "unavailable", reason };
  };
  const reason = (error: unknown) => error instanceof ExecutionViewError ? error.code :
    error instanceof Error && /^execution_(view|image)_[a-z_]+$/u.test(error.message) ? error.message : "execution_view_acquisition_failed";
  const available = (): string | undefined => !active ? "execution_view_unloaded" : input.readOnly ? "execution_view_replay_read_only" : busy ? "execution_view_busy" : !policy || policy.disabled || policy.backend === "none" ? "execution_view_policy_unavailable" : undefined;
  const record = (name: string, body: unknown): EventRecord => {
    const text = canonicalJson(body), blob = BlobStore.forSession(log.path).put(text);
    return log.append({ kind: "observe", name, payload: { blob, blob_bytes: Buffer.byteLength(text) } });
  };
  const readBodies = () => {
    const store = BlobStore.forSession(log.path), bodies = new Map<string, unknown>();
    for (const event of log.events) if (EXECUTION_VIEW_BODY_EVENTS.has(event.name)) {
      const digest = String(event.payload.blob);
      if (!bodies.has(digest)) bodies.set(digest, JSON.parse(store.get(digest)));
    }
    return bodies;
  };
  return Object.freeze({
    capture() {
      const unavailable = available(); if (unavailable) return refused(unavailable);
      busy = true;
      try { const image = captureExecutionImage(log, policy!); return { status: "retained" as const, digest: image.digest }; }
      catch (error) { return refused(reason(error)); }
      finally { busy = false; }
    },
    observe(image: string) {
      const unavailable = available(); if (unavailable) return refused(unavailable);
      busy = true;
      try {
        const retained = projectExecutionViews(log.events, readBodies()).images.find(row => row.digest === image);
        if (!retained || retained.manifest.workspace !== policy!.workspaceRoot) throw new ExecutionViewError("execution_view_image_unenrolled");
        const trees_digest = observeImageTrees(retained.manifest, BlobStore.forSession(log.path));
        const matched = hash(canonicalJson(retained.manifest.trees)) === trees_digest;
        const event = log.append({ kind: "observe", name: "execution_view/observation", payload: { image, trees_digest, matched } });
        return { status: "observed" as const, matched, reference: reference(event) };
      } catch (error) { return refused(reason(error)); }
      finally { busy = false; }
    },
    compose(proposal: Parameters<ExecutionViews["compose"]>[0]) {
      const request = { candidate: proposal.candidate, checker: proposal.checker, paths: [...proposal.paths] };
      const unavailable = available(); if (unavailable) return refused(unavailable);
      busy = true;
      try {
        const images = projectExecutionViews(log.events, readBodies()).images;
        const candidate = images.find(row => row.digest === request.candidate), checker = images.find(row => row.digest === request.checker);
        if (!candidate || !checker) throw new ExecutionViewError("execution_view_image_unenrolled");
        const image = record("execution_view/image", composeExecutionImage(candidate.manifest, checker.manifest, request.paths));
        log.append({ kind: "observe", name: "execution_view/composition", payload: { ...request, image: image.payload.blob } });
        return { status: "retained" as const, digest: String(image.payload.blob) };
      } catch (error) { return refused(reason(error)); }
      finally { busy = false; }
    },
    execute(proposal: Parameters<ExecutionViews["execute"]>[0]) {
      const request = Object.freeze({ image: proposal.image, command: proposal.command, timeoutMs: proposal.timeoutMs });
      const unavailable = available(); if (unavailable) return refused(unavailable);
      if (process.platform !== "linux" || policy!.backend !== "bwrap" || policy!.mode !== "workspace-write") return refused("execution_view_backend_unsupported");
      if (!request.command || request.command.includes("\0") || !/^[a-f0-9]{64}$/u.test(request.image) ||
        (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > 600000))) return refused("execution_view_request_invalid");
      busy = true;
      let materialized: MaterializedExecutionImage | undefined, derived: SandboxPolicy | undefined, dispatch: EventRecord | undefined;
      try {
        const retained = projectExecutionViews(log.events, readBodies()).images.find(row => row.digest === request.image);
        if (!retained) throw new ExecutionViewError("execution_view_image_unenrolled");
        if (retained.manifest.base_policy !== policyDigest(policy!) || retained.manifest.runtime !== hash(readFileSync(policy!.runtimeExecutable)) ||
          canonicalJson(retained.manifest.environment) !== canonicalJson(policy!.childEnv)) throw new ExecutionViewError("execution_view_base_changed");
        materialized = materializeExecutionImage(log, request.image, retained.manifest);
        derived = createExecutionViewPolicyFrom(policy!, materialized);
        const timeout = request.timeoutMs ?? 120000;
        dispatch = record("execution_view/dispatch", { schema_version: 1, image: request.image, command: request.command, timeout_ms: timeout,
          policy: policyDigest(derived), base_policy: retained.manifest.base_policy, environment: derived.childEnv, runtime: retained.manifest.runtime,
          boundary: executionViewBoundary(derived), mappings: materialized.mappings, resource: materialized.resource });
        if (!active) throw new ExecutionViewError("execution_view_unloaded");
        const prepared = appendSandboxExecutionEvent({ log, policy: derived, evidence: { kind: "direct", commandDigest: hash(request.command) } });
        const native = log.events.filter(row => row.name === "sandbox/exec" && row.payload.digest === prepared.digest && row.payload.command_digest === hash(request.command)).at(-1)!;
        if (!active) throw new ExecutionViewError("execution_view_unloaded");
        const processResult = spawnPreparedSandbox(prepared, request.command, timeout, { captureBytes: true, maxBuffer: 4 * 1024 * 1024 });
        let changed = false;
        try { assertMaterializedExecutionImage(materialized); } catch { changed = true; }
        const result = record("execution_view/result", { schema_version: 1, dispatch: reference(dispatch), native: reference(native), process: processResult, changed });
        return { status: "executed" as const, process: processResult, changed, result: reference(result) };
      } catch (error) { return refused(reason(error)); }
      finally {
        try {
          if (derived) disposeSandboxPolicy(derived);
          if (materialized) disposeMaterializedExecutionImage(materialized);
          if (dispatch) log.append({ kind: "observe", name: "execution_view/cleanup", payload: { dispatch: reference(dispatch), status: "removed" } });
        } finally { busy = false; }
      }
    },
    recover() {
      const unavailable = available(); if (unavailable) return refused(unavailable);
      if (!log.events.some(row => row.name === "execution_view/dispatch")) return { status: "recovered" as const, removed: 0, active: 0 };
      busy = true;
      try {
        const bodies = readBodies(), state = projectExecutionViews(log.events, bodies);
        let removed = 0, activeCount = 0;
        for (const execution of state.executions.filter(row => !row.cleaned)) {
          const dispatch = log.events.find(row => row.seq === execution.seq)!;
          const value = bodies.get(String(dispatch.payload.blob)) as { resource: ExecutionImageResource; image: string };
          if (recoverExecutionImage(log, value.resource, value.image) === "active") activeCount++;
          else { log.append({ kind: "observe", name: "execution_view/cleanup", payload: { dispatch: reference(dispatch), status: "removed" } }); removed++; }
        }
        return { status: "recovered" as const, removed, active: activeCount };
      } catch (error) { return refused(reason(error)); }
      finally { busy = false; }
    },
    dispose() { active = false; },
  });
}

export const plugin: PluginModule = {
  id: "execution-view",
  claims: [{ key: "tools", role: "consumer" }, { key: "execution_views", role: "definition" }, { key: "execution_views", role: "provider" }],
  register(ctx) {
    const facade = createExecutionViews({ log: ctx.log, policy: workspaceToolsPolicy(ctx.inject<AgentTool[]>("tools")), readOnly: ctx.log.isReadOnly });
    ctx.effect(() => () => facade.dispose());
    ctx.define("execution_views", { visibility: "host_only", format: "original-path-view-v1", truth: "event_log" });
    ctx.provide("execution_views", facade);
    if (!ctx.log.isReadOnly) facade.recover();
  },
};
