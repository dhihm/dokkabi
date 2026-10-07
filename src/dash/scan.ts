import type { Tone } from "./screen.ts";

/**
 * TUI scan helpers for the EVENTS pane and pane titles.
 *
 * The EventLog kind (surface/observe/effect) is the hash-chain type, not
 * the actor. Operators scan actors: input, model, tool, other observe.
 * This is a projection, not a second log (constitution 6).
 */

export type EventLane = "I" | "M" | "T" | "O";

export interface ScanEvent {
  name: string;
  ts?: string;
  payload?: Record<string, unknown>;
}

export function eventLane(event: Pick<ScanEvent, "name">): EventLane {
  const name = event.name;
  if (name === "user/message" || name === "operator/note") {
    return "I";
  }
  if (name.startsWith("assistant/") || name.startsWith("model/")) {
    return "M";
  }
  if (name.startsWith("tool/") || name.startsWith("sandbox/")) {
    return "T";
  }
  return "O";
}

/** Compact I/M/T chronology. Observe is a dot so the strip stays a density map. */
export function eventDensityStrip(events: readonly Pick<ScanEvent, "name">[], width: number): string {
  if (width < 1 || events.length === 0) {
    return "";
  }
  return events
    .slice(-width)
    .map((event) => {
      const lane = eventLane(event);
      return lane === "O" ? "·" : lane;
    })
    .join("");
}

export function eventDelta(prev: Pick<ScanEvent, "ts"> | undefined, event: Pick<ScanEvent, "ts">): string {
  if (!prev?.ts || !event.ts) {
    return "";
  }
  const start = Date.parse(prev.ts);
  const end = Date.parse(event.ts);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return "";
  }
  const ms = end - start;
  if (ms >= 10_000) {
    return `+${Math.round(ms / 1000)}s`;
  }
  return `+${(ms / 1000).toFixed(1)}s`;
}

function payload(event: ScanEvent): Record<string, unknown> {
  return event.payload ?? {};
}

export function isBadEvent(event: ScanEvent): boolean {
  const body = payload(event);
  if (body.error === true) {
    return true;
  }
  if (event.name === "swe/result" && body.resolved === false) {
    return true;
  }
  if (event.name === "swe/baseline" && body.passed === false) {
    return true;
  }
  // A refused step carries its cause in `error` as TEXT, not a boolean flag,
  // so read as an ordinary observe row it would look like normal progress.
  if (event.name === "work/step_refused") {
    return true;
  }
  // A briefing the operator expected and did not get. `unbound` matches no
  // fail/error word, so without this it paints exactly like success.
  if (event.name === "knowledge/briefing_scope" && body.status !== "bound") {
    return true;
  }
  if (typeof body.status === "string" && /fail|error/i.test(body.status)) {
    return true;
  }
  return false;
}

function isHotEvent(event: ScanEvent): boolean {
  if (event.name === "model/retry" || event.name === "model/progress") {
    return true;
  }
  return event.name === "work/step" && payload(event).action === "defer";
}

export function eventLaneTone(event: ScanEvent): Tone {
  if (isBadEvent(event)) {
    return "bad";
  }
  if (isHotEvent(event)) {
    return "ember";
  }
  switch (eventLane(event)) {
    case "I":
      return "ember";
    case "M":
      return "title";
    case "T":
      return "lane";
    case "O":
      return "default";
  }
}

/** Pane chrome: `EVENTS IMT IMTT·` when the title row has room.
 * STREAM keeps a short title — the density strip blew past the box
 * width and painted `MODEL STREAM IMT MMMM…` over the reply. */
export function scanPaneTitle(
  pane: string,
  events: readonly Pick<ScanEvent, "name">[],
  width: number,
): string {
  if (pane === "STREAM" || pane === "MODEL STREAM") {
    return pane.length + 2 <= width ? pane : "STREAM";
  }
  const head = `${pane} IMT`;
  const room = Math.max(0, width - head.length - 3);
  if (room < 4 || events.length === 0) {
    return pane;
  }
  const strip = eventDensityStrip(events, Math.min(16, room));
  if (strip.length === 0) {
    return pane;
  }
  const titled = `${head} ${strip}`;
  return titled.length + 2 <= width ? titled : pane;
}
