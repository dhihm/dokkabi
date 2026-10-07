import { z } from "zod";

export const PREDICTOR_V2_SCHEMA = "dokkabi-speculative-predictor-v2" as const;
export const PREDICTOR_STAGE1_MAX_BYTES = 100 * 1024;
export const PREDICTOR_ARTIFACT_MAX_BYTES = 5 * 1024 * 1024;
export const PREDICTOR_MAX_CALLS = 4;

const repositoryPath = z.string().min(1).max(512).refine((path) => {
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  if (path.split("/").some((part) => part === "" || part === "." || part === "..")) return false;
  return !/(?:^|\/)(?:\.env(?:\..*)?|secrets?|credentials?|passwords?|tokens?|keys?|private)(?:\/|$)|(?:^|\/)(?:id_(?:rsa|ed25519)|auth\.json|\.npmrc)(?:$|\/)/iu.test(path);
});
const toolName = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);

export const stage1RowSchema = z.strictObject({
  tool: toolName,
  is_error: z.boolean(),
  exit_code: z.number().int().nonnegative().safe().nullable(),
  turn_bucket: z.enum(["any", "early", "middle", "late"]),
  next_tool: toolName,
  support: z.number().int().positive().safe(),
  total: z.number().int().positive().safe(),
});

export const topologyEdgeSchema = z.strictObject({
  from: repositoryPath,
  to: repositoryPath,
  relation: z.enum(["calls", "tested_by", "imports"]),
});

export const lexicalDocumentSchema = z.strictObject({
  path: repositoryPath,
  symbols: z.array(z.string().max(4096)).max(128),
});

export const coEditSchema = z.strictObject({
  source: repositoryPath,
  target: repositoryPath,
  count: z.number().int().positive().safe(),
});

export const predictorV2Schema = z.strictObject({
  schema: z.literal(PREDICTOR_V2_SCHEMA),
  compatibility: z.strictObject({ adapter: z.enum(["native-v2", "v1-explicit"]) }),
  training: z.strictObject({
    trajectories: z.number().int().positive().safe(),
    samples: z.number().int().positive().safe(),
  }),
  limits: z.strictObject({
    max_calls: z.literal(PREDICTOR_MAX_CALLS),
    stage1_max_bytes: z.literal(PREDICTOR_STAGE1_MAX_BYTES),
    artifact_max_bytes: z.literal(PREDICTOR_ARTIFACT_MAX_BYTES),
  }),
  digests: z.strictObject({ topology: digest, lexical: digest, coedit: digest }),
  stage1: z.array(stage1RowSchema).max(4096),
  targets: z.strictObject({
    topology: z.array(topologyEdgeSchema).max(2048),
    lexical_documents: z.array(lexicalDocumentSchema).max(256),
    co_edits: z.array(coEditSchema).max(512),
  }),
});

export type PredictorStage1Row = Readonly<z.infer<typeof stage1RowSchema>>;
export type PredictorTopologyEdge = Readonly<z.infer<typeof topologyEdgeSchema>>;
export type PredictorV2Artifact = {
  readonly schema: typeof PREDICTOR_V2_SCHEMA;
  readonly compatibility: { readonly adapter: "native-v2" | "v1-explicit" };
  readonly training: { readonly trajectories: number; readonly samples: number };
  readonly limits: {
    readonly max_calls: typeof PREDICTOR_MAX_CALLS;
    readonly stage1_max_bytes: typeof PREDICTOR_STAGE1_MAX_BYTES;
    readonly artifact_max_bytes: typeof PREDICTOR_ARTIFACT_MAX_BYTES;
  };
  readonly digests: { readonly topology: string; readonly lexical: string; readonly coedit: string };
  readonly stage1: readonly PredictorStage1Row[];
  readonly targets: {
    readonly topology: readonly PredictorTopologyEdge[];
    readonly lexical_documents: readonly { readonly path: string; readonly symbols: readonly string[] }[];
    readonly co_edits: readonly { readonly source: string; readonly target: string; readonly count: number }[];
  };
};

export class PredictorV2Error extends Error {
  readonly name = "PredictorV2Error";
  readonly code = "speculative_predictor_v2" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
