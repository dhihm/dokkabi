import type { ArtifactPort, Todo, WorkPlan } from "./schema.ts";

/**
 * Static checks over a plan's artifact ports (#78 Phase 1, G4).
 *
 * `blocked_by` has always ordered todos, and a dependency cycle is already
 * refused. What no check could see was DATA: nothing recorded that a todo
 * needs an artifact another todo makes, so an undeclared dependency or a
 * shape mismatch was discoverable only by running the plan and watching a
 * step fail for a reason the graph could have named first.
 *
 * These run in the same pass as the rest of plan review, so a bad wiring is
 * a refusal with the todo named — not a wave spent finding out.
 *
 * Ports are optional. A plan that declares none produces no errors, which is
 * every plan written before this existed.
 */

const PORT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const PORT_KIND = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;

function portsOf(todo: Todo, side: "consumes" | "produces"): readonly ArtifactPort[] {
  const value = todo[side];
  return Array.isArray(value) ? value : [];
}

function shapeErrors(todo: Todo, side: "consumes" | "produces"): string[] {
  const value = todo[side];
  // `null` is ABSENT, not malformed. It is the most common thing a small
  // model writes for an optional field it has nothing to put in, and now
  // that prompts/work/decompose.md describes ports, treating it as a shape
  // error would refuse a plan that correctly meant "no ports".
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    return [`todo ${todo.id} ${side} must be an ARRAY of {id, kind} ports`];
  }
  const errors: string[] = [];
  for (const port of value) {
    if (!port || typeof port !== "object" || Array.isArray(port)) {
      errors.push(`todo ${todo.id} ${side} contains a port that is not an {id, kind} object`);
      continue;
    }
    if (typeof port.id !== "string" || !PORT_ID.test(port.id)) {
      errors.push(`todo ${todo.id} ${side} port id must match [a-z0-9][a-z0-9_-]* (got ${JSON.stringify(port.id)})`);
    }
    if (typeof port.kind !== "string" || !PORT_KIND.test(port.kind)) {
      errors.push(`todo ${todo.id} ${side} port ${String(port.id)} has an invalid kind ${JSON.stringify(port.kind)}`);
    }
  }
  return errors;
}

/** Todos this one depends on, transitively. Bounded by a visited set so a
 * cyclic plan — which validatePlan refuses separately — cannot hang here on
 * the way to that refusal. */
function ancestors(plan: WorkPlan, id: string): Set<string> {
  const byId = new Map(plan.todos.map((todo) => [todo.id, todo]));
  const seen = new Set<string>();
  const queue = [...(byId.get(id)?.blocked_by ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...(byId.get(next)?.blocked_by ?? []));
  }
  return seen;
}

export function reviewPortWiring(plan: WorkPlan): string[] {
  const todos = Array.isArray(plan.todos) ? plan.todos : [];
  const errors: string[] = [];
  // Only the todos whose ports are MALFORMED sit out the wiring pass. A
  // plan-wide early return hid every real wiring fault behind one typo, and
  // these strings go back to the model through the decompose retry prompt —
  // each suppressed class costs a full round trip.
  const malformed = new Set<string>();
  for (const todo of todos) {
    const shape = [...shapeErrors(todo, "consumes"), ...shapeErrors(todo, "produces")];
    if (shape.length > 0) malformed.add(todo.id);
    errors.push(...shape);
  }
  const wired = todos.filter((todo) => !malformed.has(todo.id));

  // One producer per artifact. Two would leave the consumer unable to say
  // which one it meant, and the host unable to order it after both.
  const producers = new Map<string, { todo: string; kind: string }[]>();
  for (const todo of wired) {
    for (const port of portsOf(todo, "produces")) {
      producers.set(port.id, [...(producers.get(port.id) ?? []), { todo: todo.id, kind: port.kind }]);
    }
  }
  for (const [id, rows] of [...producers].sort(([left], [right]) => left.localeCompare(right))) {
    if (rows.length < 2) continue;
    const owners = [...new Set(rows.map((row) => row.todo))].sort();
    // A todo listing one artifact twice is a duplicate ENTRY, not a second
    // producer. Telling a model to find a producer that does not exist spends
    // a retry chasing nothing.
    errors.push(owners.length === 1
      ? `todo ${owners[0]} lists artifact ${id} ${rows.length} times in produces — declare it once`
      : `artifact ${id} is produced by ${owners.length} todos (${owners.join(", ")}) — exactly one may produce it`);
  }

  for (const todo of wired) {
    const made = new Set(portsOf(todo, "produces").map((port) => port.id));
    const before = ancestors(plan, todo.id);
    for (const port of portsOf(todo, "consumes")) {
      if (made.has(port.id)) {
        errors.push(`todo ${todo.id} consumes its own output ${port.id}`);
        continue;
      }
      const rows = producers.get(port.id);
      if (!rows || rows.length === 0) {
        errors.push(`todo ${todo.id} consumes ${port.id}, but no todo produces it`);
        continue;
      }
      // Ambiguous producer: the duplicate is already reported, and there is
      // no single kind or ordering to check this port against.
      if (rows.length > 1) continue;
      const producer = rows[0]!;
      if (producer.kind !== port.kind) {
        errors.push(
          `todo ${todo.id} consumes ${port.id} with kind ${port.kind}, but its producer ${producer.todo} `
          + `declares kind ${producer.kind} — the ports must agree`,
        );
      }
      // The check that ties data flow to control flow. Without it a consumer
      // can be scheduled before its producer and read what does not exist.
      if (!before.has(producer.todo)) {
        errors.push(
          `todo ${todo.id} consumes ${port.id} but does not depend on its producer ${producer.todo} — add it to blocked_by`,
        );
      }
    }
  }
  return errors;
}
