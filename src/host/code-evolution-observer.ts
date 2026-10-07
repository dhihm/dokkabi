import { EventLog } from "./event-log.ts";
import { canonicalJson } from "./canonical.ts";
import type { EventInput, EventRecord } from "./schema.ts";
import type { VersionResult } from "./code-evolution-versions.ts";
import { captureMaterial, CodeVersionRefusal, LIMITS, sha } from "../code-evolution/material.ts";
import { codeSessionIsBound } from "../code-evolution/session-binding.ts";
import {
  observerPolicy,
  observerResumeRequest,
  readCodeObserverState,
  type CodeObserverState,
} from "../code-evolution/observer-state.ts";
export { readCodeObserverState } from "../code-evolution/observer-state.ts";

const boundaries = new Set(["initial", "resume", "tool_batch", "todo_clear", "goal_done"]);
type Options = {
  log: EventLog;
  sessionId: string;
  workspaceRoot: string;
  paths: readonly string[];
  versions: { capture(input: unknown): VersionResult; read(input: unknown): VersionResult };
  idle?: {
    isSettled(): boolean;
    schedule?(callback: () => void, milliseconds: number): () => void;
  };
};
/** Comparison excludes diff and out-of-scope history: those describe the
 * transition, not today's selected material. Never cache only this digest. */
function stateDigest(value: Pick<VersionResult["value"], "rootId" | "files" | "policies">) {
  return sha(canonicalJson({ rootId: value.rootId, files: value.files, policies: value.policies }));
}

/** Owned synchronous boundary observer, not a background filesystem watcher.
 * Every publication still goes through the existing durable capture protocol. */
export class CodeEvolutionObserver {
  private readonly policy: ReturnType<typeof observerPolicy>;
  private readonly base: Omit<ReturnType<typeof observerPolicy>, "paths">;
  private disposed = false;
  private suspended = false;
  private cancelTimer: (() => void) | undefined;
  private watcherStarted = false;
  private watcherFailed = false;
  private watcherGeneration = 0;
  constructor(private readonly options: Options) {
    this.policy = observerPolicy(options.sessionId, options.workspaceRoot, options.paths);
    const { paths: _paths, ...base } = this.policy;
    this.base = base;
  }
  private rows(): readonly EventRecord[] {
    const rows = new EventLog(this.options.log.path, { readOnly: true }).events;
    if (
      rows.some((r) => !r.payload || typeof r.payload !== "object" || Array.isArray(r.payload)) ||
      !codeSessionIsBound(rows, this.options.sessionId)
    )
      throw new Error("Code observer source ownership invalid");
    return rows;
  }
  private append(name: string, payload: Record<string, unknown>): EventRecord {
    const rows = this.options.log.appendBatchDurable(() => {
      if (!codeSessionIsBound(this.options.log.events, this.options.sessionId))
        throw new Error("Code observer source ownership invalid");
      return [
        { kind: "observe", name, payload: { ...this.base, ...payload } } satisfies EventInput,
      ];
    });
    return rows[0]!;
  }
  private transition(
    name: "code/observer_paused" | "code/observer_disabled",
    payload: Record<string, unknown>,
    window?: number,
  ) {
    this.options.log.appendBatchDurable(() => {
      if (!codeSessionIsBound(this.options.log.events, this.options.sessionId))
        throw new Error("Code observer source ownership invalid");
      const state = readCodeObserverState(
        this.options.log.events,
        this.options.sessionId,
        this.options.workspaceRoot,
      );
      if (state.policyDigest !== this.policy.policyDigest || state.state !== "active" || (window !== undefined && state.window !== window)) return [];
      return [{ kind: "observe", name, payload: { ...this.base, ...payload } }];
    });
  }
  private pause(reason: NonNullable<CodeObserverState["reason"]>, window?: number) {
    this.transition("code/observer_paused", { reason }, window);
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }
  private watcherTransition(runtime: "started" | "suspended" | "stopped" | "unavailable"): boolean {
    const rows = this.options.log.appendBatchDurable(() => {
      if (!codeSessionIsBound(this.options.log.events, this.options.sessionId)) throw new Error("Code observer source ownership invalid");
      const state = readCodeObserverState(this.options.log.events, this.options.sessionId, this.options.workspaceRoot);
      if (state.policyDigest !== this.policy.policyDigest) return [];
      return [{ kind: "observe", name: "code/observer_watcher", payload: { ...this.base,
        mode: "selected_path_idle_poll", intervalMs: 5000, runtime } }];
    });
    return rows.length === 1;
  }
  markWatcherUnavailable(): void {
    if (this.options.log.isReadOnly || this.disposed) return;
    const state = readCodeObserverState(this.rows(), this.options.sessionId, this.options.workspaceRoot);
    if (state.policyDigest !== this.policy.policyDigest || state.state === "off")
      this.append("code/observer_configured", { paths: this.policy.paths });
    this.watcherTransition("unavailable");
  }
  /** Idle polling is explicitly owned by the trusted host, never by a read. */
  startWatcher(): void {
    if (this.disposed || this.suspended || this.watcherFailed || !this.options.idle || this.options.log.isReadOnly || this.cancelTimer) return;
    let state = readCodeObserverState(this.rows(), this.options.sessionId, this.options.workspaceRoot);
    if (state.policyDigest !== this.policy.policyDigest || state.state === "off") {
      this.append("code/observer_configured", { paths: this.policy.paths });
      state = readCodeObserverState(this.rows(), this.options.sessionId, this.options.workspaceRoot);
    }
    if (state.state !== "active") return;
    if (!this.watcherStarted) {
      if (!this.watcherTransition("started")) return;
      this.watcherStarted = true;
    }
    const generation = ++this.watcherGeneration;
    const callback = () => {
      if (generation !== this.watcherGeneration) return;
      this.cancelTimer = undefined;
      if (this.disposed || this.suspended || this.watcherFailed) return;
      try {
        if (this.options.idle!.isSettled()) this.check("idle");
        const current = readCodeObserverState(this.rows(), this.options.sessionId, this.options.workspaceRoot);
        if (current.policyDigest === this.policy.policyDigest && current.state === "active") this.startWatcher();
      } catch {
        // Preserve EventLog's failed-append model guard. No hidden retry or
        // in-memory claim that a failed collector is still running.
        this.watcherFailed = true;
        this.watcherStarted = false;
        if (this.options.log.canRequestModel) {
          try { this.pause("capture_failed"); this.watcherTransition("stopped"); } catch { /* retained source/append refusal stays visible */ }
        }
      }
    };
    if (this.options.idle.schedule) this.cancelTimer = this.options.idle.schedule(callback, 5000);
    else {
      const timer = setTimeout(callback, 5000);
      timer.unref?.();
      this.cancelTimer = () => clearTimeout(timer);
    }
  }
  async suspend(): Promise<void> {
    if (this.disposed || this.suspended) return;
    this.suspended = true;
    this.watcherGeneration++;
    this.cancelTimer?.(); this.cancelTimer = undefined;
    if (this.watcherStarted) {
      this.watcherTransition("suspended");
      this.watcherStarted = false;
    }
  }
  async resumeWatcher(): Promise<void> {
    if (this.disposed || !this.suspended) return;
    this.suspended = false;
    this.startWatcher();
  }
  resume(input: unknown): { commandId: string; seq: number; hash: string } {
    if (this.disposed || this.suspended || this.options.log.isReadOnly || (this.options.idle && !this.options.idle.isSettled())) throw new CodeVersionRefusal("observer_unavailable");
    const request = observerResumeRequest.parse(input);
    let receipt: EventRecord | undefined;
    let refusal: string | undefined;
    const appended = this.options.log.appendBatchDurable(() => {
      try {
      if (!codeSessionIsBound(this.options.log.events, this.options.sessionId)) throw new CodeVersionRefusal("observer_conflict");
      const previous = this.options.log.events.find(r => r.name === "code/observer_resumed" && r.payload.commandId === request.commandId);
      if (previous) {
        if (previous.payload.policyDigest !== this.policy.policyDigest || previous.payload.expectedRevision !== request.expectedRevision || previous.payload.newWindow !== request.newWindow)
          throw new CodeVersionRefusal("idempotency_conflict");
        receipt = previous; return [];
      }
      const state = readCodeObserverState(this.options.log.events, this.options.sessionId, this.options.workspaceRoot);
      if (state.policyDigest !== this.policy.policyDigest || state.revision !== request.expectedRevision || state.state === "active")
        throw new CodeVersionRefusal("observer_conflict");
      if (state.retainedVersions >= LIMITS.versions || state.retainedBytes >= LIMITS.retained || state.reason === "version_limit" || state.reason === "retention_bytes_limit")
        throw new CodeVersionRefusal("observer_storage_limit");
      if (!request.newWindow && state.checks >= 256) throw new CodeVersionRefusal("observer_check_limit");
      if (state.window >= Number.MAX_SAFE_INTEGER || state.lifetimeChecks >= Number.MAX_SAFE_INTEGER)
        throw new CodeVersionRefusal("observer_counter_limit");
      return [{ kind: "observe", name: "code/observer_resumed", payload: { ...this.base, schema: 2,
        ...request, window: state.window + Number(request.newWindow), lifetimeChecks: state.lifetimeChecks } }];
      } catch (error) {
        if (!(error instanceof CodeVersionRefusal)) throw error;
        refusal = error.code; return [];
      }
    });
    if (refusal) throw new CodeVersionRefusal(refusal);
    appended.forEach(row => { receipt = row; });
    if (!receipt) throw new CodeVersionRefusal("observer_conflict");
    if (appended.length) { this.watcherFailed = false; this.startWatcher(); }
    return { commandId: request.commandId, seq: receipt.seq, hash: receipt.hash };
  }
  check(boundary: string): void {
    if (this.disposed || this.suspended || this.options.log.isReadOnly ||
      (!boundaries.has(boundary) && !(boundary === "idle" && this.watcherStarted && this.options.idle?.isSettled()))) return;
    let rows = this.rows();
    let state = readCodeObserverState(rows, this.options.sessionId, this.options.workspaceRoot);
    if (state.policyDigest !== this.policy.policyDigest || state.state === "off") {
      this.append("code/observer_configured", { paths: this.policy.paths });
      rows = this.rows();
      state = readCodeObserverState(rows, this.options.sessionId, this.options.workspaceRoot);
    }
    if (state.state === "paused") return;
    if (state.checks >= 256) return this.pause("check_limit", state.window);
    if (state.lifetimeChecks >= Number.MAX_SAFE_INTEGER) return this.pause("check_limit", state.window);
    const publications = rows.filter((r) => r.name === "code/version");
    if (publications.length >= LIMITS.versions) return this.pause("version_limit", state.window);
    if (state.retainedBytes >= LIMITS.retained) return this.pause("retention_bytes_limit", state.window);
    try {
      const last = publications.at(-1);
      const previous = last
        ? this.options.versions.read({
            sessionId: this.options.sessionId,
            version: { seq: last.seq, hash: last.hash },
            digest: last.payload.blob,
          })
        : null;
      const source = rows.at(-1)!;
      const material = captureMaterial(
        this.options.workspaceRoot,
        this.policy.paths,
        previous?.value ?? null,
      );
      if (previous && previous.value.rootId !== material.rootId)
        throw new CodeVersionRefusal("workspace_identity_changed");
      const digest = stateDigest(material);
      const changed = previous === null || digest !== stateDigest(previous.value);
      const check = state.checks + 1;
      // Refuse competing producer/lifecycle changes rather than append an
      // invalid duplicate counter. There is one enrolled observer per kernel.
      this.options.log.appendBatchDurable(() => {
        if (!codeSessionIsBound(this.options.log.events, this.options.sessionId))
          throw new Error("Code observer source ownership invalid");
        const current = readCodeObserverState(
          this.options.log.events,
          this.options.sessionId,
          this.options.workspaceRoot,
        );
        if (
          current.policyDigest !== this.policy.policyDigest ||
          current.state !== "active" ||
          current.checks !== state.checks || current.window !== state.window ||
          current.lifetimeChecks !== state.lifetimeChecks
        )
          throw new CodeVersionRefusal("observer_conflict");
        return [
          {
            kind: "observe",
            name: "code/observer_checked",
            payload: {
              ...this.base,
              source: { seq: source.seq, hash: source.hash },
              boundary,
              check,
              changed,
              digest,
              files: material.files.map((f) => ({
                path: f.path,
                status: f.status,
                original: f.original?.digest ?? null,
                sanitized: f.sanitized?.digest ?? null,
              })),
            },
          },
        ];
      });
      if (!changed) return;
      // Full policy digest plus bounded check number fits the E1 80-char id.
      // The checked digest describes the first read; this capture re-reads.
      this.options.versions.capture({
        id: state.window === 0 ? `ob_${this.policy.policyDigest}_${check.toString(36)}` :
          `ow_${this.policy.policyDigest}_${(state.lifetimeChecks + 1).toString(36)}`,
        expected: { seq: this.options.log.lastSeq, hash: this.options.log.lastHash },
        paths: this.policy.paths,
        previous: previous?.reference ?? null,
        links: [],
      });
    } catch (error) {
      const code = error instanceof CodeVersionRefusal ? error.code : null;
      this.pause(
        code === "version_limit" || code === "retention_bytes_limit"
          ? code
          : code !== null
            ? "source_refused"
            : "capture_failed",
        state.window,
      );
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.watcherGeneration++;
    this.cancelTimer?.(); this.cancelTimer = undefined;
    if (this.options.log.isReadOnly) return;
    if (this.watcherStarted) {
      const state = readCodeObserverState(this.rows(), this.options.sessionId, this.options.workspaceRoot);
      if (state.policyDigest === this.policy.policyDigest)
        this.watcherTransition("stopped");
    }
    this.transition("code/observer_disabled", {});
  }
}
