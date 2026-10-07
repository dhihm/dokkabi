import type { ArtifactPort, WorkPlan } from "./schema.ts";

/**
 * The work plan, projected as a graph (#78 Phase 1, G1).
 *
 * A PROJECTION, deliberately — not a second file. The RFC sketches a
 * `work/graph.json` alongside `work/current.json`, but two authored
 * representations of one job are two worlds that can disagree, and the plan
 * is the world (constitution 3). Everything here is derived, the way the
 * dashboard and the replay contract are derived, so nothing can drift.
 *
 * Three edge kinds, kept apart because they are different facts:
 *   contains    goal → todo → scenario → case, the plan's structure
 *   blocked_by  ordering the operator or model declared
 *   flows       an artifact moving from its producer to a consumer
 *
 * An ordering edge and a data edge between the same two todos are not the
 * same claim: the first says "after", the second says "because of this".
 */

export type WorkNodeKind = "goal" | "todo" | "scenario" | "case";
export type WorkEdgeKind = "contains" | "blocked_by" | "flows";

export interface WorkGraphNode {
  /** `kind:id`. A plan may legally reuse one id across kinds — validatePlan
   * checks uniqueness only WITHIN each kind — so a bare id would collide and
   * hand every consumer (layout, renderer, a Phase 2 executor) an ambiguous
   * graph. */
  readonly node: string;
  readonly id: string;
  readonly kind: WorkNodeKind;
  readonly label: string;
  /** Todo nodes only. */
  readonly class?: string;
  readonly consumes?: readonly ArtifactPort[];
  readonly produces?: readonly ArtifactPort[];
}

export interface WorkGraphEdge {
  readonly kind: WorkEdgeKind;
  /** Compound node keys, for the same reason. */
  readonly from: string;
  readonly to: string;
  /** `flows` only: which artifact travels this edge. */
  readonly artifact?: string;
}

export interface WorkGraphV1 {
  readonly format: 1;
  readonly goal: string;
  readonly nodes: readonly WorkGraphNode[];
  readonly edges: readonly WorkGraphEdge[];
  /**
   * Topological levels over `blocked_by`: every todo in a wave can run
   * beside the others. This is a HINT the DAG already implied, not a
   * schedule — the drive loop still picks one action at a time.
   */
  readonly waves: readonly (readonly string[])[];
  /** Todos no wave could place, i.e. those inside or behind a dependency
   * cycle. `validatePlan` refuses the cycle; this reports it without
   * pretending to order it. */
  readonly unscheduled: readonly string[];
}

function ports(value: readonly ArtifactPort[] | undefined): readonly ArtifactPort[] {
  return Array.isArray(value) ? value : [];
}

export function projectWorkGraph(plan: WorkPlan): WorkGraphV1 {
  const todos = Array.isArray(plan.todos) ? plan.todos : [];
  const scenarios = Array.isArray(plan.scenarios) ? plan.scenarios : [];
  const cases = Array.isArray(plan.cases) ? plan.cases : [];

  const goal = plan.goal ?? { id: "goal-missing", statement: "" };
  const key = (kind: WorkNodeKind, id: string): string => `${kind}:${id}`;
  const nodes: WorkGraphNode[] = [
    { node: key("goal", goal.id), id: goal.id, kind: "goal", label: goal.statement },
    ...todos.map((todo) => ({
      node: key("todo", todo.id),
      id: todo.id,
      kind: "todo" as const,
      label: todo.title,
      class: todo.class,
      consumes: ports(todo.consumes),
      produces: ports(todo.produces),
    })),
    ...scenarios.map((scenario) => ({
      node: key("scenario", scenario.id),
      id: scenario.id,
      kind: "scenario" as const,
      label: `${scenario.given} / ${scenario.when} / ${scenario.then}`,
    })),
    ...cases.map((item) => ({
      node: key("case", item.id), id: item.id, kind: "case" as const, label: item.command,
    })),
  ];

  const edges: WorkGraphEdge[] = [];
  for (const todo of todos) {
    edges.push({ kind: "contains", from: key("goal", goal.id), to: key("todo", todo.id) });
    for (const blocker of todo.blocked_by ?? []) {
      edges.push({ kind: "blocked_by", from: key("todo", blocker), to: key("todo", todo.id) });
    }
  }
  for (const scenario of scenarios) {
    edges.push({ kind: "contains", from: key("todo", scenario.todo), to: key("scenario", scenario.id) });
  }
  for (const item of cases) {
    edges.push({ kind: "contains", from: key("scenario", item.scenario), to: key("case", item.id) });
  }

  const producers = new Map<string, string[]>();
  for (const todo of todos) {
    for (const port of ports(todo.produces)) {
      producers.set(port.id, [...(producers.get(port.id) ?? []), todo.id]);
    }
  }
  for (const todo of todos) {
    for (const port of ports(todo.consumes)) {
      const from = producers.get(port.id) ?? [];
      // Ambiguously produced: EVERY candidate edge is drawn. Picking the
      // first by array order would be inventing the answer reviewPortWiring
      // refuses, and printing one confident edge hides that the plan is
      // refusable.
      for (const source of from) {
        if (source === todo.id) continue;
        edges.push({
          kind: "flows", from: key("todo", source), to: key("todo", todo.id), artifact: port.id,
        });
      }
    }
  }

  return {
    format: 1,
    goal: goal.id,
    nodes,
    edges,
    ...schedule(todos.map((todo) => ({ id: todo.id, blocked_by: [...(todo.blocked_by ?? [])] }))),
  };
}

/** Kahn levels. Terminates on a cycle by construction: a round that places
 * nothing stops, and whatever is left is reported as unscheduled. */
function schedule(
  todos: readonly { id: string; blocked_by: string[] }[],
): { waves: string[][]; unscheduled: string[] } {
  const known = new Set(todos.map((todo) => todo.id));
  const pending = new Map(todos.map((todo) => [
    todo.id,
    // A blocker that is not a todo cannot be waited for; validatePlan names
    // it separately, and treating it as unmet would hide every real wave.
    // A SELF-blocker is kept: it is a cycle, and dropping it here would let a
    // plan validatePlan refuses (`blocked_by cycle: t1 -> t1`) come back with
    // a full schedule — three host components giving three answers about one
    // plan. (The idiom was borrowed from dash/dag.ts, where suppressing a
    // self-edge is right for LAYOUT and wrong for a validity claim.)
    new Set(todo.blocked_by.filter((blocker) => known.has(blocker))),
  ]));
  const waves: string[][] = [];
  const placed = new Set<string>();
  while (placed.size < todos.length) {
    const wave = [...pending.keys()]
      .filter((id) => !placed.has(id) && [...pending.get(id)!].every((blocker) => placed.has(blocker)))
      .sort();
    if (wave.length === 0) break;
    for (const id of wave) placed.add(id);
    waves.push(wave);
  }
  const unscheduled = todos.map((todo) => todo.id).filter((id) => !placed.has(id)).sort();
  // A plan with a cycle gets NO waves: a partial schedule that silently drops
  // the cyclic tail reads as a valid plan with fewer todos.
  return unscheduled.length > 0 ? { waves: [], unscheduled } : { waves, unscheduled };
}
