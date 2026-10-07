import { createHash } from "node:crypto";
import {
  assertSshWarmupTransportIdentity,
  type SshWarmupTransportAuthority,
} from "../../host/ssh-warmup-authority.ts";
import type { WarmupAuthority } from "./registry.ts";

export type SshWarmupRequest = Readonly<{
  target: string;
  command: string;
  timeout?: number;
}>;

export type SshWarmupPlan = Readonly<{
  authority: WarmupAuthority;
  request: SshWarmupRequest;
}>;

type SealedSshPlan = Readonly<{
  transport: SshWarmupTransportAuthority;
}>;

const SEALED_PLANS = new WeakMap<SshWarmupPlan, SealedSshPlan>();

export class SshWarmupSealError extends Error {
  readonly name = "SshWarmupSealError";
}

export function sealEnrolledSshWarmup(input: Readonly<{
  transport: SshWarmupTransportAuthority;
  command: string;
  timeout?: number;
}>): SshWarmupPlan {
  if (input.command.length === 0 || input.command.includes("\0")) {
    throw new SshWarmupSealError("SSH warmup command is invalid");
  }
  const timeout = input.timeout ?? 120;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3_600) {
    throw new SshWarmupSealError("SSH warmup timeout is invalid");
  }
  assertSshWarmupTransportIdentity(input.transport);
  const request = Object.freeze({ target: input.transport.alias, command: input.command, timeout });
  const keyDigest = createHash("sha256")
    .update(input.transport.identity).update("\0")
    .update(input.command).update("\0")
    .update(String(timeout))
    .digest("hex");
  const plan = Object.freeze({ authority: Object.freeze({ kind: "ssh", keyDigest }), request });
  SEALED_PLANS.set(plan, Object.freeze({ transport: input.transport }));
  return plan;
}

export function sealedSshPlan(plan: SshWarmupPlan): SealedSshPlan {
  const sealed = SEALED_PLANS.get(plan);
  if (!sealed) throw new SshWarmupSealError("SSH warmup plan has no sealed authority");
  return sealed;
}

export function assertSshConfigIdentity(plan: SshWarmupPlan): void {
  assertSshWarmupTransportIdentity(sealedSshPlan(plan).transport);
}
