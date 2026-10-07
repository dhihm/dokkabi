import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig, writeConfig, type KnowledgeProfileConfig } from "../host/config.ts";
import { EventLog } from "../host/event-log.ts";
import { sessionLogPath } from "../host/paths.ts";
import { KNOWLEDGE_PROJECT, resolveActiveKnowledgeProfile, validateKnowledgeProfile } from "./config.ts";
import { KnowledgeIndex } from "./index.ts";
import { resolveRepositoryScope } from "./briefing-scope.ts";
import { createKnowledgeService } from "./service.ts";
import { CORE_ONTOLOGY, coreOntologyJson } from "./ontology.ts";
import type { JournalRecordInput, KnowledgePromoteInput } from "./types.ts";
import { swarmRepositoryDigest } from "../swarm/repository-identity.ts";

interface KnowledgeCliIo {
  write(line: string): void;
  readStdin?(): Promise<string>;
}

const DEFAULT_CONTEXT = `${JSON.stringify({
  "@context": {
    wiki: "https://dokkabi.dev/wiki#",
    ...Object.fromEntries(CORE_ONTOLOGY.classes.map((item) => [item.id, { "@id": item.id }])),
    ...Object.fromEntries(CORE_ONTOLOGY.predicates.map((item) => [item.id, { "@type": "@id" }])),
  },
}, null, 2)}\n`;

export async function runKnowledgeCommand(args: string[], io: KnowledgeCliIo = defaultIo()): Promise<number> {
  const [command = "status", ...rest] = args;
  if (command === "init") return initialize(rest, io);
  if (command === "attach") return attach(rest, io);
  if (command === "profiles") return listProfiles(io);
  if (command === "select") return selectProfile(rest, io);
  if (command === "verify") return verifyProfile(rest, io);
  if (command === "bind") return bindRepository(rest, io);
  if (command === "help" || command === "--help" || command === "-h") {
    io.write(knowledgeHelp());
    return 0;
  }
  const flags = parseArgs(rest);
  const profile = resolveActiveKnowledgeProfile(readConfig(), flags.profile);
  if (!profile) {
    io.write("knowledge=unconfigured");
    io.write("next=dokkabi knowledge init --profile notes --root PATH");
    return command === "status" ? 0 : 2;
  }
  if (command === "status") {
    let status;
    try {
      status = new KnowledgeIndex(profile).status();
    } catch {
      io.write(`knowledge=invalid profile=${profile.name} reason=index-unavailable`);
      return 1;
    }
    io.write(`knowledge=ready profile=${status.profile} dialect=${status.dialect} layout=${status.layout}`);
    io.write(`documents=${status.documents} relations=${status.relations} links=${status.links} errors=${status.errors} warnings=${status.warnings}`);
    io.write(`write=${status.writable ? "enabled" : "disabled"} publish=${status.publishable ? "enabled" : "disabled"} revision=${status.revision_digest.slice(0, 12)}`);
    return status.errors > 0 ? 1 : 0;
  }

  const log = EventLog.create(sessionLogPath(`knowledge-cli-${randomUUID()}`));
  const wiki = createKnowledgeService({ log, profile });
  if (command === "query") {
    const text = positional(rest).join(" ").trim();
    if (!text) throw new Error("knowledge query requires text");
    io.write(JSON.stringify(wiki.search({
      text,
      ...(flags.scope ? { scope: flags.scope as "task" | "project" | "shared" } : {}),
      ...(flags.archived ? { include_archived: true } : {}),
    }), null, 2));
    return 0;
  }
  if (command === "read") {
    const id = positional(rest)[0];
    if (!id) throw new Error("knowledge read requires a document id");
    const document = wiki.read(id);
    if (!document) return 1;
    io.write(document.body);
    return 0;
  }
  if (command === "follow") {
    const id = positional(rest)[0];
    if (!id) throw new Error("knowledge follow requires a document id");
    io.write(JSON.stringify(wiki.follow(id), null, 2));
    return 0;
  }
  if (command === "lint") {
    const issues = wiki.lint();
    io.write(JSON.stringify(issues, null, 2));
    return issues.some((issue) => issue.severity === "error") ? 1 : 0;
  }
  if (command === "journal") {
    if (!flags.stdin) throw new Error("knowledge journal accepts content only through --stdin JSON");
    const raw = await (io.readStdin?.() ?? Bun.stdin.text());
    const result = await wiki.record(JSON.parse(raw) as JournalRecordInput);
    io.write(JSON.stringify(result));
    return 0;
  }
  if (command === "promote") {
    const sourceId = positional(rest)[0];
    if (!sourceId || (flags.scope !== "project" && flags.scope !== "shared")) {
      throw new Error("knowledge promote requires ID and --scope project|shared");
    }
    const result = await wiki.promote({
      sourceId,
      scope: flags.scope,
      ...(flags.project ? { project: flags.project } : {}),
    } satisfies KnowledgePromoteInput);
    io.write(JSON.stringify(result));
    return 0;
  }
  if (command === "publish") {
    const paths = positional(rest);
    const result = await wiki.publish({ paths, push: flags.push === true });
    io.write(JSON.stringify(result));
    return 0;
  }
  throw new Error(`unknown knowledge command ${command}`);
}

function initialize(args: string[], io: KnowledgeCliIo): number {
  const flags = parseArgs(args);
  if (!flags.profile || !flags.root) throw new Error("knowledge init requires --profile NAME and --root PATH");
  validateProfileName(flags.profile);
  if (flags.push && !flags.git) throw new Error("knowledge init --push requires --git");
  if (flags.remote && !flags.git) throw new Error("knowledge init --remote requires --git");
  if (flags.publishPolicy && !flags.git) throw new Error("knowledge init --publish-policy requires --git");
  const root = resolve(flags.root);
  validateKnowledgeProfile(flags.profile, profileConfig(flags, root));
  const directories = [root, resolve(root, "meta"), resolve(root, "meta", "ontology"), resolve(root, "tasks"), resolve(root, "projects"), resolve(root, "shared")];
  for (const dir of directories) {
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error("knowledge init refuses symbolic-link directories");
  }
  for (const dir of directories) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  const context = resolve(root, "meta", "context.jsonld");
  if (!existsSync(context)) {
    writeFileSync(context, DEFAULT_CONTEXT, { mode: 0o600 });
    chmodSync(context, 0o600);
  }
  const core = resolve(root, "meta", "ontology", "core.json");
  if (!existsSync(core)) {
    writeFileSync(core, coreOntologyJson(), { mode: 0o600 });
    chmodSync(core, 0o600);
  }
  if (flags.git && !isGitWorktreeRoot(root)) {
    const initialized = spawnSync("git", ["init", "--quiet"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (initialized.status !== 0) throw new Error("knowledge init could not create the Git worktree");
  }
  storeProfile({ ...flags, profile: flags.profile }, root);
  io.write(`knowledge=initialized profile=${flags.profile} dialect=${flags.obsidian ? "obsidian" : "commonmark"}`);
  io.write("credentials=none auth=git-owned");
  return 0;
}

function attach(args: string[], io: KnowledgeCliIo): number {
  const flags = parseArgs(args);
  if (!flags.profile || !flags.root) throw new Error("knowledge attach requires --profile NAME and --root PATH");
  validateProfileName(flags.profile);
  if (flags.push && !flags.git) throw new Error("knowledge attach --push requires --git");
  if (flags.remote && !flags.git) throw new Error("knowledge attach --remote requires --git");
  if (flags.publishPolicy && !flags.git) throw new Error("knowledge attach --publish-policy requires --git");
  const root = resolve(flags.root);
  validateKnowledgeProfile(flags.profile, profileConfig(flags, root));
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error("knowledge attach root must be an existing directory");
  if (lstatSync(root).isSymbolicLink()) throw new Error("knowledge vault root cannot be a symbolic link");
  if (flags.git && !isGitWorktreeRoot(root)) throw new Error("knowledge attach --git requires an existing Git worktree root");
  // Attach is deliberately non-destructive: external Obsidian/Git vaults are
  // indexed in place and no metadata or directory is created here.
  storeProfile({ ...flags, profile: flags.profile }, root);
  io.write(`knowledge=attached profile=${flags.profile} dialect=${flags.obsidian ? "obsidian" : "commonmark"}`);
  io.write("credentials=none auth=git-owned");
  return 0;
}

function storeProfile(flags: ParsedArgs & { profile: string }, root: string): void {
  const config = readConfig();
  const raw = profileConfig(flags, root);
  validateKnowledgeProfile(flags.profile, raw);
  writeConfig({
    knowledge: {
      active_profile: flags.profile,
      profiles: {
        ...(config.knowledge?.profiles ?? {}),
        [flags.profile]: raw,
      },
    },
  });
}

function profileConfig(flags: ParsedArgs, root: string): KnowledgeProfileConfig {
  const publisher: KnowledgeProfileConfig["publisher"] = flags.git
    ? {
        kind: "git",
        remote: flags.remote ?? "origin",
        push: flags.push === true,
        policy: publishPolicy(flags.publishPolicy),
      }
    : { kind: "none" };
  return {
    root,
    dialect: flags.obsidian ? "obsidian" : "commonmark",
    layout: flags.layout === "research-lab" ? "research-lab" : "generic",
    visibility: visibility(flags.visibility),
    permissions: {
      read: true,
      write: flags.write === true || flags.git === true,
      publish: flags.git === true,
    },
    publisher,
  };
}

function listProfiles(io: KnowledgeCliIo): number {
  const config = readConfig();
  const profiles = Object.keys(config.knowledge?.profiles ?? {}).sort();
  if (profiles.length === 0) {
    io.write("knowledge=unconfigured");
    return 0;
  }
  for (const name of profiles) {
    let state = "ready";
    try {
      resolveActiveKnowledgeProfile(config, name);
    } catch {
      state = "invalid";
    }
    io.write(`profile=${name} active=${config.knowledge?.active_profile === name ? "yes" : "no"} state=${state}`);
  }
  return 0;
}

function selectProfile(args: string[], io: KnowledgeCliIo): number {
  const config = readConfig();
  const name = positional(args)[0] ?? parseArgs(args).profile;
  if (!name) throw new Error("knowledge select requires a profile name");
  resolveActiveKnowledgeProfile(config, name);
  writeConfig({ knowledge: { ...(config.knowledge ?? {}), active_profile: name } });
  io.write(`knowledge=selected profile=${name}`);
  return 0;
}

function bindRepository(args: string[], io: KnowledgeCliIo): number {
  const flags = parseArgs(args);
  // One rule, shared with the profile validator, so bind and the service
  // cannot drift apart again: bind used to accept a wider alphabet than
  // `brief`/`search` accept, and the mismatch surfaced as `invalid knowledge
  // project` thrown from inside a goal-context prepare with no try/catch.
  if (!flags.project || !KNOWLEDGE_PROJECT.test(flags.project)) {
    throw new Error("knowledge bind requires a stable --project ID [letters, digits, . _ -]");
  }
  const config = readConfig();
  const profile = resolveActiveKnowledgeProfile(config, flags.profile);
  if (!profile) throw new Error("knowledge bind requires an active profile");
  const digest = flags.repository ?? swarmRepositoryDigest(resolve(flags.workspace ?? process.cwd()));
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error("knowledge bind repository digest is invalid");
  const raw = config.knowledge?.profiles?.[profile.name];
  if (!raw) throw new Error("knowledge bind profile disappeared");
  const next: KnowledgeProfileConfig = {
    ...raw,
    repository_projects: {
      ...(raw.repository_projects ?? {}),
      [digest]: flags.project,
    },
  };
  validateKnowledgeProfile(profile.name, next);
  writeConfig({
    knowledge: {
      ...(config.knowledge ?? {}),
      active_profile: profile.name,
      profiles: { ...(config.knowledge?.profiles ?? {}), [profile.name]: next },
    },
  });
  io.write(`knowledge=bound profile=${profile.name} repository=${digest.slice(0, 12)} project=${flags.project}`);
  return 0;
}

function verifyProfile(args: string[], io: KnowledgeCliIo): number {
  const flags = parseArgs(args);
  const profile = resolveActiveKnowledgeProfile(readConfig(), flags.profile);
  if (!profile) {
    io.write("knowledge=unconfigured");
    return 2;
  }
  if (!existsSync(profile.root) || !lstatSync(profile.root).isDirectory() || lstatSync(profile.root).isSymbolicLink()) {
    io.write(`knowledge=invalid profile=${profile.name} reason=root-unavailable`);
    return 1;
  }
  if (profile.publisher.kind === "git" && !isGitWorktreeRoot(profile.root)) {
    io.write(`knowledge=invalid profile=${profile.name} reason=git-worktree-unavailable`);
    return 1;
  }
  let status;
  try {
    status = new KnowledgeIndex(profile).status();
  } catch {
    io.write(`knowledge=invalid profile=${profile.name} reason=index-unavailable`);
    return 1;
  }
  io.write(`knowledge=verified profile=${profile.name} dialect=${profile.dialect} layout=${profile.layout}`);
  io.write(`documents=${status.documents} errors=${status.errors} warnings=${status.warnings} write=${status.writable ? "enabled" : "disabled"} publish=${status.publishable ? "enabled" : "disabled"}`);
  // Reads are repository-scoped and fail closed (#58), so "is this workspace
  // bound" is the difference between a briefing and silence. Reporting it here
  // is how an operator answers that without grepping an EventLog.
  const scope = resolveRepositoryScope({
    repositoryProjects: profile.repositoryProjects,
    workspaceRoot: resolve(flags.workspace ?? process.cwd()),
  });
  io.write(
    `repository=${scope.repository ? scope.repository.slice(0, 12) : "unidentified"} scope=${scope.status}`
    + `${scope.project ? ` project=${scope.project}` : ""}${scope.reason ? ` reason=${scope.reason}` : ""}`,
  );
  if (scope.status !== "bound") {
    io.write(scope.status === "unbound"
      ? "next=dokkabi knowledge bind --project ID"
      : "next=knowledge reads need a non-shallow git workspace");
  }
  // The exit code stays a statement about the VAULT, which is what `verify`
  // has always meant. The binding is a property of the WORKSPACE, so a gate
  // that cares asks for it: silently folding it in would have flipped the
  // result for every healthy unbound vault.
  const requireBinding = args.includes("--require-binding");
  return status.errors > 0 || (requireBinding && scope.status !== "bound") ? 1 : 0;
}

function isGitWorktreeRoot(root: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || !result.stdout.trim()) return false;
  try {
    return realpathSync(result.stdout.trim()) === realpathSync(root);
  } catch {
    return false;
  }
}

interface ParsedArgs {
  profile?: string;
  root?: string;
  scope?: string;
  project?: string;
  repository?: string;
  "require-binding"?: boolean;
  workspace?: string;
  remote?: string;
  layout?: string;
  visibility?: string;
  publishPolicy?: string;
  obsidian?: boolean;
  write?: boolean;
  git?: boolean;
  push?: boolean;
  stdin?: boolean;
  archived?: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  const valued = new Set(["profile", "root", "scope", "project", "repository", "workspace", "remote", "layout", "visibility", "publish-policy"]);
  const boolean = new Set(["obsidian", "write", "git", "push", "stdin", "require-binding", "archived"]);
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i]!;
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    if (boolean.has(key)) {
      (out as Record<string, unknown>)[key] = true;
      continue;
    }
    if (!valued.has(key)) throw new Error(`unknown knowledge flag --${key}`);
    const next = args[++i];
    if (!next || next.startsWith("--")) throw new Error(`knowledge flag --${key} requires a value`);
    (out as Record<string, unknown>)[key === "publish-policy" ? "publishPolicy" : key] = next;
  }
  return out;
}

function positional(args: string[]): string[] {
  const valued = new Set(["--profile", "--root", "--scope", "--project", "--repository", "--workspace", "--remote", "--layout", "--visibility", "--publish-policy"]);
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (valued.has(args[i]!)) {
      i += 1;
      continue;
    }
    if (!args[i]!.startsWith("--")) out.push(args[i]!);
  }
  return out;
}

function defaultIo(): KnowledgeCliIo {
  return {
    write: (line) => process.stdout.write(`${line}\n`),
    readStdin: () => Bun.stdin.text(),
  };
}

function knowledgeHelp(): string {
  return `Usage:
  dokkabi knowledge init --profile NAME --root PATH [--obsidian] [--write] [--git] [--push]
  dokkabi knowledge attach --profile NAME --root PATH [--obsidian] [--write] [--git]
  dokkabi knowledge profiles
  dokkabi knowledge select NAME
  dokkabi knowledge verify [--profile NAME] [--workspace DIR] [--require-binding]
  dokkabi knowledge bind --project ID [--profile NAME] [--workspace REPOSITORY|--repository DIGEST]
  dokkabi knowledge status [--profile NAME]
  dokkabi knowledge query TEXT [--scope task|project|shared] [--archived]
  dokkabi knowledge read ID
  dokkabi knowledge follow ID
  dokkabi knowledge lint
  dokkabi knowledge journal --stdin
  dokkabi knowledge promote ID --scope project|shared [--project NAME]
  dokkabi knowledge publish PATH... [--push]

Profiles contain filesystem and policy metadata only. Git authentication stays
with the user's git/SSH credential manager; Dokkabi never copies credentials.`;
}

function validateProfileName(value: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/u.test(value)) {
    throw new Error("knowledge profile name must use lowercase letters, digits, underscores, or hyphens");
  }
}

function visibility(value: string | undefined): "private" | "team" | "public" {
  if (value === undefined || value === "private") return "private";
  if (value === "team" || value === "public") return value;
  throw new Error("knowledge visibility must be private, team, or public");
}

function publishPolicy(value: string | undefined): "manual" | "checkpoint" | "automatic" {
  if (value === undefined || value === "manual") return "manual";
  if (value === "checkpoint" || value === "automatic") return value;
  throw new Error("knowledge publish policy must be manual, checkpoint, or automatic");
}
