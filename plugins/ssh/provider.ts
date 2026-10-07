import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { createSshService, SSH_BATCH_LIMIT, type SshService } from "../../src/host/ssh.ts";
import { remoteWorkspacesFromPlan } from "../../src/host/ssh-remote-diff.ts";
import { sshOpIntent, sshOpMismatch } from "../../src/host/ssh-op-guard.ts";
import type {
  HostContext,
  PluginModule,
  ToolContributionRegistry,
} from "../../src/loader/types.ts";
import type { PrerequisiteRegistry } from "../../src/prerequisite/registry.ts";
import { textToolResult } from "../../src/tools/model-result.ts";
import type { PermissionController } from "../../src/host/permissions.ts";
import { registerSshExactTool } from "./speculative.ts";

const SshParameters = Type.Object({
  op: Type.Union([
    Type.Literal("status"),
    Type.Literal("exec"),
    Type.Literal("wait"),
    Type.Literal("put"),
    Type.Literal("get"),
    Type.Literal("copy"),
    Type.Literal("sync"),
    Type.Literal("enroll"),
  ]),
  alias: Type.Optional(Type.String({
    description: "op=enroll: the letter-led alias name to register for the address",
  })),
  address: Type.Optional(Type.String({
    description: "op=enroll: the operator's [user@]host[:port] to register under the alias; the operator confirms it in an approval popup and it is written to their ssh config, never to the log",
  })),
  target: Type.Optional(Type.String({
    description: "Operator-owned logical SSH Host alias; never an address, account, or user@host value",
  })),
  command: Type.Optional(Type.String({
    description: "Bounded non-interactive remote command; credentials are forbidden",
  })),
  script: Type.Optional(Type.String({
    description: "Multiline script delivered verbatim to the remote command's stdin (default interpreter: bash -s). Use this instead of quoting heredocs into command or encoding content into workspace files",
  })),
  probe: Type.Optional(Type.String({
    description: "op=wait: bounded remote command re-run on each poll; its stdout is tested against until",
  })),
  until: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 512,
    description: "op=wait: JavaScript regular expression matched against probe stdout",
  })),
  pid: Type.Optional(Type.Number({
    minimum: 1,
    description: "op=wait: pid of the background job being watched, as printed when you launched it. Give it whenever you are waiting on a job you started: each poll then also reports whether that process is still alive, and the wait ends the moment it exits instead of polling a finished job until the deadline",
  })),
  interval_ms: Type.Optional(Type.Number({ minimum: 10, maximum: 60_000, description: "op=wait: milliseconds between polls; defaults to 5000" })),
  deadline_ms: Type.Optional(Type.Number({ minimum: 1, maximum: 86_400_000, description: "op=wait: total monotonic deadline in milliseconds" })),
  local: Type.Optional(Type.String({
    description: "op=put/get/sync: workspace-relative path (never absolute, never escaping the workspace)",
  })),
  remote: Type.Optional(Type.String({
    description: "op=put/get/sync: path on the remote host",
  })),
  source_target: Type.Optional(Type.String({ description: "op=copy: source Host alias" })),
  source_remote: Type.Optional(Type.String({ description: "op=copy: source path on the source host" })),
  dest_target: Type.Optional(Type.String({ description: "op=copy: destination Host alias" })),
  dest_remote: Type.Optional(Type.String({ description: "op=copy: destination path on the destination host" })),
  recursive: Type.Optional(Type.Boolean({ description: "op=put/get/copy: transfer a directory tree" })),
  direction: Type.Optional(Type.Union([Type.Literal("up"), Type.Literal("down")], {
    description: "op=sync: up = workspace→remote, down = remote→workspace",
  })),
  delete: Type.Optional(Type.Boolean({ description: "op=sync: mirror — remove destination entries missing from the source" })),
  // The transport ceiling, one hour (host/ssh.ts SSH_TIMEOUT_MAX_SECONDS).
  // A case that loads real weights declares its own budget and the host runs
  // it through this same path; a schema stuck at ten minutes refused those
  // before any remote process started.
  timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 3600 })),
}, { additionalProperties: false });

function createSshTool(service: SshService): AgentTool<typeof SshParameters> {
  const tool: AgentTool<typeof SshParameters> = {
    name: "ssh",
    label: "SSH",
    executionMode: "sequential",
    description: "Bounded remote work through sealed host OpenSSH, independent of sandbox PATH; no ssh binary in the sandbox is normal. Aliases resolve through operator-owned SSH configuration. CALL SHAPES — op=status: no other arguments. op=enroll: alias + address (registers an operator-given [user@]host as a Host alias; approval-gated, written to the operator ssh config, never logged) — this is the ONLY way to introduce a host you know only by address. op=exec: target + command (or script for multiline, delivered on stdin). op=wait: target + probe + until + deadline_ms, plus pid whenever you are watching a job you launched, so the wait ends when that process does. op=put/get: target + local + remote. op=copy: source_target + source_remote + dest_target + dest_remote. op=sync: target + local + remote + direction. Every op except enroll takes target as a logical Host alias — never an address, account, or user@host. Do not put a raw address in exec; enroll it first, then exec against the alias. In ask mode nothing runs until the TUI records approval; bypass skips only that prompt. Never substitute a sandbox remote shell, direct TCP, or an alternative SSH client, and never pass a key, password, or token.",
    parameters: SshParameters,
    async execute(_toolCallId, params, signal) {
      // Refuse an op that carries the wrong arguments, so a mis-filled op
      // (op=status with a command — the live silent-swallow bug) is reported
      // instead of quietly dropping the command.
      // When the arguments name exactly one op, the intent is not a guess:
      // run it and say so, rather than spending a round trip refusing. Live,
      // one run sent op=status with target+command 35 times.
      const intended = sshOpIntent(params as Record<string, unknown>);
      let correction = "";
      if (intended) {
        correction = `[ssh] you sent op=${String(params.op)} with ${intended} arguments; ran it as op=${intended}. Send op=${intended} next time.\n`;
        params = { ...params, op: intended } as typeof params;
      }
      const mismatch = sshOpMismatch(params as Record<string, unknown>);
      if (mismatch) return textToolResult(mismatch, true);
      const note = (result: { text: string; error: boolean }) =>
        textToolResult(`${correction}${result.text}`, result.error);
      if (params.op === "status") return textToolResult(service.control("status"));
      if (params.op === "enroll") {
        if (!params.alias || !params.address) {
          return textToolResult("ssh enroll requires alias and address (the operator's [user@]host to register)", true);
        }
        const result = await service.enroll({ alias: params.alias, address: params.address }, signal);
        return note(result);
      }
      if (params.op === "wait") {
        if (!params.target || !params.probe || !params.until || params.deadline_ms === undefined) {
          return textToolResult("ssh wait requires target, probe, until, and deadline_ms", true);
        }
        const result = await service.waitFor({
          target: params.target,
          probe: params.probe,
          until: params.until,
          ...(params.interval_ms === undefined ? {} : { interval: params.interval_ms }),
          ...(params.pid === undefined ? {} : { pid: params.pid }),
          deadline: params.deadline_ms,
        }, signal);
        return note(result);
      }
      if (params.op === "put" || params.op === "get") {
        if (!params.target || !params.local || !params.remote) {
          return textToolResult(`ssh ${params.op} requires target, local, and remote`, true);
        }
        const result = await service.transfer({
          op: params.op,
          target: params.target,
          local: params.local,
          remote: params.remote,
          ...(params.recursive === undefined ? {} : { recursive: params.recursive }),
          ...(params.timeout === undefined ? {} : { timeout: params.timeout }),
        }, signal);
        return note(result);
      }
      if (params.op === "copy") {
        if (!params.source_target || !params.source_remote || !params.dest_target || !params.dest_remote) {
          return textToolResult("ssh copy requires source_target, source_remote, dest_target, and dest_remote", true);
        }
        const result = await service.transfer({
          op: "copy",
          source_target: params.source_target,
          source_remote: params.source_remote,
          dest_target: params.dest_target,
          dest_remote: params.dest_remote,
          ...(params.recursive === undefined ? {} : { recursive: params.recursive }),
          ...(params.timeout === undefined ? {} : { timeout: params.timeout }),
        }, signal);
        return note(result);
      }
      if (params.op === "sync") {
        if (!params.target || !params.local || !params.remote || !params.direction) {
          return textToolResult("ssh sync requires target, local, remote, and direction", true);
        }
        const result = await service.transfer({
          op: "sync",
          target: params.target,
          local: params.local,
          remote: params.remote,
          direction: params.direction,
          ...(params.delete === undefined ? {} : { delete: params.delete }),
          ...(params.timeout === undefined ? {} : { timeout: params.timeout }),
        }, signal);
        return note(result);
      }
      if (!params.target || (!params.command && !params.script)) {
        return textToolResult("ssh exec requires target and either command or script", true);
      }
      const result = await service.execute({
        target: params.target,
        command: params.command ?? "",
        ...(params.script === undefined ? {} : { script: params.script }),
        ...(params.timeout === undefined ? {} : { timeout: params.timeout }),
      }, signal);
      return note(result);
    },
  };
  registerSshExactTool(tool, service);
  return tool;
}

const SshProbeParameters = Type.Object({
  probes: Type.Array(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$", description: "Stable result id" }),
    target: Type.String({ description: "Operator-owned logical SSH Host alias; never an address or user@host" }),
    command: Type.Optional(Type.String({ description: "Bounded non-interactive remote command" })),
    script: Type.Optional(Type.String({ description: "Multiline script delivered verbatim on stdin (default interpreter: bash -s)" })),
    timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 600, description: "Per-probe timeout in seconds" })),
  }, { additionalProperties: false }), { minItems: 1, maxItems: SSH_BATCH_LIMIT }),
  parallel: Type.Optional(Type.Boolean({ description: "Run the probes concurrently; defaults to true" })),
}, { additionalProperties: false });

function createSshProbeTool(service: SshService): AgentTool<typeof SshProbeParameters> {
  return {
    name: "ssh_probe",
    label: "SSH probe",
    description:
      `Run up to ${SSH_BATCH_LIMIT} independent remote commands in ONE tool call and return them keyed by id. `
      + "Commands run in parallel by default; they may address different hosts in the same call. "
      + "Use this whenever you want more than one piece of remote state — read a config and list a directory and check a log — "
      + "instead of spending a separate turn on each: the turn, not the connection, is what those questions cost. "
      + "Every command still faces the same alias check, approval, and sealed transport as op=exec, so this asks several "
      + "questions at once and never one that would be refused alone. "
      + "Use plain ssh op=exec for a single command, for anything whose result decides what you run next, and for writes "
      + "that must not interleave.",
    parameters: SshProbeParameters,
    async execute(_toolCallId, params, signal) {
      const result = await service.batch({
        probes: params.probes,
        ...(params.parallel === undefined ? {} : { parallel: params.parallel }),
      }, signal);
      return textToolResult(result.text, result.error);
    },
  };
}

export const plugin: PluginModule = {
  id: "ssh",
  claims: [
    { key: "ssh", role: "definition" },
    { key: "ssh", role: "provider" },
    { key: "tool_contributions", role: "consumer", modelFacing: true },
    { key: "prerequisites", role: "consumer", optional: true },
    // Host-root capabilities are not plugin fibers, so this claim is optional
    // for lifecycle ordering while still authorizing the scoped lookup.
    { key: "permissions", role: "consumer", optional: true },
  ],
  activate() {
    const swarmChild = process.env.DOKKABI_PARENT_SESSION !== undefined
      || process.env.DOKKABI_SWARM_ROLE !== undefined;
    return swarmChild
      ? { active: false, reason: "operator-approved SSH is unavailable to private swarm children", kind: "unavailable" }
      : { active: true };
  },
  register(ctx: HostContext) {
    const prerequisites = ctx.tryGet<PrerequisiteRegistry>("prerequisites");
    const permissions = ctx.tryGet<PermissionController>("permissions");
    const removePrerequisite = prerequisites?.register("ssh_access", "ssh");
    if (removePrerequisite) ctx.effect(() => removePrerequisite);
    // A work plan's host-bound cases already say where the remote code lives;
    // that turns on the remote diff probe for those hosts, so a change made
    // over ssh is as visible as a local edit.
    const remoteWorkspaces = readRemoteWorkspaces(ctx.workspaceRoot);
    const service = createSshService({
      log: ctx.log,
      workspaceRoot: ctx.workspaceRoot,
      ...(permissions ? { permissions } : {}),
      ...(prerequisites ? { prerequisites } : {}),
      ...(Object.keys(remoteWorkspaces).length > 0 ? { remoteWorkspaces } : {}),
    });
    const tools = ctx.get<ToolContributionRegistry<AgentTool>>("tool_contributions");
    ctx.define("ssh", { authority: "operator_approval", transport: "host_openssh" });
    ctx.provide("ssh", service);
    ctx.effect(() => tools.register("ssh", createSshTool(service)));
    ctx.effect(() => tools.register("ssh_probe", createSshProbeTool(service)));
    ctx.effect(() => () => service.dispose());
  },
};

/** Read alias→remote workspace from the workspace's current work plan. A
 * missing or malformed plan simply arms no probe. */
function readRemoteWorkspaces(workspaceRoot: string): Record<string, string> {
  try {
    const path = joinPath(workspaceRoot, "work", "current.json");
    if (!existsSync(path)) return {};
    return remoteWorkspacesFromPlan(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}
