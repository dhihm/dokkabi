import { isRecoveryTerminalError } from "../host/recovery.ts";
import type { RecoveryChildInput } from "./recovery-child.ts";
import { readEvidenceBodies } from "./evidence/bodies.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { EventLog } from "../host/event-log.ts";
import { assertNoSecrets, redactText } from "../host/redact.ts";
import { replayContract, replayDigest } from "../host/replay.ts";
import type { ArtifactContributionRegistry } from "../loader/types.ts";
import { toolScopeForTodo } from "../loader/tool-profiles.ts";
import { captureInPlaceDelta, captureWorktreeSnapshot } from "../swarm/worktree.ts";
import { buildStepInput, relativeFiles } from "./artifacts/build.ts";
import { renderStepInput, type PatchDiffV1 } from "./artifacts/step.ts";
import type { GateRegistry } from "./gate/registry.ts";
import { withWorkPhase } from "./phase.ts";
import { appendSemanticAttemptPatch } from "./semantic-patch.ts";
import type { WorkPlan } from "./schema.ts";
import { openWorkStep, workStepSessionId } from "./step-session.ts";
import { summariseStepUsage, type StepUsageSummary } from "./step-usage.ts";

/**
 * One implement step, isolated (#77 v1).
 *
 * The shape is the whole point:
 *   host assembles the slot → records it → step runs in a FRESH session on
 *   that slot alone → host captures the delta as a typed artifact → a GATE
 *   decides whether the step counted.
 *
 * Nothing here branches on an artifact type: the loop names a kind, the
 * registry knows what that means, and the gate registry decides the verdict
 * (constitution 7). Every stage is a recorded row (6), and the slot is on
 * the log before the model sees it (1).
 *
 * Every failure inside this function is a RECORDED REFUSAL, never a throw.
 * The drive loop does not catch around `hooks.implement`, so an escaping
 * error kills the whole wave — and the first review of this code found three
 * ordinary inputs (a workspace outside a git root, an oversized diff, an
 * unregistered artifact kind) that each did exactly that.
 */

/** What the parent can prove about the session that ran the step. Mirrors
 * `swarm/child_close`: digests and hashes, never the child's transcript. */
export interface StepEvidence {
  readonly session: string;
  readonly finalHash: string;
  readonly replayDigest: string;
  /** What the step cost, summed from the child log. Record-only. */
  readonly usage?: StepUsageSummary;
}

export interface IsolatedStepInput {
  readonly log: EventLog;
  readonly plan: WorkPlan;
  readonly todo: string;
  readonly wave: number;
  readonly workspaceRoot: string;
  readonly artifacts: ArtifactContributionRegistry;
  readonly gates: GateRegistry;
  /** Test seam. Production opens a fresh session and prompts it. */
  readonly runStep?: (input: { prompt: string; stepId: string }) => Promise<StepEvidence | void>;
  /** Folds mid-run operator notes into the prompt the step is given. Without
   * it a dashboard note written during an implement wave is never read and
   * never recorded. */
  readonly wrapPrompt?: (prompt: string) => { text: string; commit(): void; rollback(): void };
  /** The loop's transient-failure policy. A 429 must not become a permanent
   * refusal just because this path bypassed the retry the other one has. */
  readonly runTurn?: (call: () => Promise<void>) => Promise<void>;
  readonly repoRoot?: string;
  readonly parentSessionId?: string;
  readonly route?: string;
  readonly modelId?: string;
  readonly effort?: ThinkingLevel;
  readonly recovery?: RecoveryChildInput;
}

/** The capability the work loop asks for. Provided only when the mesh plugin
 * loaded AND a gate seam exists to judge with — a step nothing can judge is
 * not a step this host runs. */
export interface IsolatedStepRunner {
  run(input: Omit<IsolatedStepInput, "artifacts" | "gates" | "log">): Promise<boolean>;
}

function refuse(log: EventLog, stepId: string, todo: string, error: unknown): false {
  log.append({
    kind: "observe",
    name: "work/step_refused",
    payload: {
      step_id: stepId,
      todo,
      error: redactText(error instanceof Error ? error.message : String(error)).slice(0, 400),
    },
  });
  return false;
}

/**
 * A step id must be unique across RUNS, not just across waves.
 *
 * The parent session id is a pure hash of the workspace path and the wave
 * counter restarts at 0 in every process, so `<parent>-step-<step>-1` repeats
 * on every rerun in the same directory — and `EventLog.create` opens an
 * existing file. The step would then prompt on the previous run's transcript,
 * which is precisely what a fresh session exists to prevent. The parent log's
 * current sequence is monotone across reruns of the same session and is
 * itself a recorded position, so it dates the step without reading a clock.
 */
function stepRunToken(log: EventLog): number {
  return log.events.at(-1)?.seq ?? 0;
}

export async function runIsolatedImplementStep(input: IsolatedStepInput): Promise<boolean> {
  const fallbackId = `implement-${input.todo}-${input.wave}`;
  let slot;
  try {
    slot = buildStepInput({
      plan: input.plan,
      todoId: input.todo,
      events: input.log.events,
      workspaceRoot: input.workspaceRoot,
      wave: input.wave,
    });
  } catch (error) {
    return refuse(input.log, fallbackId, input.todo, error);
  }

  const stepSessionId = input.parentSessionId
    ? `${workStepSessionId(input.parentSessionId, slot.step_id)}-${stepRunToken(input.log)}`
    : slot.step_id;

  let base;
  try {
    // Constitution 1: what the model will see is on the log before it sees it.
    input.artifacts.record({
      kind: "step_input_v1",
      body: slot,
      name: "work/step_input",
      payload: { step_id: slot.step_id, todo: input.todo, step_session: stepSessionId },
    });
    base = captureWorktreeSnapshot(input.workspaceRoot);
  } catch (error) {
    return refuse(input.log, slot.step_id, input.todo, error);
  }

  const rendered = renderStepInput(slot);
  const notes = input.wrapPrompt?.(rendered);
  const prompt = notes?.text ?? rendered;
  const runStep = input.runStep ?? (async (): Promise<StepEvidence> => {
    const step = await openWorkStep({
      sessionId: stepSessionId,
      recovery: input.recovery,
      workspaceRoot: input.workspaceRoot,
      repoRoot: input.repoRoot ?? process.cwd(),
      route: input.route ?? "codex",
      ...(input.modelId ? { modelId: input.modelId } : {}),
    });
    try {
      await step.loop.prompt(prompt, {
        ...(input.modelId ? { modelId: input.modelId } : {}),
        ...(input.effort ? { thinkingLevel: input.effort } : {}),
        toolScope: toolScopeForTodo(
          input.plan.todos.find((todo) => todo.id === input.todo) ?? { id: input.todo },
        ),
      });
      return {
        session: step.sessionId,
        finalHash: step.log.events.at(-1)?.hash ?? "missing",
        replayDigest: replayDigest(replayContract(step.log.events, readEvidenceBodies(step.log))),
        usage: summariseStepUsage(step.log.events),
      };
    } finally {
      // bootSession handed us the whole runtime; disposing it is the only
      // thing that stops this step's samplers and its bash job runtime.
      await step.close().catch(() => undefined);
    }
  });

  let evidence: StepEvidence | undefined;
  try {
    await withWorkPhase(input.log, "implement", `step ${slot.step_id}`, async () => {
      const call = async (): Promise<void> => {
        evidence = (await runStep({ prompt, stepId: slot.step_id })) ?? undefined;
      };
      // The retry policy belongs to the loop, not to this function: a
      // transient provider failure is waited out exactly as the transcript
      // path waits it out.
      await (input.runTurn ? input.runTurn(call) : call());
    });
  } catch (error) {
    // The notes never reached the model; put them back rather than destroying
    // instructions the operator cannot retype.
    notes?.rollback();
    if (isRecoveryTerminalError(error)) throw error;
    return refuse(input.log, slot.step_id, input.todo, error);
  }
  notes?.commit();

  try {
    // The parent's binding to the session that did the work. Its own name,
    // not `work/step`: that row is the drive loop's action ledger and several
    // projections read its `action` field.
    input.log.append({
      kind: "observe",
      name: "work/step_session",
      payload: {
        step_id: slot.step_id,
        todo: input.todo,
        child_session: evidence?.session ?? stepSessionId,
        final_hash: evidence?.finalHash ?? "missing",
        replay_digest: evidence?.replayDigest ?? "missing",
      },
    });
    if (evidence?.usage) {
      // Its own row rather than fields on the binding: cost is an observation
      // about the step, and folding it in would make a step with no usage
      // look like a step with none recorded.
      input.log.append({
        kind: "observe",
        name: "work/step_usage",
        payload: {
          step_id: slot.step_id,
          todo: input.todo,
          child_session: evidence.session,
          ...evidence.usage,
        },
      });
    }
  } catch (error) {
    return refuse(input.log, slot.step_id, input.todo, error);
  }

  let recorded;
  try {
    // Refuses a step that COMMITTED: committing moves the base the whole run
    // is measured against, so it is a refusal, not a diff.
    const delta = captureInPlaceDelta(base, input.workspaceRoot);
    // BlobStore runs no secret scanner, and a diff carries the full added
    // content of every new file. EventLog.append would refuse these bytes on
    // a payload; a blob must not be the way around that.
    assertNoSecrets(delta.patch);
    appendSemanticAttemptPatch({
      log: input.log,
      plan: input.plan,
      todo: input.todo,
      cases: slot.cases.map((item) => item.id),
      patch: delta.patch,
      patchDigest: delta.patchDigest,
      files: relativeFiles(delta.patch, input.workspaceRoot),
      stepId: slot.step_id,
    });
    const diff: PatchDiffV1 = {
      format: 1,
      step_id: slot.step_id,
      patch_digest: delta.patchDigest,
      base_tree: base.tree,
      final_tree: delta.finalTree,
      files: relativeFiles(delta.patch, input.workspaceRoot),
    };
    recorded = input.artifacts.record({
      kind: "patch_diff_v1",
      body: diff,
      name: "work/step_patch",
      payload: { step_id: diff.step_id, todo: input.todo, files_count: diff.files.length },
      // The diff text rides as payload.source_blob or the GC deletes it.
      source: delta.patch,
    });
  } catch (error) {
    return refuse(input.log, slot.step_id, input.todo, error);
  }

  try {
    const verdict = await input.gates.run({
      stepId: slot.step_id,
      workspaceRoot: input.workspaceRoot,
      artifact: recorded,
    });
    return verdict.status === "pass";
  } catch (error) {
    return refuse(input.log, slot.step_id, input.todo, error);
  }
}
