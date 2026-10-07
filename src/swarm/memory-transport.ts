import { canonicalJson } from "../host/canonical.ts";
import { BlobStore } from "../host/blob-store.ts";
import type { EventLog } from "../host/event-log.ts";
import { projectSessionReplaySchemas, type EventRecord } from "../host/schema.ts";
import {
  assertSwarmDispatchContract,
  dispatchContractDigest,
  type SwarmDispatchContractV2,
} from "./contract.ts";
import {
  assertSwarmMemoryProviderId,
  MAX_SWARM_MEMORY_SELECTED_IDS,
  validateSwarmMemoryViewV1,
  type SwarmMemoryViewV1,
} from "./memory-view.ts";

const DIGEST = /^[a-f0-9]{64}$/u;

export interface SwarmMemoryBindingV1 {
  readonly childSession: string;
  readonly viewDigest: string;
  readonly repositoryDigest: string;
  readonly sourceSnapshotDigest: string;
  readonly blobDigest: string;
  readonly dispatchDigest: string;
}

export interface SwarmMemoryViewReferenceV1 {
  readonly view_digest: string;
  readonly repository_digest: string;
  readonly source_snapshot_digest: string;
  readonly section_count: number;
  readonly sufficiency: "sufficient" | "insufficient";
  readonly providers: readonly SwarmMemoryProviderReferenceV1[];
}

export interface SwarmMemoryProviderReferenceV1 {
  readonly provider_id: string;
  readonly source_revision_digest: string;
  readonly selection_count: number;
}

export type SwarmMemoryVerificationStatus = "ok" | "missing" | "mismatch";

/** Digest-only replay evidence for one parent-to-child memory transport. */
export interface SwarmMemoryTransportReferenceV1 {
  readonly child_session: string;
  readonly view_digest: string;
  readonly blob_digest: string;
  readonly dispatch_digest: string;
  readonly status: SwarmMemoryVerificationStatus;
}

export function appendSwarmMemoryView(log: EventLog, view: SwarmMemoryViewV1): void {
  validateSwarmMemoryViewV1(view);
  BlobStore.forSession(log.path).putAndAppend(log, {
    kind: "observe",
    name: "swarm/memory_view",
    payload: publicViewPayload(view),
  }, canonicalJson(view));
}

/** Copy already recorded canonical bytes into a child's private session blob
 * store. The parent records the intent before the filesystem write and the
 * result afterward; no path or body enters either event. */
export function stageSwarmMemoryView(input: {
  readonly log: EventLog;
  readonly childSession: string;
  readonly childStore: BlobStore;
  readonly view: SwarmMemoryViewV1;
}): { readonly blobDigest: string } {
  validateSwarmMemoryViewV1(input.view);
  const recorded = recordedView(input.log, input.view.digest);
  const body = BlobStore.forSession(input.log.path).get(requiredDigest(recorded.payload.blob, "memory blob"));
  const parsed = parseView(body);
  if (parsed.digest !== input.view.digest || canonicalJson(parsed) !== canonicalJson(input.view)) {
    throw new Error("recorded swarm memory view does not match the staged view");
  }
  const parentBlobDigest = requiredDigest(recorded.payload.blob, "memory blob");
  const dispatch = recordedV2Dispatch(input.log.events, input.childSession, input.view);
  if (recorded.seq >= dispatch.event.seq) {
    throw new Error("swarm memory view must precede its V2 dispatch");
  }
  if (input.log.events.some((event) =>
    (event.name === "swarm/memory_stage" || event.name === "swarm/memory_staged") &&
    event.payload.child_session === input.childSession
  )) {
    throw new Error("swarm memory transport may only be staged once per child");
  }
  input.log.append({
    kind: "effect",
    name: "swarm/memory_stage",
    payload: {
      child_session: requiredText(input.childSession, "child session"),
      view_digest: input.view.digest,
      blob_digest: parentBlobDigest,
      dispatch_digest: dispatch.digest,
    },
  });
  const blobDigest = input.childStore.put(body);
  if (blobDigest !== parentBlobDigest) {
    throw new Error("staged swarm memory blob digest mismatch");
  }
  input.log.append({
    kind: "observe",
    name: "swarm/memory_staged",
    payload: {
      child_session: input.childSession,
      view_digest: input.view.digest,
      blob_digest: blobDigest,
      dispatch_digest: dispatch.digest,
    },
  });
  return { blobDigest };
}

/** Seal the host's bounded verdict about the child's staged memory binding.
 * Missing is also valid when world creation prevented a spawn; ok/mismatch
 * always describe a child that was actually spawned. */
export function appendSwarmMemoryVerified(log: EventLog, input: {
  readonly childSession: string;
  readonly viewDigest: string;
  readonly blobDigest: string;
  readonly dispatchDigest: string;
  readonly status: SwarmMemoryVerificationStatus;
}): EventRecord {
  const child = requiredText(input.childSession, "child session");
  const viewDigest = requiredDigest(input.viewDigest, "memory view");
  const blobDigest = requiredDigest(input.blobDigest, "memory blob");
  const dispatchDigest = requiredDigest(input.dispatchDigest, "dispatch");
  if (input.status !== "ok" && input.status !== "missing" && input.status !== "mismatch") {
    throw new Error("swarm memory verification status is invalid");
  }
  const dispatch = recordedV2DispatchByDigest(log.events, child, viewDigest, dispatchDigest);
  const stage = singleEvent(log.events, "swarm/memory_stage", child);
  const staged = singleEvent(log.events, "swarm/memory_staged", child);
  assertMemoryTransferEvent(stage, "swarm/memory_stage", "effect", {
    child,
    viewDigest,
    blobDigest,
    dispatchDigest,
  });
  assertMemoryTransferEvent(staged, "swarm/memory_staged", "observe", {
    child,
    viewDigest,
    blobDigest,
    dispatchDigest,
  });
  if (!(dispatch.event.seq < stage.seq && stage.seq < staged.seq)) {
    throw new Error("swarm memory stage/staged event order is invalid");
  }
  const spawns = log.events.filter((event) =>
    event.name === "swarm/spawn" && event.payload.child_session === child
  );
  if (spawns.length > 1) throw new Error("swarm memory transport has duplicate spawns");
  if (input.status !== "missing" && spawns.length !== 1) {
    throw new Error(`swarm memory verification ${input.status} requires a preceding spawn`);
  }
  if (spawns[0]) {
    assertExactPayload(spawns[0], ["child_session", "role", "route"], "swarm spawn");
    if (spawns[0].kind !== "effect" || spawns[0].payload.role !== dispatch.contract.role ||
      spawns[0].payload.route !== dispatch.contract.route || spawns[0].seq <= staged.seq) {
      throw new Error("swarm memory spawn order or dispatch binding is invalid");
    }
  }
  if (log.events.some((event) =>
    event.name === "swarm/memory_verified" && event.payload.child_session === child
  )) {
    throw new Error("swarm memory transport may only be verified once per child");
  }
  return log.append({
    kind: "observe",
    name: "swarm/memory_verified",
    payload: {
      child_session: child,
      view_digest: viewDigest,
      blob_digest: blobDigest,
      dispatch_digest: dispatchDigest,
      status: input.status,
    },
  });
}

export function appendSwarmMemoryBound(log: EventLog, input: {
  readonly childSession: string;
  readonly view: SwarmMemoryViewV1;
  readonly blobDigest: string;
  readonly dispatchDigest: string;
}): EventRecord {
  validateSwarmMemoryViewV1(input.view);
  requiredDigest(input.blobDigest, "memory blob");
  requiredDigest(input.dispatchDigest, "dispatch");
  requiredText(input.childSession, "child session");
  const store = BlobStore.forSession(log.path);
  const body = store.get(input.blobDigest);
  const parsed = parseView(body);
  if (canonicalJson(parsed) !== canonicalJson(input.view)) {
    throw new Error("bound swarm memory bytes do not match the declared view");
  }
  return log.append({
    kind: "observe",
    name: "swarm/memory_bound",
    payload: {
      ...publicViewPayload(input.view),
      child_session: input.childSession,
      dispatch_digest: input.dispatchDigest,
      blob: input.blobDigest,
      blob_bytes: Buffer.byteLength(body),
    },
  });
}

export function readBoundSwarmMemoryView(log: EventLog, expected: SwarmMemoryBindingV1): SwarmMemoryViewV1 {
  requiredText(expected.childSession, "child session");
  for (const [key, value] of Object.entries(expected)) {
    if (key !== "childSession") requiredDigest(value, "memory binding");
  }
  const matches = log.events.filter((event) => event.name === "swarm/memory_bound");
  if (matches.length !== 1) {
    throw new Error("child requires exactly one swarm memory binding");
  }
  const event = matches[0]!;
  if (event.payload.child_session !== expected.childSession ||
    event.payload.view_digest !== expected.viewDigest ||
    event.payload.repository_digest !== expected.repositoryDigest ||
    event.payload.source_snapshot_digest !== expected.sourceSnapshotDigest ||
    event.payload.blob !== expected.blobDigest ||
    event.payload.dispatch_digest !== expected.dispatchDigest) {
    throw new Error("child swarm memory binding mismatch");
  }
  const view = parseView(BlobStore.forSession(log.path).get(expected.blobDigest));
  if (view.digest !== expected.viewDigest ||
    view.repositoryDigest !== expected.repositoryDigest ||
    view.sourceSnapshotDigest !== expected.sourceSnapshotDigest ||
    event.payload.section_count !== view.sections.length ||
    event.payload.sufficiency !== view.sufficiency) {
    throw new Error("child swarm memory view does not match its binding");
  }
  return view;
}

export function renderSwarmMemoryView(view: SwarmMemoryViewV1): string {
  validateSwarmMemoryViewV1(view);
  return [
    `[swarm memory view; read-only evidence; sufficiency=${view.sufficiency}; digest=${view.digest.slice(0, 12)}]`,
    ...view.sections.flatMap((section) => [
      `## ${section.providerId} (${section.sufficiency}; evidence=${section.evidenceDigests.length})`,
      section.content,
    ]),
  ].join("\n");
}

export function projectSwarmMemoryViewReferences(
  events: readonly EventRecord[],
): SwarmMemoryViewReferenceV1[] {
  const references: SwarmMemoryViewReferenceV1[] = [];
  for (const event of events) {
    if (event.name !== "swarm/memory_view") continue;
    const allowed = [
      "blob",
      "blob_bytes",
      "format",
      "providers",
      "repository_digest",
      "section_count",
      "source_snapshot_digest",
      "sufficiency",
      "view_digest",
    ].sort();
    const actual = Object.keys(event.payload).sort();
    if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
      throw new Error("swarm memory view event has unknown or missing fields");
    }
    if (event.payload.format !== 1) throw new Error("swarm memory view event format is invalid");
    const viewDigest = requiredDigest(event.payload.view_digest, "memory view");
    const repositoryDigest = requiredDigest(event.payload.repository_digest, "memory repository");
    const sourceSnapshotDigest = requiredDigest(event.payload.source_snapshot_digest, "memory source snapshot");
    requiredDigest(event.payload.blob, "memory blob");
    const sectionCount = event.payload.section_count;
    if (!Number.isSafeInteger(sectionCount) || Number(sectionCount) < 0 || Number(sectionCount) > 8) {
      throw new Error("swarm memory section count is invalid");
    }
    const blobBytes = event.payload.blob_bytes;
    if (!Number.isSafeInteger(blobBytes) || Number(blobBytes) < 1 || Number(blobBytes) > 32_000) {
      throw new Error("swarm memory blob byte count is invalid");
    }
    const sufficiency = event.payload.sufficiency;
    if (sufficiency !== "sufficient" && sufficiency !== "insufficient") {
      throw new Error("swarm memory sufficiency is invalid");
    }
    const providers = projectProviderReferences(event.payload.providers, Number(sectionCount));
    references.push({
      view_digest: viewDigest,
      repository_digest: repositoryDigest,
      source_snapshot_digest: sourceSnapshotDigest,
      section_count: Number(sectionCount),
      sufficiency,
      providers,
    });
  }
  return references;
}

/** Validate and project the complete parent-side V2 transport lifecycle. No
 * blob or mutable external state is read here. */
export function projectSwarmMemoryTransportReferences(
  events: readonly EventRecord[],
): SwarmMemoryTransportReferenceV1[] {
  return projectSwarmMemoryTransports(events);
}

/** Validate one child while sibling dispatches may still be in flight. */
export function projectSwarmMemoryTransportReferenceForChild(
  events: readonly EventRecord[],
  childSession: string,
): SwarmMemoryTransportReferenceV1 {
  const child = requiredText(childSession, "child session");
  const references = projectSwarmMemoryTransports(events, child);
  if (references.length !== 1) {
    throw new Error(`swarm memory transport requires exactly one V2 dispatch for ${child}`);
  }
  return references[0]!;
}

function projectSwarmMemoryTransports(
  events: readonly EventRecord[],
  onlyChild?: string,
): SwarmMemoryTransportReferenceV1[] {
  const views = projectSwarmMemoryViewReferences(events);
  const viewByDigest = new Map(views.map((view) => [view.view_digest, view]));
  const references: SwarmMemoryTransportReferenceV1[] = [];
  const claimed = new Set<number>();

  for (const dispatchEvent of events) {
    if (dispatchEvent.name !== "swarm/dispatch") continue;
    assertSwarmDispatchContract(dispatchEvent.payload.contract);
    const contract = dispatchEvent.payload.contract;
    if (contract.format !== 2) continue;
    if (onlyChild !== undefined && dispatchEvent.payload.child_session !== onlyChild) continue;
    assertDispatchEventPayload(dispatchEvent);
    const child = requiredText(dispatchEvent.payload.child_session, "dispatch child session");
    const digest = dispatchContractDigest(contract);
    if (dispatchEvent.kind !== "effect" || dispatchEvent.payload.contract_digest !== digest) {
      throw new Error("swarm memory dispatch digest or kind is invalid");
    }
    const view = viewByDigest.get(contract.memoryViewDigest);
    const viewEvents = events.filter((event) =>
      event.name === "swarm/memory_view" && event.payload.view_digest === contract.memoryViewDigest
    );
    const viewEvent = viewEvents[0];
    if (!view || viewEvents.length !== 1 || !viewEvent || view.repository_digest !== contract.repositoryDigest ||
      viewEvent.seq >= contract.parentOpenSeq || viewEvent.seq >= dispatchEvent.seq) {
      throw new Error("swarm memory view and dispatch order or binding is invalid");
    }
    const blobDigest = requiredDigest(viewEvent.payload.blob, "memory blob");
    const expected = {
      child,
      viewDigest: contract.memoryViewDigest,
      blobDigest,
      dispatchDigest: digest,
    };
    const stage = singleEvent(events, "swarm/memory_stage", child);
    const staged = singleEvent(events, "swarm/memory_staged", child);
    const verified = singleEvent(events, "swarm/memory_verified", child);
    assertMemoryTransferEvent(stage, "swarm/memory_stage", "effect", expected);
    assertMemoryTransferEvent(staged, "swarm/memory_staged", "observe", expected);
    assertMemoryVerifiedEvent(verified, expected);
    if (!(dispatchEvent.seq < stage.seq && stage.seq < staged.seq && staged.seq < verified.seq)) {
      throw new Error("swarm memory transport order is invalid");
    }
    const spawns = events.filter((event) =>
      event.name === "swarm/spawn" && event.payload.child_session === child
    );
    if (spawns.length > 1) throw new Error("swarm memory transport has duplicate spawns");
    const status = verified.payload.status as SwarmMemoryVerificationStatus;
    if (status !== "missing" && spawns.length !== 1) {
      throw new Error(`swarm memory verification ${status} requires a preceding spawn`);
    }
    if (spawns[0]) {
      assertExactPayload(spawns[0], ["child_session", "role", "route"], "swarm spawn");
      if (spawns[0].kind !== "effect" || spawns[0].payload.role !== contract.role ||
        spawns[0].payload.route !== contract.route ||
        !(staged.seq < spawns[0].seq && spawns[0].seq < verified.seq)) {
        throw new Error("swarm memory spawn order or dispatch binding is invalid");
      }
    }
    const results = events.filter((event) =>
      event.name === "swarm/result" && event.payload.child_session === child
    );
    if (results.length > 1) throw new Error("swarm memory transport has duplicate child results");
    if (results[0]) {
      if (results[0].seq <= verified.seq) throw new Error("swarm memory verification must precede child result");
      const envelope = results[0].payload.envelope;
      const completed = typeof envelope === "object" && envelope !== null && !Array.isArray(envelope) &&
        (envelope as Record<string, unknown>).status === "completed";
      if (completed && status !== "ok") {
        throw new Error("completed swarm child requires an ok memory verification");
      }
    }
    const closes = events.filter((event) =>
      event.name === "swarm/child_close" && event.payload.child_session === child
    );
    if (closes.some((event) => event.payload.status === "completed" && status !== "ok")) {
      throw new Error("completed swarm child requires an ok memory verification");
    }
    for (const event of [stage, staged, verified]) claimed.add(event.seq);
    references.push({
      child_session: child,
      view_digest: contract.memoryViewDigest,
      blob_digest: blobDigest,
      dispatch_digest: digest,
      status,
    });
  }

  for (const event of events) {
    if ((event.name === "swarm/memory_stage" || event.name === "swarm/memory_staged" ||
      event.name === "swarm/memory_verified") &&
      (onlyChild === undefined || event.payload.child_session === onlyChild) && !claimed.has(event.seq)) {
      throw new Error(`orphan or duplicate ${event.name} event`);
    }
  }
  return references;
}

/** Preflight the recorded blob and its unsigned view digest without exposing
 * the body to the replay contract. */
export function validateRecordedSwarmMemoryViews(log: Pick<EventLog, "path" | "events">, suppliedStore?: BlobStore): void {
  projectSwarmMemoryViewReferences(log.events);
  const store = suppliedStore ?? BlobStore.forSession(log.path);
  for (const event of log.events) {
    if (event.name !== "swarm/memory_view") continue;
    const blob = requiredDigest(event.payload.blob, "memory blob");
    const view = parseView(store.get(blob));
    if (view.digest !== event.payload.view_digest ||
      view.repositoryDigest !== event.payload.repository_digest ||
      view.sourceSnapshotDigest !== event.payload.source_snapshot_digest ||
      view.sections.length !== event.payload.section_count ||
      view.sufficiency !== event.payload.sufficiency ||
      canonicalJson(event.payload.providers) !== canonicalJson(publicProviderReferences(view))) {
      throw new Error("recorded swarm memory view payload mismatch");
    }
  }
}

/** Content-aware child preflight. The replay contract itself intentionally
 * remains a projection and never opens this blob. */
export function validateRecordedSwarmMemoryBindings(log: Pick<EventLog, "path" | "events">, suppliedStore?: BlobStore): void {
  const bindings = log.events.filter((event) => event.name === "swarm/memory_bound");
  const capabilities = log.events.filter((event) => event.name === "swarm/capability_bound");
  if (bindings.length === 0 && capabilities.length === 0) {
    if (requiresSwarmMemoryBinding(log.events)) {
      throw new Error("modern swarm child requires capability and memory bindings");
    }
    return;
  }
  if (bindings.length !== 1) throw new Error("child requires exactly one swarm memory binding");
  if (capabilities.length !== 1) throw new Error("child requires exactly one swarm capability binding");
  const binding = bindings[0]!;
  const capability = capabilities[0]!;
  assertExactPayload(capability, [
    "child_session",
    "plugin_manifest_digest",
    "tool_schema_digest",
  ], "swarm capability binding");
  if (capability.kind !== "observe") throw new Error("swarm capability binding kind is invalid");
  const child = requiredText(capability.payload.child_session, "capability child session");
  const manifest = requiredDigest(capability.payload.plugin_manifest_digest, "capability plugin manifest");
  requiredDigest(capability.payload.tool_schema_digest, "capability tool schema");
  assertExactPayload(binding, [
    "blob",
    "blob_bytes",
    "child_session",
    "dispatch_digest",
    "format",
    "providers",
    "repository_digest",
    "section_count",
    "source_snapshot_digest",
    "sufficiency",
    "view_digest",
  ], "swarm memory binding");
  if (binding.kind !== "observe" || binding.payload.format !== 1) {
    throw new Error("swarm memory binding kind or format is invalid");
  }
  if (binding.payload.child_session !== child) throw new Error("swarm memory child binding mismatch");
  const blob = requiredDigest(binding.payload.blob, "memory blob");
  const dispatchDigest = requiredDigest(binding.payload.dispatch_digest, "memory dispatch");
  const opened = log.events.find((event) =>
    event.name === "session/open" && event.payload.session_id === child
  );
  const parent = log.events.find((event) =>
    event.name === "session/parent" && event.payload.child_session === child
  );
  const firstUser = log.events.find((event) => event.name === "user/message");
  if (!opened || opened.payload.plugin_manifest_digest !== manifest || !parent ||
    parent.payload.contract_digest !== dispatchDigest || !firstUser ||
    !(opened.seq < parent.seq && parent.seq < capability.seq && capability.seq < binding.seq &&
      binding.seq < firstUser.seq)) {
    throw new Error("swarm child capability or memory binding order/dispatch mismatch");
  }
  const body = (suppliedStore ?? BlobStore.forSession(log.path)).get(blob);
  if (binding.payload.blob_bytes !== Buffer.byteLength(body)) {
    throw new Error("swarm memory binding blob byte count mismatch");
  }
  const view = parseView(body);
  if (binding.payload.view_digest !== view.digest ||
    binding.payload.repository_digest !== view.repositoryDigest ||
    binding.payload.source_snapshot_digest !== view.sourceSnapshotDigest ||
    binding.payload.section_count !== view.sections.length ||
    binding.payload.sufficiency !== view.sufficiency ||
    canonicalJson(binding.payload.providers) !== canonicalJson(publicProviderReferences(view))) {
    throw new Error("swarm memory binding does not match its blob content");
  }
}

function requiresSwarmMemoryBinding(events: readonly EventRecord[]): boolean {
  const parent = events.find((event) => event.name === "session/parent");
  if (!parent) return false;
  const featureStart = projectSessionReplaySchemas(events).featureStart.get("swarm-memory-v1");
  return featureStart !== undefined && parent.seq > featureStart;
}

function recordedView(log: EventLog, digest: string): EventRecord {
  const matches = log.events.filter((event) =>
    event.name === "swarm/memory_view" && event.payload.view_digest === digest
  );
  if (matches.length !== 1) throw new Error("swarm memory view must be recorded exactly once before staging");
  return matches[0]!;
}

function recordedV2Dispatch(
  events: readonly EventRecord[],
  child: string,
  view: SwarmMemoryViewV1,
): { readonly event: EventRecord; readonly contract: SwarmDispatchContractV2; readonly digest: string } {
  const matches = events.filter((event) =>
    event.name === "swarm/dispatch" && event.payload.child_session === child
  );
  if (matches.length !== 1) throw new Error("staged swarm memory requires exactly one child dispatch");
  const event = matches[0]!;
  assertDispatchEventPayload(event);
  assertSwarmDispatchContract(event.payload.contract);
  const contract = event.payload.contract;
  if (event.kind !== "effect" || contract.format !== 2 ||
    contract.memoryViewDigest !== view.digest || contract.repositoryDigest !== view.repositoryDigest) {
    throw new Error("staged swarm memory does not match its V2 dispatch");
  }
  const digest = dispatchContractDigest(contract);
  if (event.payload.contract_digest !== digest) throw new Error("staged swarm memory dispatch digest mismatch");
  return { event, contract, digest };
}

function recordedV2DispatchByDigest(
  events: readonly EventRecord[],
  child: string,
  viewDigest: string,
  expectedDigest: string,
): { readonly event: EventRecord; readonly contract: SwarmDispatchContractV2; readonly digest: string } {
  const matches = events.filter((event) =>
    event.name === "swarm/dispatch" && event.payload.child_session === child
  );
  if (matches.length !== 1) throw new Error("verified swarm memory requires exactly one child dispatch");
  const event = matches[0]!;
  assertDispatchEventPayload(event);
  assertSwarmDispatchContract(event.payload.contract);
  const contract = event.payload.contract;
  const digest = dispatchContractDigest(contract);
  if (event.kind !== "effect" || contract.format !== 2 || contract.memoryViewDigest !== viewDigest ||
    digest !== expectedDigest || event.payload.contract_digest !== digest) {
    throw new Error("verified swarm memory does not match its V2 dispatch");
  }
  return { event, contract, digest };
}

function singleEvent(
  events: readonly EventRecord[],
  name: string,
  child: string,
): EventRecord {
  const matches = events.filter((event) =>
    event.name === name && event.payload.child_session === child
  );
  if (matches.length !== 1) throw new Error(`${name} requires exactly one event for ${child}`);
  return matches[0]!;
}

function assertMemoryTransferEvent(
  event: EventRecord,
  name: "swarm/memory_stage" | "swarm/memory_staged",
  kind: "effect" | "observe",
  expected: {
    readonly child: string;
    readonly viewDigest: string;
    readonly blobDigest: string;
    readonly dispatchDigest: string;
  },
): void {
  assertExactPayload(event, [
    "blob_digest",
    "child_session",
    "dispatch_digest",
    "view_digest",
  ], name.replace("swarm/", "swarm "));
  if (event.kind !== kind) throw new Error(`${name} kind is invalid`);
  if (event.payload.child_session !== expected.child ||
    event.payload.view_digest !== expected.viewDigest ||
    event.payload.blob_digest !== expected.blobDigest ||
    event.payload.dispatch_digest !== expected.dispatchDigest) {
    throw new Error(`${name} binding digest or child mismatch`);
  }
}

function assertMemoryVerifiedEvent(
  event: EventRecord,
  expected: {
    readonly child: string;
    readonly viewDigest: string;
    readonly blobDigest: string;
    readonly dispatchDigest: string;
  },
): void {
  assertExactPayload(event, [
    "blob_digest",
    "child_session",
    "dispatch_digest",
    "status",
    "view_digest",
  ], "swarm memory verified");
  if (event.kind !== "observe") throw new Error("swarm memory verified kind is invalid");
  const status = event.payload.status;
  if (status !== "ok" && status !== "missing" && status !== "mismatch") {
    throw new Error("swarm memory verification status is invalid");
  }
  if (event.payload.child_session !== expected.child ||
    event.payload.view_digest !== expected.viewDigest ||
    event.payload.blob_digest !== expected.blobDigest ||
    event.payload.dispatch_digest !== expected.dispatchDigest) {
    throw new Error("swarm memory verified binding digest or child mismatch");
  }
}

function assertExactPayload(event: EventRecord, keys: readonly string[], label: string): void {
  const actual = Object.keys(event.payload).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} event has unknown or missing fields`);
  }
}

function assertDispatchEventPayload(event: EventRecord): void {
  const hasWorldFact = event.payload.world_fact !== undefined || event.payload.world_fact_digest !== undefined;
  assertExactPayload(event, hasWorldFact
    ? [
        "capability_profile",
        "child_session",
        "contract",
        "contract_digest",
        "world_fact",
        "world_fact_digest",
      ]
    : ["capability_profile", "child_session", "contract", "contract_digest"], "swarm dispatch");
}

function publicViewPayload(view: SwarmMemoryViewV1): Record<string, unknown> {
  return {
    format: 1,
    view_digest: view.digest,
    repository_digest: view.repositoryDigest,
    source_snapshot_digest: view.sourceSnapshotDigest,
    section_count: view.sections.length,
    sufficiency: view.sufficiency,
    providers: publicProviderReferences(view),
  };
}

function publicProviderReferences(view: SwarmMemoryViewV1): SwarmMemoryProviderReferenceV1[] {
  return view.sections.map((section) => ({
    provider_id: section.providerId,
    source_revision_digest: section.sourceRevisionDigest,
    selection_count: section.selectedIds.length,
  }));
}

function projectProviderReferences(value: unknown, sectionCount: number): SwarmMemoryProviderReferenceV1[] {
  if (!Array.isArray(value) || value.length !== sectionCount) {
    throw new Error("swarm memory provider references do not match the section count");
  }
  const seen = new Set<string>();
  return value.map((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error("swarm memory provider reference is invalid");
    }
    const reference = raw as Record<string, unknown>;
    const actual = Object.keys(reference).sort();
    const expected = ["provider_id", "selection_count", "source_revision_digest"];
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
      throw new Error("swarm memory provider reference has unknown or missing fields");
    }
    assertSwarmMemoryProviderId(reference.provider_id);
    const providerId = String(reference.provider_id);
    if (seen.has(providerId)) throw new Error(`duplicate swarm memory provider ${providerId}`);
    seen.add(providerId);
    const revision = requiredDigest(reference.source_revision_digest, "memory provider source revision");
    if (!Number.isSafeInteger(reference.selection_count) || Number(reference.selection_count) < 0 ||
      Number(reference.selection_count) > MAX_SWARM_MEMORY_SELECTED_IDS) {
      throw new Error("swarm memory provider selection count is invalid");
    }
    return {
      provider_id: providerId,
      source_revision_digest: revision,
      selection_count: Number(reference.selection_count),
    };
  });
}

function parseView(body: string): SwarmMemoryViewV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("swarm memory blob is not valid JSON");
  }
  validateSwarmMemoryViewV1(parsed);
  return parsed;
}

function requiredDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new Error(`${label} digest is invalid`);
  }
  return value;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is invalid`);
  return value;
}
