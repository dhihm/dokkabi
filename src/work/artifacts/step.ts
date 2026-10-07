import { createHash } from "node:crypto";
import { canonicalJson } from "../../host/canonical.ts";
import { WORK_CLASSES } from "../schema.ts";

/**
 * Artifact-State Mesh v1 (#77): the typed documents that are the ONLY
 * contract between one work step and the next.
 *
 * Today an implement turn inherits the parent transcript — the goal, the
 * scenarios and the case commands exist for the model only because they
 * scrolled past earlier, and `prompts/work/continue.md` restates none of
 * them. A step that runs in a fresh session has no transcript to inherit,
 * so everything it is owed has to be a document: `StepInputV1` is what the
 * HOST hands the step, `PatchDiffV1` is what the step hands back.
 *
 * Both are validated fail-closed in this tree's standard idiom (exact keys,
 * `format: 1`, canonical digest — src/swarm/result-envelope.ts,
 * src/market/recipe.ts). Bodies travel as blobs under `payload.blob`; only
 * digests ride on event payloads.
 */

const HEX64 = /^[a-f0-9]{64}$/;
const HEX40 = /^[a-f0-9]{40}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
/** A step slot must be portable evidence, not a tour of this machine. */
const ABSOLUTE_PATH = /(?:^|[\s"'`(=])(?:\/[A-Za-z0-9._-]+){2,}|[A-Za-z]:\\/u;

/** The render budget. A slot is an obligation list, never a transcript. */
export const STEP_INPUT_RENDER_BYTES = 32_000;
const FAILURE_TAIL_BYTES = 2_400;

export interface StepScenario {
  readonly id: string;
  readonly given: string;
  readonly when: string;
  readonly then: string;
}

/**
 * An artifact this step is handed.
 *
 * `from` names the todo that owes it, and is present ONLY when exactly one
 * todo produces it and that todo is not this one. Ambiguous, absent, or
 * self-producing leaves it out: naming one producer out of two by array order
 * is the invented answer `reviewPortWiring` refuses, and the sibling graph
 * projection already refuses to do it.
 *
 * There is no digest. The mesh records one artifact per STEP
 * (`patch_diff_v1`), not one per declared port, so the only digest available
 * to attach identifies the step's whole patch document — not this artifact.
 * A first version attached it anyway, giving two different artifacts of two
 * different kinds the same digest and stamping a `test_file` port with a
 * `patch_diff_v1` document's identity. No gate read it and the replay
 * contract never projected it, so it was dead weight carrying a false fact.
 */
export interface ConsumedArtifact {
  readonly id: string;
  readonly kind: string;
  readonly from?: string;
}

/** An artifact this step owes. */
export interface ProducedArtifact {
  readonly id: string;
  readonly kind: string;
}

export interface StepCase {
  readonly id: string;
  readonly command: string;
  readonly green_means: string;
  /** The recorded RED tail this step must turn green. Absent when the case
   * has no verdict yet. */
  readonly failure_tail?: string;
}

export interface StepTodo {
  readonly id: string;
  readonly title: string;
  readonly class: string;
  readonly statement: string;
}

export interface StepInputV1 {
  readonly format: 1;
  readonly step_id: string;
  readonly goal: string;
  readonly todo: StepTodo;
  readonly scenarios: readonly StepScenario[];
  readonly cases: readonly StepCase[];
  /** The plan's port declarations for THIS todo (#78). Absent when it
   * declares none, which is every plan written before ports existed. */
  readonly consumes?: readonly ConsumedArtifact[];
  readonly produces?: readonly ProducedArtifact[];
}

export interface PatchDiffV1 {
  readonly format: 1;
  readonly step_id: string;
  /** sha256 of the unified diff the step produced; the diff body is a blob. */
  readonly patch_digest: string;
  /** Tree the workspace stood at BEFORE the step. Carrying it is what lets
   * a gate prove `base + patch == final` instead of merely proving the
   * patch is not corrupt — an incomplete diff reproduces a different tree. */
  readonly base_tree: string;
  /** Tree the workspace resolved to after the step. */
  readonly final_tree: string;
  /** Workspace-relative paths the step touched, sorted. */
  readonly files: readonly string[];
}

const STEP_INPUT_KEYS = ["cases", "consumes", "format", "goal", "produces", "scenarios", "step_id", "todo"] as const;
const OPTIONAL_STEP_INPUT_KEYS = ["consumes", "produces"] as const;
const CONSUMED_KEYS = ["id", "kind"] as const;
const CONSUMED_WITH_PRODUCER_KEYS = ["from", "id", "kind"] as const;
const PRODUCED_KEYS = ["id", "kind"] as const;
/** Matches plugin-runtime ARTIFACT_KIND and work/ports PORT_KIND. A kind is
 * not an id: dots are part of its charset (`dokkabi.failover_checkpoint`), and
 * validating it as an id refused every step touching such a port. */
const ARTIFACT_KIND = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const PATCH_DIFF_KEYS = ["base_tree", "files", "final_tree", "format", "patch_digest", "step_id"] as const;
const SCENARIO_KEYS = ["given", "id", "then", "when"] as const;
const TODO_KEYS = ["class", "id", "statement", "title"] as const;

function fail(message: string): never {
  throw new Error(`step artifact: ${message}`);
}

function requireObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has unknown or missing fields`);
  }
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function requireId(value: unknown, label: string): void {
  if (typeof value !== "string" || !ID.test(value)) fail(`${label} must be an id [a-z0-9_-]`);
}

/** A recorded FILE PATH must be workspace-relative: an absolute one names the
 * operator's machine and would not survive a move between a worktree and a
 * sandbox. This is an invariant of the patch's file list only. Plan PROSE is
 * content — a goal that says "read /etc/dokkabi/config.json" is describing the
 * work, and refusing it made the todo permanently unimplementable. */
function requirePortable(value: string, label: string): void {
  if (ABSOLUTE_PATH.test(value)) fail(`${label} carries an absolute path; slots are workspace-relative`);
}

export function assertStepInputV1(value: unknown): asserts value is StepInputV1 {
  requireObject(value, "step input");
  const body = value as Record<string, unknown>;
  requireExactKeys(
    body,
    // Optional keys are dropped from the required set when absent: a slot for
    // a portless todo must validate exactly as it did before ports existed.
    STEP_INPUT_KEYS.filter((key) => !OPTIONAL_STEP_INPUT_KEYS.includes(key as never) || key in body),
    "step input",
  );
  if (body.format !== 1) fail("step input format must be 1");
  requireId(body.step_id, "step_id");
  requireText(body.goal, "goal");

  requireObject(body.todo, "todo");
  const todo = body.todo as Record<string, unknown>;
  requireExactKeys(todo, TODO_KEYS, "todo");
  requireId(todo.id, "todo id");
  requireText(todo.title, "todo title");
  requireText(todo.statement, "todo statement");
  if (!(WORK_CLASSES as readonly string[]).includes(String(todo.class))) fail("todo class is invalid");

  if (!Array.isArray(body.scenarios) || body.scenarios.length === 0) fail("scenarios must be non-empty");
  for (const scenario of body.scenarios) {
    requireObject(scenario, "scenario");
    const row = scenario as Record<string, unknown>;
    requireExactKeys(row, SCENARIO_KEYS, "scenario");
    requireId(row.id, "scenario id");
    for (const field of ["given", "when", "then"] as const) {
      requireText(row[field], `scenario ${field}`);
    }
  }

  if (!Array.isArray(body.cases) || body.cases.length === 0) fail("cases must be non-empty");
  for (const item of body.cases) {
    requireObject(item, "case");
    const row = item as Record<string, unknown>;
    const keys = Object.keys(row).sort();
    const allowed = "failure_tail" in row
      ? ["command", "failure_tail", "green_means", "id"]
      : ["command", "green_means", "id"];
    if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
      fail("case has unknown or missing fields");
    }
    requireId(row.id, "case id");
    requireText(row.command, "case command");
    requireText(row.green_means, "case green_means");
    if ("failure_tail" in row) requireText(row.failure_tail, "case failure_tail");
  }

  requirePorts(body);
}

export function assertPatchDiffV1(value: unknown): asserts value is PatchDiffV1 {
  requireObject(value, "patch diff");
  const body = value as Record<string, unknown>;
  requireExactKeys(body, PATCH_DIFF_KEYS, "patch diff");
  if (body.format !== 1) fail("patch diff format must be 1");
  requireId(body.step_id, "step_id");
  if (typeof body.patch_digest !== "string" || !HEX64.test(body.patch_digest)) {
    fail("patch_digest must be a 64-character lowercase hex digest");
  }
  for (const field of ["base_tree", "final_tree"] as const) {
    if (typeof body[field] !== "string" || !HEX40.test(body[field] as string)) {
      fail(`${field} must be a 40-character lowercase hex tree id`);
    }
  }
  if (!Array.isArray(body.files)) fail("files must be an array");
  for (const file of body.files) {
    requirePortable(requireText(file, "file"), "file");
  }
}

function requireKind(value: unknown, label: string): void {
  if (typeof value !== "string" || !ARTIFACT_KIND.test(value)) {
    fail(`${label} must be an artifact kind [a-z0-9._-]`);
  }
}

function requirePorts(body: Record<string, unknown>): void {
  if ("consumes" in body) {
    if (!Array.isArray(body.consumes)) fail("consumes must be an array");
    // An empty list means "no ports", which is what ABSENT already means.
    // Two canonical documents for one meaning digest differently.
    if (body.consumes.length === 0) fail("consumes must be omitted when empty");
    for (const entry of body.consumes) {
      requireObject(entry, "consumed artifact");
      const row = entry as Record<string, unknown>;
      requireExactKeys(row, "from" in row ? CONSUMED_WITH_PRODUCER_KEYS : CONSUMED_KEYS, "consumed artifact");
      requireId(row.id, "consumed artifact id");
      requireKind(row.kind, "consumed artifact kind");
      if ("from" in row) requireId(row.from, "consumed artifact producer");
    }
  }
  if ("produces" in body) {
    if (!Array.isArray(body.produces)) fail("produces must be an array");
    if (body.produces.length === 0) fail("produces must be omitted when empty");
    for (const entry of body.produces) {
      requireObject(entry, "produced artifact");
      const row = entry as Record<string, unknown>;
      requireExactKeys(row, PRODUCED_KEYS, "produced artifact");
      requireId(row.id, "produced artifact id");
      requireKind(row.kind, "produced artifact kind");
    }
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function stepInputDigest(input: StepInputV1): string {
  assertStepInputV1(input);
  return digest(input);
}

export function patchDiffDigest(input: PatchDiffV1): string {
  assertPatchDiffV1(input);
  return digest(input);
}

/** The cap INCLUDES the ellipsis: a budget that its own marker can exceed
 * is not a budget. */
function clip(text: string, bytes: number): string {
  return text.length <= bytes ? text : `${text.slice(0, Math.max(0, bytes - 1))}…`;
}

/** Ports are a declaration list, not a transcript: past this many the step
 * is not being told anything more, only spending its budget. */
const RENDERED_PORTS = 16;

function pushPorts<T>(
  lines: string[],
  heading: string,
  ports: readonly T[] | undefined,
  render: (port: T) => string,
): void {
  if (!ports || ports.length === 0) return;
  lines.push("", heading);
  for (const port of ports.slice(0, RENDERED_PORTS)) lines.push(render(port));
  if (ports.length > RENDERED_PORTS) {
    lines.push(`…그리고 ${ports.length - RENDERED_PORTS}개 더`);
  }
}

/**
 * The step's whole world, as text. Deterministic: the same input renders the
 * same bytes, so a step's slot is reproducible from its recorded artifact.
 * Bounded: a slot that grew with the run would be the transcript again.
 */
export function renderStepInput(input: StepInputV1): string {
  assertStepInputV1(input);
  const lines: string[] = [
    `## 목표`,
    input.goal,
    "",
    `## 이 스텝의 TODO`,
    `${input.todo.id} (${input.todo.class}) — ${input.todo.title}`,
    input.todo.statement,
    "",
    `## 시나리오`,
  ];
  for (const scenario of input.scenarios) {
    lines.push(`${scenario.id}`, `- Given ${scenario.given}`, `- When ${scenario.when}`, `- Then ${scenario.then}`);
  }
  lines.push("", `## 케이스 (이 명령이 GREEN이어야 한다)`);
  for (const item of input.cases) {
    lines.push(`${item.id}: ${item.command}`, `- green: ${clip(item.green_means, 400)}`);
    if (item.failure_tail) {
      lines.push(`- 마지막 RED:`, clip(item.failure_tail, FAILURE_TAIL_BYTES));
    }
  }
  // Ports come AFTER the cases and bounded. Every other unbounded field here
  // is clipped individually; putting an uncapped list before the step's one
  // obligation let a port-heavy plan push the cases out of the budget
  // entirely, which is backwards.
  pushPorts(lines, `## 넘겨받은 산출물`, input.consumes, (port) =>
    `${port.id} (${port.kind})${port.from ? ` — ${port.from}` : ""}`);
  pushPorts(lines, `## 이 스텝이 내야 하는 산출물`, input.produces, (port) =>
    `${port.id} (${port.kind})`);
  return clip(lines.join("\n"), STEP_INPUT_RENDER_BYTES);
}
