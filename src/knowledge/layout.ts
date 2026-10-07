import { createHash } from "node:crypto";
import type { KnowledgeKind, KnowledgeLayout, KnowledgeScope } from "./types.ts";

const IDENTIFIER = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,127}$/u;

export interface KnowledgePathInput {
  layout: KnowledgeLayout;
  scope: KnowledgeScope;
  kind: KnowledgeKind;
  title: string;
  project?: string;
  task?: string;
}

/** Map logical knowledge identity to a portable relative path. */
export function knowledgeDocumentPath(input: KnowledgePathInput): string {
  const project = safeSegment(input.project ?? "general", "project");
  const task = safeSegment(input.task ?? "task", "task");
  if (input.layout === "research-lab") {
    if (input.scope === "task") return `01_projects/${project}/tasks/${task}/${journalName(input.kind)}`;
    if (input.scope === "project") return `01_projects/${project}/${projectFolder(input.kind)}/${slug(input.title)}.md`;
    return `02_knowledge_base/${sharedFolder(input.kind)}/${slug(input.title)}.md`;
  }
  if (input.scope === "task") return `tasks/${task}/${journalName(input.kind)}`;
  if (input.scope === "project") return `projects/${project}/${projectFolder(input.kind)}/${slug(input.title)}.md`;
  return `shared/${slug(input.title)}.md`;
}

export function inferKnowledgeScope(path: string, layout: KnowledgeLayout): KnowledgeScope {
  if (layout === "research-lab") {
    if (/^01_projects\/[^/]+\/tasks\//u.test(path)) return "task";
    if (path.startsWith("01_projects/")) return "project";
    return "shared";
  }
  if (path.startsWith("tasks/")) return "task";
  if (path.startsWith("projects/")) return "project";
  return "shared";
}

export function reservedKnowledgePath(path: string): boolean {
  const parts = path.replaceAll("\\", "/").toLowerCase().split("/");
  if (parts.some((part) => part === ".git" || part === ".obsidian" || part === ".dokkabi" || part.startsWith(".dokkabi-tmp-"))) return true;
  return parts.some((part) => /(?:credential|credentials|secret|token|password|private[_-]?key)/iu.test(part));
}

function safeSegment(value: string, label: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`invalid knowledge ${label}`);
  return value;
}

function journalName(kind: KnowledgeKind): string {
  if (kind === "research") return "research.md";
  if (kind === "worklog") return "worklog.md";
  return `${slug(kind)}.md`;
}

function projectFolder(kind: KnowledgeKind): string {
  if (kind === "experiment" || kind === "research") return "experiments";
  if (kind === "decision" || kind === "procedure") return "specs";
  return "reports";
}

function sharedFolder(kind: KnowledgeKind): string {
  const value = kind === "research" ? "research-notes" : kind;
  return `${slug(value)}s`;
}

function slug(value: string): string {
  const normalized = value.normalize("NFKD").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  return normalized || `note-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}
