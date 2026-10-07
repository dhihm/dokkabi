import type { SshService } from "../host/ssh.ts";
import {
  createSshWarmupRecovery,
  type SshTier3RecoveryResult,
  type SshWarmupRecovery,
} from "./warmup/ssh-recovery.ts";
import type { SshControlDriver } from "./warmup/ssh.ts";

export type SshTier3Recovery = SshWarmupRecovery;
export type { SshTier3RecoveryResult };

export function createSshTier3Recovery(input: Readonly<{
  sessionRoot: string;
  recoveryKey: Uint8Array;
  service: SshService;
  driver?: SshControlDriver;
}>): SshTier3Recovery {
  return createSshWarmupRecovery(input);
}
