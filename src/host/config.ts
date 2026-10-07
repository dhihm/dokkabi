import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dokkabiHome } from "./paths.ts";
import {
  defaultFailoverPolicyV1,
  normalizeFailoverPolicyV1,
  type FailoverCandidatePolicyV1,
  type FailoverContinuityV1,
  type FailoverCostPolicyV1,
  type FailoverMode,
  type FailoverPolicyV1,
  type FailoverRecoveryV1,
  type FailoverSelectorV1,
  type FailoverTriggerV1,
} from "./model-failover.ts";
import { assertNoSecrets, containsPrivateInfrastructure, containsSecret } from "./redact.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const BUILTIN_CODEX_MODEL = "gpt-5.3-codex-spark";
export const BUILTIN_LLM_ROUTE = "codex";

export interface LlmSelection {
  route: string;
  model?: string;
}

export interface KnowledgeProfileConfig {
  root: string;
  dialect?: "commonmark" | "obsidian";
  layout?: "generic" | "research-lab";
  visibility?: "private" | "team" | "public";
  permissions?: {
    read?: boolean;
    write?: boolean;
    publish?: boolean;
  };
  publisher?:
    | { kind: "none" }
    | { kind: "git"; remote?: string; push?: boolean; policy?: "manual" | "checkpoint" | "automatic" };
  /** Stable repository digest -> human Wiki project ID. No path or remote is
   * stored; bindings are created explicitly by `dokkabi knowledge bind`. */
  repository_projects?: Record<string, string>;
  /** Opt-in knowledge aging (#110): days without a recorded reference before
   * a doc moves to the archive tier, and further days before it is reported
   * as a deletion candidate. The pass never deletes. */
  aging?: { archive_after_days?: number; delete_after_days?: number };
}

export interface KnowledgeConfig {
  active_profile?: string;
  profiles?: Record<string, KnowledgeProfileConfig>;
}

export interface McpStdioServerConfig {
  transport: "stdio";
  command: string;
  args: string[];
  /** Host environment variable names copied only into the approved child. */
  env: string[];
  /** SHA-256 of the resolved executable bytes approved by the operator. */
  executable_digest: string;
}

export interface McpConfig {
  servers?: Record<string, McpStdioServerConfig>;
}

export interface ManagedPluginFileConfig {
  path: string;
  digest: string;
  bytes: number;
}

export interface ManagedPluginConfig {
  format: 1;
  skill_name: string;
  repository: string;
  commit: string;
  source_path: string;
  license: string;
  digest: string;
  total_bytes: number;
  files: ManagedPluginFileConfig[];
}

export interface FailoverConfig {
  format?: 1;
  /** Absent is exactly off. Credentials never imply permission to switch. */
  mode?: FailoverMode;
  triggers?: FailoverTriggerV1[];
  free_only?: boolean;
  /** Ordered route/model allowlist. No credentials or endpoints belong here. */
  candidates?: Array<Partial<Pick<FailoverCandidatePolicyV1, "allowedCost" | "reservePercent">> & {
    route: string;
    model: string;
  }>;
  selector?: FailoverSelectorV1;
  costPolicy?: FailoverCostPolicyV1;
  continuity?: FailoverContinuityV1;
  recovery?: FailoverRecoveryV1;
  maxTransitionsPerTurn?: number;
  cooldownSeconds?: number;
}

export interface DokkabiConfig {
  model?: string;
  route?: string;
  /** Operator-selected default reasoning effort. */
  effort?: ThinkingLevel;
  /** Bounded public route/model references, newest first. */
  modelHistory?: Array<{ route: string; model: string; at: string }>;
  /** Operator-pinned public route/model references. */
  modelFavorites?: Array<{ route: string; model: string }>;
  heung?: boolean;
  /** Retired configuration key read only for compatibility. */
  crunchmode?: boolean;
  /** Monkeymode default (#59): true = default sample budget, a number = that
   * k, false/absent = single runs. Read by the SWE campaign scripts. */
  monkeymode?: boolean | number;
  /**
   * Repositories the loop may read outside its workspace: "owner/name" to an
   * absolute local clone path. Reads go through pinned snapshots, never the
   * operator's working tree. Absent means no repository is readable.
   */
  repos?: Record<string, string>;
  /** GitHub repositories granted mutation authority for a matching workspace origin. */
  github?: {
    write_repositories?: string[];
    /** Accounts or organizations under which approved private repositories may be created. */
    create_owners?: string[];
    /** Exact private repositories that may receive approved workspace snapshots. */
    publish_repositories?: string[];
    /** Exact private repositories that may receive approved current-branch pushes. */
    push_repositories?: string[];
  };
  /** Operator-owned Markdown knowledge vaults. Credentials are forbidden. */
  knowledge?: KnowledgeConfig;
  /** Exact operator-approved MCP server launch specifications. */
  mcp?: McpConfig;
  /** Exact operator-approved inert GitHub skill bundles. */
  managed_plugins?: Record<string, ManagedPluginConfig>;
  /** Explicit cross-model continuation policy. */
  failover?: FailoverConfig;
  /**
   * The permission mode every command opens in when no flag or environment
   * value says otherwise. An unattended operator sets `bypass` here once
   * instead of on every invocation; the `permission/mode` effect records
   * `source: config` so the audit still says who widened it.
   */
  permissions?: {
    default_mode?: "ask" | "auto" | "bypass";
  };
  /**
   * `disabled: true` opens every session with the kernel fence off (backend
   * `none`), the operator's own environment in the child, and a standing
   * ALERTS row saying so. `DOKKABI_SANDBOX=on|off` overrides it per process.
   */
  sandbox?: {
    disabled?: boolean;
  };
  /** Where `dokkabi doctor` keeps its installation key: an absolute directory
   * outside every session workspace (#230 K1'). Default `<DOKKABI_HOME>/doctor`. */
  doctor?: {
    key_directory?: string;
  };
}

export function readFailoverConfig(): Required<Pick<FailoverConfig, "mode" | "free_only" | "candidates">> {
  const value = readFailoverPolicyV1();
  return {
    mode: value.mode,
    free_only: value.costPolicy === "free_only",
    candidates: value.candidates.map(({ route, model }) => ({ route, model })),
  };
}

export function writeFailoverConfig(value: FailoverConfig): FailoverConfig {
  const normalized = writeFailoverPolicyV1(normalizeFailoverPolicyV1(value));
  return normalized;
}

/** Complete secret-free policy. A malformed hand-edited config is disabled,
 * never widened or partially accepted. */
export function readFailoverPolicyV1(): FailoverPolicyV1 {
  const value = readConfig().failover;
  try {
    return normalizeFailoverPolicyV1(value);
  } catch {
    return defaultFailoverPolicyV1();
  }
}

export function writeFailoverPolicyV1(value: FailoverPolicyV1): FailoverPolicyV1 {
  const normalized = normalizeFailoverPolicyV1(value);
  assertNoSecrets(normalized);
  writeConfig({ failover: normalized });
  return normalized;
}

export function configPath(): string {
  return join(dokkabiHome(), "config.json");
}

export function readConfig(): DokkabiConfig {
  const path = configPath();
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DokkabiConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeConfig(patch: DokkabiConfig): DokkabiConfig {
  const next = { ...readConfig(), ...patch };
  const home = dokkabiHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  writeFileSync(configPath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(configPath(), 0o600);
  return next;
}

const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;

/** Persist the complete repository-creation owner policy without replacing
 * neighboring GitHub settings. The caller records the authority effect. */
export function updateGithubCreateOwners(owners: readonly string[]): string[] {
  const next: string[] = [];
  const seen = new Set<string>();
  for (const value of owners) {
    const owner = value.trim();
    const normalized = owner.toLowerCase();
    if (!GITHUB_OWNER_PATTERN.test(owner)) {
      throw new Error(`invalid GitHub owner: ${owner || "empty"}`);
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    next.push(owner);
  }
  assertNoSecrets(next);
  const current = readConfig();
  writeConfig({
    github: {
      ...current.github,
      create_owners: next,
    },
  });
  return next;
}

const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u;

/** Persist exact private publishing targets without replacing neighboring
 * GitHub policy. Live authority updates only after this function succeeds. */
export function updateGithubPublishRepositories(repositories: readonly string[]): string[] {
  const next: string[] = [];
  const seen = new Set<string>();
  for (const value of repositories) {
    const repository = value.trim();
    const normalized = repository.toLowerCase();
    const name = repository.slice(repository.indexOf("/") + 1);
    if (!GITHUB_REPOSITORY_PATTERN.test(repository) || name === "." || name === "..") {
      throw new Error(`invalid GitHub repository: ${repository || "empty"}`);
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    next.push(repository);
  }
  assertNoSecrets(next);
  const current = readConfig();
  writeConfig({
    github: {
      ...current.github,
      publish_repositories: next,
    },
  });
  return next;
}

/** Persist exact current-branch push targets without replacing neighboring
 * GitHub policy. Snapshot publishing does not imply commit-push authority. */
export function updateGithubPushRepositories(repositories: readonly string[]): string[] {
  const next: string[] = [];
  const seen = new Set<string>();
  for (const value of repositories) {
    const repository = value.trim();
    const normalized = repository.toLowerCase();
    const name = repository.slice(repository.indexOf("/") + 1);
    if (!GITHUB_REPOSITORY_PATTERN.test(repository) || name === "." || name === "..") {
      throw new Error(`invalid GitHub repository: ${repository || "empty"}`);
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    next.push(repository);
  }
  assertNoSecrets(next);
  const current = readConfig();
  writeConfig({
    github: {
      ...current.github,
      push_repositories: next,
    },
  });
  return next;
}

const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MCP_COMMAND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const MCP_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const MCP_EXECUTABLE_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export function normalizeMcpServers(
  servers: Readonly<Record<string, McpStdioServerConfig>>,
): Record<string, McpStdioServerConfig> {
  const entries = Object.entries(servers);
  if (entries.length > 16) throw new Error("MCP server limit is 16");
  const normalized: Record<string, McpStdioServerConfig> = {};
  for (const [name, value] of entries.sort(([left], [right]) => left.localeCompare(right, "en"))) {
    if (!MCP_SERVER_NAME_PATTERN.test(name)) throw new Error(`invalid MCP server name: ${name || "empty"}`);
    if (!value || value.transport !== "stdio" || !MCP_COMMAND_PATTERN.test(value.command)) {
      throw new Error(`invalid MCP stdio command for ${name}`);
    }
    if (!Array.isArray(value.args) || value.args.length > 24) {
      throw new Error(`invalid MCP arguments for ${name}`);
    }
    let argumentBytes = 0;
    const args = value.args.map((argument) => {
      if (typeof argument !== "string" || argument.length === 0 || argument.length > 512 || /[\0\r\n]/u.test(argument)) {
        throw new Error(`invalid MCP argument for ${name}`);
      }
      argumentBytes += Buffer.byteLength(argument);
      if (containsSecret(argument) || containsPrivateInfrastructure(argument)) {
        throw new Error(`secret-shaped or private MCP argument for ${name}`);
      }
      return argument;
    });
    if (argumentBytes > 4_096) throw new Error(`MCP arguments are too large for ${name}`);
    validateMcpLaunchShape(value.command, args, name);
    if (!Array.isArray(value.env) || value.env.length > 16) {
      throw new Error(`invalid MCP environment names for ${name}`);
    }
    const env = [...new Set(value.env)].sort();
    if (env.some((key) => !MCP_ENV_NAME_PATTERN.test(key) || forbiddenMcpEnvironmentName(key))) {
      throw new Error(`invalid MCP environment name for ${name}`);
    }
    if (!MCP_EXECUTABLE_DIGEST_PATTERN.test(value.executable_digest)) {
      throw new Error(`invalid MCP executable digest for ${name}`);
    }
    normalized[name] = {
      transport: "stdio",
      command: value.command,
      args,
      env,
      executable_digest: value.executable_digest,
    };
  }
  return normalized;
}

/** Persist the complete secret-free MCP authority without dropping other
 * configuration. Credential values are never accepted by this boundary. */
export function updateMcpServers(
  servers: Readonly<Record<string, McpStdioServerConfig>>,
): Record<string, McpStdioServerConfig> {
  const normalized = normalizeMcpServers(servers);
  const current = readConfig();
  writeConfig({ mcp: { ...current.mcp, servers: normalized } });
  return normalized;
}

const MANAGED_PLUGIN_ID_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/u;
const MANAGED_PLUGIN_REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u;
const MANAGED_PLUGIN_COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const MANAGED_PLUGIN_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const MANAGED_PLUGIN_LICENSE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/u;

export function normalizeManagedPlugins(
  plugins: Readonly<Record<string, ManagedPluginConfig>>,
): Record<string, ManagedPluginConfig> {
  const entries = Object.entries(plugins);
  if (entries.length > 16) throw new Error("managed plugin limit is 16");
  const normalized: Record<string, ManagedPluginConfig> = {};
  for (const [id, value] of entries.sort(([left], [right]) => left.localeCompare(right, "en"))) {
    if (!MANAGED_PLUGIN_ID_PATTERN.test(id) || !value || value.format !== 1) {
      throw new Error(`invalid managed plugin id: ${id || "empty"}`);
    }
    if (!MANAGED_PLUGIN_ID_PATTERN.test(value.skill_name)) throw new Error(`invalid managed skill name for ${id}`);
    if (!MANAGED_PLUGIN_REPOSITORY_PATTERN.test(value.repository)) throw new Error(`invalid managed repository for ${id}`);
    if (!MANAGED_PLUGIN_COMMIT_PATTERN.test(value.commit)) throw new Error(`invalid managed commit for ${id}`);
    if (!safeManagedRelativePath(value.source_path)) throw new Error(`invalid managed source path for ${id}`);
    if (!MANAGED_PLUGIN_LICENSE_PATTERN.test(value.license)) throw new Error(`invalid managed license for ${id}`);
    if (!MANAGED_PLUGIN_DIGEST_PATTERN.test(value.digest)) throw new Error(`invalid managed digest for ${id}`);
    if (!Number.isSafeInteger(value.total_bytes) || value.total_bytes < 0 || value.total_bytes > 2 * 1024 * 1024) {
      throw new Error(`invalid managed byte count for ${id}`);
    }
    if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > 64) {
      throw new Error(`invalid managed files for ${id}`);
    }
    const seen = new Set<string>();
    let total = 0;
    const files = value.files.map((file) => {
      if (!file || !safeManagedRelativePath(file.path) || seen.has(file.path)) {
        throw new Error(`invalid managed file path for ${id}`);
      }
      seen.add(file.path);
      if (!MANAGED_PLUGIN_DIGEST_PATTERN.test(file.digest) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 256 * 1024) {
        throw new Error(`invalid managed file metadata for ${id}`);
      }
      total += file.bytes;
      return { path: file.path, digest: file.digest, bytes: file.bytes };
    });
    if (total !== value.total_bytes || !seen.has("SKILL.md")) throw new Error(`managed file totals do not match for ${id}`);
    normalized[id] = {
      format: 1,
      skill_name: value.skill_name,
      repository: value.repository,
      commit: value.commit,
      source_path: value.source_path,
      license: value.license,
      digest: value.digest,
      total_bytes: value.total_bytes,
      files: files.sort((left, right) => left.path.localeCompare(right.path, "en")),
    };
  }
  return normalized;
}

/** Persist only validated metadata. The exact bytes live in the private
 * content-addressed managed-plugin store and are re-hashed on every read. */
export function updateManagedPlugins(
  plugins: Readonly<Record<string, ManagedPluginConfig>>,
): Record<string, ManagedPluginConfig> {
  const normalized = normalizeManagedPlugins(plugins);
  writeConfig({ managed_plugins: normalized });
  return normalized;
}

function safeManagedRelativePath(value: string): boolean {
  return value.length > 0 && value.length <= 1024 && !value.startsWith("/") && !value.includes("\\")
    && !value.includes("\0") && !value.split("/").some((part) => !part || part === "." || part === "..");
}

function forbiddenMcpEnvironmentName(name: string): boolean {
  return /^(?:PATH|HOME|SHELL|PWD|OLDPWD|IFS|ENV|BASH_ENV|NODE_OPTIONS|BUN_OPTIONS|PYTHONPATH|RUBYOPT|PERL5OPT|LD_.+|DYLD_.+)$/u
    .test(name);
}

function validateMcpLaunchShape(command: string, args: readonly string[], server: string): void {
  const genericLaunchers = new Set([
    "bash", "sh", "zsh", "fish", "env", "node", "nodejs", "bun",
    "python", "python3", "perl", "ruby", "npm", "pnpm", "yarn", "curl", "wget",
  ]);
  if (genericLaunchers.has(command)) {
    throw new Error(`MCP ${server} must use its server executable or a supported pinned package runner`);
  }
  if (command !== "npx") return;
  const packageSpec = args[0] === "--yes" ? args[1] : undefined;
  if (!packageSpec || !exactNpmPackage(packageSpec)) {
    throw new Error(`MCP ${server} npx package must use --yes and an exact package version`);
  }
}

function exactNpmPackage(value: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u
    .test(value);
}

export function resolveLlmSelection(explicit: Partial<LlmSelection> = {}): LlmSelection {
  const config = readConfig();
  const savedRoute = config.route?.trim() || BUILTIN_LLM_ROUTE;
  const route = explicit.route?.trim() || process.env.DOKKABI_ROUTE?.trim() || savedRoute;
  const model = explicit.model?.trim() || process.env.DOKKABI_MODEL?.trim() ||
    (route === savedRoute ? config.model?.trim() : undefined) ||
    (route === BUILTIN_LLM_ROUTE ? BUILTIN_CODEX_MODEL : undefined);
  return { route, model };
}

/**
 * Flag > env > ~/.dokkabi/config.json > built-in default.
 */
export function resolveCodexModel(explicit?: string): string {
  return resolveLlmSelection({ route: BUILTIN_LLM_ROUTE, model: explicit }).model ?? BUILTIN_CODEX_MODEL;
}
