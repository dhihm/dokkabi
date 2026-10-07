import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Case, Scenario, WorkPlan } from "./schema.ts";
import { isWorkClass } from "./schema.ts";
import { caseTestFile } from "./validate.ts";

/**
 * Host-side completion of a graph that has todos/edges but forgot scenarios
 * and cases. Does not invent product code.
 *
 * Case strategy (avoids the locate↔fix deadlock):
 * - **locate** (and unknown): bun test that goes green when `work/REPRO.md`
 *   exists — model can clear without the product fix.
 * - **fix / verify**: if the goal names `tests/...` (FAIL_TO_PASS), use
 *   `python -m pytest -q <that>` so green means the real bug is fixed.
 *   Otherwise fall back to a REPRO-style marker for that todo.
 */
/**
 * Hoist scenario/case OBJECTS a model nested inside todos up to the
 * top-level arrays. The content is the model's — only the location moves.
 * String entries (["scn-a"]) are id back-references and stay untouched.
 */
function hoistNestedChecks(plan: WorkPlan): { plan: WorkPlan; added: string[] } {
  const added: string[] = [];
  const scenarios = [...(plan.scenarios ?? [])];
  const cases = [...(plan.cases ?? [])];
  const scenarioIds = new Set(scenarios.map((s) => s.id));
  const caseIds = new Set(cases.map((c) => c.id));
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const str = (value: unknown): string => (typeof value === "string" ? value : "");

  const todos = (plan.todos ?? []).map((todo) => {
    const raw = todo as unknown as Record<string, unknown>;
    const nestedScenarios = Array.isArray(raw.scenarios) ? raw.scenarios.filter(isRecord) : [];
    const nestedCases = Array.isArray(raw.cases) ? raw.cases.filter(isRecord) : [];
    if (nestedScenarios.length === 0 && nestedCases.length === 0) {
      return todo;
    }
    // Old nested id → hoisted top-level id, so nested cases keep their link.
    const idMap = new Map<string, string>();
    let firstScenarioId: string | undefined;
    nestedScenarios.forEach((obj, index) => {
      const id = str(obj.id) || `scn-${todo.id}-${index + 1}`;
      // A nested object whose id already exists top-level is the model
      // duplicating its own content — a back-reference, not new material.
      // Hoisting it would double the plan (run 7 minted -h copies).
      if (scenarioIds.has(id)) {
        idMap.set(id, id);
        firstScenarioId = firstScenarioId ?? id;
        return;
      }
      if (str(obj.id)) {
        idMap.set(str(obj.id), id);
      }
      scenarioIds.add(id);
      firstScenarioId = firstScenarioId ?? id;
      scenarios.push({
        id,
        todo: todo.id,
        given: str(obj.given),
        when: str(obj.when),
        then: str(obj.then),
      });
      added.push(`hoist scenario ${id} ← ${todo.id}`);
    });
    nestedCases.forEach((obj, index) => {
      const id = str(obj.id) || `case-${todo.id}-${index + 1}`;
      if (caseIds.has(id)) {
        return;
      }
      caseIds.add(id);
      const ref = str(obj.scenario);
      const scenario =
        (ref && (idMap.get(ref) ?? (scenarioIds.has(ref) ? ref : undefined))) ??
        firstScenarioId ??
        ref;
      cases.push({
        id,
        scenario,
        layer: (str(obj.layer) || "unit") as Case["layer"],
        command: str(obj.command),
        red_means: str(obj.red_means),
        green_means: str(obj.green_means),
        ...(str(obj.host) ? { host: str(obj.host) } : {}),
        ...(str(obj.dir) ? { dir: str(obj.dir) } : {}),
      });
      added.push(`hoist case ${id} ← ${todo.id}`);
    });
    // Strip the nested keys: the seal refuses inline objects.
    const { scenarios: _s, cases: _c, ...rest } = raw;
    if (Array.isArray(raw.scenarios) && raw.scenarios.some((item) => typeof item === "string")) {
      (rest as Record<string, unknown>).scenarios = raw.scenarios.filter((item) => typeof item === "string");
    }
    return rest as unknown as typeof todo;
  });
  return { plan: { ...plan, todos, scenarios, cases }, added };
}

/** Fill missing case red/green means so a nearly-valid model plan can seal. */
/** String values of a wrong-shaped leaf, in writing order. */
function flatStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(flatStrings);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(flatStrings);
  }
  return [];
}

/**
 * Shape-only pass: hoist nested scenario/case objects and flatten object
 * statements. Does not invent ids, classes, or red/green wording — those
 * stay in `normalizePlanFields` (repair/scaffold). `loadWorkPlan` uses this
 * so an implement rewrite that puts statement back to an object still seals
 * (runs 37/38/39).
 */
export function flattenPlanLeaves(plan: WorkPlan): { plan: WorkPlan; added: string[] } {
  const hoisted = hoistNestedChecks(plan);
  plan = hoisted.plan;
  const added: string[] = [...hoisted.added];
  // Small models write statement as an OBJECT ({"title": …, "judgment": …})
  // on nearly every decompose (runs 20/23/26). The words are the model's own;
  // flattening the shape is normalization, not authoring.
  if (plan.goal && typeof plan.goal.statement === "object" && plan.goal.statement !== null) {
    const flat = flatStrings(plan.goal.statement).join(" — ");
    if (flat) {
      plan = { ...plan, goal: { ...plan.goal, statement: flat } };
      added.push("goal statement flattened");
    }
  }
  const todos = (plan.todos ?? []).map((todo, index) => {
    let next = todo;
    if (typeof next.statement === "object" && next.statement !== null) {
      const shaped = next.statement as Record<string, unknown>;
      const hoistedTitle =
        !next.title && typeof shaped.title === "string" && shaped.title.trim()
          ? shaped.title.trim()
          : undefined;
      const rest = hoistedTitle
        ? Object.entries(shaped)
            .filter(([key]) => key !== "title")
            .flatMap(([, value]) => flatStrings(value))
        : flatStrings(shaped);
      const flat = rest.join(" — ");
      if (flat || hoistedTitle) {
        next = {
          ...next,
          ...(hoistedTitle ? { title: hoistedTitle } : {}),
          statement: flat || hoistedTitle || "",
        };
        added.push(`statement flattened ${next.id || `todo-${index + 1}`}`);
      }
    }
    return next;
  });
  return { plan: { ...plan, todos }, added };
}

export function normalizePlanFields(plan: WorkPlan): { plan: WorkPlan; added: string[] } {
  const leaves = flattenPlanLeaves(plan);
  plan = leaves.plan;
  const added: string[] = [...leaves.added];
  // Todos with no id/title/statement cannot seal; backfill deterministically
  // by position so a small model's fieldless DAG still opens a graph.
  const todos = (plan.todos ?? []).map((todo, index) => {
    let next = todo;
    if (!next.id) {
      next = { ...next, id: `todo-${index + 1}` };
      added.push(`id ${next.id}`);
    }
    if (!next.title) {
      next = { ...next, title: next.id };
      added.push(`title ${next.id}`);
    }
    if (!next.statement) {
      next = { ...next, statement: next.title };
      added.push(`statement ${next.id}`);
    }
    if (!isWorkClass(next.class)) {
      next = { ...next, class: "verify" };
      added.push(`class ${next.id}`);
    }
    return next;
  });
  // Dangling blocked_by stays on the todo. validatePlan refuses unknown ids
  // so the model must name a real predecessor — the host does not delete edges.
  const cases = (plan.cases ?? []).map((item) => {
    let next = item;
    if (!item.red_means) {
      next = { ...next, red_means: "fails until the deliverable exists" };
      added.push(`red_means ${item.id}`);
    }
    if (!item.green_means) {
      next = { ...next, green_means: "passes when the deliverable works" };
      added.push(`green_means ${item.id}`);
    }
    return next;
  });
  return { plan: { ...plan, todos, cases }, added };
}

export function scaffoldMissingPlanChecks(
  plan: WorkPlan,
  workspaceRoot: string,
  /** Extra text (operator order) scanned for FAIL_TO_PASS paths. */
  orderHint?: string,
): { plan: WorkPlan; added: string[] } {
  const normalized = normalizePlanFields(plan);
  const added: string[] = [...normalized.added];
  plan = normalized.plan;
  const todoIds = new Set(plan.todos.map((todo) => todo.id));
  const todos = plan.todos.map((todo) => {
    const blockers = todo.blocked_by ?? [];
    const kept = blockers.filter((id) => todoIds.has(id));
    const stale = blockers.filter((id) => !todoIds.has(id));
    if (stale.length === 0) {
      return todo;
    }
    added.push(`pruned blocked_by ${todo.id}: ${stale.join(", ")}`);
    return { ...todo, blocked_by: kept };
  });
  plan = { ...plan, todos };
  const scenarios = [...(plan.scenarios ?? [])];
  const cases = [...(plan.cases ?? [])];
  const scenarioIds = new Set(scenarios.map((s) => s.id));
  const casesByScenario = new Map<string, Case[]>();
  for (const item of cases) {
    const list = casesByScenario.get(item.scenario) ?? [];
    list.push(item);
    casesByScenario.set(item.scenario, list);
  }

  const required = extractRequiredTests(
    `${plan.goal?.statement ?? ""}\n${orderHint ?? ""}`,
  );
  const pytestTarget = required[0];
  if (pytestTarget) {
    added.push(`pytest_target ${pytestTarget}`);
  }

  for (const todo of plan.todos ?? []) {
    let todoScenarios = scenarios.filter((s) => s.todo === todo.id);
    if (todoScenarios.length === 0) {
      const id = `scn-${todo.id.replace(/^todo-/, "")}`;
      if (!scenarioIds.has(id)) {
        const scenario: Scenario = {
          id,
          todo: todo.id,
          given: `Starting from the workspace before ${todo.id}.`,
          when: `The work for ${todo.id} runs.`,
          then: `Evidence shows ${todo.id} is done.`,
        };
        scenarios.push(scenario);
        scenarioIds.add(id);
        todoScenarios = [scenario];
        added.push(`scenario ${id}`);
      }
    }
    for (const scenario of todoScenarios) {
      if ((casesByScenario.get(scenario.id) ?? []).length > 0) {
        continue;
      }
      const caseId = `case-${scenario.id.replace(/^scn-/, "")}`;
      const kind = classifyTodo(todo.id);
      let command: string;
      let red_means: string;
      let green_means: string;
      if ((kind === "fix" || kind === "verify") && pytestTarget) {
        // The prepared interpreter, not ambient `python` — sandboxed runs mask
        // /tmp and ambient site-packages, so only the adapter's python is honest.
        command = `"\${DOKKABI_SWE_PYTHON:-python}" -m pytest -q -W ignore::DeprecationWarning ${pytestTarget}`;
        red_means = "FAIL_TO_PASS still red";
        green_means = "FAIL_TO_PASS green after the product fix";
      } else {
        const relTest = `tests/${caseId}.test.ts`;
        const marker = kind === "locate" ? "work/REPRO.md" : `work/DONE-${todo.id}.md`;
        command = `bun test ${relTest}`;
        red_means = `missing ${marker}`;
        green_means = `${marker} documents the step`;
        ensureMarkerTest(workspaceRoot, relTest, caseId, marker, added);
      }
      const item: Case = {
        id: caseId,
        scenario: scenario.id,
        layer: kind === "verify" ? "contract" : "unit",
        command,
        red_means,
        green_means,
      };
      cases.push(item);
      const list = casesByScenario.get(scenario.id) ?? [];
      list.push(item);
      casesByScenario.set(scenario.id, list);
      added.push(`case ${caseId}`);
    }
  }

  // Upgrade fix/verify bun stubs to real FAIL_TO_PASS when we know the path.
  if (pytestTarget) {
    for (let i = 0; i < cases.length; i += 1) {
      const item = cases[i]!;
      const scenario = scenarios.find((s) => s.id === item.scenario);
      const todo = (plan.todos ?? []).find((t) => t.id === scenario?.todo);
      const kind = classifyTodo(todo?.id ?? item.id);
      if (
        (kind === "fix" || kind === "verify") &&
        /\bbun\s+test\b/i.test(item.command)
      ) {
        cases[i] = {
          ...item,
          command: `"\${DOKKABI_SWE_PYTHON:-python}" -m pytest -q -W ignore::DeprecationWarning ${pytestTarget}`,
          red_means: item.red_means || "FAIL_TO_PASS still red",
          green_means: item.green_means || "FAIL_TO_PASS green after the product fix",
        };
        added.push(`upgrade ${item.id} → pytest`);
      }
    }
  }

  // Ensure any remaining bun case command still has a file.
  for (const item of cases) {
    const file = caseTestFile(item.command);
    if (file && item.command.includes("bun test")) {
      ensureMarkerTest(
        workspaceRoot,
        file,
        item.id,
        "work/REPRO.md",
        added,
      );
    }
  }

  return {
    plan: { ...plan, scenarios, cases },
    added,
  };
}

/** Pull tests/… paths (optional ::node) from order / goal text. */
export function extractRequiredTests(text: string): string[] {
  const out: string[] = [];
  // Both suite layouts: most repos test in tests/, pytest itself in testing/.
  // Node ids are file::Class::method[param] — the file part must not eat ::.
  for (const match of text.matchAll(/(?:tests|testing)\/[^\s:]+(?:\.py)?(?:::[\w.\[\]-]+)+/g)) {
    if (!out.includes(match[0])) {
      out.push(match[0]);
    }
  }
  return out;
}

function classifyTodo(id: string): "locate" | "fix" | "verify" | "other" {
  const s = id.toLowerCase();
  if (s.includes("locate") || s.includes("repro") || s.includes("find")) {
    return "locate";
  }
  if (s.includes("verify") || s.includes("prove") || s.includes("check")) {
    return "verify";
  }
  if (s.includes("fix") || s.includes("patch") || s.includes("implement")) {
    return "fix";
  }
  return "other";
}

function ensureMarkerTest(
  root: string,
  rel: string,
  caseId: string,
  marker: string,
  added: string[],
): void {
  const absolute = join(root, rel);
  if (existsSync(absolute)) {
    return;
  }
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(
    absolute,
    [
      `// GREEN when ${marker} exists with content (locate/repro evidence).`,
      `import { existsSync, readFileSync } from "node:fs";`,
      `import { test, expect } from "bun:test";`,
      `test(${JSON.stringify(caseId)}, () => {`,
      `  expect(existsSync(${JSON.stringify(marker)})).toBe(true);`,
      `  expect(readFileSync(${JSON.stringify(marker)}, "utf8").trim().length).toBeGreaterThan(20);`,
      `});`,
      "",
    ].join("\n"),
    "utf8",
  );
  added.push(`stub ${rel} → ${marker}`);
}
