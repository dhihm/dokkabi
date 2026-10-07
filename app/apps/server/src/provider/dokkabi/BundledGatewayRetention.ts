// @effect-diagnostics nodeBuiltinImport:off
// Allocation is a synchronous native filesystem transaction before process launch.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

const RUN_LIMIT = 64;
const BYTE_LIMIT = 128 * 1024 * 1024;
const RUN_NAME = /^run-[a-f0-9]{16}$/;
const ROOT_OWNER = "owner.json";
const CLAIM = ".allocation";
const IDENTITY_KIND = "dokkabi-desktop-gateways";
const LOG_FILES = new Set(["gateway.jsonl", "gateway.telemetry.jsonl", ".desktop-child-owner"]);

class RetentionRefusal extends Error {}
const refuse = (
  message = "Bundled gateway storage cannot be verified. Retained evidence was preserved.",
): never => {
  throw new RetentionRefusal(message);
};

/** Only an absolute configured harness home supplies the persistent default.
 * Explicit runtimeRoot exists for isolated fixtures and host integration. */
export function bundledGatewayRuntimeRoot(runtimeRoot?: string): string {
  return storageRoot("desktop-gateways", runtimeRoot);
}

function storageRoot(name: string, override?: string): string {
  const runtimeRoot = override;
  if (runtimeRoot !== undefined) {
    if (!NodePath.isAbsolute(runtimeRoot) || runtimeRoot.includes("\0")) refuse();
    return NodePath.resolve(runtimeRoot);
  }
  const configured = process.env.DOKKABI_HOME;
  const home =
    configured && NodePath.isAbsolute(configured)
      ? configured
      : NodePath.join(NodeOS.homedir(), ".dokkabi");
  return NodePath.join(home, name);
}

/** Canonicalize existing ancestors without creating an oversized socket path. */
function prospectiveRoot(path: string): string {
  const missing: string[] = [];
  let ancestor = path;
  for (;;) {
    try {
      const stat = NodeFS.lstatSync(ancestor);
      if (ancestor === path && stat.isSymbolicLink()) refuse();
      if (!stat.isDirectory() && !stat.isSymbolicLink()) refuse();
      return NodePath.join(NodeFS.realpathSync(ancestor), ...missing.toReversed());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(NodePath.basename(ancestor));
      const parent = NodePath.dirname(ancestor);
      if (parent === ancestor) refuse();
      ancestor = parent;
    }
  }
}

function ownedStat(path: string, rootDevice?: number): NodeFS.Stats {
  const stat = NodeFS.lstatSync(path);
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    stat.uid !== uid ||
    (stat.mode & 0o077) !== 0 ||
    stat.isSymbolicLink() ||
    (rootDevice !== undefined && stat.dev !== rootDevice)
  )
    refuse();
  return stat;
}

function regularBytes(path: string, rootDevice: number): number {
  const placed = ownedStat(path, rootDevice);
  if (!placed.isFile() || placed.nlink !== 1) refuse();
  const fd = NodeFS.openSync(path, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  try {
    const opened = NodeFS.fstatSync(fd);
    if (
      opened.dev !== placed.dev ||
      opened.ino !== placed.ino ||
      !Number.isSafeInteger(opened.size) ||
      opened.size < 0
    )
      refuse();
    return opened.size;
  } finally {
    NodeFS.closeSync(fd);
  }
}

function readRootOwner(root: string, rootDevice: number, kind = IDENTITY_KIND): number {
  const path = NodePath.join(root, ROOT_OWNER);
  const placed = ownedStat(path, rootDevice);
  if (!placed.isFile() || placed.nlink !== 1 || placed.size > 1024) refuse();
  const fd = NodeFS.openSync(path, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  try {
    const opened = NodeFS.fstatSync(fd);
    if (opened.dev !== placed.dev || opened.ino !== placed.ino || opened.size > 1024) refuse();
    const owner: unknown = JSON.parse(NodeFS.readFileSync(fd, "utf8"));
    if (
      !owner ||
      typeof owner !== "object" ||
      Array.isArray(owner) ||
      Object.keys(owner).length !== 3
    )
      refuse();
    const value = owner as Record<string, unknown>;
    if (value.schema !== 1 || value.kind !== kind || value.uid !== process.getuid?.()) refuse();
    return opened.size;
  } finally {
    NodeFS.closeSync(fd);
  }
}

function runBytes(path: string, rootDevice: number, ledger = false): number {
  if (!ownedStat(path, rootDevice).isDirectory()) refuse();
  let bytes = 0;
  for (const name of NodeFS.readdirSync(path)) {
    const file = NodePath.join(path, name);
    if (
      (LOG_FILES.has(name) && (!ledger || name !== ".desktop-child-owner")) ||
      (ledger && name === "run.lock")
    )
      bytes += regularBytes(file, rootDevice);
    else if (!ledger && name === "gateway.sock") {
      if (!ownedStat(file, rootDevice).isSocket()) refuse();
    } else if (name === "gateway.jsonl.lock") {
      if (!ownedStat(file, rootDevice).isDirectory()) refuse();
      const children = NodeFS.readdirSync(file);
      if (children.length !== 1 || children[0] !== "owner.json") refuse();
      bytes += regularBytes(NodePath.join(file, "owner.json"), rootDevice);
    } else refuse();
  }
  return bytes;
}

/** Serialize owned-root admission. The claim is never reclaimed by age/PID;
 * unknown ownership needs repair, and retained evidence is never removed. */
function withAllocationRoot<T>(
  root: string,
  kind: string,
  use: (rootStat: NodeFS.Stats, bytes: number) => T,
): T {
  let claim: { path: string; dev: number; ino: number } | undefined;
  let claimOwner: { path: string; dev: number; ino: number } | undefined;
  try {
    if (process.getuid === undefined) refuse();
    let created = false;
    try {
      NodeFS.mkdirSync(root, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        created = NodeFS.mkdirSync(root, { recursive: true, mode: 0o700 }) !== undefined;
      } else if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const rootStat = ownedStat(root);
    if (!rootStat.isDirectory()) refuse();
    const claimPath = NodePath.join(root, CLAIM);
    try {
      NodeFS.mkdirSync(claimPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        refuse("Bundled gateway storage allocation is busy. Retained evidence was preserved.");
      throw error;
    }
    const claimStat = ownedStat(claimPath, rootStat.dev);
    claim = { path: claimPath, dev: claimStat.dev, ino: claimStat.ino };
    const ownerPath = NodePath.join(claimPath, ROOT_OWNER);
    const ownerFd = NodeFS.openSync(ownerPath, "wx", 0o600);
    try {
      const stat = NodeFS.fstatSync(ownerFd);
      claimOwner = { path: ownerPath, dev: stat.dev, ino: stat.ino };
      NodeFS.writeFileSync(
        ownerFd,
        JSON.stringify({ token: NodeCrypto.randomBytes(16).toString("hex"), pid: process.pid }),
      );
    } finally {
      NodeFS.closeSync(ownerFd);
    }
    if (created) {
      NodeFS.writeFileSync(
        NodePath.join(root, ROOT_OWNER),
        JSON.stringify({ schema: 1, kind, uid: process.getuid?.() }),
        { flag: "wx", mode: 0o600 },
      );
    }
    const bytes = readRootOwner(root, rootStat.dev, kind) + regularBytes(ownerPath, rootStat.dev);
    return use(rootStat, bytes);
  } catch (error) {
    if (error instanceof RetentionRefusal) throw error;
    return refuse();
  } finally {
    // Clean only our ephemeral claim. Never recursively delete its contents,
    // reclaim another claimant, or unlink evidence from a retained run.
    if (claim) {
      try {
        const current = NodeFS.lstatSync(claim.path);
        if (current.dev === claim.dev && current.ino === claim.ino) {
          if (claimOwner) {
            const owner = NodeFS.lstatSync(claimOwner.path);
            if (owner.dev === claimOwner.dev && owner.ino === claimOwner.ino)
              NodeFS.unlinkSync(claimOwner.path);
          }
          NodeFS.rmdirSync(claim.path);
        }
      } catch {
        /* A changed or incomplete claim fails closed on later starts. */
      }
    }
  }
}

function scanDirectories(
  root: string,
  rootStat: NodeFS.Stats,
  initialBytes: number,
  ledger: boolean,
) {
  let bytes = initialBytes;
  const names = new Set<string>();
  for (const item of NodeFS.readdirSync(root)) {
    if (item === ROOT_OWNER || item === CLAIM) continue;
    if (!(ledger ? /^[a-f0-9]{64}$/.test(item) : RUN_NAME.test(item))) refuse();
    names.add(item);
    bytes += runBytes(NodePath.join(root, item), rootStat.dev, ledger);
    if (!Number.isSafeInteger(bytes)) refuse();
  }
  return { names, bytes };
}

function requireAdmission(count: number, bytes: number): void {
  if (count >= RUN_LIMIT || bytes >= BYTE_LIMIT) {
    refuse(
      "Bundled gateway retention limit reached. Retained evidence was preserved; new gateway startup was refused.",
    );
  }
}

type RunIdentity = {
  directory: string;
  root: string;
  dev: number;
  ino: number;
  rootDev: number;
  rootIno: number;
};
const allocatedRuns = new Map<string, RunIdentity>();
const runReceipts = new WeakMap<BundledGatewayRunReceipt, RunIdentity>();

/** Opaque creation-bound receipt. It grants only removal of the same empty run. */
export interface BundledGatewayRunReceipt {
  readonly directory: string;
}

/** Fresh process/socket directory. Retained evidence is never deleted here. */
export function allocateBundledGatewayRun(runtimeRoot?: string): string {
  try {
    const root = prospectiveRoot(bundledGatewayRuntimeRoot(runtimeRoot));
    const run = NodePath.join(root, `run-${NodeCrypto.randomBytes(8).toString("hex")}`);
    if (
      HostProcessPlatform.defaultValue() !== "win32" &&
      Buffer.byteLength(NodePath.join(run, "gateway.sock")) > 100
    ) {
      refuse("Bundled gateway storage path exceeds the local socket limit.");
    }
    return withAllocationRoot(root, IDENTITY_KIND, (rootStat, bytes) => {
      const scan = scanDirectories(root, rootStat, bytes, false);
      requireAdmission(scan.names.size, scan.bytes);
      NodeFS.mkdirSync(run, { mode: 0o700 });
      const stat = ownedStat(run, rootStat.dev);
      if (!stat.isDirectory()) refuse();
      allocatedRuns.set(run, {
        directory: run,
        root,
        dev: stat.dev,
        ino: stat.ino,
        rootDev: rootStat.dev,
        rootIno: rootStat.ino,
      });
      return run;
    });
  } catch (error) {
    if (error instanceof RetentionRefusal) throw error;
    return refuse();
  }
}

/** A canonical workspace and provider owner bind one durable ledger; the
 * returned directory never contains app-created gateway history or a lock. */
export function allocateBundledGatewayLedger(
  input: { ownerKey: string; workspace: string },
  ledgerRoot?: string,
): string {
  try {
    if (
      !input.ownerKey ||
      Buffer.byteLength(input.ownerKey) > 4096 ||
      input.ownerKey.includes("\0") ||
      !NodePath.isAbsolute(input.workspace)
    )
      refuse();
    const workspace = NodeFS.realpathSync(input.workspace);
    if (!NodeFS.statSync(workspace).isDirectory()) refuse();
    const name = NodeCrypto.createHash("sha256")
      .update(workspace)
      .update("\0")
      .update(input.ownerKey)
      .digest("hex");
    const root = prospectiveRoot(storageRoot("desktop-ledgers", ledgerRoot));
    return withAllocationRoot(root, "dokkabi-desktop-ledgers", (rootStat, bytes) => {
      const scan = scanDirectories(root, rootStat, bytes, true);
      const directory = NodePath.join(root, name);
      if (!scan.names.has(name)) {
        requireAdmission(scan.names.size, scan.bytes);
        NodeFS.mkdirSync(directory, { mode: 0o700 });
      }
      return directory;
    });
  } catch (error) {
    if (error instanceof RetentionRefusal) throw error;
    return refuse();
  }
}

/** Capture immediately after allocation, before passing the run to its child. */
export function captureBundledGatewayRun(directory: string): BundledGatewayRunReceipt {
  const identity = allocatedRuns.get(directory);
  if (!identity) return refuse();
  allocatedRuns.delete(directory);
  const receipt = Object.freeze({ directory });
  runReceipts.set(receipt, identity);
  return receipt;
}

/** Caller must first confirm its child exited. rmdir is the final empty check;
 * changed/nonempty runs stay intact, and forged receipts grant no authority. */
export function releaseEmptyBundledGatewayRun(receipt: BundledGatewayRunReceipt): boolean {
  const identity = runReceipts.get(receipt);
  if (!identity) return refuse();
  try {
    const root = ownedStat(identity.root);
    if (root.dev !== identity.rootDev || root.ino !== identity.rootIno) return false;
    readRootOwner(identity.root, root.dev);
    const stat = ownedStat(identity.directory, root.dev);
    if (stat.dev !== identity.dev || stat.ino !== identity.ino || !stat.isDirectory()) return false;
    if (NodeFS.readdirSync(identity.directory).length !== 0) return false;
    NodeFS.rmdirSync(identity.directory);
    runReceipts.delete(receipt);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return false;
    if (error instanceof RetentionRefusal) throw error;
    return refuse();
  }
}
