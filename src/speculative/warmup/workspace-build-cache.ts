import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { BuildWarmupError } from "./build-exec.ts";

const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 4_096;

export function digestWorkspaceBuildCache(root: string, artifactSuffix: string): string {
  const hash = createHash("sha256");
  let total = 0;
  let entries = 0;
  let artifacts = 0;
  const directories = [root];
  for (const directory of directories) {
    assertSafeDirectory(directory);
    const children = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of children) {
      entries += 1;
      if (entries > MAX_CACHE_ENTRIES) throw new BuildWarmupError("output");
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) throw new BuildWarmupError("output");
      if (entry.isDirectory() && stat.isDirectory()) {
        directories.push(path);
        continue;
      }
      if (!entry.isFile() || !stat.isFile() || stat.nlink !== 1 || !ownedByHost(stat.uid)) {
        throw new BuildWarmupError("output");
      }
      if (stat.size > MAX_CACHE_BYTES - total) throw new BuildWarmupError("output");
      const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) {
          throw new BuildWarmupError("output");
        }
        bytes = readFileSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      if (bytes.byteLength !== stat.size || bytes.byteLength > MAX_CACHE_BYTES - total) {
        throw new BuildWarmupError("output");
      }
      total += bytes.byteLength;
      if (entry.name.endsWith(artifactSuffix)) artifacts += 1;
      hash.update(relative(root, path)).update("\0").update(bytes).update("\0");
    }
  }
  if (artifacts === 0) throw new BuildWarmupError("output");
  return hash.digest("hex");
}

function assertSafeDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !ownedByHost(stat.uid) || (stat.mode & 0o022) !== 0) {
    throw new BuildWarmupError("output");
  }
}

function ownedByHost(uid: number): boolean {
  return typeof process.getuid !== "function" || uid === process.getuid();
}
