// oxlint-disable t3code/no-global-process-runtime -- Native runtime qualification must match the actual build process.
// @effect-diagnostics nodeBuiltinImport:off - Tests own temporary Git repositories and payload files.
import * as NodeChildProcess from "node:child_process";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { assert, it } from "@effect/vitest";
import {
  inspectDokkabiRuntimeSource,
  isDokkabiRuntimeSourcePath,
  recordDokkabiRuntimeFiles,
  resolveDokkabiRuntimeSource,
  stageDokkabiRuntime,
  validateBunLicenseNotices,
} from "./stage-dokkabi-runtime.ts";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
async function withSourceFixture(run: (root: string) => Promise<void>) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "dokkabi-packaging-test-"));
  try {
    for (const [file, contents] of Object.entries({
      LICENSE: "MIT License\nCopyright (c) 2026 Dokkabi fixture",
      "package.json": '{"name":"dokkabi","type":"module"}',
      "bun.lock": '{"lockfileVersion":1,"workspaces":{"":{"name":"dokkabi"}},"packages":{}}',
      "src/dash/desktop-server.ts": "export {};",
      "plugins/manifest.json": '{"plugins":[{"path":"../src/dash/desktop-server.ts"}]}',
      "prompts/system.md": "Dokkabi fixture",
      "scripts/desktop-child.ts": "export {};",
      "profiles/operator.json": '{"secret":"fixture-only"}',
      "plugins/auth.json": '{"secret":"fixture-only"}',
      ".env": "FIXTURE_SECRET=excluded",
    })) {
      await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(root, file), contents);
    }
    await NodeFSP.mkdir(NodePath.join(root, "resources/licenses/bun"), { recursive: true });
    await NodeFSP.cp(
      new URL("../licenses/bun/1.4.2", import.meta.url),
      NodePath.join(root, "resources/licenses/bun/1.4.2"),
      { recursive: true },
    );
    await execute("git", ["init", root]);
    await execute("git", ["-C", root, "add", "."]);
    await execute("git", [
      "-C",
      root,
      "-c",
      "user.name=Packaging Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Packaging fixture",
    ]);
    await run(root);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

it("keeps existing external packaging when harness opt-in is absent", () => {
  assert.isUndefined(
    resolveDokkabiRuntimeSource(
      { DOKKABI_DESKTOP_BUN: "/runtime/bun" },
      { platform: "mac", arch: "arm64" },
    ),
  );
});

it("requires absolute source and executable paths and rejects cross targets", () => {
  const host = { platform: "darwin", arch: "arm64" };
  assert.throws(
    () =>
      resolveDokkabiRuntimeSource(
        { DOKKABI_DESKTOP_HARNESS_SOURCE: "repo", DOKKABI_DESKTOP_BUN: "/bin/bun" },
        { platform: "mac", arch: "arm64" },
        host,
      ),
    /absolute/,
  );
  assert.throws(
    () =>
      resolveDokkabiRuntimeSource(
        { DOKKABI_DESKTOP_HARNESS_SOURCE: "/repo" },
        { platform: "mac", arch: "arm64" },
        host,
      ),
    /absolute/,
  );
  for (const target of [
    { platform: "mac" as const, arch: "universal" },
    { platform: "mac" as const, arch: "x64" },
    { platform: "linux" as const, arch: "arm64" },
  ]) {
    assert.throws(
      () =>
        resolveDokkabiRuntimeSource(
          { DOKKABI_DESKTOP_HARNESS_SOURCE: "/repo", DOKKABI_DESKTOP_BUN: "/bin/bun" },
          target,
          host,
        ),
      /actual build host/,
    );
  }
});

it("selects only committed runtime source/resource paths and excludes operator files", async () => {
  await withSourceFixture(async (root) => {
    await NodeFSP.writeFile(
      NodePath.join(root, "src/untracked.ts"),
      "throw Error('must not ship');",
    );
    const source = await inspectDokkabiRuntimeSource(root);
    assert.match(source.revision, /^[a-f0-9]{40}$/);
    assert.include(source.files, "scripts/desktop-child.ts");
    assert.include(source.files, "LICENSE");
    assert.notInclude(source.files, "src/untracked.ts");
    assert.notInclude(source.files, "profiles/operator.json");
    assert.notInclude(source.files, "plugins/auth.json");
    assert.notInclude(source.files, ".env");
    assert.isTrue(isDokkabiRuntimeSourcePath("src/dash/pty-run.py"));
    assert.isFalse(isDokkabiRuntimeSourcePath("src/profiles/operator.json"));
    await NodeFSP.writeFile(NodePath.join(root, "src/dash/desktop-server.ts"), "uncommitted");
    await NodeAssert.rejects(inspectDokkabiRuntimeSource(root), /uncommitted tracked changes/);
  });
});

it("retains the missing committed launcher RED even when an untracked launcher exists", async () => {
  await withSourceFixture(async (root) => {
    await execute("git", ["-C", root, "rm", "scripts/desktop-child.ts"]);
    await execute("git", [
      "-C",
      root,
      "-c",
      "user.name=Packaging Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Missing launcher fixture",
    ]);
    await NodeFSP.mkdir(NodePath.join(root, "scripts"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, "scripts/desktop-child.ts"), "export {};");
    await NodeAssert.rejects(
      stageDokkabiRuntime({
        source: root,
        bun: "/missing/bun",
        destination: NodePath.join(root, "payload"),
      }),
      /missing required payload scripts\/desktop-child.ts/,
    );
  });
});

it("records regular payload hashes and rejects escaping dependency links", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "dokkabi-payload-test-"));
  try {
    await NodeFSP.writeFile(NodePath.join(root, "native.node"), "native fixture");
    await NodeFSP.writeFile(NodePath.join(root, "manifest.json"), "not part of its own digest");
    assert.deepEqual(await recordDokkabiRuntimeFiles(root), [
      {
        path: "native.node",
        sha256: "9fe66fa32138b1127125fa555a99d63d5b2f84c3d049c5c3618ab9fcaa43161a",
        size: 14,
      },
    ]);
    await NodeFSP.symlink(NodePath.join(root, "native.node"), NodePath.join(root, "internal"));
    assert.equal((await recordDokkabiRuntimeFiles(root)).length, 1);
    await NodeFSP.symlink(NodeOS.tmpdir(), NodePath.join(root, "escaping"));
    await NodeAssert.rejects(recordDokkabiRuntimeFiles(root), /symlink escapes/);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("refuses Git archive attributes that remove committed payload files", async () => {
  await withSourceFixture(async (source) => {
    await NodeFSP.writeFile(
      NodePath.join(source, ".gitattributes"),
      "src/dash/desktop-server.ts export-ignore\n",
    );
    await execute("git", ["-C", source, "add", ".gitattributes"]);
    await execute("git", [
      "-C",
      source,
      "-c",
      "user.name=Packaging Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Archive exclusion fixture",
    ]);
    const stageRoot = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "dokkabi-archive-refusal-"),
    );
    const destination = NodePath.join(stageRoot, "runtime");
    try {
      await NodeAssert.rejects(
        stageDokkabiRuntime({ source, bun: process.execPath, destination }),
        /Git archive does not match/,
      );
      await NodeAssert.rejects(NodeFSP.access(destination), { code: "ENOENT" });
      assert.deepEqual(await NodeFSP.readdir(stageRoot), []);
    } finally {
      await NodeFSP.rm(stageRoot, { recursive: true, force: true });
    }
  });
});

// Explicit local qualification: the regular unit suite performs no network install.
it.skipIf(!process.env.DOKKABI_PACKAGING_TEST_BUN)(
  "stages a real host Bun and DuckDB from a frozen fixture outside its checkout",
  async () => {
    const bun = process.env.DOKKABI_PACKAGING_TEST_BUN!;
    await withSourceFixture(async (source) => {
      await NodeFSP.writeFile(
        NodePath.join(source, "package.json"),
        JSON.stringify({
          name: "dokkabi",
          type: "module",
          dependencies: { "@duckdb/node-api": "1.5.5-r.4" },
        }),
      );
      await NodeFSP.rm(NodePath.join(source, "bun.lock"));
      const home = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "dokkabi-fixture-install-"),
      );
      const stageRoot = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "dokkabi-native-stage-"),
      );
      try {
        await execute(bun, ["install", "--lockfile-only", "--ignore-scripts"], {
          cwd: source,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            BUN_INSTALL_CACHE_DIR: NodePath.join(home, "cache"),
          },
          timeout: 60_000,
        });
        await execute("git", ["-C", source, "add", "package.json", "bun.lock"]);
        await execute("git", [
          "-C",
          source,
          "-c",
          "user.name=Packaging Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          "Native dependency fixture",
        ]);
        // Neither tracked nor untracked checkout dependencies are copied.
        await NodeFSP.mkdir(NodePath.join(source, "node_modules/operator-auth"), {
          recursive: true,
        });
        await NodeFSP.writeFile(
          NodePath.join(source, "node_modules/operator-auth/auth.json"),
          '{"secret":"fixture-only"}',
        );
        const destination = NodePath.join(stageRoot, "dokkabi-runtime");
        const manifest = await stageDokkabiRuntime({ source, bun, destination });
        assert.equal(manifest.platform, process.platform);
        assert.equal(manifest.arch, process.arch);
        assert.include(
          manifest.files.map((file) => file.path),
          "bin/bun",
        );
        assert.isTrue(
          manifest.files.some(
            (file) => file.path.includes("duckdb") && file.path.endsWith(".node"),
          ),
        );
        assert.isFalse(
          manifest.files.some(
            (file) => file.path.includes("operator-auth") || file.path.endsWith("auth.json"),
          ),
        );
        assert.deepEqual(manifest.files, await recordDokkabiRuntimeFiles(destination));
        assert.equal(
          await NodeFSP.readFile(
            NodePath.join(destination, "harness/scripts/desktop-child.ts"),
            "utf8",
          ),
          "export {};",
        );
      } finally {
        await NodeFSP.rm(home, { recursive: true, force: true });
        await NodeFSP.rm(stageRoot, { recursive: true, force: true });
      }
    });
  },
  120_000,
);

it("refuses unknown Bun license versions and altered or incomplete notices", async () => {
  await withSourceFixture(async (root) => {
    await validateBunLicenseNotices(root, "1.4.2");
    await NodeAssert.rejects(validateBunLicenseNotices(root, "99.0.0"), /missing license/);
    const notice = NodePath.join(root, "resources/licenses/bun/1.4.2/LGPL-2.1.txt");
    await NodeFSP.appendFile(notice, "altered");
    await NodeAssert.rejects(validateBunLicenseNotices(root, "1.4.2"), /Altered/);
    await NodeFSP.rm(notice);
    await NodeAssert.rejects(validateBunLicenseNotices(root, "1.4.2"), /missing license/);
  });
});
