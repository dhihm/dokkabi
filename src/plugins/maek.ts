import { createOwnedMaek } from "../maek/owned-resource.ts";
import { dirname, join } from "node:path";
import { canonicalJson } from "../host/canonical.ts";
import { assertNoSecrets, collectStrings, containsPrivateInfrastructureValue } from "../host/redact.ts";
import { digestRows } from "../maek/hash.ts";
import { createMaekService, type MaekService } from "../maek/service.ts";
import type {
  HostContext,
  OwnedWorkResourceRegistry,
  PluginModule,
  SwarmMemoryContributionRegistry,
  WorkCheckpointContributionRegistry,
} from "../loader/types.ts";
import type { SwarmMemoryCompileInput, SwarmMemoryContribution } from "../swarm/memory-view.ts";

export type { MaekService } from "../maek/service.ts";

const MAEK_MEMORY_ROW_LIMIT = 3;
const MAEK_MEMORY_TEXT_BYTES = 384;
const MAEK_MEMORY_UNAVAILABLE = "MAEK L1 memory is unavailable for this captured source snapshot.";
const RAW_ABSOLUTE_PATH = /(?:^|[\s"'`(=])(?:~\/|\/(?!\/)[^\s"'`)>\]}]+|[A-Za-z]:[\\/][^\s"'`)>\]}]+|\\\\[^\s\\/"'`]+\\[^\s"'`)>\]}]+)/u;

export const plugin: PluginModule = {
  id: "maek",
  claims: [
    { key: "maek", role: "definition" },
    { key: "maek", role: "provider" },
    { key: "swarm_memory_contributions", role: "consumer" },
    { key: "work_checkpoint_contributions", role: "consumer", optional: true },
    { key: "owned_work_resources", role: "consumer", optional: true },
  ],
  register(ctx: HostContext) {
    const replay = ctx.log.isReadOnly === true;
    const serviceInput = {
      log: ctx.log,
      sessionId: ctx.sessionId,
      // Beside the log this session actually writes, not beside a session id
      // resolved against the operator's home. A session whose log lives
      // elsewhere — a test, a per-instance evaluator home, a board pointed at
      // a path — created an empty directory under ~/.dokkabi/sessions anyway,
      // and `dokkabi dash` with no --session follows the newest one there: a
      // gate run left three of them and the operator's board opened on an
      // empty session.
      dbPath: join(dirname(ctx.log.path), "maek.duckdb"),
      replay,
    };
    const resources = ctx.tryGet<OwnedWorkResourceRegistry>("owned_work_resources");
    let owned: ReturnType<typeof createOwnedMaek> | undefined;
    // Enroll before eager acquisition so a busy registry refuses before open.
    if (resources && !replay) ctx.effect(() => resources.register("maek", {
      async suspend() { await owned?.suspend(); },
      async resume() { await owned?.resume(); },
    }));
    owned = replay ? undefined : createOwnedMaek(serviceInput);
    const maek = owned?.service ?? createMaekService(serviceInput);
    ctx.define("maek", { engine: "duckdb", modelFacing: false, close: () => maek.close() });
    ctx.provide("maek", maek);
    ctx.effect(() => () => maek.close());
    const memory = ctx.tryGet<SwarmMemoryContributionRegistry>("swarm_memory_contributions");
    if (memory) ctx.effect(() => memory.register("maek", (input) => maekMemory(maek, input)));
    // Ingest otherwise advances only at boot and inside a query, so a
    // long-running session that never queries projects nothing (#109). Each
    // work milestone pulls the derived store up to the current log prefix; a
    // failure is already recorded as maek/ingest_failed and must not fail
    // the milestone itself.
    const checkpoints = ctx.tryGet<WorkCheckpointContributionRegistry>("work_checkpoint_contributions");
    if (checkpoints && !replay) {
      ctx.effect(() =>
        checkpoints.register("maek", async () => {
          try {
            await maek.ingest();
          } catch {
            // recorded by the service; a milestone never fails on recall upkeep
          }
        }),
      );
    }
  },
};

async function maekMemory(
  maek: MaekService,
  input: SwarmMemoryCompileInput,
): Promise<SwarmMemoryContribution> {
  try {
    const [decisions, faults] = await Promise.all([
      maek.queryDecisions(input.purpose, { limit: MAEK_MEMORY_ROW_LIMIT }),
      maek.querySimilarFaults({ errorPattern: input.purpose, limit: MAEK_MEMORY_ROW_LIMIT }),
    ]);
    const exposed = {
      format: 1,
      decisions: decisions.map((row) => ({
        decision_id: row.decision_id,
        ...(row.symbol_id ? { symbol_id: row.symbol_id } : {}),
        decision_type: row.decision_type,
        rationale: row.rationale,
      })),
      faults: faults.map((row) => ({
        fault_id: row.fault_id,
        ...(row.command_digest ? { command_digest: row.command_digest } : {}),
        exit_code: row.exit_code,
        fault_excerpt: row.fault_excerpt,
      })),
    };
    assertSafeMemory(exposed);
    const bounded = {
      ...exposed,
      decisions: exposed.decisions.map((row) => ({
        ...row,
        rationale: boundedUtf8(row.rationale, MAEK_MEMORY_TEXT_BYTES),
      })),
      faults: exposed.faults.map((row) => ({
        ...row,
        fault_excerpt: boundedUtf8(row.fault_excerpt, MAEK_MEMORY_TEXT_BYTES),
      })),
    };
    assertSafeMemory(bounded);
    const decisionRevision = digestRows(decisions);
    const faultRevision = digestRows(faults);
    return {
      sufficiency: decisions.length + faults.length > 0 ? "sufficient" : "insufficient",
      content: canonicalJson(bounded),
      sourceRevisionDigest: digestRows({ decisions: decisionRevision, faults: faultRevision }),
      selectedIds: [
        ...decisions.map((row) => row.decision_id),
        ...faults.map((row) => row.fault_id),
      ],
      evidenceDigests: [decisionRevision, faultRevision],
    };
  } catch {
    return {
      sufficiency: "insufficient",
      content: MAEK_MEMORY_UNAVAILABLE,
      sourceRevisionDigest: digestRows([]),
      selectedIds: [],
      evidenceDigests: [],
    };
  }
}

function assertSafeMemory(value: unknown): void {
  assertNoSecrets(value);
  if (containsPrivateInfrastructureValue(value) || containsRawFilesystemPath(value)) {
    throw new Error("MAEK memory contains a private coordinate or raw path");
  }
}

function containsRawFilesystemPath(value: unknown): boolean {
  return collectStrings(value).some((text) => RAW_ABSOLUTE_PATH.test(text));
}

function boundedUtf8(value: string, bytes: number): string {
  if (Buffer.byteLength(value) <= bytes) return value;
  const suffix = "\n[MAEK text truncated]";
  const available = Math.max(0, bytes - Buffer.byteLength(suffix));
  const prefix = Buffer.from(value).subarray(0, available).toString("utf8").replace(/\uFFFD+$/gu, "").trimEnd();
  return `${prefix}${suffix}`;
}
