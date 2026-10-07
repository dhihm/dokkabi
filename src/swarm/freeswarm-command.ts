import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { EventLog } from "../host/event-log.ts";
import { fetchOpenRouterFreeModels, type FreeModel } from "../host/openrouter-free-models.ts";
import { sessionDir } from "../host/paths.ts";
import { assignRoster, FREE_SWARM_ROLES, type RoleAssignment } from "./free-roster.ts";
import { buildPipelinePlan } from "./freeswarm-pipeline.ts";
import { createFreeswarmStageRunner, assertFreeswarmSandbox } from "./freeswarm-live.ts";
import { freeModelLines, rosterLines } from "./freeswarm-render.ts";
import { runFreeswarm, type FreeswarmRunResult } from "./freeswarm-run.ts";

/**
 * `dokkabi 두레 / freeswarm [--model role=id …] [--preview] <task>`
 *
 * Fetches OpenRouter's free models, proposes a role roster (architect →
 * builder → tester → critic → code-reviewer) tiered by capability, and prints
 * both. This is the operator's window into the mode: it shows every usable
 * free model and who plays which role, honouring per-role overrides. The live
 * pipeline run (spawning a child per stage) is wired separately; today the
 * command previews the roster the run would use.
 */

export interface ParsedFreeswarmArgs {
  task?: string;
  preview: boolean;
  overrides: Record<string, string>;
}

export function parseFreeswarmArgs(args: readonly string[]): ParsedFreeswarmArgs {
  const overrides: Record<string, string> = {};
  const words: string[] = [];
  let preview = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--preview") {
      preview = true;
    } else if (arg === "--model" && i + 1 < args.length) {
      const spec = args[i + 1]!;
      i += 1;
      const eq = spec.indexOf("=");
      if (eq > 0) {
        const role = FREE_SWARM_ROLES.find((candidate) => candidate.key === spec.slice(0, eq));
        const id = spec.slice(eq + 1);
        if (role && id.length > 0) overrides[role.key] = id;
      }
    } else if (!arg.startsWith("--")) {
      words.push(arg);
    }
  }
  const task = words.join(" ").trim();
  return { ...(task ? { task } : {}), preview, overrides };
}

/**
 * Launch a full 두레 run in the background — the TUI's `/두레 <task>` path.
 * The pipeline takes minutes and spawns its own children, so the board stays
 * responsive: the CLI runs detached with its output tee'd to a log file the
 * notice names. `spawn` is injectable for tests.
 */
export function launchFreeswarmDetached(
  task: string,
  deps: { spawn?: (argv: readonly string[], stdio: { out: string }) => void } = {},
): string {
  const runId = `freeswarm-${Date.now().toString(36)}`;
  const dir = sessionDir(runId);
  const logPath = join(dir, "run.log");
  const repoRoot = join(import.meta.dir, "..", "..");
  const argv = [process.execPath, join(repoRoot, "src", "cli.ts"), "freeswarm", task];
  const spawn = deps.spawn ?? ((cmd: readonly string[], stdio: { out: string }) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fd = openSync(stdio.out, "a");
    Bun.spawn([...cmd], { stdin: "ignore", stdout: fd, stderr: fd }).unref();
  });
  spawn(argv, { out: logPath });
  return `두레 백그라운드 시작 — run=${runId} · log=${logPath}`;
}

export interface FreeswarmCommandDeps {
  fetchModels?: () => Promise<FreeModel[]>;
  print?: (line: string) => void;
  /** Injectable pipeline execution; defaults to the live child-spawn runner. */
  runPipeline?: (input: {
    task: string;
    roster: readonly RoleAssignment[];
    /** The free pool the roster came from — enables #85 reassignment. A
     * replacement runner that drops this silently loses the feature, so it
     * belongs in the declared contract (PR #97 review M2). */
    models?: readonly FreeModel[];
    print: (line: string) => void;
  }) => Promise<FreeswarmRunResult>;
}

/** The default live execution: a parent freeswarm session log, and one
 * `cli.ts work` child per stage on the OpenRouter route with the stage's
 * assigned free model (DOKKABI_MODEL). */
async function runPipelineLive(input: {
  task: string;
  roster: readonly RoleAssignment[];
  /** The free pool the roster came from — enables #85 reassignment. */
  models?: readonly FreeModel[];
  print: (line: string) => void;
}): Promise<FreeswarmRunResult> {
  const runId = `freeswarm-${Date.now().toString(36)}`;
  const log = EventLog.create(join(sessionDir(runId), "events.jsonl"));
  const repoRoot = join(import.meta.dir, "..", "..");
  const spawnStage = createFreeswarmStageRunner({
    repoRoot,
    workspaceRoot: process.cwd(),
    runId,
  });
  input.print(`두레 실행 시작 — run=${runId}`);
  const result = await runFreeswarm({
    task: input.task,
    roster: input.roster,
    ...(input.models ? { models: input.models } : {}),
    log,
    say: input.print,
    runStage: async (stage) => {
      input.print(`  ▶ ${stage.plan.role} (${stage.plan.model?.id ?? "-"}) 실행 중…`);
      const out = await spawnStage(stage);
      if (out.error) {
        input.print(`  ✖ ${stage.plan.role} — ${out.artifact}`);
      } else if (out.acceptFailed) {
        input.print(`  ⚠ ${stage.plan.role} — goal GREEN, accept failed`);
      } else {
        input.print(`  ✔ ${stage.plan.role}`);
      }
      return out;
    },
  });
  return result;
}

export async function freeswarmCommand(
  args: readonly string[],
  deps: FreeswarmCommandDeps = {},
): Promise<number> {
  const print = deps.print ?? ((line: string) => process.stdout.write(`${line}\n`));
  const fetchModels = deps.fetchModels ?? (() => fetchOpenRouterFreeModels());
  const { task, overrides, preview } = parseFreeswarmArgs(args);

  const models = await fetchModels();
  const roster = assignRoster(models, FREE_SWARM_ROLES, overrides);
  const plan = buildPipelinePlan(roster, task ?? "");

  for (const line of freeModelLines(models)) print(line);
  print("");
  for (const line of rosterLines(plan)) print(line);

  if (!task) {
    print("");
    print("과제를 주면 이 배정으로 실행합니다: dokkabi 두레 <task>");
    return 0;
  }
  print("");
  print(`과제: ${task}`);
  if (preview) {
    return 0;
  }
  if (plan.some((stage) => stage.blocked)) {
    print("미배정 역할이 있어 실행하지 않습니다. 무료 모델이 없거나 오버라이드가 잘못됐습니다.");
    return 1;
  }
  try {
    assertFreeswarmSandbox(process.cwd());
  } catch (error) {
    print(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const runPipeline = deps.runPipeline ?? runPipelineLive;
  const result = await runPipeline({ task, roster, models, print });
  print("");
  print(`두레 결과: ${result.status}`);
  const review = result.stages.find((stage) => stage.role === "code-reviewer");
  if (review?.status === "done" && review.artifact) {
    print("");
    print("## 코드리뷰어 최종 판정");
    print(review.artifact);
  }
  return result.status === "completed" ? 0 : 1;
}
