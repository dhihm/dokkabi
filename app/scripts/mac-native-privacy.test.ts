// @effect-diagnostics nodeBuiltinImport:off - Native privacy qualification requires actual host tools and files.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";
import macNativePrivacy from "./mac-native-privacy.mjs";

// This native integration case must use the real host clang/codesign, not an injected platform.
// eslint-disable-next-line t3code/no-global-process-runtime
describe.runIf(process.platform === "darwin")("macOS native debug privacy", () => {
  it("removes linker object paths while preserving exports, execution and the dependency cache", async ({
    onTestFinished,
  }) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "dokkabi-native-privacy-"));
    onTestFinished(() => NodeFSP.rm(root, { recursive: true, force: true }));
    const appDir = NodePath.join(root, "stage");
    const target = NodePath.join(appDir, "node_modules/node-pty/build/Release");
    await NodeFSP.mkdir(target, { recursive: true });
    const source = NodePath.join(root, "native.c");
    await NodeFSP.writeFile(
      source,
      "int native_export(void){return 42;} int main(void){return 0;}\n",
    );
    const cache = NodePath.join(root, "cache.node");
    NodeChildProcess.execFileSync("clang", ["-g", "-bundle", source, "-o", cache]);
    const original = await NodeFSP.readFile(cache);
    expect(original.includes(Buffer.from(root))).toBe(true);
    await NodeFSP.link(cache, NodePath.join(target, "pty.node"));
    NodeChildProcess.execFileSync("clang", [
      "-g",
      source,
      "-o",
      NodePath.join(target, "spawn-helper"),
    ]);
    const scriptDirectory = NodePath.join(appDir, "scripts");
    await NodeFSP.mkdir(scriptDirectory);
    const hookPath = NodePath.join(scriptDirectory, "mac-native-privacy.mjs");
    await NodeFSP.copyFile(
      NodeURL.fileURLToPath(new URL("./mac-native-privacy.mjs", import.meta.url)),
      hookPath,
    );
    // Use the installed builder's real resolver from outside projectDir. A
    // project-relative hook string resolves against the filtered process cwd.
    const desktopRequire = NodeModule.createRequire(
      new URL("../apps/desktop/package.json", import.meta.url),
    );
    const builderRequire = NodeModule.createRequire(desktopRequire.resolve("electron-builder"));
    const resolver = await import(builderRequire.resolve("app-builder-lib/out/util/resolve.js"));
    const resolvedHook = await resolver.resolveFunction("module", hookPath, "afterExtract", root);
    await resolvedHook({ electronPlatformName: "darwin", packager: { info: { appDir } } });
    const addon = await NodeFSP.readFile(NodePath.join(target, "pty.node"));
    expect(addon.includes(Buffer.from(root))).toBe(false);
    expect(
      (await NodeFSP.readFile(NodePath.join(target, "spawn-helper"))).includes(Buffer.from(root)),
    ).toBe(false);
    expect(
      NodeCrypto.createHash("sha256")
        .update(await NodeFSP.readFile(cache))
        .digest("hex"),
    ).toBe(NodeCrypto.createHash("sha256").update(original).digest("hex"));
    expect(
      NodeChildProcess.execFileSync("nm", ["-gU", NodePath.join(target, "pty.node")], {
        encoding: "utf8",
      }),
    ).toContain("_native_export");
    NodeChildProcess.execFileSync("codesign", [
      "--verify",
      "--strict",
      NodePath.join(target, "pty.node"),
    ]);
    NodeChildProcess.execFileSync(NodePath.join(target, "spawn-helper"));
    await macNativePrivacy({ electronPlatformName: "darwin", packager: { info: { appDir } } });
  });

  it("refuses a dependency directory outside the owned stage", async ({ onTestFinished }) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "dokkabi-native-privacy-"));
    onTestFinished(() => NodeFSP.rm(root, { recursive: true, force: true }));
    const appDir = NodePath.join(root, "stage");
    await NodeFSP.mkdir(NodePath.join(appDir, "node_modules"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(root, "cache"));
    await NodeFSP.symlink(
      NodePath.join(root, "cache"),
      NodePath.join(appDir, "node_modules/node-pty"),
    );
    await expect(
      macNativePrivacy({ electronPlatformName: "darwin", packager: { info: { appDir } } }),
    ).rejects.toThrow("owned stage");
  });

  it("does not inspect native dependencies for other platforms", async () => {
    await expect(
      macNativePrivacy({
        electronPlatformName: "win32",
        packager: { info: { appDir: "/missing" } },
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses malformed macOS contexts before inspecting any payload", async () => {
    await expect(
      Reflect.apply(macNativePrivacy, undefined, [
        {
          electronPlatformName: "darwin",
          packager: { info: { appDir: undefined } },
        },
      ]),
    ).rejects.toThrow("owned stage");
  });
});
