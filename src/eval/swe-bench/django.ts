/**
 * Django suite support. Django's own test suite cannot run under plain
 * pytest (its app registry needs tests/runtests.py bootstrapping), and
 * SWE-bench rows for django use human-written ids in two shapes:
 *
 *   "test_non_form_errors (forms_tests.tests.test_formsets.FormsFormsetTestCase)"
 *      -> runnable: module.Class.name under runtests.py
 *   "If validate_max is set and max_num is less than TOTAL_FORMS in the"
 *      -> narrative: names a NEW test added by the test patch; it cannot be
 *         identified before the patch text is parsed, so it is excluded and
 *         counted as skipped, never guessed.
 */
export interface SuiteKindInput {
  hasRuntests: boolean;
  id: string;
}

export type SuiteKind = "django" | "plain";

export function suiteKind(input: SuiteKindInput): SuiteKind {
  if (!input.hasRuntests) {
    return "plain";
  }
  // runtests.py present AND the id is a dotted module path (not a file path).
  return /^[\w.]+$/.test(input.id) || input.id.includes(" (") ? "django" : "plain";
}

/** "name (module.Class)" → "module.Class.name"; narrative ids → undefined. */
export function parseTestId(raw: string): string | undefined {
  const paren = raw.match(/^([\w]+)\s*\(([\w.]+)\)$/);
  if (paren) {
    return `${paren[2]}.${paren[1]}`;
  }
  // Already a plain runnable id (file path or dotted).
  const pathId = !/\s/.test(raw) && (raw.includes("/") || raw.includes("::"));
  if (pathId || /^[\w.]+$/.test(raw)) {
    return raw;
  }
  return undefined;
}

/** Split a raw list into runnable ids and skipped narrative ids. */
export function partitionTestIds(
  raw: readonly string[],
): { runnable: string[]; skipped: string[] } {
  const runnable: string[] = [];
  const skipped: string[] = [];
  for (const id of raw) {
    const parsed = parseTestId(id);
    if (parsed) {
      runnable.push(parsed);
    } else {
      skipped.push(id);
    }
  }
  return { runnable, skipped };
}
