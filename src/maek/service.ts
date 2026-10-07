import type { EventLog } from "../host/event-log.ts";
import { createLiveMaek } from "./live.ts";
import { createReplayMaek } from "./replay.ts";
import type { MaekService } from "./types.ts";

export type { MaekService } from "./types.ts";

export function createMaekService(input: {
  log: EventLog;
  sessionId: string;
  dbPath: string;
  replay?: boolean;
}): MaekService {
  if (input.replay) {
    return createReplayMaek(input.log);
  }
  return createLiveMaek(input);
}
