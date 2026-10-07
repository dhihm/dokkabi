import { resolve } from "node:path";
import { BlobStore } from "../host/blob-store.ts";
import { existsSync } from "node:fs";
import { PrepareUnavailable, type GoalContextContributionRegistry, type PluginModule } from "../loader/types.ts";
import { assertSwarmChildToolSchemaBinding } from "../swarm/child-capability.ts";
import { appendSessionParent } from "../swarm/events.ts";
import {
  appendSwarmMemoryBound,
  readBoundSwarmMemoryView,
  renderSwarmMemoryView,
} from "../swarm/memory-transport.ts";
import { validateSwarmMemoryViewV1 } from "../swarm/memory-view.ts";
import { isSwarmRole, SWARM_ROLES } from "../swarm/routes.ts";
import { createSwarmService, defaultSwarmDependencies } from "../swarm/service.ts";

const DIGEST = /^[a-f0-9]{64}$/u;

export const plugin: PluginModule = {
  id: "swarm",
  claims: [
    { key: "swarm", role: "definition", modelFacing: false },
    { key: "swarm", role: "provider", modelFacing: false },
    { key: "goal_context_contributions", role: "consumer", modelFacing: false },
    { key: "swarm_memory_contributions", role: "consumer", modelFacing: false },
    // The fixed child-safe tool core includes `maek` (#109), and the maek
    // tool mounts only when the service exists — a manifest that carries
    // swarm without maek would otherwise pass boot and then brick every
    // dispatch on the exact-schema check. Declare the dependency so the
    // manifest closure catches it statically.
    { key: "maek", role: "consumer", modelFacing: false },
  ],
  // Every refusal of a child's boot, checked by every boot right before
  // register and by the prepare phase (#230 round 4, D1''): register may not refuse.
  preflight(ctx) {
    childBinding(ctx);
  },
  register(ctx) {
    const binding = childBinding(ctx);
    if (binding) {
      appendSessionParent(ctx.log, {
        parentSession: binding.parentSession,
        parentOpenSeq: binding.parentOpenSeq,
        childSession: ctx.sessionId,
        role: binding.role,
        route: binding.route,
        contractDigest: binding.contractDigest,
      });
      ctx.log.append({
        kind: "observe",
        name: "swarm/capability_bound",
        payload: {
          child_session: ctx.sessionId,
          plugin_manifest_digest: binding.expectedManifestDigest,
          tool_schema_digest: binding.expectedToolSchemaDigest,
        },
      });
      appendSwarmMemoryBound(ctx.log, {
        childSession: ctx.sessionId,
        view: binding.view,
        blobDigest: binding.blobDigest,
        dispatchDigest: binding.contractDigest,
      });
      const bound = readBoundSwarmMemoryView(ctx.log, {
        childSession: ctx.sessionId,
        repositoryDigest: binding.repositoryDigest,
        viewDigest: binding.viewDigest,
        blobDigest: binding.blobDigest,
        dispatchDigest: binding.contractDigest,
        sourceSnapshotDigest: binding.view.sourceSnapshotDigest,
      });
      const rendered = renderSwarmMemoryView(bound);
      const contexts = ctx.get<GoalContextContributionRegistry>("goal_context_contributions");
      ctx.effect(() => contexts.register("swarm-memory", () => ({ text: rendered })));
    }
    const repoRoot = resolve(import.meta.dir, "..", "..");
    ctx.define("swarm", { roles: [...SWARM_ROLES] });
    ctx.provide("swarm", createSwarmService(ctx, defaultSwarmDependencies(repoRoot)));
  },
};

/** The child lineage the environment names, or undefined for a parent
 * session; throws the refusal a partial or malformed lineage is. */
export function swarmLineage(env: NodeJS.Dict<string> = process.env) {
  const keys = ["DOKKABI_PARENT_SESSION", "DOKKABI_SWARM_ROLE", "DOKKABI_SWARM_ROUTE", "DOKKABI_PARENT_EVENT_SEQ",
    "DOKKABI_SWARM_DISPATCH_DIGEST", "DOKKABI_SWARM_REPOSITORY_DIGEST", "DOKKABI_SWARM_MEMORY_VIEW_DIGEST",
    "DOKKABI_SWARM_MEMORY_BLOB_DIGEST", "DOKKABI_SWARM_PLUGIN_MANIFEST_DIGEST", "DOKKABI_SWARM_TOOL_SCHEMA_DIGEST"];
  if (!keys.some((key) => env[key] !== undefined)) return undefined;
  const parentSession = env.DOKKABI_PARENT_SESSION;
  const parentOpenSeq = Number(env.DOKKABI_PARENT_EVENT_SEQ);
  const role = env.DOKKABI_SWARM_ROLE;
  const route = env.DOKKABI_SWARM_ROUTE;
  const contractDigest = env.DOKKABI_SWARM_DISPATCH_DIGEST;
  const repositoryDigest = env.DOKKABI_SWARM_REPOSITORY_DIGEST;
  const viewDigest = env.DOKKABI_SWARM_MEMORY_VIEW_DIGEST;
  const blobDigest = env.DOKKABI_SWARM_MEMORY_BLOB_DIGEST;
  const expectedManifestDigest = env.DOKKABI_SWARM_PLUGIN_MANIFEST_DIGEST;
  const expectedToolSchemaDigest = env.DOKKABI_SWARM_TOOL_SCHEMA_DIGEST;
  if (!parentSession || !role || !isSwarmRole(role) || !route || !Number.isSafeInteger(parentOpenSeq) || parentOpenSeq < 1
    || !validDigest(contractDigest) || !validDigest(repositoryDigest) || !validDigest(viewDigest)
    || !validDigest(blobDigest) || !validDigest(expectedManifestDigest) || !validDigest(expectedToolSchemaDigest)) {
    throw new Error("invalid swarm child lineage environment");
  }
  return { parentSession, parentOpenSeq, role, route, contractDigest, repositoryDigest, viewDigest, blobDigest, expectedManifestDigest, expectedToolSchemaDigest };
}

/** The lineage with everything a child's boot checks against it: the
 * manifest its session opened with, the tool schema it binds, the staged
 * memory view. Read-only. What only a real boot has (its opened log, its
 * registered tools, its staged blob) a dry run lacks: PrepareUnavailable. */
function childBinding(ctx: import("../loader/types.ts").HostContext) {
  const lineage = swarmLineage();
  if (lineage === undefined) return undefined;
  if (!existsSync(ctx.log.path)) throw new PrepareUnavailable("a swarm child's boot state exists only in a real boot");
  const opened = ctx.log.events.find((event) =>
    event.name === "session/open" && event.payload.session_id === ctx.sessionId
  );
  if (opened?.payload.plugin_manifest_digest !== lineage.expectedManifestDigest) {
    throw new Error("swarm child plugin manifest digest mismatch");
  }
  assertSwarmChildToolSchemaBinding(ctx.toolSchemas, lineage.expectedToolSchemaDigest);
  let parsed: unknown;
  try {
    parsed = JSON.parse(BlobStore.forSession(ctx.log.path).get(lineage.blobDigest));
  } catch {
    throw new Error("staged swarm memory blob is unavailable or invalid");
  }
  validateSwarmMemoryViewV1(parsed);
  if (parsed.repositoryDigest !== lineage.repositoryDigest || parsed.digest !== lineage.viewDigest) {
    throw new Error("staged swarm memory view does not match child environment");
  }
  return { ...lineage, view: parsed };
}

function validDigest(value: string | undefined): value is string {
  return typeof value === "string" && DIGEST.test(value);
}
