import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../../host/canonical.ts";
import { EventLog } from "../../host/event-log.ts";
import { parseReplayEvents } from "../../host/replay-audit.ts";
import { projectProviderInputs, readProviderBodies } from "../../host/provider-input.ts";
import { agentTranscriptPath, readAgentTranscriptFile } from "../../host/agent-transcript.ts";
import { assertSealEvent } from "../../host/prefix.ts";
import type { EventRecord } from "../../host/schema.ts";
import { durableResearchFile, researchContains, researchHash, researchRead } from "./environment.ts";
import { experimentId, sha256Schema, type ExternalEnvelope } from "./schema.ts";
import { expandExperimentManifest } from "./manifest.ts";

const attemptIdentity = z.strictObject({ id: experimentId, scheduled_key: sha256Schema, ordinal: z.number().int().positive() });
export type ResearchAttemptIdentity = z.infer<typeof attemptIdentity>;
export interface ResumeCheckpoint {
  attempt: ResearchAttemptIdentity; invocation: number; log_sha256: string; bytes: number;
  tail_hash: string; prefix_hash: string; seal_seq: number; events: number;
}
export interface ResearchProcessResult {
  attempt: ResearchAttemptIdentity; invocation: number; exit_code: number | null; signal: NodeJS.Signals | null;
  timed_out: boolean; error: string | null; status: "exited" | "crash" | "launch_error";
  stdout: string; stderr: string; child: ReturnType<typeof inspectResearchChild>; checkpoint: ResumeCheckpoint | null;
  process_time: { started_at: string | null; exited_at: string | null; elapsed_ms: number | null };
}
function readJson(path: string): unknown { return JSON.parse(researchRead(dirname(path), basename(path)).toString("utf8")); }
function record(log: EventLog, name: string, payload: Record<string, unknown>): void {
  log.appendDurable({ kind: "observe", name, payload });
}

export function registerScheduledResearchAttempt(studyRoot: string, manifestPath: string, scheduledKey: string, ordinal: number, phaseRoot = join(studyRoot, "resources")) {
  const bytes = researchRead(dirname(manifestPath), basename(manifestPath));
  const { scheduled } = expandExperimentManifest(JSON.parse(bytes.toString("utf8")));
  if (!scheduled.some(row => row.key === scheduledKey) || !Number.isSafeInteger(ordinal) || ordinal < 1) throw new Error("research attempt is not scheduled");
  const binding = canonicalJson({ manifest_sha256: researchHash(bytes), scheduled, phase_root: resolve(phaseRoot) });
  const schedulePath = join(studyRoot, "schedule.json");
  try { durableResearchFile(schedulePath, binding + "\n"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (canonicalJson(readJson(schedulePath)) !== binding) throw new Error("research schedule changed");
  const runs = join(studyRoot, "attempts"); mkdirSync(runs, { recursive: true, mode: 0o700 });
  const id = `${scheduledKey.slice(0, 48)}-${ordinal}`, controlRoot = join(runs, id);
  if (ordinal > 1) {
    const previous = join(runs, `${scheduledKey.slice(0, 48)}-${ordinal - 1}`);
    if (!researchInvocations(previous).length) throw new Error("research retry lacks a retained preceding attempt");
  }
  mkdirSync(controlRoot, { mode: 0o700 });
  const attempt = attemptIdentity.parse({ id, scheduled_key: scheduledKey, ordinal });
  durableResearchFile(join(controlRoot, "attempt.json"), canonicalJson(attempt) + "\n");
  return { controlRoot, attempt };
}

/** One host-owned lease serializes all enrolled model and scoring phases.
 * Stale locks deliberately remain evidence; PID reuse is not recovery proof. */
export function acquireResearchPhase(root: string, phase: "model" | "scoring", owner: string): () => void {
  const path = join(resolve(root), "active");
  mkdirSync(path, { mode: 0o700 });
  const token = randomUUID(), body = { token, phase, owner, pid: process.pid };
  try { durableResearchFile(join(path, "owner.json"), canonicalJson(body) + "\n"); }
  catch (error) { throw new Error("research phase lease could not be persisted", { cause: error }); }
  let released = false;
  return () => {
    if (released) return;
    if (canonicalJson(readJson(join(path, "owner.json"))) !== canonicalJson(body)) throw new Error("research phase lease changed");
    rmSync(path, { recursive: true }); released = true;
  };
}

export function inspectResearchChild(path?: string) {
  if (!path) return { state: "unavailable" as const, terminal: null, acceptance: null, deviation: null, usage: [] as EventRecord[] };
  try {
    const events = parseReplayEvents(researchRead(dirname(path), basename(path)).toString("utf8"));
    return { state: "retained" as const, terminal: [...events].reverse().find(row => row.name === "work/run_result") ?? null,
      acceptance: [...events].reverse().find(row => row.name === "work/accept") ?? null,
      deviation: [...events].reverse().find(row => row.name === "research/deviation") ?? null,
      usage: events.filter(row => /^(model\/(usage|retry|turn_budget)|provider\/(request|send|response))$/u.test(row.name)) };
  } catch { return { state: "unavailable" as const, terminal: null, acceptance: null, deviation: null, usage: [] as EventRecord[] }; }
}

/** Refusal is the only safe default for a tool whose durable result is absent.
 * An external effect may already have happened before the process was killed. */
export function researchResumeCheckpoint(path: string, attempt: ResearchAttemptIdentity, invocation: number): ResumeCheckpoint {
  attemptIdentity.parse(attempt);
  const bytes = researchRead(dirname(path), basename(path)), events = parseReplayEvents(bytes.toString("utf8"));
  const seal = [...events].reverse().find(row => row.name === "prompt/seal");
  if (!seal || !events.length) throw new Error("research resume lacks a sealed prefix");
  assertSealEvent(seal);
  if (events.some(row => row.name === "research/deviation")) throw new Error("research deviation blocks resume");
  const pending = new Set<string>();
  for (const row of events) {
    if (row.name === "tool/call") {
      const id = row.payload.id;
      if (typeof id !== "string" || pending.has(id)) throw new Error("research resume has ambiguous tool identity");
      pending.add(id);
    }
    if (row.name === "tool/result") {
      const id = row.payload.id;
      if (typeof id !== "string" || !pending.delete(id)) throw new Error("research resume has an unbound tool result");
    }
  }
  if (pending.size) throw new Error("research resume has uncertain in-flight effects");
  const log = new EventLog(path, { readOnly: true });
  const provider = projectProviderInputs(events, readProviderBodies(log));
  if (provider.state.pending) throw new Error("research resume has unfinished compaction");
  const cachePath = agentTranscriptPath(path);
  if (provider.state.ref && existsSync(cachePath)) {
    const cache = readAgentTranscriptFile(cachePath);
    if (!cache || canonicalJson(cache.messages) !== canonicalJson(provider.state.messages)
      || Object.entries(provider.state.metadata ?? {}).some(([key, value]) => canonicalJson((cache as unknown as Record<string, unknown>)[key]) !== canonicalJson(value))) throw new Error("research resume cache differs from recorded history");
  }
  // An assistant may have proposed a tool that never reached tool/call. The
  // existing provider transcript owns execution recovery, so also require all
  // proposed calls to have recorded toolResult messages before continuation.
  const proposed = new Set<string>();
  for (const raw of provider.state.messages) {
    const message = raw as { role?: string; content?: Array<{ type?: string; id?: string }>; toolCallId?: string };
    if (message.role === "assistant" && Array.isArray(message.content)) for (const part of message.content) {
      if (part.type === "toolCall" && part.id) proposed.add(part.id);
    }
    if (message.role === "toolResult" && message.toolCallId) proposed.delete(message.toolCallId);
  }
  if (proposed.size) throw new Error("research resume has unsettled provider tool calls");
  return { attempt, invocation, log_sha256: researchHash(bytes), bytes: bytes.length, tail_hash: events.at(-1)!.hash,
    prefix_hash: String(seal.payload.prefix_hash), seal_seq: seal.seq, events: events.length };
}

export interface ResearchProcessInput {
  controlRoot: string; attempt: ResearchAttemptIdentity; command: { start: readonly string[]; resume?: readonly string[] };
  cwd: string; environment: Readonly<Record<string, string>>; phaseRoot: string; phase?: "model" | "scoring";
  timeoutMs: number; graceMs?: number; childLog?: string; resume?: ResumeCheckpoint;
  /** Immutable runtime, prompt, plugin, tool and policy inputs, pinned by the
   * experiment controller. Candidate files are checked only before first use. */
  authorityFiles?: readonly { path: string; sha256: string }[];
  candidateFiles?: readonly { path: string; sha256: string }[];
  /** Trusted-controller test/operations seam, never supplied by the candidate. */
  onSpawn?: (child: ChildProcess) => void;
}

export async function superviseResearchProcess(input: ResearchProcessInput): Promise<ResearchProcessResult> {
  const attempt = attemptIdentity.parse(input.attempt), root = resolve(input.controlRoot);
  if (canonicalJson(readJson(join(root, "attempt.json"))) !== canonicalJson(attempt)) throw new Error("research attempt authority mismatch");
  const schedule = readJson(join(dirname(dirname(root)), "schedule.json")) as { phase_root?: string; scheduled?: { key: string }[] };
  if (schedule.phase_root !== resolve(input.phaseRoot) || !schedule.scheduled?.some(row => row.key === attempt.scheduled_key)
    || basename(root) !== `${attempt.scheduled_key.slice(0, 48)}-${attempt.ordinal}`) throw new Error("research schedule/resource authority mismatch");
  if (researchContains(input.cwd, root)) throw new Error("research supervisor must be outside the candidate workspace");
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 86400000
    || (input.graceMs !== undefined && (!Number.isSafeInteger(input.graceMs) || input.graceMs < 1 || input.graceMs > 60000))) throw new Error("research timeout is invalid");
  const argv = input.resume ? input.command.resume : input.command.start;
  if (!argv?.length || !isAbsolute(argv[0]!) || argv.some(word => typeof word !== "string" || word.includes("\0"))) throw new Error("research command is unavailable");
  const releasePhase = acquireResearchPhase(input.phaseRoot, input.phase ?? "model", attempt.id);
  let releaseAttempt: (() => void) | undefined;
  try {
    releaseAttempt = acquireResearchPhase(root, input.phase ?? "model", attempt.id);
    const log = EventLog.create(join(root, "supervisor.jsonl"));
    for (const file of input.authorityFiles ?? []) {
      if (researchHash(researchRead(dirname(file.path), basename(file.path))) !== file.sha256) throw new Error("research authority input changed");
    }
    if (!input.resume) for (const file of input.candidateFiles ?? []) {
      if (researchHash(researchRead(input.cwd, file.path)) !== file.sha256) throw new Error("research initial candidate input changed");
    }
    // Credential rotation is not an experimental input change. Key names stay
    // bound, while credential values never enter receipts or weak hashes.
    const env = Object.fromEntries(Object.entries(input.environment).map(([key, value]) =>
      [key, /(?:KEY|TOKEN|SECRET|PASSWORD)$/u.test(key) ? "[credential]" : value]));
    const identity = { attempt, command: input.command, cwd: resolve(input.cwd), environment: env, phase_root: resolve(input.phaseRoot), phase: input.phase ?? "model",
      timeout_ms: input.timeoutMs, grace_ms: input.graceMs ?? 1000, child_log: input.childLog ?? null,
      authority_files: input.authorityFiles ?? [], candidate_files: input.candidateFiles ?? [],
      executable_sha256: existsSync(argv[0]!) ? researchHash(readFileSync(argv[0]!)) : null };
    const identityPath = join(root, "launch.json");
    if (existsSync(identityPath)) {
      if (canonicalJson(readJson(identityPath)) !== canonicalJson(identity)) throw new Error("research launch identity changed");
    } else durableResearchFile(identityPath, canonicalJson(identity) + "\n");
    const starts = log.events.filter(row => row.name === "research/process_start");
    const invocation = starts.length + 1;
    if (input.resume) {
      const previous = readJson(join(root, `invocation-${invocation - 1}.json`)) as ResearchProcessResult;
      if (!previous.checkpoint || !input.childLog || !input.command.resume || previous.status === "exited"
        || canonicalJson(previous.checkpoint) !== canonicalJson(input.resume)
        || canonicalJson(researchResumeCheckpoint(input.childLog, attempt, invocation - 1)) !== canonicalJson(input.resume)) throw new Error("research resume identity is stale or unavailable");
      durableResearchFile(join(root, `resume-${input.resume.invocation}.consumed`), canonicalJson(input.resume) + "\n");
    } else if (invocation !== 1) throw new Error("research attempt requires explicit resume; retries need a new attempt identity");
    record(log, "research/process_start", { attempt, invocation, command: [...argv], resumed_from: input.resume ?? null,
      launch_sha256: researchHash(readFileSync(identityPath)), timeout_ms: input.timeoutMs, phase: input.phase ?? "model" });
    const stdoutPath = join(root, `invocation-${invocation}.stdout`), stderrPath = join(root, `invocation-${invocation}.stderr`);
    const stdout = openSync(stdoutPath, "wx", 0o600), stderr = openSync(stderrPath, "wx", 0o600);
    let error: string | null = null, timedOut = false, observedCode: number | null = null, observedSignal: NodeJS.Signals | null = null;
    let child: ChildProcess | undefined;
    const processTime: ResearchProcessResult["process_time"] = { started_at: null, exited_at: null, elapsed_ms: null };
    let started: bigint | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child?.pid) return;
      try { process.kill(-child.pid, signal); } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "ESRCH") error ??= "process_group_signal_failed";
      }
    };
    try {
      await new Promise<void>((done) => {
        let timer: ReturnType<typeof setTimeout> | undefined, force: ReturnType<typeof setTimeout> | undefined;
        try { child = spawn(argv[0]!, argv.slice(1), { cwd: input.cwd, env: { ...input.environment }, detached: true, stdio: ["ignore", "pipe", "pipe"] }); }
        catch { error = "spawn_failed"; done(); return; }
        let outputBytes = 0;
        const write = (fd: number, chunk: Buffer) => {
          if (error === "output_write_failed" || error === "output_limit_exceeded") return;
          outputBytes += chunk.length;
          if (outputBytes > 64 * 1024 * 1024) { error ??= "output_limit_exceeded"; kill("SIGKILL"); return; }
          try { for (let offset = 0; offset < chunk.length;) offset += writeSync(fd, chunk, offset); }
          catch { error ??= "output_write_failed"; kill("SIGKILL"); }
        };
        child.stdout?.on("data", (chunk: Buffer) => write(stdout, chunk));
        child.stderr?.on("data", (chunk: Buffer) => write(stderr, chunk));
        child.once("spawn", () => {
          started = process.hrtime.bigint(); processTime.started_at = new Date().toISOString();
          try { record(log, "research/process_spawn", { attempt, invocation, pid: child!.pid!, started_at: processTime.started_at }); }
          catch { error ??= "supervisor_write_failed"; kill("SIGKILL"); }
        });
        child.once("error", () => { error ??= "spawn_failed"; });
        child.once("exit", (code, signal) => {
          observedCode = code; observedSignal = signal; processTime.exited_at = new Date().toISOString();
          processTime.elapsed_ms = started === undefined ? null : Number(process.hrtime.bigint() - started) / 1e6;
          kill("SIGKILL");
        });
        child.once("close", () => { clearTimeout(timer); clearTimeout(force); done(); });
        timer = setTimeout(() => {
          timedOut = true;
          try { record(log, "research/timeout", { attempt, invocation, requested_signal: "SIGTERM" }); }
          catch { error ??= "supervisor_write_failed"; }
          kill("SIGTERM"); force = setTimeout(() => kill("SIGKILL"), input.graceMs ?? 1000);
        }, input.timeoutMs);
        try { input.onSpawn?.(child); } catch { error ??= "controller_callback_failed"; kill("SIGKILL"); }
      });
      try { fsyncSync(stdout); fsyncSync(stderr); } catch { error ??= "output_write_failed"; }
    } finally { closeSync(stdout); closeSync(stderr); }
    const observed = inspectResearchChild(input.childLog);
    if (observed.deviation) error ??= "research_deviation";
    let checkpoint: ResumeCheckpoint | null = null;
    let resumeRefusal: string | null = null;
    if (input.childLog && (observedCode !== 0 || observedSignal || timedOut || error)) {
      try { checkpoint = researchResumeCheckpoint(input.childLog, attempt, invocation); }
      catch (failure) { resumeRefusal = failure instanceof Error ? failure.message : "resume unavailable"; }
    }
    const result: ResearchProcessResult = { attempt, invocation, exit_code: observedCode, signal: observedSignal, timed_out: timedOut, error,
      status: error === "spawn_failed" ? "launch_error" : observedCode === 0 && !observedSignal && !timedOut && !error ? "exited" : "crash",
      stdout: basename(stdoutPath), stderr: basename(stderrPath), child: observed, checkpoint, process_time: processTime };
    record(log, "research/process_exit", { ...result, resume_refusal: resumeRefusal });
    durableResearchFile(join(root, `invocation-${invocation}.json`), canonicalJson(result) + "\n");
    return result;
  } finally { try { releaseAttempt?.(); } finally { releasePhase(); } }
}

/** Collector envelope for the actual final invocation. Earlier failures and
 * all costs remain in supervisor/native histories and are never overwritten. */
export function researchProcessExitArtifact(result: ResearchProcessResult, scope: string, patch: string, version: string): ExternalEnvelope {
  if (result.exit_code === null && result.signal === null) throw new Error("research process exit was not observed");
  return { schema_version: 1, kind: "process_exit", source: { system: "external", producer: "research-supervisor", version },
    scheduled_key: result.attempt.scheduled_key, attempt_id: result.attempt.id,
    references: [{ relation: "scope", artifact: scope }, { relation: "patch", artifact: patch }],
    value: { exit_code: result.exit_code, signal: result.signal, timed_out: result.timed_out, supervisor_error: result.error } };
}

export function researchInvocations(root: string): ResearchProcessResult[] {
  const results = readdirSync(root).filter(name => /^invocation-[1-9][0-9]*\.json$/u.test(name))
    .map(name => readJson(join(root, name)) as ResearchProcessResult).sort((a, b) => a.invocation - b.invocation);
  const log = parseReplayEvents(researchRead(root, "supervisor.jsonl").toString("utf8"));
  if (log.filter(row => row.name === "research/process_start").length !== results.length
    || results.some((row, i) => row.invocation !== i + 1
      || canonicalJson(row.attempt) !== canonicalJson(results[0]!.attempt)
      || !log.some(event => {
        if (event.name !== "research/process_exit" || event.payload.invocation !== row.invocation) return false;
        const { resume_refusal: _refusal, ...payload } = event.payload;
        return canonicalJson(payload) === canonicalJson(row);
      }))) throw new Error("research invocation accounting is incomplete");
  return results;
}
