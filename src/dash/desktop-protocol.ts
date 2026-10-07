/**
 * Dokkabi Desktop JSON-RPC 2.0 Protocol & Types.
 * Defines bidirectional communication between Dokkabi Core daemon,
 * Tauri v2 native desktop app, and Tailscale mobile companion.
 */

export type AgentProfileKind = "dokkabi" | "claude-code" | "codex" | "custom";

export interface AgentProfileConfig {
  id: string;
  name: string;
  kind: AgentProfileKind;
  command: string;
  args: string[];
  env?: Record<string, string>;
  defaultCwd?: string;
  icon?: string;
  available?: boolean;
  version?: string;
}

export interface DesktopSessionItem {
  id: string;
  status: string;
  goal: string;
  turns: number;
  events: number;
  lastTs: number;
  workspacePath?: string;
  profileKind: AgentProfileKind;
  active: boolean;
}

export interface PendingApproval {
  approvalId: string;
  sessionId: string;
  kind: "operator" | "github" | "mcp" | "ssh";
  severity: "low" | "medium" | "high" | "critical";
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  createdAt: number;
}

export interface ApprovalResponseParams {
  approvalId: string;
  decision: "allow" | "deny" | "modify";
  modifiedArgs?: Record<string, unknown>;
  operatorNote?: string;
}

export interface TerminalSpawnOptions {
  terminalId: string;
  profileKind?: AgentProfileKind;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface TerminalResizeOptions {
  terminalId: string;
  cols: number;
  rows: number;
}

export interface TerminalInputOptions {
  terminalId: string;
  data: string;
}

export interface TailscalePairingInfo {
  installed: boolean;
  connected: boolean;
  tailscaleIp: string | null;
  nodeName: string | null;
  serverPort: number;
  mobileUrl: string | null;
  qrSvg: string | null;
}

export interface SpeculativeMetrics {
  enabled: boolean;
  tier: 1 | 2 | 3;
  totalTurns: number;
  cacheHits: number;
  cacheMisses: number;
  hitRate: number;
  savedLatencyMs: number;
  lastSpeculation?: {
    tool: string;
    targetPath?: string;
    result: "hit" | "miss" | "discarded";
  };
}

export interface GitFileDiff {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  diffText: string;
  additions: number;
  deletions: number;
}

export interface DiffSummary {
  files: GitFileDiff[];
  totalAdditions: number;
  totalDeletions: number;
  branch: string;
}

export interface SessionCreateParams {
  sessionId?: string;
  profileKind?: AgentProfileKind;
  goal?: string;
  workspace?: string;
  command?: string;
  args?: string[];
}

export interface SessionDeleteParams {
  sessionId: string;
}

export interface TerminalSplitParams {
  targetPaneId?: string;
  direction?: "horizontal" | "vertical";
  profileKind?: AgentProfileKind;
  cwd?: string;
}

// JSON-RPC 2.0 Base Messages
export interface JsonRpcRequest<T = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: T;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification<T = unknown> {
  jsonrpc: "2.0";
  method: string;
  params: T;
}
