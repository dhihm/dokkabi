import { createHash } from "node:crypto";
import ky from "ky";
import { z } from "zod";
import type { RemoteDelivery } from "./types.ts";

const DiscordMessageSchema = z.object({ id: z.string() });

interface DiscordRestInput {
  readonly apiBaseUrl?: string;
  readonly botToken: string;
}

export interface DiscordRestClient {
  deliver(delivery: RemoteDelivery): Promise<{ readonly externalMessageId: string }>;
}

export class DiscordRestError extends Error {
  constructor(readonly operation: string, readonly reason: string, cause?: Error) {
    super(`${operation}: ${reason}`, cause ? { cause } : undefined);
    this.name = "DiscordRestError";
  }
}

export function discordDeliveryNonce(deliveryId: string): string {
  return createHash("sha256").update(deliveryId).digest("hex").slice(0, 24);
}

export function createDiscordRestClient(input: DiscordRestInput): DiscordRestClient {
  const client = ky.create({
    prefix: `${(input.apiBaseUrl ?? "https://discord.com/api/v10").replace(/\/$/u, "")}/`,
    headers: { authorization: `Bot ${input.botToken}` },
    timeout: 10_000,
    retry: {
      limit: 3,
      methods: ["post"],
      statusCodes: [408, 429, 500, 502, 503, 504],
    },
  });
  return {
    async deliver(delivery) {
      try {
        const payload: unknown = await client.post(
          `channels/${encodeURIComponent(delivery.channelId)}/messages`,
          {
            json: {
              content: delivery.text,
              enforce_nonce: true,
              nonce: discordDeliveryNonce(delivery.deliveryId),
            },
          },
        ).json();
        const parsed = DiscordMessageSchema.safeParse(payload);
        if (!parsed.success) {
          throw new DiscordRestError("create Discord message", "response has no message id");
        }
        return { externalMessageId: parsed.data.id };
      } catch (error) {
        if (error instanceof DiscordRestError) throw error;
        if (error instanceof Error) {
          throw new DiscordRestError("create Discord message", error.message, error);
        }
        throw error;
      }
    },
  };
}
