// @effect-diagnostics globalTimers:off nodeBuiltinImport:off
// Native fd3/stdio ownership and payload streaming use Node host APIs and deadlines.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type * as NodeStream from "node:stream";
import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  allocateBundledGatewayRun,
  allocateBundledGatewayLedger,
  captureBundledGatewayRun,
  releaseEmptyBundledGatewayRun,
} from "./BundledGatewayRetention.ts";

const Manifest = Schema.Struct({
  schema: Schema.Literal(1),
  harnessRevision: Schema.String,
  bunVersion: Schema.String,
  platform: Schema.String,
  arch: Schema.String,
  entry: Schema.Literal("harness/scripts/desktop-child.ts"),
  runtime: Schema.Literal("bin/bun"),
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, sha256: Schema.String, size: Schema.Number }),
  ),
});
const Ready = Schema.Struct({
  schema: Schema.Literal(1),
  httpUrl: Schema.String,
  workspace: Schema.String,
  runtime: Schema.Struct({
    bunVersion: Schema.String,
    platform: Schema.String,
    arch: Schema.String,
  }),
  harnessRevision: Schema.optionalKey(Schema.String),
});
const decodeManifest = Schema.decodeUnknownSync(Manifest, { onExcessProperty: "error" });
const decodeReady = Schema.decodeUnknownSync(Ready, { onExcessProperty: "error" });
const READY_LIMIT = 4096;
const BOOTSTRAP_LIMIT = 16 * 1024;
const MANIFEST_LIMIT = 8 * 1024 * 1024;

export interface BundledGatewayInput {
  readonly resourceRoot: string;
  readonly workspace: string;
  /** Stable provider identity; production retains its persisted instance id. */
  readonly ownerKey?: string;
  readonly ledgerRoot?: string;
  readonly readinessTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
  /** Optional isolated allocation root; production uses the persistent harness home. */
  readonly runtimeRoot?: string;
}

export interface BundledGateway {
  readonly gatewayUrl: string;
  readonly tokenEnv: string;
  readonly credentialEnvironment: Readonly<Record<string, string | undefined>>;
  readonly runtimeDirectory: string;
  readonly gatewayLedgerDirectory?: string;
  /** Completes on the owned child exit, without exposing diagnostic text. */
  readonly exited: Promise<void>;
  readonly failure: () => string | undefined;
  readonly stop: () => Promise<void>;
}

const refuse = (message: string): never => {
  throw new Error(message);
};

async function regularFile(root: string, relative: string): Promise<string> {
  if (
    !relative ||
    relative.includes("\\") ||
    relative.includes("\0") ||
    NodePath.posix.isAbsolute(relative) ||
    relative.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    refuse("Bundled runtime contains an unsafe payload path.");
  }
  let current = root;
  for (const [index, part] of relative.split("/").entries()) {
    current = NodePath.join(current, part);
    const stat = await NodeFSP.lstat(current);
    if (
      stat.isSymbolicLink() ||
      (index === relative.split("/").length - 1 ? !stat.isFile() : !stat.isDirectory())
    ) {
      refuse("Bundled runtime payload must contain regular files and directories.");
    }
  }
  return current;
}

async function validatePayload(
  resourceRoot: string,
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
  signal?: AbortSignal,
) {
  if (!NodePath.isAbsolute(resourceRoot))
    refuse("Bundled runtime needs an absolute resource root.");
  if (!(await NodeFSP.lstat(resourceRoot)).isDirectory())
    refuse("Bundled runtime resource root must be a real directory.");
  resourceRoot = await NodeFSP.realpath(resourceRoot);
  const manifestPath = await regularFile(resourceRoot, "manifest.json");
  if ((await NodeFSP.stat(manifestPath)).size > MANIFEST_LIMIT)
    refuse("Bundled runtime manifest is oversized.");
  let manifest: typeof Manifest.Type;
  try {
    manifest = decodeManifest(JSON.parse(await NodeFSP.readFile(manifestPath, "utf8")));
  } catch {
    return refuse("Bundled runtime manifest is invalid.");
  }
  if (manifest.platform !== platform || manifest.arch !== architecture) {
    refuse("Bundled runtime target does not match this host.");
  }
  if (
    !/^[a-f0-9]{40,64}$/.test(manifest.harnessRevision) ||
    !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.bunVersion) ||
    manifest.files.length === 0 ||
    manifest.files.length > 100_000
  ) {
    refuse("Bundled runtime identity is invalid.");
  }
  const checkInterrupted = () => {
    if (signal?.aborted) refuse("Bundled runtime startup was interrupted.");
  };
  checkInterrupted();
  const paths = new Set<string>();
  for (const file of manifest.files) {
    checkInterrupted();
    if (
      paths.has(file.path) ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    ) {
      refuse("Bundled runtime file manifest is invalid.");
    }
    paths.add(file.path);
    const filePath = await regularFile(resourceRoot, file.path);
    if ((await NodeFSP.stat(filePath)).size !== file.size)
      refuse("Bundled runtime payload size does not match its manifest.");
    const digest = NodeCrypto.createHash("sha256");
    for await (const chunk of NodeFS.createReadStream(filePath)) {
      checkInterrupted();
      digest.update(chunk);
    }
    if (digest.digest("hex") !== file.sha256)
      refuse("Bundled runtime payload digest does not match its manifest.");
  }
  const inventory = new Set<string>();
  const inspectDirectory = async (directory: string): Promise<void> => {
    for (const item of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      checkInterrupted();
      const path = NodePath.join(directory, item.name);
      const relative = NodePath.relative(resourceRoot, path).split(NodePath.sep).join("/");
      if (item.isSymbolicLink()) {
        const target = await NodeFSP.realpath(path);
        if (!target.startsWith(resourceRoot + NodePath.sep))
          refuse("Bundled runtime symlink escapes its payload.");
        const stat = await NodeFSP.stat(target);
        if (
          !stat.isDirectory() &&
          (!stat.isFile() ||
            !paths.has(NodePath.relative(resourceRoot, target).split(NodePath.sep).join("/")))
        ) {
          refuse("Bundled runtime symlink points to an unverified file.");
        }
      } else if (item.isDirectory()) await inspectDirectory(path);
      else if (item.isFile()) {
        if (relative !== "manifest.json") inventory.add(relative);
      } else refuse("Bundled runtime contains an unsupported payload file.");
    }
  };
  await inspectDirectory(resourceRoot);
  if (inventory.size !== paths.size || [...inventory].some((path) => !paths.has(path))) {
    refuse("Bundled runtime file inventory does not match its manifest.");
  }
  if (!paths.has(manifest.entry) || !paths.has(manifest.runtime))
    refuse("Bundled runtime executable or entry is missing from its manifest.");
  const runtime = NodePath.join(resourceRoot, manifest.runtime);
  const version = await new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(
      runtime,
      ["--version"],
      {
        timeout: 5000,
        maxBuffer: 1024,
        windowsHide: true,
        signal,
        env: privateChildEnvironment(NodePath.dirname(runtime)),
      },
      (error, stdout) => {
        if (error) reject(new Error("Bundled Bun version verification failed."));
        else resolve(stdout.trim());
      },
    );
  });
  if (version !== manifest.bunVersion) refuse("Bundled Bun version does not match its manifest.");
  return { manifest, runtime, entry: NodePath.join(resourceRoot, manifest.entry) };
}

/** Owns exactly one process. Retained run directories contain harness evidence. */
export async function startBundledGateway(input: BundledGatewayInput): Promise<BundledGateway> {
  if (!NodePath.isAbsolute(input.workspace)) refuse("Bundled runtime needs an absolute workspace.");
  try {
    if (!(await NodeFSP.stat(input.workspace)).isDirectory())
      refuse("Bundled runtime workspace must be a directory.");
  } catch {
    return refuse("Bundled runtime workspace must be an existing directory.");
  }
  const { manifest, runtime, entry } = await validatePayload(
    input.resourceRoot,
    input.platform ?? HostProcessPlatform.defaultValue(),
    input.architecture ?? HostProcessArchitecture.defaultValue(),
    input.signal,
  ).catch((error: unknown) => {
    if (error instanceof Error && error.message.startsWith("Bundled")) throw error;
    return refuse("Bundled runtime payload is unavailable.");
  });
  if (input.signal?.aborted) refuse("Bundled runtime startup was interrupted.");
  const gatewayLedgerDirectory =
    input.ownerKey === undefined
      ? undefined
      : allocateBundledGatewayLedger(
          { ownerKey: input.ownerKey, workspace: input.workspace },
          input.ledgerRoot,
        );
  const runtimeDirectory = allocateBundledGatewayRun(input.runtimeRoot);
  const runtimeReceipt = captureBundledGatewayRun(runtimeDirectory);
  const pairingToken = NodeCrypto.randomBytes(32).toString("base64url");
  const tokenEnv = `DOKKABI_BUNDLED_TOKEN_${NodeCrypto.randomBytes(16).toString("hex")}`;
  const credentialEnvironment: Record<string, string | undefined> = {};
  const bootstrap = JSON.stringify({
    schema: 1,
    workspace: input.workspace,
    runtimeDirectory,
    pairingToken,
    ...(gatewayLedgerDirectory === undefined ? {} : { gatewayLedgerDirectory }),
  });
  if (Buffer.byteLength(bootstrap) > BOOTSTRAP_LIMIT)
    refuse("Bundled runtime bootstrap is oversized.");
  const childEnvironment = privateChildEnvironment(NodePath.dirname(runtime));
  const child = NodeChildProcess.spawn(runtime, [entry], {
    cwd: input.workspace,
    env: childEnvironment,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  let stopping = false;
  let failure: string | undefined;
  let hasExited = false;
  let settleExit!: () => void;
  const exited = new Promise<void>((resolve) => {
    settleExit = resolve;
  });
  const markExit = () => {
    hasExited = true;
    if (!stopping)
      failure =
        "The bundled Dokkabi gateway exited. Reopen the provider to recover retained state.";
    // Keep the private token until scope release so delayed socket errors remain redactable.
    settleExit();
  };
  child.once("exit", markExit);
  child.on("error", () => {
    if (child.pid === undefined) markExit();
    else failure = "The bundled Dokkabi gateway process failed.";
  });
  // Diagnostic channels never supply authority. Retain only a bounded redacted tail.
  let diagnostics = "";
  const drain = (chunk: Buffer) => {
    diagnostics = (diagnostics + chunk.toString("utf8"))
      .split(pairingToken)
      .join("[redacted]")
      .slice(-8192);
  };
  child.stdout?.on("data", drain);
  child.stderr?.on("data", drain);
  for (const stream of child.stdio) stream?.on("error", () => {});
  let stopPromise: Promise<void> | undefined;
  const stop = () =>
    (stopPromise ??= (async () => {
      stopping = true;
      delete credentialEnvironment[tokenEnv];
      const awaitExit = (timeout: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, timeout);
          void exited.then(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      if (!hasExited) child.kill("SIGTERM");
      if (!hasExited) await awaitExit(input.shutdownTimeoutMs ?? 3000);
      if (!hasExited) {
        child.kill("SIGKILL");
        await awaitExit(1000);
        if (!hasExited)
          failure = "The bundled Dokkabi gateway did not exit within the shutdown deadline.";
      }
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      (child.stdio[3] as NodeStream.Readable | null)?.destroy();
      diagnostics = "";
      // A nonempty or replaced run stays retained. Durable owner history is
      // separate and is never removed by transport cleanup.
      if (hasExited) {
        try {
          releaseEmptyBundledGatewayRun(runtimeReceipt);
        } catch {
          failure ??=
            "Bundled gateway transport cleanup could not be verified. Retained data was preserved.";
        }
      }
    })());
  let abortListener: (() => void) | undefined;
  try {
    const ready = await new Promise<typeof Ready.Type>((resolve, reject) => {
      const channel = child.stdio[3] as NodeStream.Readable;
      let buffer = Buffer.alloc(0);
      const fail = () => {
        cleanup();
        reject(new Error("Bundled Dokkabi gateway readiness failed."));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Bundled Dokkabi gateway readiness timed out."));
      }, input.readinessTimeoutMs ?? 15_000);
      const cleanup = () => {
        clearTimeout(timer);
        child.off("exit", fail);
        child.off("error", fail);
      };
      child.once("exit", fail);
      child.once("error", fail);
      child.stdin?.once("error", fail);
      channel.once("error", fail);
      channel.on("data", (chunk: Buffer) => {
        if (buffer.length + chunk.length > READY_LIMIT) {
          cleanup();
          reject(new Error("Bundled Dokkabi gateway readiness is oversized."));
          channel.destroy();
        } else buffer = Buffer.concat([buffer, chunk]);
      });
      channel.once("end", () => {
        cleanup();
        try {
          const decoded = decodeReady(JSON.parse(buffer.toString("utf8")));
          const url = new URL(decoded.httpUrl);
          if (
            decoded.workspace !== input.workspace ||
            decoded.runtime.bunVersion !== manifest.bunVersion ||
            decoded.runtime.platform !== manifest.platform ||
            decoded.runtime.arch !== manifest.arch ||
            (decoded.harnessRevision !== undefined &&
              decoded.harnessRevision !== manifest.harnessRevision) ||
            url.protocol !== "http:" ||
            url.hostname !== "127.0.0.1" ||
            Number(url.port) <= 0 ||
            url.username ||
            url.password ||
            url.pathname !== "/" ||
            url.search ||
            url.hash
          ) {
            fail();
          } else resolve(decoded);
        } catch {
          fail();
        }
      });
      abortListener = () => {
        cleanup();
        reject(new Error("Bundled runtime startup was interrupted."));
      };
      input.signal?.addEventListener("abort", abortListener, { once: true });
      if (input.signal?.aborted) abortListener();
      child.stdin?.end(bootstrap);
      void exited.then(cleanup);
    });
    if (hasExited || input.signal?.aborted)
      refuse("Bundled Dokkabi gateway exited before adoption.");
    credentialEnvironment[tokenEnv] = pairingToken;
    const url = new URL(ready.httpUrl);
    url.protocol = "ws:";
    url.pathname = "/ws";
    return {
      gatewayUrl: url.toString(),
      tokenEnv,
      credentialEnvironment,
      runtimeDirectory,
      ...(gatewayLedgerDirectory === undefined ? {} : { gatewayLedgerDirectory }),
      exited,
      failure: () => failure,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    if (abortListener) input.signal?.removeEventListener("abort", abortListener);
  }
}

function privateChildEnvironment(bundledBin: string) {
  const env = { ...process.env };
  // Keep operator-owned harness/plugin configuration. App control and preload
  // variables belong to the backend and must not change the pinned child runtime.
  const runtimeControls = new Set([
    "NODE_OPTIONS",
    "NODE_PATH",
    "BUN_OPTIONS",
    "BUN_PRELOAD",
    "BUN_ENV_FILE",
    "DOKKABI_BUNDLED_RUNTIME",
  ]);
  for (const key of Object.keys(env)) {
    if (
      /^(?:ELECTRON_|T3_|AGENT_DEVICE_|VITE_|DOKKABI_BUNDLED_TOKEN_)/.test(key) ||
      runtimeControls.has(key)
    ) {
      delete env[key];
    }
  }
  env.PATH = [bundledBin, env.PATH].filter(Boolean).join(NodePath.delimiter);
  return env;
}

export class BundledGatewayError extends Schema.TaggedError<BundledGatewayError>()(
  "BundledGatewayError",
  {
    detail: Schema.String,
  },
) {
  override get message() {
    return this.detail;
  }
}

/** Provider scopes release their own gateway on disable, reconfiguration or shutdown. */
export const acquireBundledGateway = Effect.fnUntraced(function* (input: BundledGatewayInput) {
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  return yield* Effect.acquireRelease(
    Effect.callback<BundledGateway, BundledGatewayError>((resume) => {
      const controller = new AbortController();
      const starting = startBundledGateway({
        ...input,
        platform,
        architecture,
        signal: controller.signal,
      });
      void starting.then(
        (gateway) => resume(Effect.succeed(gateway)),
        (error: unknown) =>
          resume(
            Effect.fail(
              new BundledGatewayError({
                detail: error instanceof Error ? error.message : "Bundled gateway startup failed.",
              }),
            ),
          ),
      );
      return Effect.promise(async () => {
        controller.abort();
        const gateway = await starting.catch(() => undefined);
        await gateway?.stop();
      });
    }).pipe(Effect.interruptible),
    (gateway) => Effect.promise(() => gateway.stop()),
  );
});
