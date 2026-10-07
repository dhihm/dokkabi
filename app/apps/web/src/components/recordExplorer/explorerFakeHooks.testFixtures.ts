/**
 * Fake implementations of the `~/state/workbenchExplorer` hooks for DOM tests
 * and the isolated render fixture. They answer from a FakeExplorerSource
 * through the SAME pure validation the real query atoms run, keep stable
 * value identity per request key, and track mounted demand so tests can see
 * obsolete requests released. `deferred` holds answers pending until
 * `flush()` to exercise in-flight cancellation.
 */
import { useEffect, useSyncExternalStore } from "react";
import type {
  ProviderWorkbenchGraphExploreResult,
  ProviderWorkbenchRecordIndexResult,
  RecordCompanionVerification,
} from "@t3tools/contracts";

import type { EnvironmentQueryView } from "~/state/query";
import type {
  WorkbenchGraphExploreRequest,
  WorkbenchRecordBodyWindowRequest,
  WorkbenchRecordIndexRequest,
  WorkbenchRecordVerificationRequest,
} from "~/state/workbenchExplorer";
import {
  resolveRecordBodyWindowRead,
  resolveRecordVerification,
  planRecordBodyWindow,
  type RecordBodyWindowReadResult,
} from "./recordBodyWindow";
import type { FakeExplorerSource } from "./explorerFake.testFixtures";

interface Entry {
  view: EnvironmentQueryView<unknown>;
  compute: () => unknown;
  settled: boolean;
}

export interface FakeExplorerHooksControl {
  source: FakeExplorerSource;
  deferred: boolean;
  /** Keys currently mounted by a component. */
  readonly mounted: Map<string, number>;
  /** Keys released (unmounted) while their answer was still pending. */
  readonly cancelled: string[];
  /** Every key ever requested, in order. */
  readonly requested: string[];
  flush(): void;
  /** Recompute every mounted key (a periodic refresh tick). */
  poll(): void;
}

export function makeFakeExplorerHooks(source: FakeExplorerSource) {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let version = 0;
  const emit = () => {
    version += 1;
    for (const listener of listeners) listener();
  };
  const control: FakeExplorerHooksControl = {
    source,
    deferred: false,
    mounted: new Map(),
    cancelled: [],
    requested: [],
    flush: () => {
      for (const [key, entry] of entries) {
        if (!entry.settled && (control.mounted.get(key) ?? 0) > 0) settle(key, entry);
      }
      emit();
    },
    poll: () => {
      // Only the periodically refreshed reads (index, explore) re-run on a
      // tick; pinned ranges and explicit proofs have no periodic trigger.
      for (const [key, entry] of entries) {
        const periodic = key.startsWith("index:") || key.startsWith("explore:");
        if (periodic && (control.mounted.get(key) ?? 0) > 0) settle(key, entry);
      }
      emit();
    },
  };

  const settle = (key: string, entry: Entry) => {
    try {
      const data = entry.compute();
      entry.view = { ...baseView(key), data, isSuccess: true, dataUpdatedAt: Date.now() };
    } catch (error) {
      entry.view = {
        ...baseView(key),
        // A failed refresh keeps the previous value, like the real atom.
        data: entry.view.data,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    entry.settled = true;
  };

  const baseView = (key: string): EnvironmentQueryView<unknown> => ({
    data: null,
    dataUpdatedAt: null,
    error: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {
      const entry = entries.get(key);
      if (entry === undefined) return;
      settle(key, entry);
      emit();
    },
  });

  const EMPTY: EnvironmentQueryView<unknown> = {
    data: null,
    dataUpdatedAt: null,
    error: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  };

  function useFake<A>(kind: string, request: object | null, compute: () => A) {
    // The cache is deliberately mutable outside React; the compiler must not
    // memoize its lookups.
    "use no memo";
    const key = request === null ? null : `${kind}:${JSON.stringify(request)}`;
    useSyncExternalStore(
      (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      () => version,
    );
    useEffect(() => {
      if (key === null) return;
      control.mounted.set(key, (control.mounted.get(key) ?? 0) + 1);
      return () => {
        const count = (control.mounted.get(key) ?? 1) - 1;
        if (count <= 0) {
          control.mounted.delete(key);
          const entry = entries.get(key);
          if (entry !== undefined && !entry.settled) control.cancelled.push(key);
          // idleTtl 0: released demand drops its cached value.
          entries.delete(key);
        } else control.mounted.set(key, count);
      };
    }, [key]);
    if (key === null) return EMPTY as EnvironmentQueryView<A>;
    let entry = entries.get(key);
    if (entry === undefined) {
      control.requested.push(key);
      entry = { view: { ...baseView(key), isPending: true }, compute, settled: false };
      entries.set(key, entry);
      if (!control.deferred) settle(key, entry);
    }
    return entry.view as EnvironmentQueryView<A>;
  }

  const hooks = {
    useWorkbenchRecordIndex: (request: WorkbenchRecordIndexRequest | null) =>
      useFake<ProviderWorkbenchRecordIndexResult>("index", request, () =>
        source.index({
          ...(request?.after !== undefined ? { after: request.after } : {}),
          ...(request?.asOf !== undefined ? { asOf: request.asOf } : {}),
          limit: request?.limit,
        }),
      ),
    useWorkbenchRecordBodyWindow: (request: WorkbenchRecordBodyWindowRequest | null) =>
      useFake<RecordBodyWindowReadResult>("body", request, () => {
        const plan = planRecordBodyWindow(request!.start, request!.expected.byteLength);
        return resolveRecordBodyWindowRead(
          request!,
          source.body({
            row: request!.row,
            asOf: request!.asOf,
            offset: plan.fetchOffset,
            limit: plan.fetchLimit,
            expected: request!.expected,
          }),
        );
      }),
    useWorkbenchRecordVerification: (request: WorkbenchRecordVerificationRequest | null) =>
      useFake<RecordCompanionVerification>("verify", request, () =>
        resolveRecordVerification(request!, source.verify(request!)),
      ),
    useWorkbenchGraphExplore: (request: WorkbenchGraphExploreRequest | null) =>
      useFake<ProviderWorkbenchGraphExploreResult>("explore", request, () =>
        source.explore({
          graphType: request!.graphType,
          query: request!.query,
          ...(request!.snapshot !== undefined ? { snapshot: request!.snapshot } : {}),
        }),
      ),
  };
  return { hooks, control, source };
}
