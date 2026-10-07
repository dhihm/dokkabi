import { normalizeHomePaths, redactText } from "./redact.ts";

export const SLOW_TOOL_MS = 2000;
export const LARGE_RESULT_BYTES = 50_000;
export const BUSY_CPU_PCT = 80;

export interface SlowToolInput {
  duration_ms: number | "missing";
  result_bytes: number;
  overlap: number;
  error: boolean;
  cpu_pct: number | "missing";
  name: string;
  arg_hint: string;
}

export function classifySlowTool(input: SlowToolInput): string[] | undefined {
  if (typeof input.duration_ms !== "number" || input.duration_ms < SLOW_TOOL_MS) {
    return undefined;
  }
  const reasons: string[] = [];
  if (input.error) {
    reasons.push("error");
  }
  if (input.result_bytes >= LARGE_RESULT_BYTES) {
    reasons.push("large_result");
  }
  if (input.overlap >= 2) {
    reasons.push("overlap");
  }
  if (typeof input.cpu_pct === "number" && input.cpu_pct >= BUSY_CPU_PCT) {
    reasons.push("busy_host");
  }
  if (input.name === "bash_wait") {
    reasons.push("condition_wait");
  }
  if (intentionalWaitMs(input) !== undefined) {
    reasons.push("intentional_wait");
  }
  if (input.name === "bash" && /(?:^|\s)(?:bun\s+test|npm\s+test|pytest)\b/i.test(input.arg_hint)) {
    reasons.push("bash_test");
  }
  // ssh latency is on the far host — a remote build, a slow network, a busy
  // server — not the harness. Saying "remote" tells the operator the cost is
  // client-unfixable, where a bare "missing" (161 of 246 live slow ssh calls)
  // told them nothing.
  if (input.name === "ssh") {
    reasons.push("remote");
  }
  if (reasons.length === 0) {
    reasons.push("missing");
  }
  return reasons;
}

/** Parse only a literal leading sleep. Shell expressions and later sleeps do
 * not become cost facts because their actual duration cannot be inferred from
 * the bounded argument hint. */
export function intentionalWaitMs(input: Pick<SlowToolInput, "name" | "arg_hint">): number | undefined {
  if (input.name !== "bash") return undefined;
  const match = input.arg_hint.match(/^\s*sleep\s+(\d+(?:\.\d+)?)\b/i);
  if (!match?.[1]) return undefined;
  const milliseconds = Number(match[1]) * 1_000;
  return Number.isFinite(milliseconds) && milliseconds > 0
    ? Math.round(milliseconds)
    : undefined;
}

export function safeArgHint(name: string, args: unknown): string {
  if (!args || typeof args !== "object") {
    return "";
  }
  const record = args as Record<string, unknown>;
  if (name === "bash" && typeof record.command === "string") {
    return clipHint(record.command);
  }
  if (name === "ssh" && typeof record.target === "string") {
    return clipHint(record.target);
  }
  if (typeof record.path === "string") {
    return clipHint(record.path);
  }
  return "";
}

function clipHint(text: string): string {
  // The hint is durable: normalize the account name out of home paths first
  // (the normalization shortens, so the clip bound still holds), then mask
  // anything secret-shaped that survived the caller's own check.
  const flat = normalizeHomePaths(text).replaceAll("\n", " ").trim();
  const clipped = flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
  return redactText(clipped);
}
