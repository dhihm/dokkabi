import { useEffect, useRef, useState } from "react";
import type {
  CodeObserverState,
  ProviderWorkbenchCodeActionInput,
  ProviderWorkbenchCodeActionResult,
} from "@t3tools/contracts";
import { Button } from "../../ui/button";
import { randomUUID } from "~/lib/utils";
import {
  readCodeObserverIntent,
  retainCodeObserverIntent,
  clearCodeObserverIntent,
} from "~/state/workbenchCodeIntent";

type ResumeRequest = Omit<ProviderWorkbenchCodeActionInput, "threadId">;
export function CodeObserverControls({
  scopeKey,
  observer,
  disabled,
  onResume,
}: {
  scopeKey: string;
  observer: CodeObserverState | undefined;
  disabled: boolean;
  onResume: (request: ResumeRequest) => Promise<ProviderWorkbenchCodeActionResult>;
}) {
  return (
    <ScopedObserverControls
      key={scopeKey}
      scopeKey={scopeKey}
      observer={observer}
      disabled={disabled}
      onResume={onResume}
    />
  );
}
function ScopedObserverControls({
  scopeKey,
  observer,
  disabled,
  onResume,
}: {
  scopeKey: string;
  observer: CodeObserverState | undefined;
  disabled: boolean;
  onResume: (request: ResumeRequest) => Promise<ProviderWorkbenchCodeActionResult>;
}) {
  const [retained] = useState(() => readCodeObserverIntent(scopeKey));
  const [newWindow, setNewWindow] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(retained.kind === "pending");
  const [awaitingRevision, setAwaitingRevision] = useState<number | null>(null);
  const inFlight = useRef(false);
  const [heldRequest, setHeldRequest] = useState<ResumeRequest | null>(
    retained.kind === "pending" ? retained.request : null,
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const storageFull =
    observer?.reason === "version_limit" ||
    observer?.reason === "retention_bytes_limit" ||
    (observer?.retainedVersions ?? 0) >= 32 ||
    (observer?.retainedBytes ?? 0) >= 64 * 1024 * 1024;
  const awaitingUpdate = awaitingRevision !== null && (observer?.revision ?? -1) < awaitingRevision;
  const admissionBlocked = disabled || retained.kind === "unavailable" || awaitingUpdate;
  const canResume = observer?.state === "paused" && observer.revision !== undefined && !storageFull;
  const resume = async () => {
    if (inFlight.current || admissionBlocked || (!uncertain && !canResume)) return;
    const request = heldRequest ?? {
      operation: "resume" as const,
      commandId: randomUUID(),
      expectedRevision: observer!.revision!,
      newWindow,
    };
    try {
      retainCodeObserverIntent(scopeKey, request);
    } catch {
      setMessage("Could not retain the resume command. No request was sent.");
      return;
    }
    setHeldRequest(request);
    inFlight.current = true;
    setPending(true);
    setMessage(null);
    try {
      const result = await onResume(request);
      if (!mounted.current) return;
      if (result.state === "applied" && result.receipt.commandId !== request.commandId) {
        throw new Error("Resume receipt does not match the submitted command");
      }
      // A retry refusal cannot disprove an earlier response-lost application.
      const unresolved = result.state !== "applied" && (uncertain || result.state === "unknown");
      setUncertain(unresolved);
      if (!unresolved) {
        clearCodeObserverIntent(scopeKey, request);
        setHeldRequest(null);
      }
      if (result.state === "applied") {
        setAwaitingRevision(result.observer.revision!);
        setNewWindow(false);
        setMessage(`Resume recorded at #${result.receipt.seq}. Refreshing observer state.`);
      } else {
        setMessage(
          unresolved
            ? `Resume remains unresolved · ${result.state}: ${result.reason}. Retry the same command to reconcile it.`
            : `${result.state}: ${result.reason}`,
        );
      }
    } catch {
      if (!mounted.current) return;
      setUncertain(true);
      setMessage("Resume outcome unknown. Retry the same command to reconcile it.");
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  };
  if (observer?.revision === undefined && !uncertain)
    return (
      <p className="border-b border-border px-3 py-1.5 text-3xs text-muted-foreground">
        Observer recovery availability is unknown. Idle capture availability is unknown.
      </p>
    );
  if (observer?.state !== "paused" && !uncertain && !message) return null;
  return (
    <div className="border-b border-border px-3 py-2 text-3xs">
      {retained.kind === "unavailable" ? (
        <p role="alert">
          Pending recovery intent cannot be read. Resume is unavailable until its state is
          recovered.
        </p>
      ) : null}
      {storageFull ? (
        <p>
          Storage limit reached. Retained history stays readable; resume cannot reset storage
          limits.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={uncertain ? heldRequest?.newWindow === true : newWindow}
            disabled={admissionBlocked || pending || uncertain || !canResume}
            onChange={(event) => setNewWindow(event.target.checked)}
          />
          Start a new check window
        </label>
        <Button
          variant="outline"
          size="xs"
          disabled={admissionBlocked || pending || (!uncertain && !canResume)}
          onClick={() => {
            void resume();
          }}
        >
          {pending ? "Resuming…" : uncertain ? "Retry same resume" : "Resume capture"}
        </Button>
      </div>
      <p className="mt-1 text-muted-foreground">
        Leave unchecked to keep the current check count. Storage and lifetime history stay retained.
      </p>
      {message ? (
        <p className="mt-1" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
