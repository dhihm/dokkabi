import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Domain instruction belongs beside the domain, not inside the harness.
 *
 * The harness is meant to attach to any work. A team using it for one campaign
 * still needs to tell the model things only that campaign knows — which phases
 * exist, what each gate must beat, which document is the standing procedure —
 * and the only places to put that were the harness's own prompts or a
 * hand-written order retyped every run. The first makes one domain the
 * harness's premise; the second is a contract nobody can enforce.
 *
 * A prompt pack is that instruction, kept outside the repository and named by
 * the operator. It reaches the model exactly the way a plugin's prompt does,
 * so nothing about the sealing or the projection changes, and it never becomes
 * something the next campaign has to remove.
 *
 * Packs are operator-owned by construction: only an absolute path the operator
 * configured is read, the pack declares its own id and order, and a pack that
 * is missing or malformed is reported and skipped rather than failing a boot
 * that has nothing to do with it.
 */

export const PROMPT_PACK_ENV = "DOKKABI_PROMPT_PACKS";
/** Packs land after every plugin contribution, so the domain has the last word
 * over the harness's own description of itself but cannot displace it. */
export const PROMPT_PACK_BASE_ORDER = 10_000;
const PACK_FILE = "pack.json";
const MAX_PACK_BYTES = 256 * 1024;
const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

export interface PromptPack {
  readonly id: string;
  readonly order: number;
  readonly text: string;
  readonly digest: string;
  readonly source: string;
}

export interface PromptPackProblem {
  readonly source: string;
  readonly reason: string;
}

export interface PromptPackScan {
  readonly packs: readonly PromptPack[];
  readonly problems: readonly PromptPackProblem[];
}

/** The directories an operator named, in order, ignoring empty entries. */
export function promptPackRoots(env: NodeJS.Dict<string>): string[] {
  const raw = env[PROMPT_PACK_ENV];
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  return raw.split(":").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function readPack(root: string, index: number): PromptPack | PromptPackProblem {
  if (!isAbsolute(root)) {
    // A relative pack path would resolve against whatever directory the run
    // happened to start in, which is not a thing the operator chose.
    return { source: root, reason: "prompt pack path must be absolute" };
  }
  const descriptorPath = join(root, PACK_FILE);
  if (!existsSync(descriptorPath)) return { source: root, reason: `no ${PACK_FILE} in pack directory` };
  let descriptor: { schema_version?: unknown; id?: unknown; order?: unknown; prompts?: unknown };
  try {
    descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as typeof descriptor;
  } catch {
    return { source: descriptorPath, reason: `${PACK_FILE} is not valid JSON` };
  }
  if (descriptor.schema_version !== 1) {
    return { source: descriptorPath, reason: "pack schema_version must be 1" };
  }
  if (typeof descriptor.id !== "string" || !ID_PATTERN.test(descriptor.id)) {
    return { source: descriptorPath, reason: "pack id must be a lowercase identifier" };
  }
  const entries = Array.isArray(descriptor.prompts) ? descriptor.prompts : [];
  if (entries.length === 0) return { source: descriptorPath, reason: "pack declares no prompts" };
  const bodies: string[] = [];
  for (const entry of entries) {
    const path = (entry as { path?: unknown }).path;
    if (typeof path !== "string" || isAbsolute(path) || path.split(/[\\/]/u).includes("..")) {
      return { source: descriptorPath, reason: "pack prompt path must stay inside the pack" };
    }
    const promptPath = resolve(root, path);
    if (!existsSync(promptPath)) return { source: promptPath, reason: "pack prompt file is missing" };
    if (statSync(promptPath).size > MAX_PACK_BYTES) {
      return { source: promptPath, reason: `pack prompt exceeds ${MAX_PACK_BYTES} bytes` };
    }
    bodies.push(readFileSync(promptPath, "utf8").trim());
  }
  const text = bodies.filter(Boolean).join("\n\n");
  if (text.length === 0) return { source: descriptorPath, reason: "pack prompts are all empty" };
  const order = typeof descriptor.order === "number" && Number.isFinite(descriptor.order)
    ? descriptor.order
    : index;
  return {
    id: descriptor.id,
    order: PROMPT_PACK_BASE_ORDER + order,
    text,
    digest: createHash("sha256").update(text).digest("hex").slice(0, 16),
    source: root,
  };
}

function isProblem(value: PromptPack | PromptPackProblem): value is PromptPackProblem {
  return "reason" in value;
}

/** Every pack the operator named, and every one that could not be read. */
export function scanPromptPacks(env: NodeJS.Dict<string>): PromptPackScan {
  const packs: PromptPack[] = [];
  const problems: PromptPackProblem[] = [];
  const seen = new Set<string>();
  promptPackRoots(env).forEach((root, index) => {
    const result = readPack(root, index);
    if (isProblem(result)) {
      problems.push(result);
      return;
    }
    // Two packs under one id would each silently replace the other's
    // contribution depending on load order.
    if (seen.has(result.id)) {
      problems.push({ source: result.source, reason: `duplicate pack id ${result.id}` });
      return;
    }
    seen.add(result.id);
    packs.push(result);
  });
  return { packs, problems };
}

/** A pack directory holds pack.json beside its markdown. Exported for the
 * operator-facing message that explains what to create. */
export function promptPackLayoutHint(): string {
  return `${PROMPT_PACK_ENV}=/abs/pack1:/abs/pack2, each holding ${PACK_FILE} `
    + `{"schema_version":1,"id":"my-pack","order":0,"prompts":[{"id":"gates","path":"gates.md"}]}`;
}

export function promptPackDirectories(parent: string): string[] {
  if (!existsSync(parent)) return [];
  return readdirSync(parent)
    .map((name) => join(parent, name))
    .filter((path) => existsSync(join(path, PACK_FILE)));
}
