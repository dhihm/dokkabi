import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { caseLaunch } from "./case-launch.ts";
import { execSandboxed, type SandboxPolicy } from "../host/sandbox.ts";
import type { EventLog } from "../host/event-log.ts";

/**
 * Owning the remote process a case run starts.
 *
 * The watched runner launched its command detached and never tracked what it
 * had started. When a run stalled or timed out the harness walked away, the
 * process kept working, and the next attempt launched another one beside it.
 * Two memory-hungry runs then shared one machine, throughput collapsed, and
 * the kernel killed the pair. The log ended in "Killed" — which no case had
 * thought to declare as a failure — so the harness went on polling a dead
 * process until its stall window expired.
 *
 * A run therefore records its pid, reaps whatever the last run left behind
 * before starting, and is reaped itself when the verdict lands.
 */

export interface CaseRunPaths {
  readonly log: string;
  readonly pid: string;
}

export function caseRunPaths(command: string): CaseRunPaths {
  const slug = createHash("sha256").update(command).digest("hex").slice(0, 16);
  return { log: `/tmp/dokkabi-case-${slug}.log`, pid: `/tmp/dokkabi-case-${slug}.pid` };
}

/** Single-quote for POSIX sh so the remote shell never re-parses the command. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Kill the process group the pidfile names. Negating the pid targets the
 * group, so a python parent does not leave its dataloader children holding
 * memory. A run that already exited is not an error.
 */
export function reapScript(command: string): string {
  const { pid } = caseRunPaths(command);
  return `if [ -f ${pid} ]; then kill -TERM -"$(cat ${pid})" 2>/dev/null || kill -TERM "$(cat ${pid})" 2>/dev/null; sleep 2; kill -KILL -"$(cat ${pid})" 2>/dev/null || true; rm -f ${pid}; fi`;
}

/**
 * Reap the previous run, truncate its log so old output is never mistaken for
 * this run's, then launch in its own process group and record the pid.
 */
export function launchScript(input: { command: string; dir?: string; env?: string }): string {
  // Paths key off the COMMAND, never off what is prefixed to it: the log and
  // pidfile must name the same run across attempts, so an environment the
  // harness adds (the bars handoff) cannot move them and strand the previous
  // run's process unreaped.
  const { log, pid } = caseRunPaths(input.command);
  const run = input.env ? `${input.env} ${input.command}` : input.command;
  return [
    reapScript(input.command),
    // The directory is path data, entered the way every case launch enters
    // it (case-launch.ts); the shell stays there for the launch below.
    caseLaunch(input.dir, `: > ${log}`),
    `nohup setsid sh -c ${shellQuote(run)} > ${log} 2>&1 & echo $! > ${pid}`,
    `echo STARTED "$(cat ${pid})"`,
  ].join(" ; ");
}

/**
 * How much of the log tail a poll reads.
 *
 * The completion and failure signals are always at the END of a run's output,
 * and the transport keeps the FIRST 64KB of anything it returns. Polling with
 * `cat` on a log that had grown past that cap returned the beginning and
 * dropped the tail, so a kernel's "Killed" was never seen and the harness kept
 * polling a dead process. Well under the cap, since the poll's own framing
 * costs a little too.
 */
export const POLL_TAIL_BYTES = 32 * 1024;

/** Read what the run most recently said, plus whether it still lives. A log
 * that does not exist yet is empty; liveness comes from the pidfile so a run
 * that closed without a conclusive line does not get waited out. */
export function pollScript(command: string): string {
  const { log, pid } = caseRunPaths(command);
  return `tail -c ${POLL_TAIL_BYTES} ${log} 2>/dev/null || true; `
    + `if [ -f ${pid} ] && kill -0 "$(cat ${pid})" 2>/dev/null; then echo __DOKKABI_RUNNING__; else echo __DOKKABI_EXITED__; fi`;
}

/** Split the liveness marker off a poll's output. Absent marker → assume alive. */
export function parsePoll(stdout: string): { output: string; alive: boolean } {
  const exited = /__DOKKABI_EXITED__\s*$/u.test(stdout);
  const running = /__DOKKABI_RUNNING__\s*$/u.test(stdout);
  const output = stdout.replace(/__DOKKABI_(?:RUNNING|EXITED)__\s*$/u, "");
  return { output, alive: exited ? false : running ? true : true };
}

/**
 * Failures the harness recognises on every case, declared or not.
 *
 * A run the kernel killed, or one that could not get the memory it asked for,
 * says nothing about the product — and no case author should have to
 * anticipate the machine. Waiting out a stall window on a process that no
 * longer exists helps nobody either. The accelerator and C++ forms below are
 * instances of the same thing, not a domain the harness knows about.
 */
const HARNESS_FAILURE_PATTERNS: readonly RegExp[] = [
  // The shell's own report of a signalled child, on its own line.
  /^\s*Killed\s*$/mu,
  /\bOut of memory: Killed process\b/u,
  /\bOOMKilled\b/u,
  /CUDA error: out of memory/iu,
  /\bstd::bad_alloc\b/u,
];

export function harnessFailureReason(output: string): string | undefined {
  for (const pattern of HARNESS_FAILURE_PATTERNS) {
    const match = pattern.exec(output);
    if (match) {
      return `run was killed or ran out of memory: ${match[0].trim().slice(0, 80)}`;
    }
  }
  return undefined;
}

/**
 * Photograph the host when the kernel kills a run.
 *
 * A watched case died at shard 3/10 with one word — "Killed" — while the
 * memory was held by a heavyweight the model itself had launched in an
 * earlier turn, outside the runner. The verdict said WHAT; only a human
 * running `free` and `ps` by hand could see WHY, and a run cannot correct
 * itself with facts it never saw. The runner now gathers those facts —
 * memory totals, the heaviest residents, its own pidfiles so "not one of
 * mine" is visible — and puts them in the failure evidence the next turn
 * reads. Facts only: the judgment stays with the model.
 */
export function deathSceneScript(): string {
  return "free -g 2>/dev/null | head -2; "
    + "ps aux --sort=-%mem 2>/dev/null | head -8 | cut -c1-160; "
    + "ls /tmp/dokkabi-case-*.pid 2>/dev/null";
}

export function formatDeathScene(snapshot: string): string {
  const trimmed = snapshot.trim();
  if (trimmed.length === 0) return "";
  return `[host at time of death]\n${trimmed}`;
}

/**
 * One run at a time per host.
 *
 * Verify walks its cases in sequence, but a host-bound run is launched
 * detached and returns as soon as it is being watched, so nothing stopped
 * several from being in flight together. Where they contend for the same
 * bounded resource — memory, a device, a port, a database — that is fatal:
 * live, two memory-hungry runs collapsed each other's throughput and the
 * kernel killed both.
 */
const hostRunLocks = new Map<string, Promise<unknown>>();

export async function withHostRunLock<T>(host: string, run: () => Promise<T>): Promise<T> {
  const previous = hostRunLocks.get(host) ?? Promise.resolve();
  // A failed predecessor must not poison the queue behind it.
  const gate = previous.then(() => undefined, () => undefined).then(run);
  hostRunLocks.set(host, gate.then(() => undefined, () => undefined));
  return gate;
}

/**
 * What the host has free, before a heavy case is launched.
 *
 * The node is shared. A neighbouring tenant held sixty gigabytes while a
 * case that loads a fifty-gigabyte checkpoint tried to start; it died in
 * allocation, the harness recorded an ordinary red, and the run spent its
 * turns proving from `ps` output that the death was external rather than
 * optimizing anything. Reading the host first turns that whole class of
 * failure into a fact stated up front.
 *
 * `LC_ALL=C` because a localized `free` prints its own row labels, which is
 * exactly how one gate came to report -1.0 GB.
 */
export function hostMemoryScript(): string {
  return "LC_ALL=C free -g 2>/dev/null | head -2";
}

/** Available gigabytes from `free -g`, or undefined when it cannot be read. */
export function parseHostAvailableGb(output: string): number | undefined {
  for (const line of output.split(/\r?\n/u)) {
    const match = /^Mem:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/u.exec(line.trim());
    if (match) return Number(match[6]);
  }
  return undefined;
}

/**
 * Why this host cannot host this run right now, or undefined when it can.
 * A case that declares nothing asks nothing; an unreadable host is not
 * evidence of starvation and never blocks a run.
 */
/**
 * A host with nothing left cannot run anything.
 *
 * The gate below only fires for a case that declared what it needs, and a
 * plan whose cases declare nothing is a plan the gate never sees. Live, every
 * case in a campaign left `needs_memory_gb` unset; a case then launched onto a
 * node whose memory a neighbouring job had just taken to the last gigabyte,
 * hung for fifty minutes, and was recorded as an ordinary red — a verdict
 * about the product, from a run that never had the memory to start.
 *
 * So the floor needs no declaration. `free -g` reporting zero available means
 * under a gigabyte is left, and nothing a case launches fits in that.
 */
const HOST_FLOOR_GB = 1;

/** Why no case can start here, whatever it declared. */
export function exhaustedHostReason(availableGb: number | undefined): string | undefined {
  if (availableGb === undefined || !Number.isFinite(availableGb)) return undefined;
  if (availableGb >= HOST_FLOOR_GB) return undefined;
  return `host had ${availableGb}GB available — nothing was left to launch into, `
    + `so the run was not started and this is not a verdict about the product. `
    + `Something else is holding the memory; wait for it, or run less at once.`;
}

export function starvedHostReason(
  needsGb: number | undefined,
  availableGb: number | undefined,
): string | undefined {
  if (needsGb === undefined || availableGb === undefined) return undefined;
  if (!Number.isFinite(needsGb) || needsGb <= 0) return undefined;
  if (availableGb >= needsGb) return undefined;
  return `host had ${availableGb}GB available but this case's run needs ${needsGb}GB — `
    + `the run was not started, so this is not a verdict about the product. `
    + `Someone or something else is holding the memory; wait for it, or reduce what the case loads.`;
}

/**
 * Handing a run its bars, instead of sending it to find them.
 *
 * A gate judged by plan-fixed bars had to read the plan itself, so a copy of
 * the plan lived on the host beside the code. Nothing owned that copy: it was
 * synced by hand five times in one campaign, and once a run edited the copy's
 * bars downward to pass — caught only because the harness compares what a run
 * echoes against what the plan declares. A copy that can drift is a copy
 * someone will drift.
 *
 * The harness owns the plan, so it hands the bars over: a small JSON file
 * beside the case log, named by the environment the run is launched with.
 * Nothing to sync, and editing it changes nothing the verdict reads.
 */
/** Match child-process directory resolution for both execution and evidence. */
export function localAcceleratedDirectory(cwd: string, dir?: string): string {
  return resolve(dir || cwd);
}

/** Accelerator intent never grants host authority. Direct callers must supply
 * a host-sealed policy and effect log, just like every other case runner. */
export async function runLocalAccelerated(input: {
  readonly command: string;
  readonly cwd: string;
  readonly dir?: string;
  readonly env?: string;
  readonly timeoutSeconds?: number;
  readonly policy?: SandboxPolicy;
  readonly log?: EventLog;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (!input.policy || !input.log) throw new Error("local accelerator execution requires host-sealed policy and effect log");
  const command = input.env ? `${input.env} ${input.command}` : input.command;
  return execSandboxed({
    policy: input.policy,
    log: input.log,
    command: caseLaunch(input.dir ?? input.cwd, command),
    timeoutMs: Math.max(1, input.timeoutSeconds ?? 600) * 1000,
  });
}

/**
 * Write a case's bars where a local run will read them.
 *
 * The bars file was only ever produced by an ssh call, so a case that ran on
 * this machine got none: DOKKABI_CASE_BARS pointed at a path nobody had
 * written, the run read no threshold, and a declared bar judged nothing. The
 * remote path and the local path must hand a run the same thing.
 */
export function writeLocalBars(
  command: string,
  thresholds: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (!thresholds || Object.keys(thresholds).length === 0) return undefined;
  const path = caseBarsPath(command);
  try {
    writeFileSync(path, JSON.stringify(thresholds), "utf8");
    return path;
  } catch {
    // A bars file we cannot write leaves the run exactly as it was before
    // this existed; the threshold check downstream still refuses a run that
    // reports no bar.
    return undefined;
  }
}

export function caseBarsPath(command: string): string {
  const slug = createHash("sha256").update(command).digest("hex").slice(0, 16);
  return `/tmp/dokkabi-case-${slug}.bars.json`;
}

/** Write the declared bars where the run will look. Undefined when none. */
export function writeBarsScript(
  command: string,
  thresholds: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (!thresholds || Object.keys(thresholds).length === 0) return undefined;
  const json = JSON.stringify(thresholds);
  return `cat > ${caseBarsPath(command)} <<'DOKKABI_BARS_EOF'\n${json}\nDOKKABI_BARS_EOF`;
}

/** Name the bars file in the command's environment, when there are bars. */
export function withBarsEnv(
  command: string,
  barsFor: string | undefined,
): string {
  if (barsFor === undefined) return command;
  return `DOKKABI_CASE_BARS=${caseBarsPath(barsFor)} ${command}`;
}
