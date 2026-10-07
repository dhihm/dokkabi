import { observationSeal, OBSERVATION_SCHEMA_DIGEST } from "../host/observation-schema.ts";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { currentSessionSchemaPayload, hasCurrentSessionSchema } from "../host/schema.ts";
import { HostContextImpl } from "./context.ts";
import { resolvePluginManifest, type ResolvedPlugin } from "./manifest.ts";
import { PluginLifecycleRuntime } from "./runtime.ts";
import type { BootPreparation, LoadResult, PluginModule } from "./types.ts";

/** Work-stage policy plugins the model-loop surface must refuse (contract §3). */
const MODEL_LOOP_POLICY_PLUGINS = new Set([
  "gate-runtime",
  "evaluation-runtime",
  "work-evidence",
  "work-artifacts",
  "acceptance-catalog",
  "prerequisite-runtime",
  "swarm",
]);

/** The model-facing judgement-tool plugins the refusal scopes to: the model
 * loop and the ledger both move judgement off the host, so neither may mount
 * a work-stage policy plugin beside its tool set. */
const JUDGEMENT_TOOL_PLUGINS = new Set(["model-loop-tools", "ledger-tools"]);

/** Recorded roots stay host-free when the workspace is inside this process cwd. */
function displayRoot(workspaceRoot: string): string {
  const cwd = process.cwd();
  const rel = relative(cwd, resolve(workspaceRoot));
  if (rel === "") return ".";
  if (!rel.startsWith("..") && !isAbsolute(rel)) return rel;
  return "external-workspace";
}

/**
 * The boot refusals decided before any plugin is imported, as one function
 * boot calls and `dokkabi doctor` calls to diagnose a profile (#230, D1).
 * Reads the plugin ids and the process environment only; throws exactly what
 * boot throws.
 */
export function assertManifestBootable(ids: readonly string[], env: NodeJS.Dict<string> = process.env): void {
  const requested = env.DOKKABI_EVAL_ABLATE ?? env.DOKKABI_EXPERIMENT_MANIFEST ?? env.DOKKABI_EXPERIMENT_REQUEST;
  if (requested !== undefined && !ids.includes("experiment-runtime")) {
    throw new Error("experiment request has no registered runtime");
  }
  if (ids.includes("experiment-runtime") && (ids[0] !== "gate-runtime" || ids[1] !== "experiment-runtime")) {
    throw new Error("experiment runtime must bind immediately after the gate registry and before other plugins");
  }
  // The model-loop surface moves judgement to the model; a work-stage policy
  // plugin mixed into it would reintroduce the host gates it exists without.
  // Scoped to manifests that mount a judgement-tool plugin (model-loop-tools
  // or ledger-tools) so the graph loop keeps its own policy plugins.
  const modelLoopPolicyPlugin = ids.find(id => ids.some(other => JUDGEMENT_TOOL_PLUGINS.has(other)) && MODEL_LOOP_POLICY_PLUGINS.has(id));
  if (modelLoopPolicyPlugin) {
    throw new Error(`model_loop_manifest_policy_plugin: ${modelLoopPolicyPlugin} must not be mounted beside model-loop-tools`);
  }
}

export async function loadPlugins(input: {
  ctx: HostContextImpl;
  manifestPath: string;
}): Promise<LoadResult> {
  const manifest = resolvePluginManifest(input.manifestPath);
  const digest = manifest.digest;
  assertManifestBootable(manifest.plugins.map((plugin) => plugin.id));
  // Two independent decisions. The boot boundary (session/open) is recorded on
  // EVERY boot, so a restart on the same build is a visible run boundary for
  // recentRunsDigest, TIMELINE, and turn numbering — without it, four restarts
  // read as one run. Plugin re-registration is separate: it is skipped when the
  // manifest is already live in this log (a prior plugin/runtime_ready with the
  // same digest), so a restart reuses the loaded fibers.
  const persist = !input.ctx.log.isReadOnly && !alreadyLoaded(input.ctx.log.events, digest, manifest.plugins.map((plugin) => plugin.id));
  if (!input.ctx.log.isReadOnly) input.ctx.log.appendBatchDurable(() => [{
    kind: "observe",
    name: "session/open",
    payload: {
      session_id: input.ctx.sessionId,
      workspace_root: displayRoot(input.ctx.workspaceRoot),
      plugin_manifest_digest: digest,
      ...currentSessionSchemaPayload(),
      observation_schema: OBSERVATION_SCHEMA_DIGEST,
    },
  }, observationSeal(manifest.plugins.map(plugin => plugin.id))]);

  // Resolve code and claims before any registration effect. A malformed later
  // plugin cannot leave earlier capabilities half-installed.
  const modules = await Promise.all(manifest.plugins.map(importPlugin));
  const runtime = new PluginLifecycleRuntime(
    input.ctx,
    manifest.plugins.map((resolved, order) => ({ resolved, order, module: modules[order]! })),
  );
  input.ctx.define("plugins", { lifecycle: "owned_fibers", mutation: "idle_only" });
  input.ctx.provide("plugins", runtime);
  try {
    const result = await runtime.boot(persist);
    if (persist) {
      input.ctx.log.append({
        kind: "observe",
        name: "plugin/runtime_ready",
        payload: {
          plugin_manifest_digest: digest,
          states: runtime.states(),
        },
      });
      input.ctx.log.append({
        kind: "observe",
        name: "agent/status",
        payload: { status: "idle" },
      });
    }
    return { digest, loaded: result.loaded, skipped: result.skipped, runtime };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

/**
 * The loader's part of a boot's prepare phase (#230 round 5, B0): the same
 * manifest resolution and pre-import refusals as `loadPlugins`, the same
 * imports and claim validation, then the runtime's prepare phase — the boot
 * loop stopped before `register`. Nothing is appended to the context's log.
 */
export async function preparePlugins(input: { ctx: HostContextImpl; manifestPath: string }): Promise<BootPreparation> {
  const none = new Map();
  let manifest: ReturnType<typeof resolvePluginManifest>;
  try {
    manifest = resolvePluginManifest(input.manifestPath);
    assertManifestBootable(manifest.plugins.map((plugin) => plugin.id));
  } catch (error) {
    return { status: "refused", stage: "manifest", plugins: none, cause: error };
  }
  const modules: PluginModule[] = [];
  for (const resolved of manifest.plugins) {
    try {
      modules.push(await importPlugin(resolved));
    } catch (error) {
      return { status: "refused", stage: "import", pluginId: resolved.id, plugins: none, cause: error };
    }
  }
  let runtime: PluginLifecycleRuntime;
  try {
    runtime = new PluginLifecycleRuntime(
      input.ctx,
      manifest.plugins.map((resolved, order) => ({ resolved, order, module: modules[order]! })),
    );
  } catch (error) {
    return { status: "refused", stage: "claims", plugins: none, cause: error };
  }
  return runtime.prepare();
}

async function importPlugin(resolved: ResolvedPlugin): Promise<PluginModule> {
  const mod: unknown = await import(pathToFileURL(resolved.modulePath).href);
  if (!isPluginExport(mod) || mod.plugin.id !== resolved.id) {
    throw new Error(`plugin ${resolved.id} did not export plugin.id=${resolved.id}`);
  }
  return mod.plugin;
}

function isPluginExport(value: unknown): value is { readonly plugin: PluginModule } {
  if (typeof value !== "object" || value === null || !("plugin" in value)) return false;
  const plugin = value.plugin;
  return typeof plugin === "object" && plugin !== null
    && "id" in plugin && typeof plugin.id === "string"
    && "claims" in plugin && Array.isArray(plugin.claims)
    && "register" in plugin && typeof plugin.register === "function";
}

function alreadyLoaded(events: readonly { name: string; payload: Record<string, unknown> }[], digest: string, ids: string[]): boolean {
  // The manifest is live iff its plugins were already booted in this log and no
  // later manifest supersedes them. Keyed on the newest session/open that
  // carries the CURRENT schema (older logs re-register), then on whether that
  // build's runtime became ready — decoupled from the per-boot boundary, which
  // is appended every start. The runtime_ready / plugin-load evidence may
  // predate the newest open (a restart appends a fresh open with no new
  // runtime_ready), so the scan starts at the newest current-schema open with a
  // matching digest and looks forward from THERE.
  // Anchor at the OLDEST open in the trailing streak of same-digest,
  // current-schema opens — the runtime_ready that made this build live follows
  // that first open, before the restart opens that share its digest.
  let anchor = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.name !== "session/open") continue;
    if (event.payload.plugin_manifest_digest === digest && hasCurrentSessionSchema(event.payload)) {
      anchor = i;
      continue;
    }
    // An older open for a different manifest (or pre-schema) ends the streak.
    break;
  }
  if (anchor < 0) return false;
  const after = events.slice(anchor + 1);
  const ready = after.find((event) =>
    event.name === "plugin/runtime_ready" && event.payload.plugin_manifest_digest === digest,
  );
  if (ready) return true;
  const loaded = after
    .filter((event) => event.name === "plugin/load" || event.name === "plugin/skip")
    .map((event) => String(event.payload.id ?? ""));
  return loaded.length === ids.length && new Set(loaded).size === ids.length
    && ids.every((id) => loaded.includes(id));
}

export function readManifestDigest(manifestPath: string): string {
  return resolvePluginManifest(manifestPath).digest;
}
