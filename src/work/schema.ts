export const WORK_CLASSES = [
  "host",
  "loop",
  "graph",
  "sandbox",
  "tools",
  "obs",
  "verify",
  "dash",
  // The taxonomy above names Dokkabi's own subsystems — right for
  // self-development, wordless for everyone else. A model driving a product
  // workspace reached for "impl" for plain implementation todos, the seal
  // refused the plan it had legitimately grown, and the run could not boot.
  "impl",
] as const;

export type WorkClass = (typeof WORK_CLASSES)[number];
import type { CaseSubstrate } from "./case-substrate.ts";
import type { CaseMeasurement } from "./evidence/measurements.ts";

export type CaseLayer = "unit" | "contract" | "replay";
export type CaseStatus = "red" | "green";
export type TodoState = "blocked" | "ready" | "red" | "green" | "clear";
import type { ToolProfileName } from "../loader/tool-profiles.ts";

export interface Goal {
  id: string;
  statement: string;
}

/**
 * One artifact a todo consumes or produces (#78 Phase 1).
 *
 * `id` is the logical name the plan uses to wire two todos together; `kind`
 * is the shape, so a consumer expecting one thing cannot be fed another.
 * Ports are DECLARATIONS the host checks before anything runs — `blocked_by`
 * already orders todos, but nothing said which of them needs what another
 * makes, so an undeclared dependency could only be found by executing.
 */
export interface ArtifactPort {
  id: string;
  kind: string;
}

export interface Todo {
  id: string;
  title: string;
  class: WorkClass;
  priority: number;
  blocked_by: string[];
  statement: string;
  /** Artifacts this todo needs. Each must be produced by a todo it depends
   * on, transitively — data flow has to agree with control flow. */
  consumes?: readonly ArtifactPort[];
  /** Artifacts this todo makes. An id may have exactly one producer. */
  produces?: readonly ArtifactPort[];
  /** Short display clause naming the acceptance signal. Falls back to statement. */
  judgment?: string;
  /** Short display clause naming the approach. Falls back to case layers. */
  plan?: string;
  profile?: ToolProfileName;
}

export interface Scenario {
  id: string;
  todo: string;
  given: string;
  when: string;
  then: string;
}

export interface Case {
  id: string;
  scenario: string;
  layer: CaseLayer;
  command: string;
  red_means: string;
  green_means: string;
  /**
   * A standing invariant this case protects, not work it claims: a keep-green
   * over verdicts already earned, a design gate that already passed. A guard
   * is expected to PASS from the start — green at preflight is its healthy
   * state, red means the invariant broke and the plan must not open until it
   * is repaired. Implementation cases stay RED-first; a case that is green
   * before implementation without `guard` still refuses the seal.
   */
  guard?: boolean;
  /** Candidate text is weak evidence only when the plan explicitly asks for it. */
  evidence_level?: "workspace_reported";
  /** Host-observed work, with independently checked output and typed bars. */
  measurement?: CaseMeasurement;
  /**
   * Operator-enrolled SSH alias naming WHERE this case runs. Absent means the
   * local workspace. A case whose code lives on another machine cannot be
   * judged by local bash: without this the command fails here for the wrong
   * reason, the case is red forever, and no real remote run can hold a green.
   * An alias only — a raw coordinate never passes SSH_ALIAS_PATTERN.
   */
  host?: string;
  /**
   * Working directory for a host-bound case, applied on the remote side. The
   * command allowlist refuses a `cd … &&` prefix, so the directory that holds
   * the code travels as its own field instead of being smuggled into the
   * command. Ignored for a local case.
   */
  dir?: string;
  /**
   * The fidelity this case's claim depends on, as axis=level. Which axes
   * matter is the domain's business — `database=live`, `input=production`,
   * `checkpoint=real` — and the run must report the same ones. An exit code
   * cannot tell a full-scale run from a stand-in, and a stand-in cannot fail
   * for the reason a full-scale claim asserts.
   */
  substrate?: CaseSubstrate;
  /**
   * Axis → name of a positive number the run can only obtain by doing the
   * work (`witness: <name>=<n>` in its output). Declared per case like the
   * axes themselves: a serving gate may demand queries_executed for
   * database=live, a model gate checkpoint_bytes_read for checkpoint=real.
   * Axes without one are checked by their level alone.
   */
  witness_for?: Readonly<Record<string, string>>;
  /**
   * Named bars this gate is judged by, fixed here before any run. The run must
   * echo each as `threshold: name=value`; a run applying a different bar is
   * refused. A gate that calibrates its bar from its own measurement cannot
   * fail and proves nothing — the bar lives in the plan, diffable and outside
   * the run's reach.
   */
  thresholds?: Readonly<Record<string, string>>;
  /**
   * Path globs this case's verdict actually depends on, relative to its dir.
   * With a declaration, a standing green survives host changes that do not
   * touch these paths: the verdict records a digest of exactly this state,
   * and a re-verify whose digest matches keeps the green without running.
   * Without one, any host change reopens the case (the conservative rule).
   */
  depends_on?: readonly string[];
  /**
   * Gigabytes this case's run needs on its host. The runner reads the host
   * before launching; a host that cannot host the run yields "unrunnable —
   * the host was short", never a verdict about the product. Shared nodes
   * otherwise turn a neighbour's allocation into this case's red.
   */
  needs_memory_gb?: number;
  /**
   * This case uses the accelerator on THIS machine, so it runs outside the
   * sandbox.
   *
   * The sandbox world is a user namespace, and the accelerator driver refuses
   * a process in one: binding every device node back changes nothing, and a
   * local GPU case fails to initialise for a reason that is not the case's.
   * The only accelerator the harness could reach was therefore one on another
   * machine over ssh, on boxes whose own accelerators sat idle.
   *
   * A case that declares this is executed by the host shell, in the
   * workspace, with no filesystem or network fence around it — the same
   * exposure a case with `host` already accepts on the far side of an ssh
   * call. It is a declaration, never a default: a plan says so, the log
   * records it, and every case that does not say so stays fenced.
   */
  local_accelerator?: boolean;
  /**
   * Floor on how long this case's run may take. A substrate line is
   * self-asserted; this is the operator's check on it, since loading real
   * weights at full scale cannot finish in milliseconds.
   */
  min_duration_ms?: number;
  /**
   * Absolute backstop for a run that never says anything conclusive. Not the
   * thing that decides a verdict — `done_when` / `failed_when` are.
   */
  timeout_ms?: number;
  /**
   * Regex over the run's output meaning the work finished; the run's own
   * result then decides green or red. Without it the harness can only wait out
   * a clock, which killed an eleven-minute checkpoint load at two minutes.
   */
  done_when?: string;
  /**
   * Regex meaning this run has already failed — stop now rather than waiting
   * out the ceiling for an answer that will not improve.
   */
  failed_when?: string;
  /**
   * Quiet for this long, with no completion signal, means it is not coming.
   * Output that keeps moving is progress and earns more time.
   */
  stall_after_ms?: number;
  /**
   * Regex whose match is this run's progress counter, when the built-in ones
   * (epoch, step, iteration, build count, percent) do not fit. A counter that
   * keeps changing renews the clock up to the transport ceiling; one that
   * stops changing while output continues ends the run early.
   */
  telemetry_pattern?: string;
}

export interface WorkPlan {
  goal: Goal;
  todos: Todo[];
  scenarios: Scenario[];
  cases: Case[];
  /**
   * True for plans decomposed this wave: every case must record RED before a
   * GREEN can clear its todo (docs/work.md). A first-run green is unearned
   * and sends the todo back to implementation. False (absent) for re-run
   * plans whose cases are regression tests of existing code.
   */
  require_red_first?: boolean;
}

export interface WorkView {
  /** Current execution-derived evidence policy; absent in historical projections. */
  earnedEvidence?: boolean;
  plan: WorkPlan;
  caseStatus: Record<string, CaseStatus>;
  todoState: Record<string, TodoState>;
  ready: string[];
  errors: string[];
}

export function isWorkClass(value: string): value is WorkClass {
  return (WORK_CLASSES as readonly string[]).includes(value);
}

export function isCaseLayer(value: string): value is CaseLayer {
  return value === "unit" || value === "contract" || value === "replay";
}
