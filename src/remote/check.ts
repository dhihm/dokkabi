import { readDiscordRemoteConfig } from "./discord-config.ts";
import { validateRemoteStatusLine } from "./status.ts";

export interface RemoteCheckStatus {
  readonly remote: string;
  readonly exitCode: number;
  readonly reason?: string;
}

/** Operator-facing status for `dokkabi remote --check` without starting transport. */
export function remoteCheckStatus(env: NodeJS.Dict<string> = process.env): RemoteCheckStatus {
  const configured = readDiscordRemoteConfig(env);
  if (configured.active) {
    return { remote: "discord", exitCode: 0 };
  }
  return {
    remote: configured.kind === "invalid_configuration" ? "invalid" : "unconfigured",
    exitCode: 1,
    reason: configured.reason,
  };
}

export function formatRemoteCheckReasonLine(reason: string): string {
  return validateRemoteStatusLine(`reason=${reason.trim()}`);
}
