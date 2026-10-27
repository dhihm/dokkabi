/** Ambient keys that together name a private swarm child; see `swarmLineage`. */
export const SWARM_CHILD_LINEAGE_ENV_KEYS = Object.freeze([
  "DOKKABI_PARENT_SESSION",
  "DOKKABI_SWARM_ROLE",
  "DOKKABI_SWARM_ROUTE",
  "DOKKABI_PARENT_EVENT_SEQ",
  "DOKKABI_SWARM_DISPATCH_DIGEST",
  "DOKKABI_SWARM_REPOSITORY_DIGEST",
  "DOKKABI_SWARM_MEMORY_VIEW_DIGEST",
  "DOKKABI_SWARM_MEMORY_BLOB_DIGEST",
  "DOKKABI_SWARM_PLUGIN_MANIFEST_DIGEST",
  "DOKKABI_SWARM_TOOL_SCHEMA_DIGEST",
] as const);

/** True when any lineage key is set. Does not validate; `swarmLineage` refuses
 * a partial or malformed env during swarm preflight. */
export function swarmChildLineageEnvPresent(env: NodeJS.Dict<string> = process.env): boolean {
  return SWARM_CHILD_LINEAGE_ENV_KEYS.some((key) => env[key] !== undefined);
}
