/**
 * Single external store for the applied presentation state pushed by the
 * desktop host. One subscription per window feeds it (see presentationBoot);
 * every consumer reads from here, so presentation changes never remount the
 * conversation, timeline or composer.
 *
 * All state arrivals — pushes, the initial read, and save/reset/reload
 * receipts — go through one validated, monotonic application function that
 * also maintains the root override layer.
 */
import { useSyncExternalStore } from "react";
import { PresentationAppliedStateSchema, type PresentationAppliedState } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { presentationOverrideLayer } from "./presentationTokens";

const decodeAppliedState = Schema.decodeUnknownSync(PresentationAppliedStateSchema);

let state: PresentationAppliedState | null = null;
let connectionError: string | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) {
    listener();
  }
};

export const presentationStore = {
  get: (): PresentationAppliedState | null => state,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** The last subscription/read failure, surfaced in Settings; null when healthy. */
export const presentationConnectionError = (): string | null => connectionError;

/**
 * Applies a newly observed host state. Setting the same object again is a
 * no-op so repeated observations do not churn subscribers.
 */
export function setPresentationState(next: PresentationAppliedState | null): void {
  if (next === state) return;
  state = next;
  emit();
}

/**
 * The one validated, monotonic application path for arriving host payloads
 * (pushes, initial reads, operation receipts). Invalid payloads are discarded
 * with a visible connection error; a payload older than the applied revision
 * never rolls the window back.
 */
export function applyValidatedPresentationState(payload: unknown): boolean {
  let next: PresentationAppliedState;
  try {
    next = decodeAppliedState(payload);
  } catch (error) {
    connectionError =
      error instanceof Error ? error.message : "received an invalid presentation state";
    emit();
    return false;
  }
  if (state !== null && next.revision < state.revision) {
    return false;
  }
  connectionError = null;
  if (next !== state) {
    state = next;
    presentationOverrideLayer.install(document, next.config.tokens);
  }
  emit();
  return true;
}

/** Clears applied state and the override layer (window teardown). */
export function clearPresentationState(): void {
  presentationOverrideLayer.remove(document);
  if (state !== null || connectionError !== null) {
    state = null;
    connectionError = null;
    emit();
  }
}

/** Records a subscription/read failure without changing the applied state. */
export function setPresentationConnectionError(message: string | null): void {
  if (message === connectionError) return;
  connectionError = message;
  emit();
}

/** Renders with the applied presentation state, or null outside Electron. */
export function usePresentationState(): PresentationAppliedState | null {
  return useSyncExternalStore(presentationStore.subscribe, presentationStore.get, () => null);
}

/** Renders with the current connection diagnostic, or null when healthy. */
export function usePresentationConnectionError(): string | null {
  return useSyncExternalStore(presentationStore.subscribe, presentationConnectionError, () => null);
}
