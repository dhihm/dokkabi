import { createHash } from "node:crypto";
import { canonicalJson } from "../host/canonical.ts";

/** The only tool surface a private swarm child is allowed to inherit. Optional
 * knowledge, GitHub, VPN, and remote contributors are intentionally absent.
 * `maek` stays: it reads only the child's own private session index, so it is
 * local recall, not an external-knowledge surface. */
export const SWARM_CHILD_SAFE_TOOL_NAMES = Object.freeze([
  "read",
  "write",
  "edit",
  "skill",
  "grep",
  "glob",
  "ls",
  "git_status",
  "git_diff",
  "git_log",
  "bash",
  "bash_poll",
  "bash_kill",
  "bash_wait",
  "bash_probe",
  // A child's own truncated output is offloaded to a blob and the hint tells
  // it to read the rest with probe_log. Without the tool that hint names
  // nothing, and the child is the one process that cannot ask anyone. It runs
  // a filter over a path it already owns under a sealed read-only policy with
  // the network denied, so it grants strictly less than the bash the child
  // already has.
  "probe_log",
  "maek",
] as const);

const SAFE_NAMES = new Set<string>(SWARM_CHILD_SAFE_TOOL_NAMES);
const DIGEST = /^[a-f0-9]{64}$/u;

/** Derive the expected child schema bytes from the parent's already sealed
 * schemas without claiming parity for optional parent-only contributions. */
export function swarmChildToolSchemaDigest(parentSchemas: readonly unknown[]): string {
  const selected = parentSchemas.filter((schema) => {
    const name = schemaName(schema);
    return name !== undefined && SAFE_NAMES.has(name);
  });
  assertExactSafeSchemas(selected, "parent child-safe");
  return digestSchemas(selected);
}

/** Run by the last child plugin after workspace-tools has finalized the child
 * surface. It rejects before a goal context or model prompt can be produced. */
export function assertSwarmChildToolSchemaBinding(
  childSchemas: readonly unknown[],
  expectedDigest: string,
): void {
  if (!DIGEST.test(expectedDigest)) throw new Error("invalid swarm child tool schema digest");
  assertExactSafeSchemas(childSchemas, "child");
  if (digestSchemas(childSchemas) !== expectedDigest) {
    throw new Error("swarm child tool schema digest mismatch");
  }
}

function assertExactSafeSchemas(schemas: readonly unknown[], label: string): void {
  const names = schemas.map((schema) => {
    const name = schemaName(schema);
    if (!name) throw new Error(`${label} tool schema has no name`);
    if (!SAFE_NAMES.has(name)) throw new Error(`${label} tool schema ${name} is not child-safe`);
    return name;
  });
  if (names.length !== SWARM_CHILD_SAFE_TOOL_NAMES.length ||
    SWARM_CHILD_SAFE_TOOL_NAMES.some((name) => names.filter((candidate) => candidate === name).length !== 1)) {
    throw new Error(`${label} tool schemas do not match the fixed child-safe core`);
  }
}

function schemaName(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const name = (value as { readonly name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function digestSchemas(schemas: readonly unknown[]): string {
  return createHash("sha256").update(canonicalJson(schemas)).digest("hex");
}
