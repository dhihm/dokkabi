import { lastReceiptListings, recordsReceiptListings } from "./workspace-bash.ts";
import { ensureSessionScratch } from "../work/session-scratch.ts";
import {
  createEditTool,
  createReadTool,
  createWriteTool,
  NodeExecutionEnv,
  type AgentTool,
  type AgentHarnessTool,
} from "@earendil-works/pi-agent-core/node";
import { closeSync, constants, lstatSync, openSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HostContext, PluginModule, ToolContributionRegistry } from "../loader/types.ts";
import type { EventLog } from "../host/event-log.ts";
import { webFetch } from "../host/web-fetch.ts";
import { grepWorkspace, globWorkspaceListing, lsWorkspaceListing } from "../host/inspect.ts";
import { expandHomePath } from "../host/workspace-path.ts";
import { CREDENTIAL_PATH_REFUSAL, isSecretPath, isSecretWorkspaceTarget } from "../host/workspace-secrets.ts";
export { isSecretPath } from "../host/workspace-secrets.ts";
import {
  directoryPathError,
  filePathError,
  missingPathError,
  outsideWorkspaceError,
  toolPathErrorText,
} from "../host/path-error.ts";
import { createStrictReadOnlyPolicy, executeProbeLog, PROBE_LOG_BYTES_DEFAULT } from "../host/probe-log.ts";
import { sliceUtf8BytesHead } from "../tools/model-result.ts";
import { gitTracked } from "../host/git-view.ts";
import {
  appendRepoRead,
  appendRepoResult,
  pinHeader,
  repoGlob,
  repoGrep,
  repoLs,
  repoPin,
  repoShow,
  REPO_READ_LIMIT,
} from "../host/repo-view.ts";
import { readConfig } from "../host/config.ts";
import {
  appendPolicyEvent,
  createPolicy,
  disposeSandboxPolicy,
  type SandboxPolicy,
} from "../host/sandbox.ts";
import {
  boundBashTimeout,
  capBashTimeout,
  createWorkspaceBashTools,
  LIVE_BASH_TIMEOUT_DEFAULT_SECONDS,
  LIVE_BASH_TIMEOUT_MAX_SECONDS,
} from "./workspace-bash.ts";
import type { ExecutionReceiptViews } from "../host/execution-receipt.ts";
import { clampToolResultText, producerTruncation, textToolResult as textResult, type ProducerCoverage } from "../tools/model-result.ts";
import { markResultSourceReader, readNextOmittedRange, readSourceRange, sessionSources, sourceReadText } from "../host/result-source.ts";
import { probeTargetDigest } from "../host/probe-target.ts";
import { toolArgsCarryPrivateInfrastructure } from "../host/redact.ts";
import {
  AtomicWorkspaceExecutionEnv,
  LinkSafeWorkspaceExecutionEnv,
  type WorkspaceFileOperation,
} from "../host/workspace-execution-env.ts";
import {
  WorkspaceVersions,
  WorkspaceVersionsFacade,
  type VersionCapabilities,
  type WorkspaceVersionsApi,
} from "../host/workspace-versions.ts";
import { linuxTargetIo, portableTargetIo } from "../host/workspace-target-io.ts";
import { versionedMutation, versionedRead, versionHooksFor } from "./workspace-versioned-tools.ts";
import { createWorkspaceSpeculativeAuthorityRegistry } from "./workspace-speculative-authority.ts";
import { createWorkspaceGitTool } from "./workspace-speculative-authority-tools.ts";
import {
  createWorkspaceMutationAuthority,
  registerWorkspaceMutationProjector,
  revokeWorkspaceMutationProjector,
  transferWorkspaceMutationProjector,
} from "./workspace-mutation-authority.ts";
import {
  createWorkspaceBashReuseAuthority,
  registerWorkspaceBashReuseTool,
} from "./workspace-bash-reuse.ts";
import {
  createWorkspaceBashResultAuthority,
  registerWorkspaceBashResultTool,
} from "./workspace-bash-result-authority.ts";
import { liveLedger } from "../work/ledger-live.ts";
import { BaseUnavailable, requireSessionBase, sessionBase, sessionDigestCache } from "../work/session-base.ts";
import { listedEntryText, workspaceListing, type TreeListing } from "../host/execution-receipt.ts";
import { randomBytes } from "node:crypto";
import { bytesKey, exactUtf8 } from "../work/path-bytes.ts";
import { fileResourceFingerprint, fileResourceIdentity, type ReceivedReadMetadata } from "../host/received-calls.ts";

export {
  boundBashTimeout,
  capBashTimeout,
  LIVE_BASH_TIMEOUT_DEFAULT_SECONDS,
  LIVE_BASH_TIMEOUT_MAX_SECONDS,
} from "./workspace-bash.ts";
export { clampToolResultText } from "../tools/model-result.ts";

const REVIEW_BASH_TIMEOUT_SECONDS = 60;
const WORKSPACE_TOOL_DISPOSERS = new WeakMap<AgentTool[], () => void>();
const WORKSPACE_SECRET_PATH_GUARDS = new WeakMap<AgentTool, (path: string) => boolean>();

/** The generic loop asks the registered capability how its path is bound.
 * Foreign/immutable-object tools retain lexical policy; no tool-name dispatch
 * or mutable worktree lookup belongs in the loop. */
export function workspaceToolSecretPath(tools: readonly AgentTool[] | undefined, name: string, path: string): boolean {
  if (isSecretPath(path)) return true;
  return tools?.some(tool => tool.name === name && WORKSPACE_SECRET_PATH_GUARDS.get(tool)?.(path)) ?? false;
}
const WORKSPACE_TOOL_POLICIES = new WeakMap<readonly AgentTool[], SandboxPolicy>();
/** The authority behind each tool set: module-private (M5'); only its
 * facade leaves this module. */
const WORKSPACE_TOOL_VERSIONS = new WeakMap<readonly AgentTool[], { readonly impl: WorkspaceVersions; readonly facade: WorkspaceVersionsFacade }>();
/** #228 A1: the descriptor generation of each live tool set — a host-minted
 * id that exists exactly while the set is live and is gone once it is
 * disposed, so a consumer that enrolled these tool objects can tell a stale
 * enrolment from a live one by identity, never by name. */
const WORKSPACE_TOOL_GENERATIONS = new WeakMap<readonly AgentTool[], string>();
/** #228 A1: the read tool objects the HOST built for each live tool set —
 * `read`, `grep`, `glob`, `ls` and, when mounted, `repo` — by identity. A
 * contributed tool that merely carries one of those names is not among them. */
const WORKSPACE_TOOL_READERS = new WeakMap<readonly AgentTool[], ReadonlySet<AgentTool>>();
/** #224 A1: what the host states about each read tool OBJECT it built —
 * read-only, bounded, whether its cancellation is owned (in-process, it
 * settles) and, for `read` alone, the versioned resource identity a call
 * names (host/received-calls.ts). A tool without an entry, or without a
 * resource function, is never started early; a name proves nothing. */
const WORKSPACE_TOOL_RECEIVED_READS = new WeakMap<readonly AgentTool[], ReadonlyMap<AgentTool, ReceivedReadMetadata>>();
const WORKSPACE_SPECULATIVE_AUTHORITIES = createWorkspaceSpeculativeAuthorityRegistry();

/** The ledger session's plan hooks (interfaces-v3.md §1, "planning is
 * optional but visible"): a once-per-session `[no plan recorded]` notice on
 * the first tracked change recorded without a ledger revision, and — only
 * when the operator opted in — tracked writes refused until a plan exists. */
export interface LedgerPlanHooks {
  requirePlan: boolean;
}

const PLAN_REQUIRED_TEXT = "plan required before changing tracked files (--require-plan)";
const NO_PLAN_NOTICE = "[no plan recorded]";

/**
 * The state of the paths tracked at the session's base (C1, D57e): the
 * host's listing of the tree under the session's base (content digests,
 * I1), restricted to those paths, absent ones included — never git's view,
 * whose index and flags the session writes, and never a git process, whose
 * configuration the session writes (S2). Equal signatures across two reads
 * mean no path tracked at the base changed in between. A session whose base
 * cannot be had, or a listing with anything the host could not know, gives
 * a signature that equals no other (B1, U1): never taken as unchanged.
 */
function trackedChangeSignature(root: string, log: EventLog, listing: TreeListing): string {
  const unknown = () => `unknown:${randomBytes(16).toString("hex")}`;
  const base = sessionBase(log, root);
  if (base instanceof BaseUnavailable) return unknown();
  if (listing.unknown.length > 0) return unknown();
  const hash = createHash("sha256");
  for (const key of [...base.tracked.keys()].sort()) {
    hash.update(key).update("\0").update(listedEntryText(listing.entries.get(key))).update("\0");
  }
  return hash.digest("hex");
}

/** Read on every write and bash call, so from the log's running projection:
 * the rows appended since the last call, never the whole log (D48b). */
function hasLedgerRevision(log: import("../host/event-log.ts").EventLog): boolean {
  return liveLedger(log).fold.exists;
}

/** Append the one notice line to the tool result and record work/plan_notice.
 * Once per session (the row is the record), never blocking, no advice. */
function appendPlanNotice(
  log: import("../host/event-log.ts").EventLog,
  result: { content?: Array<{ type: string; text?: unknown }> | undefined },
  source: string,
): void {
  if (hasLedgerRevision(log)) return;
  if (log.events.some((event) => event.name === "work/plan_notice")) return;
  log.append({ kind: "observe", name: "work/plan_notice", payload: { notice: NO_PLAN_NOTICE, source } });
  const content = result.content ?? [];
  content.push({ type: "text", text: `\n\n${NO_PLAN_NOTICE}` });
  result.content = content;
}

/** The plan hooks for write/edit: the --require-plan refusal for tracked
 * paths, and the notice when a tracked file actually changed. */
export function guardLedgerPlanMutation(
  tool: AgentTool,
  root: string,
  log: import("../host/event-log.ts").EventLog,
  hooks: LedgerPlanHooks,
): AgentTool {
  const original = tool.execute.bind(tool);
  const guarded: AgentTool = {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate) {
      const target = typeof (params as { path?: unknown })?.path === "string"
        ? (params as { path: string }).path
        : undefined;
      // Tracked means tracked at the session's base (C1, D57e): a session
      // that drops a file from its index, flags it, or ignores it does not
      // make it writable without a plan.
      if (hooks.requirePlan && !hasLedgerRevision(log) && target && isTrackedWorkspacePath(root, target, log)) {
        return { content: [{ type: "text", text: PLAN_REQUIRED_TEXT }], details: {}, isError: true };
      }
      // Tools throw on failure, so reaching here means the write landed.
      const result = await original(toolCallId, params, signal, onUpdate);
      if (target && isTrackedWorkspacePath(root, target, log)) {
        appendPlanNotice(log, result, tool.name);
      }
      return result;
    },
  };
  transferWorkspaceMutationProjector(tool, guarded);
  return guarded;
}

/** The plan hooks for bash: while --require-plan is active and no plan
 * exists, the command runs under a read-only sibling policy; the notice
 * fires when a receipt says the command changed the tree AND tracked paths
 * actually differ around the call. */
export function guardLedgerPlanBash(
  tool: AgentTool,
  input: {
    root: string;
    log: import("../host/event-log.ts").EventLog;
    hooks: LedgerPlanHooks;
    policy: SandboxPolicy;
  },
): { tool: AgentTool; dispose: () => void } {
  const { root, log, hooks, policy } = input;
  const readOnly = hooks.requirePlan
    // A wrapper name of its own: the live bash tool's wrapper lives in the
    // same log directory, and a sibling writing `sandbox-sh` there would put
    // the read-only policy under every later command of the live tool.
    ? createWorkspaceBashTools({ workspaceRoot: root, policy: createStrictReadOnlyPolicy(root, policy), log, shellName: "sandbox-readonly-sh" })
    : undefined;
  const readOnlyBash = readOnly
    ? boundBashTimeout(readOnly.tools[0]!, {
        defaultSeconds: LIVE_BASH_TIMEOUT_DEFAULT_SECONDS,
        maxSeconds: LIVE_BASH_TIMEOUT_MAX_SECONDS,
        allowBackground: true,
      })
    : undefined;
  const original = tool.execute.bind(tool);
  // The host's own listing of the tree under the session's base (C1): no git
  // process runs around a bash call (S2: a session-set core.fsmonitor or
  // filter would otherwise run as the host, outside the sandbox). The
  // listings are the receipt's own two (D57g): no walk of its own — unless
  // the tool does not record them (then the guard lists the tree itself,
  // before and after, and only while the notice is still wanted).
  const noticeWanted = () => !hasLedgerRevision(log) && !log.events.some((event) => event.name === "work/plan_notice");
  let ownCache: ReturnType<typeof sessionDigestCache> | undefined;
  const ownListing = (): TreeListing | undefined => {
    try {
      ownCache ??= sessionDigestCache(log, root);
      return workspaceListing(root, ownCache);
    } catch {
      return undefined;
    }
  };
  const guarded: AgentTool = {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate) {
      // Only the notice reads the tracked state, and it fires once and only
      // before a plan exists: past that, a bash call costs nothing more here.
      const watching = noticeWanted();
      const beforeSeq = log.lastSeq;
      const useReadOnly = readOnlyBash !== undefined && !hasLedgerRevision(log);
      const selected = useReadOnly ? readOnlyBash! : tool;
      const listsItself = watching && !recordsReceiptListings(selected);
      const ownBefore = listsItself ? ownListing() : undefined;
      const run = useReadOnly ? readOnlyBash!.execute.bind(readOnlyBash) : original;
      const result = await run(toolCallId, params, signal, onUpdate);
      if (watching) {
        const receipt = [...log.events].reverse().find(
          (event) => event.seq > beforeSeq && event.name === "exec/receipt" && event.payload.changed === true,
        );
        if (receipt !== undefined) {
          const recorded = lastReceiptListings(log, String(receipt.payload.id));
          const ownAfter = listsItself && recorded === undefined ? ownListing() : undefined;
          const listings = recorded ?? (ownBefore !== undefined && ownAfter !== undefined ? { before: ownBefore, after: ownAfter } : undefined);
          // Listings the host does not have are unknown: never taken as
          // unchanged (U1).
          if (listings === undefined
            || trackedChangeSignature(root, log, listings.before) !== trackedChangeSignature(root, log, listings.after)) {
            appendPlanNotice(log, result, "bash");
          }
        }
      }
      return result;
    },
  };
  return { tool: guarded, dispose: () => readOnly?.dispose() };
}

export const createWorkspaceSpeculativeAuthority = WORKSPACE_SPECULATIVE_AUTHORITIES.create;
export { createWorkspaceMutationAuthority };
export { createWorkspaceBashReuseAuthority };
export { createWorkspaceBashResultAuthority };

/** Host-only lookup of the version authority behind these exact tools
 * (#221 M5): the one `authorize`/`commit`/`committed`/`onCommitted` API
 * consumers (#228 reads, #229 rename) use instead of a writer of their own. */
export function workspaceToolsVersions(tools: readonly AgentTool[]): WorkspaceVersionsApi | undefined {
  return WORKSPACE_TOOL_VERSIONS.get(tools)?.facade;
}

/** Host-only: what the authority behind these tools guarantees (M6). */
export function workspaceToolsVersionCapabilities(tools: readonly AgentTool[]): VersionCapabilities | undefined {
  return WORKSPACE_TOOL_VERSIONS.get(tools)?.impl.capabilities;
}

/** Host-only: make a consumer's own tool object a writer of this authority
 * (#229's rename tool). Only the host that built the tools can do this. */
export function registerWorkspaceVersionsWriter(tools: readonly AgentTool[], writer: AgentTool): boolean {
  const entry = WORKSPACE_TOOL_VERSIONS.get(tools);
  if (!entry || entry.impl.isRevoked) return false;
  entry.impl.register(writer, "write");
  return true;
}

/** Host-only lookup of the policy used by these exact live workspace tools. */
export function workspaceToolsPolicy(tools: readonly AgentTool[]): SandboxPolicy | undefined {
  return WORKSPACE_TOOL_POLICIES.get(tools);
}

/** Host-only: the descriptor generation of these exact tools (#228 A1) —
 * defined while the set is live, undefined once disposed. */
export function workspaceToolsGeneration(tools: readonly AgentTool[]): string | undefined {
  return WORKSPACE_TOOL_GENERATIONS.get(tools);
}

/** Host-only: the host-built read tools of these exact tools (#228 A1) —
 * the objects, never names — or undefined once the set is disposed. */
export function workspaceToolsReaders(tools: readonly AgentTool[]): ReadonlySet<AgentTool> | undefined {
  return WORKSPACE_TOOL_READERS.get(tools);
}

/** Host-only: the received-read metadata of these exact tools (#224 A1),
 * keyed by the host-built objects — or undefined once the set is disposed. */
export function workspaceToolsReceivedReads(tools: readonly AgentTool[]): ReadonlyMap<AgentTool, ReceivedReadMetadata> | undefined {
  // A copy: a consumer that writes to what it was handed forges nothing.
  const registered = WORKSPACE_TOOL_RECEIVED_READS.get(tools);
  return registered ? new Map(registered) : undefined;
}

export function disposeWorkspaceTools(tools: AgentTool[]): void {
  WORKSPACE_TOOL_DISPOSERS.get(tools)?.();
  WORKSPACE_TOOL_DISPOSERS.delete(tools);
}

export function createWorkspaceTools(
  workspaceRoot: string,
  options: {
    policy?: SandboxPolicy;
    /** Host-only enrollment for the structured Git provider, never generic bash. */
    gitMetadataWrite?: boolean;
    log?: import("../host/event-log.ts").EventLog;
    maek?: import("../maek/types.ts").MaekService;
    externalKnowledge?: boolean;
    reviewOnly?: boolean;
    workPhase?: string;
    contributions?: readonly AgentTool[];
    /** Fresh-image execution for `bash({isolated:true})`; resolved lazily so
     * a session without execution views falls back to the live workspace. */
    views?: () => ExecutionReceiptViews | undefined;
    announceReceipt?: () => boolean;
    /** Testable host capability boundary. fd-anchored tools require Linux. */
    platform?: NodeJS.Platform;
    /** Available local repository snapshot; omitted means the operator config. */
    repoRegistry?: Readonly<Record<string, string>>;
    /** Ledger-mode plan hooks (interfaces-v3.md §1); absent in every other
     * mode, so those tools stay byte-identical. */
    ledgerPlan?: LedgerPlanHooks;
    /** The ledger session's scratch directory (D48): the session's own
     * commands may write it and find it as DOKKABI_SCRATCH. Absent in every
     * other mode, so those policies stay byte-identical. */
    scratchRoot?: string;
    /** Version-aware mutations (#221). `session` (the default): writes and
     * edits need a receipt of what the model was shown. `speculative_candidate`:
     * a private copy made for one speculative call, whose authority is
     * decided when its effect is promoted into the session's tree — by the
     * session's own authority, before and after the promotion. */
    versions?: "session" | "speculative_candidate";
  } = {},
): AgentTool[] {
  const root = resolve(workspaceRoot);
  const currentWorkPhase = options.workPhase === undefined
    ? () => process.env.DOKKABI_WORK_PHASE
    : () => options.workPhase;
  const externalKnowledge =
    options.reviewOnly === true
      ? false
      : (options.externalKnowledge ?? process.env.DOKKABI_EXTERNAL_KNOWLEDGE !== "deny");
  // No loop without a sandbox: creating the policy throws when no backend
  // exists, so a session cannot open unfenced (issue #6).
  const policy =
    options.policy ??
    createPolicy({
      // The parent phase owns the trust decision: the SWE adapter opens an
      // envfix wave (network for dependency repair) by exporting the mode;
      // every other phase inherits the fenced default.
      mode: options.reviewOnly
        ? "read-only"
        : process.env.DOKKABI_SANDBOX_MODE === "envfix"
          ? "envfix"
          : "workspace-write",
      workspaceRoot: root,
      ...(options.gitMetadataWrite && !options.reviewOnly ? { gitMetadataWrite: true } : {}),
      ...(options.scratchRoot !== undefined && !options.reviewOnly ? { scratchRoot: options.scratchRoot } : {}),
      // G3 (D57g): the session's own tree shares the session's tool cache.
      ...(options.log ? { log: options.log, toolCache: "session" as const } : {}),
    });
  const log = options.log;
  if (log) {
    appendPolicyEvent(log, policy);
    // The session's base (C1, D57e): taken here, at boot, before the first
    // model request can reach any tool — or read back as its log names it.
    // None can be had: the session does not start (B1, D57f). A read-only
    // view (the dashboard, a replay) starts no session: it reads what the log
    // names, and every decision without a base is unknown.
    if (log.isReadOnly) sessionBase(log, root);
    else requireSessionBase(log, root);
  }
  const bash = createWorkspaceBashTools({
    workspaceRoot: root,
    policy,
    ...(log ? { log } : {}),
    ...(options.views ? { views: options.views } : {}),
    ...(options.announceReceipt ? { announceReceipt: options.announceReceipt } : {}),
  });
  const speculativePolicy = createStrictReadOnlyPolicy(root, policy);
  // The file tools bind to an fd-anchored environment on Linux, where
  // /proc/self/fd lets every read and write stay pinned to the directory
  // that was checked. Other platforms used to get no file tools at all,
  // which left the work loop with bash as its only writer — and bash is
  // not a finalizer, so once a decompose turn spent its tool budget on
  // exploration there was no way left to write the plan, on any retry,
  // ever. The portable binding below keeps the same path guards (realpath
  // containment, the decompose write policy, the private-literal check);
  // what it gives up is the fd pin against a symlink swapped in between the
  // check and the write. On these hosts bash can already write anywhere in
  // the workspace under the sandbox, so the pin was defence in depth, not
  // the boundary.
  const linux = (options.platform ?? process.platform) === "linux";
  const bindFile = (tool: AgentHarnessTool<{ env: NodeExecutionEnv }>, operation: WorkspaceFileOperation): AgentTool =>
    linux ? bindWorkspaceFileTool(tool, root, operation) : bindPortableWorkspaceFileTool(tool, root, operation);
  // One authority per tool set: the receipts are this session's (M1), the
  // queue is the process's (M3), the binding a recorded capability (M6).
  const versions = options.versions === "speculative_candidate"
    ? undefined
    : new WorkspaceVersions({ root, io: linux ? linuxTargetIo(root) : portableTargetIo(root), ...(log ? { log } : {}) });
  const readTool = guardWorkspaceRead(bindFile(createReadTool(), "read"), root, versions);
  const grepTool = createGrepTool(workspaceRoot);
  const globTool = createGlobTool(workspaceRoot);
  const lsTool = createLsTool(workspaceRoot);
  const repoRegistry = externalKnowledge ? { ...(options.repoRegistry ?? readConfig().repos ?? {}) } : {};
  const repoTool = externalKnowledge && Object.keys(repoRegistry).length ? createRepoTool(log, repoRegistry) : undefined;
  // The host's own read tools, by identity (#228 A1): what a read batch may
  // enrol. A contribution named like one of them is not one of them.
  const hostReaders = new Set<AgentTool>([readTool, grepTool, globTool, lsTool, ...(repoTool ? [repoTool] : [])]);
  const mutationTools = options.reviewOnly ? [] : [
    guardWorkspaceMutation(bindFile(createWriteTool(), "write"), root, true, currentWorkPhase, log, versions),
    guardWorkspaceMutation(bindFile(createEditTool(), "edit"), root, false, currentWorkPhase, log, versions),
  ];
  const probeTool = createProbeLogTool(workspaceRoot, { policy: speculativePolicy, ...(log ? { log } : {}) });
  const workspacePathTools = new Set<AgentTool>([readTool, ...mutationTools, grepTool, lsTool, probeTool]);
  const fdAnchoredTools = [
    readTool,
    ...mutationTools,
    grepTool,
    globTool,
    lsTool,
    probeTool,
  ];
  const tools = [
    ...fdAnchoredTools,
    ...(externalKnowledge && repoTool
      ? [createWebFetchTool(log), repoTool]
      : []),
    ...(options.contributions ?? []),
    createWorkspaceGitTool(workspaceRoot, "status", speculativePolicy),
    createWorkspaceGitTool(workspaceRoot, "diff", speculativePolicy),
    createWorkspaceGitTool(workspaceRoot, "log"),
    // MAEK is this session's own local evidence index, not external
    // knowledge: it mounts whenever the service exists, including in private
    // swarm children where DOKKABI_EXTERNAL_KNOWLEDGE=deny fences the web.
    ...(options.maek ? [createMaekTool(options.maek)] : []),
    ...(options.reviewOnly
      ? [capBashTimeout(bash.tools[0]!, REVIEW_BASH_TIMEOUT_SECONDS)]
      : [
          boundBashTimeout(bash.tools[0]!, {
            defaultSeconds: LIVE_BASH_TIMEOUT_DEFAULT_SECONDS,
            maxSeconds: LIVE_BASH_TIMEOUT_MAX_SECONDS,
            allowBackground: true,
          }),
          ...bash.tools.slice(1),
        ]),
  ];
  const { tools: surfaced, revokeLedgerPlanBash } = surfaceWorkspaceTools(tools, {
    root,
    policy,
    ...(log ? { log } : {}),
    ...(options.ledgerPlan ? { ledgerPlan: options.ledgerPlan } : {}),
  });
  const revokeSpeculation = WORKSPACE_SPECULATIVE_AUTHORITIES.register({ tools: surfaced, policy: speculativePolicy });
  const registeredBash = surfaced.find((tool) => tool.name === "bash");
  const bashReuse = registeredBash ? registerWorkspaceBashReuseTool(registeredBash, policy) : undefined;
  const revokeBashResult = registeredBash && bashReuse
    ? registerWorkspaceBashResultTool(registeredBash, bashReuse.registerAlias)
    : () => {};
  WORKSPACE_TOOL_POLICIES.set(surfaced, policy);
  WORKSPACE_TOOL_GENERATIONS.set(surfaced, `wg_${randomBytes(8).toString("hex")}`);
  // Surfacing maps each tool 1:1 in order, so the host's readers are the
  // surfaced objects at the same positions.
  WORKSPACE_TOOL_READERS.set(surfaced, new Set(tools.flatMap((tool, index) => hostReaders.has(tool) ? [surfaced[index]!] : [])));
  tools.forEach((tool, index) => {
    if (!workspacePathTools.has(tool)) return;
    WORKSPACE_SECRET_PATH_GUARDS.set(surfaced[index]!, path =>
      // A recorded source digest is not a workspace file, even if a local
      // pathname happens to have the same 64-hex spelling.
      !(tool === probeTool && probeTargetDigest(path) !== undefined) && isSecretWorkspaceTarget(root, path));
  });
  // #224 A1: the host's statement about its own readers, by surfaced object.
  // Only `read` names a versioned resource (one regular file, its stat
  // identity); grep/glob/ls read a tree and state no version identity.
  const receivedReads = new Map<AgentTool, ReceivedReadMetadata>();
  for (const [index, tool] of tools.entries()) {
    const surfacedTool = surfaced[index]!;
    if (tool === readTool) {
      receivedReads.set(surfacedTool, Object.freeze({
        readOnly: true as const, bounded: true as const, cancellation: "owned" as const,
        resource: (args: Readonly<Record<string, unknown>>) => typeof args.path === "string" ? fileResourceIdentity(root, args.path) : undefined,
        fingerprint: (args: Readonly<Record<string, unknown>>) => typeof args.path === "string" ? fileResourceFingerprint(root, args.path) : undefined,
      }));
    } else if (tool === grepTool || tool === globTool || tool === lsTool) {
      receivedReads.set(surfacedTool, Object.freeze({ readOnly: true as const, bounded: true as const, cancellation: "owned" as const }));
    }
  }
  WORKSPACE_TOOL_RECEIVED_READS.set(surfaced, receivedReads);
  if (versions) WORKSPACE_TOOL_VERSIONS.set(surfaced, { impl: versions, facade: new WorkspaceVersionsFacade(versions) });
  WORKSPACE_TOOL_DISPOSERS.set(surfaced, () => {
    WORKSPACE_TOOL_POLICIES.delete(surfaced);
    WORKSPACE_TOOL_GENERATIONS.delete(surfaced);
    WORKSPACE_TOOL_READERS.delete(surfaced);
    WORKSPACE_TOOL_RECEIVED_READS.delete(surfaced);
    WORKSPACE_TOOL_VERSIONS.delete(surfaced);
    for (const tool of surfaced) WORKSPACE_SECRET_PATH_GUARDS.delete(tool);
    versions?.revoke();
    for (const tool of surfaced) revokeWorkspaceMutationProjector(tool);
    revokeSpeculation();
    bashReuse?.revoke();
    revokeBashResult();
    revokeLedgerPlanBash();
    try {
      bash.dispose();
    } finally {
      if (speculativePolicy !== policy) disposeSandboxPolicy(speculativePolicy);
    }
  });
  return surfaced;
}

/**
 * The guards every surfaced tool passes through, in order: the ledger-mode
 * plan hooks (mode-scoped, only when the caller asked for them), then — the
 * docker backend only — the execution alias (`/testbed/…`) mapped to the
 * workspace path OUTERMOST, before any guard sees the path (P2, D57f): a
 * guard decides by what a path reaches, never by how it is spelled.
 */
export function surfaceWorkspaceTools(
  tools: readonly AgentTool[],
  input: {
    readonly root: string;
    readonly policy: SandboxPolicy;
    readonly log?: EventLog;
    readonly ledgerPlan?: LedgerPlanHooks;
  },
): { readonly tools: AgentTool[]; readonly revokeLedgerPlanBash: () => void } {
  const { root, policy, log, ledgerPlan } = input;
  let revokeLedgerPlanBash: () => void = () => {};
  const planned = ledgerPlan && log
    ? tools.map((tool) => {
        if (tool.name === "write" || tool.name === "edit") {
          return guardLedgerPlanMutation(tool, root, log, ledgerPlan);
        }
        if (tool.name === "bash") {
          const guarded = guardLedgerPlanBash(tool, { root, log, hooks: ledgerPlan, policy });
          revokeLedgerPlanBash = guarded.dispose;
          return guarded.tool;
        }
        return tool;
      })
    : [...tools];
  const surfaced = policy.backend === "docker"
    ? planned.map((tool) => aliasDockerWorkspacePath(tool, root))
    : planned;
  return { tools: surfaced, revokeLedgerPlanBash };
}

export function workspaceToolPath(workspaceRoot: string, target: string): string {
  if (target === "/testbed") return resolve(workspaceRoot);
  if (target.startsWith("/testbed/")) return join(resolve(workspaceRoot), target.slice("/testbed/".length));
  return target;
}

function aliasDockerWorkspacePath(tool: AgentTool, workspaceRoot: string): AgentTool {
  const original = tool.execute.bind(tool);
  const aliased: AgentTool = {
    ...tool,
    execute: (toolCallId, params, signal, onUpdate) => {
      const path = typeof (params as { path?: unknown }).path === "string"
        ? (params as { path: string }).path
        : undefined;
      const mapped = path ? workspaceToolPath(workspaceRoot, path) : undefined;
      const mappedParams = mapped && mapped !== path && typeof params === "object" && params !== null
        ? Object.assign({}, params, { path: mapped })
        : params;
      return original(
        toolCallId,
        mappedParams,
        signal,
        onUpdate,
      );
    },
  };
  transferWorkspaceMutationProjector(tool, aliased);
  return aliased;
}

/**
 * During decompose the model may only create RED tests and the plan file.
 * Product source edits wait for implement — otherwise SWE-style orders get
 * fixed in the gate/decompose turn and the DAG never seals.
 */
export function isDecomposeWritablePath(workspaceRoot: string, target: string): boolean {
  const root = resolve(workspaceRoot);
  const absolute = resolve(root, target);
  if (!pathInsideWorkspace(root, absolute)) {
    return false;
  }
  const rel = absolute
    .slice(root.length)
    .replace(/^[/\\]+/, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/");
  if (rel === "work/current.json" || rel.startsWith("work/")) {
    return true;
  }
  if (rel.startsWith("tests/") || rel.includes("/tests/")) {
    return true;
  }
  // Python / JS test file naming outside tests/
  if (/(^|\/)test_[^/]+\.(py)$/.test(rel) || /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(rel)) {
    return true;
  }
  return false;
}

/**
 * Where a tool's path argument reaches in the workspace (P2, D57f): the path
 * as the tool will take it (`~/` expanded, relative to the root), its
 * longest existing prefix canonicalised by the file system itself
 * (realpath.native: links followed, case and Unicode normalisation folded
 * exactly as the volume folds them), the rest byte-exact; and, when it
 * exists, the inode it reaches. Undefined when it reaches outside the tree.
 */
export function workspacePathReach(workspaceRoot: string, target: string): { readonly relative: Buffer; readonly inode?: string } | undefined {
  const root = resolve(workspaceRoot);
  const absolute = resolve(root, expandHomePath(target));
  let rootReal: string;
  try {
    rootReal = realpathSync.native(root);
  } catch {
    return undefined;
  }
  let prefix = absolute;
  const rest: string[] = [];
  for (;;) {
    let real: string | undefined;
    try {
      real = realpathSync.native(prefix);
    } catch {
      real = undefined;
    }
    if (real !== undefined) {
      if (real !== rootReal && !real.startsWith(`${rootReal}${sep}`)) return undefined;
      const within = real === rootReal ? "" : real.slice(rootReal.length + 1);
      const relative = [within, ...rest].filter((part) => part !== "").join("/");
      if (relative === "") return undefined;
      let inode: string | undefined;
      if (rest.length === 0) {
        try {
          const stat = statSync(real, { bigint: true });
          inode = stat.isFile() ? `${stat.dev}:${stat.ino}` : undefined;
        } catch {
          inode = undefined;
        }
      }
      return { relative: Buffer.from(relative.split(sep).join("/")), ...(inode === undefined ? {} : { inode }) };
    }
    const parent = dirname(prefix);
    if (parent === prefix) return undefined;
    rest.unshift(prefix.slice(parent.length).replace(/^[/\\]+/u, ""));
    prefix = parent;
  }
}

/** Whether `target` is tracked, decided by what it reaches (P2, D57f), not
 * by how it is spelled. With a session log: tracked at the session's base
 * (C1, D57e) — the host's record, never the live index a session writes —
 * by the path the file system resolves it to, or, for an existing file, by
 * the inode the base recorded for a tracked file (a hard link, a rename the
 * volume folds). A session whose base cannot be had takes every path as
 * tracked (B1, U1: unknown is never harmless). Without a log: the fenced
 * git view, asked about the resolved path. */
export function isTrackedWorkspacePath(workspaceRoot: string, target: string, log?: EventLog): boolean {
  const root = resolve(workspaceRoot);
  const reach = workspacePathReach(root, target);
  if (reach === undefined) return false;
  if (log !== undefined) {
    const base = sessionBase(log, root);
    if (base instanceof BaseUnavailable) return true;
    if (base.tracked.has(bytesKey(reach.relative))) return true;
    if (reach.inode !== undefined) return base.coverage.trackedInodes?.has(reach.inode) === true;
    // F1 (D57g): a path that does not exist yet is tracked when a path the
    // base tracked folds to it as the file system would fold it in the
    // directory that would hold it (probed there, now).
    return foldsToTracked(root, reach.relative.toString(), base.tracked.keys());
  }
  return gitTracked({ root, path: reach.relative.toString() });
}

/**
 * F1 (D57g, design memo §121): whether a tracked path of the base folds to
 * `relative` — a path that does not exist — under the folding of the
 * directory that would hold it: its deepest existing directory, probed there
 * at decision time (a probe file made exclusively, never through a link, and
 * removed at once: does the volume find it under another case, under the
 * other Unicode normalisation?). The existing part is compared as the file
 * system spells it; only the remainder is folded. A legitimate new path is
 * never refused for this: only a base path that folds to it counts.
 */
export function foldsToTracked(root: string, relative: string, tracked: Iterable<string>): boolean {
  const parts = relative.split("/").filter((part) => part !== "");
  let existing = parts.length;
  const rootReal = realpathSync.native(root);
  for (; existing > 0; existing -= 1) {
    try {
      if (lstatSync(join(rootReal, ...parts.slice(0, existing))).isDirectory()) break;
    } catch {
      // Not there yet.
    }
  }
  const prefix = parts.slice(0, existing);
  const rest = parts.slice(existing);
  if (rest.length === 0) return false;
  const folding = probeFolding(join(rootReal, ...prefix));
  const fold = (text: string) => {
    let out = text;
    if (folding.normalisation) out = out.normalize("NFC");
    if (folding.case) out = out.toLowerCase();
    return out;
  };
  const want = rest.map(fold);
  for (const key of tracked) {
    const text = exactUtf8(Buffer.from(key, "latin1"));
    if (text === undefined) continue;
    const segments = text.split("/");
    if (segments.length !== prefix.length + rest.length) continue;
    if (segments.slice(0, prefix.length).some((segment, index) => segment !== prefix[index])) continue;
    if (segments.slice(prefix.length).every((segment, index) => fold(segment) === want[index])) return true;
  }
  return false;
}

/** How the file system folds names in `dir`, found by asking it: a probe
 * file named with an upper-case letter and a precomposed character, made
 * exclusively and removed at once. A directory the host cannot probe folds
 * both ways (the guard then errs toward the base's paths). */
function probeFolding(dir: string): { readonly case: boolean; readonly normalisation: boolean } {
  const stem = `.dokkabi-fold-${randomBytes(6).toString("hex")}-`;
  const probe = join(dir, `${stem}A\u00e9`);
  let fd: number | undefined;
  try {
    fd = openSync(probe, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const exists = (name: string) => {
      try {
        lstatSync(join(dir, name));
        return true;
      } catch {
        return false;
      }
    };
    return { case: exists(`${stem}a\u00e9`), normalisation: exists(`${stem}Ae\u0301`) };
  } catch {
    return { case: true, normalisation: true };
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
      try {
        unlinkSync(probe);
      } catch {
        // Already gone.
      }
    }
  }
}

function guardWorkspaceRead(tool: AgentTool, workspaceRoot: string, versions?: WorkspaceVersions): AgentTool {
  const original = tool.execute.bind(tool);
  const guarded: AgentTool = {
    ...tool,
    execute: (toolCallId, params, signal, onUpdate) => {
      const target = workspaceTarget(params);
      if (target === undefined) return original(toolCallId, params, signal, onUpdate);
      const check = classifyWorkspaceToolPath(workspaceRoot, "read", target, {
        allowMissing: false,
        needsFile: "read needs a file",
      });
      if (!check.ok) return Promise.resolve(workspacePathRefusal(check.text));
      const next = replaceWorkspaceTarget(params, check.relative);
      if (!versions) return original(toolCallId, next, signal, onUpdate);
      // M1: the receipt is minted from the bytes this call read and the
      // text it returned, by this registered tool object only.
      return versionedRead({
        versions,
        caller: guarded,
        tool: tool.name,
        callId: toolCallId,
        rel: check.relative,
        params: next,
        run: () => original(toolCallId, next, signal, onUpdate),
      });
    },
  };
  versions?.register(guarded, "read");
  return guarded;
}

function guardWorkspaceMutation(
  tool: AgentTool,
  workspaceRoot: string,
  allowMissingTarget: boolean,
  workPhase: () => string | undefined,
  log?: EventLog,
  versions?: WorkspaceVersions,
): AgentTool {
  const original = tool.execute.bind(tool);
  const holder: { guarded?: AgentTool } = {};
  const guardedExecute = (terminal: AgentTool["execute"], native: boolean): AgentTool["execute"] =>
    async (toolCallId, params, signal, onUpdate) => {
      const target = workspaceTarget(params);
      let safeTarget: string | undefined;
      if (target !== undefined) {
        const check = classifyWorkspaceToolPath(
          workspaceRoot,
          tool.name === "write" ? "write" : "edit",
          target,
          {
            allowMissing: allowMissingTarget,
            needsFile: tool.name === "write" ? "write needs a file path" : "edit needs a file",
          },
        );
        if (!check.ok) return workspacePathRefusal(check.text);
        safeTarget = check.relative;
      }
      if (toolArgsCarryPrivateInfrastructure(params)) {
        return {
          content: [{
            type: "text" as const,
            text: "workspace mutation refused: private infrastructure literals are blocked. Do not stage or encode them in workspace files; use an already-available authorized logical-alias tool or report the blocker to the operator.",
          }],
          details: {},
          isError: true,
        };
      }
      if (workPhase() === "decompose") {
        const requestedPath = typeof (params as { path?: unknown }).path === "string"
          ? (params as { path: string }).path
          : "";
        const policyPath = safeTarget ?? requestedPath;
        // Decided by what the path reaches (P2, D57f): a link under tests/
        // to a product file is the product file.
        const reached = workspacePathReach(workspaceRoot, policyPath)?.relative.toString();
        if (!requestedPath || reached === undefined || !isDecomposeWritablePath(workspaceRoot, reached)) {
          return {
            content: [{ type: "text" as const,
              text: `decompose phase: writes limited to tests/ and work/ (refused ${requestedPath || "(missing path)"}). Product fixes belong in implement after the graph seals.` }],
            details: {}, isError: true,
          };
        }
        if (isTrackedWorkspacePath(workspaceRoot, policyPath, log)) {
          return {
            content: [{ type: "text" as const,
              text: `decompose phase: tracked test files are read-only (refused ${requestedPath}). Put the private RED in a new test file.` }],
            details: {}, isError: true,
          };
        }
      }
      const next = safeTarget === undefined ? params : replaceWorkspaceTarget(params, safeTarget);
      // A call that already carries its operation's hooks is the same
      // operation re-entering (a speculative fallback to the native tool):
      // the outer guard holds the queue and the decision.
      if (!versions || safeTarget === undefined || versionHooksFor(tool.name, toolCallId) !== undefined) {
        return terminal(toolCallId, next, signal, onUpdate);
      }
      return versionedMutation({
        versions,
        caller: holder.guarded!,
        tool: tool.name === "write" ? "write" : "edit",
        callId: toolCallId,
        rel: safeTarget,
        params: next,
        native,
        run: () => terminal(toolCallId, next, signal, onUpdate),
      });
    };
  const guarded: AgentTool = {
    ...tool,
    description: `${tool.description} Before changing an existing file, use the registered read tool on its current bytes. Shell reads (bash or bash_probe), grep and previews do not grant edit authority. Read every replaced span for edit; read the complete file for overwrite.`,
    execute: guardedExecute(original, true),
  };
  holder.guarded = guarded;
  versions?.register(guarded, "write");
  registerWorkspaceMutationProjector(guarded, (surface, terminal) => ({ ...surface, execute: guardedExecute(terminal, false) }));
  return guarded;
}

function workspaceTarget(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const target = Reflect.get(params, "path");
  return typeof target === "string" ? target : undefined;
}

function replaceWorkspaceTarget(params: unknown, target: string): unknown {
  return typeof params === "object" && params !== null
    ? Object.assign({}, params, { path: target })
    : params;
}

function workspacePathRefusal(text: string) {
  return {
    content: [{
      type: "text" as const,
      text,
    }],
    details: { error: true },
    isError: true,
  };
}

/**
 * Check both the declared path and the filesystem path. The lexical check
 * rejects absolute/traversal escapes; realpath rejects existing symlinks that
 * leave the workspace. Writes may name a missing target, so their nearest
 * existing ancestor is the object that must remain inside the canonical root.
 * A `~/…` argument expands against the operator's real home first — that is
 * the spelling tool output carries after home-path normalization — and an
 * expansion that lands outside the workspace is refused exactly like any
 * other absolute path.
 *
 * A refusal says which condition failed — outside the workspace, does not
 * exist, or the wrong kind for the tool — in the shared vocabulary of
 * host/path-error.ts. One conflated boundary message cost a live M3 run ten
 * grep calls against files that were inside the workspace.
 */
function classifyWorkspaceToolPath(
  workspaceRoot: string,
  tool: "read" | "write" | "edit",
  target: string,
  options: { allowMissing: boolean; needsFile: string },
): { ok: true; relative: string } | { ok: false; text: string } {
  const declaredRoot = resolve(workspaceRoot);
  const absoluteTarget = resolve(declaredRoot, expandHomePath(target));
  const outside = () => ({ ok: false as const, text: outsideWorkspaceError(tool, target).message });
  if (!resolvedPathInside(declaredRoot, absoluteTarget)) return outside();
  if (isSecretPath(target)) return { ok: false, text: CREDENTIAL_PATH_REFUSAL };

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(declaredRoot);
  } catch {
    return outside();
  }

  let exists = false;
  try {
    // stat, not lstat: the kind that matters is the one a link resolves to.
    const stats = statSync(absoluteTarget);
    exists = true;
    if (stats.isDirectory()) {
      return { ok: false, text: directoryPathError(tool, target, options.needsFile).message };
    }
  } catch (error) {
    const code = workspaceErrorCode(error);
    if (code === "ENOTDIR") {
      // An intermediate component is a file; name it rather than the path.
      const blocker = blockingFileAncestor(declaredRoot, absoluteTarget);
      if (blocker !== undefined) {
        return { ok: false, text: filePathError(tool, blocker, `${tool} needs a directory there`).message };
      }
      return { ok: false, text: missingPathError(tool, target).message };
    }
    if (code !== "ENOENT") return outside();
    if (!options.allowMissing) {
      return { ok: false, text: missingPathError(tool, target).message };
    }
  }

  const filesystemTarget = exists ? absoluteTarget : nearestExistingPath(absoluteTarget);
  if (!filesystemTarget) return outside();
  try {
    const canonicalBase = realpathSync(filesystemTarget);
    if (!resolvedPathInside(canonicalRoot, canonicalBase)) return outside();
    const canonicalTarget = resolve(canonicalBase, relative(filesystemTarget, absoluteTarget));
    if (!resolvedPathInside(canonicalRoot, canonicalTarget)) return outside();
    if (isSecretPath(relative(canonicalRoot, canonicalTarget))) {
      return { ok: false, text: CREDENTIAL_PATH_REFUSAL };
    }
    // Use a canonical path relative to the workspace. This avoids following
    // the caller's symlink again without exposing the host workspace root in
    // tool-result messages or edit patches.
    return { ok: true, relative: relative(canonicalRoot, canonicalTarget) || "." };
  } catch {
    // A broken link names nothing: the target does not exist. Writes still
    // refuse here rather than create through a link nobody canonicalized.
    return { ok: false, text: missingPathError(tool, target).message };
  }
}

/** The nearest ancestor that exists and is not a directory, workspace-relative. */
function blockingFileAncestor(declaredRoot: string, target: string): string | undefined {
  let cursor = target;
  while (true) {
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
    try {
      if (statSync(cursor).isDirectory()) return undefined;
      const rel = relative(declaredRoot, cursor);
      return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? undefined : rel;
    } catch {
      // Keep walking up past the missing tail.
    }
  }
}

function workspaceErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(Reflect.get(error, "code"))
    : undefined;
}

function nearestExistingPath(target: string): string | undefined {
  let cursor = target;
  while (true) {
    try {
      lstatSync(cursor);
      return cursor;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? Reflect.get(error, "code")
        : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
      const parent = dirname(cursor);
      if (parent === cursor) return undefined;
      cursor = parent;
    }
  }
}

function resolvedPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function pathInsideWorkspace(workspaceRoot: string, target: string): boolean {
  const root = resolve(workspaceRoot);
  const abs = resolve(root, target);
  return resolvedPathInside(root, abs);
}

export function isSafeWorkspaceTransferSource(workspaceRoot: string, target: string): boolean {
  const mapped = workspaceToolPath(workspaceRoot, target);
  return isDecomposeWritablePath(workspaceRoot, mapped) && isSafeWorkspaceFileSource(workspaceRoot, target);
}

/** Safe read-only artifact scope, independent of decompose-phase write locations. */
export function isSafeWorkspaceFileSource(workspaceRoot: string, target: string): boolean {
  const mapped = workspaceToolPath(workspaceRoot, target);
  if (isSecretWorkspaceTarget(workspaceRoot, mapped)) return false;
  const root = resolve(workspaceRoot);
  const absolute = resolve(root, mapped);
  if (!resolvedPathInside(root, absolute)) return false;
  try {
    const entry = lstatSync(absolute);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) return false;
    const canonicalRoot = realpathSync(root);
    const canonicalTarget = realpathSync(absolute);
    return resolvedPathInside(canonicalRoot, canonicalTarget);
  } catch {
    return false;
  }
}

function createWebFetchTool(log?: EventLog): AgentTool {
  return {
    name: "web_fetch",
    label: "web fetch",
    description:
      "Fetch a URL over anonymous public HTTPS (host-side, logged; bash itself has no network). Returns readable HTML article text with title/final URL, follows bounded HTTPS/HTML meta redirects without executing JavaScript, and retains the complete safe text for probe_log recovery if delivery is clipped. A redirect/challenge or missing source is not documentation evidence. Verify cited pages and release versions rather than inventing unvisited links. GitHub URLs are refused — use the github tool for issues, files, and listings.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute https URL to fetch." },
      },
      required: ["url"],
      additionalProperties: false,
    } as never,
    async execute(toolCallId, params) {
      void toolCallId;
      const url = typeof (params as { url?: unknown }).url === "string" ? (params as { url: string }).url : "";
      if (!log) {
        return {
          content: [{ type: "text", text: "web_fetch unavailable: no session log" }],
          details: { error: true },
        };
      }
      const outcome = await webFetch({ log, url });
      return {
        content: [{ type: "text", text: outcome.text }],
        details: { error: outcome.error, url, final_url: outcome.final_url, format: outcome.format, source_blob: outcome.source_blob, source_bytes: outcome.source_bytes },
      };
    },
  };
}

/**
 * repo: read a registered repository outside the workspace, at a pinned
 * commit. Reads come straight out of git object storage — no worktree, no
 * export, no copy on disk — so the operator's clone is never mutated and a
 * multi-gigabyte repository costs nothing to read. Every read records the
 * sha it came from.
 */
function createRepoTool(log: EventLog | undefined, registry: Readonly<Record<string, string>>): AgentTool {
  return {
    name: "repo",
    label: "repo",
    description:
      "Read a registered local repository at a pinned commit. op 'pin' resolves a revision (default: the clone's origin default branch) and reports its sha, commit date, and subject; 'grep', 'glob', 'ls', and 'read' operate on the tree at that commit, including files the checked-out branch does not have. Use it to check a claim against real source when the repository is registered; unregistered repositories are refused, and github is the remote fallback.",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["pin", "grep", "glob", "ls", "read"], description: "What to do." },
        repo: { type: "string", enum: Object.keys(registry).sort(), description: "Available registered local repository, as owner/name. Other remote repositories use github." },
        ref: { type: "string", description: "Branch, tag, or sha. Default: the clone's origin default branch." },
        pattern: { type: "string", description: "Regex, for op=grep." },
        glob: { type: "string", description: "Glob pattern for op=glob, or a file filter for op=grep." },
        path: { type: "string", description: "Path inside the repository, for op=ls/read/grep." },
        case_sensitive: { type: "boolean", description: "grep only. Default true." },
        max_results: { type: "number", description: "grep only. Default 200." },
      },
      required: ["op", "repo"],
      additionalProperties: false,
    } as never,
    async execute(toolCallId, params) {
      void toolCallId;
      const p = params as {
        op?: string;
        repo?: string;
        ref?: string;
        pattern?: string;
        glob?: string;
        path?: string;
        case_sensitive?: boolean;
        max_results?: number;
      };
      if (!log) {
        return textResult("repo: no session log", true);
      }
      const ops = ["pin", "grep", "glob", "ls", "read"];
      if (typeof p.op !== "string" || !ops.includes(p.op)) {
        return textResult(`repo: op must be one of ${ops.join(", ")}`, true);
      }
      if (typeof p.repo !== "string" || p.repo.length === 0) {
        return textResult("repo: repo is required, as owner/name", true);
      }
      if (typeof p.path === "string" && isSecretPath(p.path)) {
        return textResult(CREDENTIAL_PATH_REFUSAL, true);
      }
      let pin;
      try {
        pin = repoPin({
          registry,
          repo: p.repo,
          ...(p.ref !== undefined ? { ref: p.ref } : {}),
        });
      } catch (error) {
        return textResult(`repo: ${error instanceof Error ? error.message : String(error)}`, true);
      }
      const header = pinHeader(pin);
      // #228 Q1': every repo result states what it covers. A git run is a
      // synchronous subprocess bounded by its own timeout; its termination is
      // its settlement (C1'').
      // E1': the base's text, clamp and `error` field; the statement is additive.
      const covered = (text: string, coverage: ProducerCoverage) => {
        const base = textResult(text);
        const clamp = (base.details as { producer_truncated?: true }).producer_truncated === true;
        return { content: base.content, details: { ...base.details, coverage: { ...coverage, ...(clamp ? { complete: false, reason: "producer" as const } : {}) } } };
      };
      if (p.op === "pin") {
        return covered(
          [
            header,
            `subject: ${pin.subject}`,
            "Read this commit with op grep, glob, ls, or read on the same repo.",
          ].join("\n"),
          { complete: true, unit: "whole" },
        );
      }
      const target = p.pattern ?? p.glob ?? p.path ?? ".";
      // Effect first: a rejected append cancels the read.
      appendRepoRead(log, pin, p.op, target);
      try {
        if (p.op === "grep") {
          if (typeof p.pattern !== "string" || p.pattern.length === 0) {
            return textResult("repo grep: pattern is required", true);
          }
          const result = repoGrep({
            pin,
            pattern: p.pattern,
            ...(p.path !== undefined ? { path: p.path } : {}),
            ...(p.case_sensitive !== undefined ? { caseSensitive: p.case_sensitive } : {}),
            ...(p.max_results !== undefined ? { maxResults: p.max_results } : {}),
          });
          const lines = result.matches.map((match) => `${match.path}:${match.line}: ${match.text}`);
          if (result.truncated) {
            lines.push(`[truncated at ${result.matches.length} matches]`);
          }
          const paths = [...new Set(result.matches.map((match) => match.path))];
          appendRepoResult(log, pin, p.op, result.matches.length, paths);
          const clamped = result.matches.filter((match) => match.text.length >= 500).length;
          return covered([header, ...(lines.length > 0 ? lines : ["no matches"])].join("\n"),
            { complete: !result.truncated && clamped === 0, unit: "matches", kept: result.matches.length, limit: p.max_results ?? 200, ...(result.truncated ? { reason: "max_results" } : {}), ...(clamped > 0 ? { clamped, clamp: 500 } : {}) });
        }
        if (p.op === "glob") {
          if (typeof p.glob !== "string" || p.glob.length === 0) {
            return textResult("repo glob: glob is required", true);
          }
          const files = repoGlob({ pin, pattern: p.glob });
          appendRepoResult(log, pin, p.op, files.length, files);
          return covered([header, ...(files.length > 0 ? files : ["no files matched"])].join("\n"), { complete: true, unit: "entries", kept: files.length });
        }
        if (p.op === "ls") {
          const entries = repoLs({ pin, ...(p.path !== undefined ? { path: p.path } : {}) });
          appendRepoResult(log, pin, p.op, entries.length, entries);
          return covered([header, ...entries].join("\n"), { complete: true, unit: "entries", kept: entries.length });
        }
        if (typeof p.path !== "string" || p.path.length === 0) {
          return textResult("repo read: path is required", true);
        }
        const body = repoShow({ pin, path: p.path });
        appendRepoResult(log, pin, p.op, body.length, [p.path]);
        // The read limit slices silently: a body at the limit is stated partial.
        const atLimit = body.length >= REPO_READ_LIMIT;
        return covered(`${header}\n${body}`, { complete: !atLimit, unit: "bytes", kept: body.length, limit: REPO_READ_LIMIT, ...(atLimit ? { reason: "read_limit" } : {}) });
      } catch (error) {
        return textResult(`repo ${p.op}: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  };
}

/** grep: regex search over workspace files, node_modules and .git excluded. */
function createGrepTool(workspaceRoot: string): AgentTool {
  return {
    name: "grep",
    label: "grep",
    description:
      "Search workspace files with a regex. Returns path:line: text. `path` may be a directory or a single file. node_modules and .git are skipped. A glob without a slash matches the basename at any depth, like rg -g.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for." },
        path: { type: "string", description: "File or directory to search, relative to the workspace. A file is searched alone; the glob filter still applies to it. Default: whole workspace." },
        glob: { type: "string", description: "Optional file filter, e.g. '*.ts' or 'src/**/*.md'." },
        case_sensitive: { type: "boolean", description: "Default true." },
        max_results: { type: "number", description: "Default 200." },
      },
      required: ["pattern"],
      additionalProperties: false,
    } as never,
    async execute(toolCallId, params, signal) {
      void toolCallId;
      const p = params as { pattern?: string; path?: string; glob?: string; case_sensitive?: boolean; max_results?: number };
      if (typeof p.pattern !== "string" || p.pattern.length === 0) {
        return textResult("grep: pattern is required", true);
      }
      try {
        const result = grepWorkspace({
          root: workspaceRoot,
          pattern: p.pattern,
          ...(p.path !== undefined ? { path: p.path } : {}),
          ...(p.glob !== undefined ? { glob: p.glob } : {}),
          ...(p.case_sensitive !== undefined ? { caseSensitive: p.case_sensitive } : {}),
          ...(p.max_results !== undefined ? { maxResults: p.max_results } : {}),
          ...(signal ? { signal } : {}),
        });
        const visible = result.matches;
        const lines = visible.map((match) => `${match.path}:${match.line}: ${match.text}`);
        if (result.truncated) {
          lines.push(`[truncated at ${result.matches.length} matches]`);
        }
        // E1': the model-visible text and its clamp are the base's; the
        // statements below are additive structured fields (Q1', C1'').
        const base = textResult(lines.length > 0 ? lines.join("\n") : "no matches");
        const clamp = (base.details as { producer_truncated?: true }).producer_truncated === true;
        const coverage: ProducerCoverage = {
          complete: !result.truncated && !result.cancelled && (result.clamped ?? 0) === 0 && !clamp,
          unit: "matches", kept: visible.length, limit: p.max_results ?? 200,
          ...(result.cancelled ? { reason: "cancelled" } : result.truncated ? { reason: "max_results" } : clamp ? { reason: "producer" } : {}),
          ...(result.clamped ? { clamped: result.clamped, clamp: 500 } : {}),
        };
        return {
          content: base.content,
          details: {
            ...base.details,
            coverage,
            // The one base correction (design memo §140 E1'): a grep cut at
            // its match cap is recorded `producer_truncated`, not `complete`
            // — the structured statement #223 reads, the text unchanged.
            ...(result.truncated ? { truncation: { truncated: true, truncatedBy: "matches", kept: visible.length } } : {}),
            ...(result.cancelled ? { cancelled: true } : {}),
          },
        };
      } catch (error) {
        return textResult(toolPathErrorText("grep", error), true);
      }
    },
  };
}

/** glob: file-name patterns relative to the workspace root. */
function createGlobTool(workspaceRoot: string): AgentTool {
  return {
    name: "glob",
    label: "glob",
    description: "List files matching a glob, relative to the workspace root. Example: 'src/**/*.ts'. Dotfiles and node_modules are never returned.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern relative to the workspace root." },
      },
      required: ["pattern"],
      additionalProperties: false,
    } as never,
    async execute(toolCallId, params, signal) {
      void toolCallId;
      const pattern = (params as { pattern?: unknown }).pattern;
      if (typeof pattern !== "string" || pattern.length === 0) {
        return textResult("glob: pattern is required", true);
      }
      try {
        const listing = globWorkspaceListing({ root: workspaceRoot, pattern, ...(signal ? { signal } : {}) });
        // E1': the base's text; the omission is stated in the structured field only.
        const base = textResult(listing.entries.length > 0 ? listing.entries.join("\n") : "no files matched");
        const coverage: ProducerCoverage = {
          complete: !listing.truncated && !listing.cancelled, unit: "entries", kept: listing.entries.length, limit: listing.limit,
          ...(listing.cancelled ? { reason: "cancelled" } : listing.truncated ? { reason: "cap" } : {}),
        };
        return { content: base.content, details: { ...base.details, coverage, ...(listing.cancelled ? { cancelled: true } : {}) } };
      } catch (error) {
        return textResult(toolPathErrorText("glob", error), true);
      }
    },
  };
}

/** ls: one directory level, directories first with a trailing slash; a file lists itself. */
function createLsTool(workspaceRoot: string): AgentTool {
  return {
    name: "ls",
    label: "ls",
    description: "List one directory level, or one file when the path names a file. Directories carry a trailing slash and sort before files. Path is relative to the workspace root.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory relative to the workspace root. Default: root." },
      },
      additionalProperties: false,
    } as never,
    async execute(toolCallId, params, signal) {
      void toolCallId;
      const path = (params as { path?: unknown }).path;
      try {
        const listing = lsWorkspaceListing({ root: workspaceRoot, ...(typeof path === "string" ? { path } : {}), ...(signal ? { signal } : {}) });
        // E1': the base's text; the omission is stated in the structured field only.
        const base = textResult(listing.entries.join("\n"));
        const coverage: ProducerCoverage = {
          complete: !listing.truncated && !listing.cancelled, unit: "entries", kept: listing.entries.length, limit: listing.limit,
          ...(listing.cancelled ? { reason: "cancelled" } : listing.truncated ? { reason: "cap" } : {}),
        };
        return { content: base.content, details: { ...base.details, coverage, ...(listing.cancelled ? { cancelled: true } : {}) } };
      } catch (error) {
        return textResult(toolPathErrorText("ls", error), true);
      }
    },
  };
}

/** probe_log: stateless inspection over files or session blobs with Python/Bun
 * snippet, and (#223) the session's authorised source reader: with
 * `start_byte`/`end_byte` on a `blob:<digest>` path it returns exactly those
 * recorded safe bytes of one of this session's tool-result sources. */
export function createProbeLogTool(
  workspaceRoot: string,
  options: { policy?: SandboxPolicy; log?: EventLog } = {},
): AgentTool {
  const tool: AgentTool = {
    name: "probe_log",
    label: "probe_log",
    description:
      "Inspect, filter, or aggregate a large file or session blob without context bloat by streaming its content via stdin through a short stateless Python or Bun script. Returns the script's stdout (max 50 lines / 8KB). Prefer recover=true with a blob path to read the next unread omitted interval automatically (UTF-8 safe, at most 8192 bytes). Recover only omitted evidence relevant to the task. A filtered miss applies only to this recorded source, which may be one remote-file window; it does not search the full remote file. For a known GitHub file use github op=blob find_text rather than sequentially recovering unrelated chunks or guessing offsets. Do not rerun an unchanged producer. To read back bytes an omission marker names, pass its blob path with start_byte and end_byte instead of a script: the exact recorded bytes are returned (at most 8192 per read).",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to a workspace file, or a session blob reference (e.g. 'blob:<digest>').",
        },
        script: {
          type: "string",
          description: "Inline Python (default) or JS/TS snippet that reads from stdin and prints the summary. Required unless start_byte/end_byte are given.",
        },
        runtime: {
          type: "string",
          enum: ["python", "bun"],
          description: "Runtime to execute the snippet. Default: 'python'.",
        },
        max_lines: {
          type: "number",
          description: "Maximum output lines to return (1-200, default 50).",
        },
        recover: { type: "boolean", description: "With a blob path, read the next unread omitted range automatically; Optional offsets restrict recovery to a specific omitted interval; do not combine with script." },
        start_byte: {
          type: "integer",
          description: "With end_byte and a blob path: first UTF-8 byte offset of an exact range read.",
        },
        end_byte: {
          type: "integer",
          description: "With start_byte and a blob path: end (exclusive) UTF-8 byte offset of an exact range read.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    } as never,
    async execute(toolCallId, params, signal) {
      void toolCallId;
      const p = params as {
        path?: string;
        script?: string;
        runtime?: "python" | "bun";
        max_lines?: number;
        recover?: boolean;
        start_byte?: unknown;
        end_byte?: unknown;
      };
      if (typeof p.path !== "string" || p.path.trim().length === 0) {
        return textResult("probe_log: path is required", true);
      }
      const named = probeTargetDigest(p.path);
      const blobPath = named !== undefined;
      const digest = named ?? "";
      const ranged = p.start_byte !== undefined || p.end_byte !== undefined;
      if (p.recover && p.script !== undefined) return textResult("probe_log: recover cannot be combined with script", true);
      if (ranged || p.recover) {
        if (!blobPath || !options.log) {
          return textResult("probe_log: start_byte/end_byte read a recorded session source; the path must be blob:<digest> of this session", true);
        }
        const outcome = p.recover ? readNextOmittedRange({ log: options.log, digest, ...(ranged ? { start: typeof p.start_byte === "number" ? p.start_byte : Number.NaN, end: typeof p.end_byte === "number" ? p.end_byte : Number.NaN } : {}) }) : readSourceRange({
          log: options.log,
          digest,
          start: typeof p.start_byte === "number" ? p.start_byte : Number.NaN,
          end: typeof p.end_byte === "number" ? p.end_byte : Number.NaN,
        });
        if (!outcome) return textResult("probe_log: no unread omitted bytes remain in this source. This does not imply semantic review completeness.");
        return {
          content: [{ type: "text", text: sourceReadText(outcome) }],
          details: {
            error: outcome.status !== "ok",
            // The host verifies this against the recorded row before it
            // treats the result as a read-back (R6'): the claim itself is
            // not authority.
            source_read: outcome.status === "ok"
              ? { status: "ok", seq: outcome.seq, digest: outcome.digest, start: outcome.start, end: outcome.end, read_digest: outcome.readDigest }
              : { status: outcome.status, code: outcome.code, ...(outcome.status === "refused" && outcome.next ? { next: outcome.next } : {}) },
          },
        };
      }
      if (typeof p.script !== "string" || p.script.trim().length === 0) {
        return textResult("probe_log: script is required", true);
      }
      // A digest is not access: only a source this session recorded is
      // readable, whatever else the store holds (#223 R3).
      if (blobPath && (!options.log || !sessionSources(options.log.events).has(digest))) {
        return textResult(`probe_log: blob:${digest.slice(0, 12)}… is not a source recorded in this session; nothing was read`, true);
      }
      try {
        const result = await executeProbeLog({
          workspaceRoot,
          path: p.path,
          script: p.script,
          runtime: p.runtime,
          maxLines: p.max_lines,
          maxBytes: PROBE_LOG_BYTES_DEFAULT,
          policy: options.policy,
          log: options.log,
          signal,
        });
        const bounded = Buffer.byteLength(result.text, "utf8") > PROBE_LOG_BYTES_DEFAULT
          ? sliceUtf8BytesHead(result.text, PROBE_LOG_BYTES_DEFAULT)
          : result.text;
        return textResult(bounded, result.error);
      } catch (error) {
        const msg = toolPathErrorText("probe_log", error);
        return textResult(sliceUtf8BytesHead(msg, PROBE_LOG_BYTES_DEFAULT), true);
      }
    },
  };
  return options.log ? markResultSourceReader(tool, options.log) : tool;
}

function createMaekTool(maek: import("../maek/types.ts").MaekService): AgentTool {
  return {
    name: "maek",
    label: "maek",
    description:
      "Query this session's MAEK memory. op=decisions searches recorded decisions; op=faults searches recorded tool failures. Use it to recall a prior decision or a similar fault instead of re-deriving it from the transcript.",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["decisions", "faults"], description: "Which index to search." },
        query: { type: "string", description: "Text to search for." },
        symbol: { type: "string", description: "Optional symbol filter for op=decisions." },
        limit: { type: "number", description: "Max rows, 1–32." },
      },
      required: ["op", "query"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      const p = params as { op: "decisions" | "faults"; query: string; symbol?: string; limit?: number };
      if (p.op === "faults") {
        const rows = await maek.querySimilarFaults({ errorPattern: p.query, limit: p.limit });
        return textResult(JSON.stringify(rows));
      }
      const rows = await maek.queryDecisions(p.query, { symbolId: p.symbol, limit: p.limit });
      return textResult(JSON.stringify(rows));
    },
  };
}

function bindWorkspaceFileTool(
  tool: AgentHarnessTool<{ env: NodeExecutionEnv }>,
  workspaceRoot: string,
  operation: WorkspaceFileOperation,
): AgentTool {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const env = new AtomicWorkspaceExecutionEnv(workspaceRoot, operation, versionHooksFor(tool.name, toolCallId));
      try {
        return await tool.execute(toolCallId, params, signal, onUpdate, { env });
      } finally {
        env.closeWorkspace();
      }
    },
  };
}

/** The same tool over a plain environment rooted at the workspace; the
 * guards around it are what keep it inside. */
function bindPortableWorkspaceFileTool(
  tool: AgentHarnessTool<{ env: NodeExecutionEnv }>,
  workspaceRoot: string,
  operation: WorkspaceFileOperation,
): AgentTool {
  return {
    name: tool.name,
    label: tool.label,
    // Issue 69 asked that a platform not advertise a guarantee it cannot
    // keep. The name stays — the finalizer budget matches on it — and the
    // description says which binding this is, so the honesty is declared
    // rather than expressed by leaving the model with no writer at all.
    description: `${tool.description} ${PORTABLE_BINDING_NOTE}`,
    parameters: tool.parameters,
    execute: async (toolCallId, params, signal, onUpdate) => {
      // Link-safe paths (S1), not plain ones: no link is followed anywhere
      // on the way, and a write lands on the inode that was checked.
      const env = new LinkSafeWorkspaceExecutionEnv(workspaceRoot, operation, versionHooksFor(tool.name, toolCallId));
      return await tool.execute(toolCallId, params, signal, onUpdate, { env });
    },
  };
}

/** Spelled once so a test can hold the platform to it. */
export const PORTABLE_BINDING_NOTE =
  "(Path-guarded to the workspace on this platform; not fd-anchored — the sandbox is the boundary here.)";

export const plugin: PluginModule = {
  id: "workspace-tools",
  claims: [
    { key: "tools", role: "definition" },
    { key: "tools", role: "provider", modelFacing: true },
    { key: "workspace_versions", role: "definition" },
    { key: "workspace_versions", role: "provider" },
    { key: "tool_contributions", role: "consumer", modelFacing: true },
    { key: "maek", role: "consumer", optional: true },
    { key: "execution_views", role: "consumer", optional: true },
  ],
  register(ctx: HostContext) {
    const contributions = ctx.tryGet<ToolContributionRegistry<AgentTool>>("tool_contributions")?.list() ?? [];
    // D48: a ledger session's scratch directory is created at boot, in its
    // session directory, and handed to the session's own sandbox.
    const scratchRoot = process.env.DOKKABI_WORK_PLANNER === "ledger"
      ? ensureSessionScratch({ logPath: ctx.log.path, workspaceRoot: ctx.workspaceRoot, readOnly: ctx.log.isReadOnly })
      : undefined;
    const tools = createWorkspaceTools(ctx.workspaceRoot, {
      log: ctx.log,
      maek: ctx.tryGet("maek"),
      contributions,
      // Lazy: execution-view registers after this plugin in every manifest.
      views: () => ctx.tryGet<ExecutionReceiptViews>("execution_views"),
      // The receipt line is model-facing only where a tool can cite it.
      announceReceipt: () => contributions.some((tool) => tool.name === "finish" || tool.name === "propose_plan"),
      // Mode-scoped (interfaces-v3.md §1): the plan notice and the
      // --require-plan refusal exist only in a ledger work session.
      ...(process.env.DOKKABI_WORK_PLANNER === "ledger"
        ? { ledgerPlan: { requirePlan: process.env.DOKKABI_LEDGER_REQUIRE_PLAN === "1" } }
        : {}),
      ...(scratchRoot !== undefined ? { scratchRoot } : {}),
    });
    ctx.define("tools", { names: tools.map((tool) => tool.name) });
    ctx.provide("tools", tools);
    const versions = workspaceToolsVersions(tools);
    const capabilities = workspaceToolsVersionCapabilities(tools);
    if (versions && capabilities) {
      ctx.define("workspace_versions", { visibility: "host_only", guarantee: capabilities.guarantee, binding: capabilities.binding });
      // The facade only (M5'): authorize / commit / committed / onCommitted.
      ctx.provide("workspace_versions", versions);
    }
    ctx.effect(() => () => disposeWorkspaceTools(tools));
  },
};
