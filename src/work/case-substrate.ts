/** Legacy workspace-reported text grammar. These helpers compare reports;
 * they do not authenticate measurements or substrate use. Strong case claims
 * require the protected observer contract in evidence/measurements.ts. */
/**
 * What a case's run actually ran ON.
 *
 * A gate can claim more than its run proves. Live, a case demanding per-layer
 * agreement across a full-scale model with production weights on an
 * accelerator was closed by a four-layer randomly-initialised CPU fixture: the
 * command exited 0, so the harness called it green. A reduced fixture cannot
 * accumulate the error that claim is about, so the run could never have failed
 * — the case was unfalsifiable and the green meant nothing.
 *
 * Exit codes do not carry this, so a case declares the fidelity its claim
 * needs and its run reports the fidelity it had. WHICH axes matter is the
 * domain's business, not the harness's: a serving gate might declare
 * `database=live storage=real`, a compiler gate `input=production
 * optimisation=full`, a model gate `checkpoint=real device=gpu scale=full`.
 * The first version of this hard-coded that last set, which made a general
 * rule look like a rule about one afternoon's problem.
 *
 * The harness therefore compares without understanding: every axis the claim
 * names must appear in the report with the same level. A plan may declare an
 * ordering for an axis — weakest first — and then a stronger run satisfies a
 * weaker claim. Absent an ordering the harness will not guess which of two
 * words means "more", so it requires an exact match.
 */

/** Axis → level. Both are the domain's words; the harness only matches them. */
export type CaseSubstrate = Readonly<Record<string, string>>;

/** Axis → levels, weakest first. A run may exceed a claim, never fall short. */
export type SubstrateOrdering = Readonly<Record<string, readonly string[]>>;

const AXIS_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/u;

/** Rendered from the claim itself, so the example always fits the case at hand. */
export function formatSubstrate(substrate: CaseSubstrate): string {
  return Object.entries(substrate)
    .map(([axis, level]) => `${axis}=${level}`)
    .join(" ");
}

export const SUBSTRATE_MARKER_PREFIX = "substrate:";

/**
 * Read the substrate a run reported. One line anywhere in the output, so a run
 * emits it with an ordinary print. The LAST marker wins: within one command the
 * final word on what ran is the honest one.
 */
export function parseSubstrateReport(output: string): CaseSubstrate | undefined {
  let found: Record<string, string> | undefined;
  for (const match of output.matchAll(/substrate:[ \t]*([^\r\n]+)/giu)) {
    const body = match[1] ?? "";
    const pairs: Record<string, string> = {};
    for (const pair of body.matchAll(/([A-Za-z][A-Za-z0-9_]*)=([^\s]+)/gu)) {
      const axis = pair[1]?.toLowerCase();
      const level = pair[2]?.toLowerCase();
      if (axis && level) pairs[axis] = level;
    }
    if (Object.keys(pairs).length > 0) found = pairs;
  }
  return found;
}

/** Shape gate for a declaration arriving as plan data. */
export function validateSubstrate(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [
      `case substrate must be an object of axis=level — e.g. {"database":"live","storage":"real"}`,
    ];
  }
  const raw = value as Record<string, unknown>;
  const axes = Object.keys(raw);
  if (axes.length === 0) {
    return ["case substrate declares no axes, so it constrains nothing — name what its claim depends on"];
  }
  const errors: string[] = [];
  for (const axis of axes) {
    if (!AXIS_PATTERN.test(axis)) {
      errors.push(`case substrate axis "${axis}" must be a bare name like checkpoint or database`);
      continue;
    }
    const level = raw[axis];
    if (typeof level !== "string" || level.trim().length === 0) {
      errors.push(`case substrate.${axis} must be a non-empty level name (got ${String(level)})`);
    }
  }
  return errors;
}

/** True when `reported` sits at or above `declared` on this axis. */
function satisfies(
  axis: string,
  declared: string,
  reported: string,
  ordering?: SubstrateOrdering,
): boolean {
  if (declared === reported) return true;
  const ranked = ordering?.[axis];
  if (!ranked) return false;
  const want = ranked.indexOf(declared);
  const got = ranked.indexOf(reported);
  return want >= 0 && got >= 0 && got >= want;
}

/**
 * Why this run may not close this claim, or undefined when it may.
 *
 * A claim with no declaration asks nothing. A declared claim with no reported
 * substrate is refused: the run has not said what it ran on, and "the command
 * exited 0" is not an answer. Axes the report carries beyond the claim are
 * ignored — the claim is what constrains.
 */
export function substrateMismatch(
  declared: CaseSubstrate | undefined,
  reported: CaseSubstrate | undefined,
  ordering?: SubstrateOrdering,
): string | undefined {
  if (!declared || Object.keys(declared).length === 0) return undefined;
  if (!reported) {
    return `case declares substrate ${formatSubstrate(declared)} but its run reported none — print one line "${SUBSTRATE_MARKER_PREFIX} ${formatSubstrate(declared)}" from the run so the claim can be checked against what actually ran`;
  }
  const weak: string[] = [];
  for (const [axis, level] of Object.entries(declared)) {
    const got = reported[axis];
    if (got === undefined) {
      weak.push(`${axis} not reported (needs ${level})`);
      continue;
    }
    if (!satisfies(axis, level, got, ordering)) {
      weak.push(`${axis}=${got} (needs ${level})`);
    }
  }
  if (weak.length === 0) return undefined;
  return `case ran on a substrate its claim does not allow: ${weak.join(", ")} — a run that differs here cannot fail for the reason this case asserts, so it cannot pass for it either`;
}

/**
 * Why a run that met its substrate report still may not close the claim.
 *
 * A report is self-asserted: a table mapping test names to substrate strings
 * satisfies it whether or not the work was ever done. The harness cannot read
 * the remote process, but the operator knows what the claim costs, so a case
 * may state a floor and a run coming in under it has not done what it says.
 */
export function durationShortfall(
  minDurationMs: number | undefined,
  actualMs: number,
): string | undefined {
  if (minDurationMs === undefined || !Number.isFinite(minDurationMs) || minDurationMs <= 0) {
    return undefined;
  }
  if (actualMs >= minDurationMs) return undefined;
  return `case ran in ${actualMs}ms but declares its claim cannot cost less than ${minDurationMs}ms — a substrate line is self-reported, and a run this fast did not do the work the claim describes`;
}

/**
 * Witnesses: numbers only the claimed work could have produced.
 *
 * A substrate line can be true and still say nothing. Two gates declared the
 * most demanding levels available and reported exactly that, having done none
 * of the work: one read a layer count out of a config file — the number sits
 * there whether or not a model exists — and asked whether the machine has an
 * accelerator, which is not the same as having used one; the other printed the
 * line from a template whose placeholders were never filled.
 *
 * The first version of this check hard-coded which axes need which witness,
 * which repeated the exact mistake the axes themselves had just been cured of:
 * a web gate declaring database=live could not be asked for a witness at all,
 * and the machine-learning axes got theirs by privilege rather than by
 * declaration. So the plan now declares the witness the same way it declares
 * the axis: `witness_for` maps an axis to the name of a positive number the
 * run could only obtain by doing the work. Axes without a declared witness are
 * checked by their level alone.
 */
export type WitnessDeclaration = Readonly<Record<string, string>>;

/** Positive `witness: name=<number>` values found in the run's output. */
function witnessValues(output: string): Map<string, number> {
  const found = new Map<string, number>();
  for (const match of output.matchAll(/witness:[ \t]*([^\r\n]+)/giu)) {
    for (const pair of (match[1] ?? "").matchAll(/([A-Za-z][A-Za-z0-9_]*)=([0-9]+(?:\.[0-9]+)?)/gu)) {
      const name = pair[1]?.toLowerCase();
      const value = Number(pair[2]);
      if (name && Number.isFinite(value) && value > 0) found.set(name, value);
    }
  }
  return found;
}

/**
 * Why this run's substrate claim is unwitnessed, or undefined when every axis
 * with a declared witness is backed by one.
 */
export function substrateWitnessGap(
  declared: CaseSubstrate | undefined,
  _reported: CaseSubstrate | undefined,
  output: string,
  witnessFor?: WitnessDeclaration,
): string | undefined {
  if (!declared || !witnessFor || Object.keys(witnessFor).length === 0) return undefined;
  const present = witnessValues(output);
  const missing: string[] = [];
  for (const [axis, witness] of Object.entries(witnessFor)) {
    if (declared[axis] === undefined) continue;
    if (!present.has(witness.toLowerCase())) {
      missing.push(`${axis}=${declared[axis]} needs "witness: ${witness}=<n>"`);
    }
  }
  if (missing.length === 0) return undefined;
  return `case claims a substrate its run did not witness: ${missing.join(", ")}. `
    + `A capability flag, a config field, or a template placeholder is not evidence the work happened — `
    + `print a positive number the run could only have obtained by doing it.`;
}

/**
 * Did the run report a machine other than the one the harness sent it to?
 *
 * The harness cannot be lied to about where it dispatched a command: it either
 * ran it here or handed it to a named alias. A case that prints
 * `label: host=<name>` is claiming provenance for its numbers, and when that
 * claim contradicts the dispatch the numbers are about a machine nobody asked
 * for.
 *
 * A remote case is the one worth checking hard. It was sent to another box, so
 * a report naming THIS box means the work happened here — the shape a forged
 * measurement takes when a case quietly runs where it is cheap to pass.
 */
export function hostLabelMismatch(
  declaredHost: string | undefined,
  localHostname: string,
  output: string,
): string | undefined {
  const labelled = output.match(/label:[ \t]*(?:[^\r\n]*[ \t])?host=([^\s\r\n]+)/iu)?.[1];
  if (!labelled) return undefined;
  const local = localHostname.trim().toLowerCase();
  const claimed = labelled.trim().toLowerCase();
  if (!local || !claimed) return undefined;
  const sameMachine = claimed === local
    || claimed.startsWith(`${local.split(".")[0]}.`)
    || local.startsWith(`${claimed.split(".")[0]}.`);
  if (declaredHost === undefined) return undefined;
  if (!sameMachine) return undefined;
  return `case declares host ${declaredHost} but its run reported "label: host=${labelled}", which is `
    + `the machine the harness is running ON. The command was dispatched to ${declaredHost}; a result `
    + `that came from here is not evidence about ${declaredHost}.`;
}
