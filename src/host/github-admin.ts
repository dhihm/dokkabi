import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { EventLog } from "./event-log.ts";
import {
  captureGithubPublishTree,
  defaultGithubPublishRunner,
  type GithubPublishRunner,
  type GithubPublishRunnerResult,
  type GithubPublishSnapshot,
} from "./github-publish.ts";
import {
  defaultGithubRepoFetchRunner,
  defaultGithubRepoPushInspector,
  defaultGithubRepoPushRunner,
  GithubRepoPushInspectionError,
  type GithubRepoFetchRunner,
  type GithubRepoFetchRunnerResult,
  type GithubRepoPushCandidate,
  type GithubRepoPushInspector,
  type GithubRepoPushRunner,
  type GithubRepoPushRunnerResult,
} from "./github-repo-push.ts";
import type { PermissionController } from "./permissions.ts";
import { approvalRelayEnabled, waitForOperatorDecision } from "./approval-relay.ts";
import { containsSecret } from "./redact.ts";

const MAX_DESCRIPTION_BYTES = 350;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/u;

export interface GithubAdminRunnerInput {
  readonly owner: string;
  readonly repo: string;
  readonly description?: string;
}

export interface GithubAdminRunnerResult {
  readonly status: number;
}

export type GithubAdminRunner = (input: GithubAdminRunnerInput) => Promise<GithubAdminRunnerResult>;

export interface GithubRepoCreateRequest {
  readonly argv: readonly string[];
  readonly stdin: string;
}

export interface GithubAdminOutcome {
  readonly error: boolean;
  readonly text: string;
}

export interface GithubRepoPublishInput {
  readonly owner: string;
  readonly repo: string;
  readonly sourcePath: string;
  readonly message?: string;
}

export interface GithubAdminService {
  control(command: string): string;
  create(input: GithubAdminRunnerInput, signal?: AbortSignal): Promise<GithubAdminOutcome>;
  publish(input: GithubRepoPublishInput, signal?: AbortSignal): Promise<GithubAdminOutcome>;
  /** Pushes only the current workspace's checked-out default branch. */
  push(signal?: AbortSignal): Promise<GithubAdminOutcome>;
  dispose(): void;
  setInteractiveApproval(enabled: boolean): void;
}

type GithubAdminApprovalScope = "once" | "bypass";
type GithubAdminApprovalDecision = GithubAdminApprovalScope | "deny" | "cancelled";

type GithubAdminOperation = "repo_create" | "repo_publish" | "repo_push";

interface GithubAdminApprovalDetails {
  readonly operation: GithubAdminOperation;
  readonly authorizeOwner?: boolean;
  readonly authorizeRepository?: boolean;
  readonly sourcePath?: string;
  readonly fileCount?: number;
  readonly totalBytes?: number;
  readonly treeDigest?: string;
  readonly branch?: string;
  readonly remoteHead?: string;
  readonly localHead?: string;
  readonly commitCount?: number;
  readonly rangeDigest?: string;
  readonly untrackedCount?: number;
}

interface PendingApproval {
  readonly authorizeOwner: boolean;
  readonly authorizeRepository: boolean;
  readonly operation: GithubAdminOperation;
  readonly owner: string;
  readonly repo: string;
  readonly sourcePath?: string;
  readonly fileCount?: number;
  readonly totalBytes?: number;
  readonly treeDigest?: string;
  readonly branch?: string;
  readonly remoteHead?: string;
  readonly localHead?: string;
  readonly commitCount?: number;
  readonly rangeDigest?: string;
  readonly untrackedCount?: number;
  readonly requestId: string;
  readonly resolve: (decision: GithubAdminApprovalDecision) => void;
  removeAbort?: () => void;
  settled: boolean;
}

function approvalDetailPayload(details: GithubAdminApprovalDetails | PendingApproval): Record<string, unknown> {
  return {
    ...(details.authorizeOwner ? { authorize_owner: true } : {}),
    ...(details.authorizeRepository ? { authorize_repository: true } : {}),
    ...(details.sourcePath ? { source_path: details.sourcePath } : {}),
    ...(details.fileCount === undefined ? {} : { file_count: details.fileCount }),
    ...(details.totalBytes === undefined ? {} : { total_bytes: details.totalBytes }),
    ...(details.treeDigest ? { tree_digest: details.treeDigest } : {}),
    ...(details.branch ? { branch: details.branch } : {}),
    ...(details.remoteHead ? { remote_head: details.remoteHead } : {}),
    ...(details.localHead ? { local_head: details.localHead } : {}),
    ...(details.commitCount === undefined ? {} : { commit_count: details.commitCount }),
    ...(details.rangeDigest ? { range_digest: details.rangeDigest } : {}),
    ...(details.untrackedCount === undefined ? {} : { untracked_count: details.untrackedCount }),
  };
}

/**
 * Account-level GitHub authority stays separate from workspace-scoped issue
 * mutation. The owner allowlist narrows the account boundary; a live approval
 * then grants exactly one private repository creation.
 */
export function createGithubAdminService(input: {
  readonly log: EventLog;
  readonly allowedOwners: readonly string[];
  readonly allowedPublishRepositories?: readonly string[];
  readonly allowedPushRepositories?: readonly string[];
  readonly permissions?: PermissionController;
  readonly fetchRunner?: GithubRepoFetchRunner;
  readonly publishRunner?: GithubPublishRunner;
  readonly pushInspector?: GithubRepoPushInspector;
  readonly pushRunner?: GithubRepoPushRunner;
  readonly runner?: GithubAdminRunner;
  readonly saveAllowedOwners?: (owners: readonly string[]) => void;
  readonly saveAllowedPublishRepositories?: (repositories: readonly string[]) => void;
  readonly saveAllowedPushRepositories?: (repositories: readonly string[]) => void;
  readonly workspaceRoot?: string;
}): GithubAdminService {
  const allowedOwners = new Map<string, string>();
  for (const value of input.allowedOwners) {
    const normalized = normalizedOwner(value);
    if (normalized && !allowedOwners.has(normalized)) allowedOwners.set(normalized, value.trim());
  }
  const allowedPublishRepositories = new Map<string, string>();
  for (const value of input.allowedPublishRepositories ?? []) {
    const normalized = normalizedRepository(value);
    if (normalized && !allowedPublishRepositories.has(normalized)) {
      allowedPublishRepositories.set(normalized, value.trim());
    }
  }
  const allowedPushRepositories = new Map<string, string>();
  for (const value of input.allowedPushRepositories ?? []) {
    const normalized = normalizedRepository(value);
    if (normalized && !allowedPushRepositories.has(normalized)) {
      allowedPushRepositories.set(normalized, value.trim());
    }
  }
  const runner = input.runner ?? defaultGithubAdminRunner;
  const fetchRunner = input.fetchRunner ?? defaultGithubRepoFetchRunner;
  const publishRunner = input.publishRunner ?? defaultGithubPublishRunner;
  const pushInspector = input.pushInspector ?? defaultGithubRepoPushInspector;
  const pushRunner = input.pushRunner ?? defaultGithubRepoPushRunner;
  let disposed = false;
  let interactive = false;
  let pending: PendingApproval | undefined;
  let requestSequence = input.log.events.filter((event) => event.name === "github/admin_approval_requested").length;

  const resolvePending = (
    decision: GithubAdminApprovalDecision,
    reason: "operator" | "permission_mode" | "signal" | "interactive_closed" | "disposed",
  ): void => {
    const current = pending;
    if (!current || current.settled) return;
    if (reason === "operator" || (reason === "permission_mode" && decision === "bypass")) {
      input.log.append({
        kind: "effect",
        name: "github/admin_approval_decision",
        payload: {
          request_id: current.requestId,
          operation: current.operation,
          owner: current.owner,
          repo: current.repo,
          visibility: "private",
          decision: decision === "deny" ? "deny" : "approve",
          ...approvalDetailPayload(current),
          ...(decision === "once" || decision === "bypass" ? { scope: decision } : {}),
        },
      });
    }
    current.settled = true;
    current.removeAbort?.();
    input.log.append({
      kind: "observe",
      name: "github/admin_approval_resolved",
      payload: {
        request_id: current.requestId,
        operation: current.operation,
        owner: current.owner,
        repo: current.repo,
        visibility: "private",
        status: decision === "once" || decision === "bypass" ? "approved" : decision,
        reason,
        ...approvalDetailPayload(current),
        ...(decision === "once" || decision === "bypass" ? { scope: decision } : {}),
      },
    });
    pending = undefined;
    current.resolve(decision);
  };

  const requestApproval = async (
    owner: string,
    repo: string,
    requestDigest: string,
    details: GithubAdminApprovalDetails,
    signal?: AbortSignal,
  ): Promise<GithubAdminApprovalDecision | "not_interactive"> => {
    if (input.permissions?.current() === "bypass") return "bypass";
    requestSequence += 1;
    const requestId = `github-admin-${requestSequence}`;
    input.log.append({
      kind: "observe",
      name: "github/admin_approval_requested",
      payload: {
        request_id: requestId,
        operation: details.operation,
        owner,
        repo,
        visibility: "private",
        ...approvalDetailPayload(details),
        request_digest: requestDigest,
      },
    });
    if (!interactive) {
      const resolved = (status: string, reason: string, scope?: "once"): void => {
        input.log.append({
          kind: "observe",
          name: "github/admin_approval_resolved",
          payload: {
            request_id: requestId,
            operation: details.operation,
            owner,
            repo,
            visibility: "private",
            status,
            reason,
            ...(scope ? { scope } : {}),
            ...approvalDetailPayload(details),
          },
        });
      };
      if (!approvalRelayEnabled()) {
        resolved("unavailable", "not_interactive");
        return "not_interactive";
      }
      // No operator here: park the request for `dokkabi approve` (approval-relay.ts).
      // Administration is per request, so a session answer counts as once.
      const outcome = await waitForOperatorDecision({
        logPath: input.log.path,
        kind: "github-admin",
        requestId,
        target: `${owner}/${repo}`,
        summary: `${details.operation} ${owner}/${repo}`,
        ...(signal ? { signal } : {}),
      });
      if (outcome === "once" || outcome === "session") {
        resolved("approved", "operator", "once");
        return "once";
      }
      if (outcome === "deny") {
        resolved("deny", "operator");
        return "deny";
      }
      if (outcome === "cancelled") {
        resolved("cancelled", "signal");
        return "cancelled";
      }
      resolved("unavailable", "operator_timeout");
      return "not_interactive";
    }
    if (pending) {
      input.log.append({
        kind: "observe",
        name: "github/admin_approval_resolved",
        payload: {
          request_id: requestId,
          operation: details.operation,
          owner,
          repo,
          visibility: "private",
          status: "cancelled",
          reason: "request_already_waiting",
          ...approvalDetailPayload(details),
        },
      });
      return "cancelled";
    }
    return new Promise((resolve) => {
      const next: PendingApproval = {
        authorizeOwner: details.authorizeOwner === true,
        authorizeRepository: details.authorizeRepository === true,
        operation: details.operation,
        owner,
        repo,
        requestId,
        resolve,
        settled: false,
        ...(details.sourcePath ? { sourcePath: details.sourcePath } : {}),
        ...(details.fileCount === undefined ? {} : { fileCount: details.fileCount }),
        ...(details.totalBytes === undefined ? {} : { totalBytes: details.totalBytes }),
        ...(details.treeDigest ? { treeDigest: details.treeDigest } : {}),
        ...(details.branch ? { branch: details.branch } : {}),
        ...(details.remoteHead ? { remoteHead: details.remoteHead } : {}),
        ...(details.localHead ? { localHead: details.localHead } : {}),
        ...(details.commitCount === undefined ? {} : { commitCount: details.commitCount }),
        ...(details.rangeDigest ? { rangeDigest: details.rangeDigest } : {}),
        ...(details.untrackedCount === undefined ? {} : { untrackedCount: details.untrackedCount }),
      };
      if (signal) {
        const onAbort = () => resolvePending("cancelled", "signal");
        signal.addEventListener("abort", onAbort, { once: true });
        next.removeAbort = () => signal.removeEventListener("abort", onAbort);
      }
      pending = next;
      if (signal?.aborted) resolvePending("cancelled", "signal");
    });
  };

  const ownerList = (): string[] => [...allowedOwners.values()]
    .sort((left, right) => left.localeCompare(right, "en", { sensitivity: "base" }));

  const changeOwner = (
    action: "allow" | "remove",
    owner: string,
    source: "approval" | "tui",
  ): boolean => {
    const normalized = normalizedOwner(owner);
    if (!normalized || containsSecret(owner)) throw new Error("invalid GitHub owner");
    if (!input.saveAllowedOwners) throw new Error("GitHub owner policy persistence is unavailable");
    const next = action === "allow"
      ? [...ownerList(), ...(allowedOwners.has(normalized) ? [] : [owner])]
      : ownerList().filter((candidate) => normalizedOwner(candidate) !== normalized);
    input.log.append({
      kind: "effect",
      name: "github/admin_owner_change",
      payload: { action, owner, source },
    });
    try {
      input.saveAllowedOwners(next);
    } catch {
      input.log.append({
        kind: "observe",
        name: "github/admin_owner_change_result",
        payload: { action, owner, source, status: "failed" },
      });
      return false;
    }
    if (action === "allow") allowedOwners.set(normalized, owner);
    else allowedOwners.delete(normalized);
    input.log.append({
      kind: "observe",
      name: "github/admin_owner_change_result",
      payload: { action, owner, source, status: "completed" },
    });
    return true;
  };

  const publishRepositoryList = (): string[] => [...allowedPublishRepositories.values()]
    .sort((left, right) => left.localeCompare(right, "en", { sensitivity: "base" }));

  const changePublishRepository = (
    action: "allow" | "remove",
    repository: string,
    source: "approval" | "tui",
  ): boolean => {
    const normalized = normalizedRepository(repository);
    if (!normalized || containsSecret(repository)) throw new Error("invalid GitHub repository");
    if (!input.saveAllowedPublishRepositories) {
      throw new Error("GitHub publish repository policy persistence is unavailable");
    }
    const next = action === "allow"
      ? [...publishRepositoryList(), ...(allowedPublishRepositories.has(normalized) ? [] : [repository])]
      : publishRepositoryList().filter((candidate) => normalizedRepository(candidate) !== normalized);
    input.log.append({
      kind: "effect",
      name: "github/admin_repository_change",
      payload: { action, repo: repository, source, capability: "publish" },
    });
    try {
      input.saveAllowedPublishRepositories(next);
    } catch {
      input.log.append({
        kind: "observe",
        name: "github/admin_repository_change_result",
        payload: { action, repo: repository, source, capability: "publish", status: "failed" },
      });
      return false;
    }
    if (action === "allow") allowedPublishRepositories.set(normalized, repository);
    else allowedPublishRepositories.delete(normalized);
    input.log.append({
      kind: "observe",
      name: "github/admin_repository_change_result",
      payload: { action, repo: repository, source, capability: "publish", status: "completed" },
    });
    return true;
  };

  const pushRepositoryList = (): string[] => [...allowedPushRepositories.values()]
    .sort((left, right) => left.localeCompare(right, "en", { sensitivity: "base" }));

  const changePushRepository = (
    action: "allow" | "remove",
    repository: string,
    source: "approval" | "tui",
  ): boolean => {
    const normalized = normalizedRepository(repository);
    if (!normalized || containsSecret(repository)) throw new Error("invalid GitHub repository");
    if (!input.saveAllowedPushRepositories) {
      throw new Error("GitHub push repository policy persistence is unavailable");
    }
    const next = action === "allow"
      ? [...pushRepositoryList(), ...(allowedPushRepositories.has(normalized) ? [] : [repository])]
      : pushRepositoryList().filter((candidate) => normalizedRepository(candidate) !== normalized);
    input.log.append({
      kind: "effect",
      name: "github/admin_repository_change",
      payload: { action, repo: repository, source, capability: "push" },
    });
    try {
      input.saveAllowedPushRepositories(next);
    } catch {
      input.log.append({
        kind: "observe",
        name: "github/admin_repository_change_result",
        payload: { action, repo: repository, source, capability: "push", status: "failed" },
      });
      return false;
    }
    if (action === "allow") allowedPushRepositories.set(normalized, repository);
    else allowedPushRepositories.delete(normalized);
    input.log.append({
      kind: "observe",
      name: "github/admin_repository_change_result",
      payload: { action, repo: repository, source, capability: "push", status: "completed" },
    });
    return true;
  };

  const removePermissionListener = input.permissions?.onChange((mode) => {
    if (mode !== "bypass") return;
    resolvePending(
      pending?.authorizeOwner || pending?.authorizeRepository ? "cancelled" : "bypass",
      "permission_mode",
    );
  });

  return {
    control(command) {
      const text = command.trim().replace(/\s+/gu, " ");
      const normalized = text.toLowerCase();
      if (normalized === "" || normalized === "status") {
        const approval = input.permissions?.current() === "bypass"
          ? "bypass"
          : pending
            ? "pending"
            : "idle";
        const owners = ownerList().join(",") || "none";
        const publish = publishRepositoryList().join(",") || "none";
        const push = pushRepositoryList().join(",") || "none";
        return pending
          ? `github-admin approval=${approval} operation=${pending.operation} repo=${pending.repo} visibility=private owners=${owners} publish=${publish} push=${push} sandbox=enforced — /github-admin approve once | /github-admin deny`
          : `github-admin approval=${approval} visibility=private owners=${owners} publish=${publish} push=${push} sandbox=enforced — /github-admin allow OWNER | remove OWNER | allow-repo OWNER/REPO | remove-repo OWNER/REPO | allow-push-repo OWNER/REPO | remove-push-repo OWNER/REPO`;
      }
      if (normalized === "approve once") {
        if (!pending) throw new Error("no GitHub administration approval is waiting");
        resolvePending("once", "operator");
        return "GitHub administration approved once; the pending request is continuing";
      }
      if (normalized === "deny") {
        if (!pending) throw new Error("no GitHub administration approval is waiting");
        resolvePending("deny", "operator");
        return "GitHub administration denied; no mutation was started";
      }
      const ownerCommand = /^(allow|remove) (\S+)$/iu.exec(text);
      if (ownerCommand) {
        const action = ownerCommand[1]!.toLowerCase() as "allow" | "remove";
        const owner = ownerCommand[2]!;
        const key = normalizedOwner(owner);
        if (!key || containsSecret(owner)) throw new Error("invalid GitHub owner");
        if (action === "allow" && allowedOwners.has(key)) {
          return `GitHub owner ${allowedOwners.get(key)} is already authorized for private repository creation`;
        }
        if (action === "remove" && !allowedOwners.has(key)) {
          return `GitHub owner ${owner} is not authorized for private repository creation`;
        }
        if (!changeOwner(action, owner, "tui")) {
          throw new Error(`GitHub owner ${owner} policy change failed; no live authority changed`);
        }
        return action === "allow"
          ? `GitHub owner ${owner} authorized for private repository creation`
          : `GitHub owner ${owner} removed from private repository creation authority`;
      }
      const repositoryCommand = /^(allow-repo|remove-repo) (\S+)$/iu.exec(text);
      if (repositoryCommand) {
        const action = repositoryCommand[1]!.toLowerCase() === "allow-repo" ? "allow" : "remove";
        const repository = repositoryCommand[2]!;
        const key = normalizedRepository(repository);
        if (!key || containsSecret(repository)) throw new Error("invalid GitHub repository");
        if (action === "allow" && allowedPublishRepositories.has(key)) {
          return `GitHub repository ${allowedPublishRepositories.get(key)} is already authorized for workspace publishing`;
        }
        if (action === "remove" && !allowedPublishRepositories.has(key)) {
          return `GitHub repository ${repository} is not authorized for workspace publishing`;
        }
        if (!changePublishRepository(action, repository, "tui")) {
          throw new Error(`GitHub repository ${repository} policy change failed; no live authority changed`);
        }
        return action === "allow"
          ? `GitHub repository ${repository} authorized for workspace publishing`
          : `GitHub repository ${repository} removed from workspace publishing authority`;
      }
      const pushRepositoryCommand = /^(allow-push-repo|remove-push-repo) (\S+)$/iu.exec(text);
      if (pushRepositoryCommand) {
        const action = pushRepositoryCommand[1]!.toLowerCase() === "allow-push-repo" ? "allow" : "remove";
        const repository = pushRepositoryCommand[2]!;
        const key = normalizedRepository(repository);
        if (!key || containsSecret(repository)) throw new Error("invalid GitHub repository");
        if (action === "allow" && allowedPushRepositories.has(key)) {
          return `GitHub repository ${allowedPushRepositories.get(key)} is already authorized for current-branch pushes`;
        }
        if (action === "remove" && !allowedPushRepositories.has(key)) {
          return `GitHub repository ${repository} is not authorized for current-branch pushes`;
        }
        if (!changePushRepository(action, repository, "tui")) {
          throw new Error(`GitHub repository ${repository} push policy change failed; no live authority changed`);
        }
        return action === "allow"
          ? `GitHub repository ${repository} authorized for current-branch pushes`
          : `GitHub repository ${repository} removed from current-branch push authority`;
      }
      throw new Error("usage: /github-admin [status|approve once|deny|allow OWNER|remove OWNER|allow-repo OWNER/REPO|remove-repo OWNER/REPO|allow-push-repo OWNER/REPO|remove-push-repo OWNER/REPO]");
    },
    async create(request, signal) {
      if (disposed) return refused("service_disposed");
      const parsed = parseRequest(request);
      if (!parsed.ok) return refused(parsed.reason);
      const target = `${parsed.value.owner}/${parsed.value.repo}`;
      const ownerKey = normalizedOwner(parsed.value.owner);
      const authorizeOwner = !allowedOwners.has(ownerKey);
      if (authorizeOwner && !input.saveAllowedOwners) return refused("owner_not_authorized");
      if (authorizeOwner && (input.permissions?.current() === "bypass" || !interactive)) {
        return ownerSetupRequired(parsed.value.owner);
      }
      const prior = input.log.events.some((event) =>
        event.name === "github/repo_create_result"
        && typeof event.payload.repo === "string"
        && event.payload.repo.toLowerCase() === target.toLowerCase()
        && event.payload.visibility === "private"
        && event.payload.status === "completed"
      );
      if (prior) {
        return { error: false, text: `Private GitHub repository ${target} creation already completed.` };
      }

      const descriptionDigest = parsed.value.description === undefined
        ? undefined
        : createHash("sha256").update(parsed.value.description).digest("hex");
      const requestDigest = createHash("sha256")
        .update(target.toLowerCase())
        .update("\0private\0")
        .update(descriptionDigest ?? "")
        .digest("hex");
      const approval = await requestApproval(
        parsed.value.owner,
        target,
        requestDigest,
        { operation: "repo_create", authorizeOwner },
        signal,
      );
      if (approval === "not_interactive") {
        return {
          error: true,
          text: "GitHub administration approval is unavailable: use Dokkabi chat or restart explicitly with --permission-mode bypass.",
        };
      }
      if (approval === "deny") return refused("operator_denied");
      if (approval === "cancelled") return refused("approval_cancelled");
      if (authorizeOwner && !changeOwner("allow", parsed.value.owner, "approval")) {
        return {
          error: true,
          text: `GitHub owner ${parsed.value.owner} authorization could not be saved; no repository mutation was started.`,
        };
      }

      input.log.append({
        kind: "effect",
        name: "github/repo_create",
        payload: {
          repo: target,
          visibility: "private",
          approval_scope: approval,
          request_digest: requestDigest,
          ...(descriptionDigest
            ? {
                description_digest: descriptionDigest,
                description_bytes: Buffer.byteLength(parsed.value.description ?? ""),
              }
            : {}),
        },
      });

      let status = -1;
      try {
        status = (await runner(parsed.value)).status;
      } catch {
        status = -1;
      }
      const completed = status === 0;
      input.log.append({
        kind: "observe",
        name: "github/repo_create_result",
        payload: {
          repo: target,
          visibility: "private",
          status: completed ? "completed" : "failed",
          request_digest: requestDigest,
          ...(!completed && status >= 0 ? { exit_code: status } : {}),
        },
      });
      return completed
        ? { error: false, text: `Private GitHub repository ${target} created.` }
        : {
            error: true,
            text: `Private GitHub repository ${target} creation failed. Inspect gh authentication and owner permission locally.`,
          };
    },
    async publish(request, signal) {
      if (disposed) return refused("service_disposed");
      const parsed = parseRequest({ owner: request.owner, repo: request.repo });
      if (!parsed.ok) return refused(parsed.reason);
      if (!input.workspaceRoot) return refused("workspace_root_unavailable");
      let snapshot: GithubPublishSnapshot;
      try {
        snapshot = captureGithubPublishTree({
          workspaceRoot: input.workspaceRoot,
          sourcePath: request.sourcePath,
        });
      } catch (error) {
        return {
          error: true,
          text: error instanceof Error ? error.message : "GitHub publish source capture failed.",
        };
      }
      const target = `${parsed.value.owner}/${parsed.value.repo}`;
      const targetKey = normalizedRepository(target);
      const authorizeRepository = !allowedPublishRepositories.has(targetKey);
      if (authorizeRepository && !input.saveAllowedPublishRepositories) {
        return refused("publish_repository_not_authorized");
      }
      if (authorizeRepository && (input.permissions?.current() === "bypass" || !interactive)) {
        return repositorySetupRequired(target);
      }
      const message = request.message?.trim() || `Publish ${snapshot.sourcePath}`;
      if (Buffer.byteLength(message) > 200 || containsSecret(message)) {
        return refused("publish_message_invalid_or_secret_shaped");
      }
      const messageDigest = createHash("sha256").update(message).digest("hex");
      const requestDigest = createHash("sha256")
        .update(targetKey)
        .update("\0repo_publish\0")
        .update(snapshot.treeDigest)
        .update("\0")
        .update(messageDigest)
        .digest("hex");
      const prior = input.log.events.some((event) =>
        event.name === "github/repo_publish_result"
        && typeof event.payload.repo === "string"
        && event.payload.repo.toLowerCase() === targetKey
        && event.payload.visibility === "private"
        && event.payload.tree_digest === snapshot.treeDigest
        && event.payload.status === "completed"
      );
      if (prior) {
        return { error: false, text: `Workspace snapshot is already published to private GitHub repository ${target}.` };
      }

      const approval = await requestApproval(
        parsed.value.owner,
        target,
        requestDigest,
        {
          operation: "repo_publish",
          authorizeRepository,
          sourcePath: snapshot.sourcePath,
          fileCount: snapshot.fileCount,
          totalBytes: snapshot.totalBytes,
          treeDigest: snapshot.treeDigest,
        },
        signal,
      );
      if (approval === "not_interactive") {
        return {
          error: true,
          text: "GitHub publish approval is unavailable: use Dokkabi chat or restart explicitly with --permission-mode bypass for full session authority.",
        };
      }
      if (approval === "deny") return refused("operator_denied");
      if (approval === "cancelled") return refused("approval_cancelled");
      if (authorizeRepository && !changePublishRepository("allow", target, "approval")) {
        return {
          error: true,
          text: `GitHub repository ${target} publishing authorization could not be saved; no GitHub mutation was started.`,
        };
      }

      input.log.append({
        kind: "effect",
        name: "github/repo_publish",
        payload: {
          repo: target,
          visibility: "private",
          mode: "additive",
          source_path: snapshot.sourcePath,
          file_count: snapshot.fileCount,
          total_bytes: snapshot.totalBytes,
          tree_digest: snapshot.treeDigest,
          message_digest: messageDigest,
          approval_scope: approval,
          request_digest: requestDigest,
        },
      });
      let result: GithubPublishRunnerResult;
      try {
        result = await publishRunner({ target, snapshot, message });
      } catch {
        result = { status: -1 };
      }
      const completed = result.status === 0 && typeof result.commitSha === "string" && result.commitSha.length > 0;
      input.log.append({
        kind: "observe",
        name: "github/repo_publish_result",
        payload: {
          repo: target,
          visibility: "private",
          mode: "additive",
          status: completed ? "completed" : "failed",
          tree_digest: snapshot.treeDigest,
          request_digest: requestDigest,
          ...(completed ? { commit_sha: result.commitSha, branch: result.branch ?? "unknown" } : {}),
          ...(!completed && result.status >= 0 ? { exit_code: result.status } : {}),
        },
      });
      if (!completed) {
        return {
          error: true,
          text: `Publishing workspace files to private GitHub repository ${target} failed. Inspect gh authentication, private visibility, and repository permission locally.`,
        };
      }
      return {
        error: false,
        text: `Published ${snapshot.fileCount} files to private GitHub repository ${target} on ${result.branch ?? "default branch"} at ${result.commitSha!.slice(0, 12)}.`,
      };
    },
    async push(signal) {
      if (disposed) return refused("service_disposed");
      if (!input.workspaceRoot) return refused("workspace_root_unavailable");
      const fullAuthority = input.permissions?.current() === "bypass";
      const inspectPush = () => pushInspector(input.workspaceRoot!, { fullAuthority });
      let candidate: GithubRepoPushCandidate;
      try {
        candidate = await inspectPush();
      } catch (error) {
        const stale = safePushInspectionError(error);
        if (!stale) return pushInspectionFailure(error);
        input.log.append({
          kind: "effect",
          name: "github/repo_fetch",
          payload: {
            repo: stale.repository,
            visibility: stale.visibility ?? "private",
            branch: stale.branch,
            remote_head: stale.remoteHead,
            mode: "tracking_ref_only",
          },
        });
        let fetched: GithubRepoFetchRunnerResult;
        try {
          fetched = await fetchRunner({
            workspaceRoot: input.workspaceRoot,
            repository: stale.repository,
            branch: stale.branch,
            remoteHead: stale.remoteHead,
          });
        } catch {
          fetched = { status: -1 };
        }
        const fetchCompleted = fetched.status === 0 && fetched.remoteHead === stale.remoteHead;
        input.log.append({
          kind: "observe",
          name: "github/repo_fetch_result",
          payload: {
            repo: stale.repository,
            visibility: stale.visibility ?? "private",
            branch: stale.branch,
            remote_head: stale.remoteHead,
            mode: "tracking_ref_only",
            status: fetchCompleted ? "completed" : "failed",
          },
        });
        if (!fetchCompleted) {
          return {
            error: true,
            text: `GitHub current-branch push paused: host_remote_fetch_failed. Dokkabi could not synchronize the exact private ${stale.repository} ${stale.branch} tracking ref; no approval or push was started. Retry repo_push after host GitHub access is available. Do not ask the operator to run git push.`,
          };
        }
        try {
          candidate = await inspectPush();
        } catch (nextError) {
          return pushInspectionFailure(nextError, true);
        }
      }
      if (!validPushCandidateMetadata(candidate, fullAuthority)) return refused("push_candidate_invalid");
      if (candidate.commitCount === 0) {
        return candidate.remoteHead === candidate.localHead
          ? {
              error: false,
              text: `${candidate.visibility === "public" ? "Public" : "Private"} GitHub repository ${candidate.repository} is already up to date on ${candidate.branch} at ${candidate.localHead}. Local origin tracking refs are not refreshed by this check.`,
            }
          : refused("empty_push_range_does_not_match_remote");
      }

      const targetKey = normalizedRepository(candidate.repository);
      const authorizeRepository = !fullAuthority && !allowedPushRepositories.has(targetKey);
      if (authorizeRepository && !input.saveAllowedPushRepositories) {
        return refused("push_repository_not_authorized");
      }
      if (authorizeRepository && (input.permissions?.current() === "bypass" || !interactive)) {
        return pushRepositorySetupRequired(candidate.repository);
      }
      if (fullAuthority && input.permissions?.current() !== "bypass") return refused("permission_mode_changed");
      const owner = candidate.repository.slice(0, candidate.repository.indexOf("/"));
      const approval = await requestApproval(
        owner,
        candidate.repository,
        candidate.requestDigest,
        {
          operation: "repo_push",
          authorizeRepository,
          branch: candidate.branch,
          remoteHead: candidate.remoteHead,
          localHead: candidate.localHead,
          commitCount: candidate.commitCount,
          rangeDigest: candidate.rangeDigest,
          untrackedCount: candidate.untrackedCount,
        },
        signal,
      );
      if (approval === "not_interactive") {
        return {
          error: true,
          text: "GitHub current-branch push approval is unavailable: use Dokkabi chat or restart explicitly with --permission-mode bypass for full session authority.",
        };
      }
      if (approval === "deny") return refused("operator_denied");
      if (approval === "cancelled") return refused("approval_cancelled");

      let revalidated: GithubRepoPushCandidate;
      try {
        revalidated = await inspectPush();
      } catch (error) {
        const reason = safePushInspectionError(error)?.code ?? "candidate_changed";
        return {
          error: true,
          text: `GitHub current-branch push state changed after approval (${reason}); no push was started. Call repo_push again so Dokkabi can synchronize and present a new exact candidate. Do not ask the operator to run git push.`,
        };
      }
      if (!validPushCandidateMetadata(revalidated, fullAuthority) || !samePushCandidate(candidate, revalidated)) {
        return {
          error: true,
          text: "GitHub current-branch push state changed after approval; no push was started.",
        };
      }
      if (authorizeRepository && !changePushRepository("allow", candidate.repository, "approval")) {
        return {
          error: true,
          text: `GitHub repository ${candidate.repository} push authorization could not be saved; no GitHub mutation was started.`,
        };
      }

      if (fullAuthority && input.permissions?.current() !== "bypass") return refused("permission_mode_changed");
      input.log.append({
        kind: "effect",
        name: "github/repo_push",
        payload: {
          repo: candidate.repository,
          visibility: candidate.visibility ?? "private",
          mode: "fast_forward_only",
          branch: candidate.branch,
          remote_head: candidate.remoteHead,
          local_head: candidate.localHead,
          commit_count: candidate.commitCount,
          range_digest: candidate.rangeDigest,
          untracked_count: candidate.untrackedCount,
          approval_scope: approval,
          request_digest: candidate.requestDigest,
        },
      });
      let result: GithubRepoPushRunnerResult;
      try {
        result = await pushRunner({ workspaceRoot: input.workspaceRoot, candidate });
      } catch {
        result = { status: -1 };
      }
      const completed = result.status === 0 && result.remoteHead === candidate.localHead;
      input.log.append({
        kind: "observe",
        name: "github/repo_push_result",
        payload: {
          repo: candidate.repository,
          visibility: candidate.visibility ?? "private",
          mode: "fast_forward_only",
          branch: candidate.branch,
          remote_head_before: candidate.remoteHead,
          local_head: candidate.localHead,
          commit_count: candidate.commitCount,
          range_digest: candidate.rangeDigest,
          request_digest: candidate.requestDigest,
          status: completed ? "completed" : "failed",
          ...(completed ? { remote_head_after: result.remoteHead } : {}),
        },
      });
      return completed
        ? {
            error: false,
            text: `Pushed ${candidate.commitCount} existing commits to ${candidate.visibility ?? "private"} GitHub repository ${candidate.repository} on ${candidate.branch} at ${candidate.localHead}. Remote ${candidate.branch} is verified at ${candidate.localHead}; local origin tracking refs are not refreshed by this push.`,
          }
        : {
            error: true,
            text: `Pushing existing commits to ${candidate.visibility ?? "private"} GitHub repository ${candidate.repository} failed. Host GitHub authentication, the remote ref, or repository permission no longer matched the approved range.`,
          };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      interactive = false;
      resolvePending("cancelled", "disposed");
      removePermissionListener?.();
    },
    setInteractiveApproval(enabled) {
      interactive = enabled && !disposed;
      if (!interactive) resolvePending("cancelled", "interactive_closed");
    },
  };
}

/** Build the only mutation request emitted by the default runner. */
export function githubRepoCreateRequest(
  input: GithubAdminRunnerInput,
  viewer: string,
): GithubRepoCreateRequest {
  const personal = normalizedOwner(input.owner) === normalizedOwner(viewer);
  const endpoint = personal ? "user/repos" : `orgs/${input.owner}/repos`;
  return {
    argv: ["gh", "api", "--method", "POST", endpoint, "--input", "-", "--silent"],
    stdin: JSON.stringify({
      name: input.repo,
      private: true,
      ...(input.description === undefined ? {} : { description: input.description }),
    }),
  };
}

const defaultGithubAdminRunner: GithubAdminRunner = async (input) => {
  // gh starts outside every workspace (S2, D57e): nothing it asks git about
  // a current repository can read a tree's configuration.
  const viewer = spawnSync("gh", ["api", "user", "--jq", ".login"], {
    cwd: "/",
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (viewer.status !== 0 || !viewer.stdout?.trim()) return { status: viewer.status ?? -1 };
  const request = githubRepoCreateRequest(input, viewer.stdout.trim());
  const result = spawnSync(request.argv[0]!, [...request.argv.slice(1)], {
    cwd: "/",
    encoding: "utf8",
    env: process.env,
    input: request.stdin,
    maxBuffer: 1_000_000,
  });
  return { status: result.status ?? -1 };
};

function parseRequest(
  input: GithubAdminRunnerInput,
): { ok: true; value: GithubAdminRunnerInput } | { ok: false; reason: string } {
  const owner = input.owner.trim();
  const repo = input.repo.trim();
  if (!OWNER_PATTERN.test(owner) || !REPOSITORY_PATTERN.test(repo) || repo === "." || repo === "..") {
    return { ok: false, reason: "invalid_owner_or_repository" };
  }
  if (containsSecret(owner) || containsSecret(repo)) {
    return { ok: false, reason: "owner_or_repository_contains_secret_shaped_material" };
  }
  if (input.description !== undefined) {
    if (Buffer.byteLength(input.description) > MAX_DESCRIPTION_BYTES) {
      return { ok: false, reason: "description_too_large" };
    }
    if (containsSecret(input.description)) return { ok: false, reason: "description_contains_secret_shaped_material" };
  }
  return {
    ok: true,
    value: {
      owner,
      repo,
      ...(input.description === undefined ? {} : { description: input.description }),
    },
  };
}

function normalizedOwner(value: string): string {
  const owner = value.trim();
  return OWNER_PATTERN.test(owner) ? owner.toLowerCase() : "";
}

function normalizedRepository(value: string): string {
  const separator = value.indexOf("/");
  if (separator < 1 || separator === value.length - 1) return "";
  const owner = value.slice(0, separator).trim();
  const repo = value.slice(separator + 1).trim();
  if (!OWNER_PATTERN.test(owner) || !REPOSITORY_PATTERN.test(repo) || repo === "." || repo === "..") return "";
  return `${owner}/${repo}`.toLowerCase();
}

function refused(reason: string): GithubAdminOutcome {
  return { error: true, text: `GitHub administration refused: ${reason}.` };
}

function ownerSetupRequired(owner: string): GithubAdminOutcome {
  return {
    error: true,
    text: `GitHub owner ${owner} is not authorized. Use Dokkabi chat in ask mode to approve the first valid request, or run /github-admin allow ${owner}.`,
  };
}

function repositorySetupRequired(repository: string): GithubAdminOutcome {
  return {
    error: true,
    text: `GitHub repository ${repository} is not authorized for workspace publishing. Use Dokkabi chat in ask mode to approve the first valid publish request, or run /github-admin allow-repo ${repository}.`,
  };
}

function pushRepositorySetupRequired(repository: string): GithubAdminOutcome {
  return {
    error: true,
    text: `GitHub repository ${repository} is not authorized for current-branch pushes. Use Dokkabi chat in ask mode to approve the first valid push request, or run /github-admin allow-push-repo ${repository}.`,
  };
}

function validPushCandidateMetadata(candidate: GithubRepoPushCandidate, fullAuthority = false): boolean {
  return normalizedRepository(candidate.repository) !== ""
    && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(candidate.branch)
    && !candidate.branch.includes("..")
    && !candidate.branch.includes("//")
    && !candidate.branch.includes("@{")
    && /^[a-f0-9]{40}$/u.test(candidate.remoteHead)
    && /^[a-f0-9]{40}$/u.test(candidate.localHead)
    && Number.isSafeInteger(candidate.commitCount)
    && candidate.commitCount >= 0
    && (fullAuthority || candidate.commitCount <= 256)
    && /^[a-f0-9]{64}$/u.test(candidate.rangeDigest)
    && Number.isSafeInteger(candidate.untrackedCount)
    && candidate.untrackedCount >= 0
    && candidate.untrackedCount <= 1_000_000
    && /^[a-f0-9]{64}$/u.test(candidate.requestDigest);
}

function samePushCandidate(left: GithubRepoPushCandidate, right: GithubRepoPushCandidate): boolean {
  return left.repository.toLowerCase() === right.repository.toLowerCase()
    && left.branch === right.branch
    && left.remoteHead === right.remoteHead
    && left.localHead === right.localHead
    && left.commitCount === right.commitCount
    && left.rangeDigest === right.rangeDigest
    && left.untrackedCount === right.untrackedCount
    && left.requestDigest === right.requestDigest
    && left.visibility === right.visibility
    && left.newBranch === right.newBranch
    && left.fullAuthority === right.fullAuthority;
}

function safePushInspectionError(error: unknown): GithubRepoPushInspectionError | undefined {
  if (!(error instanceof GithubRepoPushInspectionError)) return undefined;
  return normalizedRepository(error.repository) !== ""
    && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(error.branch)
    && !error.branch.includes("..")
    && !error.branch.includes("//")
    && !error.branch.includes("@{")
    && /^[a-f0-9]{40}$/u.test(error.remoteHead)
    && /^[a-f0-9]{40}$/u.test(error.localHead)
    ? error
    : undefined;
}

function pushInspectionFailure(error: unknown, fetched = false): GithubAdminOutcome {
  const inspected = safePushInspectionError(error);
  if (inspected?.code === "local_not_descendant" && fetched) {
    return {
      error: true,
      text: `GitHub current-branch push paused: remote_advanced_local_sync_required. Dokkabi synchronized ${inspected.repository} ${inspected.branch} to origin/${inspected.branch} at ${inspected.remoteHead.slice(0, 12)} without changing the current branch. Rebase the current branch onto origin/${inspected.branch} with workspace Git, resolve any conflicts, then call github_admin repo_push again. Do not ask the operator to run git push.`,
    };
  }
  if (inspected?.code === "remote_head_missing" && fetched) {
    return {
      error: true,
      text: "GitHub current-branch push paused: remote_changed_during_fetch. The tracking ref was synchronized, but GitHub advanced again before reinspection. Call repo_push again for the new exact state. Do not ask the operator to run git push.",
    };
  }
  return {
    error: true,
    text: "GitHub current-branch push inspection failed or was refused. The current workspace must have one clean tracked tree, private github.com origin, checked-out default branch, and descendant-only committed range. No approval or push was started; do not ask the operator to run git push.",
  };
}
