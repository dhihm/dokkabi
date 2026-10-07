import { z } from "zod";
import { ContextGraphSchemaError, eventRefSchema } from "../context-graph/types.ts";
import type { EventRecord } from "./schema.ts";

/** Delivery metadata for arbitrary plugin context, never selection authority. */
export const HOST_CONTEXT_FRAME_SCHEMA = "host-context-frame-v1";
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const frameId = z.string().regex(/^cf-[0-9]+$/u);
export const contributionFrameSchema = z.strictObject({
  schema: z.literal(HOST_CONTEXT_FRAME_SCHEMA),
  frame: z.strictObject({ id: frameId, sourceHead: eventRefSchema }),
  mode: z.enum(["shadow", "on"]),
  boundary: z.enum(["initial", "tool_batch", "resume", "retry", "completion"]),
  blob: digest,
  blob_bytes: z.number().int().nonnegative(),
  contribution: z.record(z.string(), z.unknown()),
});
export type ContributionFrameRow = z.infer<typeof contributionFrameSchema>;

// A closed compatibility shape for already recorded rows. This is not an
// extensible acceptance of unknown historical frame schemas or world claims.
const legacyWorkspaceFrameSchema = z.strictObject({
  schema: z.literal("github-workspace-scope-v1"),
  frame_id: frameId,
  user_seq: z.number().int().nonnegative(),
  repository: z.string().max(512).regex(/^[^\s/]+\/[^\s/]+$/u),
  prior_review: z.strictObject({
    number: z.number().int().positive(),
    head: z.string().optional(),
    base: z.string().optional(),
  }).nullable(),
  blob: digest,
  blob_bytes: z.number().int().nonnegative(),
});

const legacyCompletionFrameSchema = z.strictObject({
  schema: z.enum(["source-research-completion-v1", "github-issue-completion-v1"]),
  frame_id: frameId, blob: digest, blob_bytes: z.number().int().nonnegative(),
  user_seq: z.number().int().nonnegative(),
});
const legacyFollowupFrameSchema = z.strictObject({
  schema: z.literal("github-followup-progress-v1"),
  frame_id: frameId, blob: digest, blob_bytes: z.number().int().nonnegative(),
  user_seq: z.number().int().nonnegative(), begin_seq: z.number().int().positive().nullable(),
  phase: z.enum(["report_findings", "investigate"]),
  finding_ids: z.array(z.string()), pending_files: z.array(z.string()),
  next_case_file: z.string().nullable(), next_tool: z.literal("review_assessment").nullable(),
  next_args: z.record(z.string(), z.unknown()).nullable(),
  existing_checks: z.array(z.unknown()), next_action: z.string(),
});
const legacyFrameSchema = z.union([legacyWorkspaceFrameSchema, legacyCompletionFrameSchema, legacyFollowupFrameSchema]);
export interface LegacyContributionFrameRow {
  readonly schema: "legacy-context-contribution";
  readonly frame: { id: string; sourceHead: { seq: number; hash: string } };
  readonly mode: "unrecorded";
  readonly boundary: "unrecorded";
  readonly blob: string;
  readonly blob_bytes: number;
  readonly contribution: Record<string, unknown>;
}
export type RecordedContributionFrameRow = ContributionFrameRow | LegacyContributionFrameRow;

export function contributionFrameOf(event: EventRecord, legacyAllowed: boolean): RecordedContributionFrameRow {
  if (event.payload.schema === HOST_CONTEXT_FRAME_SCHEMA) {
    const result = contributionFrameSchema.safeParse(event.payload);
    if (result.success) return result.data;
  } else if (legacyAllowed) {
    const result = legacyFrameSchema.safeParse(event.payload);
    if (result.success && event.seq > 1) {
      return {
        schema: "legacy-context-contribution",
        frame: { id: result.data.frame_id, sourceHead: { seq: event.seq - 1, hash: event.prev_hash } },
        mode: "unrecorded", boundary: "unrecorded", blob: result.data.blob,
        blob_bytes: result.data.blob_bytes, contribution: result.data,
      };
    }
  }
  throw new ContextGraphSchemaError("context/frame is not a supported recorded contribution");
}
