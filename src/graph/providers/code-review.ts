import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { EventLog } from "../../host/event-log.ts";
import {
  type ModuleLoader,
  resolveWorkspaceImports,
  scanModuleSyntax,
} from "../../speculative/syntax.ts";
import { GraphStore, type GraphMutation } from "../store.ts";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".dokkabi",
  ".omo",
  ".bun",
  "__pycache__",
  ".pytest_cache",
  ".venv",
  ".ruff_cache",
  "logs",
  "log",
  "artifacts",
  "ci_results",
  "test_logs",
  "service_logs",
  "profiling",
  "issue-assets",
]);
const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs|py)$/;

/**
 * First graph provider: a code-review snapshot of the workspace. File nodes
 * carry content digests, source files contribute symbol nodes, imports become
 * edges, test files become test nodes with tested_by edges to the symbols
 * they reference. Rebuilding an unchanged workspace records nothing: the
 * provider only appends when the world actually moved.
 */
export function buildCodeReviewGraph(log: EventLog, workspaceRoot: string): GraphStore {
  const root = resolve(workspaceRoot);
  const store = GraphStore.fromEvents(log.events);
  const current = snapshot(root);

  const add: GraphMutation["add"] = [];
  const edges: GraphMutation["edges"] = [];

  for (const file of current.files) {
    if (store.fileNode(file.path)?.digest === file.digest) {
      continue;
    }
    add.push({ kind: file.isTest ? "test" : "file", id: file.path, file: file.path, digest: file.digest });
    for (const symbol of file.symbols) {
      const symbolId = `sym:${symbol}`;
      if (!store.hasNode(symbolId)) {
        add.push({ kind: "symbol", id: symbolId, file: file.path });
      }
      edges.push({ kind: "observed_at", from: symbolId, to: file.path });
    }
    for (const imported of file.imports) {
      edges.push({ kind: "imports", from: file.path, to: imported });
    }
    if (file.isTest) {
      // A test exercises the symbols of every file it imports.
      for (const imported of file.imports) {
        for (const candidate of current.files) {
          if (candidate.path === imported) {
            for (const symbol of candidate.symbols) {
              edges.push({ kind: "tested_by", from: `sym:${symbol}`, to: file.path });
            }
          }
        }
      }
    }
  }

  if (add.length > 0 || edges.length > 0) {
    store.applyMutation(log, { add, edges });
  }
  return store;
}

interface FileSnapshot {
  path: string;
  digest: string;
  symbols: string[];
  imports: string[];
  isTest: boolean;
}

function snapshot(root: string): { files: FileSnapshot[] } {
  const files: FileSnapshot[] = [];
  walk(root, root, files);
  return { files };
}

function walk(root: string, dir: string, out: FileSnapshot[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) {
      continue;
    }
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(root, full, out);
      continue;
    }
    if (!SOURCE_EXT.test(entry.name)) {
      continue;
    }
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (!stats.isFile()) {
      continue;
    }
    const rel = relative(root, full).replaceAll("\\", "/");
    let text: string;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    let extracted: Pick<FileSnapshot, "symbols" | "imports"> | undefined;
    const extract = (): Pick<FileSnapshot, "symbols" | "imports"> => {
      if (extracted) return extracted;
      const syntax = rel.endsWith(".py") ? undefined : scanModuleSyntax(text, loaderFor(rel));
      extracted = {
        symbols: syntax
          ? syntax.parsed ? [...new Set([...syntax.exports, ...typescriptLocalSymbolsOf(text)])] : []
          : pythonSymbolsOf(text),
        imports: syntax?.parsed
          ? [...resolveWorkspaceImports({ workspaceRoot: root, fromPath: rel, specifiers: syntax.imports })]
          : syntax ? [] : pythonImportsOf(rel, text, root),
      };
      return extracted;
    };
    out.push({
      path: rel,
      digest: createHash("sha256").update(text).digest("hex").slice(0, 32),
      get symbols() { return extract().symbols; },
      get imports() { return extract().imports; },
      isTest: entry.name.includes(".test.") || entry.name.includes(".spec.") || rel.startsWith("tests/") || rel.startsWith("test_"),
    });
  }
}

function pythonSymbolsOf(text: string): string[] {
  const symbols = new Set<string>();
  for (const match of text.matchAll(/^(?:async\s+)?def\s+([A-Za-z_][\w]*)|^class\s+([A-Za-z_][\w]*)/gm)) {
    const symbol = match[1] ?? match[2];
    if (symbol) symbols.add(symbol);
  }
  return [...symbols];
}

function typescriptLocalSymbolsOf(text: string): string[] {
  const symbols = new Set<string>();
  for (const match of text.matchAll(/(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) {
    const symbol = match[1];
    if (symbol) symbols.add(symbol);
  }
  return [...symbols];
}

function pythonImportsOf(fromPath: string, text: string, root: string): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/^\s*(?:from\s+([\w.]+)\s+)?import\s+([\w.,\s]+)$/gm)) {
    const module = match[1] ?? "";
    const names = (match[2] ?? "")
      .split(",")
      .map((name) => name.trim().split(" ")[0] ?? "")
      .filter(Boolean);
    for (const name of names) {
      const base = module ? module.replaceAll(".", "/") : dirname(fromPath);
      const candidate = `${base}/${name}.py`;
      if (!seen.has(candidate) && existsFile(join(root, candidate))) {
        seen.add(candidate);
        resolved.push(candidate);
      }
    }
  }
  return resolved;
}

function loaderFor(path: string): ModuleLoader {
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".jsx")) return "jsx";
  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) return "ts";
  return "js";
}

function existsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
