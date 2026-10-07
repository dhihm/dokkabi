import { relative, resolve } from "node:path";
import { redactText, stripTerminalControls } from "../../host/redact.ts";
import type { EventRecord } from "../../host/schema.ts";
import { redCaseOutputs } from "../scope.ts";
import type { WorkPlan } from "../schema.ts";
import {
  assertStepInputV1,
  type ConsumedArtifact,
  type ProducedArtifact,
  type StepCase,
  type StepInputV1,
  type StepScenario,
} from "./step.ts";

/**
 * Assemble the slot a fresh implement step will see (#77 v1).
 *
 * Everything here exists because a step session has NO transcript: today the
 * goal, the scenarios, the case commands and the last RED tail reach the
 * model only because they scrolled past earlier in the same session, and
 * `prompts/work/continue.md` restates none of them.
 */

const FAILURE_TAIL_BYTES = 2_400;

export function workStepId(todoId: string, wave: number): string {
  return `implement-${todoId}-${wave}`;
}

/** The slot schema refuses absolute paths — they name the operator's machine
 * and would not survive a move between a worktree and a sandbox. A real plan
 * may well carry them, so the host relativises rather than letting the
 * assertion kill the wave. */
function relativise(text: string, workspaceRoot: string): string {
  const root = resolve(workspaceRoot);
  return text.split(`${root}/`).join("").split(root).join(".");
}

/** A tail reaches BOTH the model and a blob, and BlobStore does not run the
 * secret scanner — only EventLog.append does. Clean it here or not at all. */
function safeTail(text: string): string {
  const stripped = stripTerminalControls(text).trim();
  const bounded = stripped.length > FAILURE_TAIL_BYTES ? stripped.slice(-FAILURE_TAIL_BYTES) : stripped;
  return redactText(bounded);
}

export function buildStepInput(input: {
  readonly plan: WorkPlan;
  readonly todoId: string;
  readonly events: readonly EventRecord[];
  readonly workspaceRoot: string;
  readonly wave: number;
}): StepInputV1 {
  const todo = input.plan.todos.find((item) => item.id === input.todoId);
  if (!todo) throw new Error(`step input: todo ${input.todoId} is not in the plan`);

  const scenarios: StepScenario[] = input.plan.scenarios
    .filter((item) => item.todo === input.todoId)
    .map((item) => ({
      id: item.id,
      given: relativise(item.given, input.workspaceRoot),
      when: relativise(item.when, input.workspaceRoot),
      then: relativise(item.then, input.workspaceRoot),
    }));
  if (scenarios.length === 0) {
    throw new Error(`step input: todo ${input.todoId} owns no scenario`);
  }

  const owned = new Set(scenarios.map((item) => item.id));
  const tails = new Map(
    redCaseOutputs(input.events, input.plan, input.todoId).map((row) => [row.id, row.tail]),
  );
  const cases: StepCase[] = input.plan.cases
    .filter((item) => owned.has(item.scenario))
    .map((item) => {
      const tail = tails.get(item.id);
      return {
        id: item.id,
        command: relativise(item.command, input.workspaceRoot),
        green_means: item.green_means,
        ...(tail && tail.trim().length > 0 ? { failure_tail: safeTail(tail) } : {}),
      };
    });
  if (cases.length === 0) {
    throw new Error(`step input: todo ${input.todoId} owns no case — a step with no obligation is not a step`);
  }

  const ports = stepPorts(input.plan, todo);
  const slot: StepInputV1 = {
    format: 1,
    step_id: workStepId(input.todoId, input.wave),
    goal: relativise(input.plan.goal.statement, input.workspaceRoot),
    todo: {
      id: todo.id,
      title: relativise(todo.title, input.workspaceRoot),
      class: todo.class,
      statement: relativise(todo.statement, input.workspaceRoot),
    },
    scenarios,
    cases,
    ...ports,
  };
  assertStepInputV1(slot);
  return slot;
}

/**
 * Undo git's C-style path quoting.
 *
 * `core.quotePath` is on by default, so any path with a non-ASCII or control
 * byte arrives as `"a/\355\225\234.txt"`. Reading those headers as literal
 * text silently drops the file from the count — and `files_count` is a number
 * the board prints (constitution 6).
 */
function unquotePath(raw: string): string {
  if (!raw.startsWith("\"") || !raw.endsWith("\"")) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== "\\") {
      bytes.push(...Buffer.from(body[i]!, "utf8"));
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    const octal = body.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/u.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      i += 3;
      continue;
    }
    const escapes: Record<string, number> = { n: 10, t: 9, r: 13, "\"": 34, "\\": 92 };
    bytes.push(escapes[next] ?? Buffer.from(next, "utf8")[0]!);
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** One `diff --git` header's two sides, quoted or not. A rename touches both
 * names; reporting only the new one understates what the step moved. */
const DIFF_HEADER = /^diff --git (?:"((?:[^"\\]|\\.)*)"|(\S+)) (?:"((?:[^"\\]|\\.)*)"|(\S+))$/gmu;

/**
 * The plan's port declarations for this todo (#78 Phase 3).
 *
 * Phase 1 let a todo declare what it consumes and produces, and refused a
 * wiring that could not run — but nothing read the declaration at run time,
 * so a step was never told what it was handed or what it owed.
 *
 * Two rules earned by review:
 *
 * Every declared port is CARRIED. A first version dropped a consumed port
 * whose producer it could not find, on the argument that `reviewPortWiring`
 * refuses that plan — but that check runs only at the decompose seal and in
 * `dokkabi plan check`, never on `dokkabi work --plan PATH`, so a declaration
 * the plan made was erased from the artifact that is supposed to BE the
 * contract between steps, with no event and no field.
 *
 * `from` is named only when it is unambiguous. Two producers, none, or the
 * todo itself leaves it out: picking one by array order is the invented
 * answer `reviewPortWiring` refuses, and `graph-projection.ts` already
 * declines to do exactly this on the same declarations.
 */
function stepPorts(
  plan: WorkPlan,
  todo: WorkPlan["todos"][number],
): { consumes?: ConsumedArtifact[]; produces?: ProducedArtifact[] } {
  const declaredConsumes = Array.isArray(todo.consumes) ? todo.consumes : [];
  const declaredProduces = Array.isArray(todo.produces) ? todo.produces : [];
  if (declaredConsumes.length === 0 && declaredProduces.length === 0) return {};

  const producersOf = new Map<string, string[]>();
  for (const other of plan.todos) {
    for (const port of Array.isArray(other.produces) ? other.produces : []) {
      producersOf.set(port.id, [...(producersOf.get(port.id) ?? []), other.id]);
    }
  }

  const consumes: ConsumedArtifact[] = declaredConsumes.map((port) => {
    const owners = [...new Set(producersOf.get(port.id) ?? [])].filter((owner) => owner !== todo.id);
    return {
      id: port.id,
      kind: port.kind,
      ...(owners.length === 1 ? { from: owners[0]! } : {}),
    };
  });
  const produces: ProducedArtifact[] = declaredProduces.map((port) => ({ id: port.id, kind: port.kind }));
  return {
    ...(consumes.length > 0 ? { consumes } : {}),
    ...(produces.length > 0 ? { produces } : {}),
  };
}

/** Workspace-relative paths for a recorded patch's file list. */
export function relativeFiles(patch: string, workspaceRoot: string): string[] {
  const files = new Set<string>();
  const root = resolve(workspaceRoot);
  const add = (raw: string | undefined, quoted: boolean): void => {
    if (!raw) return;
    const path = quoted ? unquotePath(`"${raw}"`) : raw;
    // Strip git's a/ and b/ prefixes, which are not part of the path.
    const stripped = path.replace(/^[ab]\//u, "");
    const rel = relative(root, resolve(root, stripped));
    if (rel && !rel.startsWith("..")) files.add(rel);
  };
  for (const match of patch.matchAll(DIFF_HEADER)) {
    add(match[1], true);
    add(match[2], false);
    add(match[3], true);
    add(match[4], false);
  }
  return [...files].sort();
}
