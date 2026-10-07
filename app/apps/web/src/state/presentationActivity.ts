import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

/** Presentation demand only: backend execution and command reconciliation are
 * independent of whether this native window can display their results. */
export function isPresentationActive(): boolean {
  return (
    typeof document === "undefined" ||
    (document.visibilityState === "visible" && document.hasFocus())
  );
}

export const PRESENTATION_REFRESH_INTERVAL_MS = 5_000;

/** All mounted recorded reads share one timer and one set of native activity
 * listeners. Every activation invalidates even a recently cached read. */
export const presentationActivityAtom = Atom.make((get) => {
  let active = isPresentationActive();
  let revision = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const publish = () => get.setSelf({ active, revision: ++revision });
  const schedule = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = active ? setInterval(publish, PRESENTATION_REFRESH_INTERVAL_MS) : undefined;
  };
  const track = () => {
    const next = isPresentationActive();
    if (next === active) return;
    active = next;
    schedule();
    publish();
  };
  schedule();
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", track);
  if (typeof window !== "undefined") {
    window.addEventListener("focus", track);
    window.addEventListener("blur", track);
  }
  get.addFinalizer(() => {
    if (timer !== undefined) clearInterval(timer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", track);
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", track);
      window.removeEventListener("blur", track);
    }
  });
  return { active, revision };
}).pipe(Atom.setIdleTTL(0), Atom.withLabel("workbench:presentation-activity"));

export const presentationActiveAtom = Atom.map(presentationActivityAtom, (state) => state.active);
export const usePresentationActive = () => useAtomValue(presentationActiveAtom);

/** Gates automatic/reconnection reads as well as timer refreshes. Never apply
 * this to a command: a pending write must reconcile independently of focus. */
export function presentationRead<A, E, R>(read: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return Effect.suspend(() => (isPresentationActive() ? read : Effect.never));
}

/** Keep the same scope's validated picture while making paused or revalidating
 * reads explicit to existing stale-state views and revision-bearing controls. */
export function retainPresentationFreshness<A, E>(
  source: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
): Atom.Atom<AsyncResult.AsyncResult<A, E | Error>> {
  return Atom.transform(source, (get) => {
    const { active } = get(presentationActivityAtom);
    const result = get(source);
    if (result._tag === "Failure") return result;
    if (active && (!result.waiting || Option.isNone(AsyncResult.value(result)))) return result;
    return AsyncResult.failWithPrevious<A, E | Error>(
      new Error(
        active
          ? "Revalidating the recorded view."
          : "Recorded view refresh is paused while this window is inactive.",
      ),
      { previous: Option.some(result), waiting: result.waiting },
    );
  }).pipe(Atom.setIdleTTL(0));
}
