import type { EventLog } from "./host/event-log.ts";

export function factorial(n: number): number {
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error("invalid_input");
  }
  if (n === 0) {
    return 1;
  }
  let result = 1;
  for (let i = 1; i <= n; i += 1) {
    result *= i;
  }
  return result;
}

export function runFactorialCli(log: EventLog, args: string[]): string {
  const raw = args[0];
  if (typeof raw !== "string") {
    throw new Error("invalid_input");
  }
  const n = Number(raw);
  const value = factorial(n);
  const text = `${value}`;
  log.append({
    kind: "observe",
    name: "factorial/cli",
    payload: {
      text,
    },
  });
  return text;
}
