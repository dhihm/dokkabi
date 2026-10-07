import type { AgentTool } from "@earendil-works/pi-agent-core";
import { canonicalJson } from "../host/canonical.ts";

/** Expose union fields to tool encoders that inspect the object root.
 * Keep every original branch: projection must not widen argument validation.
 * TypeBox symbols survive the spread, preserving its conversion semantics.
 */
export function objectRootTool(tool: AgentTool): AgentTool {
  const schema = tool.parameters as Record<string, unknown>;
  if (schema.type !== undefined || schema.properties !== undefined || !Array.isArray(schema.anyOf) || !schema.anyOf.length) return tool;
  const branches = schema.anyOf as Record<string, unknown>[];
  if (!branches.every(branch => branch && branch.type === "object" && branch.properties && typeof branch.properties === "object" && !Array.isArray(branch.properties))) return tool;

  const fields = new Map<string, Map<string, unknown>>();
  for (const branch of branches) {
    for (const [name, property] of Object.entries(branch.properties as Record<string, unknown>)) {
      const choices = fields.get(name) ?? new Map<string, unknown>();
      choices.set(canonicalJson(property), property);
      fields.set(name, choices);
    }
  }
  const properties = Object.fromEntries([...fields].map(([name, choices]) => {
    const variants = [...choices.values()];
    return [name, variants.length === 1 ? variants[0] : { anyOf: variants }];
  }));
  const required = (Array.isArray(branches[0]!.required) ? branches[0]!.required : [])
    .filter(name => branches.every(branch => Array.isArray(branch.required) && branch.required.includes(name)));
  return { ...tool, parameters: {
    ...schema, type: "object", properties, required,
    ...(branches.every(branch => branch.additionalProperties === false) ? { additionalProperties: false } : {}),
  } as AgentTool["parameters"] };
}
