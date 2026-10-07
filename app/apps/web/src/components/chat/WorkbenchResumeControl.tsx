import { useCallback, useEffect, useRef, useState } from "react";
import { PlugZapIcon } from "lucide-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { Button } from "../ui/button";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { workbenchOverviewAtomFor } from "~/state/workbenchOverview";
import { workbenchResumeAction } from "~/state/workbenchResume";
import { resumeControlVisible, resumeOutcomeMessage } from "./WorkbenchResumeControl.logic";

/**
 * R8 explicit recorded-parent reconnect: one compact control that appears ONLY
 * while the thread's recorded overview reports the source detached
 * ("unavailable") — a persisted harness conversation whose gateway binding is
 * gone after a restart or dispose. Ordinary providers and drafts never reach
 * that state, so the control stays hidden for them.
 *
 * The reconnect dispatches ONLY from an explicit operator click: mounting,
 * the bounded overview poll and projection updates never send it. Restored
 * reads are observed by the normal poll — no automatic dispatch and no
 * synthetic refresh rows. Every async continuation is guarded by mount +
 * action generation + scope equality, so a stale or unmounted reply can
 * never touch state; busy always clears (interruption clears silently), and
 * an honest unsupported/unknown outcome shows its bounded reason. The
 * composer, drafts and history are not touched by this control.
 */
export function WorkbenchResumeControl({
  environmentId,
  threadId,
  providerInstanceId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
}) {
  const mountedRef = useRef(true);
  /** Bumped on unmount and on every scope change: continuations of an older
   * generation may neither touch state nor show stale thread results. */
  const actionGenerationRef = useRef(0);
  const scopeKey = JSON.stringify([environmentId, threadId, providerInstanceId ?? null]);
  const scopeKeyRef = useRef(scopeKey);

  useEffect(() => {
    mountedRef.current = true;
    if (scopeKeyRef.current !== scopeKey) {
      scopeKeyRef.current = scopeKey;
      actionGenerationRef.current += 1;
      setBusy(false);
      setMessage(null);
    }
    return () => {
      mountedRef.current = false;
      actionGenerationRef.current += 1;
    };
  }, [scopeKey]);

  // Same keyed overview atom the WorkbenchContextBar subscribes to: no new
  // poll, no new request shape — only the retained availability fact.
  const query = useEnvironmentQuery(
    workbenchOverviewAtomFor({ environmentId, threadId, providerInstanceId }),
  );
  const runResume = useAtomCommand(workbenchResumeAction, { reportFailure: false });
  const runResumeRef = useRef(runResume);
  runResumeRef.current = runResume;

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const reconnect = useCallback(async () => {
    if (!mountedRef.current || busy) return;
    const scopeAtStart = scopeKeyRef.current;
    const generation = actionGenerationRef.current;
    setBusy(true);
    setMessage(null);
    let outcomeMessage: string | null = null;
    try {
      const result = await runResumeRef.current({
        environmentId,
        input: { threadId },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const squashed = squashAtomCommandFailure(result);
          outcomeMessage =
            squashed instanceof Error
              ? squashed.message
              : "The reconnect failed at the provider boundary.";
        }
      } else {
        outcomeMessage = resumeOutcomeMessage(result.value);
      }
    } catch {
      outcomeMessage = "The reconnect failed.";
    }
    if (
      !mountedRef.current ||
      generation !== actionGenerationRef.current ||
      scopeKeyRef.current !== scopeAtStart
    ) {
      // Stale continuation: no state write from a dead generation or scope.
      return;
    }
    setBusy(false);
    setMessage(outcomeMessage);
  }, [busy, environmentId, threadId]);

  const overview = query.data;
  if (!resumeControlVisible({ overviewStatus: overview?.status ?? null })) {
    return null;
  }
  return (
    <div
      className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-background px-4 text-xs text-muted-foreground"
      data-workbench-resume-control="unavailable"
      data-thread-id={threadId}
    >
      <PlugZapIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="max-w-[72ch] truncate">
        {overview?.reason ?? "The recorded source is not currently bound."} No message is required
        to reach it again.
      </span>
      <span className="grow" />
      <Button
        variant="outline"
        size="xs"
        disabled={busy}
        data-workbench-resume-reconnect="true"
        onClick={() => {
          void reconnect();
        }}
      >
        {busy ? "Reconnecting…" : "Reconnect recorded conversation"}
      </Button>
      {busy ? (
        <span data-workbench-resume-state="busy" className="text-muted-foreground">
          Reconnecting the recorded source…
        </span>
      ) : message !== null ? (
        <span
          data-workbench-resume-state="message"
          className="max-w-[72ch] truncate text-warning-foreground"
        >
          {message}
        </span>
      ) : null}
    </div>
  );
}
