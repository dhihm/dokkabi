import type { ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../../host/canonical.ts";
import { EventLog } from "../../host/event-log.ts";
import { parseReplayEvents } from "../../host/replay-audit.ts";
import type { EventRecord } from "../../host/schema.ts";
import { buildSweAgentCommand } from "../swe-bench/agent-command.ts";
import { beginComparatorArtifact, freezeComparatorArtifact } from "./comparator-artifact.ts";
import { normalizeClaudeStream, normalizeDokkabiSessions, joinDokkabiSessions, type DokkabiSessionObservation } from "./comparators.ts";
import { snapshotSessionBytes } from "./checkpoint.ts";
import { durableResearchFile, researchHash, researchRead, type ResearchAttemptHome } from "./environment.ts";
import { expandExperimentManifest } from "./manifest.ts";
import { researchProcessExitArtifact, superviseResearchProcess, type ResearchAttemptIdentity } from "./runner.ts";
import { sha256Schema, type Artifact, type Attempt, type ExternalEnvelope } from "./schema.ts";
import { WORK_DEADLINE_ENV } from "../../work/review-budget.ts";
import { TOOL_PROFILE_NAMES } from "../../loader/tool-profiles.ts";

const absolute = z.string().refine(isAbsolute, "absolute path required");
const model = z.string().min(1).refine(value => !/^(auto|default|opus|sonnet|haiku)$/iu.test(value) && !/latest/iu.test(value), "explicit model identifier required");
const common = { executable: absolute, version: z.string().min(1), sha256: sha256Schema, model };
export const comparatorArmSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("claude-code"), ...common, effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
    max_turns: z.number().int().positive(), max_budget_usd: z.number().positive(), allowed_tools: z.array(z.string().min(1)).min(1) }),
  z.strictObject({ kind: z.literal("dokkabi"), ...common, repo_root: absolute, route: z.string().min(1),
    max_steps: z.number().int().positive(), heung: z.boolean(), loop: z.enum(["graph", "model"]).default("graph"),
    planner: z.enum(["host", "model", "ledger"]).default("host"),
    // The session's tool profile (D39). Absent is the unflagged default, and
    // the launch names it only when the spec asked for one — the verified-work
    // chain's verify stage asks for `verify`, which is what puts the `defect`
    // tool in front of the session that has to report through it.
    tool_profile: z.enum(TOOL_PROFILE_NAMES).optional(),
    authority_files: z.array(z.strictObject({ path: absolute, sha256: sha256Schema })).min(1) }),
]);
export type ComparatorArm = z.infer<typeof comparatorArmSchema>;
export type ComparatorArmInput = z.input<typeof comparatorArmSchema>;
/** Repo-relative files the Dokkabi arm hard-pins before dispatch, verified
 * from the repo root. The model loop adds its plugin manifest and system
 * prompt so the slim surface is pinned exactly like the graph surface. */
export function dokkabiAuthorityClosure(arm: { repo_root: string; loop: "graph" | "model"; planner: "host" | "model" | "ledger";
  authority_files: readonly { path: string; sha256: string }[] }): { path: string; sha256: string }[] {
  const required = ["src/cli.ts", "plugins/manifest.json", "package.json", "bun.lock",
    ...(arm.loop === "model" ? ["plugins/manifest.model-loop.json", "prompts/model-loop/system.md"] : []),
    ...(arm.planner === "model" ? ["prompts/work/plan-v2.md", "plugins/manifest.plan-v2.json"] : []),
    // A comparator arm always launches with the research policy enrolled, and
    // boot maps the surface manifest to its research variant
    // (eval/experiment/plugin-manifest.ts), so the ledger surface a research
    // run boots is manifest.research.ledger.json. manifest.ledger.json is only
    // the name that lookup is keyed by; pinning it would pin a file no run
    // reads, which is a claim of authority over nothing.
    ...(arm.planner === "ledger" ? ["prompts/work/ledger.md", "plugins/manifest.research.ledger.json"] : [])];
  const closure: { path: string; sha256: string }[] = [];
  for (const path of required) {
    const file = arm.authority_files.find(file => file.path === join(arm.repo_root, path));
    if (!file) throw new Error("Dokkabi runtime authority closure is incomplete");
    if (researchHash(researchRead(dirname(file.path), basename(file.path))) !== file.sha256) throw new Error("Dokkabi runtime authority closure changed");
    closure.push(file);
  }
  return closure;
}
export function buildComparatorCommand(raw: ComparatorArmInput, home: ResearchAttemptHome, session: string, prompt: string): { argv: string[]; env: Record<string, string> } {
  const arm = comparatorArmSchema.parse(raw);
  if (arm.kind === "claude-code") {
    const env = Object.fromEntries(Object.entries(home.environment).filter(([key]) => !key.startsWith("DOKKABI_")));
    return { argv: [arm.executable, "--print", "--verbose", "--output-format", "stream-json", "--forward-subagent-text",
      "--no-session-persistence", "--safe-mode", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--model", arm.model, "--effort", arm.effort, "--max-turns", String(arm.max_turns), "--max-budget-usd", String(arm.max_budget_usd),
      "--permission-mode", "acceptEdits", "--allowedTools", arm.allowed_tools.join(","), "--", prompt],
      env: { ...env, CLAUDE_CONFIG_DIR: join(home.home, ".claude"), ANTHROPIC_DEFAULT_OPUS_MODEL: arm.model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: arm.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: arm.model, CLAUDE_CODE_SUBAGENT_MODEL: arm.model } };
  }
  if (arm.model !== home.environment.DOKKABI_MODEL || arm.route !== home.environment.DOKKABI_ROUTE) throw new Error("Dokkabi launch model/route differs from prepared home");
  const command = buildSweAgentCommand({ repoRoot: arm.repo_root, sessionId: session, workspace: home.workspace, order: prompt,
    maxSteps: arm.max_steps, workTimeoutMs: 1, crunch: arm.heung, swarm: false, route: arm.route, modelId: arm.model, loop: arm.loop,
    planner: arm.planner, ...(arm.tool_profile === undefined ? {} : { toolProfile: arm.tool_profile }) });
  return { argv: [arm.executable, ...command.argv.slice(1)], env: { ...home.environment, ...command.env } };
}
export interface ComparatorExecutionInput {
  study: string; controlRoot: string; attempt: ResearchAttemptIdentity; phaseRoot: string;
  home: ResearchAttemptHome; arm: ComparatorArmInput; prompt: string; git: string; timeoutMs: number; graceMs?: number;
  onSpawn?: (child: ChildProcess) => void;
}

/** Native execution has the same supervisor, immutable attempt identity and
 * collector schema as Dokkabi. No benchmark evaluator runs in the agent loop. */
export async function executeComparatorAttempt(input: ComparatorExecutionInput) {
  const arm = comparatorArmSchema.parse(input.arm), manifestPath = join(input.study, "manifest.json");
  const manifestBytes = researchRead(input.study, "manifest.json");
  const scheduled = expandExperimentManifest(JSON.parse(manifestBytes.toString("utf8"))).scheduled.find(row => row.key === input.attempt.scheduled_key);
  if (!scheduled || (scheduled.system !== "mixed" && scheduled.system !== (arm.kind === "dokkabi" ? "dokkabi" : "external"))) throw new Error("comparator does not match its scheduled condition");
  if (arm.kind === "dokkabi") {
    dokkabiAuthorityClosure(arm);
    for (const file of arm.authority_files) {
      if (researchHash(researchRead(dirname(file.path), basename(file.path))) !== file.sha256) throw new Error("Dokkabi runtime authority closure changed");
    }
    const reader = join(arm.repo_root, "src/work/evidence/earned.ts");
    const authority = arm.authority_files.find(file => file.path === reader);
    if (!authority || researchHash(researchRead(dirname(reader), basename(reader))) !== authority.sha256) throw new Error("Dokkabi evaluator input preflight is not pinned");
    const { captureEvaluatorInputs } = await import(reader) as typeof import("../../work/evidence/earned.ts");
    const evaluatorInputs = captureEvaluatorInputs();
    durableResearchFile(join(input.controlRoot, "runtime-inputs.json"), canonicalJson({ schema_version: 1, inputs: evaluatorInputs }) + "\n");
  }
  const launch = buildComparatorCommand(arm, input.home, input.attempt.id, input.prompt);
  if (researchHash(readFileSync(arm.executable)) !== arm.sha256) throw new Error("comparator executable authority changed");
  const started = process.hrtime.bigint();
  // The loop identity is repeated at the top level so a reader can grep it
  // without descending into the arm; the model-loop closure lists the two
  // files that distinguish that surface from the graph loop.
  const loop = arm.kind === "dokkabi" ? arm.loop : null;
  const planner = arm.kind === "dokkabi" ? arm.planner : null;
  const modelLoopAuthority = arm.kind === "dokkabi" && arm.loop === "model"
    ? arm.authority_files.filter(file => file.path === join(arm.repo_root, "plugins/manifest.model-loop.json") || file.path === join(arm.repo_root, "prompts/model-loop/system.md"))
    : [];
  // The planner surface closure lists the plan-v2 prompt and plugin manifest
  // that distinguish the model planner from the host planner.
  const planV2Authority = arm.kind === "dokkabi" && arm.planner === "model"
    ? arm.authority_files.filter(file => file.path === join(arm.repo_root, "prompts/work/plan-v2.md") || file.path === join(arm.repo_root, "plugins/manifest.plan-v2.json"))
    : [];
  // The ledger surface closure lists the two files a ledger research run reads
  // and no other planner does: its prompt and the research manifest it boots.
  const ledgerAuthority = arm.kind === "dokkabi" && arm.planner === "ledger"
    ? arm.authority_files.filter(file => file.path === join(arm.repo_root, "prompts/work/ledger.md")
      || file.path === join(arm.repo_root, "plugins/manifest.research.ledger.json"))
    : [];
  durableResearchFile(join(input.controlRoot, "comparator.json"), canonicalJson({ schema_version: 1, arm, loop, planner, model_loop_authority: modelLoopAuthority,
    plan_v2_authority: planV2Authority, ledger_authority: ledgerAuthority,
    prompt_sha256: researchHash(input.prompt), usage_policy: "all-observed-models-and-sessions", oracle: "not-run", cache_policy: "cold-private-home" }) + "\n");
  const capture = beginComparatorArtifact(input.home.workspace, input.controlRoot, input.git);
  let child: ChildProcess | undefined, interrupted: string | null = null;
  const interrupt = (signal: NodeJS.Signals) => { interrupted = signal; if (child?.pid) { try { process.kill(-child.pid, signal); } catch { /* Supervisor retains the physical exit. */ } } };
  const sigterm = () => interrupt("SIGTERM"), sigint = () => interrupt("SIGINT");
  process.on("SIGTERM", sigterm); process.on("SIGINT", sigint);
  let result: Awaited<ReturnType<typeof superviseResearchProcess>>;
  try {
    // Share the supervisor's allowance with review. This starts conservatively
    // before supervisor admission; the existing process timeout still enforces
    // the outer ceiling. A review cannot acquire a fresh phase-sized budget.
    if (arm.kind === "dokkabi") launch.env[WORK_DEADLINE_ENV] = String(Date.now() + input.timeoutMs);
    result = await superviseResearchProcess({ controlRoot: input.controlRoot, attempt: input.attempt, phaseRoot: input.phaseRoot,
      command: { start: launch.argv }, cwd: input.home.workspace, environment: launch.env, timeoutMs: input.timeoutMs, graceMs: input.graceMs,
      ...(arm.kind === "dokkabi" ? { childLog: join(input.home.dokkabiHome, "sessions", input.attempt.id, "events.jsonl") } : {}),
      authorityFiles: [{ path: arm.executable, sha256: arm.sha256 }, { path: manifestPath, sha256: researchHash(manifestBytes) },
        ...(arm.kind === "dokkabi" ? arm.authority_files : [])], candidateFiles: input.home.inputs,
      onSpawn: processChild => { child = processChild; if (interrupted) interrupt(interrupted as NodeJS.Signals); input.onSpawn?.(processChild); } });
  } finally { process.off("SIGTERM", sigterm); process.off("SIGINT", sigint); }
  const issues: string[] = [];
  let artifact: ReturnType<typeof freezeComparatorArtifact> | null = null;
  try { artifact = freezeComparatorArtifact(capture); } catch { issues.push("final_artifact_capture_failed"); }
  const taskTimeMs = Number(process.hrtime.bigint() - started) / 1e6;
  if (interrupted) issues.push("controller_interrupted");
  if (result.status !== "exited") issues.push("process_not_successful");
  const artifacts: Artifact[] = [], sessions: Attempt["sessions"] = [], native: DokkabiSessionObservation[] = [];
  const source = { system: "external" as const, producer: "harness-comparison-adapter", version: "1" };
  const add = (suffix: string, kind: Artifact["kind"], bytes: Buffer | string, refs: Artifact["references"] = [], producer: Artifact["source"] = source) => {
    const id = `${input.attempt.id}-${suffix}`, path = join(input.controlRoot, `${suffix}.${kind === "dokkabi_log" ? "jsonl" : "artifact"}`);
    durableResearchFile(path, bytes);
    const descriptor: Artifact = { id, kind, path: relative(input.study, path), sha256: researchHash(bytes), source: producer, references: refs };
    artifacts.push(descriptor); return id;
  };
  const patch = artifact ? add("patch", "patch", readFileSync(artifact.patch.path), [{ relation: "scope", artifact: scheduled.scope }]) : `${input.attempt.id}-missing-patch`;
  const refs = [{ relation: "scope", artifact: scheduled.scope }, { relation: "patch", artifact: patch },
    { relation: "oracle", artifact: scheduled.oracle }, { relation: "rubric", artifact: scheduled.rubric }];
  const blobRefs: Artifact["references"] = [];
  for (const name of [result.stdout, result.stderr, `invocation-${result.invocation}.json`, "launch.json", "comparator.json"]) {
    blobRefs.push({ relation: "native-source", artifact: add(`raw-${blobRefs.length}`, "blob", researchRead(input.controlRoot, name)) });
  }
  let parentEvents: readonly EventRecord[] = [];
  if (arm.kind === "dokkabi") {
    let names: string[] = [];
    try { names = readdirSync(join(input.home.dokkabiHome, "sessions")).sort(); } catch { issues.push("dokkabi_sessions_unavailable"); }
    for (const [index, id] of names.entries()) {
      const path = join(input.home.dokkabiHome, "sessions", id, "events.jsonl");
      let events: readonly EventRecord[] | null = null;
      try {
        const snap = snapshotSessionBytes(path), references: Artifact["references"] = [];
        for (const [file, bytes] of snap.files) if (file !== "events.jsonl") references.push({ relation: "blob", artifact: add(`s${index}-b${references.length}`, "blob", bytes) });
        events = snap.events;
        const log = add(`s${index}-log`, "dokkabi_log", snap.bytes, references, { system: "dokkabi", producer: "dokkabi", version: arm.version });
        const parent = events.find(row => row.name === "session/parent");
        const role = parent?.payload.role;
        sessions.push({ id, log, role: id === input.attempt.id ? "parent" : role === "spec" || role === "verifier" ? role : "child",
          parent: id === input.attempt.id ? null : typeof parent?.payload.parent_session === "string" ? parent.payload.parent_session : null });
      } catch {
        issues.push("dokkabi_snapshot_incomplete");
        // Retain parseable raw usage even if the stronger blob/replay snapshot
        // failed. This fallback never promotes the raw log to replay-qualified.
        try { const bytes = researchRead(dirname(path), basename(path)); add(`s${index}-raw`, "blob", bytes); events = parseReplayEvents(bytes.toString("utf8")); } catch { /* Unknown remains unknown. */ }
      }
      native.push({ id, events }); if (id === input.attempt.id && events) parentEvents = events;
    }
  }
  const observed = arm.kind === "claude-code" ? normalizeClaudeStream(researchRead(input.controlRoot, result.stdout).toString("utf8"), arm.model)
    : normalizeDokkabiSessions(native, arm.model, input.attempt.id);
  const sessionLinks = joinDokkabiSessions(input.attempt.id, native);
  for (const session of sessions) Object.assign(session, sessionLinks.get(session.id));
  if (arm.kind === "dokkabi" && !input.home.environment.DOKKABI_RESEARCH_POLICY) issues.push("dokkabi_request_guard_not_enrolled");
  const normalized = add("observation", "blob", canonicalJson({ ...observed, process: result, task_time_ms: taskTimeMs, issues: [...issues, ...observed.issues] }) + "\n", [...refs, ...blobRefs]);
  function external(suffix: string, kind: ExternalEnvelope["kind"], value: unknown) {
    return add(suffix, kind, canonicalJson({ schema_version: 1, kind, source, scheduled_key: input.attempt.scheduled_key,
      attempt_id: input.attempt.id, references: refs, value }) + "\n", refs);
  }
  let processExit: string | null = null;
  if (result.exit_code !== null || result.signal !== null) {
    const body = researchProcessExitArtifact(result, scheduled.scope, patch, "1");
    body.source = source;
    processExit = add("exit", "process_exit", canonicalJson(body) + "\n", body.references);
  }
  const harness = external("harness", "harness_result", observed.harness);
  const journal = external("journal", "journal", { reason: "comparison-evaluation-pending", text: `Native observation artifact ${normalized}; external task verdict and completion-claim classification are pending.` });
  const log = sessions.find(row => row.id === input.attempt.id)?.log;
  const eventRef = (names: string[]) => {
    const event = parentEvents.filter(row => names.includes(row.name)).at(-1);
    return event && log ? { artifact: log, seq: event.seq, hash: event.hash } : null;
  };
  const attempt: Attempt = { ...input.attempt, sessions, bindings: { terminal: eventRef(["work/run_result"]), acceptance: eventRef(["work/accept"]),
    graph: eventRef(["graph/snapshot", "graph/apply"]), scope: scheduled.scope, patch, process_exit: processExit, oracle: null,
    labels: [], harness: [harness], journal: [journal] } };
  const inventory = { schema_version: 1 as const, manifest_sha256: researchHash(manifestBytes), artifacts, attempts: [attempt], exclusions: [] };
  durableResearchFile(join(input.controlRoot, "inventory.json"), canonicalJson(inventory) + "\n");
  const report = { schema_version: 1, attempt: input.attempt, arm: arm.kind, process: result, artifact, observation: observed,
    issues: [...issues, ...observed.issues], task_time_ms: taskTimeMs, inventory };
  const reportBytes = canonicalJson(report) + "\n";
  durableResearchFile(join(input.controlRoot, "comparison-result.json"), reportBytes);
  EventLog.create(join(input.controlRoot, "supervisor.jsonl")).appendDurable({ kind: "observe", name: "research/comparator_result", payload: {
    attempt_id: input.attempt.id, source_system: arm.kind === "claude-code" ? "external" : "dokkabi", harness: arm.kind,
    result: "comparison-result.json", result_sha256: researchHash(reportBytes), observation_artifact: normalized,
    patch_sha256: artifact?.patch.sha256 ?? null, status: observed.harness.status, usage: observed.usage,
    task_time_ms: taskTimeMs, issues: report.issues, oracle: "not-run",
  } });
  return report;
}

/** Rebuild from immutable per-attempt pieces. Registered incomplete attempts
 * remain rows; no interrupted invocation is silently turned into never-started. */
export function collectComparatorInventory(study: string) {
  const bytes = researchRead(study, "manifest.json"), digest = researchHash(bytes);
  const scheduled = expandExperimentManifest(JSON.parse(bytes.toString("utf8"))).scheduled;
  const artifacts: Artifact[] = [], attempts: Attempt[] = [];
  let registeredIds: string[] = [];
  try { registeredIds = readdirSync(join(study, "attempts")).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const id of registeredIds) {
    const root = join(study, "attempts", id);
    const registered = JSON.parse(researchRead(root, "attempt.json").toString("utf8")) as ResearchAttemptIdentity;
    const row = scheduled.find(row => row.key === registered.scheduled_key);
    if (!row || registered.id !== id || registered.id !== `${registered.scheduled_key.slice(0, 48)}-${registered.ordinal}`) throw new Error("registered comparator attempt is not scheduled");
    let piece: { manifest_sha256: string; artifacts: Artifact[]; attempts: Attempt[] } | undefined;
    try { piece = JSON.parse(researchRead(root, "inventory.json").toString("utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (piece) {
      if (piece.manifest_sha256 !== digest || piece.attempts.length !== 1 || piece.attempts[0]?.id !== registered.id
        || piece.attempts[0]?.scheduled_key !== registered.scheduled_key || piece.attempts[0]?.ordinal !== registered.ordinal) throw new Error("comparator inventory piece identity changed");
      artifacts.push(...piece.artifacts); attempts.push(...piece.attempts);
    } else attempts.push({ ...registered, sessions: [], bindings: { terminal: null, acceptance: null, graph: null, scope: row.scope,
      patch: `${registered.id}-missing-patch`, process_exit: null, oracle: null, labels: [], harness: [], journal: [] } });
  }
  return { schema_version: 1 as const, manifest_sha256: digest, artifacts, attempts, exclusions: [] };
}
