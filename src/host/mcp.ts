import { createHash } from "node:crypto";
import type { McpStdioServerConfig } from "./config.ts";
import { normalizeMcpServers } from "./config.ts";
import type { EventLog } from "./event-log.ts";
import {
  connectMcpStdio,
  resolveMcpExecutable,
  type McpConnection,
  type McpConnector,
  type McpToolCallResult,
  type McpToolDefinition,
  type ResolvedMcpExecutable,
} from "./mcp-stdio.ts";
import type { PermissionController } from "./permissions.ts";
import { approvalRelayEnabled, waitForOperatorDecision } from "./approval-relay.ts";
import {
  containsPrivateInfrastructureValue,
  containsSecretValue,
  redactText,
  stripTerminalControls,
  toolArgsCarryPrivateInfrastructure,
} from "./redact.ts";

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const MAX_ARGUMENT_BYTES = 16 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;

export interface McpEnrollRequest {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: readonly string[];
}

export interface McpCallRequest {
  readonly server: string;
  readonly tool: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
}

export interface McpOutcome {
  readonly error: boolean;
  readonly text: string;
  /** The service's own 64 KB cut discarded the rest (#223: recorded as
   * `producer_truncated`, never as complete). */
  readonly truncated?: true;
}

export interface McpService {
  control(command: string): string | Promise<string>;
  enroll(request: McpEnrollRequest, signal?: AbortSignal): Promise<McpOutcome>;
  status(): McpOutcome;
  tools(server?: string): Promise<McpOutcome>;
  call(request: McpCallRequest, signal?: AbortSignal): Promise<McpOutcome>;
  setInteractiveApproval(enabled: boolean): void;
  dispose(): Promise<void>;
}

type ApprovalDecision = "once" | "session" | "deny" | "cancelled" | "bypass";

interface PendingApproval {
  readonly operation: "server_enroll" | "tool_call";
  readonly requestId: string;
  readonly server: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: readonly string[];
  readonly executableDigest?: string;
  readonly replace?: boolean;
  readonly tool?: string;
  readonly argumentDigest?: string;
  readonly resolve: (decision: ApprovalDecision) => void;
  removeAbort?: () => void;
  settled: boolean;
}

type McpExecutableResolver = (command: string) => ResolvedMcpExecutable;

export function createMcpService(input: {
  readonly log: EventLog;
  readonly servers?: Readonly<Record<string, McpStdioServerConfig>>;
  readonly permissions?: PermissionController;
  readonly saveServers?: (servers: Readonly<Record<string, McpStdioServerConfig>>) => void;
  readonly connector?: McpConnector;
  readonly resolveExecutable?: McpExecutableResolver;
  readonly env?: NodeJS.Dict<string>;
}): McpService {
  let configured: Record<string, McpStdioServerConfig>;
  try {
    configured = normalizeMcpServers(input.servers ?? {});
  } catch {
    configured = {};
  }
  const connections = new Map<string, Promise<McpConnection>>();
  const sessionTools = new Set<string>();
  const connector = input.connector ?? connectMcpStdio;
  const resolveExecutable = input.resolveExecutable ?? resolveMcpExecutable;
  let requestSequence = 0;
  let pending: PendingApproval | undefined;
  let interactive = false;
  let disposed = false;

  const resolvePending = (decision: ApprovalDecision, reason: string): void => {
    const current = pending;
    if (!current || current.settled) return;
    current.settled = true;
    current.removeAbort?.();
    pending = undefined;
    if (decision !== "cancelled") {
      input.log.append({
        kind: "effect",
        name: "mcp/approval_decision",
        payload: approvalPayload(current, {
          decision: decision === "deny" ? "deny" : "approve",
          ...(decision === "once" || decision === "session" || decision === "bypass"
            ? { scope: decision }
            : {}),
        }),
      });
    }
    input.log.append({
      kind: "observe",
      name: "mcp/approval_resolved",
      payload: approvalPayload(current, {
        status: decision === "once" || decision === "session" || decision === "bypass"
          ? "approved"
          : decision,
        reason,
        ...(decision === "once" || decision === "session" || decision === "bypass"
          ? { scope: decision }
          : {}),
      }),
    });
    current.resolve(decision);
  };

  const requestApproval = async (
    details: Omit<PendingApproval, "requestId" | "resolve" | "settled" | "removeAbort">,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision | "not_interactive"> => {
    if (details.operation === "tool_call" && input.permissions?.current() === "bypass") {
      return "bypass";
    }
    requestSequence += 1;
    const requestId = `mcp-${requestSequence}`;
    const eventShape = { ...details, requestId, resolve: () => {}, settled: false } as PendingApproval;
    input.log.append({
      kind: "observe",
      name: "mcp/approval_requested",
      payload: approvalPayload(eventShape),
    });
    if (!interactive) {
      if (!approvalRelayEnabled()) {
        input.log.append({
          kind: "observe",
          name: "mcp/approval_resolved",
          payload: approvalPayload(eventShape, { status: "unavailable", reason: "not_interactive" }),
        });
        return "not_interactive";
      }
      // No operator here: park the request for `dokkabi approve` (approval-relay.ts).
      const outcome = await waitForOperatorDecision({
        logPath: input.log.path,
        kind: "mcp",
        requestId,
        summary: `${details.operation} ${details.server}${"tool" in details && typeof details.tool === "string" ? ` ${details.tool}` : ""}`,
        ...(signal ? { signal } : {}),
      });
      input.log.append({
        kind: "observe",
        name: "mcp/approval_resolved",
        payload: approvalPayload(eventShape, outcome === "once" || outcome === "session"
          ? { status: "approved", reason: "operator", scope: outcome }
          : outcome === "deny"
            ? { status: "deny", reason: "operator" }
            : outcome === "cancelled"
              ? { status: "cancelled", reason: "signal" }
              : { status: "unavailable", reason: "operator_timeout" }),
      });
      return outcome === "timeout" ? "not_interactive" : outcome;
    }
    if (pending) {
      input.log.append({
        kind: "observe",
        name: "mcp/approval_resolved",
        payload: approvalPayload(eventShape, { status: "cancelled", reason: "request_already_waiting" }),
      });
      return Promise.resolve("cancelled");
    }
    if (signal?.aborted) {
      input.log.append({
        kind: "observe",
        name: "mcp/approval_resolved",
        payload: approvalPayload(eventShape, { status: "cancelled", reason: "signal" }),
      });
      return Promise.resolve("cancelled");
    }
    return new Promise((resolve) => {
      const next: PendingApproval = { ...details, requestId, resolve, settled: false };
      if (signal) {
        const onAbort = () => resolvePending("cancelled", "signal");
        signal.addEventListener("abort", onAbort, { once: true });
        next.removeAbort = () => signal.removeEventListener("abort", onAbort);
      }
      pending = next;
    });
  };

  const removePermissionListener = input.permissions?.onChange((mode) => {
    if (mode !== "bypass") return;
    resolvePending(pending?.operation === "server_enroll" ? "cancelled" : "bypass", "permission_mode");
  });

  const serverNames = (): string[] => Object.keys(configured).sort((left, right) => left.localeCompare(right, "en"));

  const saveServerSet = async (
    action: "allow" | "remove",
    server: string,
    next: Record<string, McpStdioServerConfig>,
  ): Promise<boolean> => {
    if (!input.saveServers) return false;
    input.log.append({
      kind: "effect",
      name: "mcp/server_change",
      payload: { action, server, transport: "stdio" },
    });
    try {
      input.saveServers(next);
    } catch {
      input.log.append({
        kind: "observe",
        name: "mcp/server_change_result",
        payload: { action, server, status: "failed", transport: "stdio" },
      });
      return false;
    }
    configured = normalizeMcpServers(next);
    // A server name is not executable identity. Replacement and removal
    // revoke grants before any new connection can inherit them.
    for (const key of [...sessionTools]) {
      if (key.startsWith(`${server}\0`)) sessionTools.delete(key);
    }
    input.log.append({
      kind: "observe",
      name: "mcp/server_change_result",
      payload: { action, server, status: "completed", transport: "stdio" },
    });
    if (action === "remove") await closeConnection(server);
    return true;
  };

  const closeConnection = async (server: string): Promise<void> => {
    const connection = connections.get(server);
    connections.delete(server);
    if (!connection) return;
    try {
      await (await connection).close();
    } catch {
      // Revocation and disposal remain best-effort process cleanup.
    }
  };

  const getConnection = async (server: string): Promise<McpConnection> => {
    const config = configured[server];
    if (!config) throw new Error(`MCP server is not enrolled: ${server}`);
    const existing = connections.get(server);
    if (existing) return existing;
    const hostEnv = input.env ?? process.env;
    const missingEnv = config.env.filter((name) => !hostEnv[name]);
    if (missingEnv.length > 0) {
      throw new Error(`MCP server ${server} needs host environment: ${missingEnv.join(", ")}; set it before starting Dokkabi`);
    }
    const executable = resolveExecutable(config.command);
    if (executable.digest !== config.executable_digest) {
      throw new Error(`MCP executable changed for ${server}; enroll it again`);
    }
    input.log.append({
      kind: "effect",
      name: "mcp/connect",
      payload: {
        server,
        transport: "stdio",
        executable_digest: executable.digest,
        argument_digest: digestJson(config.args),
        env_names: config.env,
        filesystem: "isolated_empty",
        network: "sandbox_policy",
      },
    });
    const connecting = connector({
      name: server,
      config,
      executable,
      ...(input.env ? { env: input.env } : {}),
      log: input.log,
    });
    connections.set(server, connecting);
    try {
      const connection = await connecting;
      input.log.append({
        kind: "observe",
        name: "mcp/connect_result",
        payload: {
          server,
          status: "connected",
          transport: "stdio",
          ...(connection.serverInfo
            ? { server_name: safePublic(connection.serverInfo.name), server_version: safePublic(connection.serverInfo.version) }
            : {}),
        },
      });
      return connection;
    } catch {
      connections.delete(server);
      input.log.append({
        kind: "observe",
        name: "mcp/connect_result",
        payload: { server, status: "failed", transport: "stdio" },
      });
      throw new Error(`MCP server ${server} failed to connect in its isolated sandbox`);
    }
  };

  const listTools = async (server: string): Promise<readonly McpToolDefinition[]> => {
    const connection = await getConnection(server);
    input.log.append({ kind: "effect", name: "mcp/tools_list", payload: { server } });
    try {
      const tools = await connection.listTools();
      const safe = tools.map(validateToolDefinition);
      input.log.append({
        kind: "observe",
        name: "mcp/tools_list_result",
        payload: {
          server,
          status: "completed",
          count: safe.length,
          tool_names: safe.map((tool) => tool.name),
          schema_digest: digestJson(safe.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema }))),
        },
      });
      return safe;
    } catch {
      input.log.append({
        kind: "observe",
        name: "mcp/tools_list_result",
        payload: { server, status: "failed" },
      });
      throw new Error(`MCP server ${server} tool discovery failed`);
    }
  };

  const service: McpService = {
    async control(command) {
      const text = command.trim();
      const normalized = text.toLowerCase();
      if (!text || normalized === "status") {
        const approval = pending ? `${pending.operation}:${pending.server}` : "idle";
        const servers = serverNames().join(",") || "none";
        return `mcp approval=${approval} servers=${servers} transport=stdio isolation=empty-sandbox — /mcp remove NAME`;
      }
      if (normalized === "approve once") {
        if (!pending) throw new Error("no MCP approval is waiting");
        const operation = pending.operation;
        resolvePending("once", "operator");
        return operation === "server_enroll"
          ? "MCP server enrollment approved; the pending request is continuing"
          : "MCP tool call approved once; the pending request is continuing";
      }
      if (normalized === "approve session") {
        if (!pending) throw new Error("no MCP approval is waiting");
        if (pending.operation !== "tool_call") throw new Error("persistent MCP enrollment uses approve once");
        resolvePending("session", "operator");
        return "MCP tool approved for this server and chat session; the pending request is continuing";
      }
      if (normalized === "deny") {
        if (!pending) throw new Error("no MCP approval is waiting");
        resolvePending("deny", "operator");
        return "MCP request denied; no pending external action was started";
      }
      const remove = /^remove ([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/u.exec(text);
      if (remove) {
        const server = remove[1]!;
        if (!configured[server]) return `MCP server ${server} is not enrolled`;
        const next = { ...configured };
        delete next[server];
        if (!await saveServerSet("remove", server, next)) {
          throw new Error(`MCP server ${server} removal failed; live authority is unchanged`);
        }
        for (const key of [...sessionTools]) {
          if (key.startsWith(`${server}\0`)) sessionTools.delete(key);
        }
        return `MCP server ${server} removed and disconnected`;
      }
      throw new Error("usage: /mcp [status|approve once|approve session|deny|remove NAME]");
    },
    async enroll(request, signal) {
      if (disposed) return refused("service_disposed");
      if (!SERVER_NAME.test(request.name)) return refused("invalid_server_name");
      let executable: ResolvedMcpExecutable;
      try {
        executable = resolveExecutable(request.command);
      } catch {
        return refused("executable_unavailable_or_untrusted");
      }
      let nextConfig: McpStdioServerConfig;
      try {
        nextConfig = normalizeMcpServers({
          [request.name]: {
            transport: "stdio",
            command: request.command,
            args: [...(request.args ?? [])],
            env: [...(request.env ?? [])],
            executable_digest: executable.digest,
          },
        })[request.name]!;
      } catch (error) {
        return { error: true, text: error instanceof Error ? error.message : "MCP enrollment is invalid." };
      }
      const current = configured[request.name];
      if (current && digestJson(current) === digestJson(nextConfig)) {
        return service.tools(request.name);
      }
      if (!input.saveServers) return refused("server_policy_persistence_unavailable");
      if (input.permissions?.current() === "bypass" || !interactive) {
        return {
          error: true,
          text: `MCP server ${request.name} needs explicit persistent approval in live ask mode; bypass cannot enroll new external code.`,
        };
      }
      const approval = await requestApproval({
        operation: "server_enroll",
        server: request.name,
        command: nextConfig.command,
        args: nextConfig.args,
        env: nextConfig.env,
        executableDigest: nextConfig.executable_digest,
        replace: current !== undefined,
      }, signal);
      if (approval === "not_interactive") return refused("interactive_approval_unavailable");
      if (approval === "deny") return refused("operator_denied");
      if (approval === "cancelled") return refused("approval_cancelled");
      if (approval !== "once") return refused("persistent_enrollment_requires_explicit_approval");
      const next = { ...configured, [request.name]: nextConfig };
      if (!await saveServerSet("allow", request.name, next)) {
        return {
          error: true,
          text: `MCP server ${request.name} authorization could not be saved; no process was started.`,
        };
      }
      await closeConnection(request.name);
      return service.tools(request.name);
    },
    status() {
      const servers = serverNames().map((name) => ({
        name,
        connected: connections.has(name),
        command: configured[name]!.command,
        env: configured[name]!.env,
        credentialsReady: configured[name]!.env.every((key) => Boolean((input.env ?? process.env)[key])),
      }));
      return {
        error: false,
        text: servers.length === 0
          ? "No MCP servers are enrolled. Use mcp op=enroll with an exact stdio launch specification."
          : JSON.stringify({ servers, isolation: "empty-sandbox", transport: "stdio" }),
      };
    },
    async tools(server) {
      if (disposed) return refused("service_disposed");
      const names = server ? [server] : serverNames();
      if (names.length === 0) return service.status();
      const rows: Array<{ server: string; tools: readonly McpToolDefinition[] }> = [];
      try {
        for (const name of names) {
          if (!configured[name]) return refused(`server_not_enrolled:${name}`);
          rows.push({ server: name, tools: await listTools(name) });
        }
      } catch (error) {
        return { error: true, text: error instanceof Error ? error.message : "MCP tool discovery failed." };
      }
      return {
        error: false,
        text: `UNTRUSTED MCP TOOL METADATA\n${boundedResult(JSON.stringify(rows))}`,
      };
    },
    async call(request, signal) {
      if (disposed) return refused("service_disposed");
      if (!SERVER_NAME.test(request.server) || !configured[request.server]) return refused("server_not_enrolled");
      if (!TOOL_NAME.test(request.tool)) return refused("invalid_tool_name");
      const args = request.arguments ?? {};
      if (!plainObject(args) || containsSecretValue(args) || toolArgsCarryPrivateInfrastructure(args)) {
        return refused("arguments_secret_or_private_coordinate");
      }
      const argumentJson = JSON.stringify(args);
      if (Buffer.byteLength(argumentJson) > MAX_ARGUMENT_BYTES) return refused("arguments_too_large");
      const authorityDigest = digestJson(configured[request.server]);
      let tools: readonly McpToolDefinition[];
      try {
        tools = await listTools(request.server);
      } catch (error) {
        return { error: true, text: error instanceof Error ? error.message : "MCP tool discovery failed." };
      }
      if (!tools.some((tool) => tool.name === request.tool)) return refused("tool_not_exposed_by_server");
      if (!configured[request.server] || digestJson(configured[request.server]) !== authorityDigest) return refused("server_changed_during_discovery");
      const sessionKey = `${request.server}\0${authorityDigest}\0${request.tool}`;
      let approval: ApprovalDecision = "session";
      if (!sessionTools.has(sessionKey)) {
        const decision = await requestApproval({
          operation: "tool_call",
          server: request.server,
          tool: request.tool,
          argumentDigest: digestJson(args),
        }, signal);
        if (decision === "not_interactive") return refused("interactive_approval_unavailable");
        if (decision === "deny") return refused("operator_denied");
        if (decision === "cancelled") return refused("approval_cancelled");
        approval = decision;
        if (decision === "session") sessionTools.add(sessionKey);
      }
      if (!configured[request.server] || digestJson(configured[request.server]) !== authorityDigest) return refused("server_changed_during_approval");
      let connection: McpConnection;
      try { connection = await getConnection(request.server); }
      catch { return refused("server_connection_unavailable"); }
      if (!configured[request.server] || digestJson(configured[request.server]) !== authorityDigest) return refused("server_changed_during_approval");
      input.log.append({
        kind: "effect",
        name: "mcp/tool_call",
        payload: {
          server: request.server,
          tool: request.tool,
          argument_digest: digestJson(args),
          approval_scope: approval,
        },
      });
      let result: McpToolCallResult;
      try {
        result = await connection.callTool(request.tool, args);
      } catch {
        input.log.append({
          kind: "observe",
          name: "mcp/tool_call_result",
          payload: { server: request.server, tool: request.tool, status: "failed" },
        });
        return { error: true, text: `MCP tool ${request.server}/${request.tool} failed.` };
      }
      const text = formatToolResult(result);
      const withheld = containsSecretValue(text) || containsPrivateInfrastructureValue(text);
      input.log.append({
        kind: "observe",
        name: "mcp/tool_call_result",
        payload: {
          server: request.server,
          tool: request.tool,
          status: withheld ? "withheld" : result.isError ? "tool_error" : "completed",
          bytes: withheld ? 0 : Buffer.byteLength(text),
        },
      });
      return withheld
        ? { error: true, text: "MCP result was withheld because it matched the secret or private-coordinate guard." }
        : { error: result.isError, text: boundedResult(text), ...(Buffer.byteLength(text) > MAX_RESULT_BYTES ? { truncated: true as const } : {}) };
    },
    setInteractiveApproval(enabled) {
      interactive = enabled;
      if (!enabled) resolvePending("cancelled", "interactive_disabled");
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      resolvePending("cancelled", "service_disposed");
      removePermissionListener?.();
      const active = [...connections.values()];
      connections.clear();
      await Promise.allSettled(active.map(async (connection) => (await connection).close()));
    },
  };
  return service;
}

function approvalPayload(pending: PendingApproval, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: pending.requestId,
    operation: pending.operation,
    server: pending.server,
    ...(pending.command ? { command: pending.command } : {}),
    ...(pending.args ? { args: pending.args } : {}),
    ...(pending.env ? { env_names: pending.env } : {}),
    ...(pending.executableDigest ? { executable_digest: pending.executableDigest } : {}),
    ...(pending.replace ? { replace: true } : {}),
    ...(pending.tool ? { tool: pending.tool } : {}),
    ...(pending.argumentDigest ? { argument_digest: pending.argumentDigest } : {}),
    filesystem: "isolated_empty",
    network: "sandbox_policy",
    ...extra,
  };
}

function validateToolDefinition(tool: McpToolDefinition): McpToolDefinition {
  if (!TOOL_NAME.test(tool.name) || !plainObject(tool.inputSchema)) {
    throw new Error("MCP server returned an invalid tool definition");
  }
  if (containsSecretValue(tool) || containsPrivateInfrastructureValue(tool)) {
    throw new Error(`MCP tool metadata was withheld: ${tool.name}`);
  }
  return {
    name: tool.name,
    ...(tool.title ? { title: safePublic(tool.title) } : {}),
    ...(tool.description ? { description: safePublic(tool.description) } : {}),
    inputSchema: tool.inputSchema,
  };
}

function formatToolResult(result: McpToolCallResult): string {
  const rows: string[] = [];
  for (const block of result.content) {
    if (plainObject(block) && block.type === "text" && typeof block.text === "string") {
      rows.push(stripTerminalControls(block.text));
    } else if (plainObject(block) && typeof block.type === "string") {
      rows.push(`[MCP ${safePublic(block.type)} content omitted]`);
    }
  }
  if (result.structuredContent) rows.push(JSON.stringify(result.structuredContent));
  return rows.join("\n") || (result.isError ? "MCP tool returned an error without text." : "MCP tool returned no text.");
}

function safePublic(value: string): string {
  const safe = stripTerminalControls(redactText(value)).trim();
  return Buffer.from(safe).subarray(0, 2_048).toString("utf8") || "unavailable";
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function boundedResult(value: string): string {
  if (Buffer.byteLength(value) <= MAX_RESULT_BYTES) return value;
  return `${Buffer.from(value).subarray(0, MAX_RESULT_BYTES - 32).toString("utf8")}\n[MCP result truncated]`;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function refused(reason: string): McpOutcome {
  return { error: true, text: `MCP refused: ${reason}.` };
}
