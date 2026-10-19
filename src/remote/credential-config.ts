import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z, type ZodError } from "zod";
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
  if (!path) {
    return {
      active: false,
      reason: "Remote configuration credential is not configured.",
      kind: "not_configured",
    };
  }
  const body = readSecureCredentialText(path, 64 * 1_024, "Remote configuration credential");
  if (!body.ok) {
    return { active: false, reason: body.reason, kind: body.kind };
  }
  try {
    const parsed = RemoteCredentialSchema.safeParse(JSON.parse(body.text));
    return parsed.success
      ? { active: true, config: parsed.data }
      : {
          active: false,
          reason: remoteCredentialInvalidReason(parsed.error),
          kind: "invalid_configuration",
        };
  } catch {
    return {
      active: false,
      reason: "Remote configuration credential is invalid: file is not valid JSON.",
      kind: "invalid_configuration",
    };
  }
}

export function readDiscordTokenCredential(
  env: NodeJS.Dict<string> = process.env,
): string | undefined {
  const status = readDiscordTokenCredentialStatus(env);
  return status.configured ? status.token : undefined;
}

export type DiscordTokenCredentialStatus =
  | { readonly configured: false; readonly reason: string; readonly kind: "not_configured" | "invalid_configuration" }
  | { readonly configured: true; readonly token: string };

export function readDiscordTokenCredentialStatus(
  env: NodeJS.Dict<string> = process.env,
): DiscordTokenCredentialStatus {
  const path = credentialPath(
    env,
    DISCORD_TOKEN_CREDENTIAL,
    "DOKKABI_DISCORD_BOT_TOKEN_FILE",
  );
  if (!path) {
    return {
      configured: false,
      reason: "Discord bot token credential is not configured.",
      kind: "not_configured",
    };
  }
  const body = readSecureCredentialText(path, 16 * 1_024, "Discord bot token credential");
  if (!body.ok) {
    return { configured: false, reason: body.reason, kind: body.kind };
  }
  const token = body.text.trim();
  if (!token) {
    return {
      configured: false,
      reason: "Discord bot token credential is empty.",
      kind: "invalid_configuration",
    };
  }
  return { configured: true, token };
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

type SecureCredentialReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string; readonly kind: "not_configured" | "invalid_configuration" };

function readSecureCredentialText(
  path: string,
  maxBytes: number,
  label: string,
): SecureCredentialReadResult {
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) {
      return {
        ok: false,
        kind: "invalid_configuration",
        reason: `${label} file must be a regular file, not a symbolic link.`,
      };
    }
    if (!metadata.isFile()) {
      return {
        ok: false,
        kind: "invalid_configuration",
        reason: `${label} file was not found.`,
      };
    }
    if (metadata.size > maxBytes) {
      return {
        ok: false,
        kind: "invalid_configuration",
        reason: `${label} file is too large.`,
      };
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      return {
        ok: false,
        kind: "invalid_configuration",
        reason: `${label} file permissions are too permissive.`,
      };
    }
    return { ok: true, text: readFileSync(path, "utf8") };
  } catch (error) {
    if (isEnoent(error)) {
      return {
        ok: false,
        kind: "invalid_configuration",
        reason: `${label} file was not found.`,
      };
    }
    return {
      ok: false,
      kind: "invalid_configuration",
      reason: `${label} file is unavailable.`,
    };
  }
}

function remoteCredentialInvalidReason(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Remote configuration credential is invalid.";
  const path = issue.path.map(String).join(".");
  return path.length > 0
    ? `Remote configuration credential is invalid: missing or invalid field "${path}".`
    : "Remote configuration credential is invalid.";
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: string }).code === "ENOENT";
}
