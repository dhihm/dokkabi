import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SshRunner, SshRunnerInput } from "../../host/ssh.ts";
import type { SshWarmupTransportAuthority } from "../../host/ssh-warmup-authority.ts";
import { assertSandboxExecutableIdentity } from "../../host/sandbox-executable.ts";
import {
  createWarmupRegistry,
  type WarmupAuthority,
  type WarmupLease,
  type WarmupRegistry,
} from "./registry.ts";
import {
  assertSshConfigIdentity,
  sealedSshPlan,
  type SshWarmupPlan,
} from "./ssh-seal.ts";
import {
  createSshControlDriver,
  type SshControlDriver,
  type SshControlProcess,
} from "./ssh-process.ts";
import type { SshWarmupCrashReceipt } from "./ssh-recovery.ts";

export { sealEnrolledSshWarmup } from "./ssh-seal.ts";
export type { SshWarmupPlan, SshWarmupRequest } from "./ssh-seal.ts";
export type { SshControlDriver, SshControlProcess } from "./ssh-process.ts";

export type SshWarmupApprovalResult<Approval> =
  | { readonly ok: true; readonly approval: Approval; readonly discard?: () => void }
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: false; readonly result: Readonly<{ text: string }> };

export type SshWarmupResource<Approval> = Readonly<{
  approval: Approval;
  runner: SshRunner;
  transport: SshWarmupTransportAuthority;
  dispose(): Promise<void>;
}>;

export type SshWarmupLease<Approval> = WarmupLease<SshWarmupResource<Approval>>;

export function createSshWarmupLease<Approval>(input: Readonly<{
  plan: SshWarmupPlan;
  approval: (
    request: SshWarmupPlan["request"],
    transport: SshWarmupTransportAuthority,
    signal?: AbortSignal,
  ) => Promise<SshWarmupApprovalResult<Approval>>;
  signal?: AbortSignal;
  timeoutMs?: number;
  registry?: WarmupRegistry;
  driver?: SshControlDriver;
  assertExecutable?: typeof assertSandboxExecutableIdentity;
  crashRecovery?: SshWarmupCrashReceipt;
}>): SshWarmupLease<Approval> {
  try {
    const sealed = sealedSshPlan(input.plan);
    const registry = input.registry ?? createWarmupRegistry();
    const driver = input.driver ?? createSshControlDriver(sealed.transport.executable.path);
    const assertExecutable = input.assertExecutable ?? assertSandboxExecutableIdentity;
    return registry.prepare({
      authority: input.plan.authority,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      acquire: (signal) => acquireResource({
        plan: input.plan,
        approval: input.approval,
        assertExecutable,
        driver,
        env: sealed.transport.env,
        signal,
        ...(input.crashRecovery ? { crashRecovery: input.crashRecovery } : {}),
      }),
      release: (resource) => resource.dispose(),
    });
  } catch (error) {
    input.crashRecovery?.discard();
    throw error;
  }
}

type AcquireInput<Approval> = Readonly<{
  plan: SshWarmupPlan;
  approval: (
    request: SshWarmupPlan["request"],
    transport: SshWarmupTransportAuthority,
    signal?: AbortSignal,
  ) => Promise<SshWarmupApprovalResult<Approval>>;
  assertExecutable: typeof assertSandboxExecutableIdentity;
  driver: SshControlDriver;
  env: Readonly<Record<string, string>>;
  signal: AbortSignal;
  crashRecovery?: SshWarmupCrashReceipt;
}>;

async function acquireResource<Approval>(input: AcquireInput<Approval>): Promise<SshWarmupResource<Approval>> {
  const sealed = sealedSshPlan(input.plan);
  let approved: SshWarmupApprovalResult<Approval>;
  try {
    approved = await input.approval(input.plan.request, sealed.transport, input.signal);
  } catch (error) {
    input.crashRecovery?.discard();
    throw error;
  }
  if (!approved.ok) {
    input.crashRecovery?.discard();
    throw new SshWarmupError("reason" in approved ? approved.reason : approved.result.text);
  }
  const root = (() => {
    let path: string | undefined;
    try {
      if (input.signal.aborted) throw new SshWarmupError("cancelled");
      input.assertExecutable(sealed.transport.executable);
      assertSshConfigIdentity(input.plan);
      path = input.crashRecovery?.paths().root ?? mkdtempSync(join(tmpdir(), "dokkabi-ssh-warmup-"));
      if (!input.crashRecovery) chmodSync(path, 0o700);
      return path;
    } catch (error) {
      if (path) rmSync(path, { recursive: true, force: true });
      if (input.crashRecovery && (!path || path === input.crashRecovery.paths().root)) input.crashRecovery.discard();
      approved.discard?.();
      throw error;
    }
  })();
  const socket = join(root, "control");
  let master: SshControlProcess | undefined;
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    approved.discard?.();
    let failure: unknown;
    if (master) {
      try {
        await input.driver.run(controlArgs(input.plan, socket, "exit"), input.env, { timeoutMs: 1_000 });
      } catch (error) {
        failure = error;
      }
      try {
        master.kill();
        await Promise.race([master.exited, Bun.sleep(1_000)]);
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      rmSync(root, { recursive: true, force: true });
      input.crashRecovery?.complete();
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) {
      sealed.transport.reportCleanupFailure();
      throw failure;
    }
  };
  try {
    master = input.driver.spawn(masterArgs(input.plan, socket), input.env);
    await waitUntilReady(input.plan, socket, input.driver, input.env, input.signal, master);
    const runner: SshRunner = async (request) => {
      assertExactRunnerInput(input.plan, request);
      input.assertExecutable(sealed.transport.executable);
      assertSshConfigIdentity(input.plan);
      return input.driver.run(foregroundArgs(input.plan, socket), input.env, {
        ...(request.signal ? { signal: request.signal } : {}),
        timeoutMs: request.timeoutMs,
      });
    };
    return Object.freeze({ approval: approved.approval, runner, transport: sealed.transport, dispose });
  } catch (error) {
    await dispose();
    throw error;
  }
}

export class SshWarmupError extends Error {
  readonly name = "SshWarmupError";
}

function assertExactRunnerInput(plan: SshWarmupPlan, input: SshRunnerInput): void {
  const sealed = sealedSshPlan(plan);
  if (input.target !== plan.request.target || input.command !== plan.request.command || input.stdin !== undefined ||
    input.timeoutMs !== (plan.request.timeout ?? 120) * 1_000 ||
    input.executable !== sealed.transport.executable.path) {
    throw new SshWarmupError("SSH warmup foreground operation mismatch");
  }
}

async function waitUntilReady(
  plan: SshWarmupPlan,
  socket: string,
  driver: SshControlDriver,
  env: Readonly<Record<string, string>>,
  signal: AbortSignal,
  master: SshControlProcess,
): Promise<void> {
  let masterExited = false;
  void master.exited.then(() => { masterExited = true; });
  while (!signal.aborted && !masterExited) {
    const check = await driver.run(controlArgs(plan, socket, "check"), env, { signal, timeoutMs: 250 });
    if (check.state === "completed" && check.exitCode === 0 && !masterExited) return;
    await Bun.sleep(5);
  }
  if (masterExited) throw new SshWarmupError("SSH warmup master exited before readiness");
  throw new SshWarmupError("cancelled");
}

function secureOptions(plan: SshWarmupPlan, socket: string): string[] {
  const sealed = sealedSshPlan(plan);
  return [
    "-F", sealed.transport.configPath,
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectionAttempts=1",
    "-o", "ClearAllForwardings=yes",
    "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no",
    "-o", "ForwardX11Trusted=no",
    "-o", "Tunnel=no",
    "-o", "PermitLocalCommand=no",
    "-o", "RequestTTY=no",
    "-o", `ControlPath=${socket}`,
  ];
}

function masterArgs(plan: SshWarmupPlan, socket: string): string[] {
  return [...secureOptions(plan, socket), "-o", "ControlMaster=yes", "-o", "ControlPersist=no", "-N", "--", plan.request.target];
}

function foregroundArgs(plan: SshWarmupPlan, socket: string): string[] {
  return [
    ...secureOptions(plan, socket),
    "-o", "ControlMaster=no",
    "-o", "ControlPersist=no",
    "-o", "ProxyCommand=/usr/bin/false",
    "--", plan.request.target, plan.request.command,
  ];
}

function controlArgs(plan: SshWarmupPlan, socket: string, operation: "check" | "exit"): string[] {
  return [
    ...secureOptions(plan, socket),
    "-o", "ProxyCommand=/usr/bin/false",
    "-S", socket,
    "-O", operation,
    "--", plan.request.target,
  ];
}

export function sshWarmupAuthority(plan: SshWarmupPlan): WarmupAuthority {
  return plan.authority;
}
