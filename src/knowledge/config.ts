import { isAbsolute, resolve } from "node:path";
import type { DokkabiConfig, KnowledgeProfileConfig } from "../host/config.ts";
import { assertNoSecrets } from "../host/redact.ts";
import type { KnowledgeAging, KnowledgeProfile } from "./types.ts";

const PROFILE = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const FORBIDDEN_KEYS = /(?:token|secret|password|credential|api[_-]?key|private[_-]?key)/iu;

export function resolveActiveKnowledgeProfile(
  config: DokkabiConfig,
  requested?: string,
): KnowledgeProfile | undefined {
  const name = requested?.trim() || config.knowledge?.active_profile?.trim();
  if (!name) return undefined;
  if (!PROFILE.test(name)) throw new Error("knowledge profile name must use lowercase letters, digits, underscores, or hyphens");
  const raw = config.knowledge?.profiles?.[name];
  if (!raw) throw new Error(`knowledge profile ${name} is not configured`);
  return validateKnowledgeProfile(name, raw);
}

/** The project-alias rule. Must equal src/knowledge/service.ts IDENTIFIER:
 * a binding the service will not accept is not a usable binding. */
export const KNOWLEDGE_PROJECT = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,127}$/u;

export function validateKnowledgeProfile(name: string, raw: KnowledgeProfileConfig): KnowledgeProfile {
  assertNoForbiddenKeys(raw);
  assertAllowedKeys(raw as unknown as Record<string, unknown>, ["root", "dialect", "layout", "visibility", "permissions", "publisher", "repository_projects", "aging"]);
  if (raw.permissions && typeof raw.permissions === "object") {
    assertAllowedKeys(raw.permissions as Record<string, unknown>, ["read", "write", "publish"]);
  }
  if (raw.publisher && typeof raw.publisher === "object") {
    assertAllowedKeys(raw.publisher as unknown as Record<string, unknown>, ["kind", "remote", "push", "policy"]);
  }
  if (raw.aging !== undefined) {
    if (!raw.aging || typeof raw.aging !== "object" || Array.isArray(raw.aging)) {
      throw new Error(`knowledge profile ${name} aging must be an object`);
    }
    assertAllowedKeys(raw.aging as Record<string, unknown>, ["archive_after_days", "delete_after_days"]);
  }
  assertNoSecrets(raw);
  if (typeof raw.root !== "string" || raw.root.trim().length === 0) {
    throw new Error(`knowledge profile ${name} requires root`);
  }
  const root = resolve(raw.root);
  if (!isAbsolute(root)) throw new Error(`knowledge profile ${name} root must resolve to an absolute path`);
  const dialect = raw.dialect ?? "commonmark";
  if (dialect !== "commonmark" && dialect !== "obsidian") throw new Error(`knowledge profile ${name} has invalid dialect`);
  const layout = raw.layout ?? "generic";
  if (layout !== "generic" && layout !== "research-lab") throw new Error(`knowledge profile ${name} has invalid layout`);
  const visibility = raw.visibility ?? "private";
  if (visibility !== "private" && visibility !== "team" && visibility !== "public") {
    throw new Error(`knowledge profile ${name} has invalid visibility`);
  }
  const permissions = {
    read: raw.permissions?.read !== false,
    write: raw.permissions?.write === true,
    publish: raw.permissions?.publish === true,
  };
  const rawPublisher = raw.publisher ?? { kind: "none" as const };
  if (rawPublisher.kind !== "none" && rawPublisher.kind !== "git") {
    throw new Error(`knowledge profile ${name} has invalid publisher`);
  }
  const publisher = rawPublisher.kind === "git"
    ? {
        kind: "git" as const,
        remote: rawPublisher.remote?.trim() || "origin",
        push: rawPublisher.push === true,
        policy: rawPublisher.policy ?? "manual",
      }
    : { kind: "none" as const };
  if (publisher.kind === "git" && !REMOTE.test(publisher.remote)) {
    throw new Error(`knowledge profile ${name} git remote must be an alias, not a URL`);
  }
  if (publisher.kind === "git" && publisher.policy !== "manual" && publisher.policy !== "checkpoint" && publisher.policy !== "automatic") {
    throw new Error(`knowledge profile ${name} has invalid publish policy`);
  }
  if (permissions.publish && publisher.kind !== "git") {
    throw new Error(`knowledge profile ${name} grants publish without a git publisher`);
  }
  const repositoryProjects: Record<string, string> = {};
  if (raw.repository_projects !== undefined) {
    if (!raw.repository_projects || typeof raw.repository_projects !== "object" || Array.isArray(raw.repository_projects)) {
      throw new Error(`knowledge profile ${name} repository bindings must be an object`);
    }
    for (const [digest, project] of Object.entries(raw.repository_projects)) {
      if (!/^[a-f0-9]{64}$/u.test(digest) || typeof project !== "string") {
        throw new Error(`knowledge profile ${name} has an invalid repository binding`);
      }
      // A project the service cannot brief with is DROPPED, not fatal.
      //
      // This validator runs on every profile load, so rejecting the profile
      // would brick `bootSession` — and with it `dokkabi work`, `ask`, and
      // the very `knowledge bind`/`verify` an operator needs to repair the
      // binding. An earlier `knowledge bind` accepted a wider alphabet
      // (colons, 192 chars) than src/knowledge/service.ts IDENTIFIER, so
      // those bindings exist in the wild. Dropping one leaves its repository
      // UNBOUND, which is the fail-closed state the rest of #58 already
      // handles and reports.
      if (!KNOWLEDGE_PROJECT.test(project)) continue;
      repositoryProjects[digest] = project;
    }
  }
  let aging: KnowledgeAging | undefined;
  if (raw.aging !== undefined) {
    const archive = raw.aging.archive_after_days;
    const remove = raw.aging.delete_after_days;
    if (!Number.isInteger(archive) || (archive as number) < 1
      || !Number.isInteger(remove) || (remove as number) < 1) {
      throw new Error(`knowledge profile ${name} aging requires positive integer day counts`);
    }
    aging = { archiveAfterDays: archive as number, deleteAfterDays: remove as number };
  }
  return {
    name,
    root,
    dialect,
    layout,
    visibility,
    permissions,
    publisher,
    repositoryProjects: Object.freeze(repositoryProjects),
    ...(aging ? { aging } : {}),
  };
}

function assertNoForbiddenKeys(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.test(key)) throw new Error("knowledge profiles cannot contain credentials or secret fields");
    assertNoForbiddenKeys(nested);
  }
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const set = new Set(allowed);
  if (Object.keys(value).some((key) => !set.has(key))) {
    throw new Error("knowledge profile contains an unsupported field");
  }
}
