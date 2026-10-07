import { BUILTIN_RUNNER_SPECS } from "./case-runners.ts";

// Where the ecosystems the host knows keep tests, as the built-in runner
// specs themselves declare it (dir segments, basename affixes), plus the JS
// .test./.spec. infix those specs leave implicit. A file a runner merely
// POINTS at is the case's test file only when it lives in one of these
// shapes: a repository-registered check whose subject is a data or product
// file (extensions-only spec) reads that file, it does not test it — the
// session changing it is the work, never tampering.
const TEST_DIR_SEGMENTS: ReadonlySet<string> = new Set(
  BUILTIN_RUNNER_SPECS.flatMap((spec) => spec.test_file.dir_segments ?? []),
);
const TEST_BASENAME_PREFIXES: readonly string[] = [
  ...new Set(BUILTIN_RUNNER_SPECS.flatMap((spec) => spec.test_file.basename_prefixes ?? [])),
];
const TEST_BASENAME_SUFFIXES: readonly string[] = [
  ...new Set([
    ...BUILTIN_RUNNER_SPECS.flatMap((spec) => spec.test_file.basename_suffixes ?? []),
    ".test.ts", ".test.tsx", ".test.js", ".test.jsx", ".test.mjs", ".test.cjs",
    ".spec.ts", ".spec.tsx", ".spec.js", ".spec.jsx", ".spec.mjs", ".spec.cjs",
  ]),
];

/** True when the path sits where the host's runner knowledge keeps test
 * files (a tests/testing directory segment, or a conventional basename). */
export function isConventionalTestPath(path: string): boolean {
  const segments = path.split("/");
  const basename = segments.at(-1) ?? "";
  return segments.slice(0, -1).some((segment) => TEST_DIR_SEGMENTS.has(segment))
    || TEST_BASENAME_PREFIXES.some((prefix) => basename.startsWith(prefix))
    || TEST_BASENAME_SUFFIXES.some((suffix) => basename.endsWith(suffix));
}

