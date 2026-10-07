import type { Case, WorkPlan } from "./schema.ts";

/**
 * Wave-parallel case dispatch (issue #119).
 *
 * The planner already separates independent todos into the same topological
 * wave; the verify pass ran them one at a time, so a long benchmark on one
 * runner blocked an unrelated todo that another machine could have judged.
 * This module plans WHICH cases may execute together — never how they are
 * judged: verdict recording stays with the verifier, in plan order, on the
 * single append-only EventLog (constitution 2, 5).
 */

export const MAX_WAVE_CONCURRENCY = 4;

/** Resolve the operator's --wave-concurrency. Default 1 is today's serial
 * verify. Anything outside 1..4 fails closed instead of silently clamping. */
export function resolveWaveConcurrency(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 1 || value > MAX_WAVE_CONCURRENCY) {
    throw new Error(`--wave-concurrency must be an integer in 1..${MAX_WAVE_CONCURRENCY}, got ${String(value)}`);
  }
  return value;
}

/** Transitive blocked_by closure per todo (a todo "depends on" every ancestor). */
function ancestorClosure(plan: WorkPlan): Map<string, Set<string>> {
  const byId = new Map(plan.todos.map((todo) => [todo.id, todo] as const));
  const memo = new Map<string, Set<string>>();
  const visit = (id: string, stack: ReadonlySet<string>): Set<string> => {
    const cached = memo.get(id);
    if (cached) return cached;
    const todo = byId.get(id);
    const out = new Set<string>();
    if (todo) {
      for (const parent of todo.blocked_by) {
        if (stack.has(parent)) continue; // cycle: validate.ts owns that error
        out.add(parent);
        for (const ancestor of visit(parent, new Set([...stack, parent]))) out.add(ancestor);
      }
    }
    memo.set(id, out);
    return out;
  };
  for (const todo of plan.todos) visit(todo.id, new Set([todo.id]));
  return memo;
}

/** Artifact ids a todo touches, either side of the flow. */
function touchedArtifacts(plan: WorkPlan): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const todo of plan.todos) {
    const ids = new Set<string>();
    for (const port of [...(todo.produces ?? []), ...(todo.consumes ?? [])]) ids.add(port.id);
    out.set(todo.id, ids);
  }
  return out;
}

/** True when neither todo depends on the other and their flows stay disjoint. */
export function todosAreWaveIndependent(
  plan: WorkPlan,
  left: string,
  right: string,
  ancestors = ancestorClosure(plan),
  artifacts = touchedArtifacts(plan),
): boolean {
  if (left === right) return false;
  if (ancestors.get(left)?.has(right) || ancestors.get(right)?.has(left)) return false;
  const leftArtifacts = artifacts.get(left) ?? new Set<string>();
  for (const id of artifacts.get(right) ?? []) {
    if (leftArtifacts.has(id)) return false;
  }
  return true;
}

/** The todo that owns a case, via its scenario. */
export function caseTodo(plan: WorkPlan, item: Case): string | undefined {
  return plan.scenarios.find((scenario) => scenario.id === item.scenario)?.todo;
}

/**
 * Partition cases into ordered parallel batches.
 *
 * Rules: cases of one todo stay together and run in plan order inside their
 * worker; a batch holds at most `limit` independent todos (no blocked_by
 * ancestry, no shared artifact id); two todos whose cases use the SAME ssh
 * alias never share a batch — the plan's enrolled aliases are the
 * distribution, the batch is the guarantee that one host judges one case at
 * a time. Todos without a scenario link keep to themselves, serial.
 */
export function planCaseBatches(input: {
  readonly plan: WorkPlan;
  readonly cases: readonly Case[];
  readonly limit: number;
}): Case[][] {
  const ancestors = ancestorClosure(input.plan);
  const artifacts = touchedArtifacts(input.plan);
  const groups = new Map<string, Case[]>();
  const loners: Case[] = [];
  for (const item of input.cases) {
    const todo = caseTodo(input.plan, item);
    if (todo === undefined) {
      loners.push(item);
      continue;
    }
    const group = groups.get(todo) ?? [];
    group.push(item);
    groups.set(todo, group);
  }

  const batches: Case[][] = [];
  for (const loner of loners) batches.push([loner]);

  const remaining = [...groups.keys()];
  while (remaining.length > 0) {
    const batch: string[] = [];
    const hosts = new Set<string>();
    for (const todo of [...remaining]) {
      if (batch.length >= input.limit) break;
      if (batch.some((picked) => !todosAreWaveIndependent(input.plan, picked, todo, ancestors, artifacts))) continue;
      const groupHosts = new Set(
        (groups.get(todo) ?? [])
          .map((item) => item.host)
          .filter((host): host is string => host !== undefined),
      );
      if ([...groupHosts].some((host) => hosts.has(host))) continue;
      batch.push(todo);
      for (const host of groupHosts) hosts.add(host);
      remaining.splice(remaining.indexOf(todo), 1);
    }
    batches.push(batch.flatMap((todo) => groups.get(todo) ?? []));
  }
  return batches;
}

export interface WaveBatchResult {
  readonly aborted: boolean;
  /** Bounded stable reason of the first harness-level failure, if any. */
  readonly reason?: string;
}

/**
 * Run one wave batch to its barrier. Tasks receive `aborted()` so a worker
 * skips its not-yet-started cases after a sibling's harness-level failure;
 * an in-flight run drains within its declared budget — cancellation happens
 * at case boundaries, never mid-command. The caller appends the barrier row
 * from the result and fails closed when `aborted` is true.
 */
export async function runWaveBatch(
  tasks: ReadonlyArray<(aborted: () => boolean) => Promise<void>>,
): Promise<WaveBatchResult> {
  let failure: WaveBatchResult | undefined;
  const aborted = (): boolean => failure !== undefined;
  await Promise.allSettled(
    tasks.map(async (task) => {
      try {
        await task(aborted);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (failure === undefined) {
          failure = { aborted: true, reason: reason.slice(0, 240) };
        }
      }
    }),
  );
  return failure ?? { aborted: false };
}
