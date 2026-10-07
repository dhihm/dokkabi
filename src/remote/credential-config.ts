import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { resolveRemoteLocale, type RemoteLocale } from "./locale.ts";

export const REMOTE_CONFIG_CREDENTIAL = "dokkabi-remote-config";
export const DISCORD_TOKEN_CREDENTIAL = "dokkabi-discord-token";

const CredentialNameSchema = z.string().regex(/^[A-Za-z0-9_.-]+$/u);
const WorkerCommandSchema = z.array(z.string().trim().min(1)).min(1).readonly();

const DiscordSchema = z.strictObject({
  channel_id: z.string().trim().min(1),
  guild_id: z.string().trim().min(1),
  operator_id: z.string().trim().min(1),
});

const VpnSchema = z.strictObject({
  channel_id: z.string().trim().min(1).optional(),
  locale: z.enum(["en", "ko"]).optional(),
  monitor_interval_ms: z.number().int().min(1_000).optional(),
  // Read for compatibility with earlier credentials; repeated outage notices
  // are intentionally disabled and this value has no runtime effect.
  reminder_interval_ms: z.number().int().min(60_000).optional(),
  stability_interval_ms: z.number().int().min(500).optional(),
  stability_polls: z.number().int().min(2).max(10).optional(),
  worker_command: WorkerCommandSchema,
});

const RemoteCredentialSchema = z.strictObject({
  schema_version: z.literal(1),
  discord: DiscordSchema,
  remote: z.strictObject({ locale: z.enum(["en", "ko"]).optional() }).optional(),
  vpn: VpnSchema.optional(),
});

export type RemoteCredential = z.infer<typeof RemoteCredentialSchema>;

export type RemoteCredentialConfiguration =
  | { readonly active: false; readonly reason: string; readonly kind: "not_configured" | "invalid_configuration" }
  | { readonly active: true; readonly config: RemoteCredential };

export function readRemoteCredentialConfig(
  env: NodeJS.Dict<string> = process.env,
): RemoteCredentialConfiguration {
  const path = credentialPath(env, REMOTE_CONFIG_CREDENTIAL, "DOKKABI_REMOTE_CONFIG_FILE");
  const body = path ? readSecureText(path, 64 * 1_024) : undefined;
  if (!body) {
    return { active: false, reason: "Remote configuration credential is unavailable.", kind: "not_configured" };
  }
  try {
    const parsed = RemoteCredentialSchema.safeParse(JSON.parse(body));
    return parsed.success
      ? { active: true, config: parsed.data }
      : { active: false, reason: "Remote configuration credential is invalid.", kind: "invalid_configuration" };
  } catch {
    return { active: false, reason: "Remote configuration credential is invalid.", kind: "invalid_configuration" };
  }
}

export function readDiscordTokenCredential(
  env: NodeJS.Dict<string> = process.env,
): string | undefined {
  const path = credentialPath(
    env,
    DISCORD_TOKEN_CREDENTIAL,
    "DOKKABI_DISCORD_BOT_TOKEN_FILE",
  );
  const token = path ? readSecureText(path, 16 * 1_024)?.trim() : undefined;
  return token || undefined;
}

export function remoteCredentialLocale(config: RemoteCredential): RemoteLocale {
  return resolveRemoteLocale(config.remote?.locale);
}

export function resolveCredentialArguments(
  command: readonly string[],
  env: NodeJS.Dict<string> = process.env,
): readonly string[] | undefined {
  const directory = env.CREDENTIALS_DIRECTORY?.trim();
  const resolved: string[] = [];
  for (const argument of command) {
    if (!argument.startsWith("credential:")) {
      resolved.push(argument);
      continue;
    }
    const parsed = CredentialNameSchema.safeParse(argument.slice("credential:".length));
    if (!directory || !parsed.success) return undefined;
    resolved.push(join(directory, parsed.data));
  }
  return resolved;
}

function credentialPath(
  env: NodeJS.Dict<string>,
  name: string,
  override: string,
): string | undefined {
  const directory = env.CREDENTIALS_DIRECTORY?.trim();
  if (directory) return join(directory, name);
  return env[override]?.trim() || undefined;
}

function readSecureText(path: string, maxBytes: number): string | undefined {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) return undefined;
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
