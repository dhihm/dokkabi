import type { DiscordGatewayConfig } from "./discord-wire.ts";
import {
  readDiscordTokenCredential,
  readRemoteCredentialConfig,
} from "./credential-config.ts";

export type DiscordRemoteConfiguration =
  | { readonly active: false; readonly reason: string; readonly kind: "not_configured" | "invalid_configuration" }
  | { readonly active: true; readonly config: DiscordGatewayConfig };

export function readDiscordRemoteConfig(
  env: NodeJS.Dict<string> = process.env,
): DiscordRemoteConfiguration {
  const deployment = readRemoteCredentialConfig(env);
  const botToken = readDiscordTokenCredential(env);
  if (!deployment.active || !botToken) {
    return {
      active: false,
      reason: "Discord remote requires bot token, guild, channel, and operator configuration.",
      // An invalid deployment credential says so; an absent one is not configured.
      kind: !deployment.active ? deployment.kind : "not_configured",
    };
  }
  return {
    active: true,
    config: {
      botToken,
      channelId: deployment.config.discord.channel_id,
      guildId: deployment.config.discord.guild_id,
      operatorId: deployment.config.discord.operator_id,
    },
  };
}
