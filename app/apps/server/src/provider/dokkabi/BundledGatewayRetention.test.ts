// @effect-diagnostics nodeBuiltinImport:off
// Tests use isolated native filesystem fixtures and actual owned Bun children.
import { describe, expect, it } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import { startBundledGateway } from "./BundledGateway.ts";
import {
  allocateBundledGatewayRun,
  bundledGatewayRuntimeRoot,
  allocateBundledGatewayLedger,
  captureBundledGatewayRun,
  releaseEmptyBundledGatewayRun,
} from "./BundledGatewayRetention.ts";
import * as NodeFS from "node:fs";

async function fixture() {
  const root = await NodeFSP.realpath(await NodeFSP.mkdtemp("/tmp/bg-retain-"));
  const resourceRoot = NodePath.join(root, "payload");
  const workspace = NodePath.join(root, "workspace");
  const runtimeRoot = NodePath.join(root, "runs");
  await NodeFSP.mkdir(NodePath.join(resourceRoot, "bin"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(resourceRoot, "harness/scripts"), { recursive: true });
  await NodeFSP.mkdir(workspace);
  const bun = NodePath.join(NodeOS.homedir(), ".bun/bin/bun");
  await NodeFSP.copyFile(bun, NodePath.join(resourceRoot, "bin/bun"));
  await NodeFSP.chmod(NodePath.join(resourceRoot, "bin/bun"), 0o700);
  const source = `import { writeFileSync, closeSync, readdirSync } from 'node:fs';
    let raw = ''; for await (const chunk of process.stdin) raw += chunk;
    const input = JSON.parse(raw);
    if (readdirSync(input.runtimeDirectory).length !== 0) throw Error('run directory was not empty');
    writeFileSync(input.workspace + '/spawned', 'yes');
    const ledger = input.gatewayLedgerDirectory ?? input.runtimeDirectory;
    writeFileSync(ledger + '/gateway.jsonl', 'retained evidence\\n', {mode:0o600,flag:'a'});
    const server = Bun.serve({hostname:'127.0.0.1', port:0, fetch(){return new Response('ok')}});
    process.on('SIGTERM', () => {server.stop(true); process.exit(0)});
    writeFileSync(3, JSON.stringify({schema:1,httpUrl:'http://127.0.0.1:'+server.port,workspace:input.workspace,runtime:{bunVersion:Bun.version,platform:process.platform,arch:process.arch}}));
    closeSync(3);`;
  await NodeFSP.writeFile(NodePath.join(resourceRoot, "harness/scripts/desktop-child.ts"), source);
  const files = [];
  for (const path of ["bin/bun", "harness/scripts/desktop-child.ts"]) {
    const data = await NodeFSP.readFile(NodePath.join(resourceRoot, path));
    files.push({
      path,
      size: data.length,
      sha256: NodeCrypto.createHash("sha256").update(data).digest("hex"),
    });
  }
  await NodeFSP.writeFile(
    NodePath.join(resourceRoot, "manifest.json"),
    JSON.stringify({
      schema: 1,
      harnessRevision: "a".repeat(40),
      bunVersion: NodeChildProcess.execFileSync(bun, ["--version"], { encoding: "utf8" }).trim(),
      platform: HostProcessPlatform.defaultValue(),
      arch: HostProcessArchitecture.defaultValue(),
      runtime: "bin/bun",
      entry: "harness/scripts/desktop-child.ts",
      files,
    }),
  );
  return { root, resourceRoot, workspace, runtimeRoot };
}

async function withFixture(body: (input: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const input = await fixture();
  try {
    await body(input);
  } finally {
    await NodeFSP.rm(input.root, { recursive: true, force: true });
  }
}

async function withRoot(body: (root: string) => Promise<void>) {
  const base = await NodeFSP.realpath(await NodeFSP.mkdtemp("/tmp/bg-root-"));
  try {
    await body(NodePath.join(base, "runs"));
  } finally {
    await NodeFSP.rm(base, { recursive: true, force: true });
  }
}

describe("bundled gateway persistent retention", () => {
  it("allocates in its explicit persistent root instead of temporary storage", () =>
    withFixture(async (input) => {
      const gateway = await startBundledGateway(input);
      try {
        expect(NodePath.dirname(gateway.runtimeDirectory)).toBe(input.runtimeRoot);
      } finally {
        await gateway.stop();
        // Baseline's unrelated temporary allocation belongs only to this test.
        if (NodePath.dirname(gateway.runtimeDirectory) !== input.runtimeRoot)
          await NodeFSP.rm(gateway.runtimeDirectory, { recursive: true, force: true });
      }
    }));

  it("refuses a new child when 64 retained runs already exist", () =>
    withFixture(async (input) => {
      await NodeFSP.mkdir(input.runtimeRoot, { mode: 0o700 });
      await NodeFSP.writeFile(
        NodePath.join(input.runtimeRoot, "owner.json"),
        JSON.stringify({ schema: 1, kind: "dokkabi-desktop-gateways", uid: process.getuid?.() }),
        { mode: 0o600 },
      );
      for (let index = 0; index < 64; index += 1)
        await NodeFSP.mkdir(
          NodePath.join(input.runtimeRoot, `run-${index.toString(16).padStart(16, "0")}`),
          { mode: 0o700 },
        );
      let gateway: Awaited<ReturnType<typeof startBundledGateway>> | undefined;
      let refusal: unknown;
      try {
        gateway = await startBundledGateway(input);
      } catch (error) {
        refusal = error;
      } finally {
        await gateway?.stop();
        if (gateway && NodePath.dirname(gateway.runtimeDirectory) !== input.runtimeRoot)
          await NodeFSP.rm(gateway.runtimeDirectory, { recursive: true, force: true });
      }
      expect(refusal instanceof Error ? refusal.message : undefined).toContain("retention limit");
      await expect(NodeFSP.stat(NodePath.join(input.workspace, "spawned"))).rejects.toThrow();
    }));

  it("refuses before child launch at 128 MiB and preserves the existing evidence", () =>
    withFixture(async (input) => {
      const run = allocateBundledGatewayRun(input.runtimeRoot);
      const path = NodePath.join(run, "gateway.jsonl");
      const file = await NodeFSP.open(path, "wx", 0o600);
      try {
        await file.write("retained prefix");
        await file.truncate(128 * 1024 * 1024);
      } finally {
        await file.close();
      }
      await expect(startBundledGateway(input)).rejects.toThrow("retention limit");
      expect((await NodeFSP.stat(path)).size).toBe(128 * 1024 * 1024);
      expect(
        (await NodeFSP.readdir(input.runtimeRoot)).filter((name) => name.startsWith("run-")),
      ).toHaveLength(1);
      await expect(NodeFSP.stat(NodePath.join(input.workspace, "spawned"))).rejects.toThrow();
      expect(await NodeFSP.readdir(input.runtimeRoot)).not.toContain(".allocation");
    }));

  it("preserves stopped runs and private permissions while admitting a later child", () =>
    withFixture(async (input) => {
      const a = await startBundledGateway(input);
      await a.stop();
      const original = await NodeFSP.readFile(NodePath.join(a.runtimeDirectory, "gateway.jsonl"));
      const b = await startBundledGateway(input);
      await b.stop();
      expect(b.runtimeDirectory).not.toBe(a.runtimeDirectory);
      expect(await NodeFSP.readFile(NodePath.join(a.runtimeDirectory, "gateway.jsonl"))).toEqual(
        original,
      );
      expect((await NodeFSP.stat(input.runtimeRoot)).mode & 0o777).toBe(0o700);
      expect((await NodeFSP.stat(a.runtimeDirectory)).mode & 0o777).toBe(0o700);
      expect(
        (await NodeFSP.readdir(input.runtimeRoot)).filter((name) => name.startsWith("run-")),
      ).toHaveLength(2);
    }));

  it("uses only an absolute harness home for the persistent default", () => {
    const original = process.env.DOKKABI_HOME;
    try {
      process.env.DOKKABI_HOME = "/private/isolated-home";
      expect(bundledGatewayRuntimeRoot()).toBe("/private/isolated-home/desktop-gateways");
      process.env.DOKKABI_HOME = "relative";
      expect(bundledGatewayRuntimeRoot()).toBe(
        NodePath.join(NodeOS.homedir(), ".dokkabi/desktop-gateways"),
      );
      expect(() => bundledGatewayRuntimeRoot("relative")).toThrow("cannot be verified");
    } finally {
      if (original === undefined) delete process.env.DOKKABI_HOME;
      else process.env.DOKKABI_HOME = original;
    }
  });

  it("arbitrates the last available run between separate allocation processes", () =>
    withRoot(async (root) => {
      allocateBundledGatewayRun(root);
      for (let index = 0; index < 62; index += 1)
        await NodeFSP.mkdir(NodePath.join(root, `run-${index.toString(16).padStart(16, "0")}`), {
          mode: 0o700,
        });
      const moduleUrl = new URL("./BundledGatewayRetention.ts", import.meta.url).href;
      const contenders = Array.from(
        { length: 4 },
        () =>
          new Promise<{ ok: boolean }>((resolve, reject) => {
            NodeChildProcess.execFile(
              process.execPath,
              [
                "--input-type=module",
                "--eval",
                `
        import { allocateBundledGatewayRun } from ${JSON.stringify(moduleUrl)};
        try { allocateBundledGatewayRun(process.argv[1]); console.log(JSON.stringify({ok:true})); }
        catch { console.log(JSON.stringify({ok:false})); }`,
                root,
              ],
              { timeout: 10_000 },
              (error, output) => {
                if (error) reject(error);
                else resolve(JSON.parse(output));
              },
            );
          }),
      );
      expect((await Promise.all(contenders)).filter((result) => result.ok)).toHaveLength(1);
      expect((await NodeFSP.readdir(root)).filter((name) => name.startsWith("run-"))).toHaveLength(
        64,
      );
      expect(await NodeFSP.readdir(root)).not.toContain(".allocation");
    }));

  it.each([
    "unknown-root",
    "unknown-run",
    "linked-run",
    "linked-file",
    "hardlinked-file",
    "wrong-kind",
    "public-root",
    "corrupt-owner",
    "abandoned-claim",
  ])("refuses %s without deleting any retained data or unknown owner", (kind) =>
    withRoot(async (root) => {
      const run = allocateBundledGatewayRun(root);
      const log = NodePath.join(run, "gateway.jsonl");
      await NodeFSP.writeFile(log, "original retained evidence", { mode: 0o600 });
      if (kind === "unknown-root")
        await NodeFSP.writeFile(NodePath.join(root, "unknown"), "keep", { mode: 0o600 });
      if (kind === "unknown-run")
        await NodeFSP.writeFile(NodePath.join(run, "unknown"), "keep", { mode: 0o600 });
      if (kind === "linked-run")
        await NodeFSP.symlink(run, NodePath.join(root, "run-eeeeeeeeeeeeeeee"));
      if (kind === "linked-file")
        await NodeFSP.symlink(log, NodePath.join(run, "gateway.telemetry.jsonl"));
      if (kind === "hardlinked-file")
        await NodeFSP.link(log, NodePath.join(run, "gateway.telemetry.jsonl"));
      if (kind === "wrong-kind")
        await NodeFSP.mkdir(NodePath.join(run, "gateway.telemetry.jsonl"), { mode: 0o700 });
      if (kind === "public-root") await NodeFSP.chmod(root, 0o755);
      if (kind === "corrupt-owner")
        await NodeFSP.writeFile(NodePath.join(root, "owner.json"), "not JSON");
      if (kind === "abandoned-claim") {
        await NodeFSP.mkdir(NodePath.join(root, ".allocation"), { mode: 0o700 });
        await NodeFSP.writeFile(NodePath.join(root, ".allocation/owner.json"), "unknown owner", {
          mode: 0o600,
        });
      }
      const before = await NodeFSP.readdir(root);
      expect(() => allocateBundledGatewayRun(root)).toThrow(
        /cannot be verified|allocation is busy/,
      );
      expect(await NodeFSP.readFile(log, "utf8")).toBe("original retained evidence");
      expect(await NodeFSP.readdir(root)).toEqual(before);
      if (kind === "abandoned-claim")
        expect(await NodeFSP.readFile(NodePath.join(root, ".allocation/owner.json"), "utf8")).toBe(
          "unknown owner",
        );
    }),
  );

  it("accepts only known private EventLog sidecars and counts them in the byte budget", () =>
    withRoot(async (root) => {
      const run = allocateBundledGatewayRun(root);
      await NodeFSP.writeFile(NodePath.join(run, "gateway.jsonl"), "record", { mode: 0o600 });
      await NodeFSP.writeFile(NodePath.join(run, "gateway.telemetry.jsonl"), "telemetry", {
        mode: 0o600,
      });
      await NodeFSP.writeFile(NodePath.join(run, ".desktop-child-owner"), "", { mode: 0o600 });
      await NodeFSP.mkdir(NodePath.join(run, "gateway.jsonl.lock"), { mode: 0o700 });
      await NodeFSP.writeFile(NodePath.join(run, "gateway.jsonl.lock/owner.json"), "owner", {
        mode: 0o600,
      });
      expect(NodePath.dirname(allocateBundledGatewayRun(root))).toBe(root);
      const fd = NodeFS.openSync(NodePath.join(run, "gateway.telemetry.jsonl"), "r+");
      try {
        NodeFS.ftruncateSync(fd, 128 * 1024 * 1024);
      } finally {
        NodeFS.closeSync(fd);
      }
      expect(() => allocateBundledGatewayRun(root)).toThrow("retention limit");
    }));

  it("rejects oversized Unix socket paths before creating an allocation root", () =>
    withRoot(async (root) => {
      const longRoot = NodePath.join(root, "x".repeat(100));
      expect(() => allocateBundledGatewayRun(longRoot)).toThrow("socket limit");
      await expect(NodeFSP.stat(root)).rejects.toThrow();
    }));

  it("refuses an existing root alias and an unmarked private directory", () =>
    withRoot(async (root) => {
      await NodeFSP.mkdir(root, { mode: 0o700 });
      expect(() => allocateBundledGatewayRun(root)).toThrow("cannot be verified");
      const alias = root + "-alias";
      await NodeFSP.symlink(root, alias);
      expect(() => allocateBundledGatewayRun(alias)).toThrow("cannot be verified");
      expect(await NodeFSP.readdir(root)).toEqual([]);
    }));
});

describe("bundled gateway stable owner ledgers", () => {
  it("reuses one workspace/owner ledger without rewriting any history", () =>
    withRoot(async (root) => {
      const workspace = NodePath.dirname(root);
      const input = { workspace, ownerKey: "provider-instance-one" };
      const directory = allocateBundledGatewayLedger(input, root);
      expect(await NodeFSP.readdir(directory)).toEqual([]);
      const log = NodePath.join(directory, "gateway.jsonl");
      await NodeFSP.writeFile(log, "original accepted command and hash chain", { mode: 0o600 });
      await NodeFSP.writeFile(NodePath.join(directory, "run.lock"), "old dead owner metadata", {
        mode: 0o600,
      });
      const rootOwner = await NodeFSP.readFile(NodePath.join(root, "owner.json"));
      const before = await NodeFSP.readFile(log);
      expect(allocateBundledGatewayLedger(input, root)).toBe(directory);
      expect(await NodeFSP.readFile(log)).toEqual(before);
      expect(await NodeFSP.readFile(NodePath.join(root, "owner.json"))).toEqual(rootOwner);
      expect(NodePath.basename(directory)).toBe(
        NodeCrypto.createHash("sha256")
          .update(workspace + "\0" + input.ownerKey)
          .digest("hex"),
      );
      expect((await NodeFSP.stat(directory)).mode & 0o777).toBe(0o700);
    }));

  it("binds canonical workspace identity and separates different provider owners", () =>
    withRoot(async (root) => {
      const workspace = NodePath.dirname(root);
      const alias = NodePath.join(workspace, "workspace-alias");
      await NodeFSP.symlink(workspace, alias);
      const original = allocateBundledGatewayLedger({ workspace, ownerKey: "one" }, root);
      expect(allocateBundledGatewayLedger({ workspace: alias, ownerKey: "one" }, root)).toBe(
        original,
      );
      expect(allocateBundledGatewayLedger({ workspace, ownerKey: "two" }, root)).not.toBe(original);
      expect(() => allocateBundledGatewayLedger({ workspace, ownerKey: "" }, root)).toThrow(
        "cannot be verified",
      );
      expect(() =>
        allocateBundledGatewayLedger({ workspace: "relative", ownerKey: "one" }, root),
      ).toThrow("cannot be verified");
    }));

  it("refuses a 65th new owner while preserving access to an existing owner", () =>
    withRoot(async (root) => {
      const input = { workspace: NodePath.dirname(root), ownerKey: "existing" };
      const existing = allocateBundledGatewayLedger(input, root);
      for (let index = 0; index < 63; index += 1)
        await NodeFSP.mkdir(NodePath.join(root, index.toString(16).padStart(64, "0")), {
          mode: 0o700,
        });
      expect(() => allocateBundledGatewayLedger({ ...input, ownerKey: "new" }, root)).toThrow(
        "retention limit",
      );
      expect(allocateBundledGatewayLedger(input, root)).toBe(existing);
      expect(
        (await NodeFSP.readdir(root)).filter((name) => /^[a-f0-9]{64}$/.test(name)),
      ).toHaveLength(64);
    }));

  it("refuses a new ledger at 128 MiB without retiring the existing owner", () =>
    withRoot(async (root) => {
      const input = { workspace: NodePath.dirname(root), ownerKey: "existing" };
      const existing = allocateBundledGatewayLedger(input, root);
      const log = NodePath.join(existing, "gateway.jsonl");
      const fd = NodeFS.openSync(log, "wx", 0o600);
      try {
        NodeFS.ftruncateSync(fd, 128 * 1024 * 1024);
      } finally {
        NodeFS.closeSync(fd);
      }
      expect(() => allocateBundledGatewayLedger({ ...input, ownerKey: "new" }, root)).toThrow(
        "retention limit",
      );
      expect(allocateBundledGatewayLedger(input, root)).toBe(existing);
      expect((await NodeFSP.stat(log)).size).toBe(128 * 1024 * 1024);
    }));

  it.each([
    "unknown",
    "socket-name",
    "alias",
    "public-lock",
    "incomplete-lock",
    "foreign-root-kind",
  ])("refuses unsafe ledger inventory: %s", (kind) =>
    withRoot(async (root) => {
      const input = { workspace: NodePath.dirname(root), ownerKey: "existing" };
      const directory = allocateBundledGatewayLedger(input, root);
      const log = NodePath.join(directory, "gateway.jsonl");
      await NodeFSP.writeFile(log, "preserve this accepted record", { mode: 0o600 });
      if (kind === "unknown")
        await NodeFSP.writeFile(NodePath.join(directory, "unexpected"), "keep", { mode: 0o600 });
      if (kind === "socket-name")
        await NodeFSP.writeFile(NodePath.join(directory, "gateway.sock"), "keep", { mode: 0o600 });
      if (kind === "alias") await NodeFSP.symlink(log, NodePath.join(directory, "run.lock"));
      if (kind === "public-lock")
        await NodeFSP.writeFile(NodePath.join(directory, "run.lock"), "lock", { mode: 0o644 });
      if (kind === "incomplete-lock")
        await NodeFSP.mkdir(NodePath.join(directory, "gateway.jsonl.lock"), { mode: 0o700 });
      if (kind === "foreign-root-kind")
        await NodeFSP.writeFile(
          NodePath.join(root, "owner.json"),
          JSON.stringify({ schema: 1, kind: "dokkabi-desktop-gateways", uid: process.getuid?.() }),
        );
      expect(() => allocateBundledGatewayLedger(input, root)).toThrow("cannot be verified");
      expect(await NodeFSP.readFile(log, "utf8")).toBe("preserve this accepted record");
      expect(await NodeFSP.readdir(root)).not.toContain(".allocation");
    }),
  );

  it("passes a real child the stable ledger and releases only empty process directories", () =>
    withFixture(async (input) => {
      const ownedInput = {
        ...input,
        ownerKey: "stable-provider",
        ledgerRoot: NodePath.join(input.root, "ledgers"),
      };
      const a = await startBundledGateway(ownedInput);
      const ledger = a.gatewayLedgerDirectory!;
      const bytes = await NodeFSP.readFile(NodePath.join(ledger, "gateway.jsonl"));
      await a.stop();
      await expect(NodeFSP.stat(a.runtimeDirectory)).rejects.toThrow();
      const b = await startBundledGateway(ownedInput);
      try {
        expect(b.gatewayLedgerDirectory).toBe(ledger);
        expect(
          (await NodeFSP.readFile(NodePath.join(ledger, "gateway.jsonl"))).subarray(
            0,
            bytes.length,
          ),
        ).toEqual(bytes);
        expect(b.runtimeDirectory).not.toBe(a.runtimeDirectory);
      } finally {
        await b.stop();
      }
      await expect(NodeFSP.stat(b.runtimeDirectory)).rejects.toThrow();
      expect(
        (await NodeFSP.readdir(input.runtimeRoot)).filter((name) => name.startsWith("run-")),
      ).toEqual([]);
    }));
});

describe("confirmed-exit empty runtime release", () => {
  it("removes only issued empty runs and allows more than 64 clean lifetimes", () =>
    withRoot(async (root) => {
      for (let index = 0; index < 66; index += 1) {
        const run = allocateBundledGatewayRun(root);
        const receipt = captureBundledGatewayRun(run);
        expect(releaseEmptyBundledGatewayRun(receipt)).toBe(true);
        await expect(NodeFSP.stat(run)).rejects.toThrow();
      }
      expect(await NodeFSP.readdir(root)).toEqual(["owner.json"]);
    }));

  it("keeps nonempty evidence and refuses forged cleanup receipts", () =>
    withRoot(async (root) => {
      const run = allocateBundledGatewayRun(root);
      const receipt = captureBundledGatewayRun(run);
      await NodeFSP.writeFile(NodePath.join(run, "gateway.jsonl"), "retained evidence", {
        mode: 0o600,
      });
      expect(releaseEmptyBundledGatewayRun(receipt)).toBe(false);
      expect(() => releaseEmptyBundledGatewayRun({ directory: run })).toThrow("cannot be verified");
      expect(await NodeFSP.readFile(NodePath.join(run, "gateway.jsonl"), "utf8")).toBe(
        "retained evidence",
      );
    }));

  it("preserves a replacement inode at the allocated path", () =>
    withRoot(async (root) => {
      const run = allocateBundledGatewayRun(root);
      const receipt = captureBundledGatewayRun(run);
      await NodeFSP.rename(run, run + "-retained");
      await NodeFSP.mkdir(run, { mode: 0o700 });
      expect(releaseEmptyBundledGatewayRun(receipt)).toBe(false);
      expect((await NodeFSP.stat(run)).isDirectory()).toBe(true);
      expect((await NodeFSP.stat(run + "-retained")).isDirectory()).toBe(true);
    }));

  it("refuses unsafe cleanup ownership without deleting the directory", () =>
    withRoot(async (root) => {
      const run = allocateBundledGatewayRun(root);
      const receipt = captureBundledGatewayRun(run);
      await NodeFSP.chmod(run, 0o755);
      expect(() => releaseEmptyBundledGatewayRun(receipt)).toThrow("cannot be verified");
      expect((await NodeFSP.stat(run)).isDirectory()).toBe(true);
    }));
});
