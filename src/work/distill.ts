import { BlobStore } from "../host/blob-store.ts";
import { canonicalJson } from "../host/canonical.ts";
import type { EventLog } from "../host/event-log.ts";
import type { EventRecord } from "../host/schema.ts";
import { deriveHostObservations } from "../maek/host-producer.ts";
import { sha256 } from "../maek/hash.ts";
import type { FaultRecord } from "../maek/types.ts";

/**
 * Post-campaign self-distillation (issue #117).
 *
 * A finished campaign leaves its truth in the session EventLog: case
 * reversals, tool faults, and the commands that carried them. This module is
 * a deterministic projection over that immutable prefix — no model synthesis,
 * no live-loop state, and no native dependencies (the MAEK loader lives in
 * `distill-maek.ts` so bundled CLIs can start without DuckDB). Everything it
 * emits is disposable: the appended `distill/summary`,
 * `knowledge/promote_candidate`, and `knowledge/distill_draft` rows can be
 * rebuilt from the log at any time, and the log stays the source of truth
 * (constitution 1, 5).
 */

export interface DistillRecipe {
  readonly case_id: string;
  readonly scenario?: string;
  readonly todo?: string;
  readonly command?: string;
  /** Recorded bash commands between the RED and its GREEN, in order, capped. */
  readonly steps: readonly string[];
  readonly red_hash: string;
  readonly green_hash: string;
  readonly digest: string;
}

export interface DistillFaultPattern {
  readonly command: string;
  readonly command_digest: string;
  readonly repeats: number;
  readonly fault_excerpt: string;
  readonly fault_ids: readonly string[];
}

export interface DistillKnowledge {
  readonly goal?: string;
  readonly recipes: readonly DistillRecipe[];
  /** Unresolved faults that repeated at least twice — do-not-retry candidates. */
  readonly fault_patterns: readonly DistillFaultPattern[];
  /** Total diagnosed faults with no recorded GREEN resolution. */
  readonly unresolved_faults: number;
}

export interface DistillRunResult {
  readonly status: "distilled" | "unchanged";
  readonly summary?: EventRecord;
  readonly candidates: readonly EventRecord[];
  readonly drafts: readonly EventRecord[];
}

export interface DistillCampaignState {
  readonly input_digest: string;
  readonly head_seq: number;
  readonly head_hash: string;
}

/** Cap on recorded recipe steps: the shape of the recipe, not the whole log. */
const RECIPE_STEP_LIMIT = 8;

/** Events this pipeline appends; extraction always ignores its own output. */
const DISTILL_EVENT_NAMES = new Set([
  "distill/summary",
  "distill/maek_indexed",
  "distill/auto_failed",
  "knowledge/promote_candidate",
  "knowledge/distill_draft",
]);

/** Rows that only exist as projections of the campaign prefix (this module's
 * appends and the MAEK store's recorded ingests). They trail the real work,
 * never lead it, so the distill input head skips them: re-running the MAEK
 * load between two distill runs must not make the prefix look new. */
export function isDerivedProjectionEvent(name: string): boolean {
  return (
    name.startsWith("distill/")
    || name.startsWith("dream/")
    || name.startsWith("maek/")
    || name === "knowledge/promote_candidate"
    || name === "knowledge/distill_draft"
  );
}

/** The campaign prefix state a distill run is a function of. */
export function distillCampaignState(log: EventLog, sessionId: string): DistillCampaignState {
  const head = [...log.events].reverse().find((event) => !isDerivedProjectionEvent(event.name));
  if (!head) throw new Error("distill needs at least one campaign event in the session log");
  return {
    input_digest: sha256(canonicalJson({ session: sessionId, head: head.hash, seq: head.seq })),
    head_seq: head.seq,
    head_hash: head.hash,
  };
}

export function distillRecipeDigest(
  recipe: Omit<DistillRecipe, "digest">,
): string {
  const normalized: Record<string, unknown> = {
    case_id: recipe.case_id,
    red_hash: recipe.red_hash,
    green_hash: recipe.green_hash,
    steps: [...recipe.steps],
  };
  if (recipe.scenario !== undefined) normalized.scenario = recipe.scenario;
  if (recipe.todo !== undefined) normalized.todo = recipe.todo;
  if (recipe.command !== undefined) normalized.command = recipe.command;
  return sha256(canonicalJson(normalized));
}

export function extractDistillKnowledge(input: {
  readonly events: readonly EventRecord[];
  readonly sessionId: string;
  readonly store: BlobStore;
}): DistillKnowledge {
  const events = input.events.filter((event) => !DISTILL_EVENT_NAMES.has(event.name));

  // One authoritative campaign: the last bound goal. Case ids are reused
  // across replans; a RED from a retired goal must never meet a GREEN from
  // the current one (review finding: mixed-scope recipes).
  let scopeStart = 0;
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]!.name === "work/goal") scopeStart = index;
  }
  const campaign = events.slice(scopeStart);
  const goal = campaign.find((event) => event.name === "work/goal");
  const goalStatement = goal
    ? optionalString(goal.payload.statement) ?? optionalString(goal.payload.id)
    : undefined;

  const scenarioTodos = new Map<string, string>();
  for (const event of campaign) {
    if (event.name !== "work/scenario") continue;
    const id = optionalString(event.payload.id);
    const todo = optionalString(event.payload.todo);
    if (id !== undefined && todo !== undefined) scenarioTodos.set(id, todo);
  }

  const recipes: DistillRecipe[] = [];
  const caseRuns = new Map<string, EventRecord[]>();
  for (const event of campaign) {
    const id = event.name === "work/case" ? optionalString(event.payload.id) : undefined;
    if (id === undefined || typeof event.payload.status !== "string") continue;
    const runs = caseRuns.get(id) ?? [];
    runs.push(event);
    caseRuns.set(id, runs);
  }
  for (const [id, runs] of [...caseRuns.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // The final applicable verdict must remain GREEN: a case that turned
    // green and later regressed back to red is not a verified recipe.
    if (runs.at(-1)?.payload.status !== "green") continue;
    const red = runs.find((event) => event.payload.status === "red");
    if (!red) continue;
    const green = runs.find((event) => event.payload.status === "green" && event.seq > red.seq);
    if (!green) continue;
    const scenario = optionalString(green.payload.scenario) ?? optionalString(red.payload.scenario);
    const command = optionalString(green.payload.command) ?? optionalString(red.payload.command);
    const steps = recipeSteps(campaign, red.seq, green.seq);
    const base = {
      case_id: id,
      red_hash: red.hash,
      green_hash: green.hash,
      steps,
      ...(scenario !== undefined ? { scenario } : {}),
      ...(scenario !== undefined && scenarioTodos.has(scenario) ? { todo: scenarioTodos.get(scenario)! } : {}),
      ...(command !== undefined ? { command } : {}),
    };
    recipes.push({ ...base, digest: distillRecipeDigest(base) });
  }

  const observations = deriveHostObservations({
    events: campaign,
    sessionId: input.sessionId,
    store: input.store,
  });
  const resolved = new Set(
    observations
      .filter((observation) => observation.kind === "fault_resolution")
      .map((observation) => observation.row.fault_id),
  );
  const unresolved = observations
    .filter((observation) => observation.kind === "fault" && !resolved.has(observation.row.fault_id))
    .map((observation) => observation.row as FaultRecord)
    .sort((left, right) => left.fault_id.localeCompare(right.fault_id));

  const groups = new Map<string, FaultRecord[]>();
  for (const fault of unresolved) {
    const key = fault.command_digest ?? sha256(canonicalJson({ command: fault.command }));
    const group = groups.get(key) ?? [];
    group.push(fault);
    groups.set(key, group);
  }
  const fault_patterns = [...groups.entries()]
    .map(([command_digest, group]) => {
      const last = group.at(-1)!;
      return {
        command: last.command,
        command_digest,
        repeats: group.length,
        fault_excerpt: last.fault_excerpt,
        fault_ids: group.map((fault) => fault.fault_id),
      };
    })
    .filter((pattern) => pattern.repeats >= 2)
    .sort((left, right) => left.command_digest.localeCompare(right.command_digest));

  return {
    ...(goalStatement !== undefined ? { goal: goalStatement } : {}),
    recipes,
    fault_patterns,
    unresolved_faults: unresolved.length,
  };
}

function recipeSteps(campaign: readonly EventRecord[], fromSeq: number, toSeq: number): string[] {
  const steps: string[] = [];
  for (const event of campaign) {
    if (event.seq <= fromSeq || event.seq > toSeq) continue;
    if (event.name !== "tool/call") continue;
    const args = event.payload.args;
    const command = args && typeof args === "object"
      ? optionalString((args as Record<string, unknown>).command)
      : undefined;
    if (command === undefined || command.length === 0) continue;
    if (!steps.includes(command)) steps.push(command);
    if (steps.length >= RECIPE_STEP_LIMIT) break;
  }
  return steps;
}

export function distillMarkdown(knowledge: DistillKnowledge, goal: string): string {
  const lines = [
    `## Distilled knowledge for ${goal}`,
    "",
    ...(knowledge.goal !== undefined ? [`Goal: ${knowledge.goal}`, ""] : []),
  ];
  if (knowledge.recipes.length > 0) {
    lines.push("### Verified recipes", "");
    for (const recipe of knowledge.recipes) {
      const target = recipe.command ?? recipe.case_id;
      lines.push(
        `- ${target} — RED ${recipe.red_hash.slice(0, 12)} turned GREEN ${recipe.green_hash.slice(0, 12)}`
          + (recipe.todo !== undefined ? ` (todo ${recipe.todo})` : ""),
      );
      for (const step of recipe.steps) lines.push(`  - ${step}`);
    }
    lines.push("");
  }
  if (knowledge.fault_patterns.length > 0) {
    lines.push("### Do-not-repeat faults", "");
    for (const pattern of knowledge.fault_patterns) {
      lines.push(`- ${pattern.command} failed ${pattern.repeats} times — ${pattern.fault_excerpt}`);
    }
    lines.push("");
  }
  if (knowledge.recipes.length === 0 && knowledge.fault_patterns.length === 0) {
    lines.push("No reversals or repeated unresolved faults in this campaign.", "");
  }
  lines.push(
    `${knowledge.unresolved_faults} unresolved fault(s) are indexed in MAEK; the EventLog remains the source of truth.`,
  );
  return lines.join("\n");
}

function recipeDraftMarkdown(recipe: DistillRecipe): string {
  const lines = [
    `## Runbook draft: ${recipe.command ?? recipe.case_id}`,
    "",
    "A recorded RED-to-GREEN reversal backs this runbook draft.",
    "",
    "### Steps",
    ...(recipe.steps.length > 0
      ? recipe.steps.map((step) => `- ${step}`)
      : ["- (no recorded commands between RED and GREEN)"]),
    "",
    "### Evidence",
    `- RED event: ${recipe.red_hash}`,
    `- GREEN event: ${recipe.green_hash}`,
  ];
  return lines.join("\n");
}

/**
 * Append the distill rows for a completed session's log.
 *
 * Failure-atomic by construction: the per-recipe `knowledge/distill_draft`
 * and `knowledge/promote_candidate` rows are appended first (deduplicated by
 * digest, so a retry after a partial append reconciles instead of
 * duplicating), and only then the `distill/summary` that marks the prefix
 * distilled. A run whose summary and outputs are all present appends nothing.
 */
export function runDistill(input: {
  readonly log: EventLog;
  readonly sessionId: string;
}): DistillRunResult {
  const prior = input.log.events.filter((event) => !DISTILL_EVENT_NAMES.has(event.name));
  const state = distillCampaignState(input.log, input.sessionId);
  const existing = latestSummaryFor(input.log.events, state.input_digest);

  const knowledge = extractDistillKnowledge({ events: prior, sessionId: input.sessionId, store: BlobStore.forSession(input.log.path) });
  const store = BlobStore.forSession(input.log.path);

  const expected = expectedRecipes(input.log.events, existing, knowledge);
  const drafts = appendMissing(
    input,
    expected.map((recipe) => ({
      kind: "observe" as const,
      name: "knowledge/distill_draft",
      key: recipe.digest,
      payload: {
        kind: "runbook",
        digest: recipe.digest,
        case_id: recipe.case_id,
        ...(recipe.command !== undefined ? { command: recipe.command } : {}),
        blob: store.put(recipeDraftMarkdown(recipe)),
        evidence: [recipe.red_hash, recipe.green_hash],
      },
    })),
  );
  const candidates = appendMissing(
    input,
    expected.map((recipe) => ({
      kind: "observe" as const,
      name: "knowledge/promote_candidate",
      key: recipe.digest,
      payload: {
        kind: "procedure",
        digest: recipe.digest,
        case_id: recipe.case_id,
        ...(recipe.command !== undefined ? { command: recipe.command } : {}),
        evidence: [recipe.red_hash, recipe.green_hash],
      },
    })),
  );

  const complete = existing !== undefined && drafts.length === 0 && candidates.length === 0;
  if (complete) return { status: "unchanged", summary: existing, candidates: [], drafts: [] };

  const summary = existing ?? appendSummary(input, knowledge, state, store);
  return { status: "distilled", summary, candidates, drafts };
}

/**
 * Campaign-end auto-trigger for the work loop: run the projection and record
 * a `distill/auto_failed` row instead of letting a derived failure take the
 * campaign's own success down with it.
 */
export function distillAtCampaignEnd(input: {
  readonly log: EventLog;
  readonly sessionId: string;
}): "distilled" | "unchanged" | "failed" {
  try {
    return runDistill(input).status;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    input.log.append({
      kind: "observe",
      name: "distill/auto_failed",
      payload: { reason: reason.slice(0, 200) },
    });
    return "failed";
  }
}

function latestSummaryFor(events: readonly EventRecord[], inputDigest: string): EventRecord | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.name === "distill/summary" && event.payload.input_digest === inputDigest) return event;
  }
  return undefined;
}

/** Recipes a run must account for: the current extraction, or — when the
 * summary already exists — the set that summary committed to. */
function expectedRecipes(
  events: readonly EventRecord[],
  existing: EventRecord | undefined,
  knowledge: DistillKnowledge,
): readonly DistillRecipe[] {
  if (!existing) return knowledge.recipes;
  const recorded = existing.payload.recipes;
  if (!Array.isArray(recorded)) return knowledge.recipes;
  return recorded.filter((row): row is DistillRecipe => {
    if (!row || typeof row !== "object") return false;
    return typeof (row as DistillRecipe).digest === "string";
  });
}

function appendMissing(
  input: { readonly log: EventLog },
  rows: readonly {
    readonly kind: "observe";
    readonly name: string;
    readonly key: string;
    readonly payload: Record<string, unknown>;
  }[],
): readonly EventRecord[] {
  const appended: EventRecord[] = [];
  for (const row of rows) {
    const present = input.log.events.some(
      (event) => event.name === row.name && event.payload.digest === row.key,
    );
    if (present) continue;
    appended.push(input.log.append({ kind: row.kind, name: row.name, payload: row.payload }));
  }
  return appended;
}

function appendSummary(
  input: { readonly log: EventLog; readonly sessionId: string },
  knowledge: DistillKnowledge,
  state: DistillCampaignState,
  store: BlobStore,
): EventRecord {
  const goal = knowledge.goal ?? input.sessionId;
  const markdown = distillMarkdown(knowledge, goal);
  return input.log.append({
    kind: "observe",
    name: "distill/summary",
    payload: {
      session: input.sessionId,
      input_digest: state.input_digest,
      head_seq: state.head_seq,
      reversals: knowledge.recipes.length,
      unresolved_faults: knowledge.unresolved_faults,
      fault_patterns: knowledge.fault_patterns.map((pattern) => ({
        command: pattern.command,
        command_digest: pattern.command_digest,
        repeats: pattern.repeats,
        fault_excerpt: pattern.fault_excerpt,
      })),
      recipes: knowledge.recipes,
      // The canonical blob envelope: GC, packing, and replay follow payload.blob.
      blob: store.put(markdown),
    },
  });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
