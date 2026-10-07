import { factorEnabled, recordUnobservedFactor } from "../../plugins/experiment-runtime.ts";
import { constants, openSync, closeSync, writeSync, chmodSync, unlinkSync, realpathSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFixtureFile, listFixtureDirectory } from "./fixture-files.ts";
import { dirname, join, relative, resolve } from "node:path";
import type { EventLog } from "../../host/event-log.ts";
import { freezeEvidence } from "./contract.ts";
import { FixturePreparationError, fixtureHash, fixtureRoot, fixtureTarget, readFixtureBytes, readFixtureEnrollment, recordFixtureBody, ownFixturePath, assertFixtureEnvironment, type FixtureManifest } from "./fixture-manifest.ts";

export type FixturePreparationReceipt = {
  schema_version: 1; preparing_seq: number | null; status: "prepared" | "evaluator_error"; fixture_digest: string | null;
  workspace: string; visibility: "visible" | "hidden"; command: string;
  attempted_paths: string[]; completed_paths: string[]; bytes_written: number; bytes_verified: number; write_attempts: { path: string; bytes_written: number; status: "completed" | "failed" }[];
  checker_protection?: "ablated";
  candidate_digest: string | null; reason_code?: string; cleanup_reason_code?: string;
};
export type PreparedFixture = {
  readonly status: "prepared"; readonly root: string; readonly manifest: FixtureManifest;
  readonly receipt: FixturePreparationReceipt; readonly receiptDigest: string;
  assertIntegrity(): void; close(): void;
};
export type FixturePreparation = { status: "not_managed"; root: string } | PreparedFixture | { status: "evaluator_error"; error: FixturePreparationError; receipt: FixturePreparationReceipt };

function reason(error: unknown): string { return error instanceof FixturePreparationError ? error.code : (error as NodeJS.ErrnoException)?.code ?? "fixture_preparation_failed"; }
function statOrMissing(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Every invocation builds a fresh, independent candidate evaluation snapshot. */
export function prepareFixture(input: { log: EventLog; workspace: string; command: string; visibility?: "visible" | "hidden" }): FixturePreparation {
  const visibility = input.visibility ?? "visible";
  const receipt: FixturePreparationReceipt = { schema_version: 1, preparing_seq: null, status: "evaluator_error", fixture_digest: null, workspace: input.workspace, visibility, command: input.command, attempted_paths: [], completed_paths: [], bytes_written: 0, bytes_verified: 0, write_attempts: [], candidate_digest: null };
  let snapshot: string | undefined;
  try {
    const removeChecker = visibility === "visible" && !factorEnabled(input.log, "managed_tests");
    // An ordinary symlink cwd remains ordinary work; managed roots stay strict.
    const lookupRoot = realpathSync(resolve(input.workspace));
    if (!input.log.events.some(event => event.name === "fixture/enrolled" && event.payload.workspace === lookupRoot)
      && !statOrMissing(join(lookupRoot, ".swe-test.patch"))) return { status: "not_managed", root: input.workspace };
    const root = fixtureRoot(input.workspace); receipt.workspace = root;
    const enrolled = readFixtureEnrollment(input.log, root);
    if (!enrolled) {
      if (statOrMissing(join(root, ".swe-test.patch"))) throw new FixturePreparationError("unenrolled_managed_checker");
      return { status: "not_managed", root };
    }
    const manifest = enrolled.manifest; receipt.fixture_digest = enrolled.digest;
    // Prework acceptance probes belong only to final acceptance. They must not
    // commandeer implementation case enrollment or a managed benchmark fixture.
    if (manifest.scope === "acceptance" && input.command !== "dokkabi acceptance") {
      if (statOrMissing(join(root, ".swe-test.patch"))) throw new FixturePreparationError("acceptance_fixture_cannot_cover_managed_work");
      return { status: "not_managed", root: input.workspace };
    }
    const ablated = removeChecker && manifest.purpose !== "observer";
    if (ablated) {
      receipt.checker_protection = "ablated";
      recordUnobservedFactor(input.log, "managed_tests", "checker_protection_disabled");
    }
    if (manifest.visibility !== visibility) throw new FixturePreparationError("fixture_visibility_mismatch");
    if (!manifest.commands.includes(input.command)) throw new FixturePreparationError("checker_command_not_enrolled");
    // Authenticate all source bodies before creating or changing the snapshot.
    const bytes = ablated ? [] : manifest.files.map(file => ({ file, bytes: readFixtureBytes(input.log, file) }));
    receipt.preparing_seq = input.log.append({ kind: "observe", name: "fixture/preparing", payload: { workspace: root, fixture_digest: enrolled.digest, visibility, command: input.command, ...(ablated ? { checker_protection: "ablated" } : {}) } }).seq;
    snapshot = realpathSync(mkdtempSync(join(tmpdir(), "dokkabi-evaluation-")));
    const snapshotRoot = snapshot;
    const candidateDirectories = new Map<string, number>();
    const candidate: { path: string; sha256: string; bytes: number; mode: number }[] = [];
    const folded = new Map<string, string>();
    for (const path of [...manifest.files.map(file => file.path), ...manifest.directories.map(directory => directory.path), ...manifest.discovery_roots, ...manifest.absent_paths, ...manifest.excluded_candidate_roots]) ownFixturePath(folded, path);
    let totalBytes = 0;
    const logRelative = relative(root, input.log.path).replaceAll("\\", "/");
    const blobsRelative = relative(root, join(dirname(input.log.path), "blobs")).replaceAll("\\", "/");
    const omitted = [".git", ".dokkabi-home", ...manifest.excluded_candidate_roots, logRelative, blobsRelative];
    const skip = (path: string): boolean => omitted.some(prefix => path === prefix || path.startsWith(prefix + "/"));
    const copy = (path: string): void => {
      if (path === ".git") return;
      ownFixturePath(folded, path);
      if (skip(path)) return;
      const target = fixtureTarget(root, path); const st = lstatSync(target);
      const destination = join(snapshotRoot, path);
      if (st.isDirectory()) {
        if ((st.mode & 0o7000) !== 0) throw new FixturePreparationError("candidate_directory_mode", path);
        candidateDirectories.set(path, st.mode & 0o777); mkdirSync(destination, { recursive: true });
        for (const entry of listFixtureDirectory(root, path)) copy(path + "/" + entry.name);
      } else {
        if ((st.mode & 0o7000) !== 0) throw new FixturePreparationError("candidate_file_mode", path);
        const acquired = readFixtureFile(root, path); const data = acquired.bytes;
        if (`${st.dev}:${st.ino}` !== acquired.identity || data.length !== st.size) throw new FixturePreparationError("candidate_changed", path);
        totalBytes += data.length;
        if (totalBytes > 1024 ** 3 || candidate.length >= 100000) throw new FixturePreparationError("candidate_snapshot_limit");
        const mode = acquired.mode;
        writeFileSync(destination, data, { flag: "wx", mode }); chmodSync(destination, mode); candidate.push({ path, sha256: fixtureHash(data), bytes: data.length, mode });
      }
    };
    for (const entry of listFixtureDirectory(root)) copy(entry.name);
    receipt.candidate_digest = recordFixtureBody(input.log, "fixture/candidate", candidate, { preparing_seq: receipt.preparing_seq, fixture_digest: enrolled.digest });
    // Discovery is host-owned: newly added checker/config files cannot enter the run.
    for (const path of ablated ? [] : [...manifest.discovery_roots, ...manifest.absent_paths]) {
      fixtureTarget(root, path, true);
      rmSync(join(snapshotRoot, path), { recursive: true, force: true });
      for (const directory of candidateDirectories.keys()) if (directory === path || directory.startsWith(path + "/")) candidateDirectories.delete(directory);
    }
    // Recreate all pinned directories after removals, independent of root order.
    for (const directory of ablated ? [] : manifest.directories) {
      mkdirSync(fixtureTarget(snapshotRoot, directory.path, true), { recursive: true });
      candidateDirectories.set(directory.path, directory.mode);
    }
    for (const item of bytes) {
      receipt.attempted_paths.push(item.file.path);
      const attempt = { path: item.file.path, bytes_written: 0, status: "failed" as "completed" | "failed" }; receipt.write_attempts.push(attempt);
      const source = fixtureTarget(root, item.file.path, true); const current = statOrMissing(source);
      if (current && !current.isFile()) throw new FixturePreparationError("checker_target_not_file", item.file.path);
      const destination = fixtureTarget(snapshotRoot, item.file.path, true);
      mkdirSync(dirname(destination), { recursive: true });
      if (statOrMissing(destination)) unlinkSync(destination);
      const fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, item.file.mode);
      try {
        while (attempt.bytes_written < item.bytes.length) {
          const count = writeSync(fd, item.bytes, attempt.bytes_written, item.bytes.length - attempt.bytes_written);
          if (count <= 0) throw new FixturePreparationError("checker_write_incomplete", item.file.path);
          attempt.bytes_written += count; receipt.bytes_written += count;
        }
      } finally { closeSync(fd); }
      chmodSync(destination, item.file.mode);
      if (fixtureHash(readFileSync(destination)) !== item.file.sha256 || lstatSync(destination).nlink !== 1) throw new FixturePreparationError("checker_write_integrity", item.file.path);
      attempt.status = "completed"; receipt.completed_paths.push(item.file.path); receipt.bytes_verified += item.bytes.length;
    }
    for (const [path, mode] of [...candidateDirectories].sort(([a], [b]) => b.split("/").length - a.split("/").length)) chmodSync(join(snapshotRoot, path), mode);
    const check = (): void => {
      try {
      if (readFixtureEnrollment(input.log, root)?.digest !== enrolled.digest) throw new FixturePreparationError("fixture_enrollment_changed");
        for (const excluded of manifest.excluded_candidate_roots) if (statOrMissing(join(snapshotRoot, excluded))) throw new FixturePreparationError("excluded_candidate_path_added", excluded);
      if (ablated) return;
      for (const directory of manifest.directories) {
        const st = lstatSync(fixtureTarget(snapshotRoot, directory.path));
        if (!st.isDirectory() || (st.mode & 0o7777) !== directory.mode) throw new FixturePreparationError("prepared_directory_changed", directory.path);
      }
      for (const file of manifest.files) {
        const target = fixtureTarget(snapshotRoot, file.path); const st = lstatSync(target);
        if (!st.isFile() || (st.mode & 0o7777) !== file.mode || fixtureHash(readFixtureFile(snapshotRoot, file.path).bytes) !== file.sha256) throw new FixturePreparationError("prepared_checker_changed", file.path);
      }
      for (const path of manifest.absent_paths) if (statOrMissing(join(snapshotRoot, path))) throw new FixturePreparationError("prepared_absent_path_added", path);
      const expected = new Set([...manifest.files.map(file => file.path), ...manifest.directories.map(directory => directory.path)]);
      const discover = (path: string): void => {
        const target = fixtureTarget(snapshotRoot, path); const st = lstatSync(target);
        if (!expected.has(path)) throw new FixturePreparationError("prepared_discovery_changed", path);
        if (st.isDirectory()) for (const entry of listFixtureDirectory(snapshotRoot, path)) discover(path + "/" + entry.name);
        else if (!expected.has(path)) throw new FixturePreparationError("prepared_discovery_changed", path);
      };
      for (const path of manifest.discovery_roots) discover(path);
      } catch (error) { throw error instanceof FixturePreparationError ? error : new FixturePreparationError(reason(error)); }
    };
    check(); receipt.status = "prepared";
    const receiptDigest = recordFixtureBody(input.log, "fixture/preparation", receipt, { status: receipt.status, fixture_digest: enrolled.digest, visibility, bytes_written: receipt.bytes_written, bytes_verified: receipt.bytes_verified, ...(receipt.cleanup_reason_code ? { cleanup_reason_code: receipt.cleanup_reason_code } : {}), attempted_count: receipt.attempted_paths.length, completed_count: receipt.completed_paths.length });
    let closed = false; let cleaned = false;
    const prepared: PreparedFixture = {
      status: "prepared", root: snapshotRoot, manifest, receipt, receiptDigest,
      assertIntegrity() {
        if (closed) throw new FixturePreparationError("prepared_fixture_closed");
        try { check(); input.log.append({ kind: "observe", name: "fixture/integrity", payload: { status: "passed", preparation_ref: receiptDigest } }); }
        catch (error) { input.log.append({ kind: "observe", name: "fixture/integrity", payload: { status: "evaluator_error", preparation_ref: receiptDigest, reason_code: reason(error) } }); throw error; }
      },
      close() {
        if (cleaned) return; closed = true;
        try { rmSync(snapshotRoot, { recursive: true, force: true }); cleaned = true; }
        catch (error) { input.log.append({ kind: "observe", name: "fixture/cleanup", payload: { status: "evaluator_error", preparation_ref: receiptDigest, reason_code: reason(error) } }); throw new FixturePreparationError("snapshot_cleanup_failed"); }
        input.log.append({ kind: "observe", name: "fixture/cleanup", payload: { status: "completed", preparation_ref: receiptDigest } });
      },
    };
    freezeEvidence(prepared.manifest); freezeEvidence(prepared.receipt); Object.freeze(prepared);
    PREPARED_FIXTURES.set(prepared, { check: () => { if (closed) throw new FixturePreparationError("prepared_fixture_closed"); prepared.assertIntegrity(); }, log: input.log });
    return prepared;
  } catch (error) {
    receipt.status = "evaluator_error"; receipt.reason_code = reason(error);
    if (snapshot) {
      try { rmSync(snapshot, { recursive: true, force: true }); } catch (cleanupError) { receipt.cleanup_reason_code = reason(cleanupError); }
    }
    recordFixtureBody(input.log, "fixture/preparation", receipt, { status: "evaluator_error", fixture_digest: receipt.fixture_digest, visibility, reason_code: receipt.reason_code, bytes_written: receipt.bytes_written, bytes_verified: receipt.bytes_verified, ...(receipt.cleanup_reason_code ? { cleanup_reason_code: receipt.cleanup_reason_code } : {}), attempted_count: receipt.attempted_paths.length, completed_count: receipt.completed_paths.length });
    return { status: "evaluator_error", error: new FixturePreparationError(receipt.reason_code), receipt };
  }
}

export function requirePreparedFixture(input: Parameters<typeof prepareFixture>[0]): PreparedFixture | undefined {
  const result = prepareFixture(input);
  if (result.status === "evaluator_error") throw result.error;
  return result.status === "prepared" ? result : undefined;
}

const PREPARED_FIXTURES = new WeakMap<object, { check: () => void; log: EventLog }>();
/** Only a live host-created snapshot capability can authorize an evaluator backend. */
export function assertPreparedFixture(value: unknown): asserts value is PreparedFixture {
  if (!value || typeof value !== "object") throw new FixturePreparationError("untrusted_prepared_fixture");
  const check = PREPARED_FIXTURES.get(value);
  if (!check) throw new FixturePreparationError("untrusted_prepared_fixture");
  check.check();
}

/** Validate the actual filtered child environment immediately before dispatch. */
export function assertPreparedFixtureEnvironment(prepared: PreparedFixture, environment: Readonly<Record<string, string>>): void {
  assertPreparedFixture(prepared);
  if (prepared.receipt.checker_protection !== "ablated") assertFixtureEnvironment(prepared.manifest, environment);
  recordFixtureBody(PREPARED_FIXTURES.get(prepared)!.log, "fixture/environment", { preparation_ref: prepared.receiptDigest, environment }, { preparation_ref: prepared.receiptDigest });
}
