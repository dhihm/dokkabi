export type RunnerOutcomeKind = "execution_unavailable" | "collection_setup_error"
  | "assertion_failure" | "product_exception" | "passed" | "cancelled" | "incomplete";

export interface RunnerOutcome {
  readonly kind: RunnerOutcomeKind;
  readonly reason: string;
  readonly tests: number;
  readonly qualifying_red: boolean;
  readonly green: boolean;
  readonly framework_version?: string;
}

/** Host plugin capability. Declarative runner data can refer to an installed
 * adapter, but cannot implement one or elevate its evidence protection. */
export interface RunnerResultAdapter {
  readonly id: string;
  readonly digest: string;
  command(original: string): string;
  read(body: string, exitCode: number): RunnerOutcome;
}

export function refusedOutcome(kind: RunnerOutcomeKind, reason: string): RunnerOutcome {
  return { kind, reason, tests: 0, qualifying_red: false, green: false };
}
