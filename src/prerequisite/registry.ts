import { z } from "zod";
import type { EventLog } from "../host/event-log.ts";
import type { PluginDisposer } from "../loader/types.ts";

const IdentifierSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/u);
const ReasonCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/u);
const StatusSchema = z.enum(["ready", "waiting_operator", "unavailable"]);

export type PrerequisiteStatus = z.infer<typeof StatusSchema>;

export interface PrerequisiteSnapshot {
  readonly id: string;
  readonly owner: string;
  readonly reasonCode: string;
  readonly status: PrerequisiteStatus;
}

export interface PrerequisiteRegistry {
  register(id: string, owner: string): PluginDisposer;
  update(id: string, status: PrerequisiteStatus, reasonCode: string): PrerequisiteSnapshot;
  get(id: string): PrerequisiteSnapshot | undefined;
  list(): readonly PrerequisiteSnapshot[];
  requireReady(ids: readonly string[]): readonly PrerequisiteSnapshot[];
}

export class PrerequisiteBlockedError extends Error {
  readonly name = "PrerequisiteBlockedError";

  constructor(readonly blockers: readonly string[]) {
    super(`prerequisite not ready: ${blockers.join(", ")}`);
  }
}

export function createPrerequisiteRegistry(log: EventLog): PrerequisiteRegistry {
  const owners = new Map<string, string>();
  const recovered = recover(log);
  const states = new Map<string, PrerequisiteSnapshot>();

  return {
    register(id, owner) {
      const validId = IdentifierSchema.parse(id);
      const validOwner = IdentifierSchema.parse(owner);
      const existing = owners.get(validId);
      if (existing) throw new Error(`prerequisite ${validId} already owned by ${existing}`);
      owners.set(validId, validOwner);
      const prior = recovered.get(validId);
      if (prior) states.set(validId, { ...prior, owner: validOwner });
      return () => {
        if (owners.get(validId) !== validOwner) return;
        owners.delete(validId);
        states.delete(validId);
      };
    },
    update(id, status, reasonCode) {
      const validId = IdentifierSchema.parse(id);
      const owner = owners.get(validId);
      if (!owner) throw new Error(`unregistered prerequisite ${validId}`);
      const next: PrerequisiteSnapshot = {
        id: validId,
        owner,
        reasonCode: parseReasonCode(reasonCode),
        status: StatusSchema.parse(status),
      };
      const current = states.get(validId);
      if (current?.status === next.status && current.reasonCode === next.reasonCode) return current;
      log.append({
        kind: "observe",
        name: "prerequisite/state",
        payload: {
          id: next.id,
          owner: next.owner,
          reason_code: next.reasonCode,
          status: next.status,
        },
      });
      states.set(validId, next);
      return next;
    },
    get(id) {
      return states.get(IdentifierSchema.parse(id));
    },
    list() {
      return [...states.values()].sort((left, right) => left.id.localeCompare(right.id));
    },
    requireReady(ids) {
      const snapshots = ids.map((id) => {
        const validId = IdentifierSchema.parse(id);
        return states.get(validId) ?? {
          id: validId,
          owner: owners.get(validId) ?? "unregistered",
          reasonCode: "state_missing",
          status: "unavailable" as const,
        };
      });
      const blockers = snapshots.filter((state) => state.status !== "ready").map((state) => state.id);
      if (blockers.length > 0) throw new PrerequisiteBlockedError(blockers);
      return snapshots;
    },
  };
}

function parseReasonCode(value: string): string {
  const parsed = ReasonCodeSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid prerequisite reason code");
  return parsed.data;
}

function recover(log: EventLog): Map<string, Omit<PrerequisiteSnapshot, "owner">> {
  const states = new Map<string, Omit<PrerequisiteSnapshot, "owner">>();
  for (const event of log.events) {
    if (event.name !== "prerequisite/state") continue;
    const parsed = z.strictObject({
      id: IdentifierSchema,
      owner: IdentifierSchema,
      reason_code: ReasonCodeSchema,
      status: StatusSchema,
    }).safeParse(event.payload);
    if (!parsed.success) continue;
    states.set(parsed.data.id, {
      id: parsed.data.id,
      reasonCode: parsed.data.reason_code,
      status: parsed.data.status,
    });
  }
  return states;
}
