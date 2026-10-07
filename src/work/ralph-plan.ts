import { isRecoveryTerminalError } from "../host/recovery.ts";
import { admitRecoveryChild, recoveringChildLoop, type RecoveryChildInput } from "./recovery-child.ts";
import { readEvidenceBodies } from "./evidence/bodies.ts";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { bootSession } from "../boot.ts";
import type { EventLog } from "../host/event-log.ts";
import { redactText } from "../host/redact.ts";
import { replayContract, replayDigest } from "../host/replay.ts";
import type { ModelResilienceService } from "../plugins/model-resilience.ts";
import {
  draftPlanDigest,
  parseDraftPlanCritique,
  parseDraftPlanReply,
  parseDraftPlanSynthesis,
  validateDraftPlan,
  writeDraftPlan,
  type DraftPlan,
  type DraftPlanCritique,
} from "./draft-plan.ts";
import { renderPrompt } from "./prompt-slots.ts";
import { streamFinalChunk, type VoiceLoop } from "./turn-support.ts";

export const DEFAULT_RALPH_PLAN_PASSES = 3;
export const MIN_RALPH_PLAN_PASSES = 2;
export const MAX_RALPH_PLAN_PASSES = 3;

export type RalphPlanRole = "scout" | "critic" | "synthesizer";
export type RalphPlanStopReason = "converged" | "invalid" | "no_progress" | "max_passes";

export interface RalphPlannerSession {
  readonly sessionId: string;
  readonly log: EventLog;
  readonly loop: VoiceLoop;
  close(): Promise<void>;
}

export interface RalphPlanResult {
  readonly status: "converged" | "stopped";
  readonly stopReason: RalphPlanStopReason;
  readonly passes: number;
  readonly path?: string;
  readonly digest?: string;
  readonly plan?: DraftPlan;
  readonly errors: string[];
}

export function resolveRalphPlanPasses(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RALPH_PLAN_PASSES;
  if (!Number.isInteger(value) || value < MIN_RALPH_PLAN_PASSES || value > MAX_RALPH_PLAN_PASSES) {
    throw new Error(`--max-plan-passes requires an integer from ${MIN_RALPH_PLAN_PASSES} to ${MAX_RALPH_PLAN_PASSES}`);
  }
  return value;
}

export function ralphDraftPlanPath(workspaceRoot: string): string {
  return resolve(workspaceRoot, "work", "ralph-plan.json");
}

export async function openRalphPlanner(input: {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly manifestPath: string;
  readonly repoRoot: string;
  readonly route: string;
  readonly modelId?: string;
  readonly recovery?: RecoveryChildInput;
}): Promise<RalphPlannerSession> {
  const admission = input.recovery ? admitRecoveryChild(input.recovery, input.sessionId) : undefined;
  const { ctx, runtime } = await bootSession({
    sessionId: admission?.sessionId ?? input.sessionId,
    workspaceRoot: input.workspaceRoot,
    manifestPath: input.manifestPath,
    repoRoot: input.repoRoot,
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= runtime.dispose();
  if (!ctx.llm || !ctx.loop) {
    await close();
    throw new Error("Ralph Plan requires llm and loop capabilities");
  }
  try {
    ctx.llm.select(input.route, input.modelId);
    const active = ctx.llm.active();
    ctx.tryGet<ModelResilienceService>("model_resilience")?.setManualPrimary({
      route: ctx.llm.activeName,
      model: ctx.llm.activeModelId ?? active.defaultModelId() ?? "missing",
    });
  } catch (error) {
    await close();
    throw error;
  }
  let recovered: ReturnType<typeof recoveringChildLoop> | undefined;
  try { recovered = admission ? recoveringChildLoop(ctx, ctx.loop, admission) : undefined; }
  catch (error) { await close(); throw error; }
  return { sessionId: admission?.sessionId ?? input.sessionId, log: ctx.log, loop: recovered?.loop ?? ctx.loop, close: async () => { await close(); recovered?.settled(); } };
}

export async function runRalphPlan(input: {
  readonly parentLog: EventLog;
  readonly parentSessionId: string;
  readonly order: string;
  readonly workspaceRoot: string;
  readonly artifactPath?: string;
  readonly maxPasses?: number;
  readonly modelId?: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly route: string;
  readonly openSession: (sessionId: string) => Promise<RalphPlannerSession>;
  readonly nonce?: () => string;
}): Promise<RalphPlanResult> {
  const maxPasses = resolveRalphPlanPasses(input.maxPasses);
  const artifactPath = input.artifactPath ?? ralphDraftPlanPath(input.workspaceRoot);
  const nonce = input.nonce?.() ?? Date.now().toString(36);
  input.parentLog.append({
    kind: "observe",
    name: "work/plan_started",
    payload: {
      mode: "ralph",
      max_passes: maxPasses,
      artifact: workspaceRelative(input.workspaceRoot, artifactPath),
      route: input.route,
      ...(input.modelId ? { model: input.modelId } : {}),
    },
  });

  let draft: DraftPlan | undefined;
  let draftDigest: string | undefined;
  let critique: DraftPlanCritique | undefined;
  let revision = 0;
  let lastRefusalFingerprint: string | undefined;
  let lastErrors: string[] = [];

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const role: RalphPlanRole = draft === undefined ? "scout" : critique === undefined ? "critic" : "synthesizer";
    const childSessionId = `${input.parentSessionId}-ralph-plan-${pass}-${nonce}`;
    input.parentLog.append({
      kind: "observe",
      name: "work/plan_pass",
      payload: { mode: "ralph", pass, max_passes: maxPasses, role, child_session: childSessionId },
    });
    let session: RalphPlannerSession;
    try {
      session = await input.openSession(childSessionId);
    } catch (error) {
      if (isRecoveryTerminalError(error)) throw error;
      const errors = [`${role} session failed to open: ${safeFailure(error)}`];
      input.parentLog.append({
        kind: "observe",
        name: "work/plan_refused",
        payload: {
          pass,
          role,
          child_session: childSessionId,
          child_digest: "missing",
          child_log_hash: "missing",
          errors,
          reply_digest: textDigest(""),
        },
      });
      return stop(input.parentLog, "invalid", pass, errors);
    }
    let reply = "";
    let childDigest = "missing";
    let childLogHash = session.log.lastHash;
    let turnFailure: string | undefined;
    try {
      reply = await streamFinalChunk(session.loop, promptFor(role, input.order, draft, critique, lastErrors), {
        providerRole: role,
        modelId: input.modelId,
        thinkingLevel: input.thinkingLevel,
        thinkingBudgets: { medium: role === "critic" ? 1_024 : 2_048 },
        maxOutputTokens: 8_192,
        timeoutMs: 180_000,
        timeoutPolicy: "continue",
        maxToolCalls: role === "synthesizer" ? 0 : 16,
      });
      childDigest = replayDigest(replayContract(session.log.events, readEvidenceBodies(session.log)));
      childLogHash = session.log.lastHash;
    } catch (error) {
      if (isRecoveryTerminalError(error)) throw error;
      turnFailure = `${role} session failed: ${safeFailure(error)}`;
      childDigest = replayDigest(replayContract(session.log.events, readEvidenceBodies(session.log)));
      childLogHash = session.log.lastHash;
    } finally {
      try {
        await session.close();
      } catch (error) {
        turnFailure ??= `${role} session failed to close: ${safeFailure(error)}`;
      }
    }
    if (turnFailure) {
      const errors = [turnFailure];
      input.parentLog.append({
        kind: "observe",
        name: "work/plan_refused",
        payload: {
          pass,
          role,
          child_session: childSessionId,
          child_digest: childDigest,
          child_log_hash: childLogHash,
          errors,
          reply_digest: textDigest(reply),
        },
      });
      return stop(input.parentLog, "invalid", pass, errors);
    }

    if (role === "scout") {
      const parsed = parseDraftPlanReply(reply, input.order, revision + 1, draftDigest);
      const evidenceErrors = parsed.plan ? validateDraftPlan(parsed.plan, input.workspaceRoot) : [];
      const errors = unique([...parsed.errors, ...evidenceErrors]);
      if (!parsed.plan || errors.length > 0) {
        const stopped = recordRefusal({
          input,
          pass,
          role,
          childSessionId,
          childDigest,
          childLogHash,
          reply,
          errors,
          lastRefusalFingerprint,
          maxPasses,
        });
        lastErrors = errors;
        if (stopped) return stopped;
        lastRefusalFingerprint = refusalFingerprint(reply, errors);
        continue;
      }
      draft = parsed.plan;
      revision += 1;
      draftDigest = draftPlanDigest(draft);
      appendRevision(input.parentLog, {
        pass, role, revision, digest: draftDigest, childSessionId, childDigest, childLogHash, plan: draft,
      });
      lastErrors = [];
      continue;
    }

    if (role === "critic") {
      const parsed = parseDraftPlanCritique(reply, draft!);
      if (!parsed.critique || parsed.errors.length > 0) {
        const stopped = recordRefusal({
          input,
          pass,
          role,
          childSessionId,
          childDigest,
          childLogHash,
          reply,
          errors: parsed.errors,
          lastRefusalFingerprint,
          maxPasses,
        });
        lastErrors = parsed.errors;
        if (stopped) return stopped;
        lastRefusalFingerprint = refusalFingerprint(reply, parsed.errors);
        continue;
      }
      appendCritique(input.parentLog, {
        pass,
        childSessionId,
        childDigest,
        childLogHash,
        critique: parsed.critique,
        draftDigest: draftDigest!,
      });
      if (parsed.critique.verdict === "accept") {
        return converge(input, draft!, draftDigest!, artifactPath, pass);
      }
      critique = parsed.critique;
      lastErrors = [];
      if (pass === maxPasses) {
        return stop(input.parentLog, "max_passes", pass, ["critic requested revision at the final planning pass"]);
      }
      continue;
    }

    const parsed = parseDraftPlanSynthesis(reply, input.order, revision + 1, draftDigest!, critique!);
    const evidenceErrors = parsed.synthesis
      ? validateDraftPlan(parsed.synthesis.draft, input.workspaceRoot)
      : [];
    const errors = unique([...parsed.errors, ...evidenceErrors]);
    if (!parsed.synthesis || errors.length > 0) {
      const reason = errors.some((error) => error.includes("no semantic progress")) ? "no_progress" : "invalid";
      input.parentLog.append({
        kind: "observe",
        name: "work/plan_refused",
        payload: {
          pass,
          role,
          child_session: childSessionId,
          child_digest: childDigest,
          child_log_hash: childLogHash,
          errors: errors.slice(0, 12),
          reply_digest: textDigest(reply),
        },
      });
      return stop(input.parentLog, reason, pass, errors);
    }
    const previousDraft = draft;
    const parentDigest = draftDigest;
    draft = parsed.synthesis.draft;
    revision += 1;
    draftDigest = draftPlanDigest(draft);
    appendRevision(input.parentLog, {
      pass, role, revision, digest: draftDigest, childSessionId, childDigest, childLogHash, plan: draft,
      previousPlan: previousDraft,
      parentDigest,
      resolved: parsed.synthesis.resolved_findings.length,
    });
    return converge(input, draft, draftDigest, artifactPath, pass);
  }

  return stop(input.parentLog, draft ? "max_passes" : "invalid", maxPasses, lastErrors);
}

function promptFor(
  role: RalphPlanRole,
  order: string,
  draft: DraftPlan | undefined,
  critique: DraftPlanCritique | undefined,
  errors: readonly string[],
): string {
  if (role === "scout") {
    return renderPrompt("work/ralph-plan-scout.md", {
      order,
      refusal_block: errors.length > 0 ? `The previous fresh attempt was refused:\n${errors.map((error) => `- ${error}`).join("\n")}` : "",
    }).trimEnd();
  }
  if (role === "critic") {
    return renderPrompt("work/ralph-plan-critic.md", {
      order,
      draft_json: JSON.stringify(draft, null, 2),
      refusal_block: errors.length > 0 ? `The previous critic reply was refused:\n${errors.map((error) => `- ${error}`).join("\n")}` : "",
    }).trimEnd();
  }
  return renderPrompt("work/ralph-plan-synthesize.md", {
    order,
    draft_json: JSON.stringify(draft, null, 2),
    critique_json: JSON.stringify(critique, null, 2),
  }).trimEnd();
}

function appendRevision(
  log: EventLog,
  input: {
    readonly pass: number;
    readonly role: RalphPlanRole;
    readonly revision: number;
    readonly digest: string;
    readonly childSessionId: string;
    readonly childDigest: string;
    readonly childLogHash: string;
    readonly plan: DraftPlan;
    readonly previousPlan?: DraftPlan;
    readonly parentDigest?: string;
    readonly resolved?: number;
  },
): void {
  log.append({
    kind: "observe",
    name: "work/plan_revision",
    payload: {
      mode: "ralph",
      pass: input.pass,
      role: input.role,
      revision: input.revision,
      digest: input.digest,
      ...(input.parentDigest ? { parent_digest: input.parentDigest } : {}),
      delta: draftDelta(input.previousPlan, input.plan),
      child_session: input.childSessionId,
      child_digest: input.childDigest,
      child_log_hash: input.childLogHash,
      boundaries: input.plan.boundaries.length,
      todos: input.plan.todos.length,
      unknowns: input.plan.unknowns.length,
      contradictions: input.plan.contradictions.length,
      evidence: input.plan.evidence_refs.length,
      ...(input.resolved === undefined ? {} : { resolved_findings: input.resolved }),
    },
  });
}

function appendCritique(
  log: EventLog,
  input: {
    readonly pass: number;
    readonly childSessionId: string;
    readonly childDigest: string;
    readonly childLogHash: string;
    readonly critique: DraftPlanCritique;
    readonly draftDigest: string;
  },
): void {
  const blocking = input.critique.findings.filter((finding) => finding.blocking).length;
  const newGaps = input.critique.findings.filter((finding) =>
    finding.kind === "missing_boundary" || finding.kind === "evidence"
  ).length;
  log.append({
    kind: "observe",
    name: "work/plan_revision",
    payload: {
      mode: "ralph",
      pass: input.pass,
      role: "critic",
      digest: input.draftDigest,
      decision: input.critique.verdict,
      child_session: input.childSessionId,
      child_digest: input.childDigest,
      child_log_hash: input.childLogHash,
      findings: input.critique.findings.length,
      blocking,
      new_gaps: newGaps,
    },
  });
}

function converge(
  input: Parameters<typeof runRalphPlan>[0],
  plan: DraftPlan,
  digest: string,
  artifactPath: string,
  passes: number,
): RalphPlanResult {
  writeDraftPlan(artifactPath, plan);
  input.parentLog.append({
    kind: "observe",
    name: "work/plan_converged",
    payload: {
      mode: "ralph",
      passes,
      revision: plan.revision,
      digest,
      boundaries: plan.boundaries.length,
      todos: plan.todos.length,
    },
  });
  input.parentLog.append({
    kind: "observe",
    name: "work/plan_sealed",
    payload: {
      mode: "ralph",
      stage: "draft",
      draft_digest: digest,
      artifact: workspaceRelative(input.workspaceRoot, artifactPath),
    },
  });
  return { status: "converged", stopReason: "converged", passes, path: artifactPath, digest, plan, errors: [] };
}

function recordRefusal(input: {
  readonly input: Parameters<typeof runRalphPlan>[0];
  readonly pass: number;
  readonly role: RalphPlanRole;
  readonly childSessionId: string;
  readonly childDigest: string;
  readonly childLogHash: string;
  readonly reply: string;
  readonly errors: readonly string[];
  readonly lastRefusalFingerprint?: string;
  readonly maxPasses: number;
}): RalphPlanResult | undefined {
  const fingerprint = refusalFingerprint(input.reply, input.errors);
  input.input.parentLog.append({
    kind: "observe",
    name: "work/plan_refused",
    payload: {
      pass: input.pass,
      role: input.role,
      child_session: input.childSessionId,
      child_digest: input.childDigest,
      child_log_hash: input.childLogHash,
      errors: input.errors.slice(0, 12),
      reply_digest: textDigest(input.reply),
    },
  });
  if (fingerprint === input.lastRefusalFingerprint) {
    return stop(input.input.parentLog, "no_progress", input.pass, [...input.errors]);
  }
  if (input.pass === input.maxPasses) {
    return stop(input.input.parentLog, "invalid", input.pass, [...input.errors]);
  }
  return undefined;
}

function stop(log: EventLog, reason: Exclude<RalphPlanStopReason, "converged">, passes: number, errors: readonly string[]): RalphPlanResult {
  log.append({
    kind: "observe",
    name: "work/plan_stopped",
    payload: { mode: "ralph", reason, passes, errors: errors.slice(0, 12) },
  });
  return { status: "stopped", stopReason: reason, passes, errors: [...errors] };
}

function refusalFingerprint(reply: string, errors: readonly string[]): string {
  return textDigest(`${[...errors].sort().join("\n")}\0${reply.trim()}`);
}

function textDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function safeFailure(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240) || "unknown failure";
}

function draftDelta(previous: DraftPlan | undefined, next: DraftPlan): Record<string, number> {
  const count = (before: readonly string[], after: readonly string[]) => {
    const old = new Set(before);
    const current = new Set(after);
    return {
      added: [...current].filter((item) => !old.has(item)).length,
      removed: [...old].filter((item) => !current.has(item)).length,
    };
  };
  const boundary = count(previous?.boundaries.map((item) => item.id) ?? [], next.boundaries.map((item) => item.id));
  const todo = count(previous?.todos.map((item) => item.id) ?? [], next.todos.map((item) => item.id));
  const evidence = count(previous?.evidence_refs.map((item) => item.id) ?? [], next.evidence_refs.map((item) => item.id));
  const dependencyDigest = (plan: DraftPlan | undefined) => textDigest(
    (plan?.todos ?? [])
      .map((item) => `${item.id}:${[...item.blocked_by].sort().join(",")}`)
      .sort()
      .join("\n"),
  );
  return {
    boundaries_added: boundary.added,
    boundaries_removed: boundary.removed,
    todos_added: todo.added,
    todos_removed: todo.removed,
    evidence_added: evidence.added,
    evidence_removed: evidence.removed,
    dependencies_changed: previous && dependencyDigest(previous) !== dependencyDigest(next) ? 1 : 0,
  };
}

function workspaceRelative(workspaceRoot: string, path: string): string {
  const root = resolve(workspaceRoot);
  const absolute = resolve(path);
  return absolute === root ? "." : absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : "outside";
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
