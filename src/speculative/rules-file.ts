import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseSpeculativeRules, type SpeculativeRules } from "./rules.ts";

export const SPECULATIVE_RULES_ENV = "DOKKABI_SPECULATIVE_RULES";

export interface LoadedSpeculativeRules {
  readonly rules: SpeculativeRules;
  readonly digest: string;
}

export function loadSpeculativeRules(path: string): LoadedSpeculativeRules {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new Error("speculative rules file could not be opened safely");
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.nlink !== 1) {
      throw new Error("speculative rules file must be a regular single-link file");
    }
    if (stats.size > 1024 * 1024) throw new Error("speculative rules file exceeds 1 MiB");
    const bytes = readFileSync(fd);
    const text = bytes.toString("utf8");
    const rules = parseSpeculativeRules(text);
    return { rules, digest: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    closeSync(fd);
  }
}

export function optionalSpeculativeRules(env: NodeJS.Dict<string> = process.env): LoadedSpeculativeRules | undefined {
  const path = env[SPECULATIVE_RULES_ENV]?.trim();
  return path ? loadSpeculativeRules(path) : undefined;
}
