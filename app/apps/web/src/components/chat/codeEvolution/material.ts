import * as Schema from "effect/Schema";
import type { WorkbenchCode } from "@t3tools/contracts";

const Text = Schema.String.check(Schema.isMaxLength(512 * 1024));
const Id = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Coordinate = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(1_000_000),
);
const Extent = Coordinate.check(Schema.isGreaterThan(0));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Ref = Schema.Struct({ seq: Count, hash: Digest });
const Status = Schema.Literals([
  "parsed",
  "parse_failed",
  "excluded",
  "unsupported",
  "missing",
  "unavailable",
  "oversized",
  "invalid_utf8",
]);
const Node = Schema.Struct({
  id: Id,
  kind: Id,
  name: Text,
  path: Id,
  x: Coordinate,
  y: Coordinate,
  w: Extent,
  h: Extent,
  parent: Schema.optional(Id),
  line: Schema.optional(Count),
  endLine: Schema.optional(Count),
  signature: Schema.optional(Text),
  diagnosticCount: Schema.optional(Count),
});
const Edge = Schema.Struct({
  id: Id,
  source: Id,
  target: Id,
  kind: Id,
  label: Schema.optional(Text),
});
const Row = Schema.Struct({
  t: Schema.Literals([" ", "+", "-"]),
  a: Schema.NullOr(Count),
  b: Schema.NullOr(Count),
  text: Text,
});
const Diff = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("exact"),
    value: Schema.Struct({
      identical: Schema.Boolean,
      added: Count,
      removed: Count,
      hunks: Schema.Array(
        Schema.Struct({
          aStart: Count,
          aLines: Count,
          bStart: Count,
          bLines: Count,
          rows: Schema.Array(Row).check(Schema.isMaxLength(1000)),
        }),
      ).check(Schema.isMaxLength(1000)),
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("summary_only"),
    reason: Id,
    beforeLines: Count,
    afterLines: Count,
  }),
]);
const Material = Schema.Struct({
  schema: Schema.Literal("code-evolution-v1"),
  sessionId: Id,
  graphDigest: Digest,
  previous: Schema.NullOr(Schema.Struct({ sessionId: Id, version: Ref, digest: Digest })),
  identity: Schema.Struct({
    parser: Schema.Struct({ name: Id, version: Id }),
    redaction: Schema.Struct({ version: Count }),
  }),
  graph: Schema.Struct({
    nodes: Schema.Array(Node).check(Schema.isMaxLength(20_000)),
    edges: Schema.Array(Edge).check(Schema.isMaxLength(80_000)),
  }),
  files: Schema.Array(
    Schema.Struct({
      path: Id,
      status: Status,
      original: Schema.NullOr(Schema.Struct({ digest: Digest, bytes: Count })),
      sanitized: Schema.NullOr(Schema.Struct({ digest: Digest, bytes: Count, text: Text })),
    }),
  ).check(Schema.isMaxLength(128)),
  diff: Schema.Struct({
    files: Schema.Array(
      Schema.Struct({ path: Id, status: Status, originalChanged: Schema.Boolean, textDiff: Diff }),
    ).check(Schema.isMaxLength(128)),
    outOfScope: Schema.Array(Id).check(Schema.isMaxLength(128)),
  }),
  coverage: Schema.Struct({
    scope: Schema.Literal("explicit_selected_paths"),
    consistency: Schema.Literal("checked_per_file_non_atomic"),
    coordinateSpace: Schema.Literal("sanitized_utf16_lines"),
    selected: Count.check(Schema.isLessThanOrEqualTo(128)),
    statuses: Schema.Array(Schema.Struct({ path: Id, status: Status })).check(
      Schema.isMaxLength(128),
    ),
    outOfScope: Schema.Array(Id).check(Schema.isMaxLength(128)),
  }),
  links: Schema.Array(
    Schema.Struct({
      path: Id,
      receipt: Schema.Struct({
        verification: Schema.Literal("linked_recorded_tool_change"),
        tool: Id,
        operation: Id,
        commit: Ref,
        call: Ref,
        result: Ref,
        exclusiveAuthorship: Schema.Literal(false),
        taskSuccess: Schema.Literal("not_established"),
      }),
    }),
  ).check(Schema.isMaxLength(128)),
});
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Material));
export type CodeMaterial = typeof Material.Type;
export type CodeNode = typeof Node.Type;

/** The adapter verifies canonical bytes and digests. The renderer additionally
 * rejects shapes that cannot be safely navigated; it never reparses live files. */
export function decodeCodeMaterial(body: NonNullable<WorkbenchCode["body"]>): CodeMaterial {
  const material = decode(body.text);
  if (material.sessionId !== body.reference.sessionId)
    throw new Error("Code material belongs to another session.");
  const ids = new Set(material.graph.nodes.map((n) => n.id));
  if (ids.size !== material.graph.nodes.length) throw new Error("Duplicate Code node identity.");
  if (
    new Set(material.graph.edges.map((e) => e.id)).size !== material.graph.edges.length ||
    material.graph.edges.some((e) => !ids.has(e.source) || !ids.has(e.target)) ||
    material.graph.nodes.some((n) => n.parent !== undefined && !ids.has(n.parent))
  )
    throw new Error("Broken Code graph relationship.");
  const paths = new Set(material.files.map((f) => f.path));
  if (
    paths.size !== material.files.length ||
    material.coverage.selected !== paths.size ||
    material.diff.files.some((f) => !paths.has(f.path)) ||
    material.coverage.statuses.length !== paths.size ||
    material.coverage.statuses.some(
      (f) =>
        !paths.has(f.path) || material.files.find((v) => v.path === f.path)?.status !== f.status,
    )
  )
    throw new Error("Code file coverage mismatch.");
  return material;
}

export function resolveCodeFilePath(
  material: CodeMaterial,
  selected: string | null,
  file: string | null,
): string | undefined {
  const nodePath = material.graph.nodes.find((n) => n.id === selected)?.path;
  const paths = new Set(material.files.map((f) => f.path));
  return nodePath && paths.has(nodePath)
    ? nodePath
    : file && paths.has(file)
      ? file
      : material.files[0]?.path;
}
