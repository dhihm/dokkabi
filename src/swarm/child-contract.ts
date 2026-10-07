import { readEvidenceBodies } from "../work/evidence/bodies.ts";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { deriveMessages } from "../host/derive-messages.ts";
import { BlobStore } from "../host/blob-store.ts";
import { EventLog } from "../host/event-log.ts";
import { sessionLogPath } from "../host/paths.ts";
import { replayContract, replayDigest } from "../host/replay.ts";
import type { EventRecord, Missing } from "../host/schema.ts";
import { planDigest as digestPlan } from "../work/digest.ts";
import { loadWorkPlan } from "../work/load.ts";
import type { SwarmRole } from "./routes.ts";
import {
  assertSwarmCapabilityProfile,
  type SwarmCapabilityProfileV1,
} from "./contract.ts";
import {
  readBoundSwarmMemoryView,
  validateRecordedSwarmMemoryBindings,
  type SwarmMemoryBindingV1,
} from "./memory-transport.ts";

export interface ChildContractEvidence {
  sessionId: string;
  replayDigest: string;
  finalHash: string;
  evidenceDigest: string;
  graphRev: number;
  planDigest: string | Missing;
  summaryDigest: string;
  dispatchDigest: string | Missing;
  repositoryDigest: string | Missing;
  memoryViewDigest: string | Missing;
}

export interface ChildContractRequest {
  sessionId: string;
  parentSession: string;
  parentOpenSeq: number;
  role: SwarmRole;
  route: string;
  dispatchDigest?: string;
  operatorOrderDigest?: string;
  workspaceRoot?: string;
  planPath?: string;
  /** Host-known private log path. Modern dispatch collection never resolves
   * through the parent's process-global DOKKABI_HOME. */
  eventLogPath?: string;
  memoryBinding?: SwarmMemoryBindingV1;
  capabilityProfile?: SwarmCapabilityProfileV1;
}

export interface ChildDispatchBinding {
  sessionId: string;
  parentSession: string;
  parentOpenSeq: number;
  role: SwarmRole;
  route: string;
  dispatchDigest: string;
  operatorOrderDigest: string;
}

export type ChildMemoryVerificationStatus = "ok" | "missing" | "mismatch";

const HEX = /^[a-f0-9]{64}$/;

export function inspectChildMemoryBinding(input: {
  readonly eventLogPath: string;
  readonly binding: SwarmMemoryBindingV1;
  readonly parentSession: string;
  readonly parentOpenSeq: number;
  readonly role: SwarmRole;
  readonly route: string;
}): ChildMemoryVerificationStatus {
  if (!isAbsolute(input.eventLogPath) || !existsSync(input.eventLogPath)) return "missing";
  let log: EventLog;
  try {
    log = new EventLog(resolve(input.eventLogPath));
  } catch {
    return "mismatch";
  }
  const bindings = log.events.filter((event) => event.name === "swarm/memory_bound");
  if (bindings.length === 0) return "missing";
  if (bindings.length !== 1) return "mismatch";
  if (!BlobStore.forSession(log.path).has(input.binding.blobDigest)) return "missing";
  try {
    validateRecordedSwarmMemoryBindings(log);
    readBoundSwarmMemoryView(log, input.binding);
  } catch {
    return "mismatch";
  }
  const opened = log.events.find((event) =>
    event.name === "session/open" && event.payload.session_id === input.binding.childSession
  );
  const parents = log.events.filter((event) => event.name === "session/parent");
  const parent = parents[0];
  const firstUser = log.events.find((event) => event.name === "user/message");
  const binding = bindings[0]!;
  if (!opened || parents.length !== 1 || !parent ||
    parent.payload.parent_session !== input.parentSession ||
    parent.payload.parent_open_seq !== input.parentOpenSeq ||
    parent.payload.child_session !== input.binding.childSession ||
    parent.payload.role !== input.role || parent.payload.route !== input.route ||
    parent.payload.contract_digest !== input.binding.dispatchDigest ||
    binding.seq <= opened.seq || binding.seq <= parent.seq ||
    (firstUser !== undefined && binding.seq >= firstUser.seq)) return "mismatch";
  return "ok";
}

export function validateChildDispatchBinding(
  events: readonly EventRecord[],
  expected: ChildDispatchBinding,
): void {
  const bindings = events.filter((event) => event.name === "session/parent");
  if (bindings.length !== 1) {
    throw new Error(`child dispatch requires exactly one session/parent binding for ${expected.sessionId}`);
  }
  const binding = bindings[0]!;
  if (
    binding.payload.parent_session !== expected.parentSession ||
    binding.payload.parent_open_seq !== expected.parentOpenSeq ||
    binding.payload.child_session !== expected.sessionId ||
    binding.payload.role !== expected.role ||
    binding.payload.route !== expected.route
  ) {
    throw new Error(`child EventLog lineage mismatch for ${expected.sessionId}`);
  }
  if (binding.payload.contract_digest !== expected.dispatchDigest) {
    throw new Error(`child dispatch digest mismatch for ${expected.sessionId}`);
  }
  const firstOrder = events.find((event) =>
    event.name === "user/message" && typeof event.payload.text === "string"
  );
  if (!firstOrder || firstOrder.seq <= binding.seq) {
    throw new Error(`child operator order is missing or precedes lineage for ${expected.sessionId}`);
  }
  const actualOrderDigest = createHash("sha256").update(String(firstOrder.payload.text)).digest("hex");
  if (actualOrderDigest !== expected.operatorOrderDigest) {
    throw new Error(`child operator order digest mismatch for ${expected.sessionId}`);
  }
}

function sealedPlanDigest(
  events: readonly EventRecord[],
  workspaceRoot?: string,
  planPath = "work/current.json",
): string | Missing {
  const recorded = [...events].reverse().find((event) =>
    event.name === "work/goal" && typeof event.payload.digest === "string" && HEX.test(event.payload.digest)
  )?.payload.digest;
  if (typeof recorded !== "string") return "missing";
  if (!workspaceRoot) return recorded;
  const path = isAbsolute(planPath) ? planPath : resolve(workspaceRoot, planPath);
  if (!existsSync(path)) throw new Error("child sealed plan file is missing");
  const loaded = loadWorkPlan(path);
  if (loaded.errors.length > 0) {
    throw new Error(`child sealed plan is invalid: ${loaded.errors.join("; ")}`);
  }
  if (digestPlan(loaded.plan) !== recorded) {
    throw new Error("child sealed plan digest does not match the EventLog");
  }
  return recorded;
}

export function collectChildContract(input: ChildContractRequest): ChildContractEvidence {
  const { sessionId } = input;
  if (input.dispatchDigest !== undefined && !input.eventLogPath) {
    throw new Error(`child dispatch collection requires an explicit private EventLog path for ${sessionId}`);
  }
  const path = input.eventLogPath === undefined
    ? sessionLogPath(sessionId)
    : (() => {
        if (!isAbsolute(input.eventLogPath!)) throw new Error("child EventLog path must be absolute");
        return resolve(input.eventLogPath!);
      })();
  if (!existsSync(path)) throw new Error(`missing child EventLog for ${sessionId}`);
  const log = new EventLog(path);
  const opened = log.events.find((event) =>
    event.name === "session/open" && event.payload.session_id === sessionId
  );
  if (!opened) throw new Error(`child EventLog identity mismatch for ${sessionId}`);
  const parent = log.events.find((event) => event.name === "session/parent" &&
    event.payload.parent_session === input.parentSession && event.payload.parent_open_seq === input.parentOpenSeq &&
    event.payload.child_session === sessionId && event.payload.role === input.role && event.payload.route === input.route);
  if (!parent) throw new Error(`child EventLog lineage mismatch for ${sessionId}`);
  if (input.dispatchDigest !== undefined || input.operatorOrderDigest !== undefined) {
    if (!input.dispatchDigest || !HEX.test(input.dispatchDigest) || !input.operatorOrderDigest ||
      !HEX.test(input.operatorOrderDigest)) {
      throw new Error(`child dispatch binding is incomplete for ${sessionId}`);
    }
    validateChildDispatchBinding(log.events, {
      sessionId,
      parentSession: input.parentSession,
      parentOpenSeq: input.parentOpenSeq,
      role: input.role,
      route: input.route,
      dispatchDigest: input.dispatchDigest,
      operatorOrderDigest: input.operatorOrderDigest,
    });
    if (!input.memoryBinding || !input.capabilityProfile) {
      throw new Error(`child dispatch evidence is missing memory or capability binding for ${sessionId}`);
    }
    if (input.memoryBinding.childSession !== sessionId) {
      throw new Error(`child memory binding session mismatch for ${sessionId}`);
    }
    validateRecordedSwarmMemoryBindings(log);
    const memory = readBoundSwarmMemoryView(log, input.memoryBinding);
    const memoryEvent = log.events.find((event) => event.name === "swarm/memory_bound");
    const parentEvent = log.events.find((event) => event.name === "session/parent");
    const firstUser = log.events.find((event) => event.name === "user/message");
    if (!memoryEvent || !parentEvent || !firstUser || memoryEvent.seq <= parentEvent.seq || memoryEvent.seq >= firstUser.seq) {
      throw new Error(`child memory binding must precede the first operator order for ${sessionId}`);
    }
    if (memory.digest !== input.memoryBinding.viewDigest ||
      memory.repositoryDigest !== input.memoryBinding.repositoryDigest) {
      throw new Error(`child memory evidence mismatch for ${sessionId}`);
    }
    validateChildCapabilityBinding(log.events, sessionId, input.capabilityProfile, firstUser.seq);
  }
  const contract = replayContract(log.events, readEvidenceBodies(log));
  if (contract.manifestDigest === "missing") {
    throw new Error(`child EventLog has no manifest digest for ${sessionId}`);
  }
  const planDigest = sealedPlanDigest(log.events, input.workspaceRoot, input.planPath);
  if (input.dispatchDigest && planDigest === "missing") {
    throw new Error(`child EventLog has no sealed plan digest for ${sessionId}`);
  }
  const summary = [...deriveMessages(log.events)].reverse()
    .find((message) => message.role === "assistant")?.text ?? "";
  return {
    sessionId,
    replayDigest: replayDigest(contract),
    finalHash: log.lastHash,
    evidenceDigest: contract.evidenceDigest,
    graphRev: contract.graphRev,
    planDigest,
    summaryDigest: createHash("sha256").update(summary).digest("hex"),
    dispatchDigest: input.dispatchDigest ?? "missing",
    repositoryDigest: input.memoryBinding?.repositoryDigest ?? "missing",
    memoryViewDigest: input.memoryBinding?.viewDigest ?? "missing",
  };
}

function validateChildCapabilityBinding(
  events: readonly EventRecord[],
  sessionId: string,
  expected: SwarmCapabilityProfileV1,
  firstUserSeq: number,
): void {
  assertSwarmCapabilityProfile(expected);
  const matches = events.filter((event) => event.name === "swarm/capability_bound");
  if (matches.length !== 1) throw new Error(`child requires exactly one capability binding for ${sessionId}`);
  const event = matches[0]!;
  if (event.payload.child_session !== sessionId ||
    event.payload.plugin_manifest_digest !== expected.pluginManifestDigest ||
    event.payload.tool_schema_digest !== expected.toolSchemaDigest) {
    throw new Error(`child capability binding mismatch for ${sessionId}`);
  }
  const opened = events.find((candidate) =>
    candidate.name === "session/open" && candidate.payload.session_id === sessionId
  );
  if (!opened || opened.payload.plugin_manifest_digest !== expected.pluginManifestDigest ||
    event.seq <= opened.seq || event.seq >= firstUserSeq) {
    throw new Error(`child capability binding order mismatch for ${sessionId}`);
  }
}
