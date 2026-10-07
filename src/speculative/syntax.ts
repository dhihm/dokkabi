import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { safeRelativeFile } from "./targets.ts";

export type ModuleSyntax =
  | {
    readonly parsed: true;
    readonly imports: readonly string[];
    readonly exports: readonly string[];
  }
  | {
    readonly parsed: false;
    readonly imports: readonly [];
    readonly exports: readonly [];
  };

export type ModuleLoader = "js" | "jsx" | "ts" | "tsx";

const transpilers = new Map<ModuleLoader, Bun.Transpiler>();

export function scanModuleSyntax(sourceText: string, loader: ModuleLoader): ModuleSyntax {
  let transpiler = transpilers.get(loader);
  if (!transpiler) {
    transpiler = new Bun.Transpiler({ loader });
    if (loader === "js" || loader === "jsx" || loader === "ts" || loader === "tsx") {
      transpilers.set(loader, transpiler);
    }
  }
  try {
    const imports = unique(transpiler.scanImports(sourceText).map((entry) => entry.path));
    const exports = unique(transpiler.scan(sourceText).exports).sort();
    return { parsed: true, imports, exports };
  } catch (error) {
    if (isSyntaxScanFailure(error)) return { parsed: false, imports: [], exports: [] };
    throw error;
  }
}

function isSyntaxScanFailure(error: unknown): boolean {
  if (error instanceof BuildMessage) return true;
  if (!(error instanceof Error)) return false;
  return error.message === "Failed to scan imports" || error.message === "Backtrack Failed to scan imports";
}

export function resolveWorkspaceImports(input: {
  readonly workspaceRoot: string;
  readonly fromPath: string;
  readonly specifiers: readonly string[];
}): readonly string[] {
  const root = realpathSync(input.workspaceRoot);
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const specifier of input.specifiers) {
    if (!specifier.startsWith(".")) continue;
    const base = `${dirname(input.fromPath)}/${specifier}`;
    for (const candidate of candidates(base)) {
      const path = safeRelativeFile(root, candidate);
      if (!path) continue;
      if (!seen.has(path)) {
        seen.add(path);
        resolved.push(path);
      }
      break;
    }
  }
  return resolved;
}

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

function candidates(base: string): readonly string[] {
  return [base, ...EXTENSIONS.map((extension) => `${base}${extension}`),
    ...EXTENSIONS.map((extension) => `${base}/index${extension}`)];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
