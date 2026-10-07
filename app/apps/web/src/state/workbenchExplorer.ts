import {
  WS_METHODS,
  type EnvironmentId,
  type ProviderExploreWorkbenchGraphInput,
  type ProviderGetWorkbenchRecordBodyInput,
  type ProviderGetWorkbenchRecordIndexInput,
  type ProviderInstanceId,
  type ProviderVerifyWorkbenchRecordBodyInput,
  type ProviderWorkbenchGraphExploreResult,
  type ProviderWorkbenchRecordBodyResult,
  type ProviderWorkbenchRecordIndexResult,
  type ProviderWorkbenchRecordVerificationResult,
  type RecordCompanionVerification,
  type ThreadId,
  type WorkbenchGraphExploreQueryInput,
  type WorkbenchGraphExploreSnapshot,
  type WorkbenchRecordAsOf,
  type WorkbenchRecordBodyExpected,
  type WorkbenchRecordCursor,
} from "@t3tools/contracts";
import type {
  EnvironmentRegistry,
  EnvironmentSupervisor,
} from "@t3tools/client-runtime/connection";
import { request } from "@t3tools/client-runtime/rpc";
import { createEnvironmentQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import {
  planRecordBodyWindow,
  resolveRecordBodyWindowRead,
  resolveRecordVerification,
  type RecordBodyWindowReadResult,
} from "../components/recordExplorer/recordBodyWindow";
import {
  PRESENTATION_REFRESH_INTERVAL_MS,
  isPresentationActive,
  presentationActiveAtom,
  presentationActivityAtom,
  presentationRead,
  retainPresentationFreshness,
} from "./presentationActivity";
import { useEnvironmentQuery, type EnvironmentQueryView } from "./query";

/**
 * Bounded retained-data explorer reads (record index/body/verify, graph
 * explore) through the authenticated per-environment client and the keyed
 * query lifecycle.
 *
 * - Source isolation: every cache key carries environment + thread + the
 *   actual provider instance AND every cursor, pin, byte window, query and
 *   snapshot. Only the thread id and the closed bounded parameters travel the
 *   wire; the instance is a client-only key input and credentials stay
 *   server-side. Native/child branch ownership is resolved by the server's
 *   existing facade, never by the renderer.
 * - Demand: idleTtlMs 0 — an atom reads only while mounted; the final
 *   unsubscribe interrupts an in-flight read (the transport's disposable-read
 *   AbortSignal releases it), so a selection/query/scope change cancels the
 *   obsolete request instead of queueing it.
 * - Freshness: the index and graph pages follow the shared presentation
 *   activity (five-second revalidation while active, paused while inactive).
 *   A pinned byte range is immutable, so it revalidates only on activation.
 *   Whole-record verification is an explicit one-shot: it never repeats on a
 *   timer or activation and never runs automatically.
 * - Every range is validated and decoded inside the read; a range failing its
 *   local checks is a typed failure, never displayed text.
 * - Record reads (index, body, proof) are also active while the host reports
 *   this scope's ready companion window as the active presentation
 *   (`companionActive`, a client-only key input derived from host state, never
 *   from the child). Such reads share one five-second companion timer; Graph
 *   and the other readers keep the main window's activity gating unchanged.
 *   With every presentation inactive, record reads (including an explicit
 *   proof) do not start.
 */

/** The logical source an explorer read belongs to. */
export interface WorkbenchExplorerSource {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
}

/** Record reads may be kept active by the host-reported active companion. */
export interface WorkbenchRecordDemand {
  readonly companionActive?: boolean | undefined;
}

export interface WorkbenchRecordIndexRequest
  extends WorkbenchExplorerSource, WorkbenchRecordDemand {
  readonly after?: WorkbenchRecordCursor | undefined;
  readonly asOf?: WorkbenchRecordAsOf | undefined;
  readonly limit: number;
}

export interface WorkbenchRecordBodyWindowRequest
  extends WorkbenchExplorerSource, WorkbenchRecordDemand {
  readonly row: WorkbenchRecordCursor;
  readonly asOf: WorkbenchRecordAsOf;
  readonly expected: WorkbenchRecordBodyExpected;
  /** Requested window start; the read plans one bounded overlapped range. */
  readonly start: number;
}

export interface WorkbenchRecordVerificationRequest
  extends WorkbenchExplorerSource, WorkbenchRecordDemand {
  readonly row: WorkbenchRecordCursor;
  readonly asOf: WorkbenchRecordAsOf;
  readonly expected: WorkbenchRecordBodyExpected;
  /** Explicit request identity: a new click is a new one-shot proof. */
  readonly nonce: number;
}

export interface WorkbenchGraphExploreRequest extends WorkbenchExplorerSource {
  readonly graphType: "work" | "context";
  readonly query: WorkbenchGraphExploreQueryInput;
  readonly snapshot?: WorkbenchGraphExploreSnapshot | undefined;
}

/** The four bounded wire reads (injected so the lifecycle is testable). */
export interface WorkbenchExplorerSend<E, R = never, EB = E, EV = E, EX = E> {
  readonly index: (
    payload: ProviderGetWorkbenchRecordIndexInput,
  ) => Effect.Effect<ProviderWorkbenchRecordIndexResult, E, R>;
  readonly body: (
    payload: ProviderGetWorkbenchRecordBodyInput,
  ) => Effect.Effect<ProviderWorkbenchRecordBodyResult, EB, R>;
  readonly verify: (
    payload: ProviderVerifyWorkbenchRecordBodyInput,
  ) => Effect.Effect<ProviderWorkbenchRecordVerificationResult, EV, R>;
  readonly explore: (
    payload: ProviderExploreWorkbenchGraphInput,
  ) => Effect.Effect<ProviderWorkbenchGraphExploreResult, EX, R>;
}

/** A body range that failed its local integrity checks (never displayed). */
export class WorkbenchRecordBodyRefused extends Data.TaggedError("WorkbenchRecordBodyRefused")<{
  readonly message: string;
}> {}

/**
 * The single companion refresh timer: mounted only by record reads that the
 * active companion keeps alive; the final subscriber clears it.
 */
const companionRefreshAtom = Atom.make((get) => {
  const owner = get(presentationActivityAtom);
  if (owner.active) return owner;
  let revision = owner.revision;
  const timer = setInterval(
    () => get.setSelf({ active: true, revision: ++revision }),
    PRESENTATION_REFRESH_INTERVAL_MS,
  );
  get.addFinalizer(() => clearInterval(timer));
  return { active: true, revision };
}).pipe(Atom.setIdleTTL(0), Atom.withLabel("workbench:record-companion-refresh"));

/** Record demand: the main presentation OR the host-reported active companion. */
function recordRead<A, E, R>(
  companionActive: boolean,
  read: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return companionActive ? read : presentationRead(read);
}

/** An explicit proof starts only while some presentation of it is active. */
function recordProofRead<A, E, R>(
  companionActive: boolean,
  read: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.suspend(() => (companionActive || isPresentationActive() ? read : Effect.never));
}

/** Client-only cache identity of the source (never sent). */
function sourceKey(source: WorkbenchExplorerSource): string | null {
  return source.providerInstanceId === undefined || source.providerInstanceId === null
    ? null
    : String(source.providerInstanceId);
}

export function createWorkbenchExplorerReads<R, ER, E, EB, EV, EX>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
  send: WorkbenchExplorerSend<E, R | EnvironmentSupervisor, EB, EV, EX>,
) {
  const indexRead = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:provider:workbench-record-index",
    execute: (input: {
      readonly threadId: ThreadId;
      readonly after?: WorkbenchRecordCursor | undefined;
      readonly asOf?: WorkbenchRecordAsOf | undefined;
      readonly limit: number;
      readonly companionActive: boolean;
      readonly sourceKey: string | null;
    }) =>
      recordRead(
        input.companionActive,
        send.index({
          threadId: input.threadId,
          ...(input.after !== undefined ? { after: input.after } : {}),
          ...(input.asOf !== undefined ? { asOf: input.asOf } : {}),
          limit: input.limit,
        }),
      ),
    staleTimeMs: 5_000,
    refreshTrigger: (target) =>
      target.input.companionActive ? companionRefreshAtom : presentationActivityAtom,
    idleTtlMs: 0,
  });

  const bodyRead = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:provider:workbench-record-body",
    execute: (input: {
      readonly threadId: ThreadId;
      readonly row: WorkbenchRecordCursor;
      readonly asOf: WorkbenchRecordAsOf;
      readonly expected: WorkbenchRecordBodyExpected;
      readonly start: number;
      readonly companionActive: boolean;
      readonly sourceKey: string | null;
    }) => {
      const plan = planRecordBodyWindow(input.start, input.expected.byteLength);
      return recordRead(
        input.companionActive,
        send
          .body({
            threadId: input.threadId,
            row: input.row,
            asOf: input.asOf,
            offset: plan.fetchOffset,
            limit: plan.fetchLimit,
            expected: input.expected,
          })
          .pipe(
            Effect.flatMap((result) =>
              Effect.try({
                try: (): RecordBodyWindowReadResult => resolveRecordBodyWindowRead(input, result),
                catch: (cause) =>
                  new WorkbenchRecordBodyRefused({
                    message: cause instanceof Error ? cause.message : String(cause),
                  }),
              }),
            ),
          ),
      );
    },
    // An immutable pinned range: revalidate on activation only.
    staleTimeMs: 60_000,
    refreshTrigger: () => presentationActiveAtom,
    idleTtlMs: 0,
  });

  const verifyRead = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:provider:workbench-record-verify",
    execute: (input: {
      readonly threadId: ThreadId;
      readonly row: WorkbenchRecordCursor;
      readonly asOf: WorkbenchRecordAsOf;
      readonly expected: WorkbenchRecordBodyExpected;
      readonly nonce: number;
      readonly companionActive: boolean;
      readonly sourceKey: string | null;
    }) =>
      recordProofRead(
        input.companionActive,
        send
          .verify({
            threadId: input.threadId,
            row: input.row,
            asOf: input.asOf,
            expected: input.expected,
          })
          .pipe(
            Effect.map((result): RecordCompanionVerification =>
              resolveRecordVerification(input, result),
            ),
          ),
      ),
    // Explicit one-shot proof: no timer, no activation repeat.
    staleTimeMs: 24 * 60 * 60_000,
    idleTtlMs: 0,
  });

  const exploreRead = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:provider:workbench-graph-explore",
    execute: (input: {
      readonly threadId: ThreadId;
      readonly graphType: "work" | "context";
      readonly query: WorkbenchGraphExploreQueryInput;
      readonly snapshot?: WorkbenchGraphExploreSnapshot | undefined;
      readonly sourceKey: string | null;
    }) =>
      presentationRead(
        send.explore({
          threadId: input.threadId,
          graphType: input.graphType,
          query: input.query,
          ...(input.snapshot !== undefined ? { snapshot: input.snapshot } : {}),
        }),
      ),
    staleTimeMs: 5_000,
    refreshTrigger: () => presentationActivityAtom,
    idleTtlMs: 0,
  });

  const indexPresentation = Atom.family((atom: ReturnType<typeof indexRead>) =>
    retainPresentationFreshness(atom),
  );
  // An active child is a live Record presentation even while the owner is
  // blurred. Keep revalidation explicit without the owner's paused label.
  const companionIndexPresentation = Atom.family((atom: ReturnType<typeof indexRead>) =>
    Atom.transform(atom, (get) => {
      const result = get(atom);
      if (
        result._tag === "Failure" ||
        !result.waiting ||
        Option.isNone(AsyncResult.value(result))
      ) {
        return result;
      }
      return AsyncResult.failWithPrevious(new Error("Revalidating the recorded view."), {
        previous: Option.some(result),
        waiting: result.waiting,
      });
    }).pipe(Atom.setIdleTTL(0)),
  );
  const explorePresentation = Atom.family((atom: ReturnType<typeof exploreRead>) =>
    retainPresentationFreshness(atom),
  );

  return {
    indexAtom: (request: WorkbenchRecordIndexRequest) => {
      const atom = indexRead({
        environmentId: request.environmentId,
        input: {
          threadId: request.threadId,
          ...(request.after !== undefined ? { after: request.after } : {}),
          ...(request.asOf !== undefined ? { asOf: request.asOf } : {}),
          limit: request.limit,
          companionActive: request.companionActive === true,
          sourceKey: sourceKey(request),
        },
      });
      return request.companionActive === true
        ? companionIndexPresentation(atom)
        : indexPresentation(atom);
    },
    bodyAtom: (request: WorkbenchRecordBodyWindowRequest) =>
      bodyRead({
        environmentId: request.environmentId,
        input: {
          threadId: request.threadId,
          row: request.row,
          asOf: request.asOf,
          expected: request.expected,
          start: request.start,
          companionActive: request.companionActive === true,
          sourceKey: sourceKey(request),
        },
      }),
    verifyAtom: (request: WorkbenchRecordVerificationRequest) =>
      verifyRead({
        environmentId: request.environmentId,
        input: {
          threadId: request.threadId,
          row: request.row,
          asOf: request.asOf,
          expected: request.expected,
          nonce: request.nonce,
          companionActive: request.companionActive === true,
          sourceKey: sourceKey(request),
        },
      }),
    exploreAtom: (request: WorkbenchGraphExploreRequest) =>
      explorePresentation(
        exploreRead({
          environmentId: request.environmentId,
          input: {
            threadId: request.threadId,
            graphType: request.graphType,
            query: request.query,
            ...(request.snapshot !== undefined ? { snapshot: request.snapshot } : {}),
            sourceKey: sourceKey(request),
          },
        }),
      ),
  };
}

const reads = createWorkbenchExplorerReads(connectionAtomRuntime, {
  index: (payload) => request(WS_METHODS.providerGetWorkbenchRecordIndex, payload),
  body: (payload) => request(WS_METHODS.providerGetWorkbenchRecordBody, payload),
  verify: (payload) => request(WS_METHODS.providerVerifyWorkbenchRecordBody, payload),
  explore: (payload) => request(WS_METHODS.providerExploreWorkbenchGraph, payload),
});

export function useWorkbenchRecordIndex(
  input: WorkbenchRecordIndexRequest | null,
): EnvironmentQueryView<ProviderWorkbenchRecordIndexResult> {
  return useEnvironmentQuery(input === null ? null : reads.indexAtom(input));
}

export function useWorkbenchRecordBodyWindow(
  input: WorkbenchRecordBodyWindowRequest | null,
): EnvironmentQueryView<RecordBodyWindowReadResult> {
  return useEnvironmentQuery(input === null ? null : reads.bodyAtom(input));
}

export function useWorkbenchRecordVerification(
  input: WorkbenchRecordVerificationRequest | null,
): EnvironmentQueryView<RecordCompanionVerification> {
  return useEnvironmentQuery(input === null ? null : reads.verifyAtom(input));
}

export function useWorkbenchGraphExplore(
  input: WorkbenchGraphExploreRequest | null,
): EnvironmentQueryView<ProviderWorkbenchGraphExploreResult> {
  return useEnvironmentQuery(input === null ? null : reads.exploreAtom(input));
}
