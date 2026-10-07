export interface CalendarDateParts {
  year: number;
  month: number;
  day: number;
}

export function parseDateParts(input: string): CalendarDateParts {
  const match = /^([0-9]{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (!match) {
    throw new Error("invalid_date");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error("invalid_date");
  }
  if (month < 1 || month > 12) {
    throw new Error("invalid_date");
  }

  const maxDay = daysInMonth(year, month);
  if (day < 1 || day > maxDay) {
    throw new Error("invalid_date");
  }

  return {
    year,
    month,
    day,
  };
}

export function weekdayName(year: number, month: number, day: number): string {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error("invalid_date");
  }
  if (month < 1 || month > 12) {
    throw new Error("invalid_date");
  }
  const maxDay = daysInMonth(year, month);
  if (day < 1 || day > maxDay) {
    throw new Error("invalid_date");
  }

  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
  const date = new Date(Date.UTC(year, month - 1, day));
  const name = names[date.getUTCDay()];
  if (name === undefined) {
    throw new Error("invalid_date");
  }
  return name;
}

export function daysInMonth(year: number, month: number): number {
  if (!Number.isInteger(year) || !Number.isInteger(month)) {
    throw new Error("invalid_input");
  }
  if (month < 1 || month > 12) {
    throw new Error("invalid_input");
  }

  const start = new Date(Date.UTC(year, month - 1, 1));
  const next = new Date(Date.UTC(year, month, 1));
  return (next.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
}

export function formatCalendarSummary(year: number, month: number, day: number): string {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error("invalid_input");
  }
  if (month < 1 || month > 12) {
    throw new Error("invalid_input");
  }
  if (day < 1 || day > 31) {
    throw new Error("invalid_input");
  }

  const monthDays = daysInMonth(year, month);
  if (day > monthDays) {
    throw new Error("invalid_input");
  }

  // getUTCDay is 0-6 and the array has seven entries, so the index cannot miss.
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) {
    throw new Error("invalid_input");
  }
  const dayName = names[date.getUTCDay()];
  const formatted = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}: ${dayName} (${monthDays} days)`;
  return formatted;
}
