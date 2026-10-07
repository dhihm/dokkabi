import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BlobStore } from "../../src/host/blob-store.ts";
import type { EventLog } from "../../src/host/event-log.ts";
import { assertSandboxExecutableIdentity, sealHostRuntimeExecutable } from "../../src/host/sandbox-executable.ts";
import { canonicalJson } from "../../src/host/canonical.ts";
import { readFixtureFile, type FixtureFileRead } from "../../src/work/evidence/fixture-files.ts";
import { enrollFixture, fixtureHash, fixturePathSchema, fixtureRoot } from "../../src/work/evidence/fixture-manifest.ts";
import { prepareFixture, type PreparedFixture } from "../../src/work/evidence/fixture-prepare.ts";

/** The adapter only loads candidate code. All output checks execute in the host. */
const ADAPTER = 'await import("../candidate.ts");\n';
const ADAPTER_PATH = ".observer/adapter.ts";
const MAX_CANDIDATE_BYTES = 8 * 1024 * 1024;

export class BatchObservationError extends Error {
  constructor(readonly status: "unavailable" | "evaluator_error", readonly code: string, cause?: unknown) {
    super(`${status}: ${code}`, { cause }); this.name = "BatchObservationError";
  }
}

export interface NativeBatchPreparation {
  readonly fixture: PreparedFixture;
  readonly candidateRef: { path: string; digest: string };
  readonly contractRef: { path: string; digest: string };
  readonly sourceRef: string;
  assertIntegrity(): void;
  finish(): void;
  close(): void;
}

function sameFile(left: FixtureFileRead, right: FixtureFileRead): boolean {
  return left.identity === right.identity && left.mode === right.mode && left.bytes.equals(right.bytes);
}

/** A reference invocation admits one self-contained source file as candidate input. */
export function prepareNativeBatch(input: {
  log: EventLog; workspaceRoot: string; candidatePath: string; caseId: string; contract: unknown;
}): NativeBatchPreparation {
  if (input.log.isReadOnly) throw new BatchObservationError("unavailable", "replay_cannot_measure");
  const workspace = fixtureRoot(input.workspaceRoot);
  const candidatePath = fixturePathSchema.parse(input.candidatePath);
  const original = readFixtureFile(workspace, candidatePath, { maxBytes: MAX_CANDIDATE_BYTES });
  const sourceBody = canonicalJson({
    schema_version: 1, case_id: input.caseId, candidate_path: candidatePath,
    sha256: fixtureHash(original.bytes), identity: original.identity, mode: original.mode,
    encoding: "base64", data: original.bytes.toString("base64"),
  });
  const sourceRef = fixtureHash(sourceBody);
  BlobStore.forSession(input.log.path).putAndAppend(input.log, { kind: "observe", name: "measurement/source", payload: {
    case_id: input.caseId, artifact: "measurement-source-v1", digest: sourceRef,
  } }, sourceBody);
  const hostRoot = realpathSync(mkdtempSync(join(tmpdir(), "dokkabi-observer-")));
  let fixture: PreparedFixture | undefined;
  let closed = false;
  try {
    const intake = join(hostRoot, "intake"); const sourceRoot = join(hostRoot, "host-source");
    mkdirSync(intake, { mode: 0o700 }); mkdirSync(join(sourceRoot, ".observer"), { recursive: true, mode: 0o700 });
    writeFileSync(join(intake, "candidate.ts"), original.bytes, { mode: original.mode, flag: "wx" });
    chmodSync(join(intake, "candidate.ts"), original.mode);
    writeFileSync(join(sourceRoot, ADAPTER_PATH), ADAPTER, { mode: 0o400, flag: "wx" });
    const contractText = canonicalJson(input.contract);
    const contractPath = join(hostRoot, "contract.json");
    writeFileSync(contractPath, contractText, { mode: 0o400, flag: "wx" });
    const contract = readFixtureFile(hostRoot, "contract.json");
    const helper = readFixtureFile(sourceRoot, ADAPTER_PATH);
    const modules = ["native.ts", "batch.ts"].map(path => ({ path, file: readFixtureFile(dirname(import.meta.path), path) }));
    enrollFixture(input.log, {
      id: `observer-${randomUUID()}`, workspace: intake, sourceRoot, visibility: "visible", purpose: "observer",
      files: [{ path: ADAPTER_PATH, role: "entrypoint" }], discoveryRoots: [".observer"],
      environment: {}, commands: ["bun .observer/adapter.ts"], absentPaths: ["bunfig.toml", "package.json", "tsconfig.json"],
    });
    const preparation = prepareFixture({ log: input.log, workspace: intake, command: "bun .observer/adapter.ts" });
    if (preparation.status === "evaluator_error") throw preparation.error;
    if (preparation.status !== "prepared") throw new BatchObservationError("evaluator_error", "observer_fixture_unprepared");
    fixture = preparation;
    const prepared = fixture;
    const runtime = sealHostRuntimeExecutable(resolve(process.execPath), [prepared.root, workspace]);
    const assertIntegrity = (): void => {
      if (closed) throw new BatchObservationError("evaluator_error", "observer_preparation_closed");
      if (!sameFile(original, readFixtureFile(workspace, candidatePath, { maxBytes: MAX_CANDIDATE_BYTES }))) throw new BatchObservationError("evaluator_error", "observer_candidate_changed");
      if (!sameFile(contract, readFixtureFile(hostRoot, "contract.json"))) throw new BatchObservationError("evaluator_error", "observer_contract_changed");
      if (!sameFile(helper, readFixtureFile(sourceRoot, ADAPTER_PATH))) throw new BatchObservationError("evaluator_error", "observer_helper_changed");
      for (const module of modules) if (!sameFile(module.file, readFixtureFile(dirname(import.meta.path), module.path))) throw new BatchObservationError("evaluator_error", "observer_source_changed");
      if (!original.bytes.equals(readFixtureFile(prepared.root, "candidate.ts", { maxBytes: MAX_CANDIDATE_BYTES }).bytes)) throw new BatchObservationError("evaluator_error", "observer_prepared_candidate_changed");
      assertSandboxExecutableIdentity(runtime);
      prepared.assertIntegrity();
    };
    assertIntegrity();
    return Object.freeze({
      fixture: prepared,
      candidateRef: Object.freeze({ path: resolve(workspace, candidatePath), digest: fixtureHash(original.bytes) }),
      contractRef: Object.freeze({ path: contractPath, digest: fixtureHash(contractText) }), sourceRef,
      assertIntegrity,
      finish() { prepared.close(); },
      close() {
        closed = true;
        try { prepared.close(); } finally { rmSync(hostRoot, { recursive: true, force: true }); }
      },
    });
  } catch (error) {
    try { fixture?.close(); } finally { rmSync(hostRoot, { recursive: true, force: true }); }
    throw error;
  }
}
