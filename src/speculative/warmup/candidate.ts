import { createSpeculationCandidate } from "../candidates.ts";
import type { ScheduledCandidate } from "../scheduler-types.ts";
import { isExecutingScheduledCandidate } from "../scheduler.ts";
import type { WarmupAuthority } from "./registry.ts";

export class WarmupCandidateError extends Error {
  readonly code = "warmup_candidate" as const;
}

const RECEIPT_SECRET = Symbol("warmup-candidate-receipt");

export class WarmupCandidateReceipt {
  readonly #brand = "warmup-candidate-receipt";

  constructor(secret: symbol) {
    if (secret !== RECEIPT_SECRET) throw new WarmupCandidateError("warmup candidate receipt is host-only");
  }
}

export interface SchedulerWarmupCandidateIssuer {
  issue(candidate: ScheduledCandidate): WarmupCandidateReceipt;
}

const RECEIPTS = new WeakMap<WarmupCandidateReceipt, ScheduledCandidate>();

export function createSchedulerWarmupCandidateIssuer(): SchedulerWarmupCandidateIssuer {
  return Object.freeze({
    issue(candidate: ScheduledCandidate): WarmupCandidateReceipt {
      if (candidate.tier !== 3 || !candidate.id || candidate.provenance.kind === "prediction" ||
        !Object.isFrozen(candidate) || !isExecutingScheduledCandidate(candidate)) {
        throw new WarmupCandidateError("warmup requires an immutable scheduler tier-3 candidate");
      }
      const receipt = new WarmupCandidateReceipt(RECEIPT_SECRET);
      Object.freeze(receipt);
      RECEIPTS.set(receipt, candidate);
      return receipt;
    },
  });
}

export function authorityForWarmupCandidate(
  kind: string,
  receipt: WarmupCandidateReceipt,
  exactArgs: unknown,
): WarmupAuthority {
  const candidate = RECEIPTS.get(receipt);
  if (!candidate) throw new WarmupCandidateError("warmup candidate receipt is missing or forged");
  RECEIPTS.delete(receipt);
  const provenance = candidate.provenance;
  const canonical = createSpeculationCandidate({ tool: candidate.tool, args: exactArgs, provenance }, {
    tier: 3,
    maxCallBytes: candidate.byteLength,
  });
  if (!canonical || canonical.keyDigest !== candidate.keyDigest || canonical.byteLength !== candidate.byteLength) {
    throw new WarmupCandidateError("warmup recipe does not match its exact candidate authority");
  }
  return Object.freeze({ kind, keyDigest: candidate.keyDigest });
}
