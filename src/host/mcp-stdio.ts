import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpStdioServerConfig } from "./config.ts";
import type { EventLog } from "./event-log.ts";
import {
  appendPolicyEvent,
  createPolicy,
  writeWrapperScript,
} from "./sandbox.ts";

const SYSTEM_EXECUTABLE_DIRS = [
  ...(process.platform === "darwin" ? ["/opt/homebrew/bin"] : []),
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/local/sbin",
  "/usr/sbin",
  "/sbin",
] as const;
const MAX_TOOLS = 128;
const MAX_TOOL_PAGES = 8;

export interface ResolvedMcpExecutable {
  readonly path: string;
  readonly digest: string;
}

export interface McpToolDefinition {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface McpToolCallResult {
  readonly isError: boolean;
  readonly content: readonly unknown[];
  readonly structuredContent?: Record<string, unknown>;
}

export interface McpConnection {
  readonly serverInfo?: { readonly name: string; readonly version: string };
  listTools(): Promise<readonly McpToolDefinition[]>;
  callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<McpToolCallResult>;
  close(): Promise<void>;
}

export type McpConnector = (input: {
  readonly name: string;
  readonly config: McpStdioServerConfig;
  readonly executable: ResolvedMcpExecutable;
  readonly env?: NodeJS.Dict<string>;
  readonly log?: EventLog;
}) => Promise<McpConnection>;

/** Resolve only a host-owned executable from the fixed system PATH. Approval
 * binds the returned byte digest; workspace-controlled PATH never participates. */
export function resolveMcpExecutable(command: string): ResolvedMcpExecutable {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(command)) {
    throw new Error("MCP command must be one executable name without a path");
  }
  for (const directory of SYSTEM_EXECUTABLE_DIRS) {
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      const path = realpathSync(candidate);
      const metadata = lstatSync(path);
      if (!metadata.isFile() || (metadata.mode & 0o111) === 0) continue;
      const bytes = readFileSync(path);
      return {
        path,
        digest: createHash("sha256").update(bytes).digest("hex"),
      };
    } catch {
      // Continue through the fixed host-owned candidates only.
    }
  }
  throw new Error(`MCP executable is unavailable or untrusted: ${command}`);
}

/** Connect one approved server through the official MCP client inside a
 * disposable empty sandbox. The Dokkabi workspace is never mounted. */
export async function connectMcpStdio(input: {
  readonly name: string;
  readonly config: McpStdioServerConfig;
  readonly executable: ResolvedMcpExecutable;
  readonly env?: NodeJS.Dict<string>;
  readonly log?: EventLog;
}): Promise<McpConnection> {
  if (input.executable.digest !== input.config.executable_digest) {
    throw new Error("MCP executable changed after approval; enroll it again");
  }
  const root = mkdtempSync(join(tmpdir(), "dokkabi-mcp-world-"));
  const wrapperRoot = mkdtempSync(join(tmpdir(), "dokkabi-mcp-wrapper-"));
  const credentialFile = join(root, ".dokkabi-mcp-env");
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let closed = false;
  try {
    const credentialLines: string[] = [];
    const hostEnv = input.env ?? process.env;
    for (const name of input.config.env) {
      const value = hostEnv[name];
      if (!value) throw new Error(`MCP credential environment is unavailable: ${name}`);
      if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
        throw new Error(`MCP credential environment is invalid: ${name}`);
      }
      credentialLines.push(`export ${name}=${shellWord(value)}`);
    }
    if (credentialLines.length > 0) {
      writeFileSync(credentialFile, `${credentialLines.join("\n")}\n`, { mode: 0o600 });
    }
    const policy = createPolicy({
      mode: "workspace-write",
      workspaceRoot: root,
      ...(input.log ? { log: input.log } : {}),
    });
    if (input.log) appendPolicyEvent(input.log, policy);
    const wrapper = writeWrapperScript(policy, join(wrapperRoot, "stdio.sh"));
    const argv = [input.executable.path, ...input.config.args].map(shellWord).join(" ");
    const command = credentialLines.length > 0
      ? `. ./.dokkabi-mcp-env; rm -f ./.dokkabi-mcp-env; exec ${argv}`
      : `exec ${argv}`;
    transport = new StdioClientTransport({
      command: wrapper,
      args: ["--noprofile", "--norc", "-c", command],
      env: { ...policy.childEnv },
      cwd: root,
      stderr: "pipe",
      maxBufferSize: 1024 * 1024,
    });
    transport.stderr?.on("data", () => {
      // Drain untrusted server diagnostics; never forward them into EventLog.
    });
    client = new Client({ name: "dokkabi", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport, { timeout: 15_000 });
    const serverVersion = client.getServerVersion();

    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      try {
        await client?.close();
      } finally {
        try {
          await transport?.close();
        } finally {
          rmSync(root, { recursive: true, force: true });
          rmSync(wrapperRoot, { recursive: true, force: true });
        }
      }
    };

    return {
      ...(serverVersion && typeof serverVersion.name === "string" && typeof serverVersion.version === "string"
        ? { serverInfo: { name: serverVersion.name, version: serverVersion.version } }
        : {}),
      async listTools() {
        const tools: McpToolDefinition[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
          const result = await client!.listTools(cursor ? { cursor } : undefined, { timeout: 15_000 });
          for (const tool of result.tools) {
            if (tools.length >= MAX_TOOLS) throw new Error(`MCP tool limit is ${MAX_TOOLS}`);
            if (!safeToolName(tool.name)) throw new Error("MCP server returned an invalid tool name");
            if (!plainObject(tool.inputSchema)) throw new Error(`MCP tool ${tool.name} has an invalid input schema`);
            tools.push({
              name: tool.name,
              ...(typeof tool.title === "string" ? { title: bounded(tool.title, 256) } : {}),
              ...(typeof tool.description === "string" ? { description: bounded(tool.description, 2_048) } : {}),
              inputSchema: tool.inputSchema,
            });
          }
          cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
          if (!cursor) return tools;
        }
        throw new Error(`MCP tool pagination exceeds ${MAX_TOOL_PAGES} pages`);
      },
      async callTool(name, args) {
        if (!safeToolName(name) || !plainObject(args)) throw new Error("invalid MCP tool call");
        const result = await client!.callTool({ name, arguments: { ...args } }, undefined, { timeout: 60_000 });
        return {
          isError: result.isError === true,
          content: Array.isArray(result.content) ? result.content : [],
          ...(plainObject(result.structuredContent)
            ? { structuredContent: result.structuredContent as Record<string, unknown> }
            : {}),
        };
      },
      close,
    };
  } catch (error) {
    try {
      await client?.close();
    } catch {
      // The original connection error is more useful and already bounded by callers.
    }
    try {
      await transport?.close();
    } catch {
      // Best-effort process cleanup follows with directory cleanup.
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(wrapperRoot, { recursive: true, force: true });
    throw error;
  }
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function safeToolName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bounded(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  return Buffer.from(value).subarray(0, maxBytes).toString("utf8");
}
