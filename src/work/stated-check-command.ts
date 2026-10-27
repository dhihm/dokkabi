import { createHash } from "node:crypto";

/** Conservative patterns for a runnable check the operator named in plain text. */
const SO_PASSES = /\bso\s+(.+?)\s+passes\b/i;
const UNTIL_PASSES = /\buntil\s+(.+?)\s+passes\b/i;
const MAKE_PASS = /\bmake\s+(.+?)\s+pass\b/i;
/** `` `cmd` passes `` — backticks only inside an explicit pass context. */
const BACKTICK_PASSES = /`([^`\n]+)`\s+passes\b/i;

/** Subcommands that must never run as an operator-stated check at session open. */
const FORBIDDEN_SUBCOMMANDS = new Set(["publish", "deploy", "push", "release", "install", "rm"]);

/** First-token runners the host treats as verification commands. */
const KNOWN_RUNNERS = new Set([
  "python3",
  "python",
  "bun",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "node",
  "deno",
  "cargo",
  "go",
  "make",
  "pytest",
  "tox",
  "mvn",
  "gradle",
  "dotnet",
  "ruby",
  "rake",
  "bundle",
  "php",
  "phpunit",
  "jest",
  "vitest",
  "sh",
  "bash",
]);

function firstToken(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

function isExecutablePath(token: string): boolean {
  if (token.startsWith("./") && token.length > 2 && !/\s/u.test(token)) {
    return /^\.\/[\w./-]+$/.test(token);
  }
  return /^(?:scripts|bin)\/[\w./-]+$/.test(token);
}

/** Whether `text` plausibly names a shell command rather than prose. */
export function looksLikeRunnableCommand(text: string): boolean {
  const command = text.trim();
  if (command.length < 3) return false;
  if (/^(it|this|that|the|they|we|you)\b/i.test(command)) return false;
  const head = firstToken(command);
  if (head === "") return false;
  if (KNOWN_RUNNERS.has(head)) return true;
  if (head === "./gradlew") return true;
  return isExecutablePath(head);
}

function hasForbiddenSubcommand(command: string): boolean {
  for (const token of command.trim().toLowerCase().split(/\s+/)) {
    if (FORBIDDEN_SUBCOMMANDS.has(token)) return true;
  }
  return false;
}

function clauseStartIndex(order: string, position: number): number {
  let start = 0;
  for (const sep of [".", ";", ","]) {
    const at = order.lastIndexOf(sep, position);
    if (at >= start) start = at + 1;
  }
  return start;
}

/** True when the same clause already negates this command before the pass pattern. */
function negatedCommandInClause(order: string, patternIndex: number, command: string): boolean {
  const clauseStart = clauseStartIndex(order, patternIndex);
  const beforePattern = order.slice(clauseStart, patternIndex);
  const cmd = command.trim().toLowerCase();
  const lastToken = cmd.split(/\s+/).at(-1) ?? "";
  const negatedPhrase = /\b(?:don't|dont|do not|never|without|avoid)\s+([^,.;`]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = negatedPhrase.exec(beforePattern)) !== null) {
    const phrase = match[1]!.trim().toLowerCase();
    if (phrase === cmd || cmd.includes(phrase) || phrase.includes(cmd)) return true;
    if (lastToken.length >= 4 && (phrase === lastToken || phrase.endsWith(` ${lastToken}`) || phrase.split(/\s+/).includes(lastToken))) {
      return true;
    }
  }
  if (/\bno\s+(?:run|execute|use)\b/i.test(beforePattern) && beforePattern.toLowerCase().includes(lastToken)) return true;
  return false;
}

function normalizeCandidate(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const command = raw.trim().replace(/[.!?]+$/u, "").trim();
  if (!looksLikeRunnableCommand(command)) return undefined;
  if (hasForbiddenSubcommand(command)) return undefined;
  return command;
}

function stripBackticks(raw: string): string {
  return raw.replace(/`/g, "").trim();
}

function acceptPassMatch(order: string, full: RegExpMatchArray): string | undefined {
  const patternIndex = full.index ?? 0;
  const rawCapture = full[1];
  if (rawCapture === undefined) return undefined;
  const command = normalizeCandidate(stripBackticks(rawCapture));
  if (command === undefined) return undefined;
  if (negatedCommandInClause(order, patternIndex, command)) return undefined;
  return command;
}

/** Extract the operator's stated verification command from an order, when unambiguous. */
export function extractStatedCheckCommand(order: string): string | undefined {
  const backtickPass = order.match(BACKTICK_PASSES);
  if (backtickPass) {
    const command = acceptPassMatch(order, backtickPass);
    if (command !== undefined) return command;
  }
  for (const pattern of [SO_PASSES, UNTIL_PASSES, MAKE_PASS]) {
    const match = order.match(pattern);
    if (match) {
      const command = acceptPassMatch(order, match);
      if (command !== undefined) return command;
    }
  }
  return undefined;
}

/** Stable ledger case id for one operator-stated command string. */
export function statedCheckCaseId(command: string): string {
  const digest = createHash("sha256").update(command.trim()).digest("hex").slice(0, 12);
  return `stated-${digest}`;
}

/** Host-recorded operator-stated cases use ids with this prefix. */
export function isOperatorStatedCaseId(id: string): boolean {
  return id.startsWith("stated-");
}
