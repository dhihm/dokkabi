import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { EventLog } from "../host/event-log.ts";
import type { EventRecord } from "../host/schema.ts";
import { writeWorkPlan } from "./decompose.ts";
import { captureRunnerContracts } from "./evidence/authority.ts";
import { missingObligations, obligationErrors, orderScope, projectObligations, requirementObligations } from "./evidence/obligations.ts";
import { applyOperatorGoal } from "./graph.ts";
import { bindPlan, readPlanFromLog } from "./log.ts";
import { sealedWorkGraph } from "./phase.ts";
import { reviewPortWiring } from "./ports.ts";
import { validateRunnerSpec } from "./runner-spec.ts";
import type { WorkPlan } from "./schema.ts";
import { reviewPlanFiles, validatePlan } from "./validate.ts";
import { preflightPlanRedCases, reviewTrackedPlanningChanges, type TrackedChangeSnapshot } from "./verify.ts";

/**
 * The mechanical seal behind `propose_plan` (interfaces-v2.md §2). The model
 * proposes a work graph; the host runs the checks below in order and returns
 * every finding as located data — `{check, node, fact}`, never prose. When no
 * check fires, the graph seals in the same call: `writeWorkPlan` +
 * `bindPlan` + the phase event v1 appends, so the drive loop sees an
 * identical state (src/cli.ts:2808, :2899; src/work/drive.ts:167).
 *
 * Check order (§2): shape, files, immobility, red, ports, obligations. The
 * static checks are pure and always run. `red` executes, so it runs only
 * when shape/files/immobility/ports/obligations are clean — a RED minted on
 * a broken premise (an unparseable graph, a missing test file, a tree that
 * moved mid-planning) would be evidence of nothing, and a refused proposal
 * would have paid for runs the findings already answer. `obligations` needs
 * a well-formed graph, so it is gated on shape. `red` is not this file's
 * own judgment: the cases run through the host RED preflight, so what seals
 * is exactly what the drive loop's execution-earned policy accepts.
 */

export interface SealFinding {
  readonly check: "shape" | "files" | "immobility" | "red" | "ports" | "obligations";
  readonly node: string;
  readonly fact: string;
}

export type SealResult =
  | { readonly status: "findings"; readonly findings: SealFinding[] }
  | { readonly status: "sealed"; readonly digest: string; readonly plan_path: string };

/** Node naming for the string errors the imported reviews return: they all
 * lead with the node ("case c-1 …", "todo t-2 …", "scenario s-1 …"). */
function errorNode(error: string, fallback: string): string {
  const lead = /^(?:todo|case|scenario)\s+(\S+)/.exec(error);
  if (lead?.[1]) return lead[1];
  // Path-prefix branch: matches the strings reviewTrackedPlanningChanges
  // produces (src/work/verify.ts near :497), which lead with the file path.
  if (error.startsWith("planning changed tracked file ")) {
    return error.slice("planning changed tracked file ".length).split(";")[0]!;
  }
  if (error.startsWith("goal")) return fallback;
  return "plan";
}

function toFindings(check: SealFinding["check"], errors: readonly string[], goalId: string): SealFinding[] {
  return errors.map((fact) => ({ check, node: errorNode(fact, goalId), fact }));
}

/** Preflight refusals become red findings. Each refused case keeps the exit
 * code its own run observed, read from the work/case_preflight row the
 * preflight appended — data the model needs, never a second red rule. */
function preflightFindings(log: EventLog, errors: readonly string[], goalId: string): SealFinding[] {
  return errors.map((fact) => {
    const node = errorNode(fact, goalId);
    const row = node !== goalId && node !== "plan"
      ? [...log.events].reverse().find((event) =>
        event.name === "work/case_preflight" && event.payload.id === node && typeof event.payload.result_seq === "number")
      : undefined;
    const result = row
      ? log.events.find((event) => event.seq === row.payload.result_seq && event.hash === row.payload.result_hash)
      : undefined;
    const exitCode = typeof result?.payload.exit_code === "number" ? result.payload.exit_code : undefined;
    return { check: "red" as const, node, fact: exitCode === undefined ? fact : `${fact} (exit ${exitCode})` };
  });
}

/** The operator order this proposal seals under: the work/goal row opening
 * the current order scope — the pending ask sealOperatorGoal appended — read
 * the way the drive-side authority path reads it (evidence/authority.ts). */
function operatorOrderStatement(events: readonly EventRecord[]): string | undefined {
  const scope = orderScope(events);
  if (scope === undefined) return undefined;
  const row = events.find((event) => event.seq === scope && event.name === "work/goal");
  return typeof row?.payload.statement === "string" ? row.payload.statement : undefined;
}

/** Delta merge: sealed nodes replaced by id, new ids appended. Weakening a
 * replaced node is not merged away — the obligations check names it. */
export function mergePlans(sealed: WorkPlan, delta: WorkPlan): WorkPlan {
  const mergeById = <T extends { readonly id: string }>(base: readonly T[], extra: readonly T[]): T[] => {
    const out = base.map((item) => extra.find((candidate) => candidate.id === item.id) ?? item);
    for (const candidate of extra) {
      if (!base.some((item) => item.id === candidate.id)) out.push(candidate);
    }
    return out;
  };
  return {
    ...sealed,
    goal: delta.goal,
    todos: mergeById(sealed.todos, delta.todos),
    scenarios: mergeById(sealed.scenarios, delta.scenarios),
    cases: mergeById(sealed.cases, delta.cases),
  };
}

export async function sealProposal(input: {
  readonly log: EventLog;
  readonly workspaceRoot: string;
  readonly plan: WorkPlan;
  /** Declarative runner specs carried by the proposal; validated, then
   * persisted under work/runners/ at seal time. */
  readonly runners?: readonly unknown[];
  readonly delta?: boolean;
  /** The sealed graph a delta merges into; falls back to the log's. */
  readonly sealed?: WorkPlan;
  /** Tracked-tree baseline captured when the planning session began. */
  readonly sessionStartRef?: TrackedChangeSnapshot;
}): Promise<SealResult> {
  const { log, workspaceRoot, plan } = input;
  const goalId = typeof plan?.goal?.id === "string" && plan.goal.id ? plan.goal.id : "goal";

  // A delta is a fragment: its references (blocked_by, scenario, ports) reach
  // into the sealed graph, so every check runs on the MERGED graph — which is
  // also what seals (interfaces-v2.md §2: "the sealed plan is the merged graph").
  const sealed = input.delta === true ? input.sealed ?? readPlanFromLog(log.events) : undefined;
  let merged = input.delta === true && sealed ? mergePlans(sealed, plan) : plan;

  // The host sets the goal statement (v2-t20): the operator order, applied
  // with the drive loop's own applyOperatorGoal BEFORE any check runs, so the
  // sealed goal IS the order whatever the model typed — including a
  // paraphrase, re-wrapped whitespace or an omitted statement. The order is
  // an invariant the host holds by construction; making the model reproduce
  // a 7 KB order inside a JSON argument turned it into a copying test
  // (arm A9-M3: ten proposals, nine refused on this clause alone).
  const order = operatorOrderStatement(log.events);
  if (order !== undefined) merged = applyOperatorGoal(merged, order);

  // shape: graph shape, references, cycles, todo→scenario→case presence,
  // plus the runner-spec shape the tool schema accepted as data.
  const shapeErrors = validatePlan(merged);
  for (const [index, raw] of (input.runners ?? []).entries()) {
    const validated = validateRunnerSpec(raw);
    const node = typeof (raw as { id?: unknown })?.id === "string" ? String((raw as { id: string }).id) : `runners[${index}]`;
    shapeErrors.push(...validated.errors.map((error) => `runner ${node}: ${error}`));
  }
  const shape = toFindings("shape", shapeErrors, goalId);

  // files: case test files exist on disk.
  const fileFindings = toFindings("files", reviewPlanFiles(merged, workspaceRoot), goalId);

  // immobility: the tracked tree did not move while planning ran.
  const immobility = toFindings(
    "immobility",
    reviewTrackedPlanningChanges(workspaceRoot, input.sessionStartRef, log),
    goalId,
  );

  // obligations (delta admission): the admitted goal/case obligations survive
  // into the merged graph. Runs whenever an admitted snapshot exists — a
  // non-delta re-proposal over a sealed graph binds the same authority rule.
  const obligations: SealFinding[] = [];
  if (input.delta === true && !sealed) {
    obligations.push({ check: "obligations", node: goalId, fact: "no_sealed_plan" });
  } else if (shapeErrors.length === 0) {
    const runners = captureRunnerContracts(merged);
    const errors = obligationErrors(merged, log.events, runners);
    if (errors.length > 0) {
      // obligationErrors is missingObligations mapped in order; recompute the
      // same list so each finding names its node instead of parsing strings.
      const prior = projectObligations(log.events).current;
      const missing = prior ? missingObligations(requirementObligations(prior.plan, prior.runners), requirementObligations(merged, runners)) : [];
      obligations.push(...errors.map((fact, index) => ({
        check: "obligations" as const,
        node: missing[index]?.alias ?? goalId,
        fact,
      })));
    }
  }

  // ports: only when consumes/produces are declared (reviewPortWiring's rule).
  const ports = toFindings("ports", reviewPortWiring(merged), goalId);

  // red: the drive loop's own baseline qualification — one definition of RED.
  // The cases run through the host RED preflight (preflightPlanRedCases, the
  // same path `dokkabi work` seals through), which executes each case under
  // its native runner adapter and records execution-earned-v1 rows. A case is
  // a baseline only when that policy classifies the failure as qualifying; a
  // bare nonzero exit (a usage error, a test id that does not exist yet) is a
  // finding, so the drive loop's run_baseline can never disagree with what
  // sealed it. The check runs only when every static check is clean — a RED
  // minted on a broken premise would be evidence of nothing, and a refused
  // proposal would have paid for runs the findings already answer.
  const red: SealFinding[] = [];
  let sealGraph = merged;
  if (shape.length === 0 && fileFindings.length === 0 && immobility.length === 0
    && ports.length === 0 && obligations.length === 0) {
    // v1's model-plan normalization (cli.ts sets require_red_first on every
    // generated plan): preflight, seal and drive loop share red-first.
    sealGraph = { ...merged, require_red_first: true } as WorkPlan;
    const preflight = await preflightPlanRedCases({
      log,
      cwd: workspaceRoot,
      plan: sealGraph,
      ...(order !== undefined ? { operatorOrder: order } : {}),
    });
    red.push(...preflightFindings(log, preflight.errors, goalId));
    for (const id of preflight.brokenGuards ?? []) {
      red.push({ check: "red", node: id, fact: "guard_failed" });
    }
  }

  const findings = [...shape, ...fileFindings, ...immobility, ...red, ...ports, ...obligations];
  if (findings.length > 0) {
    return { status: "findings", findings };
  }

  // Seal: runner specs to work/runners/*.json (the sweep registers them),
  // the merged graph to work/current.json, then bindPlan's goal/todo/
  // scenario/case bindings plus the phase transition v1 records.
  if (input.runners && input.runners.length > 0) {
    const runnersDir = resolve(workspaceRoot, "work", "runners");
    mkdirSync(runnersDir, { recursive: true });
    for (const raw of input.runners) {
      const { spec } = validateRunnerSpec(raw);
      if (spec) writeFileSync(resolve(runnersDir, `${spec.id}.json`), `${JSON.stringify(spec, null, 2)}\n`);
    }
  }
  const planPath = resolve(workspaceRoot, "work", "current.json");
  mkdirSync(dirname(planPath), { recursive: true });
  writeWorkPlan(planPath, sealGraph);
  let boundDigest: string;
  try {
    // bindPlan re-checks evidence definitions and authority; a refusal here is
    // data about the proposal, not a crash.
    boundDigest = bindPlan(log, sealGraph).digest;
  } catch (error) {
    return {
      status: "findings",
      findings: [{ check: "shape", node: goalId, fact: error instanceof Error ? error.message : String(error) }],
    };
  }
  sealedWorkGraph(log, []);
  return { status: "sealed", digest: boundDigest, plan_path: planPath };
}
