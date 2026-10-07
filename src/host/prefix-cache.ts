/** Honest prefix-cache oracle. Same rule Codex uses: longest shared prefix, then tokens. */

export function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

export function commonPrefix(left: string, right: string): string {
  const n = Math.min(left.length, right.length);
  let i = 0;
  while (i < n && left[i] === right[i]) {
    i += 1;
  }
  return left.slice(0, i);
}

export function serializeModelContext(context: {
  systemPrompt?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  tools?: Array<{ name?: string; description?: string }>;
}): string {
  const tools = (context.tools ?? [])
    .map((tool) => `${tool.name ?? ""}:${tool.description ?? ""}`)
    .join("|");
  const messages = (context.messages ?? []).map(messageText).join("\n");
  return `${context.systemPrompt ?? ""}\n${tools}\n${messages}`;
}

function messageText(message: { role?: string; content?: unknown }): string {
  const role = message.role ?? "";
  const content = message.content;
  if (typeof content === "string") {
    return `${role}:${content}`;
  }
  if (Array.isArray(content)) {
    return `${role}:${content.map(partText).join("")}`;
  }
  return `${role}:${content === undefined ? "" : JSON.stringify(content)}`;
}

function partText(part: unknown): string {
  if (typeof part === "string") {
    return part;
  }
  if (part && typeof part === "object" && "text" in part && typeof (part as { text: unknown }).text === "string") {
    return (part as { text: string }).text;
  }
  return JSON.stringify(part);
}

export interface PrefixCacheSample {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  hit: number;
  total: number;
}

export class PrefixCacheMeter {
  private readonly last = new Map<string, string>();

  measure(
    sessionId: string,
    context: {
      systemPrompt?: string;
      messages?: Array<{ role?: string; content?: unknown }>;
      tools?: Array<{ name?: string; description?: string }>;
    },
  ): PrefixCacheSample {
    const text = serializeModelContext(context);
    const previous = this.last.get(sessionId);
    this.last.set(sessionId, text);
    const total = estimateTokens(text);
    if (!previous) {
      return { input: total, cacheRead: 0, cacheWrite: total, hit: 0, total };
    }
    const prefix = commonPrefix(previous, text);
    const cacheRead = estimateTokens(prefix);
    const cacheWrite = estimateTokens(text.slice(prefix.length));
    const input = Math.max(0, total - cacheRead);
    return {
      input,
      cacheRead,
      cacheWrite,
      hit: total <= 0 ? 0 : cacheRead / total,
      total,
    };
  }
}
