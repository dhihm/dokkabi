import { readFileSync } from "node:fs";
import { join } from "node:path";
import { containsPrivateInfrastructure, containsSecret } from "./redact.ts";

/** Operator-chosen logical alias shape shared by host validation and the dash
 * projection: letter-led, no dots/@/wildcards, so a raw coordinate can never
 * pass as an alias. */
export const SSH_ALIAS_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/u;

const SSH_ALIAS_LIST_LIMIT = 32;

/**
 * List the alias names an operator has configured in ~/.ssh/config, so a
 * failed resolution can teach the model the real roster instead of leaving it
 * to guess names one approval prompt at a time. Names only: wildcard patterns,
 * coordinate-shaped tokens, and anything failing the safe alias shape stay
 * out, and connection details are never read into the result.
 */
export function readOperatorSshAliases(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const home = env.HOME;
  if (!home) return [];
  let content: string;
  try {
    content = readFileSync(join(home, ".ssh", "config"), "utf8");
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const line of content.split("\n")) {
    const match = /^\s*host[\s=]+(.+)$/iu.exec(line);
    if (!match) continue;
    for (const token of match[1]!.trim().split(/\s+/u)) {
      if (!SSH_ALIAS_PATTERN.test(token)) continue;
      if (containsSecret(token) || containsPrivateInfrastructure(token)) continue;
      out.add(token);
      if (out.size >= SSH_ALIAS_LIST_LIMIT) return [...out].sort();
    }
  }
  return [...out].sort();
}

/** Bounded `known_aliases=` suffix for alias failure results. */
export function knownAliasesHint(env: Readonly<Record<string, string | undefined>>): string {
  const aliases = readOperatorSshAliases(env);
  return aliases.length === 0
    ? "known_aliases=(none configured in ~/.ssh/config)"
    : `known_aliases=${aliases.join(",")}`;
}
