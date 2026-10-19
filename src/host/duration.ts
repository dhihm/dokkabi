const DURATION = /^(\d+)([dhms])$/u;

/** Parse a compact duration such as `14d`, `12h`, `30m`, or `90s`. */
export function parseDuration(spec: string): number {
  const trimmed = spec.trim();
  const match = DURATION.exec(trimmed);
  if (!match) {
    throw new Error("--older-than requires a duration like 14d, 12h, 30m, or 90s");
  }
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("--older-than requires a positive integer duration");
  }
  const unit = match[2]!;
  const scale = unit === "d" ? 86_400_000
    : unit === "h" ? 3_600_000
      : unit === "m" ? 60_000
        : 1_000;
  return amount * scale;
}
