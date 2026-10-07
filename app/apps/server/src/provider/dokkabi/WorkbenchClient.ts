/**
 * Dokkabi workbench client seam — the one import surface adapters use.
 *
 * Combines the closed wire schemas, the loopback-validated transport, and
 * the transport-loss sentinel that submit reconciliation keys off. Keeps
 * adapter imports linear and gives tests a single place to double.
 *
 * @module provider/dokkabi/WorkbenchClient
 */
import * as Schema from "effect/Schema";
import { WorkbenchTransport, workbenchRequest, validateGatewayUrl } from "./WorkbenchTransport.ts";
import {
  BindResponse,
  BranchDescriptorResponse,
  CancelResponse,
  CheckpointResponse,
  CommandStatusResponse,
  DecisionResponse,
  DecisionsResponse,
  DetachResponse,
  GraphExploreResponse,
  GraphResponse,
  HandshakeResponse,
  ModelSelectionResponse,
  OverviewResponse,
  ReadResponse,
  RecordBodyResponse,
  RecordIndexResponse,
  RecordResponse,
  CodeResponse,
  CodeActionResponse,
  SubmitResponse,
  UsageResponse,
  WorkModeResponse,
  decodeResult,
} from "./WorkbenchProtocol.ts";

export {
  WorkbenchTransport,
  workbenchRequest,
  validateGatewayUrl as validateWorkbenchUrl,
  decodeResult,
};

export const HandshakeSchema = HandshakeResponse;
export const ModelSelectionSchema = ModelSelectionResponse;
export const BindSchema = BindResponse;
export const ReadSchema = ReadResponse;
export const SubmitSchema = SubmitResponse;
export const CommandStatusSchema = CommandStatusResponse;
export const CancelSchema = CancelResponse;
export const DetachSchema = DetachResponse;
export const OverviewSchema = OverviewResponse;
export const GraphSchema = GraphResponse;
export const UsageSchema = UsageResponse;
export const CodeSchema = CodeResponse;
export const CodeActionSchema = CodeActionResponse;
export type CodeResult = CodeResponse;
export const RecordSchema = RecordResponse;
export const RecordIndexSchema = RecordIndexResponse;
export const RecordBodySchema = RecordBodyResponse;
export const GraphExploreSchema = GraphExploreResponse;
export const DecisionsSchema = DecisionsResponse;
export const CheckpointSchema = CheckpointResponse;
export const DecisionSchema = DecisionResponse;
export const BranchDescriptorSchema = BranchDescriptorResponse;
export const WorkModeSchema = WorkModeResponse;

export type HandshakeResult = HandshakeResponse;
export type BindResult = BindResponse;
export type ReadResult = ReadResponse;
export type SubmitResult = SubmitResponse;
export type CommandStatusResult = CommandStatusResponse;
export type CancelResult = CancelResponse;
export type OverviewResult = OverviewResponse;
export type GraphResult = GraphResponse;
export type UsageResult = UsageResponse;
export type RecordResult = RecordResponse;
export type RecordIndexResult = RecordIndexResponse;
export type RecordBodyResult = RecordBodyResponse;
export type GraphExploreResult = GraphExploreResponse;
export type DecisionsResult = DecisionsResponse;
export type CheckpointResult = CheckpointResponse;
export type DecisionResult = DecisionResponse;
export type BranchDescriptorResult = BranchDescriptorResponse;
export type WorkModeResult = WorkModeResponse;

/**
 * A request whose transport failed before a response arrived. The effect on
 * the gateway may or may not have happened — callers must reconcile via
 * `workbench.commandStatus` before any retry, never blind-replay.
 */
export class WorkbenchTransportLost extends Schema.TaggedError<WorkbenchTransportLost>()(
  "WorkbenchTransportLost",
  { detail: Schema.String },
) {
  override get message(): string {
    return `Dokkabi gateway transport lost before a response: ${this.detail}`;
  }
}

export const isWorkbenchTransportLost = Schema.is(WorkbenchTransportLost);
