import { createHash } from "node:crypto";
import { canonicalJson } from "../host/canonical.ts";
import type { EventRecord } from "../host/schema.ts";
import type { Case, Scenario, WorkPlan } from "./schema.ts";
import { workCaseDigest } from "./scope.ts";
import { caseMeasurementSchema } from "./evidence/measurements.ts";

interface SemanticScenarioDefinition {
  readonly id: string;
  readonly todo: string;
  readonly given: string;
  readonly when: string;
  readonly then: string;
}

interface SemanticCaseDefinition {
  readonly id: string;
  readonly scenario: string;
  readonly layer: string;
  readonly command: string;
  readonly red_means: string;
  readonly green_means: string;
  readonly case_digest: string;
}

export interface RecordedSemanticPlanDefinition {
  readonly digest: string;
  readonly cases: ReadonlyMap<string, { readonly todo: string; readonly digest: string }>;
}

export class SemanticPlanDefinitionTracker {
  private readonly scenarios = new Map<string, SemanticScenarioDefinition>();
  private readonly cases = new Map<string, SemanticCaseDefinition>();
  private invalid = false;
  private dirty = true;
  private cached: RecordedSemanticPlanDefinition | undefined;

  reset(): void {
    this.scenarios.clear();
    this.cases.clear();
    this.invalid = false;
    this.dirty = true;
    this.cached = undefined;
  }

  push(event: EventRecord): void {
    if (event.name === "work/scenario") {
      const definition = scenarioFromEvent(event);
      if (!definition || this.scenarios.has(definition.id)) this.invalid = true;
      else this.scenarios.set(definition.id, definition);
      this.dirty = true;
      return;
    }
    if (event.name !== "work/case"
      || event.payload.status === "red" || event.payload.status === "green") return;
    const definition = caseFromEvent(event, this.scenarios);
    if (!definition || this.cases.has(definition.id)) this.invalid = true;
    else this.cases.set(definition.id, definition);
    this.dirty = true;
  }

  snapshot(): RecordedSemanticPlanDefinition | undefined {
    if (!this.dirty) return this.cached;
    this.dirty = false;
    this.cached = undefined;
    if (this.invalid || this.scenarios.size === 0 || this.cases.size === 0) return undefined;
    const ownership = new Map<string, { readonly todo: string; readonly digest: string }>();
    for (const item of this.cases.values()) {
      const scenario = this.scenarios.get(item.scenario);
      if (!scenario) return undefined;
      ownership.set(item.id, { todo: scenario.todo, digest: item.case_digest });
    }
    this.cached = {
      digest: digestDefinitions([...this.scenarios.values()], [...this.cases.values()]),
      cases: ownership,
    };
    return this.cached;
  }
}

function digestDefinitions(
  scenarios: readonly SemanticScenarioDefinition[],
  cases: readonly SemanticCaseDefinition[],
): string {
  return createHash("sha256").update(canonicalJson({ scenarios, cases })).digest("hex");
}

function scenarioDefinition(scenario: Scenario): SemanticScenarioDefinition {
  return {
    id: scenario.id,
    todo: scenario.todo,
    given: scenario.given,
    when: scenario.when,
    then: scenario.then,
  };
}

function caseDefinition(item: Case, scenario: Scenario | undefined): SemanticCaseDefinition {
  return {
    id: item.id,
    scenario: item.scenario,
    layer: item.layer,
    command: item.command,
    red_means: item.red_means,
    green_means: item.green_means,
    case_digest: workCaseDigest(item, scenario),
  };
}

export function semanticPlanDefinitionDigest(plan: WorkPlan): string {
  const scenarios = plan.scenarios.map(scenarioDefinition);
  const scenarioById = new Map(plan.scenarios.map((scenario) => [scenario.id, scenario]));
  const cases = plan.cases.map((item) => caseDefinition(item, scenarioById.get(item.scenario)));
  return digestDefinitions(scenarios, cases);
}

export function recordedSemanticPlanDefinitionDigest(
  events: readonly EventRecord[],
  goalSeq: number,
): string | undefined {
  const tracker = new SemanticPlanDefinitionTracker();
  let definitionsStarted = false;
  for (const event of events) {
    if (event.seq <= goalSeq) continue;
    if (event.name === "work/todo" && !definitionsStarted) continue;
    const isScenario = event.name === "work/scenario";
    const isCase = event.name === "work/case"
      && event.payload.status !== "red"
      && event.payload.status !== "green";
    if (!isScenario && !isCase) break;
    definitionsStarted = true;
    tracker.push(event);
  }
  return tracker.snapshot()?.digest;
}

function eventText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function scenarioFromEvent(event: EventRecord): SemanticScenarioDefinition | undefined {
  const id = eventText(event.payload.id);
  const todo = eventText(event.payload.todo);
  const given = eventText(event.payload.given);
  const when = eventText(event.payload.when);
  const then = eventText(event.payload.then);
  return id && todo && given && when && then ? { id, todo, given, when, then } : undefined;
}

/** Evidence modes are closed declarations; invalid bodies cannot become legacy cases. */
export function validCaseEvidenceDefinition(item: Case | Record<string, unknown>): boolean {
  if (item.evidence_level !== undefined && item.evidence_level !== "workspace_reported") return false;
  if (item.measurement === undefined) return true;
  return item.evidence_level === undefined && caseMeasurementSchema.safeParse(item.measurement).success;
}

function caseFromEvent(
  event: EventRecord,
  scenarios: ReadonlyMap<string, SemanticScenarioDefinition>,
): SemanticCaseDefinition | undefined {
  const id = eventText(event.payload.id);
  const scenarioId = eventText(event.payload.scenario);
  const layer = eventText(event.payload.layer);
  const command = eventText(event.payload.command);
  const redMeans = eventText(event.payload.red_means);
  const greenMeans = eventText(event.payload.green_means);
  const digest = eventText(event.payload.case_digest);
  const scenario = scenarioId ? scenarios.get(scenarioId) : undefined;
  if (!id || !scenarioId || !scenario || !layer || !command || !redMeans || !greenMeans || !digest) {
    return undefined;
  }
  const definition = {
    id,
    scenario: scenarioId,
    layer,
    command,
    red_means: redMeans,
    green_means: greenMeans,
    case_digest: digest,
  };
  return validCaseEvidenceDefinition(event.payload)
    && workCaseDigest(event.payload, scenario) === digest ? definition : undefined;
}
