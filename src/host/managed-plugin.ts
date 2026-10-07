import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  normalizeManagedPlugins,
  updateManagedPlugins,
  type ManagedPluginConfig,
} from "./config.ts";
import type { EventLog } from "./event-log.ts";
import {
  candidateDigest,
  inspectManagedPlugin,
  normalizeRelativePath,
  type ManagedPluginCandidate,
  type ManagedPluginInspectRequest,
} from "./managed-plugin-source.ts";
import { dokkabiHome } from "./paths.ts";
import type { PermissionController } from "./permissions.ts";
import { approvalRelayEnabled, waitForOperatorDecision } from "./approval-relay.ts";

const PLUGIN_ID = /^[a-z][a-z0-9._-]{0,127}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

export interface ManagedPluginOutcome {
  readonly error: boolean;
  readonly text: string;
}

export interface ManagedPluginService {
  status(): ManagedPluginOutcome;
  inspect(request: ManagedPluginInspectRequest): Promise<ManagedPluginOutcome>;
  install(request: ManagedPluginInspectRequest, signal?: AbortSignal): Promise<ManagedPluginOutcome>;
  read(id: string, path?: string): ManagedPluginOutcome;
  control(command: string): string | Promise<string>;
  setInteractiveApproval(enabled: boolean): void;
  dispose(): void;
}

type ApprovalDecision = "once" | "deny" | "cancelled";

interface PendingApproval {
  readonly requestId: string;
  readonly candidate: ManagedPluginCandidate;
  readonly replace: boolean;
  readonly resolve: (decision: ApprovalDecision) => void;
  removeAbort?: () => void;
  settled: boolean;
}

export type ManagedPluginInspector = (request: ManagedPluginInspectRequest) => Promise<ManagedPluginCandidate>;
export type ManagedPluginPersister = (
  candidate: ManagedPluginCandidate,
  entries: Readonly<Record<string, ManagedPluginConfig>>,
  previous?: ManagedPluginConfig,
) => void;
export type ManagedPluginRemover = (
  id: string,
  entry: ManagedPluginConfig,
  entries: Readonly<Record<string, ManagedPluginConfig>>,
) => void;

export function createManagedPluginService(input: {
  readonly log: EventLog;
  readonly entries?: Readonly<Record<string, ManagedPluginConfig>>;
  readonly permissions?: PermissionController;
  readonly inspector?: ManagedPluginInspector;
  readonly persist?: ManagedPluginPersister;
  readonly remove?: ManagedPluginRemover;
  readonly readFile?: (id: string, entry: ManagedPluginConfig, path: string) => string;
}): ManagedPluginService {
  let entries: Record<string, ManagedPluginConfig>;
  try {
    entries = normalizeManagedPlugins(input.entries ?? {});
  } catch {
    entries = {};
  }
  const inspector = input.inspector ?? inspectManagedPlugin;
  const persist = input.persist ?? persistManagedPlugin;
  const remove = input.remove ?? removeManagedPlugin;
  const readFile = input.readFile ?? readManagedPluginFile;
  let interactive = false;
  let disposed = false;
  let pending: PendingApproval | undefined;
  let requestSequence = input.log.events.filter((event) => event.name === "managed_plugin/approval_requested").length;

  const resolvePending = (decision: ApprovalDecision, reason: string): void => {
    const current = pending;
    if (!current || current.settled) return;
    current.settled = true;
    current.removeAbort?.();
    pending = undefined;
    if (decision !== "cancelled") {
      input.log.append({
        kind: "effect",
        name: "managed_plugin/approval_decision",
        payload: approvalPayload(current, {
          decision: decision === "deny" ? "deny" : "approve",
          ...(decision === "once" ? { scope: "once" } : {}),
        }),
      });
    }
    input.log.append({
      kind: "observe",
      name: "managed_plugin/approval_resolved",
      payload: approvalPayload(current, {
        status: decision === "once" ? "approved" : decision,
        reason,
        ...(decision === "once" ? { scope: "once" } : {}),
      }),
    });
    current.resolve(decision);
  };

  const requestApproval = async (
    candidate: ManagedPluginCandidate,
    replace: boolean,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision | "not_interactive"> => {
    requestSequence += 1;
    const requestId = `managed-plugin-${requestSequence}`;
    const shape = { candidate, replace, requestId, resolve: () => {}, settled: false } satisfies PendingApproval;
    input.log.append({
      kind: "observe",
      name: "managed_plugin/approval_requested",
      payload: approvalPayload(shape),
    });
    if (!interactive) {
      if (!approvalRelayEnabled()) {
        input.log.append({
          kind: "observe",
          name: "managed_plugin/approval_resolved",
          payload: approvalPayload(shape, { status: "unavailable", reason: "not_interactive" }),
        });
        return "not_interactive";
      }
      // No operator here: park the request for `dokkabi approve` (approval-relay.ts).
      // An install is a one-time act, so a session answer counts as once.
      const outcome = await waitForOperatorDecision({
        logPath: input.log.path,
        kind: "plugin",
        requestId,
        summary: `${replace ? "replace" : "install"} ${candidate.id}`,
        ...(signal ? { signal } : {}),
      });
      const decision: ApprovalDecision | "not_interactive" = outcome === "once" || outcome === "session"
        ? "once"
        : outcome === "timeout" ? "not_interactive" : outcome;
      input.log.append({
        kind: "observe",
        name: "managed_plugin/approval_resolved",
        payload: approvalPayload(shape, decision === "once"
          ? { status: "approved", reason: "operator", scope: "once" }
          : decision === "deny"
            ? { status: "deny", reason: "operator" }
            : decision === "cancelled"
              ? { status: "cancelled", reason: "signal" }
              : { status: "unavailable", reason: "operator_timeout" }),
      });
      return decision;
    }
    if (pending) {
      input.log.append({
        kind: "observe",
        name: "managed_plugin/approval_resolved",
        payload: approvalPayload(shape, { status: "cancelled", reason: "request_already_waiting" }),
      });
      return Promise.resolve("cancelled");
    }
    if (signal?.aborted) {
      input.log.append({
        kind: "observe",
        name: "managed_plugin/approval_resolved",
        payload: approvalPayload(shape, { status: "cancelled", reason: "signal" }),
      });
      return Promise.resolve("cancelled");
    }
    return new Promise((resolveDecision) => {
      const next: PendingApproval = { candidate, replace, requestId, resolve: resolveDecision, settled: false };
      if (signal) {
        const onAbort = () => resolvePending("cancelled", "signal");
        signal.addEventListener("abort", onAbort, { once: true });
        next.removeAbort = () => signal.removeEventListener("abort", onAbort);
      }
      pending = next;
    });
  };

  const inspectCandidate = async (request: ManagedPluginInspectRequest): Promise<ManagedPluginCandidate> => {
    input.log.append({
      kind: "effect",
      name: "managed_plugin/inspect",
      payload: {
        repository: request.repository,
        ...(request.ref ? { ref: request.ref } : {}),
        ...(request.path ? { source_path: request.path } : {}),
        ...(request.id ? { requested_id: request.id } : {}),
        transport: "public_github_https",
      },
    });
    try {
      const candidate = await inspector(request);
      input.log.append({
        kind: "observe",
        name: "managed_plugin/inspect_result",
        payload: candidatePayload(candidate, { status: "compatible" }),
      });
      return candidate;
    } catch (error) {
      input.log.append({
        kind: "observe",
        name: "managed_plugin/inspect_result",
        payload: {
          repository: request.repository,
          status: "incompatible",
          reason: safeReason(error),
        },
      });
      throw error;
    }
  };

  const service: ManagedPluginService = {
    status() {
      const installed = Object.entries(entries).map(([id, entry]) => ({
        id,
        skill: entry.skill_name,
        repository: entry.repository,
        commit: entry.commit,
        source_path: entry.source_path,
        license: entry.license,
        digest: entry.digest,
        files: entry.files.length,
        bytes: entry.total_bytes,
        runtime: "none",
      }));
      return {
        error: false,
        text: installed.length === 0
          ? "No managed skill plugins are installed. Use plugin op=inspect or op=install for a public GitHub SKILL.md bundle."
          : JSON.stringify({ installed, execution: "inert_skill_content_only" }),
      };
    },
    async inspect(request) {
      if (disposed) return refused("service_disposed");
      try {
        const candidate = await inspectCandidate(request);
        return { error: false, text: JSON.stringify(publicCandidate(candidate)) };
      } catch (error) {
        return { error: true, text: `Managed plugin inspection failed: ${safeReason(error)}.` };
      }
    },
    async install(request, signal) {
      if (disposed) return refused("service_disposed");
      let candidate: ManagedPluginCandidate;
      try {
        candidate = await inspectCandidate(request);
      } catch (error) {
        return { error: true, text: `Managed plugin installation refused: ${safeReason(error)}.` };
      }
      const current = entries[candidate.id];
      if (current?.digest === candidate.digest) {
        return service.read(candidate.id);
      }
      if (input.permissions?.current() === "bypass") {
        return {
          error: true,
          text: `Managed plugin ${candidate.id} needs explicit installation approval in live ask mode; bypass cannot persist external instructions.`,
        };
      }
      const approval = await requestApproval(candidate, current !== undefined, signal);
      if (approval === "not_interactive") return refused("interactive_approval_unavailable");
      if (approval === "deny") return refused("operator_denied");
      if (approval === "cancelled") return refused("approval_cancelled");
      if (candidateDigest(candidate) !== candidate.digest) return refused("candidate_changed_after_approval");
      const next = normalizeManagedPlugins({ ...entries, [candidate.id]: configFromCandidate(candidate) });
      input.log.append({
        kind: "effect",
        name: "managed_plugin/install",
        payload: candidatePayload(candidate, { replace: current !== undefined }),
      });
      try {
        persist(candidate, next, current);
      } catch {
        input.log.append({
          kind: "observe",
          name: "managed_plugin/install_result",
          payload: candidatePayload(candidate, { status: "failed" }),
        });
        return { error: true, text: `Managed plugin ${candidate.id} could not be persisted; installation is unchanged.` };
      }
      entries = next;
      input.log.append({
        kind: "observe",
        name: "managed_plugin/install_result",
        payload: candidatePayload(candidate, { status: "completed" }),
      });
      return { error: false, text: installedSkillText(candidate) };
    },
    read(id, path = "SKILL.md") {
      if (disposed) return refused("service_disposed");
      if (!PLUGIN_ID.test(id)) return refused("invalid_plugin_id");
      let requested: string;
      try {
        requested = normalizeRelativePath(path, "managed plugin read path");
      } catch {
        return refused("invalid_read_path");
      }
      const entry = entries[id];
      if (!entry) return refused(`plugin_not_installed:${id}`);
      const metadata = entry.files.find((file) => file.path === requested);
      if (!metadata) {
        return {
          error: true,
          text: `Managed plugin ${id} has no file ${requested}. Available: ${entry.files.map((file) => file.path).join(", ")}`,
        };
      }
      input.log.append({
        kind: "effect",
        name: "managed_plugin/read",
        payload: { id, path: requested, package_digest: entry.digest, file_digest: metadata.digest },
      });
      try {
        const body = readFile(id, entry, requested);
        input.log.append({
          kind: "observe",
          name: "managed_plugin/read_result",
          payload: { id, path: requested, status: "completed", file_digest: metadata.digest, bytes: metadata.bytes },
        });
        return {
          error: false,
          text: `MANAGED PLUGIN ${id} · ${entry.repository}@${entry.commit}\nUNTRUSTED INERT FILE ${requested}\nReferences are not workspace paths; load them with plugin op=read.\n\n${body}`,
        };
      } catch {
        input.log.append({
          kind: "observe",
          name: "managed_plugin/read_result",
          payload: { id, path: requested, status: "failed", file_digest: metadata.digest },
        });
        return { error: true, text: `Managed plugin ${id}/${requested} failed integrity verification.` };
      }
    },
    async control(command) {
      const text = command.trim();
      const normalized = text.toLowerCase();
      if (!text || normalized === "status") {
        const waiting = pending ? pending.candidate.id : "idle";
        const installed = Object.keys(entries).sort().join(",") || "none";
        return `plugin approval=${waiting} installed=${installed} mode=inert-skills — /plugin remove ID`;
      }
      if (normalized === "approve once") {
        if (!pending) throw new Error("no managed plugin approval is waiting");
        resolvePending("once", "operator");
        return "Managed skill installation approved; the pending request is continuing";
      }
      if (normalized === "deny") {
        if (!pending) throw new Error("no managed plugin approval is waiting");
        resolvePending("deny", "operator");
        return "Managed skill installation denied; no package was persisted";
      }
      const match = /^remove ([a-z][a-z0-9._-]{0,127})$/u.exec(text);
      if (match) {
        const id = match[1]!;
        const entry = entries[id];
        if (!entry) return `Managed plugin ${id} is not installed`;
        const next = normalizeManagedPlugins(Object.fromEntries(Object.entries(entries).filter(([key]) => key !== id)));
        input.log.append({
          kind: "effect",
          name: "managed_plugin/remove",
          payload: { id, repository: entry.repository, commit: entry.commit, package_digest: entry.digest },
        });
        try {
          remove(id, entry, next);
        } catch {
          input.log.append({
            kind: "observe",
            name: "managed_plugin/remove_result",
            payload: { id, status: "failed", package_digest: entry.digest },
          });
          throw new Error(`Managed plugin ${id} removal failed; installed authority is unchanged`);
        }
        entries = next;
        input.log.append({
          kind: "observe",
          name: "managed_plugin/remove_result",
          payload: { id, status: "completed", package_digest: entry.digest },
        });
        return `Managed plugin ${id} removed`;
      }
      throw new Error("usage: /plugin [status|approve once|deny|remove ID]");
    },
    setInteractiveApproval(enabled) {
      interactive = enabled;
      if (!enabled) resolvePending("cancelled", "interactive_disabled");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      removePermissionListener?.();
      resolvePending("cancelled", "service_disposed");
    },
  };

  const removePermissionListener = input.permissions?.onChange((mode) => {
    if (mode === "bypass") resolvePending("cancelled", "permission_mode");
  });
  return service;
}

export function persistManagedPlugin(
  candidate: ManagedPluginCandidate,
  entries: Readonly<Record<string, ManagedPluginConfig>>,
  previous?: ManagedPluginConfig,
): void {
  if (candidateDigest(candidate) !== candidate.digest || !DIGEST.test(candidate.digest)) {
    throw new Error("managed plugin candidate digest changed");
  }
  const root = managedPluginStoreRoot();
  const idRoot = join(root, candidate.id);
  const destination = join(idRoot, candidate.digest);
  mkdirSync(idRoot, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  chmodSync(idRoot, 0o700);
  let created = false;
  if (!existsSync(destination)) {
    const temporary = join(idRoot, `.install-${randomUUID()}`);
    mkdirSync(temporary, { mode: 0o700 });
    try {
      for (const file of candidate.files) {
        const target = confinedManagedPath(temporary, file.path);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        writeFileSync(target, file.body, { mode: 0o600, flag: "wx" });
      }
      writeFileSync(join(temporary, ".dokkabi-package.json"), `${JSON.stringify({
        format: 1,
        id: candidate.id,
        repository: candidate.repository,
        commit: candidate.commit,
        source_path: candidate.sourcePath,
        license: candidate.license,
        digest: candidate.digest,
      }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      verifyCandidateDirectory(temporary, candidate);
      renameSync(temporary, destination);
      created = true;
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  } else {
    verifyCandidateDirectory(destination, candidate);
  }
  try {
    updateManagedPlugins(entries);
  } catch (error) {
    if (created) rmSync(destination, { recursive: true, force: true });
    throw error;
  }
  if (previous && previous.digest !== candidate.digest) {
    const old = join(idRoot, previous.digest);
    if (existsSync(old)) rmSync(old, { recursive: true, force: true });
  }
}

export function removeManagedPlugin(
  id: string,
  entry: ManagedPluginConfig,
  entries: Readonly<Record<string, ManagedPluginConfig>>,
): void {
  if (!PLUGIN_ID.test(id) || !DIGEST.test(entry.digest)) throw new Error("invalid managed plugin removal target");
  const idRoot = join(managedPluginStoreRoot(), id);
  const destination = join(idRoot, entry.digest);
  const quarantine = join(idRoot, `.remove-${randomUUID()}`);
  let moved = false;
  if (existsSync(destination)) {
    renameSync(destination, quarantine);
    moved = true;
  }
  try {
    updateManagedPlugins(entries);
  } catch (error) {
    if (moved) renameSync(quarantine, destination);
    throw error;
  }
  if (moved) rmSync(quarantine, { recursive: true, force: true });
  try {
    rmdirSync(idRoot);
  } catch {
    // Older content-addressed versions may share the validated id directory.
  }
}

export function readManagedPluginFile(id: string, entry: ManagedPluginConfig, path: string): string {
  if (!PLUGIN_ID.test(id) || !DIGEST.test(entry.digest)) throw new Error("invalid managed plugin read target");
  const metadata = entry.files.find((file) => file.path === path);
  if (!metadata) throw new Error("managed plugin file is not registered");
  const root = realpathSync(join(managedPluginStoreRoot(), id, entry.digest));
  const target = realpathSync(confinedManagedPath(root, path));
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error("managed plugin file escaped its package");
  }
  if (!lstatSync(target).isFile()) throw new Error("managed plugin file is not regular");
  const body = readFileSync(target, "utf8");
  if (Buffer.byteLength(body) !== metadata.bytes || sha256(body) !== metadata.digest) {
    throw new Error("managed plugin file integrity mismatch");
  }
  return body;
}

function managedPluginStoreRoot(): string {
  const root = join(dokkabiHome(), "managed-plugins");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function confinedManagedPath(root: string, path: string): string {
  const normalized = normalizeRelativePath(path, "managed plugin storage path");
  const target = resolve(root, normalized);
  const rel = relative(resolve(root), target);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error("managed plugin storage path escaped its root");
  }
  return target;
}

function verifyCandidateDirectory(root: string, candidate: ManagedPluginCandidate): void {
  for (const file of candidate.files) {
    const target = confinedManagedPath(root, file.path);
    if (!existsSync(target) || !lstatSync(target).isFile()) throw new Error("managed plugin file is missing after write");
    const body = readFileSync(target, "utf8");
    if (Buffer.byteLength(body) !== file.bytes || sha256(body) !== file.digest) {
      throw new Error("managed plugin file changed during persistence");
    }
  }
}

function configFromCandidate(candidate: ManagedPluginCandidate): ManagedPluginConfig {
  return {
    format: 1,
    skill_name: candidate.skillName,
    repository: candidate.repository,
    commit: candidate.commit,
    source_path: candidate.sourcePath,
    license: candidate.license,
    digest: candidate.digest,
    total_bytes: candidate.totalBytes,
    files: candidate.files.map((file) => ({ path: file.path, digest: file.digest, bytes: file.bytes })),
  };
}

function approvalPayload(pending: PendingApproval, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: pending.requestId,
    ...candidatePayload(pending.candidate, { replace: pending.replace }),
    content_kind: "inert_skill_bundle",
    runtime: "none",
    host_execution: false,
    persistence: "private_content_addressed_store",
    ...extra,
  };
}

function candidatePayload(candidate: ManagedPluginCandidate, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: candidate.id,
    skill_name: candidate.skillName,
    repository: candidate.repository,
    commit: candidate.commit,
    source_path: candidate.sourcePath,
    license: candidate.license,
    package_digest: candidate.digest,
    file_count: candidate.files.length,
    total_bytes: candidate.totalBytes,
    reference_count: candidate.references.length,
    ...extra,
  };
}

function publicCandidate(candidate: ManagedPluginCandidate): Record<string, unknown> {
  return {
    ...candidatePayload(candidate),
    description: candidate.description,
    files: candidate.files.map((file) => file.path),
    referenced_files: candidate.references,
    install_effect: "inert instructions and references only; no hooks, commands, agents, MCP servers, or runtime modules execute",
  };
}

function installedSkillText(candidate: ManagedPluginCandidate): string {
  const skill = candidate.files.find((file) => file.path === "SKILL.md");
  if (!skill) throw new Error("installed candidate lost SKILL.md");
  return [
    `MANAGED PLUGIN INSTALLED ${candidate.id} · ${candidate.repository}@${candidate.commit}`,
    `license=${candidate.license} digest=${candidate.digest} files=${candidate.files.length} bytes=${candidate.totalBytes}`,
    "UNTRUSTED INERT SKILL BODY",
    "References are not workspace paths; load them with plugin op=read using this installed id.",
    "",
    skill.body,
  ].join("\n");
}

function safeReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const safe = message.replaceAll(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return safe.slice(0, 240) || "unclassified_failure";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function refused(reason: string): ManagedPluginOutcome {
  return { error: true, text: `Managed plugin refused: ${reason}.` };
}
