import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import * as Layer from "effect/Layer";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import fixture from "../components/chat/codeEvolution/retained.fixture.json";
import { codeIndexFeed } from "./workbenchCode";
import type { CodeSessionCursor, ProviderWorkbenchCodeResult } from "@t3tools/contracts";

it.live("acknowledges only settled pages and keeps one pull in flight", () =>
  Effect.gen(function* () {
    let active = 0;
    let maximum = 0;
    const seen: Array<CodeSessionCursor | undefined> = [];
    const read = (after?: CodeSessionCursor) =>
      Effect.gen(function* () {
        seen.push(after);
        active++;
        maximum = Math.max(maximum, active);
        yield* Effect.yieldNow;
        active--;
        return { status: "available", code: fixture } as ProviderWorkbenchCodeResult;
      });
    const result = yield* Stream.runCollect(codeIndexFeed(read).pipe(Stream.take(3)));
    expect(result.length).toBe(3);
    expect(maximum).toBe(1);
    expect(seen).toEqual([undefined, fixture.sessionCursor, fixture.sessionCursor]);
  }),
);
it.live("interrupts a pending read without issuing another acknowledgement", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let calls = 0;
    let stopped = false;
    const reader = yield* Stream.runDrain(
      codeIndexFeed(() =>
        Effect.gen(function* () {
          calls++;
          yield* Deferred.succeed(entered, undefined);
          return yield* Effect.never;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              stopped = true;
            }),
          ),
        ),
      ),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(reader);
    expect(calls).toBe(1);
    expect(stopped).toBe(true);
  }),
);
it.live("ends unavailable feeds instead of spinning against a detached owner", () =>
  Effect.gen(function* () {
    let calls = 0;
    const result = yield* Stream.runCollect(
      codeIndexFeed(() =>
        Effect.sync(() => {
          calls++;
          return { status: "unavailable", reason: "Detached" } as const;
        }),
      ),
    );
    expect(calls).toBe(1);
    expect(result[0]?.status).toBe("unavailable");
  }),
);

it.live("zero-TTL visible reader disposal interrupts the actual atom stream", () =>
  Effect.gen(function* () {
    const registry = yield* Effect.acquireRelease(
      Effect.sync(() => AtomRegistry.make()),
      (registry) => Effect.sync(() => registry.dispose()),
    );
    const entered = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    let calls = 0;
    const atom = Atom.runtime(Layer.empty)
      .atom(
        codeIndexFeed(() =>
          Effect.gen(function* () {
            calls++;
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }).pipe(Effect.ensuring(Deferred.succeed(stopped, undefined))),
        ),
      )
      .pipe(Atom.setIdleTTL(0));
    const unmount = registry.mount(atom);
    yield* Deferred.await(entered);
    unmount();
    yield* Deferred.await(stopped);
    expect(calls).toBe(1);
  }).pipe(Effect.scoped),
);
