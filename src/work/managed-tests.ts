import { trackedInHead } from "../host/host-index.ts";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { FixturePreparationError, fixtureRoot, fixtureTarget } from "./evidence/fixture-manifest.ts";
import { spawnSealedHostGit } from "../host/git-authority.ts";

/** Legacy patch restoration only. Successful application is not checker authority. */
export function patchTouchedFiles(patchPath: string): string[] {
  return parsePatchPaths(readFileSync(patchPath, "utf8"));
}

function parsePatchPaths(patch: string): string[] {
  const files: string[] = [];
  for (const line of patch.split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    // Git's quoted-path encoding is deliberately unsupported by this legacy API.
    if (!match) throw new FixturePreparationError("unsupported_patch_header");
    files.push(match[1]!, match[2]!);
  }
  return [...new Set(files)];
}

type RestoreResult = { ok: true; files: string[] } | {
  ok: false; files: string[]; status: "evaluator_error"; reason_code: string; error: string; cleanup_reason_code?: string;
};

function failure(files: string[], code: string, detail?: string): RestoreResult {
  return { ok: false, files, status: "evaluator_error", reason_code: code, error: new FixturePreparationError(code, detail).message };
}
function reason(error: unknown): string {
  return error instanceof FixturePreparationError ? error.code : (error as NodeJS.ErrnoException)?.code ?? "restore_failed";
}

export function restoreManagedTests(
  workspace: string,
  patchPath: string,
): RestoreResult {
  let files: string[] = []; let privatePatchRoot: string | undefined;
  const restore = (): RestoreResult => {
    const patch = readFileSync(patchPath, "utf8");
    files = parsePatchPaths(patch);
    const root = fixtureRoot(workspace);
    for (const file of files) {
      const target = fixtureTarget(root, file, true);
      try { if (!lstatSync(target).isFile()) throw new FixturePreparationError("checker_target_not_file", file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    privatePatchRoot = mkdtempSync(join(tmpdir(), "dokkabi-restore-"));
    const pinnedPatch = join(privatePatchRoot, "official.patch"); writeFileSync(pinnedPatch, patch, { mode: 0o600 });
    if (files.length === 0) {
      return failure(files, "empty_checker_patch");
    }
    // I2 (D57g): tracked means tracked in HEAD's tree, never the index.
    const tracked = [...trackedInHead(workspace, files)];
    // HEAD's bytes, written by the host (no git `restore`, which the seal
    // does not run, and no filter or attribute of the tree applies): each
    // blob read from HEAD's tree, the file replaced beneath a root whose
    // every component is checked (fixtureTarget), its mode HEAD's.
    for (const file of tracked) {
      const listed = spawnSealedHostGit(workspace, ["ls-tree", "-z", "--full-tree", "HEAD", "--", file], { timeoutMs: 60_000 });
      const record = listed.stdout.toString("latin1").split("\0")[0] ?? "";
      const [mode, type, oid] = record.slice(0, Math.max(0, record.indexOf("\t"))).split(" ");
      if ((listed.exitCode ?? 1) !== 0 || type !== "blob" || oid === undefined || (mode !== "100644" && mode !== "100755")) {
        return failure(files, "git_restore_failed", `${file}: not a regular file in HEAD`);
      }
      const blob = spawnSealedHostGit(workspace, ["cat-file", "blob", oid], { timeoutMs: 60_000 });
      if ((blob.exitCode ?? 1) !== 0) return failure(files, "git_restore_failed", `${file}: ${blob.stderr.toString().slice(0, 200)}`);
      const target = fixtureTarget(root, file, true);
      rmSync(target, { force: true });
      writeFileSync(target, blob.stdout, { mode: mode === "100755" ? 0o755 : 0o644, flag: "wx" });
    }
    const trackedSet = new Set(tracked);
    for (const file of files.filter((item) => !trackedSet.has(item))) {
      const target = resolve(root, file);
      if (!target.startsWith(`${root}${sep}`)) {
        return failure(files, "path_escape", file);
      }
      rmSync(target, { force: true });
    }
    const apply = spawnSealedHostGit(workspace, ["apply", pinnedPatch], { timeoutMs: 60_000 });
    if ((apply.exitCode ?? 1) !== 0) {
      return failure(files, "git_apply_failed", `${apply.stdout.toString()}${apply.stderr.toString()}`.slice(0, 300));
    }
    return { ok: true, files };
  };
  let result: RestoreResult;
  try { result = restore(); }
  catch (error) { result = failure(files, reason(error)); }
  if (privatePatchRoot) {
    try { rmSync(privatePatchRoot, { recursive: true, force: true }); }
    catch (error) {
      const cleanupReason = reason(error);
      result = result.ok ? failure(files, "patch_cleanup_failed", cleanupReason) : { ...result, cleanup_reason_code: cleanupReason };
    }
  }
  return result;
}
