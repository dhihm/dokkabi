import type { DiscordGatewayConfig } from "./discord-wire.ts";
import {
  readDiscordTokenCredentialStatus,
  readRemoteCredentialConfig,
} from "./credential-config.ts";

export type DiscordRemoteConfiguration =
  | { readonly active: false; readonly reason: string; readonly kind: "not_configured" | "invalid_configuration" }
  | { readonly active: true; readonly config: DiscordGatewayConfig };

export function readDiscordRemoteConfig(
  env: NodeJS.Dict<string> = process.env,
): DiscordRemoteConfiguration {
  const deployment = readRemoteCredentialConfig(env);
  if (!deployment.active) {
    return { active: false, reason: deployment.reason, kind: deployment.kind };
  }
  const token = readDiscordTokenCredentialStatus(env);
  if (!token.configured) {
    return { active: false, reason: token.reason, kind: token.kind };
  }
  return {
    active: true,
    config: {
      botToken: token.token,
      channelId: deployment.config.discord.channel_id,
      guildId: deployment.config.discord.guild_id,
      operatorId: deployment.config.discord.operator_id,
    },
  };
}
