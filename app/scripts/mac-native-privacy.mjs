import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

/**
 * Runs after native dependency rebuilding and before ASAR hashing/copying.
 * @param {{electronPlatformName: string, packager: {info: {appDir: string}}}} context
 */
export default async function macNativePrivacy(context) {
  if (context.electronPlatformName !== "darwin") return;
  // PackContext.packager is PlatformPackager; its Packager is `info`.
  const appDir = context.packager?.info?.appDir;
  if (typeof appDir !== "string" || !NodePath.isAbsolute(appDir))
    throw new Error("Expected an owned stage.");
  const stage = await NodeFSP.realpath(appDir);
  const insideStage = (file) => {
    const relative = NodePath.relative(stage, file);
    if (
      relative === ".." ||
      relative.startsWith(`..${NodePath.sep}`) ||
      NodePath.isAbsolute(relative)
    ) {
      throw new Error("Native dependency is outside the owned stage.");
    }
  };
  const dependency = await NodeFSP.realpath(NodePath.join(stage, "node_modules/node-pty"));
  insideStage(dependency);
  const pending = [dependency];
  let addons = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const file = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith(".dSYM")) continue;
        pending.push(file);
        continue;
      }
      if (!entry.name.endsWith(".node") && entry.name !== "spawn-helper") continue;
      const source = await NodeFSP.realpath(file);
      insideStage(source);
      const stat = await NodeFSP.lstat(source);
      if (!stat.isFile()) throw new Error("Expected a regular native payload.");
      const bytes = await NodeFSP.readFile(source);
      if (
        !["cefaedfe", "cffaedfe", "feedface", "feedfacf", "cafebabe", "cafebabf"].includes(
          bytes.subarray(0, 4).toString("hex"),
        )
      )
        continue;
      if (entry.name.endsWith(".node")) addons += 1;
      // pnpm may hard-link its cache. Replace only an owned staged copy; strip
      // debugging symbols before ASAR size/integrity metadata is generated.
      const temporary = `${source}.${NodeCrypto.randomUUID()}.privacy`;
      try {
        await NodeFSP.copyFile(source, temporary, NodeFS.constants.COPYFILE_EXCL);
        await NodeFSP.chmod(temporary, stat.mode & 0o777);
        NodeChildProcess.execFileSync("/usr/bin/strip", ["-S", temporary], { stdio: "pipe" });
        // Restore a valid local Mach-O signature after changing its symbol table.
        // Ad-hoc signing uses no developer identity or notarization service.
        NodeChildProcess.execFileSync(
          "/usr/bin/codesign",
          ["--force", "--sign", "-", "--timestamp=none", "--identifier", entry.name, temporary],
          { stdio: "pipe" },
        );
        await NodeFSP.rename(temporary, source);
      } catch (cause) {
        const code = cause?.code ?? cause?.status ?? cause?.name ?? "unknown";
        throw new Error(`Could not prepare native debug privacy: ${entry.name} (${code})`, {
          cause,
        });
      } finally {
        await NodeFSP.rm(temporary, { force: true });
      }
    }
  }
  if (addons === 0) throw new Error("No macOS terminal addon in the owned stage.");
}
