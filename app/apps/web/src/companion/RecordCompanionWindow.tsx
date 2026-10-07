/**
 * Restricted Record companion window (Dokkabi R6 / R5-04).
 *
 * The one component the dedicated companion entry boots. It never mounts
 * AppRoot, the router, ChatView, authentication, providers, the queued
 * message sender or a browser host — the restricted preload exposes exactly
 * `window.recordCompanion` (bootstrap/ready/quiesce/requestDock/viewAction
 * plus pushed events) and the shell denies every network egress.
 *
 * Handshake protocol (transaction semantics per the canonical design):
 * 1. bootstrap() returns the OPENING frozen tuple; the child stays inert and
 *    acknowledges it with ready() — the original Opening tuple, exactly.
 * 2. `activated` makes the child the interactive placement; a bounded
 *    bootstrap refetch supplies the current machine revision for a later
 *    requestDock (bare events carry no revision).
 * 3. `docking` makes the child inert again; a bounded bootstrap refetch
 *    supplies the CURRENT frozen docking tuple (descriptor/view/presentation
 *    frozen at requestDock, not at open) and quiesce() acknowledges it. The
 *    child closes only after the owner committed the dock (`closed`).
 *
 * The child is a pure projection: it renders relayed snapshots (never its own
 * query) and expresses only the CLOSED action vocabulary against the
 * displayed snapshot's view revision. It carries no credential, no endpoint,
 * no arbitrary after/asOf/path and no model input.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DockIcon } from "lucide-react";
import type {
  RecordCompanionBootstrap,
  RecordCompanionBridge,
  RecordCompanionHandoff,
  RecordCompanionSnapshot,
  RecordCompanionViewAction,
  RecordCompanionViewPreferences,
} from "@t3tools/contracts";

import { presentationOverrideLayer } from "../presentationTokens";
import { Button } from "../components/ui/button";
import { RecordCompanionView } from "../components/recordCompanion/RecordCompanionView";
import type { DecisionRecordPanelState } from "../components/chat/DecisionRecordSurface.logic";

declare global {
  interface Window {
    readonly recordCompanion?: RecordCompanionBridge;
  }
}

type CompanionPhase =
  | { readonly kind: "bootstrapping" }
  | { readonly kind: "handshake" }
  | { readonly kind: "active" }
  | { readonly kind: "docking" }
  | { readonly kind: "closed" }
  | { readonly kind: "failed"; readonly message: string };

/** Runtime guard for the bootstrap receipt's handshake fields. */
function validHandshake(
  bootstrap: RecordCompanionBootstrap,
): { revision: number; handoff: RecordCompanionHandoff } | null {
  if (
    !Number.isInteger(bootstrap.revision) ||
    bootstrap.revision < 0 ||
    typeof bootstrap.handoff !== "object" ||
    bootstrap.handoff === null ||
    !Number.isInteger(bootstrap.handoff.descriptorRevision) ||
    !Number.isInteger(bootstrap.handoff.viewRevision) ||
    !Number.isInteger(bootstrap.handoff.presentationRevision)
  ) {
    return null;
  }
  return { revision: bootstrap.revision, handoff: bootstrap.handoff };
}

/** Map the relayed snapshot result onto the R5 panel state (pure projection). */
export function panelOfSnapshot(
  snapshot: RecordCompanionSnapshot | null,
): DecisionRecordPanelState {
  if (snapshot === null) return { kind: "pending" };
  const result = snapshot.result;
  switch (result.status) {
    case "pending":
      return { kind: "pending" };
    case "view":
      return { kind: "view", page: result.record, staleError: result.staleError };
    case "explorer":
      return {
        kind: "explorer",
        index: result.index,
        staleError: result.staleError,
        body: result.body,
        verification: result.verification,
      };
    case "unavailable":
      return { kind: "unavailable", reason: result.reason };
    case "unsupported":
      return { kind: "unsupported", reason: result.reason };
  }
}

function PhaseMessage({
  title,
  detail,
  tone = "muted",
}: {
  readonly title: string;
  readonly detail?: string | undefined;
  readonly tone?: "muted" | "warning";
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {detail ? (
        <p
          className={
            tone === "warning"
              ? "max-w-[46ch] text-xs text-warning-foreground"
              : "max-w-[46ch] text-xs text-muted-foreground"
          }
        >
          {detail}
        </p>
      ) : null}
    </div>
  );
}

export function RecordCompanionWindow() {
  const bridge = typeof window !== "undefined" ? window.recordCompanion : undefined;
  const [phase, setPhase] = useState<CompanionPhase>(() =>
    bridge === undefined
      ? { kind: "failed", message: "This window has no record companion bridge." }
      : { kind: "bootstrapping" },
  );
  const [bootstrap, setBootstrap] = useState<RecordCompanionBootstrap | null>(null);
  const [snapshot, setSnapshot] = useState<RecordCompanionSnapshot | null>(null);
  // The machine revision learned from the activation-time bootstrap refetch;
  // requestDock must carry it (bare events carry no revision).
  const dockRevisionRef = useRef<number | null>(null);
  // ready() acknowledges exactly once per companion: the machine refuses a
  // second ready, and a dev double-mount must not turn into a failure.
  const readySentRef = useRef<string | null>(null);

  useEffect(() => {
    if (bridge === undefined) {
      return;
    }
    let disposed = false;
    void bridge
      .bootstrap()
      .then((receipt) => {
        if (disposed) return;
        setBootstrap(receipt);
        const handshake = validHandshake(receipt);
        if (handshake === null) {
          // Without the exact frozen tuple the child cannot acknowledge the
          // transaction; it stays inert and lets the opening time out.
          setPhase({
            kind: "failed",
            message: "The host handshake is unavailable; refusing to acknowledge the handoff.",
          });
          return;
        }
        if (readySentRef.current !== receipt.companionId) {
          readySentRef.current = receipt.companionId;
          void bridge
            .ready({
              companionId: receipt.companionId,
              revision: handshake.revision,
              handoff: handshake.handoff,
            })
            .then(() => {
              if (!disposed)
                setPhase((current) =>
                  current.kind === "bootstrapping" ? { kind: "handshake" } : current,
                );
            })
            .catch((error: unknown) => {
              if (disposed) return;
              setPhase({
                kind: "failed",
                message: error instanceof Error ? error.message : String(error),
              });
            });
        } else {
          setPhase({ kind: "handshake" });
        }
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setPhase({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      disposed = true;
    };
  }, [bridge]);

  useEffect(() => {
    if (bridge === undefined) return;
    return bridge.onEvent((event) => {
      if (event.type === "snapshot") {
        setSnapshot(event.snapshot);
        return;
      }
      if (event.type === "activated") {
        setPhase((current) =>
          current.kind === "closed" || current.kind === "failed" ? current : { kind: "active" },
        );
        // Bounded refetch: the CURRENT machine revision for a later dock
        // request. Failure is non-fatal — the dock control refetches.
        void bridge
          .bootstrap()
          .then((receipt) => {
            if (Number.isInteger(receipt.revision)) {
              dockRevisionRef.current = receipt.revision;
            }
          })
          .catch(() => undefined);
        return;
      }
      if (event.type === "docking") {
        // The docking event only marks the phase; the quiesce acknowledgement
        // dispatches from a layout effect AFTER the inert render committed —
        // a setState is an intention, not a committed-DOM receipt.
        setPhase((current) =>
          current.kind === "closed" || current.kind === "failed" ? current : { kind: "docking" },
        );
        return;
      }
      setPhase({ kind: "closed" });
    });
  }, [bridge]);

  // The dock acknowledgement: only after the inert docking view committed do
  // we refetch the bounded bootstrap (CURRENT machine revision + the frozen
  // docking tuple) and quiesce. No revision arithmetic, no fixed delays.
  const docking = phase.kind === "docking";
  useLayoutEffect(() => {
    if (!docking || bridge === undefined) return;
    let cancelled = false;
    void bridge
      .bootstrap()
      .then((receipt) => {
        if (cancelled) return;
        const handshake = validHandshake(receipt);
        if (handshake === null) return undefined;
        return bridge.quiesce({
          companionId: receipt.companionId,
          revision: handshake.revision,
          handoff: handshake.handoff,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPhase({
          kind: "failed",
          message: `Dock could not be acknowledged: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [docking, bridge]);

  // The resolved theme/tokens of the latest snapshot own this window's paint;
  // invalid or absent values keep the last valid layer.
  useEffect(() => {
    if (snapshot === null) return;
    document.documentElement.classList.toggle("dark", snapshot.theme.dark);
    presentationOverrideLayer.install(document, snapshot.tokens);
  }, [snapshot]);

  const requestDock = useCallback(() => {
    if (bridge === undefined || bootstrap === null) return;
    const send = (revision: number) => {
      void bridge.requestDock({ companionId: bootstrap.companionId, revision }).catch(() => {
        // A refused dock keeps the interactive placement; the next attempt
        // refetches the revision.
        dockRevisionRef.current = null;
      });
    };
    const known = dockRevisionRef.current;
    if (known !== null) {
      send(known);
      return;
    }
    void bridge
      .bootstrap()
      .then((receipt) => {
        if (Number.isInteger(receipt.revision)) {
          dockRevisionRef.current = receipt.revision;
          send(receipt.revision);
        }
      })
      .catch(() => undefined);
  }, [bridge, bootstrap]);

  const dispatchAction = useCallback(
    (action: RecordCompanionViewAction) => {
      if (bridge === undefined || snapshot === null || phase.kind !== "active") return;
      // The action applies to the displayed snapshot's exact view revision.
      void bridge.viewAction({
        companionId: snapshot.companionId,
        viewRevision: snapshot.viewRevision,
        action,
      });
    },
    [bridge, snapshot, phase],
  );

  if (phase.kind === "failed") {
    return (
      <div data-record-companion-window="failed">
        <PhaseMessage title="Record companion unavailable" detail={phase.message} tone="warning" />
      </div>
    );
  }
  if (phase.kind === "closed") {
    return (
      <div data-record-companion-window="closed">
        <PhaseMessage title="The record view docked back." detail="This window closes now." />
      </div>
    );
  }
  const view: RecordCompanionViewPreferences = snapshot?.view ??
    bootstrap?.view ?? {
      tab: "record",
      pin: null,
      after: null,
      selectedSeq: null,
    };
  const interactive = phase.kind === "active";
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-record-companion-window={phase.kind}
      data-record-companion-id={bootstrap?.companionId ?? ""}
    >
      {phase.kind === "docking" ? (
        <div
          className="border-b border-border bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
          data-companion-docking-guidance="true"
        >
          Docking waits for the original Record panel of this source in the main window. Reopen that
          panel to finish docking; closing this window instead keeps the record closed.
        </div>
      ) : null}
      <RecordCompanionView
        state={panelOfSnapshot(snapshot)}
        view={view}
        interactive={interactive}
        onAction={dispatchAction}
        sourceLabel={snapshot?.sourceLabel ?? bootstrap?.sourceLabel ?? ""}
        headerExtra={
          <span className="flex items-center gap-1">
            {phase.kind === "handshake" ? (
              <span className="text-3xs text-muted-foreground" data-companion-preparing="true">
                preparing…
              </span>
            ) : null}
            {phase.kind === "docking" ? (
              <span className="text-3xs text-muted-foreground" data-companion-docking="true">
                docking…
              </span>
            ) : null}
            {interactive ? (
              <Button variant="ghost" size="xs" data-companion-dock="true" onClick={requestDock}>
                <DockIcon className="size-3.5" aria-hidden="true" />
                Dock
              </Button>
            ) : null}
          </span>
        }
      />
    </div>
  );
}
