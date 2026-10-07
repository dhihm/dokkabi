export type DecisionType = "FIX_BUG" | "ADD_TEST" | "REFACTOR" | "REJECT" | "COMPLETE_WORK";

export type MaekRowKind = "decision" | "fault" | "snapshot" | "fault_resolution";

export type MaekSource = {
  readonly session_id: string;
  readonly seq_start: number;
  readonly seq_end: number;
  readonly source_hash: string;
  readonly source_blob?: string;
};

export type DecisionRecord = {
  readonly decision_id: string;
  readonly session_id: string;
  readonly turn_id: number;
  readonly symbol_id?: string;
  readonly decision_type: DecisionType;
  readonly rationale: string;
  readonly constraints?: Readonly<Record<string, unknown>>;
};

export type FaultRecord = {
  readonly fault_id: string;
  readonly command: string;
  /** Digest of the full host-recorded command args when available. Unlike the
   * display-safe command hint, this identity is never truncated. */
  readonly command_digest?: string;
  readonly exit_code: number | "missing";
  readonly fault_excerpt: string;
  readonly blob_digest: string;
};

export type EvidenceSnapshot = {
  readonly snapshot_id: string;
  readonly session_id: string;
  readonly prefix_hash: string;
  readonly blob_digest: string;
};

export type FaultResolutionRecord = {
  readonly resolution_id: string;
  readonly fault_id: string;
  readonly session_id: string;
  readonly outcome: "GREEN" | "FINALIZED";
  readonly reference: string;
};

export type MaekObservation =
  | { readonly kind: "decision"; readonly row: DecisionRecord; readonly source: MaekSource }
  | { readonly kind: "fault"; readonly row: FaultRecord; readonly source: MaekSource }
  | { readonly kind: "snapshot"; readonly row: EvidenceSnapshot; readonly source: MaekSource }
  | { readonly kind: "fault_resolution"; readonly row: FaultResolutionRecord; readonly source: MaekSource };

export type QueryDecisionsInput = {
  readonly symbolId?: string;
  readonly limit?: number;
};

export type QueryFaultsInput = {
  readonly errorPattern: string;
  readonly limit?: number;
};

export type MaekService = {
  readonly engine: "duckdb";
  queryDecisions(text: string, options?: QueryDecisionsInput): Promise<DecisionRecord[]>;
  querySimilarFaults(input: QueryFaultsInput): Promise<FaultRecord[]>;
  /** Project any new host evidence from the log into the derived store now.
   * Returns the number of rows added. Live only — replay replays recorded
   * ingests at initialization and returns 0 here. */
  ingest(): Promise<number>;
  close(): Promise<void>;
};
