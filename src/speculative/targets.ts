import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_PREDICTION_TEXT = 64 * 1024;
const MAX_PREDICTIONS = 4;
const MAX_PREDICTION_MS = 10;
const ELIGIBLE_TOOLS = new Set(["grep", "glob", "git_status", "git_diff", "bash"]);
const SECRET_PATH = /(?:^|\/)(?:\.env(?:\..*)?|secrets?|credentials?|passwords?|tokens?|keys?|private)(?:\/|$)|(?:^|\/)(?:id_(?:rsa|ed25519)|auth\.json|\.npmrc)(?:$|\/)/iu;
const CANONICAL_ROOT = Symbol("dokkabi.canonical-prediction-root");
const VALIDATED_ROOT = Symbol("dokkabi.validated-prediction-root");

export type CanonicalPredictionRoot = Readonly<{
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly [CANONICAL_ROOT]: true;
}>;
export type ValidatedPredictionRoot = Readonly<{ readonly path: string; readonly [VALIDATED_ROOT]: true }>;

export interface ReadPrediction {
  readonly path: string;
}

export function extractReadPredictions(input: {
  readonly workspaceRoot: string;
  readonly tool: string;
  readonly text: string;
  readonly now?: () => number;
}): ReadPrediction[] {
  const root = createCanonicalPredictionRoot(input.workspaceRoot);
  const validated = validateCanonicalPredictionRoot(root);
  return validated ? extractReadPredictionsAtRoot(validated, input) : [];
}

export function createCanonicalPredictionRoot(workspaceRoot: string): CanonicalPredictionRoot {
  const path = realpathSync(workspaceRoot);
  const stats = lstatSync(path, { bigint: true });
  if (!stats.isDirectory()) throw new Error("Prediction workspace root must be a directory");
  const marker: true = true;
  return Object.freeze({ path, device: stats.dev, inode: stats.ino, [CANONICAL_ROOT]: marker });
}

export function validateCanonicalPredictionRoot(root: CanonicalPredictionRoot): ValidatedPredictionRoot | undefined {
  if (root[CANONICAL_ROOT] !== true) return undefined;
  try {
    const stats = lstatSync(root.path, { bigint: true });
    if (!stats.isDirectory() || stats.dev !== root.device || stats.ino !== root.inode) return undefined;
    const marker: true = true;
    return Object.freeze({ path: root.path, [VALIDATED_ROOT]: marker });
  } catch {
    return undefined;
  }
}

export function extractReadPredictionsAtRoot(
  root: ValidatedPredictionRoot,
  input: { readonly tool: string; readonly text: string; readonly now?: () => number },
): ReadPrediction[] {
  if (root[VALIDATED_ROOT] !== true) return [];
  if (!ELIGIBLE_TOOLS.has(input.tool)) return [];
  const now = input.now ?? (() => performance.now());
  const started = now();
  if (now() - started > MAX_PREDICTION_MS) return [];
  const seen = new Set<string>();
  const predictions: ReadPrediction[] = [];
  for (const line of input.text.slice(0, MAX_PREDICTION_TEXT).split(/\r?\n/u)) {
    if (now() - started > MAX_PREDICTION_MS) return [];
    const candidate = candidateFromLine(input.tool, line);
    if (!candidate) continue;
    const path = safeRelativeFile(root.path, candidate);
    if (now() - started > MAX_PREDICTION_MS) return [];
    if (!path || seen.has(path)) continue;
    seen.add(path);
    predictions.push({ path });
    if (predictions.length === MAX_PREDICTIONS) break;
  }
  return predictions;
}

export function safeRelativeFile(root: string, candidate: string): string | undefined {
  const normalized = candidate.trim().replaceAll("\\", "/");
  if (!normalized || SECRET_PATH.test(isAbsolute(normalized) ? relative(root, normalized) : normalized)) return undefined;
  const absolute = isAbsolute(normalized) ? normalized : resolve(root, normalized);
  try {
    const canonical = realpathSync(absolute);
    const canonicalRelative = relative(root, canonical);
    const stats = lstatSync(canonical, { bigint: true });
    if (canonicalRelative === "" || outside(root, canonical) || SECRET_PATH.test(canonicalRelative) || !stats.isFile() || stats.nlink !== 1n) {
      return undefined;
    }
    return canonicalRelative.split(sep).join("/");
  } catch {
    return undefined;
  }
}

function candidateFromLine(tool: string, line: string): string | undefined {
  if (tool === "grep") return line.match(/^(.+?):\d+:/u)?.[1];
  if (tool === "git_status") return line.match(/^.. (.+)$/u)?.[1]?.split(" -> ").at(-1);
  if (tool === "git_diff") return line.match(/^\+\+\+ b\/(.+)$/u)?.[1];
  if (tool === "bash") {
    return line.match(/File "([^"]+)", line \d+/u)?.[1]
      ?? line.match(/^\s*-->\s+(.+?):\d+:\d+\s*$/u)?.[1]
      ?? line.match(/(?:at\s+.*?\s+\()?([^\s():]+\.[a-zA-Z0-9]+):\d+(?::\d+)?\)?/u)?.[1];
  }
  return line.trim() || undefined;
}

function outside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}
