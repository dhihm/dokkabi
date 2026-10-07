import type { EventLog } from "../host/event-log.ts";
import { swarmRepositoryDigest } from "../swarm/repository-identity.ts";
import type { KnowledgeBriefing, KnowledgeService } from "./types.ts";

/**
 * Knowledge reads are scoped to the repository being worked on (#58).
 *
 * The swarm memory path has always done this: `wikiMemory` resolves
 * `repositoryProjects[repositoryDigest]` and fails closed when the repository
 * has no binding. The goal-context path did not, and neither did the
 * model-facing `wiki_*` read tools. `wiki.brief`/`wiki.search` without a
 * project span the whole vault — and the service's cross-project traversal
 * guard is itself conditioned on a project being present — so working in one
 * repository could put another repository's documents into the recorded turn
 * input, or into a tool result the model asked for directly.
 *
 * Unbound fails CLOSED. Every document is outside an unbound repository's
 * scope, so "zero documents outside scope" means nothing is returned — and
 * the reason lands on the log, because a briefing that silently stops
 * appearing is the kind of thing an operator cannot debug (constitution 6).
 */

export type BriefingScopeStatus = "bound" | "unbound" | "unidentified" | "unavailable";

/** Why an identity could not be derived. Path-free by construction: git's own
 * messages name the workspace, so the cause is classified rather than quoted.
 * `bind` cannot fix `shallow` or `no_repository`, and saying so is the point. */
export type ScopeFailureReason =
  | "shallow_history"
  | "no_commits"
  /** Not a repository, no git, or an untrusted workspace — indistinguishable
   * from outside the sealed spawn, so they are not split into fictions. */
  | "git_unavailable";

/** Why a bound project could not be briefed. Classified, never quoted: the
 * underlying messages carry vault paths. */
export type BriefFailureReason = "vault_unavailable" | "unsafe_content" | "brief_failed";

export interface RepositoryScope {
  readonly status: BriefingScopeStatus;
  readonly repository?: string;
  readonly project?: string;
  readonly reason?: ScopeFailureReason;
  readonly failure?: BriefFailureReason;
}

function classifyBriefFailure(error: unknown): BriefFailureReason {
  const message = error instanceof Error ? error.message : String(error);
  // No `invalid_project`: config.ts drops any binding the service would
  // reject, so a bound project always satisfies IDENTIFIER. Documenting a
  // value that cannot appear is the mistake `no_repository` already was.
  if (/vault is unavailable|ENOENT|EACCES|exceeds/iu.test(message)) return "vault_unavailable";
  if (/secret|credential/iu.test(message)) return "unsafe_content";
  return "brief_failed";
}

function classify(error: unknown): ScopeFailureReason {
  const message = error instanceof Error ? error.message : String(error);
  if (/shallow/iu.test(message)) return "shallow_history";
  if (/root object ids|max-parents|repository roots/iu.test(message)) return "no_commits";
  // A directory that is not a repository does NOT reach git: the sealed host
  // spawn refuses first with "workspace metadata is not trusted", so this and
  // a missing git binary are one observable class. Naming them separately
  // would document a value that can never appear.
  return "git_unavailable";
}

function record(log: EventLog | undefined, scope: RepositoryScope): void {
  // Digest, project alias, and a classified reason only. A vault path or a
  // git error string names the operator's machine.
  log?.append({
    kind: "observe",
    name: "knowledge/briefing_scope",
    payload: {
      status: scope.status,
      ...(scope.repository ? { repository: scope.repository } : {}),
      ...(scope.project ? { project: scope.project } : {}),
      ...(scope.reason ? { reason: scope.reason } : {}),
      ...(scope.failure ? { failure: scope.failure } : {}),
    },
  });
}

/**
 * Resolve the repository scope for a session. Never throws: a workspace that
 * cannot be identified is a refusal with a reason, not an exception thrown
 * through `goal_context_contributions.prepare`, which has no try/catch and
 * would take the whole turn down with it.
 */
export function resolveRepositoryScope(input: {
  /** The profile's repository→project map. A live service is not needed to
   * answer "is this workspace in scope", and `dokkabi knowledge verify` has
   * no session log to build one with. */
  readonly repositoryProjects: Readonly<Record<string, string>> | undefined;
  readonly workspaceRoot: string;
  readonly project?: string;
}): RepositoryScope {
  let repository: string;
  try {
    repository = swarmRepositoryDigest(input.workspaceRoot);
  } catch (error) {
    return { status: "unidentified", reason: classify(error) };
  }
  const bound = input.repositoryProjects?.[repository];
  // An explicitly requested project must BE this repository's project. A
  // caller-supplied override that bypassed the binding would be a hole in the
  // invariant this module exists to hold.
  if (input.project && input.project !== bound) return { status: "unbound", repository };
  if (!bound) return { status: "unbound", repository };
  return { status: "bound", repository, project: bound };
}

export interface RepositoryScopedBriefingInput {
  readonly wiki: KnowledgeService;
  readonly statement: string;
  readonly workspaceRoot: string;
  readonly project?: string;
  readonly log?: EventLog;
  readonly limit?: number;
  readonly maxBytes?: number;
}

export function repositoryScopedBriefing(
  input: RepositoryScopedBriefingInput,
): KnowledgeBriefing | undefined {
  const scope = resolveRepositoryScope({
    repositoryProjects: input.wiki.profile?.repositoryProjects,
    workspaceRoot: input.workspaceRoot,
    ...(input.project ? { project: input.project } : {}),
  });
  if (scope.status !== "bound" || !scope.project) {
    record(input.log, scope);
    return undefined;
  }
  let briefing: KnowledgeBriefing;
  try {
    briefing = input.wiki.brief({
      statement: input.statement,
      project: scope.project,
      limit: input.limit ?? 3,
      maxBytes: input.maxBytes ?? 12_000,
    });
  } catch (error) {
    // This call site sits inside a `prepare` with no guard, so an exception
    // here is a dead `dokkabi work`. Record the miss and let the turn proceed
    // unbriefed — but say WHICH kind of miss: a bad alias, a vault the host
    // cannot open, and a secret detected in the vault are different problems
    // with different remedies, and an unlabelled `unavailable` reads as the
    // first one.
    record(input.log, {
      status: "unavailable",
      repository: scope.repository,
      project: scope.project,
      failure: classifyBriefFailure(error),
    });
    return undefined;
  }
  // Recorded AFTER the briefing exists: a `bound` row written first claims a
  // briefing the operator never received.
  record(input.log, scope);
  return briefing;
}
