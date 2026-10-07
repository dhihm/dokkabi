// oxlint-disable t3code/no-global-process-runtime -- Native runtime qualification must match the actual build process.
// @effect-diagnostics nodeBuiltinImport:off - Packaging operates on a frozen Git archive and an isolated native dependency install.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
export const DOKKABI_RUNTIME_RESOURCE = {
  from: "apps/desktop/prod-resources/dokkabi-runtime",
  to: "dokkabi-runtime",
} as const;
export const DOKKABI_RUNTIME_FILE_EXCLUSIONS = [
  `!${DOKKABI_RUNTIME_RESOURCE.from}`,
  `!${DOKKABI_RUNTIME_RESOURCE.from}/**/*`,
] as const;

export interface DokkabiRuntimeManifest {
  readonly schema: 1;
  readonly harnessRevision: string;
  readonly bunVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly entry: "harness/scripts/desktop-child.ts";
  readonly runtime: "bin/bun";
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
  }>;
}

export interface DokkabiRuntimeSource {
  readonly source: string;
  readonly bun: string;
}

/** No opt-in means the existing externally owned gateway packaging stays in use. */
export function resolveDokkabiRuntimeSource(
  env: Readonly<Record<string, string | undefined>>,
  target: { readonly platform: "mac" | "linux" | "win"; readonly arch: string },
  host = { platform: process.platform as string, arch: process.arch as string },
): DokkabiRuntimeSource | undefined {
  const source = env.DOKKABI_DESKTOP_HARNESS_SOURCE;
  if (source === undefined) return undefined;
  const bun = env.DOKKABI_DESKTOP_BUN;
  if (!NodePath.isAbsolute(source) || !bun || !NodePath.isAbsolute(bun)) {
    throw new Error(
      "Bundled Dokkabi requires absolute DOKKABI_DESKTOP_HARNESS_SOURCE and DOKKABI_DESKTOP_BUN paths.",
    );
  }
  const platform = { mac: "darwin", linux: "linux", win: "win32" }[target.platform];
  if (platform !== host.platform || target.arch !== host.arch) {
    throw new Error(
      `Bundled Dokkabi supports only the actual build host ${host.platform}/${host.arch}; requested ${platform}/${target.arch}. Universal and cross-target bundles are unsupported.`,
    );
  }
  return { source, bun };
}

const SOURCE_TREES = new Set(["src", "plugins", "prompts", "runners", "market", "resources"]);
const SOURCE_FILES = new Set([
  "LICENSE",
  "package.json",
  "bun.lock",
  "tsconfig.json",
  "scripts/desktop-child.ts",
]);
const REQUIRED_SOURCE_FILES = [
  "LICENSE",
  "package.json",
  "bun.lock",
  "src/dash/desktop-server.ts",
  "plugins/manifest.json",
  "prompts/system.md",
  "scripts/desktop-child.ts",
] as const;

export function isDokkabiRuntimeSourcePath(file: string): boolean {
  const parts = file.split("/");
  // Even a committed operator file must never enter a distributable payload.
  if (
    parts.some((part) =>
      /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.git|auth\.json|credentials?\.json|profiles?|\.dokkabi|\.pi|node_modules)$/u.test(
        part,
      ),
    )
  )
    return false;
  return (
    SOURCE_FILES.has(file) ||
    SOURCE_TREES.has(parts[0]!) ||
    /^packages\/[^/]+\/package\.json$/u.test(file)
  );
}

async function git(source: string, args: ReadonlyArray<string>) {
  return (
    await execute("git", ["-C", source, ...args], { maxBuffer: 32 * 1024 * 1024 })
  ).stdout.trim();
}

export async function inspectDokkabiRuntimeSource(source: string) {
  if (
    !NodePath.isAbsolute(source) ||
    (await NodeFSP.realpath(source)) !==
      (await NodeFSP.realpath(await git(source, ["rev-parse", "--show-toplevel"])))
  ) {
    throw new Error("Dokkabi harness source must be an absolute Git repository root.");
  }
  if (await git(source, ["status", "--porcelain", "--untracked-files=no"])) {
    throw new Error(
      "Dokkabi harness source has uncommitted tracked changes; commit a frozen source revision before packaging.",
    );
  }
  const revision = await git(source, ["rev-parse", "HEAD"]);
  const records = (await git(source, ["ls-tree", "-r", "--full-tree", "-z", revision]))
    .split("\0")
    .filter(Boolean);
  const files: string[] = [];
  const blobs = new Map<string, string>();
  for (const record of records) {
    const tab = record.indexOf("\t");
    const file = record.slice(tab + 1);
    if (!isDokkabiRuntimeSourcePath(file)) continue;
    if (!/^100(?:644|755) blob /u.test(record.slice(0, tab))) {
      throw new Error(`Dokkabi source payload must contain regular files: ${file}.`);
    }
    files.push(file);
    blobs.set(file, record.slice(0, tab).split(" ")[2]!);
  }
  for (const file of REQUIRED_SOURCE_FILES) {
    if (!files.includes(file))
      throw new Error(`Frozen Dokkabi revision is missing required payload ${file}.`);
  }
  return { revision, files, blobs };
}

export async function recordDokkabiRuntimeFiles(
  root: string,
): Promise<DokkabiRuntimeManifest["files"]> {
  const actualRoot = await NodeFSP.realpath(root);
  const files: Array<{ path: string; sha256: string; size: number }> = [];
  const walk = async (directory: string) => {
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const absolute = NodePath.join(directory, entry.name);
      const relative = NodePath.relative(root, absolute).split(NodePath.sep).join("/");
      if (relative === "manifest.json" && entry.isFile()) continue;
      if (entry.isSymbolicLink()) {
        const resolved = await NodeFSP.realpath(absolute);
        if (!resolved.startsWith(`${actualRoot}${NodePath.sep}`))
          throw new Error(`Dokkabi payload symlink escapes its resource root: ${relative}.`);
      } else if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const bytes = await NodeFSP.readFile(absolute);
        files.push({
          path: relative,
          sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
          size: bytes.length,
        });
      } else {
        throw new Error(`Dokkabi payload contains a non-regular file: ${relative}.`);
      }
    }
  };
  await walk(root);
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// Import every default manifest module without activating plugins or opening a session.
const NATIVE_PROBE = `
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
const db = await DuckDBInstance.create(':memory:');
const connection = await db.connect();
await connection.run('SELECT 42');
connection.closeSync(); db.closeSync();
const manifestPath = resolve('plugins/manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (!Array.isArray(manifest.plugins) || manifest.plugins.length === 0) throw Error('Missing plugin manifest entries');
for (const plugin of manifest.plugins) {
  let modulePath;
  if (plugin.path) modulePath = resolve(dirname(manifestPath), plugin.path);
  else {
    const descriptorPath = resolve(dirname(manifestPath), plugin.package);
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
    modulePath = resolve(dirname(descriptorPath), descriptor.module);
  }
  await import(pathToFileURL(modulePath).href);
}
await import(pathToFileURL(resolve('src/dash/desktop-server.ts')).href);
await import(pathToFileURL(resolve('scripts/desktop-child.ts')).href);
console.log(JSON.stringify({ platform: process.platform, arch: process.arch, bunVersion: Bun.version, native: 'duckdb', plugins: manifest.plugins.length }));
`;

export async function validateBunLicenseNotices(
  harness: string,
  bunVersion: string,
): Promise<void> {
  if (!/^\d+\.\d+\.\d+$/u.test(bunVersion)) throw new Error("Invalid bundled Bun license version.");
  await validateBunLicenseNoticeDirectory(
    NodePath.join(harness, "resources/licenses/bun", bunVersion),
    bunVersion,
  );
}

export async function validateBunLicenseNoticeDirectory(
  licenseRoot: string,
  bunVersion: string,
): Promise<void> {
  for (const file of [
    "BUN-LICENSE.txt",
    "LGPL-2.0.txt",
    "LGPL-2.1.txt",
    "README.md",
    "provenance.json",
  ]) {
    try {
      await NodeFSP.access(NodePath.join(licenseRoot, file));
    } catch {
      throw new Error(`Bundled Bun ${bunVersion} is missing license notices: ${file}.`);
    }
  }
  const provenance = JSON.parse(
    await NodeFSP.readFile(NodePath.join(licenseRoot, "provenance.json"), "utf8"),
  );
  const expected = ["BUN-LICENSE.txt", "LGPL-2.0.txt", "LGPL-2.1.txt"];
  if (
    provenance.version !== bunVersion ||
    !Array.isArray(provenance.files) ||
    provenance.files.length !== expected.length ||
    expected.some((path) => !provenance.files.some((file: { path: string }) => file.path === path))
  )
    throw new Error("Bundled Bun license provenance does not match its runtime version.");
  for (const file of provenance.files) {
    if (
      typeof file.path !== "string" ||
      NodePath.basename(file.path) !== file.path ||
      !/^[a-f0-9]{64}$/u.test(file.sha256)
    )
      throw new Error("Invalid Bun license provenance entry.");
    const bytes = await NodeFSP.readFile(NodePath.join(licenseRoot, file.path));
    if (NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== file.sha256)
      throw new Error(`Altered Bun license notice: ${file.path}.`);
  }
}

export async function stageDokkabiRuntime(
  input: DokkabiRuntimeSource & { readonly destination: string },
): Promise<DokkabiRuntimeManifest> {
  const source = await inspectDokkabiRuntimeSource(input.source);
  const bunStat = await NodeFSP.stat(input.bun);
  if (!bunStat.isFile()) throw new Error("DOKKABI_DESKTOP_BUN must name a real executable file.");
  await NodeFSP.access(input.bun, NodeFSP.constants.X_OK);
  if (!NodePath.isAbsolute(input.destination))
    throw new Error("Dokkabi staging destination must be absolute.");
  // Refuse reuse so stale dependencies or operator state cannot become part of this build.
  const scratch = await NodeFSP.mkdtemp(
    NodePath.join(NodePath.dirname(input.destination), ".dokkabi-install-"),
  );
  try {
    await NodeFSP.mkdir(input.destination);
  } catch (error) {
    await NodeFSP.rm(scratch, { recursive: true, force: true });
    throw error;
  }
  const harness = NodePath.join(input.destination, "harness");
  const runtime = NodePath.join(input.destination, "bin/bun");
  try {
    await NodeFSP.mkdir(harness);
    await NodeFSP.mkdir(NodePath.dirname(runtime));
    await NodeFSP.copyFile(input.bun, runtime);
    await NodeFSP.chmod(runtime, 0o755);
    const archive = NodePath.join(scratch, "source.tar");
    await execute("git", [
      "-C",
      input.source,
      "archive",
      "--format=tar",
      `--output=${archive}`,
      source.revision,
      "--",
      ...source.files,
    ]);
    await execute("tar", ["-xf", archive, "-C", harness]);
    const archivedFiles = await recordDokkabiRuntimeFiles(harness);
    if (
      archivedFiles.length !== source.files.length ||
      archivedFiles.some((file) => !source.blobs.has(file.path))
    )
      throw new Error("Dokkabi Git archive does not match the selected committed payload.");
    for (const file of source.files) {
      const bytes = await NodeFSP.readFile(NodePath.join(harness, file));
      const expected = source.blobs.get(file)!;
      const actual = NodeCrypto.createHash(expected.length === 64 ? "sha256" : "sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
      if (actual !== expected)
        throw new Error(`Dokkabi Git archive altered committed payload ${file}.`);
    }
    const home = NodePath.join(scratch, "home");
    await NodeFSP.mkdir(home);
    // Do not inherit provider credentials, registry tokens, Git configuration or operator Bun config.
    const installEnv = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: scratch,
      TEMP: scratch,
      BUN_INSTALL_CACHE_DIR: NodePath.join(scratch, "cache"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: NodePath.join(home, ".gitconfig"),
      GIT_TERMINAL_PROMPT: "0",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    };
    const identity = JSON.parse(
      (
        await execute(
          runtime,
          [
            "--eval",
            "console.log(JSON.stringify({platform:process.platform,arch:process.arch,bunVersion:Bun.version}))",
          ],
          { env: installEnv },
        )
      ).stdout.trim(),
    ) as { platform: string; arch: string; bunVersion: string };
    if (
      identity.platform !== process.platform ||
      identity.arch !== process.arch ||
      !identity.bunVersion
    )
      throw new Error("Bundled Bun does not match the actual build host platform/architecture.");
    await validateBunLicenseNotices(harness, identity.bunVersion);
    await execute(runtime, ["install", "--production", "--frozen-lockfile", "--ignore-scripts"], {
      cwd: harness,
      env: installEnv,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 300_000,
    });
    // Resolve only from this archived tree, with no global Bun/Node or parent dependency fallback.
    for (let parent = NodePath.dirname(input.destination); ; parent = NodePath.dirname(parent)) {
      try {
        await NodeFSP.access(NodePath.join(parent, "node_modules"));
        throw new Error(
          "Dokkabi staging root has ancestor node_modules; isolated import qualification is unsafe.",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (parent === NodePath.dirname(parent)) break;
    }
    const probe = JSON.parse(
      (
        await execute(runtime, ["--eval", NATIVE_PROBE], {
          cwd: harness,
          env: { ...installEnv, PATH: NodePath.dirname(runtime), NODE_PATH: "" },
          maxBuffer: 8 * 1024 * 1024,
          timeout: 60_000,
        })
      ).stdout
        .trim()
        .split("\n")
        .at(-1)!,
    ) as typeof identity;
    if (
      probe.platform !== identity.platform ||
      probe.arch !== identity.arch ||
      probe.bunVersion !== identity.bunVersion
    )
      throw new Error("Dokkabi native import probe runtime identity mismatch.");
    const manifest: DokkabiRuntimeManifest = {
      schema: 1,
      harnessRevision: source.revision,
      bunVersion: identity.bunVersion,
      platform: identity.platform,
      arch: identity.arch,
      entry: "harness/scripts/desktop-child.ts",
      runtime: "bin/bun",
      files: await recordDokkabiRuntimeFiles(input.destination),
    };
    await NodeFSP.writeFile(
      NodePath.join(input.destination, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return manifest;
  } catch (error) {
    await NodeFSP.rm(input.destination, { recursive: true, force: true });
    throw error;
  } finally {
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  }
}
