import { z } from "zod";
import type { RemoteIngress } from "./types.ts";

const EnvelopeSchema = z.object({
  d: z.unknown(),
  op: z.number().int(),
  s: z.number().int().nullable().optional(),
  t: z.string().nullable().optional(),
});

const HelloSchema = z.object({ heartbeat_interval: z.number().positive() });
const ReadySchema = z.object({
  resume_gateway_url: z.string().optional(),
  session_id: z.string(),
  user: z.object({ id: z.string() }),
});
const MessageSchema = z.object({
  author: z.object({ bot: z.boolean().optional(), id: z.string() }),
  channel_id: z.string(),
  content: z.string(),
  guild_id: z.string().optional(),
  id: z.string(),
});

export type DiscordEnvelope = z.infer<typeof EnvelopeSchema>;

export interface DiscordGatewayConfig {
  readonly botToken: string;
  readonly channelId: string;
  readonly guildId: string;
  readonly operatorId: string;
}

export function parseDiscordEnvelope(raw: unknown): DiscordEnvelope | undefined {
  try {
    const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    const parsed = EnvelopeSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export function parseDiscordHello(value: unknown): number | undefined {
  const parsed = HelloSchema.safeParse(value);
  return parsed.success ? parsed.data.heartbeat_interval : undefined;
}

export function parseDiscordReady(value: unknown): z.infer<typeof ReadySchema> | undefined {
  const parsed = ReadySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseDiscordIngress(
  envelope: DiscordEnvelope,
  adapterId: string,
  config: DiscordGatewayConfig,
): RemoteIngress | undefined {
  if (envelope.t !== "MESSAGE_CREATE") return undefined;
  const parsed = MessageSchema.safeParse(envelope.d);
  if (!parsed.success) return undefined;
  const message = parsed.data;
  if (
    message.guild_id !== config.guildId
    || message.channel_id !== config.channelId
    || message.author.id !== config.operatorId
    || message.author.bot === true
  ) return undefined;
  const command = parseDiscordCommand(message.content);
  if (!command) return undefined;
  return {
    adapterId,
    channelId: message.channel_id,
    command,
    externalId: message.id,
    operatorId: message.author.id,
  };
}

export function parseDiscordCommand(text: string): RemoteIngress["command"] | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed === "/status") return { kind: "status" };
  if (trimmed === "/cancel") return { kind: "cancel" };
  if (trimmed.startsWith("/note ")) return { kind: "note", text: trimmed.slice(6).trim() };
  return { kind: "work", text: trimmed };
}
