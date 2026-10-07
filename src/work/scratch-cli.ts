import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { EventLog } from "../host/event-log.ts";
import { resolveWorkspaceRoot, resolveWorkspaceSessionId, sessionLogPath } from "../host/paths.ts";
import { cleanScratch, promoteScratch, type CleanScratchResult } from "./scratch.ts";
import { ScratchError } from "./scratch-error.ts";
import { defaultWorkPlanPath } from "./log.ts";

const SessionSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/u);
const LayerSchema = z.enum(["unit", "contract", "replay"]);
const PromoteSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  workspace: z.string().min(1),
  session: SessionSchema,
  plan: z.string().min(1).optional(),
  scenario: z.string().min(1).max(160).optional(),
  caseId: z.string().min(1).max(80).optional(),
  layer: LayerSchema.optional(),
  timeoutMs: z.number().int().min(1).max(3_600_000).optional(),
  redMeans: z.string().min(1).max(2_000).optional(),
  greenMeans: z.string().min(1).max(2_000).optional(),
});
const CleanSchema = z.object({
  workspace: z.string().min(1),
  session: SessionSchema,
  dryRun: z.boolean(),
  all: z.boolean(),
});

type PromoteCommand = z.infer<typeof PromoteSchema>;
type CleanCommand = z.infer<typeof CleanSchema>;

export function runScratchCommand(args: readonly string[]): void {
  const [operation, ...rest] = args;
  if (operation === "promote") {
    runPromote(parsePromote(rest));
    return;
  }
  if (operation === "clean") {
    runClean(parseClean(rest));
    return;
  }
  throw usage("usage: dokkabi scratch promote SOURCE TARGET [options] | dokkabi scratch clean [options]");
}

export function formatScratchClean(result: CleanScratchResult, dryRun: boolean): string {
  return `scratch clean${dryRun ? " (dry-run)" : ""}: eligible=${result.eligible} removed=${result.removed} kept_tracked=${result.keptTracked} bytes_freed=${result.bytesFreed}\n`;
}

function runPromote(command: PromoteCommand): void {
  const log = openLog(command.session);
  const attach = command.scenario
    ? {
        planPath: resolve(command.workspace, command.plan ?? defaultWorkPlanPath(command.workspace)),
        scenario: command.scenario,
        ...(command.caseId ? { caseId: command.caseId } : {}),
        ...(command.layer ? { layer: command.layer } : {}),
        ...(command.timeoutMs ? { timeoutMs: command.timeoutMs } : {}),
        ...(command.redMeans ? { redMeans: command.redMeans } : {}),
        ...(command.greenMeans ? { greenMeans: command.greenMeans } : {}),
      }
    : undefined;
  const result = promoteScratch({
    workspaceRoot: command.workspace,
    source: command.source,
    target: command.target,
    log,
    ...(attach ? { attach } : {}),
  });
  process.stdout.write(
    `scratch promoted ${result.source} -> ${result.target} bytes=${result.bytes}` +
      `${result.caseId ? ` case=${result.caseId}` : ""}\n`,
  );
}

function runClean(command: CleanCommand): void {
  const result = cleanScratch({
    workspaceRoot: command.workspace,
    log: openLog(command.session),
    dryRun: command.dryRun,
    all: command.all,
  });
  process.stdout.write(formatScratchClean(result, command.dryRun));
}

function parsePromote(args: readonly string[]): PromoteCommand {
  const positional: string[] = [];
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (!PROMOTE_VALUE_FLAGS.has(arg)) throw usage(`unknown scratch promote flag ${arg}`);
    const value = args[index + 1];
    if (!value) throw usage(`${arg} requires a value`);
    values.set(arg, value);
    index += 1;
  }
  if (positional.length !== 2) {
    throw usage("usage: dokkabi scratch promote SOURCE TARGET [--scenario ID] [--case ID] [--timeout-ms N]");
  }
  const workspace = resolveWorkspaceRoot(values.get("--workspace"));
  const scenario = values.get("--scenario");
  const attachmentOnly = ["--plan", "--case", "--layer", "--timeout-ms", "--red-means", "--green-means"]
    .some((flag) => values.has(flag));
  if (!scenario && attachmentOnly) throw usage("scratch case options require --scenario ID");
  return parse(PromoteSchema, {
    source: positional[0],
    target: positional[1],
    workspace,
    session: values.get("--session") ?? resolveWorkspaceSessionId(workspace),
    plan: values.get("--plan"),
    scenario,
    caseId: values.get("--case"),
    layer: values.get("--layer"),
    timeoutMs: values.has("--timeout-ms") ? Number(values.get("--timeout-ms")) : undefined,
    redMeans: values.get("--red-means"),
    greenMeans: values.get("--green-means"),
  });
}

function parseClean(args: readonly string[]): CleanCommand {
  let dryRun = false;
  let all = false;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--all") {
      all = true;
      continue;
    }
    if (arg !== "--workspace" && arg !== "--session") throw usage(`unknown scratch clean flag ${arg ?? "(missing)"}`);
    const value = args[index + 1];
    if (!value) throw usage(`${arg} requires a value`);
    values.set(arg, value);
    index += 1;
  }
  const workspace = resolveWorkspaceRoot(values.get("--workspace"));
  return parse(CleanSchema, {
    workspace,
    session: values.get("--session") ?? resolveWorkspaceSessionId(workspace),
    dryRun,
    all,
  });
}

function openLog(session: string): EventLog {
  const path = sessionLogPath(session);
  return existsSync(path) ? new EventLog(path) : EventLog.create(path);
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw usage(parsed.error.issues.map((issue) => issue.message).join("; "));
}

function usage(message: string): ScratchError {
  return new ScratchError("invalid_command", message);
}

const PROMOTE_VALUE_FLAGS = new Set([
  "--workspace",
  "--session",
  "--plan",
  "--scenario",
  "--case",
  "--layer",
  "--timeout-ms",
  "--red-means",
  "--green-means",
]);
