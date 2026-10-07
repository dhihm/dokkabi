import { readFileSync } from "node:fs";

/**
 * Some SWE-bench rows (sympy) list FAIL_TO_PASS as bare function names
 * (`test_coth`). The test patch adds those functions to specific files, so
 * the mapping is derivable deterministically: parse the patch's diff hunks,
 * map every added `def <name>` to its file, and rewrite bare ids to
 * `file::name`. Unknown names pass through — never guessed.
 */
export function resolveIdsFromPatch(ids: readonly string[], patchPath: string): string[] {
  let patch: string;
  try {
    patch = readFileSync(patchPath, "utf8");
  } catch {
    return [...ids];
  }
  const defToFile = new Map<string, string>();
  let file = "";
  for (const line of patch.split("\n")) {
    const fileHeader = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileHeader) {
      file = fileHeader[2]!;
      continue;
    }
    const added = line.match(/^\+def\s+([A-Za-z_]\w*)\s*\(/);
    if (added && file) {
      defToFile.set(added[1]!, file);
    }
  }
  if (defToFile.size === 0) {
    return [...ids];
  }
  return ids.map((id) => {
    // Bare function name only (no path, no ::).
    if (/^[A-Za-z_]\w*$/.test(id)) {
      const target = defToFile.get(id);
      if (target) {
        return `${target}::${id}`;
      }
    }
    return id;
  });
}
