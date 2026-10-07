import { existingSessionScratch, sessionScratchPath } from "./session-scratch.ts";
import { lstatSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSealedHostGit } from "../host/git-authority.ts";
import { stageTreeSealed, trackedInHead } from "../host/host-index.ts";
import { sessionLogPath } from "../host/paths.ts";
import type { PermissionMode } from "../host/permissions.ts";
import { parseReplayEvents } from "../host/replay-audit.ts";
import { initializeStandaloneGit } from "../swarm/worktree.ts";
import { LEDGER_MIRROR_PATH } from "./plan-ledger.ts";
import { preFixStateDir, savePreFixState, type PreFixState } from "./pre-fix-state.ts";
import { WORK_DEADLINE_ENV } from "./review-budget.ts";
import { observeRecheck } from "./recheck-observe.ts";
import type { EvidenceDelivery, EvidenceRequest } from "./recheck-adjudication.ts";
import type { RecheckObserver } from "./recheck.ts";
import { stageTerminal, type StageRequest, type StageSession, type VerifyRoundsRunner } from "./verify-rounds.ts";
import { deliverDisputeEvidence, DISPUTE_EVIDENCE_DIR, keepVerifierFiles, verifierFilesDir, type VerifierFilesKept } from "./verifier-files.ts";
import { LinkSafetyError, lstatBeneath, removeTreeBeneath, safeRoot, unlinkBeneath } from "./link-safe-fs.ts";
import { makeWorkspaceCopy, removeWorkspaceCopy } from "./workspace-copy.ts";

/**
 * VERIFY ROUNDS (D41), the process side: where a stage runs and how the
 * parent reads it back.
 *
 * Every stage is a child `dokkabi work --planner ledger` with the parent's
 * route, model, effort, permission mode and budget flags, a session id of its
 * own, the composed order on stdin and the shared wall in
 * DOKKABI_WORK_DEADLINE_UNIX_MS. The child's stdout is forwarded to the
 * parent's stderr (the parent's stdout keeps the build's lines and the report)
 * and scanned for the `log=` line every ledger run prints last; the log is
 * parsed with the replay parser, so a stage is read exactly as `dokkabi
 * replay` would read it.
 *
 * A verifier runs on a throwaway copy of the workspace (`cp -a`, environments
 * included, as the base pass copies it) whose delivered state is committed
 * INSIDE THE COPY through the sealed host git boundary, so the verifier
 * session's base commit is what was delivered. The copy is removed once the
 * verifier's log has been read. A fix runs in the developer's workspace
 * itself. Nothing here writes git in the developer's repository; the pre-fix
 * save below only reads it (`rev-parse`, `diff`, `ls-files`, with
 * `--no-optional-locks`).
 *
 * The recheck after a fix (D45) runs in a copy of its own
 * (recheck-observe.ts); `recheck` is its seam. Before a verifier's copy is
 * removed, the files the verifier authored there are kept in the run's own
 * directory (D47, verifier-files.ts), for the recheck to overlay. Before a
 * fix runs, the developer tree's pre-fix state is saved in that directory too
 * (D54, pre-fix-state.ts), reading the developer's git only.
 *
 * Before a verifier that is given disputed checks starts (D55), the evidence
 * of each is written into that verifier session's own scratch — the
 * directory beside the log its child will open, `<session dir>/scratch`,
 * which the child's boot keeps — never into its workspace copy
 * (verifier-files.ts, deliverDisputeEvidence). Since D56 that includes the
 * scratch the check's recording session ran it with, copied from that
 * scratch and held to the manifest the recheck recorded of it beside the
 * rounds log (recheck-observe.ts): a session's scratch is found beside its
 * log (readStage), for every case it recorded, check or not.
 */

/** The identity of the delivered-state commit inside a verifier copy. */
const SNAPSHOT_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: "Dokkabi",
  GIT_AUTHOR_EMAIL: "dokkabi@local.invalid",
  GIT_COMMITTER_NAME: "Dokkabi",
  GIT_COMMITTER_EMAIL: "dokkabi@local.invalid",
});
const SNAPSHOT_MESSAGE = "Delivered state (the verifier's base)";
/** Each git step of the snapshot is bounded like the copy itself. */
const SNAPSHOT_STEP_MAX_MS = 300_000;
/** A child still running this long after the shared wall is stopped: its own
 * wall already ended every episode, so this only catches a hang. */
const STAGE_OVERRUN_GRACE_MS = 10 * 60_000;
const STAGE_KILL_GRACE_MS = 60_000;
/** The longest delay a timer takes before it fires at once instead. */
const MAX_TIMER_MS = 2_147_483_647;
/** How much of a child's stdout the parent keeps to find its `log=` line. */
const STDOUT_TAIL_CHARS = 64 * 1024;

/** The flags every stage session inherits from the run. */
export interface StageLaunch {
  /** The CLI entry the parent itself runs from. */
  readonly cliPath: string;
  readonly route: string;
  readonly model?: string;
  readonly effort: string;
  readonly permissionMode: PermissionMode;
  readonly budgetHours?: number;
  readonly maxRequests?: number;
  readonly continueCap?: number;
  readonly narrate?: boolean;
}

/** One child process, fully described. */
export interface StageCommand {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly stdin: string;
  readonly deadlineMs: number;
}

/** A stage session's id: the run's own session, the role, the round and a
 * tag of this run, so a stage never reopens a session an earlier run sealed
 * with another order. */
export function stageSessionId(base: string, role: "verify" | "fix", round: number, tag: string): string {
  return `${base}-${role}-${round}-${tag}`;
}

/** The child `dokkabi work` for one stage. Pure. */
export function stageCommand(input: {
  readonly launch: StageLaunch;
  readonly session: string;
  readonly workspace: string;
  readonly order: string;
  readonly deadlineMs: number;
  /** verify for a verifier; absent (the full surface) for a fix. */
  readonly toolProfile?: "verify";
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly execPath?: string;
}): StageCommand {
  const { launch } = input;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.env ?? process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env[WORK_DEADLINE_ENV] = String(Math.floor(input.deadlineMs));
  return {
    argv: [
      input.execPath ?? process.execPath,
      launch.cliPath,
      "work",
      "--planner", "ledger",
      "--session", input.session,
      "--workspace", input.workspace,
      "--route", launch.route,
      ...(launch.model === undefined ? [] : ["--model", launch.model]),
      "--effort", launch.effort,
      "--permission-mode", launch.permissionMode,
      ...(launch.budgetHours === undefined ? [] : ["--budget-hours", String(launch.budgetHours)]),
      ...(launch.maxRequests === undefined ? [] : ["--max-requests", String(launch.maxRequests)]),
      ...(launch.continueCap === undefined ? [] : ["--continue-cap", String(launch.continueCap)]),
      ...(input.toolProfile === undefined ? [] : ["--tool-profile", input.toolProfile]),
      ...(launch.narrate === true ? ["--narrate"] : []),
      "--order-stdin",
    ],
    env,
    cwd: input.workspace,
    stdin: input.order,
    deadlineMs: input.deadlineMs,
  };
}

/** The path of the last `log=` line a stage printed, when it printed one. */
export function stageLogPath(stdout: string): string | undefined {
  const lines = stdout.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line.startsWith("log=") && line.length > 4) return line.slice(4);
  }
  return undefined;
}

/** What one child left behind: its exit status and the tail of its stdout. */
export interface StageExit {
  readonly exitCode: number | null;
  readonly stdout: string;
}

export type StageSpawn = (command: StageCommand) => Promise<StageExit>;

/** Start the child, forward its stdout to the parent's stderr as it arrives,
 * keep the tail, and stop it only if it outlives the shared wall by the
 * grace. Its stderr is the parent's. */
export const spawnStage: StageSpawn = async (command) => {
  const child = Bun.spawn([...command.argv], {
    cwd: command.cwd,
    env: { ...command.env },
    stdin: Buffer.from(command.stdin),
    stdout: "pipe",
    stderr: "inherit",
  });
  const overrun = Math.min(MAX_TIMER_MS, Math.max(0, command.deadlineMs + STAGE_OVERRUN_GRACE_MS - Date.now()));
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const termTimer = setTimeout(() => {
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), STAGE_KILL_GRACE_MS);
  }, overrun);
  let tail = "";
  const decoder = new TextDecoder();
  try {
    for await (const chunk of child.stdout) {
      process.stderr.write(chunk);
      tail = (tail + decoder.decode(chunk, { stream: true })).slice(-STDOUT_TAIL_CHARS);
    }
    tail = (tail + decoder.decode()).slice(-STDOUT_TAIL_CHARS);
    return { exitCode: await child.exited, stdout: tail };
  } finally {
    clearTimeout(termTimer);
    if (killTimer !== undefined) clearTimeout(killTimer);
  }
};

/** Read one stage back from what the child printed: the log named on its
 * `log=` line, parsed by the replay parser, and the terminal row in it. */
export function readStage(session: string, exit: StageExit): StageSession {
  const exitCode = exit.exitCode ?? 1;
  const logPath = stageLogPath(exit.stdout);
  if (logPath === undefined) {
    return { session, exitCode, error: `the stage printed no log= line (exit ${String(exit.exitCode)})` };
  }
  let events;
  try {
    events = parseReplayEvents(readFileSync(logPath, "utf8"));
  } catch (error) {
    return { session, exitCode, error: `the stage log could not be read: ${message(error).slice(0, 200)}` };
  }
  // The session's scratch directory (D48), read beside its log: the recheck
  // runs the session's `check` cases with the fixtures it kept there.
  const scratch = existingSessionScratch(logPath);
  return { session, exitCode, events, ...stageTerminal(events), ...(scratch === undefined ? {} : { scratch }) };
}

/** A verifier's workspace: the copy and the directory that holds it. */
export interface VerifierWorkspace {
  readonly holder: string;
  readonly copy: string;
  /** The delivered-state commit inside the copy. */
  readonly head: string;
}

/**
 * The verifier's workspace: a `cp -a` copy of the developer's workspace with
 * the delivered state committed inside it. The host's own plan mirror of the
 * build session is left behind unless the repository tracks that path: it is
 * the builder's plan, and a verifier reads the order, not the builder's plan.
 * Throws when the copy cannot be made or committed; the holder is removed
 * then.
 */
export function prepareVerifierWorkspace(workspaceRoot: string, remainingMs: number | undefined): VerifierWorkspace {
  const holder = mkdtempSync(join(tmpdir(), "dokkabi-verify-"));
  try {
    const copy = makeWorkspaceCopy(workspaceRoot, holder, remainingMs);
    const head = snapshotDeliveredState(copy, remainingMs);
    return { holder, copy, head };
  } catch (error) {
    removeWorkspaceCopy(holder);
    throw error;
  }
}

/** The absolute spellings of a root: as given and, when it differs, its real
 * path (a temporary directory is often reached through a link). */
export function rootSpellings(root: string): string[] {
  let real: string | undefined;
  try {
    real = realpathSync(root);
  } catch {
    real = undefined;
  }
  return real === undefined || real === root ? [root] : [root, real];
}

/** Remove a verifier's workspace (the findmnt-guarded removal the base pass
 * uses). */
export function removeVerifierWorkspace(workspace: VerifierWorkspace): void {
  removeWorkspaceCopy(workspace.holder);
}

function isOwnGitDirectory(copy: string): boolean {
  try {
    const entry = lstatSync(join(copy, ".git"));
    return entry.isDirectory() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * In the COPY only: commit the tree as delivered, through the sealed host git
 * boundary, and return the commit. A copy whose `.git` is a directory of its
 * own commits on top of the history it came with. A copy whose `.git` is a
 * link into another repository (a linked worktree), or that has none, first
 * loses that link and gets a repository of its own — so no git command here
 * can reach the developer's repository — and a copy whose own repository the
 * sealed boundary refuses is given a fresh one the same way. Ignored paths
 * stay out of the commit, exactly as they stay out of a developer's.
 */
export function snapshotDeliveredState(copy: string, remainingMs?: number): string {
  const timeoutMs = Math.max(1, Math.min(SNAPSHOT_STEP_MAX_MS, remainingMs ?? SNAPSHOT_STEP_MAX_MS));
  if (isOwnGitDirectory(copy)) {
    try {
      return commitDeliveredState(copy, timeoutMs);
    } catch {
      // The boundary refused the copied repository (or the commit failed in
      // it): the copy gets a repository of its own below.
    }
  }
  // Removed as what it is — a link as the link, a directory without ever
  // descending through one (S1, D57c): the copy is a tree a session wrote.
  removeTreeBeneath(safeRoot(copy, "the verifier copy"), Buffer.from(".git"), "detach");
  initializeStandaloneGit(copy);
  return commitDeliveredState(copy, timeoutMs);
}

function git(copy: string, args: readonly string[], timeoutMs: number): string {
  const result = spawnSealedHostGit(copy, args, { extraEnv: SNAPSHOT_IDENTITY, timeoutMs });
  if ((result.exitCode ?? 1) !== 0) {
    const detail = `${result.stdout.toString()}${result.stderr.toString()}`.trim().slice(0, 200);
    throw new Error(`git ${args[0] ?? ""} failed in the verifier copy: ${detail}`);
  }
  return result.stdout.toString();
}

function commitDeliveredState(copy: string, timeoutMs: number): string {
  if (!trackedInHead(copy, [LEDGER_MIRROR_PATH]).has(LEDGER_MIRROR_PATH)) {
    // The host's old mirror, when it is the file at that path of the copy: a
    // path that reaches it only through a link a session put there is not
    // the copy's mirror, and nothing is removed through it (S1).
    const root = safeRoot(copy, "the verifier copy");
    const mirror = Buffer.from(LEDGER_MIRROR_PATH);
    try {
      const entry = lstatBeneath(root, mirror, "remove");
      if (entry !== undefined && !entry.isDirectory()) unlinkBeneath(root, mirror, "remove");
    } catch (error) {
      if (!(error instanceof LinkSafetyError) || error.code === "root") throw error;
    }
  }
  // `git add --all` + `git commit`, without either (S2, D57e): git's `add`
  // asks a populated submodule whether it is dirty by starting a git inside
  // it, which reads that submodule's own configuration. The tree is the
  // host's own listing staged into an index of its own (I2, D57g), the
  // commit is made from it, and HEAD (the branch it names, or HEAD itself)
  // moves to it.
  const tree = stageTreeSealed(copy, { extraEnv: SNAPSHOT_IDENTITY, timeoutMs });
  const parent = spawnSealedHostGit(copy, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { timeoutMs });
  const parentHead = (parent.exitCode ?? 1) === 0 ? parent.stdout.toString().trim() : "";
  const commit = git(copy, ["commit-tree", tree, ...(/^[0-9a-f]{40}$/u.test(parentHead) ? ["-p", parentHead] : []), "-m", SNAPSHOT_MESSAGE], timeoutMs).trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error("the verifier copy's snapshot commit could not be made");
  git(copy, ["update-ref", "-m", "dokkabi: delivered state", "HEAD", commit], timeoutMs);
  const head = git(copy, ["rev-parse", "HEAD"], timeoutMs).trim();
  if (head !== commit) throw new Error("the verifier copy has no readable HEAD after its snapshot");
  // The copy is the host's own repository now: its index is WRITTEN to the
  // delivered commit (never read — I2, D57g), so the verifier's git sees a
  // clean tree at the delivered state.
  const reset = spawnSealedHostGit(copy, ["read-tree", commit], { extraEnv: SNAPSHOT_IDENTITY, timeoutMs, treeIndex: "host-made" });
  if ((reset.exitCode ?? 1) !== 0) throw new Error("the verifier copy's index could not be set to its snapshot");
  return head;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The runner the CLI drives the loop with: a verifier on a fresh copy, a fix
 * in the workspace, each a child `dokkabi work`, and the recheck after a fix
 * on a copy of its own (D45). `spawn` and `recheck` are the seams a test
 * replaces; everything else is the real thing.
 */
export function processStageRunner(input: {
  readonly launch: StageLaunch;
  readonly workspaceRoot: string;
  /** The run's own session id, which every stage session id starts with. */
  readonly session: string;
  readonly tag: string;
  readonly spawn?: StageSpawn;
  /** The recheck observation; the real one (observeRecheck) by default. */
  readonly recheck?: RecheckObserver;
  /** The run's own session directory (`<build session>-rounds`): each
   * verifier's authored files are kept under `verifier-<round>/files` there
   * (D47), and the tree's state before each fix under `fix-<round>` (D54).
   * Without it nothing is kept. */
  readonly roundsDir?: string;
  readonly progress?: (line: string) => void;
  readonly now?: () => number;
}): VerifyRoundsRunner {
  const spawn = input.spawn ?? spawnStage;
  const recheck: RecheckObserver = input.recheck ?? ((request) => observeRecheck(request, { workspaceRoot: input.workspaceRoot }));
  const progress = input.progress ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const now = input.now ?? Date.now;
  const roundsDir = input.roundsDir;
  /** The verifier's authored files, kept before its copy is removed (D47). */
  const keepFiles = (round: number, copy: string, remainingMs: number): VerifierFilesKept | undefined => {
    if (input.roundsDir === undefined) return undefined;
    const kept = keepVerifierFiles({ copy, dest: verifierFilesDir(input.roundsDir, round), timeoutMs: remainingMs });
    progress(`verify-rounds: verifier files round ${round} kept=${kept.kept} skipped=${kept.skipped} environment=${kept.environment}` +
      `${kept.reason === undefined ? "" : ` reason=${JSON.stringify(kept.reason)}`} dir=${kept.dir}`);
    return kept;
  };
  return {
    async verify(request: StageRequest): Promise<StageSession> {
      const session = stageSessionId(input.session, "verify", request.round, input.tag);
      let workspace: VerifierWorkspace;
      try {
        workspace = prepareVerifierWorkspace(input.workspaceRoot, request.deadlineMs - now());
      } catch (error) {
        return { session, error: `the verifier workspace could not be prepared: ${message(error).slice(0, 200)}` };
      }
      try {
        progress(`verify-rounds: verify round ${request.round} session=${session} workspace=${workspace.copy} base=${workspace.head.slice(0, 12)}`);
        const workspaceRoots = rootSpellings(workspace.copy);
        const exit = await spawn(stageCommand({
          launch: input.launch,
          session,
          workspace: workspace.copy,
          order: request.order,
          deadlineMs: request.deadlineMs,
          toolProfile: "verify",
        }));
        const verifierFiles = keepFiles(request.round, workspace.copy, request.deadlineMs - now());
        return { ...readStage(session, exit), workspaceRoots, ...(verifierFiles === undefined ? {} : { verifierFiles }) };
      } finally {
        removeVerifierWorkspace(workspace);
      }
    },
    async fix(request: StageRequest): Promise<StageSession> {
      const session = stageSessionId(input.session, "fix", request.round, input.tag);
      progress(`verify-rounds: fix round ${request.round} session=${session} workspace=${input.workspaceRoot}`);
      const exit = await spawn(stageCommand({
        launch: input.launch,
        session,
        workspace: input.workspaceRoot,
        order: request.order,
        deadlineMs: request.deadlineMs,
      }));
      return readStage(session, exit);
    },
    async recheck(request) {
      progress(`verify-rounds: recheck round ${request.round} cases=${request.cases.length} workspace=${input.workspaceRoot}`);
      return recheck(request);
    },
    async evidence(request: EvidenceRequest): Promise<EvidenceDelivery> {
      // The verifier of this round gets exactly this session id (verify
      // above), so its scratch is known before it starts.
      const session = stageSessionId(input.session, "verify", request.round, input.tag);
      const delivered = deliverDisputeEvidence({
        scratch: sessionScratchPath(sessionLogPath(session)),
        items: request.items,
        liveRoots: rootSpellings(input.workspaceRoot),
      });
      const complete = delivered.items.filter((item) => item.complete).length;
      const scratchFiles = delivered.items.reduce((sum, item) => sum + (item.scratch?.files ?? 0) + (item.scratch?.links ?? 0), 0);
      progress(`verify-rounds: dispute evidence round ${request.round} session=${session} disputes=${delivered.items.length}` +
        ` complete=${complete} scratch_entries=${scratchFiles}` +
        `${delivered.scratch === undefined ? "" : ` dir=${join(delivered.scratch, DISPUTE_EVIDENCE_DIR)}`}`);
      return { session, ...(delivered.scratch === undefined ? {} : { scratch: delivered.scratch }), items: delivered.items };
    },
    ...(roundsDir === undefined ? {} : {
      async preFix(request: { readonly round: number; readonly deadlineMs: number }): Promise<PreFixState> {
        const state = savePreFixState({
          workspaceRoot: input.workspaceRoot,
          dir: preFixStateDir(roundsDir, request.round),
          round: request.round,
          timeoutMs: request.deadlineMs - now(),
        });
        progress(`verify-rounds: pre-fix state round ${request.round} ` +
          `${state.saved ? `saved dir=${state.dir}` : `not saved reason=${JSON.stringify(state.reason ?? "")}`}`);
        return state;
      },
    }),
  };
}
