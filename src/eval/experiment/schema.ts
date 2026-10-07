import { z } from "zod";

export const experimentId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const relativePath = z.string().min(1).max(1024).refine(value =>
  !value.startsWith("/") && !value.includes("\\") && !value.includes("\0")
  && value.split("/").every(part => part !== "" && part !== "." && part !== ".."), "canonical relative path required");
export const sourceSchema = z.strictObject({ system: z.enum(["dokkabi", "external"]),
  producer: experimentId, version: z.string().min(1).max(256) });
export const referenceSchema = z.strictObject({ relation: experimentId, artifact: experimentId });
export const artifactSchema = z.strictObject({
  id: experimentId, path: relativePath, sha256: sha256Schema,
  kind: z.enum(["scope", "oracle_definition", "rubric", "patch", "dokkabi_log", "blob", "process_exit", "oracle_result", "label", "harness_result", "journal"]),
  source: sourceSchema, references: z.array(referenceSchema).max(100000),
});
export const manifestSchema = z.strictObject({
  schema_version: z.literal(1), study_id: experimentId, study_version: z.string().min(1).max(256),
  analysis_attempt: z.literal("first"),
  tasks: z.array(z.strictObject({ id: experimentId, scope: experimentId, oracle: experimentId, rubric: experimentId })).min(1).max(100000),
  conditions: z.array(z.strictObject({ id: experimentId, system: z.enum(["dokkabi", "external", "mixed"]) })).min(1).max(100),
  replicates: z.array(z.number().int().min(1).max(100000)).min(1).max(100000),
  sources: z.array(artifactSchema).min(1).max(100000),
});
export const eventRefSchema = z.strictObject({ artifact: experimentId, seq: z.number().int().positive(), hash: sha256Schema });
export const sessionSchema = z.strictObject({ id: experimentId, role: z.enum(["parent", "spec", "verifier", "child"]),
  parent: experimentId.nullable(), log: experimentId });
export const attemptSchema = z.strictObject({
  id: experimentId, scheduled_key: sha256Schema, ordinal: z.number().int().positive(), sessions: z.array(sessionSchema).max(100000),
  bindings: z.strictObject({
    terminal: eventRefSchema.nullable(), acceptance: eventRefSchema.nullable(), graph: eventRefSchema.nullable(),
    scope: experimentId, patch: experimentId, process_exit: experimentId.nullable(), oracle: experimentId.nullable(),
    labels: z.array(experimentId), harness: z.array(experimentId), journal: z.array(experimentId),
  }),
});
export const exclusionSchema = z.strictObject({ scheduled_key: sha256Schema, reason: z.string().min(1).max(4096), artifact: experimentId });
// Rows are validated separately: one malformed row must not erase other attempts.
export const inventorySchema = z.strictObject({ schema_version: z.literal(1), manifest_sha256: sha256Schema,
  artifacts: z.array(z.unknown()).max(1000000), attempts: z.array(z.unknown()).max(1000000), exclusions: z.array(z.unknown()).max(100000) });
export const externalEnvelopeSchema = z.strictObject({ schema_version: z.literal(1),
  kind: z.enum(["process_exit", "oracle_result", "label", "harness_result", "journal"]), source: sourceSchema,
  scheduled_key: sha256Schema, attempt_id: experimentId.nullable(), references: z.array(referenceSchema), value: z.unknown() });
export const oracleValueSchema = z.strictObject({ verdict: z.enum(["correct", "wrong", "unknown"]), reason: z.string().min(1).max(4096) });
export const exitValueSchema = z.strictObject({ exit_code: z.number().int().min(0).max(255).nullable(), signal: experimentId.nullable(),
  timed_out: z.boolean().optional(), supervisor_error: experimentId.nullable().optional() })
  .refine(value => (value.exit_code === null) !== (value.signal === null), "exactly one observed exit or signal required");
export const labelValueSchema = z.strictObject({ label: z.string().min(1).max(4096) });
export const harnessValueSchema = z.strictObject({ status: z.enum(["completed", "failed", "unknown"]), resolved: z.boolean().nullable() });
export const journalValueSchema = z.strictObject({ reason: z.string().min(1).max(4096), text: z.string().min(1).max(1000000) });
export type ExperimentManifest = z.infer<typeof manifestSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type Attempt = z.infer<typeof attemptSchema>;
export type EventRef = z.infer<typeof eventRefSchema>;
export type ExternalEnvelope = z.infer<typeof externalEnvelopeSchema>;
export type ScheduledRun = { key: string; task: string; condition: string; replicate: number; system: "dokkabi" | "external" | "mixed";
  scope: string; oracle: string; rubric: string };
export type CollectionIssue = { code: string; location: string; scheduled_key: string | null; attempt_id: string | null; artifact_id: string | null };
export type CollectionState = "complete" | "never_started" | "crash" | "missing" | "corrupt" | "duplicate";
