import type { EventRecord } from "../host/schema.ts";
import { caseLaunch, shellQuote } from "./case-launch.ts";

/**
 * What a green is still good FOR.
 *
 * Settlement compared a green's recorded host revision against the host's
 * current one — the whole working tree in one digest. Any edit anywhere on
 * the host reopened every settled case on it: one line in a tool parser
 * re-ran an eight-minute checkpoint load that never reads the parser, and
 * an unattended night spent most of its GPU hours confirming verdicts
 * nobody doubted.
 *
 * A case may now declare what its verdict actually depends on — path globs,
 * the same way it declares its substrate and its thresholds. At verdict
 * time the runner digests the state of exactly those paths on the host;
 * at re-verify time it digests them again. Same digest, same verdict: the
 * green stands, whatever else on the host moved. No declaration keeps the
 * conservative whole-host rule.
 */

const GLOB_PATTERN = /^[A-Za-z0-9._\-*/[\]?]+$/u;

/** Shape gate for a declaration arriving as plan data. */
export function validateDependsOn(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [
      `case depends_on must be a non-empty array of path globs — e.g. ["tests/sla/**", "src/serving/**"]`,
    ];
  }
  const errors: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      errors.push(`case depends_on entries must be non-empty path globs (got ${String(entry)})`);
      continue;
    }
    if (!GLOB_PATTERN.test(entry) || entry.includes("..")) {
      errors.push(`case depends_on glob "${entry}" must be a plain relative path glob`);
    } else if (entry.replaceAll("\\", "/").startsWith("work/scratch/")) {
      errors.push(`case depends_on glob "${entry}" must reference promoted repository assets`);
    }
  }
  return errors;
}

/**
 * One command that prints a 16-hex digest of the declared paths' CONTENT:
 * every tracked and untracked file the globs match, named and hashed as it
 * sits in the working tree.
 *
 * The first version digested the commit position plus the uncommitted diff.
 * A commit moves content between those two representations without changing
 * a byte of it — and every commit therefore re-opened every settled case on
 * the host, six minutes each, to confirm bytes that had not moved. Content
 * is the only thing the verdict ever depended on, so content is what the
 * digest reads.
 */
export function dependsProbeScript(dir: string | undefined, globs: readonly string[]): string {
  const quoted = globs.map((glob) => shellQuote(glob)).join(" ");
  // Bytecode caches churn on every run whether or not anything real changed;
  // digesting them would make every probe miss and the mechanism useless.
  // The directory is path data, entered the way every case launch enters it
  // (case-launch.ts).
  return caseLaunch(dir, `{ git ls-files -- ${quoted} 2>/dev/null; `
    + `git ls-files --others --exclude-standard -- ${quoted} 2>/dev/null; } `
    + `| grep -v -E '__pycache__|\\.pyc$' | sort -u | `
    + `while IFS= read -r f; do printf '%s\\n' "$f"; sha256sum "$f" 2>/dev/null; done `
    + `| sha256sum | cut -c1-16`);
}

/** The digest a probe printed, or undefined when the output is not one. */
export function parseDependsDigest(output: string): string | undefined {
  const lines = output.trim().split(/\r?\n/u);
  const last = lines.at(-1)?.trim() ?? "";
  return /^[0-9a-f]{16}$/u.test(last) ? last : undefined;
}

/**
 * The depends digest recorded with this case's latest GREEN verdict — the
 * state its standing green was earned on. Undefined when the latest verdict
 * is not green, carries no digest, or belongs to another case revision.
 */
export function lastGreenDependsDigest(
  caseId: string,
  caseDigest: string,
  events: readonly EventRecord[],
): string | undefined {
  const found = lastVerdictDepends(caseId, caseDigest, events);
  return found?.status === "green" ? found.digest : undefined;
}

/**
 * The latest executed verdict — either color — with the dependency state it
 * was earned on. Same inputs, same verdict, in both directions: while a
 * model spent its turns investigating a hard failure, every intervening
 * verify wave re-ran the same twelve-minute failing case against
 * byte-identical dependencies and learned nothing the log did not already
 * hold. An unchanged red is as settled as an unchanged green; its evidence
 * (failure digest and tail) travels forward with it.
 */
export function lastVerdictDepends(
  caseId: string,
  caseDigest: string,
  events: readonly EventRecord[],
): {
  status: "green" | "red";
  digest: string;
  failureDigest?: string;
  failureTail?: string;
  exitCode?: number | "missing";
} | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.name !== "work/case") continue;
    const payload = event.payload as {
      id?: unknown; status?: unknown; duration_ms?: unknown;
      case_digest?: unknown; depends_digest?: unknown; first_run?: unknown;
      failure_digest?: unknown; failure_tail?: unknown;
      exit_code?: unknown;
    };
    if (payload.id !== caseId) continue;
    if (payload.status !== "green" && payload.status !== "red") continue;
    // Only executed verdicts count; a plan-bind row restates the ledger.
    if (payload.duration_ms === undefined || payload.duration_ms === null) continue;
    // A first-run green is unearned under RED-first and settles nothing.
    if (payload.first_run === true) return undefined;
    if (payload.case_digest !== caseDigest) return undefined;
    if (typeof payload.depends_digest !== "string") return undefined;
    return {
      status: payload.status,
      digest: payload.depends_digest,
      ...(typeof payload.failure_digest === "string" ? { failureDigest: payload.failure_digest } : {}),
      ...(typeof payload.failure_tail === "string" ? { failureTail: payload.failure_tail } : {}),
      ...(typeof payload.exit_code === "number" || payload.exit_code === "missing"
        ? { exitCode: payload.exit_code }
        : {}),
    };
  }
  return undefined;
}
