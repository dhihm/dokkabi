import { projectSessionTree, type SessionRelation } from "./session-tree.ts";
import { listSessionIndex, type SessionRow } from "./session-scan.ts";

export { listSessionIndex, listSessions } from "./session-scan.ts";
export type { SessionRow } from "./session-scan.ts";

function fmtAge(ms: number): string {
  if (ms <= 0) {
    return "now";
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return "now";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

function fmtK(value: number | "missing"): string {
  if (value === "missing") {
    return "missing";
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${value}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

/** Render the sessions pane: summary line plus one line per session. */
export function sessionsPaneLines(
  rows: readonly SessionRow[],
  width: number,
  relations: readonly SessionRelation[] = [],
): string[] {
  const now = Date.now();
  const active = rows.filter((row) => now - row.lastTs < 5 * 60_000).length;
  const events = rows.reduce((sum, row) => sum + row.events, 0);
  const bytes = rows.reduce((sum, row) => sum + row.bytes, 0);
  const lines: string[] = [
    `sessions=${rows.length} active=${active} events=${events} bytes=${fmtK(bytes)}`,
  ];
  if (rows.length === 0) {
    lines.push("(no sessions found)");
    return lines;
  }
  for (const node of projectSessionTree(rows, relations)) {
    const row = node.row;
    const indent = node.depth > 0 ? `${"  ".repeat(node.depth - 1)}└─ ` : "";
    if (!row) {
      lines.push(clip(`${indent}${node.id} missing role=${node.role ?? "missing"}`, width));
      continue;
    }
    const pct =
      typeof row.contextUsed === "number" && typeof row.contextWindow === "number" && row.contextWindow > 0
        ? `${Math.round((row.contextUsed / row.contextWindow) * 100)}%`
        : "missing";
    const status = row.status === "missing" ? "missing" : row.status;
    const err = row.lastError ? " err" : "";
    const lineage = node.lineageError ? ` lineage=${node.lineageError}` : "";
    const child = node.role
      ? ` role=${node.role} route=${node.route ?? "missing"} child=${node.childStatus ?? "running"} digest=${node.replayDigest && node.replayDigest !== "missing" ? "ok" : "missing"} contract=${node.contractIntegrity ?? "missing"} result=${node.resultIntegrity ?? "missing"}`
      : row.finalized
        ? ` finalized=yes patch=${row.patchDigest?.slice(0, 8) ?? "missing"}`
        : "";
    const head = `${indent}${row.id} ${status}${err}${child}${lineage} age=${fmtAge(now - row.lastTs)} ctx=${pct} n=${row.compactions} turns=${row.turns} in=${fmtK(row.inSum)} out=${fmtK(row.outSum)}`;
    lines.push(head.slice(0, width));
    if (row.goal) {
      lines.push(clip(`  ${row.goal}`, Math.max(20, Math.min(width, 100))));
    }
  }
  return lines;
}

export function sessionsRootPaneLines(sessionsRoot: string, width: number): string[] {
  const index = listSessionIndex(sessionsRoot);
  return sessionsPaneLines(index.rows, width, index.relations);
}
