import type { EventLog } from "../host/event-log.ts";
import type { WorkPlan } from "./schema.ts";
import { readDecomposedPlan } from "./graph.ts";
import { writeWorkPlan } from "./decompose.ts";
import { buildAcceptanceReplanPrompt } from "./prompt.ts";
import { decomposeRetryState, planningArtifactFingerprint, takeDecomposeRetry } from "./decompose-retry.ts";
import { withWorkPhase } from "./phase.ts";
import { assertPlanAuthority, materializeOperatorPlan, modelGuardErrors, planAuthorityInputs, recordAuthorityRefusal, WorkAuthorityError } from "./evidence/authority.ts";
import { projectObligations } from "./evidence/obligations.ts";
import { captureTrackedChanges, reviewTrackedPlanningChanges } from "./verify.ts";
import { checkerFollowupInput } from "./evidence/checker-revision.ts";

export type AcceptanceFollowupResult =
  | { status: "ready"; plan: WorkPlan; attempts: number }
  | { status: "refused"; errors: string[]; attempts: number };

/** Planning owns no implementation authority. A refused proposal must finish a
 * bounded repair transaction before the caller can resume work. */
export async function prepareAcceptanceFollowup(input: {
  log: EventLog;
  workspaceRoot: string;
  planPath: string;
  plan: WorkPlan;
  order: string;
  gaps: string;
  wave: number;
  parentAuthority: { digest: string; scope_seq: number } | undefined;
  maxRetries: number;
  sweepRunners(): string[];
  propose(prompt: string, retry: boolean): Promise<void>;
}): Promise<AcceptanceFollowupResult> {
  const tracked = captureTrackedChanges(input.workspaceRoot, input.log);
  const retries = decomposeRetryState(input.maxRetries);
  let attempts = 0, errors: string[] = [];
  const parent = input.parentAuthority && { digest: input.parentAuthority.digest, scope_seq: input.parentAuthority.scope_seq };
  const sameParent = () => {
    const current = projectObligations(input.log.events).current;
    return parent !== undefined && current?.digest === parent.digest && current.scope_seq === parent.scope_seq;
  };
  const stop = (reasons: string[]): AcceptanceFollowupResult => {
    input.log.append({ kind: "observe", name: "work/plan_refused", payload: {
      stage: "acceptance_followup", wave: input.wave, attempt: attempts, errors: reasons,
    } });
    input.log.append({ kind: "observe", name: "work/step", payload: {
      action: "accept_replan_stopped", wave: input.wave, attempts, errors: reasons, agent: "dokkabi",
    } });
    return { status: "refused", errors: reasons, attempts };
  };
  input.log.appendBatchDurable(() => {
    const grant = sameParent() && checkerFollowupInput(input.log.events, input.plan);
    return grant ? [grant] : [];
  });
  return withWorkPhase(input.log, "decompose", "acceptance followup planning", async () => {
    do {
      input.log.refresh();
      if (!sameParent()) return stop(["acceptance followup lost its reviewed operator scope or contract"]);
      input.log.append({ kind: "observe", name: "work/step", payload: {
        action: attempts ? "accept_replan_retry" : "accept_replan", wave: input.wave,
        attempt: attempts + 1, agent: "dokkabi", ...(errors.length ? { errors } : {}),
      } });
      // The file may contain a refused proposal. Recover the exact reviewed
      // contract from its retained graph snapshot on every planning turn.
      const admittedPlan = projectObligations(input.log.events).current!.plan;
      await input.propose(buildAcceptanceReplanPrompt({ ...input, plan: admittedPlan, errors }), attempts > 0);
      attempts++;
      input.log.refresh();
      if (!sameParent()) return stop(["acceptance followup lost its reviewed operator scope or contract"]);
      errors = input.sweepRunners();
      try { materializeOperatorPlan(input.log, input.planPath); }
      catch (error) { errors.push(recordAuthorityRefusal(input.log, error)); }
      const loaded = readDecomposedPlan(input.workspaceRoot, undefined, input.planPath);
      errors.push(...loaded.errors, ...reviewTrackedPlanningChanges(input.workspaceRoot, tracked, input.log));
      if (!errors.length) {
        errors.push(...modelGuardErrors(input.log, loaded.plan));
        try { assertPlanAuthority(input.log, loaded.plan); }
        catch (error) { errors.push(recordAuthorityRefusal(input.log, error)); }
      }
      if (!errors.length) {
        // Recheck authority under its durable append lock. No host-authored
        // scaffold or RED-first override can change the admitted proposal.
        let admitted = false;
        input.log.appendBatchDurable(nextSeq => {
          try {
            if (!sameParent()) throw new WorkAuthorityError("acceptance followup lost its reviewed operator scope or contract");
            const records = planAuthorityInputs(input.log.events, loaded.plan, nextSeq);
            admitted = true;
            return records;
          } catch (error) {
            if (!(error instanceof WorkAuthorityError)) throw error;
            // An expected contract refusal is an observation, not an append
            // failure that poisons the log and prevents an honest terminal.
            errors = [error.message];
            return [{ kind: "observe", name: "work/authority_refused", payload: { reason: error.message } }];
          }
        });
        if (!admitted) return stop(errors);
        writeWorkPlan(input.planPath, loaded.plan);
        input.log.append({ kind: "observe", name: "work/step", payload: {
          action: "accept_replan_admitted", wave: input.wave, attempt: attempts, agent: "dokkabi",
        } });
        return { status: "ready", plan: loaded.plan, attempts };
      }
      input.log.append({ kind: "observe", name: "work/plan_refused", payload: {
        stage: "acceptance_followup", wave: input.wave, attempt: attempts, errors,
      } });
    } while (takeDecomposeRetry(retries, errors, planningArtifactFingerprint(input.workspaceRoot)));
    return stop(errors);
  });
}
