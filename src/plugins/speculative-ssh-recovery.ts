import { dirname } from "node:path";
import type { SshService } from "../host/ssh.ts";
import type { HostContext } from "../loader/types.ts";
import type { SpeculationEventWriter } from "../speculative/event-writer.ts";
import type { SpeculationV2Reference } from "../speculative/events-v2-schema.ts";
import { loadOrCreateRecoveryKey } from "../speculative/recovery-authority.ts";
import { SSH_TIER3_PROVIDER_DIGEST } from "../speculative/runtime-tier3-ssh.ts";
import { createSshTier3Recovery, type SshTier3Recovery } from "../speculative/runtime-tier3-ssh-recovery.ts";

type RecoveryState = { readonly recovery: SshTier3Recovery; task: Promise<void> | undefined };

export function createSessionSshRecovery(
  ctx: HostContext,
  writer: SpeculationEventWriter,
  references: readonly SpeculationV2Reference[],
  startupPending: ReadonlySet<string>,
) {
  const candidates = references.flatMap((row) => row.name === "prepare" && row.tier === 3
    && row.tool === "ssh" && row.provider_digest === SSH_TIER3_PROVIDER_DIGEST && startupPending.has(row.candidate_id)
    ? [row.candidate_id] : []);
  const recoveries = new WeakMap<SshService, RecoveryState>();
  const tasks = new Set<Promise<void>>();
  let failure: SpeculationRecoveryError | undefined;
  const assertHealthy = (): void => { if (failure) throw failure; };
  return {
    prepare(service: SshService | undefined): RecoveryState | undefined {
      assertHealthy();
      if (!service) return undefined;
      const existing = recoveries.get(service);
      if (existing) return existing;
      const sessionRoot = dirname(ctx.log.path);
      const recovery = createSshTier3Recovery({ service, sessionRoot, recoveryKey: loadOrCreateRecoveryKey(sessionRoot) });
      const state: RecoveryState = { recovery, task: undefined };
      recoveries.set(service, state);
      if (candidates.length > 0) {
        const pending = new Set(writer.pending());
        const task = recovery.recover(candidates.filter((id) => pending.has(id))).then((results) => {
          for (const result of results) {
            if (!writer.recover(result.candidateId, result.outcome)) throw new SpeculationPublicationError(result.candidateId);
          }
        }).catch((error: unknown) => { failure = new SpeculationRecoveryError(error); })
          .finally(() => { state.task = undefined; tasks.delete(task); });
        state.task = task;
        tasks.add(task);
      }
      return state;
    },
    assertHealthy,
    async idle() { await Promise.all([...tasks]); assertHealthy(); },
  };
}

export class SpeculationPublicationError extends Error {
  readonly name = "SpeculationPublicationError";
  constructor(readonly candidateId: string) { super("speculative SSH resolution could not be recorded"); }
}

class SpeculationRecoveryError extends Error {
  readonly name = "SpeculationRecoveryError";
  constructor(cause: unknown) { super("speculative SSH recovery failed", { cause }); }
}
