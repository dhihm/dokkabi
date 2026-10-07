import type { OwnedWorkResourceRegistry } from "../loader/types.ts";
import type { EventLog } from "./event-log.ts";

/** Plugin-owned exclusive resources follow the actual owned child lifetime. */
export function createOwnedWorkResourceRegistry(log: EventLog): OwnedWorkResourceRegistry {
  const entries = new Map<string, Parameters<OwnedWorkResourceRegistry["register"]>[1]>();
  let busy = false;
  let failed = false;
  return {
    register(pluginId, resource) {
      if (log.isReadOnly || busy || failed)
        throw new Error("Owned work resource enrollment unavailable");
      if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(pluginId))
        throw new Error("Invalid owned work resource id");
      if (entries.has(pluginId)) throw new Error("Duplicate owned work resource");
      entries.set(pluginId, resource);
      return () => {
        if (entries.get(pluginId) === resource) entries.delete(pluginId);
      };
    },
    async run(operation) {
      if (log.isReadOnly || busy || failed)
        throw new Error("Owned work resource transfer unavailable");
      busy = true;
      const released: Array<[string, Parameters<OwnedWorkResourceRegistry["register"]>[1]]> = [];
      const errors: unknown[] = [];
      const transfer = async (
        id: string,
        phase: "suspend" | "resume",
        callback: () => Promise<void>,
      ) => {
        log.appendDurable({
          kind: "observe",
          name: "work/resource_transfer",
          payload: { pluginId: id, phase, status: "started" },
        });
        try {
          await callback();
          log.appendDurable({
            kind: "observe",
            name: "work/resource_transfer",
            payload: { pluginId: id, phase, status: "completed" },
          });
        } catch (error) {
          log.appendDurable({
            kind: "observe",
            name: "work/resource_transfer",
            payload: { pluginId: id, phase, status: "failed" },
          });
          throw error;
        }
      };
      let value: Awaited<ReturnType<typeof operation>> | undefined;
      try {
        for (const entry of [...entries]) {
          // Include a partially suspended resource in rollback as well.
          released.push(entry);
          await transfer(entry[0], "suspend", () => entry[1].suspend());
        }
        value = await operation();
      } catch (error) {
        errors.push(error);
      } finally {
        for (const [id, resource] of released.reverse()) {
          try {
            await transfer(id, "resume", () => resource.resume());
          } catch (error) {
            failed = true;
            errors.push(error);
          }
        }
        busy = false;
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Owned work resource transfer failed");
      return value!;
    },
  };
}
