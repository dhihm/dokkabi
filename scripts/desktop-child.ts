/** Private host bridge for the installed desktop runtime; no model/work loop. */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { DokkabiDesktopServer } from "../src/dash/desktop-server.ts";
import { dokkabiHome } from "../src/host/paths.ts";

const BOOTSTRAP_LIMIT = 16 * 1024;
const READY_LIMIT = 4 * 1024;

interface Bootstrap {
  schema: 1;
  workspace: string;
  runtimeDirectory: string;
  pairingToken: string;
  gatewayLedgerDirectory?: string;
}

function runtimeIdentity() {
  return { bunVersion: Bun.version, platform: process.platform, arch: process.arch };
}

/** EOF terminates exactly one bootstrap. Refuse excess bytes before EOF. */
function readBootstrap(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let ended = false;
    const fail = () => {
      cleanup();
      process.stdin.destroy();
      reject(new Error("bootstrap refused"));
    };
    const data = (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > BOOTSTRAP_LIMIT) { fail(); return; }
      chunks.push(chunk);
    };
    const end = () => {
      ended = true;
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"))); } catch { reject(new Error("bootstrap refused")); }
    };
    const close = () => { if (!ended) fail(); };
    const cleanup = () => {
      process.stdin.off("data", data);
      process.stdin.off("end", end);
      process.stdin.off("error", fail);
      process.stdin.off("close", close);
    };
    process.stdin.on("data", data);
    process.stdin.on("end", end);
    process.stdin.on("error", fail);
    process.stdin.on("close", close);
  });
}

function validateBootstrap(input: unknown): Bootstrap {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("bootstrap refused");
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value);
  if ((keys.length !== 4 && keys.length !== 5) ||
      !keys.every((key) => ["pairingToken", "runtimeDirectory", "schema", "workspace", "gatewayLedgerDirectory"].includes(key)) || value.schema !== 1) {
    throw new Error("bootstrap refused");
  }
  if (typeof value.workspace !== "string" || !isAbsolute(value.workspace) || value.workspace.includes("\0") ||
      typeof value.runtimeDirectory !== "string" || !isAbsolute(value.runtimeDirectory) || value.runtimeDirectory.includes("\0") ||
      (value.gatewayLedgerDirectory !== undefined && (typeof value.gatewayLedgerDirectory !== "string" || !isAbsolute(value.gatewayLedgerDirectory) || value.gatewayLedgerDirectory.includes("\0"))) ||
      typeof value.pairingToken !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(value.pairingToken)) {
    throw new Error("bootstrap refused");
  }
  if (!statSync(value.workspace).isDirectory()) throw new Error("bootstrap refused");
  // lstat("link/") follows the link despite being lstat. Normalize terminal
  // separators and dot components before admitting the runtime directory.
  const runtimeDirectory = resolve(value.runtimeDirectory);
  // Unix socket address limits differ by platform; this common ceiling leaves
  // space for the terminator on both macOS and Linux. Refuse before server.start
  // can degrade a failed Unix bind into an HTTP-only "ready" result.
  if (Buffer.byteLength(join(runtimeDirectory, "gateway.sock")) > 100) throw new Error("bootstrap refused");
  const ready = JSON.stringify({ schema: 1, httpUrl: "http://127.0.0.1:65535", workspace: value.workspace, runtime: runtimeIdentity() }) + "\n";
  if (Buffer.byteLength(ready) > READY_LIMIT) throw new Error("bootstrap refused");
  return {
    schema: 1, workspace: value.workspace, runtimeDirectory, pairingToken: value.pairingToken,
    ...(typeof value.gatewayLedgerDirectory === "string" ? { gatewayLedgerDirectory: value.gatewayLedgerDirectory } : {}),
  };
}

function ownedPrivateDirectory(path: string): void {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.uid !== process.getuid?.() || (stats.mode & 0o077) !== 0) throw new Error("runtime refused");
}

/** A fresh private directory prevents server.start from unlinking another
 * owner's socket or reopening another owner's audit log. Never delete it. */
function prepareRuntime(path: string): () => void {
  try {
    ownedPrivateDirectory(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    ownedPrivateDirectory(dirname(path));
    mkdirSync(path, { mode: 0o700 });
    ownedPrivateDirectory(path);
  }
  if (readdirSync(path).length !== 0) throw new Error("runtime refused");
  // Competing starts can both see an empty directory. Claim it atomically
  // before constructing a server, whose start() unlinks an existing socket.
  const claim = join(path, ".desktop-child-owner");
  const fd = openSync(claim, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  closeSync(fd);
  const owned = lstatSync(claim);
  return () => {
    const current = lstatSync(claim);
    if (current.dev !== owned.dev || current.ino !== owned.ino || !current.isFile()) throw new Error("runtime refused");
    unlinkSync(claim);
  };
}

function readyRecord(httpUrl: string, workspace: string): void {
  const bytes = Buffer.from(JSON.stringify({ schema: 1, httpUrl, workspace, runtime: runtimeIdentity() }) + "\n");
  if (bytes.byteLength > READY_LIMIT) throw new Error("ready refused");
  for (let offset = 0; offset < bytes.byteLength;) {
    const written = writeSync(3, bytes, offset, bytes.byteLength - offset);
    if (written === 0) throw new Error("ready refused");
    offset += written;
  }
}

async function main(): Promise<void> {
  let server: DokkabiDesktopServer | undefined;
  let releaseRuntime: (() => void) | undefined;
  let releaseLedger: (() => void) | undefined;
  let readyFdOpen = false;
  let failureReported = false;
  let stopRequested = false;
  const closeReady = () => {
    if (!readyFdOpen) return;
    // Mark before close: a descriptor may be reused after successful close,
    // so finally must never close fd3 again after readiness was delivered.
    readyFdOpen = false;
    closeSync(3);
  };
  const fail = () => {
    process.exitCode = 1;
    if (failureReported) return;
    failureReported = true;
    try { writeSync(2, "Dokkabi desktop child failed.\n"); } catch { /* The parent may have closed diagnostics. */ }
  };
  let wake!: () => void;
  const shutdown = new Promise<void>((resolve) => { wake = resolve; });
  const signal = () => {
    stopRequested = true;
    process.stdin.destroy();
    wake();
  };
  process.on("SIGTERM", signal);
  process.on("SIGINT", signal);
  try {
    const readyFd = fstatSync(3);
    if (!readyFd.isFIFO() && !readyFd.isSocket()) throw new Error("ready refused");
    readyFdOpen = true;
    const bootstrap = validateBootstrap(await readBootstrap());
    if (stopRequested) return;
    releaseRuntime = prepareRuntime(bootstrap.runtimeDirectory);
    let gatewayLogPath = join(bootstrap.runtimeDirectory, "gateway.jsonl");
    if (bootstrap.gatewayLedgerDirectory !== undefined) {
      const { openDesktopGatewayLedger } = await import("../src/host/desktop-gateway-ledger.ts");
      const ledger = openDesktopGatewayLedger(bootstrap.gatewayLedgerDirectory);
      gatewayLogPath = ledger.path;
      releaseLedger = ledger.release;
    }
    const { DokkabiDesktopServer } = await import("../src/dash/desktop-server.ts");
    if (stopRequested) return;
    server = new DokkabiDesktopServer({
      host: "127.0.0.1",
      port: 0,
      workspaceCwd: bootstrap.workspace,
      sessionsRoot: join(dokkabiHome(), "sessions"),
      socketPath: join(bootstrap.runtimeDirectory, "gateway.sock"),
      gatewayLogPath,
      pairingToken: bootstrap.pairingToken,
    });
    // Startup has a private boundary: do not leak internal exception messages
    // from the server's best-effort socket fallback into child diagnostics.
    const warn = console.warn;
    const error = console.error;
    let httpUrl: string;
    try {
      console.warn = () => {};
      console.error = () => {};
      ({ httpUrl } = await server.start());
    } finally {
      console.warn = warn;
      console.error = error;
    }
    const socket = lstatSync(server.socketPath);
    if (!socket.isSocket() || socket.uid !== process.getuid?.() || (socket.mode & 0o077) !== 0) throw new Error("startup refused");
    if (stopRequested) return;
    readyRecord(httpUrl, bootstrap.workspace);
    closeReady();
    await shutdown;
  } catch {
    if (!stopRequested) fail();
  } finally {
    try { await server?.stop(); } catch { fail(); }
    try { releaseLedger?.(); } catch { fail(); }
    try { releaseRuntime?.(); } catch { fail(); }
    process.off("SIGTERM", signal);
    process.off("SIGINT", signal);
    try { closeReady(); } catch { fail(); }
  }
}

if (import.meta.main) await main();
