export type KnowledgeDialect = "commonmark" | "obsidian";
export type KnowledgeLayout = "generic" | "research-lab";
export type KnowledgeScope = "task" | "project" | "shared";
export type KnowledgeKind =
  | "task"
  | "worklog"
  | "research"
  | "claim"
  | "decision"
  | "experiment"
  | "procedure"
  | "incident"
  | "artifact"
  | "source"
  | "concept"
  | "error";
export type KnowledgeStatus = "draft" | "active" | "verified" | "deprecated";
export type KnowledgeVisibility = "private" | "team" | "public";
export type KnowledgeTruthState = "unverified" | "current" | "contested" | "superseded" | "deprecated";
/** Aging tier, orthogonal to status/truth: `core` never ages, `archive` is
 * the forgetting zone — excluded from default search and briefings, still
 * reachable by explicit id reads and follow. Absent means a normal live doc. */
export type KnowledgeLifecycle = "core" | "archive";

export interface KnowledgePermissions {
  read: boolean;
  write: boolean;
  publish: boolean;
}

export type KnowledgePublisher =
  | { kind: "none" }
  | {
      kind: "git";
      remote: string;
      push: boolean;
      /** Manual is the default. Checkpoint/automatic are explicit host policy. */
      policy?: "manual" | "checkpoint" | "automatic";
    };

/** Resolved runtime profile. The root is operator-owned configuration and is never logged. */
/** Opt-in knowledge aging: a doc untouched for archiveAfterDays moves to the
 * archive tier; an archived doc untouched for deleteAfterDays more is
 * REPORTED as a deletion candidate — the pass never deletes a file itself. */
export interface KnowledgeAging {
  archiveAfterDays: number;
  deleteAfterDays: number;
}

export interface KnowledgeProfile {
  name: string;
  root: string;
  dialect: KnowledgeDialect;
  layout: KnowledgeLayout;
  visibility?: KnowledgeVisibility;
  permissions: KnowledgePermissions;
  publisher: KnowledgePublisher;
  repositoryProjects?: Readonly<Record<string, string>>;
  aging?: KnowledgeAging;
}

export interface KnowledgeEvidence {
  kind: "event" | "artifact" | "commit" | "test" | "document" | "source" | "operator";
  locator: string;
  digest?: string;
}

export interface KnowledgeRelation {
  predicate: string;
  target: string;
  evidence?: string;
}

export interface KnowledgeLink {
  target: string;
  label?: string;
  anchor?: string;
}

export interface KnowledgeHeading {
  level: number;
  text: string;
  anchor: string;
}

export interface KnowledgeMetadata {
  schema: number;
  id: string;
  kind: KnowledgeKind;
  scope: KnowledgeScope;
  project?: string;
  task?: string;
  status: KnowledgeStatus;
  visibility: KnowledgeVisibility;
  types: string[];
  relations: KnowledgeRelation[];
  evidence: KnowledgeEvidence[];
  aliases: string[];
  tags: string[];
  created_at?: string;
  updated_at?: string;
  lifecycle?: KnowledgeLifecycle;
  /** Date (YYYY-MM-DD) a recorded read last touched this doc; refreshed by
   * the aging pass from the session's knowledge/read events. */
  last_referenced?: string;
  /** Parser diagnostics are never serialized. */
  declared_id?: boolean;
  parse_issues?: string[];
}

export interface KnowledgeDocument {
  id: string;
  path: string;
  title: string;
  body: string;
  digest: string;
  metadata: KnowledgeMetadata;
  headings: KnowledgeHeading[];
  links: KnowledgeLink[];
}

export interface KnowledgeQuery {
  text?: string;
  scope?: KnowledgeScope;
  project?: string;
  task?: string;
  types?: string[];
  tags?: string[];
  kind?: KnowledgeKind;
  status?: KnowledgeStatus;
  truth_state?: KnowledgeTruthState;
  /** Archived docs are excluded from every search unless this is set — the
   * explicit path into the forgetting zone. Reads by id are never filtered. */
  include_archived?: boolean;
  limit?: number;
}

export interface KnowledgeSearchHit {
  id: string;
  path: string;
  title: string;
  scope: KnowledgeScope;
  kind: KnowledgeKind;
  status: KnowledgeStatus;
  truth_state: KnowledgeTruthState;
  score: number;
  snippet: string;
  digest: string;
  tags: string[];
  types: string[];
}

export interface KnowledgeFollowOptions {
  predicate?: string;
  direction?: "out" | "in" | "both";
  depth?: number;
  limit?: number;
}

export interface KnowledgeEdge {
  source: string;
  predicate: string;
  target: string;
  evidence?: string;
}

export interface KnowledgeGraph {
  root: string;
  nodes: Array<Pick<KnowledgeDocument, "id" | "title" | "path">>;
  edges: KnowledgeEdge[];
  revision_digest: string;
}

export interface KnowledgeLintIssue {
  severity: "error" | "warning";
  code:
    | "duplicate_id"
    | "duplicate_alias"
    | "broken_target"
    | "broken_link"
    | "unknown_predicate"
    | "unknown_type"
    | "ontology_domain"
    | "ontology_range"
    | "missing_evidence"
    | "invalid_evidence"
    | "missing_evidence_anchor"
    | "invalid_metadata"
    | "migration_required"
    | "missing_title"
    | "missing_stable_id"
    | "orphan"
    | "contradictory_active"
    | "stale_claim"
    | "scope_leakage"
    | "source_coverage";
  document: string;
  detail: string;
  /** Stable sanitized grouping key for recurring Error Book defects. */
  fingerprint?: string;
}

export interface KnowledgeVaultStatus {
  profile: string;
  dialect: KnowledgeDialect;
  layout: KnowledgeLayout;
  documents: number;
  relations: number;
  links: number;
  errors: number;
  warnings: number;
  orphans: number;
  contested: number;
  superseded: number;
  writable: boolean;
  publishable: boolean;
  revision_digest: string;
}

export interface JournalRecordInput {
  kind: Extract<KnowledgeKind, "worklog" | "research" | "decision" | "error">;
  scope: KnowledgeScope;
  project?: string;
  task?: string;
  title: string;
  summary: string;
  details?: string;
  status?: KnowledgeStatus;
  tags?: string[];
  types?: string[];
  relations?: KnowledgeRelation[];
  evidence?: KnowledgeEvidence[];
  visibility?: KnowledgeVisibility;
  research?: {
    hypothesis: string;
    method: string;
    setup: string;
    results: string;
    analysis: string;
    conclusion: string;
    sources: KnowledgeEvidence[];
  };
}

export interface KnowledgeWriteResult {
  status: "written" | "unchanged";
  id: string;
  path: string;
  digest: string;
  previous_digest?: string;
  revision_digest: string;
}

export interface KnowledgePromoteInput {
  sourceId: string;
  scope: Extract<KnowledgeScope, "project" | "shared">;
  project?: string;
  status?: KnowledgeStatus;
  title?: string;
  kind?: Extract<KnowledgeKind, "claim" | "decision" | "procedure" | "concept">;
  visibility?: KnowledgeVisibility;
  allowVisibilityPromotion?: boolean;
}

export interface KnowledgeResolveInput {
  sourceId: string;
  targetId: string;
  relation: "wiki:contradicts" | "wiki:supersedes";
  evidence: KnowledgeEvidence;
}

export interface KnowledgeBriefingInput {
  statement: string;
  project?: string;
  limit?: number;
  maxBytes?: number;
}

export interface KnowledgeBriefing {
  text: string;
  document_ids: string[];
  related_ids: string[];
  sufficiency: "sufficient" | "insufficient";
  revision_digest: string;
  truncated: boolean;
}

export interface KnowledgeMigrationResult {
  id: string;
  from: number;
  to: number;
  changed: boolean;
  digest: string;
}

export interface KnowledgeAgingResult {
  now: string;
  refreshed: string[];
  archived: string[];
  delete_candidates: string[];
  /** Docs the pass would have rewritten but spared: non-canonical bytes it
   * cannot reproduce, or a write that failed (stale CAS, invalid id). */
  skipped: string[];
  /** Vault-relative paths the pass actually rewrote — fed into checkpoint
   * publication so lifecycle changes are not left uncommitted. */
  touched_paths: string[];
}

export interface KnowledgeMaintenanceResult {
  issues: number;
  recurring: number;
  report_digest: string;
  error_book?: KnowledgeWriteResult;
  aging?: KnowledgeAgingResult;
}

export interface KnowledgePublishInput {
  paths: string[];
  message?: string;
  push?: boolean;
}

export interface KnowledgePublishResult {
  status: "committed" | "published" | "unchanged";
  paths: string[];
}

export interface KnowledgeService {
  readonly profile: KnowledgeProfile | undefined;
  search(query: KnowledgeQuery): KnowledgeSearchHit[];
  /** Owning project of a document, WITHOUT recording a read. Scope checks use
   * this so refusing a document does not durably store the thing refused. */
  documentProject(id: string): string | undefined;
  /** Whether the vault holds this id at all, WITHOUT recording a read. */
  hasDocument(id: string): boolean;
  read(id: string): KnowledgeDocument | undefined;
  follow(id: string, options?: KnowledgeFollowOptions): KnowledgeGraph;
  status(): KnowledgeVaultStatus;
  lint(): KnowledgeLintIssue[];
  brief(input: KnowledgeBriefingInput): KnowledgeBriefing;
  record(input: JournalRecordInput): Promise<KnowledgeWriteResult>;
  promote(input: KnowledgePromoteInput): Promise<KnowledgeWriteResult>;
  resolve(input: KnowledgeResolveInput): Promise<KnowledgeWriteResult>;
  migrate(id: string): Promise<KnowledgeMigrationResult>;
  checkpoint(input: import("./worklog.ts").WorkCheckpointProjectionInput): Promise<KnowledgeWriteResult>;
  maintain(goalId: string): Promise<KnowledgeMaintenanceResult>;
  writeDocument(input: { document: KnowledgeDocument; expectedDigest?: string }): Promise<KnowledgeWriteResult>;
  publish(input: KnowledgePublishInput): Promise<KnowledgePublishResult>;
}
