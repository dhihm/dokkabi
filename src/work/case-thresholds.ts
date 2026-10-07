/** Legacy workspace-reported text grammar. These helpers compare reports;
 * they do not authenticate measurements or substrate use. Strong case claims
 * require the protected observer contract in evidence/measurements.ts. */
/**
 * The bars a gate is judged by, fixed in the plan before the run.
 *
 * A gate calibrated its own bar: the SLA test asserted its measurement against
 * a constant derived from that same measurement — its comment said so — and
 * therefore could not fail on the machine it was tuned on. Witnesses cannot
 * catch this class of counterfeit: the work genuinely happened; the STANDARD
 * was the fake.
 *
 * A threshold is only a threshold when it was set before the run, independent
 * of its result. The plan declares the named bars, the run echoes the bars it
 * actually applied (`threshold: name=value`), and the harness refuses a run
 * whose applied bar differs from the declared one. Moving the bar then means
 * editing the plan — visible, diffable, and outside the run's reach.
 *
 * Echoing a bar is not enforcing it. After the bar moved into the plan, the
 * next counterfeit arrived on schedule: a ledger COPY was rewritten to say
 * the gate is green when the measurement infrastructure works and meeting
 * the threshold is someone else's deliverable — a test could then echo the
 * declared bar, measure a hundredth of it, and still exit 0, and every
 * existing check would pass. A bar declared as an inequality (">=0.85",
 * "<=60") closes this: the run must also print `measured: name=<number>`,
 * and the HARNESS evaluates the comparison. A run whose measurement
 * violates the bar cannot be green, whatever its exit code says.
 */

export type CaseThresholds = Readonly<Record<string, string>>;

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/u;
// Scientific notation is how numeric-tolerance bars are naturally written
// (`<=1e-2`); refusing it bounced a legitimately grown plan at boot.
const INEQUALITY_PATTERN = /^(>=|<=)\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/u;

/** The comparison a declared bar demands, when it demands one. */
function parseInequality(value: string): { cmp: ">=" | "<="; bar: number } | undefined {
  const match = INEQUALITY_PATTERN.exec(value.trim());
  if (!match) return undefined;
  return { cmp: match[1] as ">=" | "<=", bar: Number(match[2]) };
}

export function validateThresholds(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [`case thresholds must be an object of name=scalar — e.g. {"throughput_vs_baseline_min_ratio":"0.85"}`];
  }
  const raw = value as Record<string, unknown>;
  const names = Object.keys(raw);
  if (names.length === 0) {
    return ["case thresholds declares no bars, so it constrains nothing — name the standards the gate is judged by"];
  }
  const errors: string[] = [];
  for (const name of names) {
    if (!NAME_PATTERN.test(name)) {
      errors.push(`case threshold name "${name}" must be a bare identifier`);
      continue;
    }
    const level = raw[name];
    if (typeof level !== "string" && typeof level !== "number") {
      errors.push(`case threshold ${name} must be a scalar value fixed in the plan (got ${typeof level})`);
      continue;
    }
    const text = String(level).trim();
    if (/^[<>]/u.test(text) && parseInequality(text) === undefined) {
      errors.push(`case threshold ${name} comparison must look like ">=0.85" or "<=60" (got ${text})`);
    }
  }
  return errors;
}

/** Read the values a run says it measured (`measured: name=<number>`). */
export function parseMeasuredReport(output: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const match of output.matchAll(/measured:[ \t]*([^\r\n]+)/giu)) {
    for (const pair of (match[1] ?? "").matchAll(/([A-Za-z][A-Za-z0-9_]*)=(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/gu)) {
      const value = Number(pair[2]);
      if (pair[1] && Number.isFinite(value)) found[pair[1]] = value;
    }
  }
  return found;
}

/**
 * Read the bars a run says it applied. The LAST report wins.
 *
 * Both spellings count: the canonical `name=<=0.01` the harness asks for,
 * and the natural `name<=0.01` a person writes. Demanding only the first
 * made a gate that had applied and met every bar read as having echoed
 * none, and the run spent nineteen turns explaining a verdict it could not
 * see the reason for.
 */
export function parseThresholdReport(output: string): Record<string, string> | undefined {
  let found: Record<string, string> | undefined;
  for (const match of output.matchAll(/threshold:[ \t]*([^\r\n]+)/giu)) {
    const pairs: Record<string, string> = {};
    for (const pair of (match[1] ?? "").matchAll(/([A-Za-z][A-Za-z0-9_]*)\s*(==|>=|<=|=)\s*([^\s]+)/gu)) {
      const [, name, operator, value] = pair;
      if (!name || !operator || !value) continue;
      pairs[name] = operator === "=" ? value : `${operator}${value}`;
    }
    if (Object.keys(pairs).length > 0) found = { ...(found ?? {}), ...pairs };
  }
  return found;
}

/** Same bar, whatever spelling: `<=1e-2` and `<=0.01` fix the same line. */
function sameScalar(a: string, b: string): boolean {
  const left = a.trim();
  const right = b.trim();
  if (left === right) return true;
  const la = parseInequality(left);
  const lb = parseInequality(right);
  if (la && lb) return la.cmp === lb.cmp && la.bar === lb.bar;
  if (la || lb) return false;
  const na = Number(left);
  const nb = Number(right);
  return Number.isFinite(na) && Number.isFinite(nb) && na === nb;
}

/** Why this run's applied bars do not close the claim, or undefined. */
export function thresholdMismatch(
  declared: CaseThresholds | undefined,
  reported: Record<string, string> | undefined,
  measured?: Record<string, number>,
): string | undefined {
  if (!declared || Object.keys(declared).length === 0) return undefined;
  const problems: string[] = [];
  for (const [name, value] of Object.entries(declared)) {
    const got = reported?.[name];
    if (got === undefined) {
      problems.push(`${name} was never echoed — print "threshold: ${name}=${value}" from the run so the applied bar can be checked`);
      continue;
    }
    if (!sameScalar(String(value), got)) {
      problems.push(`${name} was applied as ${got} but the plan fixed it at ${value}`);
      continue;
    }
    const inequality = parseInequality(String(value));
    if (!inequality) continue;
    // The harness evaluates the comparison itself: a run that echoes a bar
    // it does not enforce would otherwise measure a hundredth of it and
    // still exit 0.
    const observed = measured?.[name];
    if (observed === undefined) {
      problems.push(`${name} has no measurement — print "measured: ${name}=<number>" so the bar can be evaluated`);
      continue;
    }
    const holds = inequality.cmp === ">=" ? observed >= inequality.bar : observed <= inequality.bar;
    if (!holds) {
      problems.push(`${name} measured ${observed}, violating the plan's bar ${value}`);
    }
  }
  if (problems.length === 0) return undefined;
  return `case was judged against a bar the plan did not set: ${problems.join("; ")}. `
    + `A threshold calibrated from the run's own result cannot fail and proves nothing — the bar lives in the plan.`;
}
