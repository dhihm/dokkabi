import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { durableResearchFile, researchHash, researchRead } from "./environment.ts";

/** Host-controlled policy transport for typed children. Never inherit the
 * parent's HOME or expose a sibling's provider credentials. */
export function stageChildResearchPolicy(home: string, env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const path = env.DOKKABI_RESEARCH_POLICY, hash = env.DOKKABI_RESEARCH_POLICY_SHA256;
  if (path === undefined && hash === undefined) return {};
  if (!path || !hash) throw new Error("child research policy binding is incomplete");
  const bytes = researchRead(dirname(path), basename(path));
  if (researchHash(bytes) !== hash) throw new Error("child research policy changed");
  const target = join(home, "research-policy.json");
  if (!existsSync(target)) durableResearchFile(target, bytes);
  if (researchHash(researchRead(home, "research-policy.json")) !== hash) throw new Error("staged child research policy changed");
  return { DOKKABI_RESEARCH_POLICY: target, DOKKABI_RESEARCH_POLICY_SHA256: hash };
}
