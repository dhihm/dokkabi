import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import type { SandboxHostExecutableSeal } from "./sandbox-executable.ts";
import { SSH_ALIAS_PATTERN } from "./ssh-aliases.ts";

type AuthorityInput = Readonly<{
  alias: string;
  configPath: string;
  env: Readonly<Record<string, string>>;
  executable: SandboxHostExecutableSeal;
  reportCleanupFailure: () => void;
}>;

export class SshWarmupTransportAuthority {
  readonly alias: string;
  readonly configPath: string;
  readonly env: Readonly<Record<string, string>>;
  readonly executable: SandboxHostExecutableSeal;
  readonly identity: string;
  readonly configIdentity: string;
  readonly reportCleanupFailure: () => void;

  private constructor(input: AuthorityInput, configIdentity: string) {
    this.alias = input.alias;
    this.configPath = input.configPath;
    this.env = Object.freeze({ ...input.env });
    this.executable = input.executable;
    this.configIdentity = configIdentity;
    this.identity = authorityIdentity(input, configIdentity);
    this.reportCleanupFailure = input.reportCleanupFailure;
    Object.freeze(this);
  }

  static registerForService(input: AuthorityInput): SshWarmupTransportAuthority {
    if (!SSH_ALIAS_PATTERN.test(input.alias)) throw new SshWarmupAuthorityError("SSH warmup alias is invalid");
    const config = readConfig(input.configPath);
    if (hasUnsealedRouting(config.bytes.toString("utf8"))) {
      throw new SshWarmupAuthorityError("SSH config routing dependencies cannot be sealed");
    }
    if (!hasEnrolledAlias(config.bytes.toString("utf8"), input.alias)) {
      throw new SshWarmupAuthorityError("SSH warmup alias is not service-enrolled");
    }
    return new SshWarmupTransportAuthority(input, fileIdentity(input.configPath, config.stat, config.bytes));
  }
}

/** Include and Match may change effective routing without changing this file.
 * Such configs remain valid for ordinary OpenSSH, but are ineligible for the
 * sealed speculative/custom-HOME route until dependency sealing exists. */
function hasUnsealedRouting(config: string): boolean {
  for (const line of config.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const token = /^[^\s=]+/u.exec(trimmed)?.[0];
    const keyword = token?.replaceAll('"', "").toLowerCase();
    if (keyword === "include" || keyword === "match") return true;
  }
  return false;
}

export class SshWarmupAuthorityError extends Error {
  readonly name = "SshWarmupAuthorityError";
}

export function assertSshWarmupTransportIdentity(authority: SshWarmupTransportAuthority): void {
  const config = readConfig(authority.configPath);
  if (fileIdentity(authority.configPath, config.stat, config.bytes) !== authority.configIdentity ||
    authorityIdentity({
      alias: authority.alias,
      configPath: authority.configPath,
      env: authority.env,
      executable: authority.executable,
      reportCleanupFailure: authority.reportCleanupFailure,
    }, authority.configIdentity) !== authority.identity) {
    throw new SshWarmupAuthorityError("SSH warmup transport identity changed");
  }
}

function readConfig(path: string): Readonly<{ stat: BigIntStats; bytes: Buffer }> {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) throw new SshWarmupAuthorityError("SSH config is not a regular file");
    return { stat, bytes: readFileSync(fd) };
  } catch (error) {
    if (error instanceof SshWarmupAuthorityError) throw error;
    throw new SshWarmupAuthorityError("SSH config cannot be sealed");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function fileIdentity(path: string, stat: BigIntStats, bytes: Uint8Array): string {
  return createHash("sha256")
    .update(path).update("\0")
    .update([stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"))
    .update("\0").update(bytes).digest("hex");
}

function authorityIdentity(input: AuthorityInput, configIdentity: string): string {
  const env = Object.entries(input.env).sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256")
    .update(input.alias).update("\0")
    .update(input.configPath).update("\0")
    .update(input.executable.identity).update("\0")
    .update(input.executable.statIdentity).update("\0")
    .update(configIdentity).update("\0")
    .update(JSON.stringify(env)).digest("hex");
}

function hasEnrolledAlias(config: string, alias: string): boolean {
  let marker = false;
  for (const line of config.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.toLowerCase() === "# dokkabi-enrolled") {
      marker = true;
      continue;
    }
    const host = /^host[\s=]+([^\s]+)$/iu.exec(trimmed);
    if (host) {
      if (marker && host[1] === alias) return true;
      marker = false;
      continue;
    }
    if (!trimmed.startsWith("#")) marker = false;
  }
  return false;
}
