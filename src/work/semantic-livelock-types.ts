export const SEMANTIC_LIVELOCK_ATTEMPTS = 3;

export interface SemanticLivelockDetection {
  readonly todo: string;
  readonly caseId: string;
  readonly attempts: typeof SEMANTIC_LIVELOCK_ATTEMPTS;
  readonly failureDigest: string;
  readonly footprintDigest: string;
  readonly caseDigest: string;
  readonly planDigest: string;
  readonly triggerSeq: number;
}
