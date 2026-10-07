import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync,
  mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../../host/canonical.ts";
import { assertSandboxExecutableIdentity } from "../../host/sandbox-executable.ts";
import type { SshService } from "../../host/ssh.ts";
import type { SshWarmupTransportAuthority } from "../../host/ssh-warmup-authority.ts";
import { sealedSshPlan, type SshWarmupPlan } from "./ssh-seal.ts";
import { createSshControlDriver, type SshControlDriver } from "./ssh-process.ts";

const CandidateId = z.string().regex(/^[0-9a-f]{64}$/u);
const Digest = z.string().regex(/^[0-9a-f]{64}$/u);
const ResourceName = z.string().regex(/^dokkabi-ssh-warmup-[A-Za-z0-9]+$/u);
const Receipt = z.strictObject({ schema: z.literal(1), candidateId: CandidateId,
  target: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u), keyDigest: Digest,
  transportIdentity: Digest, resourceName: ResourceName, ownerPid: z.number().int().positive().safe(), mac: Digest });
type ReceiptValue = Readonly<z.infer<typeof Receipt>>;
type UnsignedReceipt = Omit<ReceiptValue, "mac">;

export type SshTier3RecoveryResult = Readonly<{ candidateId: string; outcome: "cleaned" | "refused" }>;
export interface SshWarmupRecovery {
  prepare(candidateId: string, plan: SshWarmupPlan): SshWarmupCrashReceipt;
  recover(candidateIds: readonly string[]): Promise<readonly SshTier3RecoveryResult[]>;
}
export class SshWarmupRecoveryError extends Error { readonly name = "SshWarmupRecoveryError"; }
const RECEIPT_SECRET = Symbol("ssh-warmup-crash-receipt");

export class SshWarmupCrashReceipt {
  readonly #root: string;
  readonly #recordPath: string;
  constructor(secret: symbol, root: string, recordPath: string) {
    if (secret !== RECEIPT_SECRET) throw new SshWarmupRecoveryError("SSH warmup recovery receipt is host-only");
    this.#root = root;
    this.#recordPath = recordPath;
    Object.freeze(this);
  }
  paths(): Readonly<{ root: string; socket: string }> {
    return Object.freeze({ root: this.#root, socket: join(this.#root, "control") });
  }
  discard(): void {
    rmSync(this.#root, { recursive: true, force: true });
    this.complete();
  }
  complete(): void {
    if (existsSync(this.#root)) throw new SshWarmupRecoveryError("SSH warmup resource still exists");
    removeReceipt(this.#recordPath);
  }
}

export function createSshWarmupRecovery(input: Readonly<{
  sessionRoot: string; recoveryKey: Uint8Array; service: SshService; driver?: SshControlDriver;
}>): SshWarmupRecovery {
  const sessionRoot = privateDirectory(input.sessionRoot);
  const key = Buffer.from(input.recoveryKey);
  if (key.byteLength !== 32) throw new SshWarmupRecoveryError("SSH warmup recovery key is invalid");
  const storageRoot = join(sessionRoot, "ssh-warmups");
  mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  privateDirectory(storageRoot);
  return Object.freeze({
    prepare(candidateId: string, plan: SshWarmupPlan) {
      CandidateId.parse(candidateId);
      const sealed = sealedSshPlan(plan);
      const root = mkdtempSync(join(tmpdir(), "dokkabi-ssh-warmup-"));
      chmodSync(root, 0o700);
      const resourceName = ResourceName.parse(basename(root));
      const recordPath = join(storageRoot, `${randomUUID()}.json`);
      try {
        const unsigned: UnsignedReceipt = Object.freeze({ schema: 1, candidateId, target: plan.request.target,
          keyDigest: plan.authority.keyDigest, transportIdentity: sealed.transport.identity, resourceName,
          ownerPid: process.pid });
        writeReceipt(recordPath, Object.freeze({ ...unsigned, mac: sign(key, unsigned) }));
        return new SshWarmupCrashReceipt(RECEIPT_SECRET, root, recordPath);
      } catch (error) {
        rmSync(root, { recursive: true, force: true });
        try { removeReceipt(recordPath); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], "SSH warmup receipt preparation cleanup failed"); }
        throw error;
      }
    },
    async recover(candidateIds: readonly string[]) {
      const pending = new Set(candidateIds.map((id) => CandidateId.parse(id)));
      const records = new Map<string, Array<{ readonly path: string; readonly receipt: ReceiptValue }>>();
      for (const entry of readdirSync(storageRoot, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[0-9a-f-]{36}\.json$/u.test(entry.name)) continue;
        const path = join(storageRoot, entry.name);
        try {
          const receipt = readReceipt(path, key);
          if (!pending.has(receipt.candidateId)) continue;
          const values = records.get(receipt.candidateId) ?? [];
          values.push({ path, receipt });
          records.set(receipt.candidateId, values);
        } catch (error) { if (!(error instanceof Error)) throw error; }
      }
      const results: SshTier3RecoveryResult[] = [];
      for (const candidateId of pending) {
        const values = records.get(candidateId);
        if (!values) continue;
        if (values.length !== 1) { results.push(Object.freeze({ candidateId, outcome: "refused" })); continue; }
        const value = values[0];
        if (!value) throw new SshWarmupRecoveryError("SSH warmup recovery record is missing");
        results.push(await recoverOne(value.path, value.receipt, input.service, input.driver));
      }
      return Object.freeze(results);
    },
  });
}

async function recoverOne(recordPath: string, receipt: ReceiptValue, service: SshService,
  injectedDriver?: SshControlDriver): Promise<SshTier3RecoveryResult> {
  const refused = (): SshTier3RecoveryResult => Object.freeze({ candidateId: receipt.candidateId, outcome: "refused" });
  try {
    if (ownerAlive(receipt.ownerPid)) return refused();
    const transport = service.warmupTransport(receipt.target);
    if (!transport || transport.identity !== receipt.transportIdentity) return refused();
    const root = join(tmpdir(), receipt.resourceName);
    if (existsSync(root)) {
      privateDirectory(root);
      const socket = join(root, "control");
      const entries = readdirSync(root);
      if (entries.some((entry) => entry !== "control")) return refused();
      const socketPresent = entries.includes("control");
      if (socketPresent && !lstatSync(socket).isSocket()) return refused();
      if (socketPresent) {
        assertSandboxExecutableIdentity(transport.executable);
        const driver = injectedDriver ?? createSshControlDriver(transport.executable.path);
        const result = await driver.run(recoveryArgs(transport, socket), transport.env, { timeoutMs: 1_000 });
        if (result.state !== "completed" || result.exitCode !== 0) return refused();
        for (let attempt = 0; attempt < 200 && existsSync(socket); attempt += 1) await Bun.sleep(5);
        if (existsSync(socket)) return refused();
      }
      privateDirectory(root);
      rmSync(root, { recursive: true, force: true });
    }
    removeReceipt(recordPath);
    return Object.freeze({ candidateId: receipt.candidateId, outcome: "cleaned" });
  } catch (error) { if (error instanceof Error) return refused(); throw error; }
}

function writeReceipt(path: string, receipt: ReceiptValue): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, canonicalJson(receipt)); fchmodSync(fd, 0o600); fsyncSync(fd); }
  finally { closeSync(fd); }
  syncDirectory(dirname(path));
}
function readReceipt(path: string, key: Buffer): ReceiptValue {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4_096 || (stat.mode & 0o777) !== 0o600)
      throw new SshWarmupRecoveryError("SSH warmup recovery receipt is unsafe");
    const receipt = Receipt.parse(JSON.parse(readFileSync(fd, "utf8")));
    const { mac, ...unsigned } = receipt;
    const expected = Buffer.from(sign(key, unsigned), "hex");
    if (!timingSafeEqual(expected, Buffer.from(mac, "hex"))) throw new SshWarmupRecoveryError("SSH warmup recovery receipt changed");
    return Object.freeze(receipt);
  } finally { closeSync(fd); }
}
function removeReceipt(path: string): void { rmSync(path, { force: true }); syncDirectory(dirname(path)); }
function privateDirectory(path: string): string {
  const requested = resolve(path);
  const requestedStat = lstatSync(requested);
  const resolved = realpathSync(requested);
  const stat = lstatSync(resolved);
  if (requestedStat.isSymbolicLink() || !stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new SshWarmupRecoveryError("SSH warmup recovery directory is unsafe");
  return resolved;
}
function sign(key: Buffer, value: UnsignedReceipt): string {
  return createHmac("sha256", key).update(canonicalJson(value), "utf8").digest("hex");
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function ownerAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (!(error instanceof Error)) throw error; return Reflect.get(error, "code") === "EPERM"; }
}
function recoveryArgs(transport: SshWarmupTransportAuthority, socket: string): readonly string[] {
  return ["-F", transport.configPath, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectionAttempts=1", "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no", "-o", "Tunnel=no", "-o", "PermitLocalCommand=no", "-o", "RequestTTY=no",
    "-o", `ControlPath=${socket}`, "-o", "ProxyCommand=/usr/bin/false", "-S", socket, "-O", "exit", "--", transport.alias];
}
