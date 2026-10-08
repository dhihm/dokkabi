import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { RejectionAudit } from "./rejection-audit.ts";
/**
 * Dokkabi Desktop & Mobile Gateway Server.
 * JSON-RPC 2.0 over a token-authenticated WebSocket/HTTP surface plus a
 * local Unix domain socket, with multi-session catalog, terminal grid,
 * approval relay integration, and Tailscale mobile companion.
 *
 * Constitution rules this server obeys:
 * - Every gateway action (terminal lifecycle, session operations, approval
 *   decisions, auth rejections) is an observe event in a hash-chained
 *   gateway EventLog (constitution 2). The log lives beside the run socket
 *   and is the audit surface for "what did the operator's desktop do".
 * - The sessions root is read-mostly: the gateway never fabricates session
 *   EventLogs — real session logs belong to the harness that runs them.
 * - Telemetry is never client-fed: metrics surfaces derive from recorded
 *   truth or report themselves unavailable (constitution 6).
 * - The pairing token gates every remote method. The default bind is
 *   localhost; binding a wider interface is an explicit operator choice that
 *   is warned about and recorded.
 * - The R2 workbench boundary shares this server and its audit log: while a
 *   workbench binding, outstanding binding claim, or unresolved workbench
 *   command owns the workspace session, the legacy chat.* mutations and
 *   note submits that could touch it refuse before effects with a recorded
 *   rejection — decision and effect atomic on the workbench chain, so a
 *   concurrent bind cannot interleave between them. Session deletion honors
 *   the same ownership plus the live interactive lease, holding its
 *   acquired guards through the delete.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { spawn, spawnSync, type Subprocess } from "bun";
import qrcode from "qrcode-generator";
import { EventLog } from "../host/event-log.ts";
import { openGatewayLog } from "./gateway-log.ts";
import { dokkabiHome } from "../host/paths.ts";
import { redactText } from "../host/redact.ts";
import { BlobStore } from "../host/blob-store.ts";
import { projectBranchRuntime } from "../chat/desktop-branch-runtime.ts";
import { acquireSessionRunLock } from "../host/session-lock.ts";
import { acquireSessionLease } from "../host/session-lease.ts";
import { decideApproval, listApprovals, type RelayDecision, type RelayRecord } from "../host/approval-relay.ts";
import { listSessionIndex } from "./session-scan.ts";
import { gitDiff, gitStatus } from "../host/git-view.ts";
import { spawnSealedHostGit } from "../host/git-authority.ts";
import { projectTranscript, transcriptCardsAfter } from "./transcript.ts";
import { TailLog } from "./tail-log.ts";
import { operatorInboxPath, pushOperatorMessage } from "../work/inbox.ts";
import { readPlanFromLog } from "../work/log.ts";
import { viewPlan } from "../work/view.ts";
import { resolveLlmSelection } from "../host/config.ts";
import { readModelPreferences } from "../host/model-preferences.ts";
import { BUILTIN_ROUTE_SPECS } from "../plugins/llm-route-catalog.ts";
import { createHostedModels } from "../plugins/hosted-models.ts";
import { hostedModelCatalogs } from "../plugins/model-catalog.ts";
import { buildModelPickerCandidates } from "../chat/model-picker.ts";
import { DokkabiAuth } from "../auth/service.ts";
import { authPickerCandidates } from "../auth/tui.ts";
import { openDesktopChatKernel, type DesktopChatKernel } from "../chat/desktop-kernel.ts";
import { defaultManifestPath } from "../boot.ts";
import { workspaceSessionId } from "../host/paths.ts";
import { WorkbenchGateway } from "./workbench.ts";
import { listWorkbenchModels } from "./workbench-models.ts";
import { isHandoffConfirmation } from "./handoff-prompt.ts";
import type {
  AgentProfileConfig,
  AgentProfileKind,
  ApprovalResponseParams,
  DesktopSessionItem,
  DiffSummary,
  GitFileDiff,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  PendingApproval,
  SessionCreateParams,
  SessionDeleteParams,
  SpeculativeMetrics,
  TailscalePairingInfo,
  TerminalInputOptions,
  TerminalResizeOptions,
  TerminalSpawnOptions,
  TerminalSplitParams,
} from "./desktop-protocol.ts";

interface DesktopConnection {
  send: (msg: string) => void;
  readonly transcriptSubscriptions: Set<string>;
  closed: boolean;
}

export interface DesktopServerConfig {
  port?: number;
  host?: string;
  socketPath?: string;
  sessionsRoot?: string;
  gatewayLogPath?: string;
  pairingToken?: string;
  pairingTokenTtlMs?: number;
  /** Private bundled host lease. Never supplied by an RPC or a pairing client. */
  credentialOwner?: AbortSignal;
  /** Immutable private bundled conversation owner; never an RPC session selector. */
  threadBinding?: { clientId: string; threadId: string };
  publicOrigin?: string;
  workspaceCwd?: string;
}

interface ActiveTerminal {
  id: string;
  profileKind: AgentProfileKind;
  command: string;
  argv: string[];
  pty: boolean;
  process: Subprocess<"pipe", "pipe", "pipe">;
  cols: number;
  rows: number;
  startedAt: number;
}

/** A parked relay approval flattened for the desktop/mobile surfaces. */
export interface ParkedApprovalItem {
  approvalId: string;
  sessionId: string;
  kind: RelayRecord["kind"];
  summary: string;
  target?: string;
  requestedAt: string;
  status: RelayRecord["status"];
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The newest recorded model usage, for the console's context rail. */
function lastUsage(
  events: readonly import("../host/schema.ts").EventRecord[],
): { contextUsed: number | "missing"; contextWindow: number | "missing"; inputTokens: number | "missing"; outputTokens: number | "missing" } | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.name !== "model/usage") continue;
    const payload = event.payload as Record<string, unknown>;
    return {
      contextUsed: metricOrMissing(payload.context_used),
      contextWindow: metricOrMissing(payload.context_window),
      inputTokens: metricOrMissing(payload.input_tokens),
      outputTokens: metricOrMissing(payload.output_tokens),
    };
  }
  return undefined;
}

function metricOrMissing(value: unknown): number | "missing" {
  return typeof value === "number" && Number.isFinite(value) ? value : "missing";
}
const SCRIPT_WRAPPER = "/usr/bin/script";
// macOS pty runner: BSD script(1) dies on non-tty stdin (tcgetattr), so
// programmatic spawns go through this helper instead. See pty-run.py.
const DARWIN_PTY_RUNNER = join(import.meta.dir, "pty-run.py");

/** Escape untrusted text for interpolation into the mobile companion page. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export class DokkabiDesktopServer {
  public port: number;
  public readonly host: string;
  public readonly socketPath: string;
  public readonly sessionsRoot: string;
  public readonly gatewayLogPath: string;
  public readonly pairingToken: string;
  public readonly pairingTokenExpiresAt: number;
  private readonly credentialOwner?: AbortSignal;
  public readonly publicOrigin?: string;
  public readonly workspaceCwd: string;

  private rejectionAuditWarning = false;
  private readonly rejectionAudit = new RejectionAudit(counts => {
    // Keep existing chained evidence. Unauthenticated traffic cannot force
    // indefinite retention growth, and this path never deletes old records.
    if (existsSync(this.gatewayLogPath) && statSync(this.gatewayLogPath).size >= 8 * 1024 * 1024 - 2048) {
      throw new Error("authentication audit storage budget exhausted");
    }
    this.record("desktop/auth_rejected", { ...counts, aggregated: true });
  });
  private releaseCredentialOwner?: () => void;
  private rejectionAuditTimer?: ReturnType<typeof setInterval>;
  private gatewayLog?: EventLog;
  private httpBunServer?: ReturnType<typeof Bun.serve>;
  private unixBunServer?: ReturnType<typeof Bun.listen>;
  private terminals = new Map<string, ActiveTerminal>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private approvalResolvers = new Map<string, (res: ApprovalResponseParams) => void>();
  private connectedSockets = new Set<DesktopConnection>();
  private activeSessionId?: string;
  /** Live transcript follows: one timer per followed session, refcounted. */
  private transcriptFollows = new Map<
    string,
    { timer: ReturnType<typeof setInterval>; tail: TailLog; lastSeq: number; refs: number }
  >();
  /** The embedded chat kernel for the gateway workspace session, if open. */
  private chatKernel?: DesktopChatKernel;
  private readonly ownedSessionId?: string;
  /** One in-flight kernel boot: concurrent legacy chat.open and workbench
   * bind calls share it instead of racing two boots for one lease. */
  private chatKernelBoot?: Promise<DesktopChatKernel>;
  /** Set synchronously when stop() begins: no new chat kernel may boot past
   * a shutdown that will await and close it. */
  private stopping = false;
  /** The one chat-disposal barrier every stop() caller awaits. */
  private stopBarrier?: Promise<void>;
  /** The R2 closed workbench wire boundary over this gateway. */
  private readonly workbench: WorkbenchGateway;

  constructor(config: DesktopServerConfig = {}) {
    this.port = config.port ?? Number(process.env.DOKKABI_DESKTOP_PORT ?? 4174);
    // Localhost unless the operator explicitly opens the surface. A wider
    // bind puts an RPC that can spawn processes on every interface; that
    // choice must be deliberate, and start() records it.
    this.host = config.host ?? process.env.DOKKABI_DESKTOP_HOST ?? "127.0.0.1";
    this.socketPath = config.socketPath ?? join(dokkabiHome(), "run", "dokkabi-desktop.sock");
    this.sessionsRoot = config.sessionsRoot ?? join(dokkabiHome(), "sessions");
    this.gatewayLogPath = config.gatewayLogPath ?? join(dokkabiHome(), "run", "desktop-gateway.jsonl");
    if (config.credentialOwner !== undefined &&
        (config.pairingToken === undefined || !/^[A-Za-z0-9_-]{32,256}$/.test(config.pairingToken) ||
         this.host !== "127.0.0.1" || config.publicOrigin !== undefined || config.pairingTokenTtlMs !== undefined)) {
      throw new Error("invalid owner credential configuration");
    }
    this.credentialOwner = config.credentialOwner;
    this.pairingToken = config.pairingToken ?? `dk_${randomBytes(32).toString("base64url")}`;
    const tokenTtl = config.pairingTokenTtlMs ?? 8 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(tokenTtl) || tokenTtl < 1 || tokenTtl > 24 * 60 * 60 * 1000) throw new Error("invalid pairing credential lifetime");
    this.pairingTokenExpiresAt = this.credentialOwner === undefined ? Date.now() + tokenTtl : Number.POSITIVE_INFINITY;
    if (config.publicOrigin !== undefined) {
      const origin = new URL(config.publicOrigin);
      if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("public gateway origin must be an HTTPS origin");
      this.publicOrigin = origin.origin;
    }
    this.workspaceCwd = config.workspaceCwd ?? process.cwd();
    if (config.threadBinding !== undefined) {
      const binding = config.threadBinding;
      if (config.credentialOwner === undefined ||
          ![binding.clientId, binding.threadId].every(id => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))) {
        throw new Error("invalid thread owner configuration");
      }
      this.ownedSessionId = "desktop-" + createHash("sha256")
        .update(JSON.stringify([realpathSync(this.workspaceCwd), binding.clientId, binding.threadId])).digest("hex");
    }
    // The R2 workbench boundary shares this server's kernel and audit ledger;
    // every workbench row lands in the same hash-chained gateway log.
    this.workbench = new WorkbenchGateway({
      workspaceCwd: this.workspaceCwd,
      sessionsRoot: this.sessionsRoot,
      gatewayLogPath: this.gatewayLogPath,
      ...(config.threadBinding ? { sessionId: this.ownedSessionId!, binding: config.threadBinding } : {}),
      openKernel: async () => await this.ensureChatKernel(true),
      getKernel: () => this.chatKernel,
      listModels: listWorkbenchModels,
    });
  }

  private warnRejectionAudit(): void {
    if (this.rejectionAuditWarning) return;
    this.rejectionAuditWarning = true;
    console.error("[DesktopServer] Authentication audit is limited; archive the gateway log or repair storage. Pending counts remain in memory.");
  }
  private rejectAuthentication(surface: "ws" | "http"): void {
    try { this.rejectionAudit.reject(surface); } catch { this.warnRejectionAudit(); }
  }

  private authenticates(request: Request, socket: boolean): boolean {
    if (this.credentialOwner?.aborted || this.stopping || Date.now() >= this.pairingTokenExpiresAt) return false;
    const url = new URL(request.url);
    if (url.searchParams.has("token")) return false;
    const origin = request.headers.get("origin");
    const nativeOrigin = ["tauri://localhost", "http://tauri.localhost"].includes(origin ?? "") &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    const localOrigins = [`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`, `http://[::1]:${this.port}`];
    if (origin !== null && !localOrigins.includes(origin) && origin !== this.publicOrigin && !nativeOrigin) return false;
    let token = request.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "";
    if (socket) {
      const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map(value => value.trim());
      if (!protocols.includes("dokkabi.rpc")) return false;
      try { token = decodeURIComponent(protocols.find(value => value.startsWith("dokkabi.auth."))?.slice(13) ?? ""); }
      catch { return false; }
    }
    const a = Buffer.from(token), b = Buffer.from(this.pairingToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Append one observe row to the gateway audit log. Failures are loud. */
  private record(name: string, payload: Record<string, unknown>): void {
    if (!this.gatewayLog) this.gatewayLog = this.openGatewayLog();
    this.gatewayLog.append({ kind: "observe", name, payload });
  }

  private openGatewayLog(): EventLog {
    return openGatewayLog(this.gatewayLogPath);
  }

  public async start(): Promise<{ httpUrl: string; socketPath: string; tailscale: TailscalePairingInfo }> {
    if (this.credentialOwner?.aborted) throw new Error("owner credential lease ended");
    // This listener has no TLS. Network-facing TLS termination must be owned
    // by the operator and forward to this loopback endpoint.
    if (!["127.0.0.1", "localhost", "::1"].includes(this.host)) {
      throw new Error("plaintext desktop gateway requires loopback; use a trusted TLS proxy for remote access");
    }
    const sockDir = dirname(this.socketPath);
    if (!existsSync(sockDir)) {
      mkdirSync(sockDir, { recursive: true, mode: 0o700 });
    }
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch { /* ignore */ }
    }
    this.record("desktop/started", { host: this.host, port: this.port, wide_bind: false, credential_lifetime: this.credentialOwner === undefined ? "pairing" : "owner-process" });

    if (this.credentialOwner !== undefined) {
      const owner = this.credentialOwner;
      const revoked = () => {
        try { this.record("desktop/owner_revoked", { reason: "owner-lease-ended" }); }
        catch { console.error("[DesktopServer] Owner revocation audit failed; credential access remains revoked."); }
      };
      owner.addEventListener("abort", revoked, { once: true });
      this.releaseCredentialOwner = () => owner.removeEventListener("abort", revoked);
    }
    this.httpBunServer = Bun.serve({
      port: this.port,
      hostname: this.host,
      websocket: {
        open: (ws) => {
          const owner = this.credentialOwner;
          if (owner !== undefined) {
            const revoke = () => ws.close(1008, "desktop owner lease ended");
            owner.addEventListener("abort", revoke, { once: true });
            (ws as unknown as { _releaseOwner?: () => void })._releaseOwner = () => owner.removeEventListener("abort", revoke);
            if (owner.aborted) revoke();
          } else {
            const expiry = setTimeout(() => ws.close(1008, "pairing credential expired"), Math.max(0, this.pairingTokenExpiresAt - Date.now()));
            expiry.unref();
            (ws as unknown as { _expiry?: ReturnType<typeof setTimeout> })._expiry = expiry;
          }
          const client: DesktopConnection = { send: (msg: string) => ws.send(msg), transcriptSubscriptions: new Set(), closed: false };
          (ws as unknown as { _clientObj?: unknown })._clientObj = client;
          this.connectedSockets.add(client);
        },
        message: async (ws, message) => {
          if (this.credentialOwner?.aborted || Date.now() >= this.pairingTokenExpiresAt) { ws.close(1008, "pairing credential expired"); return; }
          const client = (ws as unknown as { _clientObj?: DesktopConnection })._clientObj;
          const text = typeof message === "string" ? message : new TextDecoder().decode(message);
          const response = await this.handleJsonRpcMessage(text, client);
          if (response && client && !client.closed) {
            client.send(JSON.stringify(response));
          }
        },
        close: (ws) => {
          clearTimeout((ws as unknown as { _expiry?: ReturnType<typeof setTimeout> })._expiry);
          (ws as unknown as { _releaseOwner?: () => void })._releaseOwner?.();
          const client = (ws as unknown as { _clientObj?: DesktopConnection })._clientObj;
          if (client) this.releaseConnection(client);
        },
      },
      fetch: (req, srv) => {
        const url = new URL(req.url);
        // Every remote surface authenticates with the pairing token from the
        // QR fragment. Requests use a subprotocol/header, never a URL query;
        // the Unix socket side is filesystem-permission protected instead.
        if (url.pathname === "/ws") {
          if (!this.authenticates(req, true)) {
            this.rejectAuthentication("ws");
            return new Response("forbidden", { status: 403 });
          }
          if (srv.upgrade(req, { data: {}, headers: { "Sec-WebSocket-Protocol": "dokkabi.rpc" } })) return undefined as unknown as Response;
          return new Response("Upgrade failed", { status: 400 });
        }
        // The companion page is static shell; it carries no data without the
        // authenticated websocket.
        if (url.pathname === "/mobile" || url.pathname === "/") {
          return new Response(this.renderMobileCompanionHtml(), {
            headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
          });
        }
        if (url.pathname === "/api/pairing") {
          if (this.credentialOwner !== undefined || !this.authenticates(req, false)) {
            this.rejectAuthentication("http");
            return new Response("forbidden", { status: 403 });
          }
          return Response.json(this.getTailscaleInfo(), { headers: { "cache-control": "no-store" } });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    this.port = this.httpBunServer.port ?? this.port;
    this.rejectionAuditTimer = setInterval(() => {
      try { this.rejectionAudit.flush(); }
      catch { this.warnRejectionAudit(); }
    }, 60000);
    this.rejectionAuditTimer.unref();

    try {
      this.unixBunServer = Bun.listen({
        unix: this.socketPath,
        socket: {
          open: (socket) => {
            // Queued writes: socket.write() short-writes once the payload
            // outgrows its ~8KB buffer and Bun never retries the tail, so an
            // unterminated JSON line hangs every line-delimited reader — this
            // shipped as the Tauri shell waiting forever on tailscale.info's
            // 14KB reply while small RPCs looked fine.
            const client = {
              pending: "",
              transcriptSubscriptions: new Set<string>(),
              closed: false,
              send(msg: string) {
                client.pending += msg + "\n";
                DokkabiDesktopServer.pumpUnixSocket(socket, client);
              },
            };
            (socket as unknown as { _clientObj?: unknown })._clientObj = client;
            this.connectedSockets.add(client);
          },
          drain: (socket) => {
            const client = (socket as unknown as { _clientObj?: { pending: string } })._clientObj;
            if (client) DokkabiDesktopServer.pumpUnixSocket(socket, client);
          },
          data: async (socket, data) => {
            const client = (socket as unknown as { _clientObj?: DesktopConnection })._clientObj;
            const text = new TextDecoder().decode(data);
            const lines = text.split("\n").filter((l) => l.trim().length > 0);
            for (const line of lines) {
              const response = await this.handleJsonRpcMessage(line, client);
              if (response && client && !client.closed) {
                client.send(JSON.stringify(response));
              }
            }
          },
          close: (socket) => {
            const client = (socket as unknown as { _clientObj?: DesktopConnection })._clientObj;
            if (client) this.releaseConnection(client);
          },
          error: (socket, err) => {
            const client = (socket as unknown as { _clientObj?: DesktopConnection })._clientObj;
            if (client) this.releaseConnection(client);
            console.error("[DesktopServer] Unix socket error:", err);
          },
        },
      });
      // The local socket is the operator's own surface: tight file modes,
      // no token round trip needed for a same-user peer.
      try { chmodSync(this.socketPath, 0o600); } catch { /* best effort */ }
    } catch (err) {
      console.warn("[DesktopServer] Notice: Unix socket listen fallback:", err);
    }

    const tailscale = this.getTailscaleInfo();
    const httpUrl = `http://${this.host.includes(":") ? `[${this.host}]` : this.host}:${this.port}`;
    return { httpUrl, socketPath: this.socketPath, tailscale };
  }

  /** Shutdown answers ONE awaited chat-disposal barrier: every caller of
   * stop() — repeated or concurrent — awaits the same completion, and the
   * barrier covers the owned chat close (the embedded kernel and, through
   * its plugin disposer, every branch child lease) plus any in-flight
   * kernel boot, so a late boot can never leak a lease past shutdown.
   * New chat work is refused once stopping has begun. */
  public stop(): Promise<void> {
    if (this.stopBarrier !== undefined) return this.stopBarrier;
    this.stopping = true;
    this.stopBarrier = this.performStop().finally(() => this.workbench.clearReadCaches());
    return this.stopBarrier;
  }

  private async performStop(): Promise<void> {
    // The owned boot barrier: a boot that was already in flight when stop
    // began is drained to completion, and whatever kernel it installed is
    // closed by closeChat below — a successful late boot is disposed or
    // refused before it can publish an exposed kernel, never left ready.
    // `stopping` refuses every NEW boot synchronously, so the registered
    // barrier can only drain, never regrow; closeChat never awaits the
    // boot, so this cannot deadlock against bootChatKernel's own closeChat
    // call, and a failed boot releases its own lease inside the kernel.
    let boot = this.chatKernelBoot;
    while (boot !== undefined) {
      try {
        await boot;
      } catch {
        // A failed boot has already released its lease.
      }
      boot = this.chatKernelBoot;
    }
    await this.closeChat();
    for (const client of this.connectedSockets) this.releaseConnection(client);
    for (const [, follow] of this.transcriptFollows) {
      clearInterval(follow.timer);
    }
    this.transcriptFollows.clear();
    for (const [, term] of this.terminals) {
      try { term.process.kill(); } catch { /* ignore */ }
    }
    this.terminals.clear();

    if (this.httpBunServer) {
      this.httpBunServer.stop(true);
      this.httpBunServer = undefined;
    }
    if (this.unixBunServer) {
      this.unixBunServer.stop(true);
      this.unixBunServer = undefined;
    }
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch { /* ignore */ }
    }
    this.connectedSockets.clear();
    this.releaseCredentialOwner?.();
    this.releaseCredentialOwner = undefined;
    if (this.rejectionAuditTimer) clearInterval(this.rejectionAuditTimer);
    this.rejectionAuditTimer = undefined;
    try { this.rejectionAudit.flush(true); } catch { this.warnRejectionAudit(); }
  }

  public broadcast(notification: JsonRpcNotification): void {
    const payload = JSON.stringify(notification);
    for (const client of this.connectedSockets) {
      try { client.send(payload); } catch { /* ignore */ }
    }
  }

  // --- JSON-RPC 2.0 Handling ---

  public async handleJsonRpcMessage(raw: string, connection?: DesktopConnection): Promise<JsonRpcResponse | null> {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(raw);
    } catch {
      return { jsonrpc: "2.0", id: 0, error: { code: -32700, message: "Parse error" } };
    }

    if (req.jsonrpc !== "2.0" || !req.method) {
      return { jsonrpc: "2.0", id: req.id ?? 0, error: { code: -32600, message: "Invalid Request" } };
    }

    try {
      const result = await this.dispatchMethod(req.method, req.params, connection);
      return { jsonrpc: "2.0", id: req.id, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32603, message: message ?? "Internal error" },
      };
    }
  }

  private async dispatchMethod(method: string, params: unknown, connection?: DesktopConnection): Promise<unknown> {
    switch (method) {
      case "session.list":
        return this.listSessions();

      case "session.switch":
        return this.switchSession((params as { sessionId?: string })?.sessionId);

      case "session.create":
        return this.createSession(params as SessionCreateParams);

      case "session.delete":
        return this.deleteSession((params as SessionDeleteParams)?.sessionId);

      case "approval.list":
        return this.listParkedApprovals();

      case "approval.respond": {
        const p = params as { sessionId?: string; approvalId?: string; decision?: string };
        if (!p?.sessionId || !p?.approvalId) {
          throw new Error("approval.respond requires sessionId and approvalId (a parked relay request)");
        }
        if (p.decision === "modify") {
          throw new Error("the relay cannot modify a parked request: choose allow or deny");
        }
        const resolved = this.resolveParkedApproval(p.sessionId, p.approvalId, p.decision === "deny" ? "deny" : "allow");
        if (!resolved) throw new Error(`no pending approval ${p.approvalId} in session ${p.sessionId}`);
        return { ok: true, status: resolved.status };
      }

      case "terminal.spawn":
        return this.spawnTerminal(params as TerminalSpawnOptions);

      case "terminal.split":
        return this.splitTerminal(params as TerminalSplitParams);

      case "terminal.write":
        return this.writeTerminal(params as TerminalInputOptions);

      case "terminal.resize":
        return this.resizeTerminal(params as TerminalResizeOptions);

      case "terminal.kill":
        return this.killTerminal((params as { terminalId?: string })?.terminalId);

      case "tailscale.info":
        return this.getTailscaleInfo();

      case "diff.get":
        return this.getDiffSummary((params as { path?: string })?.path, (params as { staged?: boolean })?.staged);

      // Telemetry is read-only: no client may write metrics into the
      // dashboard. There is no speculative-prefetch source in the harness
      // yet, so the surface reports itself unavailable instead of inventing
      // numbers (#128 named a design, not a shipped source).
      case "speculative.metrics":
        return this.speculativeMetrics();

      case "agent.profiles":
        return this.getAgentProfiles();

      // The console projection surface: read-only views over real session
      // EventLogs (constitution 6 — the gateway never fabricates a session)
      // plus the one write an observer may make, staging a note.
      case "transcript.snapshot":
        return this.transcriptSnapshot(
          (params as { sessionId?: string })?.sessionId,
          (params as { fromSeq?: number })?.fromSeq,
        );

      case "transcript.subscribe":
        return this.transcriptSubscribe((params as { sessionId?: string })?.sessionId, connection);

      case "transcript.unsubscribe":
        return this.transcriptUnsubscribe((params as { sessionId?: string })?.sessionId, connection);

      case "plan.snapshot":
        return this.planSnapshot((params as { sessionId?: string })?.sessionId);

      case "model.candidates":
        return this.modelCandidates();

      // Observer-mode model selection: validate and persist the saved pair
      // the same way the CLI `dokkabi model` command does. It lands on the
      // next session boot; a live kernel switch goes through chat.model.
      case "model.select": {
        const choice = (params as { choice?: string })?.choice;
        if (typeof choice !== "string" || choice.trim().length === 0) {
          throw new Error("choice is required");
        }
        const { persistModelSelection } = await import("../commands/model.ts");
        const saved = await persistModelSelection(choice);
        this.record("desktop/model_selected", { route: saved.route, ...(saved.model ? { model: saved.model } : {}) });
        return {
          ok: true,
          message: `saved route=${saved.route}${saved.model ? ` model=${saved.model}` : ""} — it applies to the next session start`,
        };
      }

      case "note.submit": {
        const p = params as { sessionId?: string; text?: string };
        return this.noteSubmit(p?.sessionId, p?.text);
      }

      // The embedded chat kernel: the desktop window converses with a
      // session the way `dokkabi chat` does, behind the same lease.
      case "chat.open":
        return this.chatOpen(params as { sessionId?: string; resume?: boolean });

      case "chat.send": {
        const p = params as { text?: string };
        return this.chatSend(p?.text);
      }

      case "chat.abort":
        return this.chatAbort();

      case "chat.close":
        return this.chatClose();

      case "chat.state":
        return this.chatState();

      case "chat.model": {
        const choice = (params as { choice?: string })?.choice;
        return this.chatModel(choice);
      }

      case "chat.effort": {
        const level = (params as { level?: string })?.level;
        return this.chatEffort(level);
      }

      // The R2 closed workbench wire boundary. Strictly validated; see
      // src/dash/workbench.ts for the protocol contract. workbench.overview
      // (R3) is the additive read-only recorded overview; workbench.graph
      // (R4) the additive read-only Work/Context graph, same chain;
      // workbench.record (R5) the additive read-only exact retained record
      // reader with an immutable asOf pin. workbench.decisions (R8-04) the
      // read-only decision view; workbench.decision and workbench.branchSession
      // (R8-05) the closed decision mutations and the child-method envelope;
      // workbench.workMode (R8-06j2) the explicit session work mode.
      case "workbench.handshake":
      case "workbench.model":
      case "workbench.bind":
      case "workbench.read":
      case "workbench.submit":
      case "workbench.commandStatus":
      case "workbench.cancel":
      case "workbench.detach":
      case "workbench.overview":
      case "workbench.usage":
      case "workbench.graph":
      case "workbench.graph.explore":
      case "workbench.code":
      case "workbench.codeAction":
      case "workbench.record":
      case "workbench.record.index":
      case "workbench.record.body":
      case "workbench.decisions":
      case "workbench.decision":
      case "workbench.branchSession":
      case "workbench.checkpoint":
      case "workbench.workMode":
        return this.workbench.handle(method, params);

      default:
        throw new Error(`Method not found: ${method}`);
    }
  }

  // --- Multi-Session Catalog ---

  public listSessions(): DesktopSessionItem[] {
    const index = listSessionIndex(this.sessionsRoot);
    return index.rows.map((row) => ({
      id: row.id,
      status: row.status,
      goal: row.goal,
      turns: row.turns,
      events: row.events,
      lastTs: row.lastTs,
      profileKind: "dokkabi",
      active: row.id === this.activeSessionId,
    }));
  }

  public switchSession(sessionId?: string): { ok: boolean; session?: DesktopSessionItem } {
    if (!sessionId) return { ok: false };
    this.activeSessionId = sessionId;
    const sessionPath = join(this.sessionsRoot, sessionId, "events.jsonl");
    let eventCount = 0;
    if (existsSync(sessionPath)) {
      try {
        // Read-only: the gateway observes sessions, it never writes them.
        const log = new EventLog(sessionPath, { readOnly: true });
        eventCount = log.events.length;
      } catch {
        // An unreadable log is a fact to surface, not a reason to crash.
        eventCount = -1;
      }
    }
    this.record("desktop/session_switched", { sessionId, eventCount: eventCount >= 0 ? eventCount : "unreadable" });
    this.broadcast({
      jsonrpc: "2.0",
      method: "session.switched",
      params: { sessionId, eventCount },
    });
    const current = this.listSessions().find((s) => s.id === sessionId);
    return { ok: true, session: current };
  }

  /**
   * Register a session intent. The gateway NEVER fabricates a session
   * EventLog: real logs are hash-chained and belong to the harness that runs
   * them. The desktop records the intent in its own audit log; the session
   * appears in the catalog once `dokkabi work --session <id>` creates it.
   */
  public createSession(params?: SessionCreateParams): { ok: boolean; sessionId: string; session: DesktopSessionItem } {
    const id = params?.sessionId || `session_${Date.now()}`;
    if (!SESSION_ID_PATTERN.test(id)) {
      throw new Error(`invalid session id ${JSON.stringify(id)}`);
    }
    const goal = params?.goal ?? "New session";
    const workspace = params?.workspace ?? this.workspaceCwd;
    this.activeSessionId = id;
    this.record("desktop/session_created", { sessionId: id, goal, workspace, profileKind: params?.profileKind ?? "dokkabi" });

    const sessionItem: DesktopSessionItem = {
      id,
      status: "registered",
      goal,
      turns: 0,
      events: 0,
      lastTs: Date.now(),
      workspacePath: workspace,
      profileKind: params?.profileKind ?? "dokkabi",
      active: true,
    };
    this.broadcast({
      jsonrpc: "2.0",
      method: "session.created",
      params: sessionItem,
    });
    return { ok: true, sessionId: id, session: sessionItem };
  }

  // --- Console projection surface ---

  /** Resolve a session id to its log path, refusing anything unresolvable. */
  private sessionLogPath(sessionId?: string): string {
    if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error("a valid sessionId is required");
    }
    const path = join(this.sessionsRoot, sessionId, "events.jsonl");
    if (!existsSync(path)) {
      throw new Error(`no session log for ${sessionId}`);
    }
    return path;
  }

  /** Read-only transcript projection of a session's EventLog. */
  public transcriptSnapshot(sessionId?: string, fromSeq?: number): unknown {
    const path = this.sessionLogPath(sessionId);
    // Read-only: the gateway observes sessions, it never writes them. The
    // EventLog constructor verifies the hash chain, so a torn log refuses
    // here instead of projecting half a truth.
    const log = new EventLog(path, { readOnly: true });
    const cards = projectTranscript(log.events);
    return {
      sessionId: sessionId!,
      events: log.events.length,
      cards: typeof fromSeq === "number" ? transcriptCardsAfter(cards, fromSeq) : cards,
      usage: lastUsage(log.events),
    };
  }

  /** Follow a session log and broadcast new transcript cards as they land. */
  public transcriptSubscribe(sessionId?: string, connection?: DesktopConnection): { ok: boolean; sessionId: string } {
    if (this.stopping || connection?.closed) throw new Error("transcript subscription owner is closed");
    const path = this.sessionLogPath(sessionId);
    // A connection owns one reference per session; retries cannot accumulate
    // references that survive its explicit unsubscribe or transport close.
    if (connection?.transcriptSubscriptions.has(sessionId!)) return { ok: true, sessionId: sessionId! };
    let follow = this.transcriptFollows.get(sessionId!);
    if (!follow) {
      const tail = new TailLog(path);
      follow = { timer: undefined as never, tail, lastSeq: 0, refs: 0 };
      // Watermark starts at the current tail: subscribe means "from now on".
      const first = tail.poll();
      follow.lastSeq = first.events.at(-1)?.seq ?? 0;
      follow.timer = setInterval(() => {
        const { events, changed } = follow!.tail.poll();
        if (!changed || events.length === 0) return;
        const watermark = events.at(-1)!.seq;
        const fresh = transcriptCardsAfter(projectTranscript(events), follow!.lastSeq);
        follow!.lastSeq = watermark;
        if (fresh.length === 0) return;
        this.broadcast({
          jsonrpc: "2.0",
          method: "transcript.append",
          params: { sessionId, cards: fresh },
        });
      }, 300);
      this.transcriptFollows.set(sessionId!, follow);
      this.record("desktop/transcript_subscribed", { sessionId });
    }
    follow.refs += 1;
    connection?.transcriptSubscriptions.add(sessionId!);
    return { ok: true, sessionId: sessionId! };
  }

  public transcriptUnsubscribe(sessionId?: string, connection?: DesktopConnection): { ok: boolean } {
    // An unrelated client cannot release another connection's reference.
    if (connection && (!sessionId || !connection.transcriptSubscriptions.delete(sessionId))) return { ok: true };
    const follow = sessionId ? this.transcriptFollows.get(sessionId) : undefined;
    if (!follow) return { ok: true };
    follow.refs -= 1;
    if (follow.refs <= 0) {
      clearInterval(follow.timer);
      this.transcriptFollows.delete(sessionId!);
    }
    return { ok: true };
  }

  private releaseConnection(connection: DesktopConnection): void {
    if (connection.closed) return;
    connection.closed = true;
    for (const sessionId of connection.transcriptSubscriptions) this.transcriptUnsubscribe(sessionId, connection);
    this.connectedSockets.delete(connection);
  }

  /** The TUI WORK pane's own painting, served to the web console. */
  public planSnapshot(sessionId?: string): { ok: boolean; plan: unknown; view?: unknown } {
    const path = this.sessionLogPath(sessionId);
    const log = new EventLog(path, { readOnly: true });
    const plan = readPlanFromLog(log.events);
    if (!plan) {
      return { ok: true, plan: null };
    }
    return { ok: true, plan, view: viewPlan(plan, log.events) };
  }

  /** Hierarchical picker data (routes, recent/favorite pairs, accounts). */
  public async modelCandidates(): Promise<unknown> {
    const models = createHostedModels();
    const routes = BUILTIN_ROUTE_SPECS
      .filter((spec) => spec.name !== "replay")
      .map((spec) => ({
        name: spec.name,
        provider: spec.providerId,
        ...(spec.defaultModel ? { defaultModel: spec.defaultModel } : {}),
      }));
    const selection = resolveLlmSelection();
    const details = buildModelPickerCandidates({
      routes,
      catalogs: hostedModelCatalogs(models),
      selection: { route: selection.route, model: selection.model },
      preferences: readModelPreferences(),
    });
    const auth = new DokkabiAuth();
    const accounts = await auth.list().catch(() => []);
    const authCandidates = authPickerCandidates(accounts);
    return {
      routes: details.filter((detail) => detail.kind === "route").map((detail) => detail.value),
      details,
      authRoutes: authCandidates.map((candidate) => candidate.value),
      authSummaries: Object.fromEntries(authCandidates.map((candidate) => [candidate.value, candidate.summary])),
    };
  }

  /** The one write an observer may make: stage a note into the inbox. Notes
   * for OTHER sessions keep their legacy semantics; a note for the R2-owned
   * gateway workspace session is a mutation behind the workbench command
   * boundary and refuses while the workbench owns that session — with the
   * ownership decision and the inbox write atomic on the shared seam. */
  public async noteSubmit(sessionId?: string, text?: string): Promise<{ ok: boolean; reason?: string }> {
    if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error("a valid sessionId is required");
    }
    const deliver = (): { ok: boolean; reason?: string } => {
      if (typeof text !== "string" || text.trim().length === 0) {
        return { ok: false, reason: "text is required" };
      }
      const dir = join(this.sessionsRoot, sessionId);
      pushOperatorMessage(operatorInboxPath(dir), text);
      this.record("desktop/note_submitted", { sessionId, bytes: text.length });
      this.broadcast({ jsonrpc: "2.0", method: "note.submitted", params: { sessionId } });
      return { ok: true };
    };
    if (sessionId !== this.chatSessionId()) {
      // A recorded branch child participates in the same fence as the
      // gateway workspace session: its input arrives through its own
      // workbench surface, never a staged inherited inbox note (R8-05).
      // The fence also holds on a cold server with no live kernel.
      const fence = this.childSessionFence(sessionId);
      if (fence.owned) {
        this.record("desktop/note_refused", { sessionId, reason: fence.detail === undefined ? "branch_child_session" : "branch_child_unverifiable" });
        return {
          ok: false,
          reason: fence.detail === undefined
            ? `session ${sessionId} is a recorded branch child — use its own workbench surface`
            : `branch child ownership of ${sessionId} cannot be verified (${fence.detail}) — treat it as owned`,
        };
      }
      return deliver();
    }
    return await this.fencedChatMutation("note.submit", deliver);
  }

  // --- Embedded chat kernel ---

  /** The gateway workspace session the desktop chat owns. */
  private chatSessionId(): string {
    return this.ownedSessionId ?? workspaceSessionId(this.workspaceCwd);
  }

  /**
   * The branch-child fence for note.submit and session deletion (R8-05).
   * With a live parent kernel the runtime's durable claims decide. A cold
   * server — before any workbench.bind booted a kernel — derives the SAME
   * authenticated claims read-only from the configured parent session log
   * and its retained reader: reserved intents fence like confirmed
   * completions, with no boot and no reconciliation. An unreadable or
   * invalid parent log fences fail-closed as unverifiable.
   */
  private childSessionFence(sessionId: string): { owned: boolean; detail?: string } {
    const runtime = this.chatKernel?.branchRuntime?.();
    if (runtime !== undefined) {
      try {
        return { owned: runtime.ownsChildSession(sessionId) };
      } catch (error) {
        // A live-runtime fence failure is recorded by the callers as an
        // unverifiable-ownership refusal and fences fail-closed — it never
        // passes through as an error that would stage a note or delete
        // evidence, and it never triggers destructive cleanup.
        const detail = redactText(error instanceof Error ? error.message : String(error)).slice(0, 160);
        return { owned: true, detail: `branch child claims unverifiable: ${detail}` };
      }
    }
    try {
      const parentLogPath = join(this.sessionsRoot, this.chatSessionId(), "events.jsonl");
      if (!existsSync(parentLogPath)) return { owned: false };
      const log = new EventLog(parentLogPath, { readOnly: true });
      if (!log.events.some(row => row.name.startsWith("branch/runtime_"))) return { owned: false };
      const store = BlobStore.forSession(parentLogPath);
      const projection = projectBranchRuntime(log.events,
        digest => (store.has(digest) ? store.get(digest) : undefined));
      for (const view of projection.starts.values()) {
        if (view.childSession === sessionId) return { owned: true };
      }
      return { owned: false };
    } catch (error) {
      const detail = redactText(error instanceof Error ? error.message : String(error)).slice(0, 160);
      return { owned: true, detail: `branch child claims unverifiable: ${detail}` };
    }
  }

  /**
   * The branch-PARENT fence for session deletion (R8-05): this server's own
   * gateway workspace session, when its verified log carries ANY branch
   * runtime row — a reserved creation intent or a confirmed ready completion
   * — is durable authority for recorded children and refuses deletion. The
   * check is read-only and works identically live and cold; an unreadable
   * parent log fences fail-closed as unverifiable.
   */
  private parentClaimsFence(): { owned: boolean; detail?: string } {
    try {
      const parentLogPath = join(this.sessionsRoot, this.chatSessionId(), "events.jsonl");
      if (!existsSync(parentLogPath)) return { owned: false };
      const log = new EventLog(parentLogPath, { readOnly: true });
      return { owned: log.events.some(row => row.name.startsWith("branch/runtime_")) };
    } catch (error) {
      const detail = redactText(error instanceof Error ? error.message : String(error)).slice(0, 160);
      return { owned: true, detail: `branch parent claims unverifiable: ${detail}` };
    }
  }

  /**
   * The R2 ownership fence for legacy chat mutations: the ownership decision
   * AND the mutation's effect run as ONE step on the workbench gateway's
   * serialized chain (`runLegacyMutation`), so a concurrent bind or detach
   * can never interleave between the check and the effect it gated. While a
   * workbench binding, outstanding binding claim, or unresolved workbench
   * command owns the gateway workspace session, the legacy surfaces refuse
   * BEFORE any effect with the rejection recorded in the gateway audit log.
   * With no workbench owner the legacy semantics are unchanged, and the
   * operator's explicit shutdown (stop()/closeChat) is not fenced.
   */
  private async fencedChatMutation<T>(method: string, effect: () => T | Promise<T>): Promise<T> {
    const outcome = await this.workbench.runLegacyMutation(method, effect);
    if (!outcome.refused) {
      return outcome.value;
    }
    this.record("desktop/chat_refused", {
      method,
      reason: outcome.reason,
      ...(outcome.detail ? { detail: outcome.detail } : {}),
    });
    if (outcome.reason === "workbench_ownership_unverifiable") {
      throw new Error(
        `${method} refused: workbench ownership of this workspace cannot be verified (${outcome.detail}) — ` +
          "treat the session as owned and reconcile the gateway ledger first",
      );
    }
    throw new Error(
      `${method} refused: a workbench binding or unresolved workbench command owns this workspace session — ` +
        "use the workbench surface or reconcile it first",
    );
  }

  public async chatOpen(params: { sessionId?: string; resume?: boolean }): Promise<{ ok: boolean; sessionId: string; alreadyOpen?: boolean }> {
    const derived = this.chatSessionId();
    if (params?.sessionId && params.sessionId !== derived) {
      throw new Error(
        `desktop chat owns the gateway workspace session ${derived} — open a terminal chat for other sessions`,
      );
    }
    return await this.fencedChatMutation("chat.open", async () => {
      if (this.chatKernel && this.chatKernel.sessionId === derived) {
        return { ok: true, sessionId: derived, alreadyOpen: true };
      }
      await this.closeChat();
      const kernel = await this.ensureChatKernel(params?.resume === true);
      this.activeSessionId = derived;
      this.record("desktop/chat_opened", { sessionId: derived, resume: params?.resume === true });
      this.broadcast({ jsonrpc: "2.0", method: "chat.opened", params: { sessionId: derived } });
      return { ok: true, sessionId: kernel.sessionId };
    });
  }

  /**
   * The one boot path for the embedded chat kernel. The workbench boundary
   * always resumes; the legacy chat.open surface keeps its explicit resume
   * flag. Settlement observations flow back so the workbench ledger records
   * its receipt only after the session's own durable settlement row.
   *
   * A simultaneous legacy chat.open and workbench bind must produce exactly
   * ONE boot (the second caller would otherwise hit the first's interactive
   * lease, or worse fresh-start the session twice): while a boot is in
   * flight every caller awaits that same promise. The slot is cleared on a
   * failed boot too — the failed boot's lease is released inside the kernel
   * — so an immediate retry is a fresh attempt.
   */
  private async ensureChatKernel(resume: boolean): Promise<DesktopChatKernel> {
    if (this.stopping) {
      throw new Error("the desktop server is stopping — no new chat kernel boots");
    }
    if (this.chatKernel) {
      return this.chatKernel;
    }
    if (this.chatKernelBoot) {
      return this.chatKernelBoot;
    }
    const boot = this.bootChatKernel(resume);
    this.chatKernelBoot = boot;
    try {
      return await boot;
    } finally {
      if (this.chatKernelBoot === boot) {
        this.chatKernelBoot = undefined;
      }
    }
  }

  private async bootChatKernel(resume: boolean): Promise<DesktopChatKernel> {
    await this.closeChat();
    const repoRoot = resolve(import.meta.dir, "..", "..");
    const kernel = await openDesktopChatKernel({
      sessionId: this.chatSessionId(),
      home: dirname(this.sessionsRoot),
      workspaceRoot: this.workspaceCwd,
      repoRoot,
      manifestPath: defaultManifestPath(repoRoot),
      resume,
      turnLifecycle: {
        onTurnSettled: (commandId, outcome) => {
          this.workbench.noteSettlement(commandId, outcome);
        },
      },
    });
    if (this.stopping) {
      // Shutdown began while this boot was in flight: the fresh kernel is
      // disposed instead of published — the stop barrier is draining this
      // very boot, so no exposed ready kernel survives shutdown (disposal
      // is idempotent against the barrier's own close).
      await kernel.dispose();
      throw new Error("the desktop server is stopping — no new chat kernel boots");
    }
    this.chatKernel = kernel;
    this.activeSessionId = kernel.sessionId;
    return kernel;
  }

  public async chatSend(text?: string): Promise<{ ok: boolean; delivery?: string; reason?: string }> {
    return await this.fencedChatMutation("chat.send", () => {
      if (typeof text !== "string" || text.trim().length === 0) {
        return { ok: false, reason: "text is required" };
      }
      const kernel = this.requireChatKernel();
      // submitNote returns immediately: the fence holds the chain only for
      // the handoff, never for the whole model turn.
      const delivery = kernel.submitNote(text);
      this.record("desktop/chat_sent", { sessionId: kernel.sessionId, delivery });
      this.broadcast({
        jsonrpc: "2.0",
        method: "chat.turn",
        params: { sessionId: kernel.sessionId, phase: delivery === "prompt" ? "started" : "queued" },
      });
      if (delivery === "prompt") {
        // The turn indicator: busy flips false when the turn settles. Content
        // itself arrives as transcript.append from the session log.
        const watch = setInterval(() => {
          if (!kernel.busy()) {
            clearInterval(watch);
            this.broadcast({
              jsonrpc: "2.0",
              method: "chat.turn",
              params: { sessionId: kernel.sessionId, phase: "ended" },
            });
          }
        }, 250);
      }
      return { ok: true, delivery };
    });
  }

  public async chatAbort(): Promise<{ aborted: boolean; restored?: string }> {
    return await this.fencedChatMutation("chat.abort", () => {
      const kernel = this.requireChatKernel();
      const result = kernel.abort();
      this.record("desktop/chat_aborted", { sessionId: kernel.sessionId, aborted: result.aborted });
      return result;
    });
  }

  public async chatClose(): Promise<{ ok: boolean }> {
    await this.fencedChatMutation("chat.close", () => this.closeChat());
    return { ok: true };
  }

  public async closeChat(): Promise<void> {
    const kernel = this.chatKernel;
    this.chatKernel = undefined;
    if (!kernel) return;
    await kernel.dispose();
    this.record("desktop/chat_closed", { sessionId: kernel.sessionId });
    this.broadcast({ jsonrpc: "2.0", method: "chat.closed", params: { sessionId: kernel.sessionId } });
  }

  public async chatState(): Promise<{
    owned: boolean;
    sessionId?: string;
    busy?: boolean;
    route?: string;
    model?: string;
    ready?: boolean;
    reason?: string;
  }> {
    if (!this.chatKernel) return { owned: false };
    const status = await this.chatKernel.routeStatus();
    return {
      owned: true,
      sessionId: this.chatKernel.sessionId,
      busy: this.chatKernel.busy(),
      route: status.route,
      ...(status.model ? { model: status.model } : {}),
      ready: status.ready,
      ...(status.reason ? { reason: status.reason } : {}),
    };
  }

  public async chatModel(choice?: string): Promise<{ message?: string; handoff?: unknown }> {
    if (typeof choice !== "string" || choice.trim().length === 0) {
      throw new Error("choice is required");
    }
    return await this.fencedChatMutation("chat.model", async () => {
      const kernel = this.requireChatKernel();
      const result = await kernel.setModel(choice);
      this.record("desktop/chat_model", { sessionId: kernel.sessionId, choice: redactText(choice) });
      if (isHandoffConfirmation(result)) {
        // A large carry needs the operator's landing choice: re-send the choice
        // with " carry" or " slim", exactly like the TUI modal's 1/2 keys.
        return { handoff: result };
      }
      return { message: typeof result === "string" ? redactText(result) : "model selection applied" };
    });
  }

  public async chatEffort(level?: string): Promise<{ message: string }> {
    return await this.fencedChatMutation("chat.effort", () => {
      const kernel = this.requireChatKernel();
      const message = kernel.setEffort(level);
      return { message };
    });
  }

  private requireChatKernel(): DesktopChatKernel {
    if (!this.chatKernel) {
      throw new Error("no chat is open — call chat.open first");
    }
    return this.chatKernel;
  }

  /**
   * Delete a session directory. Two live owners refuse the delete BEFORE any
   * effect, with the refusal recorded and the session log/artifacts left
   * untouched:
   * - a workbench claim on the gateway workspace session (binding, pending
   *   or failed bind intent, unresolved command) — verified synchronously
   *   against the durable ledger, fail-closed, even with no live kernel;
   * - a live holder of the interactive session lease (a CLI chat or this
   *   gateway's own open kernel — the run lock cannot see it). The lease is
   *   RESERVED (acquired) and both guards are held THROUGH the delete, never
   *   probed and released before the effect; a dead stale owner is takeover
   *   debris and may still be deleted per the existing lease policy.
   * A live run lock keeps its existing refusal.
   */
  public deleteSession(sessionId?: string): { ok: boolean; reason?: string } {
    if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
      this.record("desktop/session_delete_refused", { sessionId: String(sessionId), reason: "invalid id" });
      return { ok: false, reason: "invalid session id" };
    }
    const dir = resolve(this.sessionsRoot, sessionId);
    if (dir !== this.sessionsRoot && !dir.startsWith(this.sessionsRoot + sep)) {
      this.record("desktop/session_delete_refused", { sessionId, reason: "escapes sessions root" });
      return { ok: false, reason: "session id escapes the sessions root" };
    }
    if (!existsSync(dir)) {
      return { ok: true };
    }
    // The R2 ownership fence, synchronously verified: the durable claim is
    // published before any workbench boot, so a ledger read cannot miss an
    // in-flight bind. An unreadable ledger owns the session (fail closed).
    const ownership = this.workbench.ownsWorkspaceSessionSync(sessionId);
    if (ownership.owned) {
      const reason =
        ownership.detail === undefined
          ? "workbench_owns_workspace"
          : `workbench_ownership_unverifiable: ${ownership.detail}`;
      this.record("desktop/session_delete_refused", { sessionId, reason });
      return {
        ok: false,
        reason:
          ownership.detail === undefined
            ? `session ${sessionId} is owned by a workbench binding or unresolved command — ` +
              "detach or reconcile the workbench first"
            : `ownership of session ${sessionId} cannot be verified (${ownership.detail}) — ` +
              "treat it as workbench-owned and reconcile the gateway ledger first",
      };
    }
    // A recorded branch child participates in the same deletion fence: its
    // session log, workspace and retained evidence belong to the parent's
    // durable start, not to a bare directory delete (R8-05). The fence also
    // holds on a cold server with no live kernel.
    const childFence = this.childSessionFence(sessionId);
    if (childFence.owned) {
      const reason = childFence.detail === undefined ? "branch_child_session" : `branch_child_unverifiable: ${childFence.detail}`;
      this.record("desktop/session_delete_refused", { sessionId, reason });
      return {
        ok: false,
        reason: childFence.detail === undefined
          ? `session ${sessionId} is a recorded branch child of this gateway's branch runtime — ` +
              "release it through the branch runtime before deleting evidence"
          : `branch child ownership of ${sessionId} cannot be verified (${childFence.detail}) — ` +
              "treat it as owned and reconcile the parent session log first",
      };
    }
    // The PARENT session of recorded branch runtime claims is fenced the
    // same way: its log roots every child's durable start, admission and
    // retained evidence, so deleting it would orphan the children's claims
    // (afterwards every child fence would answer unowned). Reserved intents
    // fence like confirmed completions; nothing is deleted (R8-05).
    if (sessionId === this.chatSessionId()) {
      const parentFence = this.parentClaimsFence();
      if (parentFence.owned) {
        const reason = parentFence.detail === undefined ? "branch_parent_session" : `branch_parent_unverifiable: ${parentFence.detail}`;
        this.record("desktop/session_delete_refused", { sessionId, reason });
        return {
          ok: false,
          reason: parentFence.detail === undefined
            ? `session ${sessionId} is the parent of recorded branch runtime claims — ` +
                "release its children through the branch runtime before deleting parent evidence"
            : `branch parent claims of ${sessionId} cannot be verified (${parentFence.detail}) — ` +
                "treat it as owned and reconcile the branch runtime first",
        };
      }
    }
    // A live run owns its directory: the lock decides, and an acquired guard
    // is HELD until the delete finished — releasing it before the effect
    // would reopen the window it exists to close.
    const probe = acquireSessionRunLock(dir);
    if (!probe.acquired) {
      this.record("desktop/session_delete_refused", { sessionId, reason: `live run holds the lock (pid ${probe.holder})` });
      return { ok: false, reason: `session ${sessionId} is live (pid ${probe.holder}); stop the run first` };
    }
    try {
      // The interactive lease is a RESERVATION, not a probe: acquiring it
      // either holds it against every other chat/desktop kernel through the
      // delete, or refuses because a live owner (any process, including this
      // one) already holds it. A dead owner's lease is taken over, which is
      // the existing stale-lease policy.
      let lease;
      try {
        lease = acquireSessionLease(dir);
      } catch (error) {
        const detail = redactText(error instanceof Error ? error.message : String(error)).slice(0, 160);
        this.record("desktop/session_delete_refused", { sessionId, reason: `live interactive lease (${detail})` });
        return {
          ok: false,
          reason: `session ${sessionId} holds a live interactive chat lease — stop the chat or gateway kernel first (${detail})`,
        };
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        this.record("desktop/session_delete_refused", { sessionId, reason: String(error).slice(0, 160) });
        return { ok: false, reason: "delete failed" };
      } finally {
        lease.release();
      }
    } finally {
      probe.release();
    }
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = undefined;
    }
    this.record("desktop/session_deleted", { sessionId });
    this.broadcast({
      jsonrpc: "2.0",
      method: "session.deleted",
      params: { sessionId },
    });
    return { ok: true };
  }

  // --- Multi-Agent & PTY Terminal Grid ---

  private checkCommandAvailable(cmd: string): boolean {
    try {
      const res = spawnSync(["which", cmd], { timeout: 800 });
      return res.exitCode === 0;
    } catch {
      return false;
    }
  }

  public getAgentProfiles(): AgentProfileConfig[] {
    return [
      {
        id: "dokkabi",
        name: "Dokkabi (도카비 코어)",
        kind: "dokkabi",
        command: "bun",
        args: ["src/cli.ts"],
        defaultCwd: this.workspaceCwd,
        available: this.checkCommandAvailable("bun"),
        icon: "👹",
      },
      {
        id: "claude-code",
        name: "Claude Code",
        kind: "claude-code",
        command: "claude",
        args: [],
        defaultCwd: this.workspaceCwd,
        available: this.checkCommandAvailable("claude"),
        icon: "🟣",
      },
      {
        id: "codex",
        name: "Codex / OpenCode",
        kind: "codex",
        command: "codex",
        args: [],
        defaultCwd: this.workspaceCwd,
        available: this.checkCommandAvailable("codex"),
        icon: "🟢",
      },
      {
        id: "shell",
        name: "System Terminal (Zsh/Bash)",
        kind: "custom",
        command: process.env.SHELL ?? "/bin/zsh",
        args: [],
        defaultCwd: this.workspaceCwd,
        available: true,
        icon: "🖥️",
      },
    ];
  }

  private static shellQuote(token: string): string {
    return `'${token.replace(/'/gu, `'\\''`)}'`;
  }

  /**
   * Build the argv for a terminal. On Linux a util-linux `script` wrapper
   * puts the command on a real pty — TUI agents (claude, codex) render, and
   * input flows through the pty line discipline. On macOS, BSD `script`
   * cannot take piped stdin, so the bundled python runner (pty-run.py)
   * allocates the pty. With neither available the spawn falls back to pipes
   * and `pty: false` says so honestly.
   */
  private buildTerminalArgv(cmd: string, args: string[]): { argv: string[]; pty: boolean } {
    if (process.platform === "darwin") {
      const python = DokkabiDesktopServer.findPtyPython();
      if (python && existsSync(DARWIN_PTY_RUNNER)) {
        return { argv: [python, DARWIN_PTY_RUNNER, cmd, ...args], pty: true };
      }
      return { argv: [cmd, ...args], pty: false };
    }
    if (existsSync(SCRIPT_WRAPPER) && statSync(SCRIPT_WRAPPER).isFile()) {
      const joined = [cmd, ...args].map(DokkabiDesktopServer.shellQuote).join(" ");
      return { argv: [SCRIPT_WRAPPER, "-qefc", joined, "/dev/null"], pty: true };
    }
    return { argv: [cmd, ...args], pty: false };
  }

  // Any python3 with a working stdlib pty module: the CLT interpreter first
  // (present on every machine that can build the Tauri shell), PATH second.
  private static ptyPython: string | null | undefined;
  private static findPtyPython(): string | null {
    if (DokkabiDesktopServer.ptyPython !== undefined) return DokkabiDesktopServer.ptyPython;
    let found: string | null = null;
    if (existsSync("/usr/bin/python3")) {
      found = "/usr/bin/python3";
    } else {
      const res = spawnSync(["which", "python3"], { timeout: 800 });
      const out = res.stdout ? new TextDecoder().decode(res.stdout).trim() : "";
      if (res.exitCode === 0 && out) found = out;
    }
    DokkabiDesktopServer.ptyPython = found;
    return found;
  }

  /**
   * Flush a unix-socket client's queued writes. Bun's socket.write() returns
   * the bytes actually accepted; a short write means the kernel buffer is
   * full and the remainder must be retried from the socket's drain handler.
   */
  private static pumpUnixSocket(
    socket: { write: (data: string) => number; flush: () => void },
    client: { pending: string },
  ): void {
    while (client.pending.length > 0) {
      const written = socket.write(client.pending);
      if (written <= 0) break;
      client.pending = client.pending.slice(written);
      if (client.pending.length > 0) break; // short write: resume on drain
    }
    socket.flush();
  }

  public spawnTerminal(opts: TerminalSpawnOptions): { ok: boolean; terminalId: string; pty: boolean } {
    const id = opts.terminalId || `term_${Date.now()}`;
    const profileKind = opts.profileKind ?? "custom";
    let cmd = opts.command;
    let args = opts.args ?? [];

    if (!cmd) {
      const profile = this.getAgentProfiles().find((p) => p.kind === profileKind);
      if (profile) {
        cmd = profile.command;
        args = profile.args;
      } else {
        cmd = process.env.SHELL ?? "/bin/zsh";
      }
    }
    if (!cmd) return { ok: false, terminalId: id, pty: false };

    const { argv, pty } = this.buildTerminalArgv(cmd, args);
    const proc = spawn(argv, {
      cwd: opts.cwd ?? this.workspaceCwd,
      env: {
        ...process.env,
        ...(opts.env ?? {}),
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        DK_PTY_COLS: String(opts.cols ?? 80),
        DK_PTY_ROWS: String(opts.rows ?? 24),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const terminal: ActiveTerminal = {
      id,
      profileKind,
      command: cmd,
      argv,
      pty,
      process: proc,
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      startedAt: Date.now(),
    };
    this.terminals.set(id, terminal);

    // The audit row records the operator's command, redacted, and env KEYS
    // only — env values can carry credentials the log must never hold.
    this.record("desktop/terminal_spawned", {
      terminalId: id,
      profileKind,
      command: redactText([cmd, ...args].join(" ")).slice(0, 400),
      argv0: argv[0],
      pty,
      cwd: opts.cwd ?? this.workspaceCwd,
      env_keys: opts.env ? Object.keys(opts.env).sort() : [],
    });

    this.streamProcessOutput(id, proc.stdout);
    this.streamProcessOutput(id, proc.stderr);

    proc.exited.then((exitCode) => {
      this.terminals.delete(id);
      this.record("desktop/terminal_exited", { terminalId: id, exitCode });
      this.broadcast({
        jsonrpc: "2.0",
        method: "terminal.exited",
        params: { terminalId: id, exitCode },
      });
    });

    return { ok: true, terminalId: id, pty };
  }

  public splitTerminal(opts: TerminalSplitParams): { ok: boolean; paneId: string; terminalId: string } {
    const paneId = opts.targetPaneId ? `split_${opts.targetPaneId}_${Date.now()}` : `pane_${Date.now()}`;
    const terminalId = `term_${paneId}`;
    const spawnRes = this.spawnTerminal({
      terminalId,
      profileKind: opts.profileKind ?? "custom",
      cwd: opts.cwd ?? this.workspaceCwd,
    });
    this.broadcast({
      jsonrpc: "2.0",
      method: "terminal.split_created",
      params: {
        paneId,
        terminalId,
        direction: opts.direction ?? "vertical",
        profileKind: opts.profileKind ?? "custom",
      },
    });
    return { ok: spawnRes.ok, paneId, terminalId };
  }

  private async streamProcessOutput(terminalId: string, stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        this.broadcast({
          jsonrpc: "2.0",
          method: "terminal.output",
          params: { terminalId, data: text },
        });
      }
    } catch { /* ignore */ }
  }

  public writeTerminal(opts: TerminalInputOptions): { ok: boolean } {
    const term = this.terminals.get(opts.terminalId);
    if (!term || !term.process.stdin) return { ok: false };
    term.process.stdin.write(opts.data);
    term.process.stdin.flush();
    return { ok: true };
  }

  public resizeTerminal(opts: TerminalResizeOptions): { ok: boolean } {
    const term = this.terminals.get(opts.terminalId);
    if (!term) return { ok: false };
    // Recorded intent; the script-wrapper pty does not take TIOCSWINSZ from
    // this side yet, so the row is the honest state of the world.
    term.cols = opts.cols;
    term.rows = opts.rows;
    return { ok: true };
  }

  public killTerminal(terminalId?: string): { ok: boolean } {
    const term = terminalId ? this.terminals.get(terminalId) : undefined;
    if (!term) return { ok: false };
    try {
      term.process.kill();
      this.terminals.delete(terminalId!);
      this.record("desktop/terminal_killed", { terminalId });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  // --- Approvals: the real relay ---

  /** Every pending relay request parked across the catalog's sessions. */
  public listParkedApprovals(): ParkedApprovalItem[] {
    if (!existsSync(this.sessionsRoot)) return [];
    const out: ParkedApprovalItem[] = [];
    for (const entry of readdirSync(this.sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sessionDir = join(this.sessionsRoot, entry.name);
      for (const record of listApprovals(sessionDir)) {
        out.push({
          approvalId: record.request_id,
          sessionId: entry.name,
          kind: record.kind,
          summary: record.summary,
          ...(record.target ? { target: record.target } : {}),
          requestedAt: record.requested_at,
          status: record.status,
        });
      }
    }
    return out.filter((row) => row.status === "pending");
  }

  /**
   * Answer one parked relay request. The relay's waiting operator decision
   * polls this very record, so this is the real 1-tap approve — the agent
   * waiting in its session unblocks on the next poll tick.
   */
  public resolveParkedApproval(sessionId: string, requestId: string, decision: "allow" | "deny"): RelayRecord | undefined {
    const sessionDir = join(this.sessionsRoot, sessionId);
    // Desktop "allow" approves this one request; "session"-wide approval
    // stays an in-terminal operator decision.
    const relayDecision: RelayDecision = decision === "deny" ? "deny" : "once";
    const resolved = decideApproval(sessionDir, requestId, relayDecision);
    this.record("desktop/approval_resolved", {
      sessionId,
      requestId,
      decision: relayDecision,
      ...(resolved ? {} : { outcome: "not_pending" }),
    });
    return resolved;
  }

  /** Gateway-internal approval surface (kept for in-process callers). */
  public requestApproval(approval: Omit<PendingApproval, "createdAt">): Promise<ApprovalResponseParams> {
    const item: PendingApproval = { ...approval, createdAt: Date.now() };
    this.pendingApprovals.set(item.approvalId, item);
    this.record("desktop/approval_request", { approvalId: item.approvalId, kind: item.kind, tool: item.tool });

    this.broadcast({
      jsonrpc: "2.0",
      method: "approval.request",
      params: item,
    });

    return new Promise<ApprovalResponseParams>((resolve) => {
      this.approvalResolvers.set(item.approvalId, resolve);
    });
  }

  public resolveApproval(params: ApprovalResponseParams): { ok: boolean } {
    const resolver = this.approvalResolvers.get(params.approvalId);
    if (!resolver) return { ok: false };
    this.pendingApprovals.delete(params.approvalId);
    this.approvalResolvers.delete(params.approvalId);
    this.record("desktop/approval_resolved", { approvalId: params.approvalId, decision: params.decision });
    resolver(params);

    this.broadcast({
      jsonrpc: "2.0",
      method: "approval.resolved",
      params,
    });
    return { ok: true };
  }

  // --- Tailscale & Mobile Companion ---

  public getTailscaleInfo(): TailscalePairingInfo {
    // App-owned credentials are not exportable mobile/QR pairing material.
    if (this.credentialOwner !== undefined) return {
      installed: false, connected: false, tailscaleIp: null, nodeName: null,
      serverPort: this.port, mobileUrl: "", qrSvg: null,
    };
    let tailscaleIp: string | null = null;
    let nodeName: string | null = null;
    let installed = false;
    let connected = false;

    try {
      const res = spawnSync(["tailscale", "ip", "-4"], { timeout: 1500 });
      if (res.exitCode === 0) {
        installed = true;
        const ip = res.stdout.toString().trim();
        if (ip.startsWith("100.")) {
          tailscaleIp = ip;
          connected = true;
        }
      }
    } catch { /* tailscale cli not found */ }

    if (!tailscaleIp && process.env.TAILSCALE_IP) {
      tailscaleIp = process.env.TAILSCALE_IP.trim();
      connected = true;
    }

    try {
      const res = spawnSync(["tailscale", "status", "--json"], { timeout: 1500 });
      if (res.exitCode === 0) {
        const parsed = JSON.parse(res.stdout.toString());
        nodeName = parsed?.Self?.DNSName ?? null;
      }
    } catch { /* ignore */ }

    // Remote links require the operator's explicit HTTPS proxy origin.
    // Tailnet discovery alone does not authorize plaintext remote exposure.
    const mobileHost = this.host === "0.0.0.0" || this.host === "::"
      ? (tailscaleIp ?? "127.0.0.1")
      : this.host;
    const mobileAuthority = mobileHost.includes(":") ? `[${mobileHost}]` : mobileHost;
    const mobileUrl = `${this.publicOrigin ?? `http://${mobileAuthority}:${this.port}`}/mobile#token=${encodeURIComponent(this.pairingToken)}`;

    let qrSvg: string | null = null;
    try {
      const qr = qrcode(0, "M");
      qr.addData(mobileUrl);
      qr.make();
      qrSvg = qr.createSvgTag({ scalable: true });
    } catch { /* ignore */ }

    return {
      installed,
      connected,
      tailscaleIp,
      nodeName,
      serverPort: this.port,
      mobileUrl,
      qrSvg,
    };
  }

  // --- Git Diff & Workspace Inspection ---

  public getDiffSummary(pathFilter?: string, staged?: boolean): DiffSummary {
    // The workspace is a tree sessions write: git runs inside the read-only
    // fence (git-view) or on the sealed boundary's host-built git directory —
    // never as a plain host process reading the tree's configuration, whose
    // core.fsmonitor, filters and textconv a session chooses (S2, D57e).
    let branch = "HEAD";
    try {
      const bRes = spawnSealedHostGit(this.workspaceCwd, ["--no-optional-locks", "rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 1500 });
      if (bRes.exitCode === 0) {
        branch = bRes.stdout.toString().trim();
      }
    } catch { /* ignore */ }

    let statusOutput = "";
    try {
      const statusRes = gitStatus({ root: this.workspaceCwd });
      if (statusRes.ok) {
        statusOutput = statusRes.text;
      } else {
        const direct = spawnSealedHostGit(this.workspaceCwd, ["--no-optional-locks", "status", "--porcelain"], { timeoutMs: 1500, treeIndex: "display" });
        if (direct.exitCode === 0) {
          statusOutput = direct.stdout.toString();
        }
      }
    } catch { /* ignore */ }

    let diffOutput = "";
    try {
      const diffRes = gitDiff({ root: this.workspaceCwd, staged, path: pathFilter });
      if (diffRes.ok) {
        diffOutput = diffRes.text;
      } else {
        const args = ["diff", "--no-ext-diff", "--no-textconv"];
        if (staged) args.push("--staged");
        if (pathFilter) args.push("--", pathFilter);
        const direct = spawnSealedHostGit(this.workspaceCwd, ["--no-optional-locks", ...args], { timeoutMs: 2000, treeIndex: "display" });
        if (direct.exitCode === 0) {
          diffOutput = direct.stdout.toString();
        }
      }
    } catch { /* ignore */ }

    const files: GitFileDiff[] = [];
    const statusLines = statusOutput.split("\n").filter((l) => l.trim().length > 0);
    let totalAdditions = 0;
    let totalDeletions = 0;

    for (const line of statusLines) {
      const code = line.slice(0, 2);
      const filePath = line.slice(3).trim();
      if (pathFilter && !filePath.includes(pathFilter)) continue;

      let status: GitFileDiff["status"] = "modified";
      if (code.includes("?")) status = "untracked";
      else if (code.includes("A")) status = "added";
      else if (code.includes("D")) status = "deleted";
      else if (code.includes("R")) status = "renamed";

      files.push({
        path: filePath,
        status,
        diffText: "",
        additions: 0,
        deletions: 0,
      });
    }

    const chunks = diffOutput.split(/(?=diff --git a\/)/g);
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const match = chunk.match(/diff --git a\/(.+?)\s+b\/(.+)/);
      if (!match?.[2]) continue;
      const parsedPath = match[2].trim();
      let adds = 0;
      let dels = 0;
      for (const l of chunk.split("\n")) {
        if (l.startsWith("+") && !l.startsWith("+++")) adds++;
        if (l.startsWith("-") && !l.startsWith("---")) dels++;
      }
      totalAdditions += adds;
      totalDeletions += dels;

      const target = files.find((f) => f.path === parsedPath || parsedPath.endsWith(f.path));
      if (target) {
        target.diffText = chunk;
        target.additions = adds;
        target.deletions = dels;
      } else {
        files.push({
          path: parsedPath,
          status: "modified",
          diffText: chunk,
          additions: adds,
          deletions: dels,
        });
      }
    }

    return {
      files,
      totalAdditions,
      totalDeletions,
      branch,
    };
  }

  // --- Telemetry: read-only, and honest about what does not exist ---

  public speculativeMetrics(): SpeculativeMetrics {
    return {
      enabled: false,
      tier: 1,
      totalTurns: 0,
      cacheHits: 0,
      cacheMisses: 0,
      hitRate: 0,
      savedLatencyMs: 0,
    };
  }

  // --- Mobile Companion Single Page App ---

  private renderMobileCompanionHtml(): string {
    return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Dokkabi Mobile Companion</title>
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --accent: #58a6ff;
      --success: #238636;
      --danger: #da3633;
      --warning: #d29922;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      min-height: 100vh;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border);
      padding-bottom: 12px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: bold;
      background: rgba(35, 134, 54, 0.2);
      color: #3fb950;
      border: 1px solid rgba(63, 185, 80, 0.4);
    }
    .badge.offline {
      background: rgba(218, 54, 51, 0.2);
      color: #f85149;
      border-color: rgba(248, 81, 73, 0.4);
    }
    .approval-card {
      background: rgba(210, 153, 34, 0.1);
      border: 2px solid var(--warning);
      border-radius: 12px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    }
    .btn-group {
      display: flex;
      gap: 10px;
      margin-top: 8px;
    }
    button {
      flex: 1;
      padding: 12px;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: bold;
      cursor: pointer;
      color: white;
    }
    .btn-approve { background: var(--success); }
    .btn-reject { background: var(--danger); }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px;
    }
    .terminal-box {
      background: #010409;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      color: #7ee787;
      height: 220px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h2 style="font-size: 18px; color: #fff;">👹 Dokkabi Mobile</h2>
      <p style="font-size: 12px; color: #8b949e;">Tailscale Remote Companion</p>
    </div>
    <span id="conn-badge" class="badge">연결 중...</span>
  </header>

  <div id="approvals-container"></div>

  <div class="card" style="display: flex; gap: 8px; padding: 10px;">
    <button style="background: #238636; flex: 1; padding: 10px; border-radius: 8px; font-size: 13px;" onclick="refreshAll()">🔄 새로고침</button>
    <button style="background: #30363d; flex: 0.7; padding: 10px; border-radius: 8px; font-size: 13px;" onclick="clearTerm()">🧹 지우기</button>
  </div>

  <div class="card">
    <h3 style="font-size: 14px; margin-bottom: 8px; color: var(--accent);">📊 세션 상태</h3>
    <p id="session-info" style="font-size: 13px;">세션 목록 조회 중...</p>
  </div>

  <div class="card">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
      <h3 style="font-size: 14px; color: #58a6ff;">📝 Git 워크스페이스 상태</h3>
      <span id="diff-meta" style="font-size: 11px; color: #8b949e;">조회 중...</span>
    </div>
    <div id="diff-summary-content" style="font-size: 12px; color: var(--text);">변경 파일 로딩 중...</div>
  </div>

  <div class="card" style="display: flex; flex-direction: column; gap: 8px;">
    <h3 style="font-size: 14px; color: #8b949e;">🖥️ 터미널 라이브 출력</h3>
    <div id="terminal-stream" class="terminal-box">터미널 대기 중...</div>
  </div>

  <script>
    const PAIRING_TOKEN = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
    history.replaceState(null, "", window.location.pathname);
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const badge = document.getElementById("conn-badge");
    const term = document.getElementById("terminal-stream");
    const approvalsContainer = document.getElementById("approvals-container");
    const sessionInfo = document.getElementById("session-info");
    const diffMeta = document.getElementById("diff-meta");
    const diffSummaryContent = document.getElementById("diff-summary-content");
    let ws = null;

    function connect() {
      ws = new WebSocket(protocol + "//" + window.location.host + "/ws", ["dokkabi.rpc", "dokkabi.auth." + encodeURIComponent(PAIRING_TOKEN)]);
      ws.onopen = () => {
        badge.textContent = "● 온라인";
        badge.className = "badge";
        refreshAll();
      };
      ws.onclose = () => {
        badge.textContent = "○ 오프라인";
        badge.className = "badge offline";
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.method === "terminal.output" && msg.params?.data) {
            const active = msg.params.terminalId;
            term.dataset.terminalId = term.dataset.terminalId ?? active;
            if (term.dataset.terminalId === active) {
              term.textContent += msg.params.data;
              term.scrollTop = term.scrollHeight;
            }
          } else if (msg.method === "approval.request") {
            renderApproval(msg.params);
          } else if (msg.method === "approval.resolved") {
            const card = document.getElementById("appr-" + msg.params.approvalId);
            if (card) card.remove();
          } else if (msg.id === "init-approvals" && Array.isArray(msg.result)) {
            approvalsContainer.innerHTML = "";
            msg.result.forEach(renderApproval);
          } else if (msg.id === "init-sessions" && Array.isArray(msg.result)) {
            if (msg.result.length > 0) {
              const active = msg.result[0];
              sessionInfo.innerHTML =
                "<strong>ID:</strong> " + escapeHtml(String(active.id)) +
                "<br><strong>목표:</strong> " + escapeHtml(String(active.goal ?? "(없음)")) +
                "<br><strong>턴:</strong> " + Number(active.turns) + "회 | <strong>이벤트:</strong> " + Number(active.events) + "개";
            } else {
              sessionInfo.textContent = "활성 세션이 없습니다.";
            }
          } else if ((msg.id === "init-diff" || msg.method === "diff.updated") && msg.result?.branch) {
            renderDiff(msg.result);
          }
        } catch (err) {
          console.error(err);
        }
      };
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function sendRpc(id, method, params) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      }
    }

    function refreshAll() {
      sendRpc("init-sessions", "session.list");
      sendRpc("init-approvals", "approval.list");
      sendRpc("init-diff", "diff.get");
    }

    function renderDiff(diff) {
      diffMeta.textContent = "⎇ " + diff.branch + " (+" + diff.totalAdditions + " -" + diff.totalDeletions + ")";
      if (diff.files.length === 0) {
        diffSummaryContent.textContent = "깨끗함 (Clean working directory)";
      } else {
        diffSummaryContent.innerHTML = diff.files.slice(0, 5).map(f =>
          '<div style="padding: 2px 0;">• ' + escapeHtml(f.path) +
          ' <span style="color: #7ee787;">[+' + Number(f.additions) + " -" + Number(f.deletions) + "]</span></div>"
        ).join("") + (diff.files.length > 5
          ? '<div style="color: #8b949e; margin-top: 4px;">... 외 ' + (diff.files.length - 5) + "개 파일</div>"
          : "");
      }
    }

    function clearTerm() {
      term.textContent = "";
    }

    function renderApproval(appr) {
      if (!appr || document.getElementById("appr-" + appr.approvalId)) return;
      const card = document.createElement("div");
      card.id = "appr-" + appr.approvalId;
      card.className = "approval-card";
      const tool = document.createElement("div");
      tool.style.cssText = "font-weight: bold; color: var(--warning);";
      tool.textContent = "⚠️ 승인 대기: " + (appr.kind ?? appr.tool ?? "작업");
      const summary = document.createElement("div");
      summary.style.cssText = "font-size: 13px;";
      summary.textContent = appr.summary ?? appr.reason ?? "";
      const detail = document.createElement("pre");
      detail.style.cssText = "background: rgba(0,0,0,0.4); padding: 8px; border-radius: 6px; font-size: 11px; overflow-x: auto;";
      detail.textContent = appr.args ? JSON.stringify(appr.args, null, 2) : (appr.target ? "target: " + appr.target : "");
      const group = document.createElement("div");
      group.className = "btn-group";
      const approve = document.createElement("button");
      approve.className = "btn-approve";
      approve.textContent = "1-Tap 승인";
      approve.onclick = () => respondApproval(appr.sessionId, appr.approvalId, "allow");
      const reject = document.createElement("button");
      reject.className = "btn-reject";
      reject.textContent = "반려";
      reject.onclick = () => respondApproval(appr.sessionId, appr.approvalId, "deny");
      group.append(approve, reject);
      card.append(tool, summary, detail, group);
      approvalsContainer.appendChild(card);
    }

    function respondApproval(sessionId, approvalId, decision) {
      sendRpc("resp-" + Date.now(), "approval.respond", { sessionId, approvalId, decision });
    }

    connect();
  </script>
</body>
</html>`;
  }
}
