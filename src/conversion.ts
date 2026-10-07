import type { EventLog } from "./host/event-log.ts";

export function convertKmToMiles(km: number): number {
  if (!Number.isFinite(km)) {
    throw new Error("invalid_input");
  }
  return km * 0.621371;
}

export function formatKmToMiles(km: number, miles: number): string {
  return `${km} km = ${miles} miles`;
}

export function runConversionCli(log: EventLog, args: string[]): string {
  const raw = args[0];
  if (typeof raw !== "string") {
    throw new Error("invalid_input");
  }
  const km = Number(raw);
  const miles = Number(convertKmToMiles(km).toFixed(7));
  const text = formatKmToMiles(km, miles);
  log.append({
    kind: "observe",
    name: "convert/cli",
    payload: {
      text,
    },
  });
  return text;
}
