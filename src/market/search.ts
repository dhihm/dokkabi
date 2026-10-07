import type { EventLog } from "../host/event-log.ts";
import { sumCosts, type TrialCost } from "./cost.ts";

/**
 * 돗가비 장터 search campaign (#60 phase 1): an OFFLINE, exhaustive walk
 * over a small space of SEALED recipe points. The operator names every
 * point explicitly (which is how campaign presets stay on free routes —
 * a paid route enters the space only by being written into a sealed
 * recipe), the budget filter removes a point BEFORE any evaluation when
 * its structural floor already exceeds the call budget, an over-budget
 * point stops mid-flight and cannot win, and the winner needs a minimum
 * number of evaluated instances plus one holdout validation. No Bayesian
 * optimization, no live runtime search (constitution 5: replay projects
 * search/trial|select|holdout records, it never re-searches).
 */

export interface SearchPoint {
  readonly id: string;
  readonly digest: string;
  /** The recipe's #59 sample budget — the structural cost floor per row. */
  readonly k: number;
}

export interface SearchRow {
  readonly instance_id: string;
}

export interface SearchTrial {
  readonly point: SearchPoint;
  /** Instances actually evaluated (the trial count for the min rule). */
  readonly instances: number;
  readonly resolved: number;
  readonly resolvedByInstance: readonly { instance: string; resolved: boolean }[];
  readonly coverage: number;
  readonly cost: TrialCost;
  /** −Infinity for any non-scored status — selection-only; the log record
   * omits objective entirely for those (JSON has no −Infinity, and a
   * silent null is not a chosen value — PR #93 review M2). */
  readonly objective: number;
  readonly status: "scored" | "budget_filtered" | "over_budget" | "quota_stopped";
}

export interface SearchHoldout {
  readonly winner: string;
  /** Instances actually evaluated — never the intended slice size. */
  readonly instances: number;
  readonly resolved: number;
  readonly coverage: number;
  readonly cost: TrialCost;
  /** Present when the validation was cut short (quota). */
  readonly stop?: "quota_exhausted";
}

export interface SearchOutcome {
  readonly trials: SearchTrial[];
  readonly winner?: SearchTrial;
  readonly holdout?: SearchHoldout;
  readonly stop: "done" | "quota_exhausted";
}

export interface TrialRun {
  readonly resolved: boolean;
  readonly cost: TrialCost;
  /** The run hit a free-route quota stop — the campaign fails closed. */
  readonly quotaStopped: boolean;
}

export interface RunTrialContext {
  readonly point: SearchPoint;
  readonly row: SearchRow;
  readonly phase: "dev" | "holdout";
}

/**
 * The objective the selection maximizes: coverage minus λ times model
 * calls PER INSTANCE (Archon's Performance − λ·Cost, with the RFC's call
 * count as the cost unit). λ and the budget are recorded on search/select
 * so the choice is auditable, never re-derived.
 */
export function searchObjective(
  coverage: number,
  cost: TrialCost,
  instances: number,
  lambda: number,
): number {
  if (instances <= 0) return Number.NEGATIVE_INFINITY;
  return coverage - lambda * (cost.calls / instances);
}

/** Structural floor: one model call per sample. instances × k over the
 * budget means the point cannot be evaluated honestly — remove it from
 * the space before spending anything (RFC: 예산을 넘는 점은 평가되지 않는다). */
export function budgetFiltered(point: SearchPoint, instances: number, budgetCalls: number): boolean {
  return instances * point.k > budgetCalls;
}

/** The winner: best objective among fully-scored trials with at least
 * minInstances evaluated; ties break toward fewer calls. A trial that was
 * filtered, stopped over budget, or starved of instances cannot win. */
export function selectWinner(
  trials: readonly SearchTrial[],
  minInstances: number,
): { winner?: SearchTrial; eligible: number } {
  const eligible = trials.filter(
    (trial) => trial.status === "scored" && trial.instances >= minInstances,
  );
  let winner: SearchTrial | undefined;
  for (const trial of eligible) {
    if (
      !winner ||
      trial.objective > winner.objective ||
      (trial.objective === winner.objective && trial.cost.calls < winner.cost.calls)
    ) {
      winner = trial;
    }
  }
  return { ...(winner ? { winner } : {}), eligible: eligible.length };
}

function recordTrial(log: EventLog, trial: SearchTrial): void {
  log.append({
    kind: "observe",
    name: "search/trial",
    payload: {
      recipe_id: trial.point.id,
      recipe_digest: trial.point.digest,
      status: trial.status,
      instances: trial.instances,
      resolved: trial.resolved,
      resolved_by_instance: trial.resolvedByInstance.map((entry) => ({ ...entry })),
      coverage: trial.coverage,
      // Only a fully-scored trial carries an objective on the log.
      ...(trial.status === "scored" ? { objective: trial.objective } : {}),
      cost: { ...trial.cost },
    },
  });
}

/**
 * Everything a campaign refuses BEFORE spending (PR #93 review M6 +
 * minors): a dev slice smaller than the min-instances rule can never
 * select and would burn the whole budget; duplicate points or instances
 * would share work slugs and clobber each other's cost ledgers; a holdout
 * overlapping dev validates nothing.
 */
export function validateCampaignInputs(input: {
  recipeIds: readonly string[];
  rows: readonly SearchRow[];
  holdoutRows?: readonly SearchRow[];
  minInstances: number;
}): void {
  if (new Set(input.recipeIds).size !== input.recipeIds.length) {
    throw new Error("duplicate --recipe ids in the campaign space");
  }
  const devIds = input.rows.map((row) => row.instance_id);
  if (new Set(devIds).size !== devIds.length) {
    throw new Error("duplicate instance ids in the dev slice");
  }
  if (input.rows.length < input.minInstances) {
    throw new Error(
      `dev slice has ${input.rows.length} instances but --min-instances is ${input.minInstances} — nothing could ever win`,
    );
  }
  if (input.holdoutRows) {
    const holdoutIds = input.holdoutRows.map((row) => row.instance_id);
    if (new Set(holdoutIds).size !== holdoutIds.length) {
      throw new Error("duplicate instance ids in the holdout slice");
    }
    const dev = new Set(devIds);
    const overlap = holdoutIds.filter((id) => dev.has(id));
    if (overlap.length > 0) {
      throw new Error(`holdout overlaps the dev slice: ${overlap.join(", ")}`);
    }
  }
}

export async function runSearchCampaign(input: {
  points: readonly SearchPoint[];
  rows: readonly SearchRow[];
  holdoutRows?: readonly SearchRow[];
  /** Hard per-point ceiling on model calls. */
  budgetCalls: number;
  lambda: number;
  /** Below this many evaluated instances a point cannot win. */
  minInstances: number;
  log: EventLog;
  runTrial(context: RunTrialContext): Promise<TrialRun> | TrialRun;
  say?(line: string): void;
}): Promise<SearchOutcome> {
  const say = input.say ?? (() => undefined);
  const trials: SearchTrial[] = [];
  let stop: SearchOutcome["stop"] = "done";
  for (const point of input.points) {
    if (budgetFiltered(point, input.rows.length, input.budgetCalls)) {
      // No silent caps: the removed point is on the log with its reason.
      const filtered: SearchTrial = {
        point,
        instances: 0,
        resolved: 0,
        resolvedByInstance: [],
        coverage: 0,
        cost: sumCosts([]),
        objective: Number.NEGATIVE_INFINITY,
        status: "budget_filtered",
      };
      trials.push(filtered);
      recordTrial(input.log, filtered);
      say(`filtered ${point.id}: ${input.rows.length}×k=${point.k} exceeds budget ${input.budgetCalls}`);
      continue;
    }
    const perInstance: { instance: string; resolved: boolean }[] = [];
    const costs: TrialCost[] = [];
    let status: SearchTrial["status"] = "scored";
    for (const row of input.rows) {
      say(`trial ${point.id} on ${row.instance_id}`);
      const run = await input.runTrial({ point, row, phase: "dev" });
      costs.push(run.cost);
      perInstance.push({ instance: row.instance_id, resolved: run.resolved });
      if (run.quotaStopped) {
        // An aborted trial is not a scored trial (PR #93 review M1).
        stop = "quota_exhausted";
        status = "quota_stopped";
        break;
      }
      if (sumCosts(costs).calls > input.budgetCalls) {
        status = "over_budget";
        say(`over budget: ${point.id} stopped after ${perInstance.length} instances`);
        break;
      }
    }
    const cost = sumCosts(costs);
    const resolved = perInstance.filter((entry) => entry.resolved).length;
    const coverage = perInstance.length > 0 ? resolved / perInstance.length : 0;
    const trial: SearchTrial = {
      point,
      instances: perInstance.length,
      resolved,
      resolvedByInstance: perInstance,
      coverage,
      cost,
      objective: status === "scored"
        ? searchObjective(coverage, cost, perInstance.length, input.lambda)
        : Number.NEGATIVE_INFINITY,
      status,
    };
    trials.push(trial);
    recordTrial(input.log, trial);
    if (stop === "quota_exhausted") break;
  }

  const selection = stop === "quota_exhausted" ? { eligible: 0 } : selectWinner(trials, input.minInstances);
  const winner = "winner" in selection ? selection.winner : undefined;

  let holdout: SearchHoldout | undefined;
  if (winner && input.holdoutRows && input.holdoutRows.length > 0) {
    const holdoutCosts: TrialCost[] = [];
    let holdoutResolved = 0;
    let evaluated = 0;
    let holdoutStop: "quota_exhausted" | undefined;
    for (const row of input.holdoutRows) {
      say(`holdout ${winner.point.id} on ${row.instance_id}`);
      const run = await input.runTrial({ point: winner.point, row, phase: "holdout" });
      holdoutCosts.push(run.cost);
      evaluated += 1;
      if (run.resolved) holdoutResolved += 1;
      if (run.quotaStopped) {
        // A quota verdict is a quota verdict in every phase (PR #93 review
        // H1): the record counts only what ran, and the campaign says so.
        holdoutStop = "quota_exhausted";
        stop = "quota_exhausted";
        break;
      }
    }
    holdout = {
      winner: winner.point.id,
      instances: evaluated,
      resolved: holdoutResolved,
      coverage: evaluated > 0 ? holdoutResolved / evaluated : 0,
      cost: sumCosts(holdoutCosts),
      ...(holdoutStop ? { stop: holdoutStop } : {}),
    };
    input.log.append({
      kind: "observe",
      name: "search/holdout",
      payload: {
        winner: holdout.winner,
        recipe_digest: winner.point.digest,
        instances: holdout.instances,
        resolved: holdout.resolved,
        coverage: holdout.coverage,
        cost: { ...holdout.cost },
        ...(holdoutStop ? { stop: holdoutStop } : {}),
      },
    });
  }

  input.log.append({
    kind: "observe",
    name: "search/select",
    payload: {
      ...(winner ? { winner: winner.point.id, winner_digest: winner.point.digest } : {}),
      eligible: selection.eligible,
      trials: trials.length,
      lambda: input.lambda,
      budget_calls: input.budgetCalls,
      min_instances: input.minInstances,
      ...(stop === "quota_exhausted" ? { stop } : {}),
    },
  });
  return { trials, ...(winner ? { winner } : {}), ...(holdout ? { holdout } : {}), stop };
}
