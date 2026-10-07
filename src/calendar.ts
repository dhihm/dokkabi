export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

export function parseDate(input: string): CalendarDate {
  const match = /^([0-9]{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (!match) {
    throw new Error("invalid_date");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    throw new Error("invalid_date");
  }
  if (month < 1 || month > 12) {
    throw new Error("invalid_date");
  }
  if (day < 1 || day > 31) {
    throw new Error("invalid_date");
  }

  return { year, month, day };
}

export function weekdayFromDate(year: number, month: number, day: number): string {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error("invalid_date");
  }
  if (month < 1 || month > 12) {
    throw new Error("invalid_date");
  }
  if (day < 1 || day > 31) {
    throw new Error("invalid_date");
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) {
    throw new Error("invalid_date");
  }
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
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
  const monthIndex = month - 1;
  const nextMonth = new Date(Date.UTC(year, monthIndex + 1, 1));
  const currentMonth = new Date(Date.UTC(year, monthIndex, 1));
  const diff = (nextMonth.getTime() - currentMonth.getTime()) / (1000 * 60 * 60 * 24);
  return diff;
}

export function formatCalendarSummary(year: number, month: number, day: number): string {
  const weekday = weekdayFromDate(year, month, day);
  const monthDays = daysInMonth(year, month);
  const yyyy = String(year).padStart(4, "0");
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}: ${weekday} (${monthDays} days)`;
}
