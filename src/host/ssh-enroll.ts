import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SSH_ALIAS_PATTERN } from "./ssh-aliases.ts";

/**
 * Operator-approved SSH alias enrollment.
 *
 * The bootstrap gap: a fresh dokkabi on a fresh host has no aliases, and the
 * model must never author a private coordinate. Enrollment closes it — the
 * OPERATOR's coordinate (from their own chat, confirmed in an approval popup)
 * is written to their ~/.ssh/config as a named Host block. From then on the
 * model uses the alias alone. The coordinate is written to the operator's
 * config, never to the EventLog; only the alias name is logged.
 */

export interface ParsedAddress {
  user?: string;
  host: string;
  port?: string;
}

const HOST_SHAPE = /^[A-Za-z0-9._-]+$/u;
const USER_SHAPE = /^[A-Za-z0-9._-]+$/u;
const PORT_SHAPE = /^[0-9]{1,5}$/u;

/** Parse `[user@]host[:port]`, rejecting anything with shell metacharacters. */
export function parseAddress(address: string): ParsedAddress | undefined {
  if (typeof address !== "string") return undefined;
  const trimmed = address.trim();
  if (trimmed === "" || /[\s;&|$`'"\\<>(){}]/u.test(trimmed)) return undefined;
  let rest = trimmed;
  let user: string | undefined;
  const at = rest.indexOf("@");
  if (at >= 0) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
    if (!USER_SHAPE.test(user)) return undefined;
  }
  let port: string | undefined;
  const colon = rest.lastIndexOf(":");
  if (colon >= 0) {
    port = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!PORT_SHAPE.test(port)) return undefined;
  }
  if (!HOST_SHAPE.test(rest)) return undefined;
  return { host: rest, ...(user ? { user } : {}), ...(port ? { port } : {}) };
}

/** A display form that keeps the coordinate recognizable to the operator but
 * out of the log: the middle of an IPv4 (or the middle of a hostname) elided. */
export function maskAddress(address: string): string {
  const parsed = parseAddress(address);
  if (!parsed) return "(invalid address)";
  const { host, user, port } = parsed;
  let maskedHost: string;
  const octets = host.split(".");
  if (octets.length === 4 && octets.every((o) => /^[0-9]+$/u.test(o))) {
    maskedHost = `${octets[0]}.${octets[1]}.x.${octets[3]!.slice(-1)}…`;
  } else if (host.length > 6) {
    maskedHost = `${host.slice(0, 3)}…${host.slice(-3)}`;
  } else {
    maskedHost = `${host.slice(0, 2)}…`;
  }
  return `${user ? `${user}@` : ""}${maskedHost}${port ? `:${port}` : ""}`;
}

export interface EnrollResult {
  ok: boolean;
  alias?: string;
  already?: boolean;
  reason?: string;
}

/** True when a `Host <alias>` block already exists in the config text. */
function hasAlias(config: string, alias: string): boolean {
  for (const line of config.split("\n")) {
    const match = /^\s*host[\s=]+(.+)$/iu.exec(line);
    if (!match) continue;
    if (match[1]!.trim().split(/\s+/u).includes(alias)) return true;
  }
  return false;
}

/**
 * Append a Host block for `alias` → `address` to the operator's ssh config
 * (backed up once to <config>.bak-enroll before the first change), creating
 * the file and its directory if absent. Idempotent: an existing alias is left
 * alone. Validates the alias shape and the address before any write.
 */
export function enrollSshAlias(input: {
  alias: string;
  address: string;
  configPath: string;
}): EnrollResult {
  if (!SSH_ALIAS_PATTERN.test(input.alias)) {
    return { ok: false, reason: "alias must be letter-led, no dots/@/spaces" };
  }
  const parsed = parseAddress(input.address);
  if (!parsed) {
    return { ok: false, reason: "address must be [user@]host[:port] with no shell characters" };
  }
  const existing = existsSync(input.configPath) ? safeRead(input.configPath) : "";
  if (existing === undefined) return { ok: false, reason: "could not read ssh config" };
  if (hasAlias(existing, input.alias)) {
    return { ok: true, alias: input.alias, already: true };
  }
  try {
    mkdirSync(dirname(input.configPath), { recursive: true, mode: 0o700 });
    if (existsSync(input.configPath) && !existsSync(`${input.configPath}.bak-enroll`)) {
      copyFileSync(input.configPath, `${input.configPath}.bak-enroll`);
    }
    const block = [
      "",
      "# dokkabi-enrolled",
      `Host ${input.alias}`,
      `    HostName ${parsed.host}`,
      ...(parsed.user ? [`    User ${parsed.user}`] : []),
      ...(parsed.port ? [`    Port ${parsed.port}`] : []),
      "",
    ].join("\n");
    const next = existing.endsWith("\n") || existing === "" ? existing + block : `${existing}\n${block}`;
    writeFileSync(input.configPath, next, { mode: 0o600 });
    return { ok: true, alias: input.alias, already: false };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "enroll write failed" };
  }
}

function safeRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
