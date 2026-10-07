/**
 * Presentation host boot for the renderer.
 *
 * One window-owned subscription, not one per component mount: refcounted
 * acquire/release keeps the subscription alive across React StrictMode
 * double-mounts and hot reloads. Each successful host registration is paired
 * with exactly one unsubscribe — a release arriving before its own subscribe
 * receipt defers the unsubscribe to that receipt, so a stale generation can
 * never decrement a newer registration even if the host failed to count.
 * The push listener is registered before the initial state request; pushes,
 * initial reads and receipts all flow through the one validated monotonic
 * application path in the store. Presentation changes rewrite one removable
 * root override layer; conversation, timeline and composer components are
 * never keyed or remounted by them.
 */
import { useEffect } from "react";

import { isElectron } from "./env";
import {
  applyValidatedPresentationState,
  clearPresentationState,
  presentationStore,
  setPresentationConnectionError,
  usePresentationConnectionError,
} from "./presentationStore";
import { installPresentationWindowDiagnostics } from "./presentationLayoutSnapshot";

interface PresentationBridgeMethods {
  readonly subscribe: () => Promise<unknown>;
  readonly unsubscribe: () => Promise<void>;
}

type PushListener = (state: unknown) => void;

interface Registration {
  /** Whether this registration's subscribe call resolved successfully. */
  settled: boolean;
  /** Set when the last owner released before the receipt arrived. */
  releaseRequested: boolean;
  /** Exactly-once guard for the paired unsubscribe. */
  cleanedUp: boolean;
}

let ownerCount = 0;
let activeSession: {
  readonly bridge: PresentationBridgeMethods;
  readonly registration: Registration;
} | null = null;
let stopActivePush: (() => void) | null = null;

const cleanupRegistrationOnce = (
  bridge: PresentationBridgeMethods,
  registration: Registration,
): void => {
  if (registration.cleanedUp || !registration.settled) return;
  registration.cleanedUp = true;
  void bridge.unsubscribe().catch(() => undefined);
};

function startSession(
  bridge: PresentationBridgeMethods,
  onState: (listener: PushListener) => () => void,
): void {
  const registration: Registration = {
    settled: false,
    releaseRequested: false,
    cleanedUp: false,
  };
  activeSession = { bridge, registration };

  // Register the push listener before requesting state: a push that races
  // the initial read must land, not vanish.
  stopActivePush = onState((payload) => {
    applyValidatedPresentationState(payload);
  });

  bridge
    .subscribe()
    .then(
      (state) => {
        registration.settled = true;
        const stillActive = activeSession?.registration === registration;
        if (!stillActive) {
          // A newer session owns the window; balance this registration
          // exactly once. (The store's monotonic gate also makes the stale
          // state harmless, but do not even store it.)
          cleanupRegistrationOnce(bridge, registration);
          return;
        }
        const applied = applyValidatedPresentationState(state);
        // Only a successfully applied payload clears the connection
        // diagnostic: an invalid initial payload keeps its visible error.
        if (applied) {
          setPresentationConnectionError(null);
        }
        if (registration.releaseRequested && ownerCount === 0) {
          endSession();
        }
      },
      (error: unknown) => {
        // A rejected subscribe never registered: nothing to balance, and no
        // other registration may be decremented.
        if (activeSession?.registration !== registration) return;
        setPresentationConnectionError(
          `Could not read the initial presentation state: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        if (registration.releaseRequested && ownerCount === 0) {
          endSession();
        }
      },
    )
    .catch(() => undefined);
}

function endSession(): void {
  const session = activeSession;
  if (session === null) return;
  activeSession = null;
  stopActivePush?.();
  stopActivePush = null;
  // If the registration was successful and not yet balanced, balance it now;
  // otherwise its own receipt continuation will.
  if (session.registration.settled) {
    cleanupRegistrationOnce(session.bridge, session.registration);
  } else {
    session.registration.releaseRequested = true;
  }
  clearPresentationState();
}

function acquirePresentationSubscription(): void {
  ownerCount += 1;
  if (activeSession !== null) return;
  const bridge = window.desktopBridge?.presentation;
  const onPresentationState = window.desktopBridge?.onPresentationState;
  if (bridge === undefined || onPresentationState === undefined) return;
  startSession(bridge, onPresentationState);
}

function releasePresentationSubscription(): void {
  ownerCount = Math.max(0, ownerCount - 1);
  if (ownerCount > 0) return;
  endSession();
}

/**
 * Operator retry for a failed initial read (Settings "Retry connection"):
 * performs one transient register → validated read → unsubscribe round trip
 * on the live bridge without disturbing any owned session. Only a successful
 * registration is balanced: a rejected subscribe never registered, and its
 * unsubscribe would decrement the healthy owner's host registration.
 */
export async function retryPresentationConnection(): Promise<void> {
  const bridge = window.desktopBridge?.presentation;
  if (bridge === undefined) return;
  let registered = false;
  try {
    const state = await bridge.subscribe();
    registered = true;
    const applied = applyValidatedPresentationState(state);
    if (applied) {
      setPresentationConnectionError(null);
    }
  } catch (error) {
    setPresentationConnectionError(
      `Could not read the presentation state: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    if (registered) {
      try {
        await bridge.unsubscribe();
      } catch {
        // The host balances by counting; a failed unsubscribe here is benign.
      }
    }
  }
}

export function usePresentationSubscription(): void {
  useEffect(() => {
    if (!isElectron) return;
    installPresentationWindowDiagnostics(window);
    acquirePresentationSubscription();
    return () => {
      releasePresentationSubscription();
    };
  }, []);
}

/** Read-only access for diagnostics: the store's current state. */
export const currentPresentationState = presentationStore.get;

/**
 * Renders the visible connection diagnostic (the store's connection-error
 * channel), so read/push failures surface as operator-visible UI rather
 * than console output only. Diagnostics-only helper; the Settings screen
 * renders the same channel with its retry control.
 */
export function ConnectionErrorReporter() {
  const error = usePresentationConnectionError();
  if (error === null) return null;
  return <p role="alert">{error}</p>;
}

/** Root-level sync component; mounts the single window subscription. */
export function PresentationSync() {
  usePresentationSubscription();
  return null;
}
