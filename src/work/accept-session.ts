import { admitRecoveryChild, recoveringChildLoop, type RecoveryChildInput } from "./recovery-child.ts";
import { factorEnabled, recordUnobservedFactor } from "../plugins/experiment-runtime.ts";
import { resolve } from "node:path";
import { assertPreparedFixture, assertPreparedFixtureEnvironment, prepareFixture, type PreparedFixture } from "./evidence/fixture-prepare.ts";
import { FixturePreparationError, readFixtureEnrollment } from "./evidence/fixture-manifest.ts";
import { readEvidenceBodies } from "./evidence/bodies.ts";
import { assertSandboxPolicyEnforceable, effectiveSandboxChildEnvironment } from "../host/sandbox.ts";
import { workspaceToolsPolicy } from "../plugins/workspace-tools.ts";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { bootSession } from "../boot.ts";
import type { EventLog } from "../host/event-log.ts";
import { replayContract, replayDigest } from "../host/replay.ts";
import type { ModelResilienceService } from "../plugins/model-resilience.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { acceptanceThinkingLevel, resolveThinkingLevel, thinkingBudgetsForLevel } from "../host/thinking.ts";
import { acceptanceSpecTurn, acceptTurn, type AcceptVerdict, type VoiceLoop } from "./speak.ts";
import { unavailableAcceptance, finalizeBudgetedReview } from "./accept-turn.ts";
import { remainingReviewTime } from "./review-budget.ts";
import { acceptanceDesignSchema, preworkAcceptanceSpecification, preworkSpecificationSource } from "./acceptance-design.ts";
import { streamFinalChunk } from "./turn-support.ts";
import { renderPrompt } from "./prompt-slots.ts";
import { parseAcceptDecision } from "./prompt.ts";
import { canonicalJson } from "../host/canonical.ts";
import { captureWorkReviewEvidence, workReviewPolicy } from "./evidence/work-review.ts";
import { projectObligations } from "./evidence/obligations.ts";
import { bindWorkReviewDelivery } from "./evidence/acceptance-execution.ts";
import { acceptanceCandidate, assertAcceptanceContract, readAcceptanceContract } from "./evidence/acceptance-contract.ts";
import { acceptanceDeliveryCurrent, beginAcceptanceExecution, bindAcceptanceDelivery, closeAcceptanceSnapshot, executeAcceptanceChecks, finishAcceptanceExecution, type AcceptanceExecution, type AcceptanceProbeExecutor } from "./evidence/acceptance-execution.ts";

// Host enrollment must explicitly authorize this scope; model requests cannot choose it.
export const ACCEPTANCE_FIXTURE_COMMAND = "dokkabi acceptance";

export type AcceptanceAction = "done" | "retry" | "replan" | "stop";

export function nextAcceptanceAction(
  verdict: Pick<AcceptVerdict, "accepted" | "inconclusive" | "verdictTurnUsed" | "retryable" | "confirmationComplete">,
  wave: number,
  maxWaves: number,
  confirmationUsed = false,
): AcceptanceAction {
  if (verdict.accepted) {
    return verdict.verdictTurnUsed && !confirmationUsed && !verdict.confirmationComplete ? "retry" : "done";
  }
  if (verdict.inconclusive) {
    if (verdict.retryable === false) return "stop";
    return confirmationUsed ? "stop" : "retry";
  }
  return wave >= maxWaves ? "stop" : "replan";
}

export interface AcceptanceVerifierSession {
  sessionId: string;
  /** Required for managed acceptance; the host checks the session opened the snapshot. */
  workspaceRoot?: string;
  /** Actual filtered process environment declared by the trusted session factory. */
  childEnv?: Readonly<Record<string, string>>;
  /** A host-verified blind spec session with no process tools and no child environment. */
  noProcessTools?: true;
  log: EventLog;
  loop: VoiceLoop;
  acceptanceProbes?: AcceptanceProbeExecutor;
  close(): Promise<void>;
}

export interface AcceptanceSessionOptions {
  workspaceRoot: string;
  phase: "spec" | "verify" | "design";
  /** Opaque live host capability; never serialized into a model prompt. */
  preparedFixture?: PreparedFixture;
}

interface RunAcceptanceVerifierInput {
  parentLog: EventLog;
  parentSessionId: string;
  /** Trusted parent workspace, never selected by a child or acceptance prompt. */
  workspaceRoot?: string;
  wave: number;
  order: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  remainingMs?: () => number | undefined;
  print: (text: string) => void;
  narrate?: boolean;
  ledger?: string;
  route?: string;
  openSpecSession(sessionId: string, options: AcceptanceSessionOptions): Promise<AcceptanceVerifierSession>;
  openSession(sessionId: string, options: AcceptanceSessionOptions): Promise<AcceptanceVerifierSession>;
  nonce?: () => string;
}

interface OpenAcceptanceVerifierInput {
  sessionId: string;
  phase?: "spec" | "verify" | "design";
  preparedFixture?: PreparedFixture;
  workspaceRoot: string;
  manifestPath: string;
  repoRoot: string;
  route: string;
  recovery?: RecoveryChildInput;
}

export async function openAcceptanceVerifier(
  input: OpenAcceptanceVerifierInput,
): Promise<AcceptanceVerifierSession> {
  if (input.preparedFixture) {
    assertPreparedFixture(input.preparedFixture);
    if (resolve(input.workspaceRoot) !== input.preparedFixture.root) throw new FixturePreparationError("acceptance_workspace_mismatch");
  }
  const admission = input.recovery ? admitRecoveryChild(input.recovery, input.sessionId) : undefined;
  const { ctx, runtime } = await bootSession({
    sessionId: admission?.sessionId ?? input.sessionId,
    workspaceRoot: input.workspaceRoot,
    manifestPath: input.manifestPath,
    repoRoot: input.repoRoot,
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= runtime.dispose();
  const loop = ctx.loop;
  if (!ctx.llm || !loop) {
    await close();
    throw new Error("acceptance verifier requires llm and loop capabilities");
  }
  const checkExecution = (): { childEnv?: Readonly<Record<string, string>>; noProcessTools?: true } => {
    const prepared = input.preparedFixture;
    if (!prepared) {
      if (input.phase !== "design" && input.phase !== "verify") return {};
      const policy = workspaceToolsPolicy(ctx.tryGet<AgentTool[]>("tools") ?? []);
      if (!policy || policy.disabled || policy.backend === "none" || policy.mode !== "read-only" ||
        policy.workspaceRoot !== ctx.workspaceRoot || (policy.writablePaths?.length ?? 0) !== 0) {
        throw new FixturePreparationError("acceptance_review_requires_read_only_workspace");
      }
      assertSandboxPolicyEnforceable(policy);
      return { childEnv: effectiveSandboxChildEnvironment(policy) };
    }
    assertPreparedFixture(prepared);
    const tools = ctx.tryGet<AgentTool[]>("tools");
    if (tools === undefined || (Array.isArray(tools) && tools.length === 0)) {
      if (input.phase !== "spec") throw new FixturePreparationError("managed_execution_requires_sandbox");
      return { noProcessTools: true };
    }
    const policy = workspaceToolsPolicy(tools);
    if (!policy || policy.backend === "none" || policy.disabled) throw new FixturePreparationError("managed_execution_requires_sandbox");
    if (policy.workspaceRoot !== prepared.root) throw new FixturePreparationError("acceptance_workspace_mismatch");
    try { assertSandboxPolicyEnforceable(policy); }
    catch { throw new FixturePreparationError("managed_acceptance_policy_unenforceable"); }
    const childEnv = effectiveSandboxChildEnvironment(policy);
    assertPreparedFixtureEnvironment(prepared, childEnv);
    return { childEnv };
  };
  let execution: ReturnType<typeof checkExecution>;
  try {
    execution = checkExecution();
    ctx.llm.select(input.route);
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
  try { recovered = admission ? recoveringChildLoop(ctx, loop, admission) : undefined; }
  catch (error) { await close(); throw error; }
  const guardedLoop: VoiceLoop = { async prompt(text, options) {
    if (input.preparedFixture || input.phase === "design" || input.phase === "verify") checkExecution();
    return (recovered?.loop ?? loop).prompt(text, { ...options, providerRole: input.phase === "spec" ? "spec" : "review" });
  } };
  return { sessionId: admission?.sessionId ?? input.sessionId, workspaceRoot: ctx.workspaceRoot, ...execution, log: ctx.log, loop: guardedLoop,
    acceptanceProbes: ctx.tryGet<AcceptanceProbeExecutor>("acceptance_probes"), close: async () => { await close(); recovered?.settled(); } };
}

/** Separate prework context; no implementation transcript or proposed patch is
 * available. JSON repair is bounded and cannot silently change the task. */
export async function generateAcceptanceDesign(input: {
  parentLog: EventLog; sessionId: string; prompt: string; modelId?: string; thinkingLevel?: ThinkingLevel;
  open(): Promise<AcceptanceVerifierSession>;
}): Promise<{ proposal: unknown; source: string }> {
  input.parentLog.append({ kind: "observe", name: "work/step", payload: { action: "accept_prepare", verifier_session: input.sessionId } });
  const session = await input.open();
  try {
    let prompt = input.prompt;
    const thinkingLevel = acceptanceThinkingLevel(input.thinkingLevel ?? resolveThinkingLevel());
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await streamFinalChunk(session.loop, prompt, { providerRole: "review", modelId: input.modelId,
        thinkingLevel, thinkingBudgets: thinkingBudgetsForLevel(thinkingLevel, { medium: 1024 }),
        maxOutputTokens: 4096, maxToolCalls: attempt === 0 ? 8 : 0, timeoutMs: 90000 });
      try {
        const proposal = acceptanceDesignSchema.parse(JSON.parse(text));
        return { proposal, source: session.sessionId };
      } catch {
        session.log.append({ kind: "observe", name: "acceptance/design_refused", payload: { reason: "invalid_proposal_json", attempt: attempt + 1 } });
        prompt = "Your final response did not match the requested acceptance JSON schema. Return the complete JSON object only, using the evidence already inspected. Do not call tools. If you cannot provide valid executable criteria, return the unsupported object with the concrete reason.";
      }
    }
    throw new Error("acceptance_design_invalid_after_repair");
  } finally {
    await session.close();
    input.parentLog.append({ kind: "observe", name: "acceptance/design_session", payload: { session: session.sessionId,
      log_hash: session.log.lastHash, digest: replayDigest(replayContract(session.log.events, readEvidenceBodies(session.log))) } });
  }
}

/** Execute the frozen generated checks on the original product. A repair's
 * criteria must distinguish its initial failure; a constant passing script
 * cannot acquire readiness just because the model proposed it. No model turn. */
export async function checkAcceptanceReadiness(input: {
  parentLog: EventLog; sessionId: string; workspaceRoot: string; requireFailure: boolean;
  open(options: AcceptanceSessionOptions): Promise<AcceptanceVerifierSession>;
}): Promise<void> {
  const contract = readAcceptanceContract(input.parentLog, input.workspaceRoot);
  if (!contract?.origin) return; // Explicit catalogues retain their operator-defined admission.
  if (input.parentLog.events.some(event => event.name === "acceptance/readiness" && event.payload.status === "ready"
    && event.payload.proposal_ref === contract.origin!.proposal_ref)) return;
  const preparation = prepareFixture({ log: input.parentLog, workspace: input.workspaceRoot, command: ACCEPTANCE_FIXTURE_COMMAND, visibility: "visible" });
  if (preparation.status !== "prepared") throw new FixturePreparationError("acceptance_readiness_snapshot_unavailable");
  let session: AcceptanceVerifierSession | undefined;
  let execution: AcceptanceExecution | undefined;
  let reason: string | undefined;
  try {
    const delivered = acceptanceCandidate(input.parentLog, contract.workspace, preparation.manifest.excluded_candidate_roots).digest;
    const evaluated = acceptanceCandidate(input.parentLog, preparation.root).digest;
    input.parentLog.append({ kind: "observe", name: "work/step", payload: { action: "accept_preflight", verifier_session: input.sessionId } });
    session = await input.open({ workspaceRoot: preparation.root, phase: "verify", preparedFixture: preparation });
    if (session.workspaceRoot !== preparation.root || !session.childEnv) throw new FixturePreparationError("acceptance_readiness_workspace_mismatch");
    assertPreparedFixtureEnvironment(preparation, session.childEnv);
    const specification = `BOUNDARIES: prework execution readiness\nCONTRACT: host-frozen generated checks\nCOUNTEREXAMPLE: original requested failure\nCHECK: ${JSON.stringify(contract.required_checks.map(check => check.id))}`;
    execution = beginAcceptanceExecution({ parentLog: input.parentLog, log: session.log, contract, prepared: preparation,
      specification, executor: session.acceptanceProbes, expectedCandidate: { delivered, evaluated } });
    const result = await executeAcceptanceChecks(execution, { completeSet: true });
    const decision = finishAcceptanceExecution(execution);
    reason = result.unavailableReason ?? (decision.status === "inconclusive" ? decision.reason
      : input.requireFailure && decision.status === "accepted" ? "prework_checks_do_not_detect_requested_failure" : undefined);
    if (reason) throw new FixturePreparationError(reason);
  } catch (error) {
    input.parentLog.append({ kind: "observe", name: "acceptance/readiness", payload: { status: "unavailable",
      proposal_ref: contract.origin.proposal_ref, reason: error instanceof Error ? error.message : String(error) } });
    throw error;
  } finally {
    try {
      await session?.close();
      if (execution) closeAcceptanceSnapshot(execution);
    } finally { preparation.close(); }
  }
  input.parentLog.append({ kind: "observe", name: "acceptance/readiness", payload: { status: "ready",
    origin: "generated_prework", proposal_ref: contract.origin.proposal_ref, require_failure: input.requireFailure,
    verifier_session: session!.sessionId, verifier_digest: replayDigest(replayContract(session!.log.events, readEvidenceBodies(session!.log))),
    verifier_log_hash: session!.log.lastHash } });
}

export async function runAcceptanceVerifier(input: RunAcceptanceVerifierInput): Promise<AcceptVerdict> {
  if (!factorEnabled(input.parentLog, "acceptance")) {
    recordUnobservedFactor(input.parentLog, "acceptance", "verifier_disabled");
    throw new Error("acceptance is disabled by the registered experiment");
  }
  if (input.workspaceRoot && !readAcceptanceContract(input.parentLog, input.workspaceRoot)
    && workReviewPolicy(input.parentLog.events, input.workspaceRoot, input.order)) {
    return runWorkReview(input);
  }
  const nonce = input.nonce?.() ?? Date.now().toString(36);
  const specSessionId = `${input.parentSessionId}-accept-spec-${input.wave}-${nonce}`;
  const verifierSessionId = `${input.parentSessionId}-accept-${input.wave}-${nonce}`;
  let prepared: PreparedFixture | undefined;
  let spec: AcceptanceVerifierSession | undefined;
  let verifier: AcceptanceVerifierSession | undefined;
  let specReview: string;
  let verdict: AcceptVerdict;
  let execution: AcceptanceExecution | undefined;
  const output: string[] = [];
  let preworkProposal: string | undefined;
  let preworkSource: ReturnType<typeof preworkSpecificationSource> | undefined;
  const checkSession = (session: AcceptanceVerifierSession, phase: "spec" | "verify"): void => {
    if (!prepared) return;
    if (!session.workspaceRoot || resolve(session.workspaceRoot) !== prepared.root) {
      throw new FixturePreparationError("acceptance_workspace_mismatch");
    }
    if (session.noProcessTools) {
      if (phase !== "spec" || session.childEnv !== undefined) throw new FixturePreparationError("managed_execution_requires_sandbox");
      prepared.assertIntegrity();
      return;
    }
    if (!session.childEnv) throw new FixturePreparationError("acceptance_child_environment_required");
    assertPreparedFixtureEnvironment(prepared, session.childEnv);
  };
  const closeSession = async (session: AcceptanceVerifierSession): Promise<void> => {
    try { await session.close(); }
    catch (error) {
      if (prepared) throw new FixturePreparationError("acceptance_session_cleanup_failed");
      throw error;
    }
    prepared?.assertIntegrity();
  };

  try {
    const contract = input.workspaceRoot ? readAcceptanceContract(input.parentLog, resolve(input.workspaceRoot)) : undefined;
    preworkProposal = contract?.origin?.proposal_ref;
    if (preworkProposal) preworkSource = preworkSpecificationSource(input.parentLog, preworkProposal);
    if (contract) assertAcceptanceContract(input.parentLog, contract, input.order);
    const deliveredBefore = contract ? acceptanceCandidate(input.parentLog, contract.workspace,
      // The fixture manifest is authenticated again by preparation below.
      readFixtureExcludedRoots(input.parentLog, contract.workspace)).digest : undefined;
    // Legacy factories without a workspace remain valid only without enrolled authority.
    if (!input.workspaceRoot && input.parentLog.events.some(event => event.name === "fixture/enrolled")) {
      throw new FixturePreparationError("acceptance_workspace_required");
    }
    const preparation = prepareFixture({
      log: input.parentLog,
      workspace: input.workspaceRoot ?? process.cwd(),
      command: ACCEPTANCE_FIXTURE_COMMAND,
      visibility: "visible",
    });
    if (preparation.status === "evaluator_error") throw preparation.error;
    if (preparation.status === "prepared") prepared = preparation;
    if (!contract) {
      prepared?.close();
      return unavailableAcceptance(input.parentLog, "required_inventory_missing", input.print);
    }
    if (contract && !prepared) throw new FixturePreparationError("acceptance_snapshot_required");
    const evaluatedBefore = contract && prepared ? acceptanceCandidate(input.parentLog, prepared.root).digest : undefined;
    const sessionOptions = { workspaceRoot: preparation.root, ...(prepared ? { preparedFixture: prepared } : {}) };
    try {
      input.parentLog.append({
        kind: "observe",
        name: "work/step",
        payload: {
          action: "accept",
          wave: input.wave,
          agent: "dokkabi",
          ...(preworkProposal ? { specification_source: "prework_design", proposal_ref: preworkProposal } : { spec_session: specSessionId }),
          verifier_session: verifierSessionId,
          route: input.route ?? "inherited",
          ...(prepared ? { preparation_ref: prepared.receiptDigest } : {}),
        },
      });

      if (preworkProposal) {
        specReview = preworkAcceptanceSpecification(contract);
      } else {
        spec = await input.openSpecSession(specSessionId, { ...sessionOptions, phase: "spec" });
        try {
          checkSession(spec, "spec");
          specReview = await acceptanceSpecTurn({
            log: spec.log,
            loop: spec.loop,
            order: input.order,
            modelId: input.modelId,
            thinkingLevel: input.thinkingLevel,
            contract,
          });
        } finally {
          await closeSession(spec);
        }
      }

      verifier = await input.openSession(verifierSessionId, { ...sessionOptions, phase: "verify" });
      try {
        checkSession(verifier, "verify");
        if (contract && prepared) {
          try { execution = beginAcceptanceExecution({ parentLog: input.parentLog, log: verifier.log, prepared, contract,
            specification: specReview, executor: verifier.acceptanceProbes,
            expectedCandidate: { delivered: deliveredBefore!, evaluated: evaluatedBefore! } }); }
          catch { throw new FixturePreparationError("acceptance_candidate_or_contract_changed"); }
        }
        verdict = await acceptTurn({
          log: verifier.log,
          loop: verifier.loop,
          order: input.order,
          modelId: input.modelId,
          thinkingLevel: input.thinkingLevel,
          remainingMs: input.remainingMs,
          print: text => { output.push(text); },
          narrate: input.narrate,
          ledger: input.ledger,
          specReview,
          execution,
        });
      } finally {
        await closeSession(verifier);
      }
    } finally {
      try {
        if (execution) {
          try { closeAcceptanceSnapshot(execution); }
          catch { throw new FixturePreparationError("acceptance_candidate_or_contract_changed"); }
        }
      } finally { prepared?.close(); }
    }
  } catch (error) {
    if (error instanceof FixturePreparationError) {
      const payload = {
        decision: "evaluator_error",
        reason_code: error.code,
        wave: input.wave,
        ...(preworkProposal ? { specification_source: "prework_design", proposal_ref: preworkProposal } : { spec_session: specSessionId }),
        verifier_session: verifierSessionId,
        ...(prepared ? { preparation_ref: prepared.receiptDigest } : {}),
      };
      // A model's earlier DONE is provisional until snapshot integrity and cleanup pass.
      if (verifier) verifier.log.append({ kind: "observe", name: "work/accept", payload });
      input.parentLog.append({ kind: "observe", name: "work/accept", payload });
    }
    throw error;
  }

  if (execution) {
    const decision = finishAcceptanceExecution(execution);
    if (decision.status === "inconclusive") {
      // A completed final verdict stays provisional while integrity rechecks run.
      verdict = { ...verdict, accepted: false, inconclusive: true, confirmationComplete: undefined,
        speech: `Acceptance is inconclusive: ${decision.reason}.` };
      output.length = 0; output.push(verdict.speech);
    }
    if (verdict.accepted) bindAcceptanceDelivery(verdict, execution);
  }

  const specDigest = spec ? replayDigest(replayContract(spec.log.events, readEvidenceBodies(spec.log))) : undefined;
  const verifierDigest = replayDigest(replayContract(verifier.log.events, readEvidenceBodies(verifier.log)));
  input.parentLog.appendBatchDurable(() => {
    if (verdict.accepted && !acceptanceDeliveryCurrent(verdict)) {
      verdict = { ...verdict, accepted: false, inconclusive: true, confirmationComplete: undefined,
        speech: "Acceptance is inconclusive: the candidate or required specification changed before delivery." };
      output.length = 0; output.push(verdict.speech);
    }
    // Only the parent may close confirmation, after snapshot cleanup and the
    // current delivery check under this durable append lock. The child's
    // complete no-tools verdict alone carries no delivery authority.
    if (execution && verdict.accepted && verdict.verdictTurnUsed) {
      verdict = { ...verdict, confirmationComplete: true };
      bindAcceptanceDelivery(verdict, execution);
    }
    return [{
    kind: "observe",
    name: "work/accept",
    payload: {
      decision: verdict.accepted ? "done" : verdict.inconclusive ? "inconclusive" : "not_done",
      marker: verdict.marker,
      ...(verdict.toolBudgetExhausted ? { tool_budget_exhausted: true } : {}),
      ...(verdict.turnBudgetExhausted ? { turn_budget_exhausted: true } : {}),
      ...(verdict.verdictTurnUsed ? { verdict_turn: true } : {}),
      ...(verdict.accepted ? { confirmation_complete: verdict.confirmationComplete === true } : {}),
      ...(verdict.reason ? { reason_code: verdict.reason } : {}),
      wave: input.wave,
      ...(spec ? { spec_session: spec.sessionId, spec_digest: specDigest, spec_log_hash: spec.log.lastHash }
        : { ...preworkSource, specification_source: "prework_design", proposal_ref: preworkProposal }),
      verifier_session: verifier.sessionId,
      verifier_digest: verifierDigest,
      verifier_log_hash: verifier.log.lastHash,
      ...(input.ledger ? { ledger: true } : {}),
      ...(prepared ? { preparation_ref: prepared.receiptDigest } : {}),
    },
    }];
  });
  for (const text of output) input.print(text);
  return verdict;
}

/** Ordinary completion reviews semantic gaps once against authenticated current
 * work evidence. It is explicitly workspace-reported, not an independent score. */
async function runWorkReview(input: RunAcceptanceVerifierInput): Promise<AcceptVerdict> {
  const cwd = input.workspaceRoot!;
  let evidence: ReturnType<typeof captureWorkReviewEvidence>;
  try { evidence = captureWorkReviewEvidence(input.parentLog, cwd, input.order); }
  catch (error) { return unavailableAcceptance(input.parentLog, error instanceof Error ? error.message : String(error), input.print); }
  const sessionId = `${input.parentSessionId}-accept-${input.wave}-${input.nonce?.() ?? Date.now().toString(36)}`;
  input.parentLog.append({ kind: "observe", name: "work/step", payload: {
    action: "accept", mode: "workspace_cases_and_review", wave: input.wave, verifier_session: sessionId,
  } });
  const session = await input.openSession(sessionId, { workspaceRoot: cwd, phase: "verify" });
  const startSeq = session.log.lastSeq;
  let reply: string;
  let finalized: Awaited<ReturnType<typeof finalizeBudgetedReview>>;
  try {
    if (resolve(session.workspaceRoot ?? "") !== resolve(cwd)) throw new FixturePreparationError("acceptance_workspace_mismatch");
    const thinkingLevel = acceptanceThinkingLevel(input.thinkingLevel ?? resolveThinkingLevel());
    const remainingMs = remainingReviewTime(input.remainingMs);
    reply = remainingMs === 0 ? "" : await streamFinalChunk(session.loop, renderPrompt("work/accept-work.md", {
      order: input.order, plan: canonicalJson(projectObligations(input.parentLog.events).current!.plan),
      evidence: canonicalJson(evidence), ledger: input.ledger ?? "No additional ledger.",
    }), { providerRole: "review", modelId: input.modelId, thinkingLevel,
      maxToolCalls: 8, timeoutMs: remainingMs, timeoutPolicy: "continue" });
    finalized = await finalizeBudgetedReview({ log: session.log, loop: session.loop, afterSeq: startSeq, reply,
      modelId: input.modelId, thinkingLevel, remainingMs: input.remainingMs,
      verdictPrompt: renderPrompt("work/accept-work-verdict.md", { order: input.order }),
    });
    reply = finalized.reply;
  } finally { await session.close(); }
  const parsed = parseAcceptDecision(reply);
  const { toolBudgetExhausted, turnBudgetExhausted, verdictTurnUsed, verdictIncomplete, verdictReason } = finalized;
  let verdict: AcceptVerdict = { speech: verdictIncomplete ? `Completion is inconclusive: the final review response is incomplete (${verdictReason}).` : parsed.speech,
    accepted: parsed.kind === "done" && !verdictIncomplete,
    inconclusive: verdictIncomplete || parsed.kind === "unknown" || parsed.kind === "inconclusive", marker: parsed.kind !== "unknown",
    toolBudgetExhausted, turnBudgetExhausted, verdictTurnUsed, retryable: false,
    ...(verdictReason ? { reason: verdictReason } : {}),
    ...(verdictTurnUsed && !verdictIncomplete && parsed.kind === "done" ? { confirmationComplete: true } : {}) };
  if (verdict.accepted) {
    bindWorkReviewDelivery(verdict, { log: input.parentLog, cwd, order: input.order, evidence });
    if (!acceptanceDeliveryCurrent(verdict)) {
      verdict = { ...verdict, accepted: false, inconclusive: true, speech: "Completion refused: work execution inputs changed during review." };
    }
  }
  input.parentLog.append({ kind: "observe", name: "work/accept", payload: {
    mode: "workspace_cases_and_review", evidence_level: "workspace_reported", workspace: cwd, order: input.order,
    decision: verdict.accepted ? "done" : verdict.inconclusive ? "inconclusive" : "not_done",
    wave: input.wave, review: reply, work_evidence: evidence, verifier_session: session.sessionId,
    tool_budget_exhausted: toolBudgetExhausted, turn_budget_exhausted: turnBudgetExhausted,
    verdict_turn: verdictTurnUsed, verdict_incomplete: verdictIncomplete,
    ...(verdictReason ? { reason_code: verdictReason } : {}),
    confirmation_complete: verdict.confirmationComplete === true,
    verifier_digest: replayDigest(replayContract(session.log.events, readEvidenceBodies(session.log))), verifier_log_hash: session.log.lastHash,
  } });
  if (verdict.speech) input.print(verdict.speech);
  return verdict;
}

function readFixtureExcludedRoots(log: EventLog, workspace: string): readonly string[] {
  return readFixtureEnrollment(log, workspace)?.manifest.excluded_candidate_roots ?? [];
}
