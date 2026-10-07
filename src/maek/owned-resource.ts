import { createLiveMaek } from "./live.ts";
import type { MaekService } from "./types.ts";

/** Stable facade: draining a live derived store never changes model tools. */
export function createOwnedMaek(input: Parameters<typeof createLiveMaek>[0]) {
  let current: ReturnType<typeof createLiveMaek> | undefined = createLiveMaek(input);
  let closed = false;
  let lifecycle: Promise<void> = Promise.resolve();
  const serialize = (operation: () => Promise<void>) => {
    const next = lifecycle.then(operation);
    lifecycle = next.catch(() => undefined);
    return next;
  };
  const available = () => {
    if (closed || !current)
      throw new Error("MAEK resource is unavailable during owned work transfer or after disposal");
    return current;
  };
  const service: MaekService = {
    engine: "duckdb",
    async queryDecisions(text, options) {
      return available().queryDecisions(text, options);
    },
    async querySimilarFaults(query) {
      return available().querySimilarFaults(query);
    },
    async ingest() {
      return available().ingest();
    },
    close() {
      closed = true;
      return serialize(async () => {
        const previous = current;
        current = undefined;
        await previous?.close();
      });
    },
  };
  return {
    service,
    suspend() {
      return serialize(async () => {
        const previous = current;
        current = undefined;
        await previous?.close();
      });
    },
    resume() {
      return serialize(async () => {
        if (closed || current) return;
        input.log.refresh();
        const restored = createLiveMaek(input);
        try {
          await restored.ready();
          if (closed) await restored.close();
          else current = restored;
        } catch (error) {
          try {
            await restored.close();
          } catch (cleanup) {
            throw new AggregateError([error, cleanup], "MAEK reconstruction and cleanup failed");
          }
          throw error;
        }
      });
    },
  };
}
