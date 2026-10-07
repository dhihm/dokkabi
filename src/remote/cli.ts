import { resolve } from "node:path";
import { bootSession, defaultManifestPath } from "../boot.ts";
import { dokkabiHome } from "../host/paths.ts";
import { recordRun } from "../host/run-registry.ts";
import type { RemoteHost } from "./types.ts";
import { RemoteConfigurationError } from "./types.ts";

export interface RemoteCommandArguments {
  readonly check: boolean;
  readonly sessionId: string;
  readonly workspaceRoot: string;
}

export function parseRemoteCommandArgs(
  args: readonly string[],
  cwd = process.cwd(),
): RemoteCommandArguments {
  let check = false;
  let sessionId = "remote";
  let workspaceRoot = cwd;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--session") {
      const value = args[++index];
      if (!value) throw new Error("--session requires an id");
      sessionId = value;
      continue;
    }
    if (arg === "--workspace") {
      const value = args[++index];
      if (!value) throw new Error("--workspace requires a directory");
      workspaceRoot = value;
      continue;
    }
    throw new Error(`unknown remote flag ${arg ?? "(missing)"}`);
  }
  return { check, sessionId, workspaceRoot: resolve(workspaceRoot) };
}

export async function runRemoteCommand(args: readonly string[], repoRoot: string): Promise<number> {
  const parsed = parseRemoteCommandArgs(args);
  recordRun({ home: dokkabiHome(), session: parsed.sessionId, label: "remote" });
  const { ctx, runtime } = await bootSession({
    sessionId: parsed.sessionId,
    workspaceRoot: parsed.workspaceRoot,
    manifestPath: defaultManifestPath(repoRoot),
    repoRoot,
  });
  try {
    const remote = ctx.get<RemoteHost>("remote");
    const adapterId = remote.adapterId();
    process.stdout.write(`remote=${adapterId ?? "unconfigured"}\n`);
    process.stdout.write(`session=${parsed.sessionId}\n`);
    if (parsed.check) return adapterId ? 0 : 1;
    if (!adapterId) throw new RemoteConfigurationError("no remote adapter is configured");

    const stopped = Promise.withResolvers<void>();
    const stop = () => stopped.resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await remote.start();
      await stopped.promise;
      return 0;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  } finally {
    await runtime.dispose();
  }
}
