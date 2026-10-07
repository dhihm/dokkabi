import type { ToolRow } from "./project.ts";

/**
 * The TOOLS failure detail block (#dokkabi-dev#51).
 *
 * Rows are already structured (`ToolRow`); this module only decides how an
 * expanded row reads. Keyed by `name:seq` — stable within a session, and the
 * seq disambiguates two calls of the same tool.
 */

export function toolKey(row: ToolRow): string {
  return `${row.name}:${row.seq}`;
}

export function toolDetailLines(row: ToolRow): string[] {
  const cost = typeof row.duration_ms === "number" ? ` ${row.duration_ms}ms` : "";
  const out = [`↳ ${row.name} ${row.error ? "failed" : "ok"}${cost}`];
  if (row.diagnosis) {
    out.push(`  ${row.diagnosis}`);
  }
  if (row.diagnosis_detail) {
    out.push(`  ${row.diagnosis_detail}`);
  }
  return out;
}
