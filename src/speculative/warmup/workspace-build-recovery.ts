import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../../host/canonical.ts";
import {
  assertSandboxPolicyEnforceable,
  type SandboxPolicy,
} from "../../host/sandbox.ts";
import { BUILD_TIER3_PROVIDER_DIGEST } from "../runtime-tier3-build-provider.ts";
import {
  createBuildRecoveryRecord,
  isProcessAlive,
  readBuildRecoveryRecord,
  removeBuildRecoveryRecord,
  replaceBuildRecoveryRecord,
} from "./workspace-build-recovery-store.ts";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const OptionalDigest = Digest.nullable();
const CandidateId = Digest;
const ResourceName = z.string().regex(/^dokkabi-workspace-build-[a-f0-9]{32}$/u);
const Identity = z.string().regex(/^\d+:\d+:\d+:\d+$/u);
const Common = {
  schema: z.literal(1),
  candidateId: CandidateId,
  providerDigest: z.literal(BUILD_TIER3_PROVIDER_DIGEST),
  resourceName: ResourceName,
  ownerPid: z.number().int().positive().safe(),
  policyDigest: Digest,
  backend: z.enum(["bwrap", "seatbelt", "docker", "none"]),
  executableIdentity: Digest,
  dockerImageIdentity: OptionalDigest,
  dockerHostEnvDigest: OptionalDigest,
};
const PlannedReceipt = z.strictObject({ ...Common, phase: z.literal("planned"), mac: Digest });
const AllocatedReceipt = z.strictObject({ ...Common, phase: z.literal("allocated"), identity: Identity, label: Digest, mac: Digest });
const Receipt = z.discriminatedUnion("phase", [PlannedReceipt, AllocatedReceipt]);
type ReceiptValue = Readonly<z.infer<typeof Receipt>>;
type UnsignedReceipt = Omit<ReceiptValue, "mac">;

export type WorkspaceBuildRecoveryResult = Readonly<{ candidateId: string; outcome: "cleaned" | "refused" }>;
export interface WorkspaceBuildWarmupRecovery {
  prepare(candidateId: string, policy: SandboxPolicy): WorkspaceBuildCrashReceipt;
  recover(candidateIds: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<readonly WorkspaceBuildRecoveryResult[]>;
}

export class WorkspaceBuildRecoveryError extends Error {
  readonly name = "WorkspaceBuildRecoveryError";
}

const RECEIPT_SECRET = Symbol("workspace-build-crash-receipt");

export class WorkspaceBuildCrashReceipt {
  readonly #root: string;
  readonly #identity: string;
  readonly #recordPath: string;

  constructor(secret: symbol, root: string, identity: string, recordPath: string) {
    if (secret !== RECEIPT_SECRET) throw new WorkspaceBuildRecoveryError("build recovery receipt is host-only");
    this.#root = root;
    this.#identity = identity;
    this.#recordPath = recordPath;
    Object.freeze(this);
  }

  root(): string { return this.#root; }
  complete(): void {
    if (existsSync(this.#root)) throw new WorkspaceBuildRecoveryError("build cache still exists");
    removeBuildRecoveryRecord(this.#recordPath);
  }
  discard(): void {
    if (existsSync(this.#root)) {
      if (directoryIdentity(this.#root) !== this.#identity) throw new WorkspaceBuildRecoveryError("build cache identity changed");
      rmSync(this.#root, { recursive: true, force: true });
    }
    removeBuildRecoveryRecord(this.#recordPath);
  }
}

export function createWorkspaceBuildWarmupRecovery(input: Readonly<{
  sessionRoot: string;
  recoveryKey: Uint8Array;
  afterPlannedReceipt?: (candidateId: string, root: string) => void;
}>): WorkspaceBuildWarmupRecovery {
  const sessionRoot = privateDirectory(input.sessionRoot);
  const key = Buffer.from(input.recoveryKey);
  if (key.byteLength !== 32) throw new WorkspaceBuildRecoveryError("build recovery key is invalid");
  const storageRoot = join(sessionRoot, "build-warmups");
  mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  privateDirectory(storageRoot);
  return Object.freeze({
    prepare(candidateId: string, policy: SandboxPolicy) {
      CandidateId.parse(candidateId);
      const seal = policySeal(policy);
      const resourceName = ResourceName.parse(`dokkabi-workspace-build-${randomUUID().replaceAll("-", "")}`);
      const root = join(realpathSync(tmpdir()), resourceName);
      const recordPath = join(storageRoot, `${randomUUID()}.json`);
      const planned = Object.freeze({ ...seal, schema: 1 as const, candidateId,
        providerDigest: BUILD_TIER3_PROVIDER_DIGEST, resourceName, ownerPid: process.pid, phase: "planned" as const });
      createBuildRecoveryRecord(recordPath, canonicalJson(signed(key, planned)));
      let allocatedIdentity: string | undefined;
      let created = false;
      try {
        input.afterPlannedReceipt?.(candidateId, root);
        mkdirSync(root, { mode: 0o700 });
        created = true;
        chmodSync(root, 0o700);
        const identity = directoryIdentity(root);
        allocatedIdentity = identity;
        const label = labelFor(root, identity);
        const allocated = Object.freeze({ ...planned, phase: "allocated" as const, identity, label });
        replaceBuildRecoveryRecord(recordPath, canonicalJson(signed(key, allocated)));
        return new WorkspaceBuildCrashReceipt(RECEIPT_SECRET, root, identity, recordPath);
      } catch (error) {
        if (allocatedIdentity && existsSync(root) && directoryIdentity(root) === allocatedIdentity) {
          rmSync(root, { recursive: true, force: true });
        }
        if (!created || allocatedIdentity) removeBuildRecoveryRecord(recordPath);
        throw error;
      }
    },
    async recover(candidateIds: readonly string[], policy: SandboxPolicy, signal?: AbortSignal) {
      const pending = new Set(candidateIds.map((id) => CandidateId.parse(id)));
      const seal = policySeal(policy);
      const records = new Map<string, Array<{ path: string; receipt: ReceiptValue }>>();
      for (const entry of readdirSync(storageRoot, { withFileTypes: true })) {
        if (signal?.aborted) break;
        if (!entry.isFile() || !/^[a-f0-9-]{36}\.json$/u.test(entry.name)) continue;
        const path = join(storageRoot, entry.name);
        try {
          const receipt = readReceipt(path, key);
          if (!pending.has(receipt.candidateId)) continue;
          const values = records.get(receipt.candidateId) ?? [];
          values.push({ path, receipt });
          records.set(receipt.candidateId, values);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
        }
      }
      const results: WorkspaceBuildRecoveryResult[] = [];
      for (const candidateId of pending) {
        if (signal?.aborted) break;
        const values = records.get(candidateId);
        if (!values) continue;
        if (values.length !== 1) {
          results.push(Object.freeze({ candidateId, outcome: "refused" }));
          continue;
        }
        const value = values[0];
        if (!value) throw new WorkspaceBuildRecoveryError("build recovery record is missing");
        results.push(await recoverOne(value.path, value.receipt, seal, policy));
      }
      return Object.freeze(results);
    },
  });
}

type PolicySeal = ReturnType<typeof policySeal>;

async function recoverOne(
  recordPath: string,
  receipt: ReceiptValue,
  current: PolicySeal,
  policy: SandboxPolicy,
): Promise<WorkspaceBuildRecoveryResult> {
  const result = (outcome: "cleaned" | "refused"): WorkspaceBuildRecoveryResult =>
    Object.freeze({ candidateId: receipt.candidateId, outcome });
  try {
    if (isProcessAlive(receipt.ownerPid) || !sameSeal(receipt, current)) return result("refused");
    const root = join(realpathSync(tmpdir()), receipt.resourceName);
    if (receipt.phase === "planned" && existsSync(root)) return result("refused");
    if (receipt.phase === "allocated") {
      if (existsSync(root) && directoryIdentity(root) !== receipt.identity) return result("refused");
      if (!await removeDockerContainer(policy, receipt.label)) return result("refused");
    }
    if (existsSync(root)) {
      privateDirectory(root);
      rmSync(root, { recursive: true, force: true });
    }
    removeBuildRecoveryRecord(recordPath);
    return result("cleaned");
  } catch (error) {
    if (error instanceof Error) return result("refused");
    throw error;
  }
}

function policySeal(policy: SandboxPolicy) {
  assertSandboxPolicyEnforceable(policy);
  const policyDigest = createHash("sha256").update([
    policy.workspaceRoot,
    policy.backend,
    policy.networkDenied ? "deny" : "allow",
    policy.backendExecutableIdentity,
    policy.dockerImageIdentityDigest ?? "missing",
    policy.dockerHostEnvDigest ?? "missing",
  ].join("\0")).digest("hex");
  return Object.freeze({ policyDigest, backend: policy.backend,
    executableIdentity: policy.backendExecutableIdentity,
    dockerImageIdentity: policy.dockerImageIdentityDigest ?? null,
    dockerHostEnvDigest: policy.dockerHostEnvDigest ?? null });
}

function sameSeal(receipt: ReceiptValue, current: PolicySeal): boolean {
  return receipt.policyDigest === current.policyDigest && receipt.backend === current.backend
    && receipt.executableIdentity === current.executableIdentity
    && receipt.dockerImageIdentity === current.dockerImageIdentity
    && receipt.dockerHostEnvDigest === current.dockerHostEnvDigest;
}

async function removeDockerContainer(policy: SandboxPolicy, label: string): Promise<boolean> {
  if (policy.backend !== "docker") return true;
  if (!policy.dockerBinary || !policy.dockerHostEnv) return false;
  const found = Bun.spawnSync([policy.dockerBinary, "ps", "-aq", "--filter", `label=dokkabi.speculative.warmup=${label}`],
    { env: { ...policy.dockerHostEnv } });
  if (found.exitCode !== 0) return false;
  const ids = found.stdout.toString().trim().split(/\s+/u).filter(Boolean);
  if (ids.length > 1) return false;
  if (ids.length === 0) return true;
  const removed = Bun.spawnSync([policy.dockerBinary, "rm", "-f", ids[0] ?? ""], { env: { ...policy.dockerHostEnv } });
  return removed.exitCode === 0;
}

function signed(key: Buffer, unsigned: UnsignedReceipt): ReceiptValue {
  return Receipt.parse({ ...unsigned, mac: createHmac("sha256", key).update(canonicalJson(unsigned)).digest("hex") });
}

function readReceipt(path: string, key: Buffer): ReceiptValue {
  const receipt = Receipt.parse(JSON.parse(readBuildRecoveryRecord(path)));
  const { mac, ...unsigned } = receipt;
  const expected = Buffer.from(createHmac("sha256", key).update(canonicalJson(unsigned)).digest("hex"), "hex");
  if (!timingSafeEqual(expected, Buffer.from(mac, "hex"))) throw new WorkspaceBuildRecoveryError("build recovery receipt changed");
  return Object.freeze(receipt);
}

function privateDirectory(path: string): string {
  const requested = resolve(path);
  const canonical = realpathSync(requested);
  const requestedStat = lstatSync(requested, { bigint: true });
  const stat = lstatSync(canonical, { bigint: true });
  const uid = BigInt(process.getuid?.() ?? Number(stat.uid));
  if (requestedStat.isSymbolicLink() || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077n) !== 0n) {
    throw new WorkspaceBuildRecoveryError("build recovery directory is unsafe");
  }
  return canonical;
}

function directoryIdentity(path: string): string {
  const canonical = privateDirectory(path);
  const stat = lstatSync(canonical, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.uid}:${stat.mode}`;
}

function labelFor(path: string, identity: string): string {
  return createHash("sha256").update(path).update("\0").update(identity).digest("hex");
}
