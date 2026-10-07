import type { AgentTool } from "@earendil-works/pi-agent-core";
import { realpathSync, statSync } from "node:fs";
import type { HostContext, PluginModule } from "../loader/types.ts";
import type { WorkspaceVersionsApi } from "../host/workspace-versions.ts";
import { MODEL_INPUT_CONTRIBUTIONS_KEY, type ModelInputContributionRegistry } from "../host/model-input-contributions.ts";
import { createPolicy, disposeSandboxPolicy, spawnFencedService, type SandboxPolicy } from "../host/sandbox.ts";
import { DiagnosticsProvider, DIAGNOSTICS_SOURCE } from "../host/lsp/provider.ts";
import { enabledProfileIds, resolveProfile, PYTHON_EXTENSIONS, TYPESCRIPT_EXTENSIONS, type ServerProfile } from "../host/lsp/profiles.ts";
import type { ServiceProcess } from "../host/lsp/server.ts";
import { workspaceToolsPolicy } from "./workspace-tools.ts";

/**
 * Passive language-server diagnostics (#222, design memo §131).
 *
 * Opt-in (D6): `DOKKABI_LSP_DIAGNOSTICS=typescript,python`. Servers run as
 * session-owned helpers under a read-only, network-denied policy derived
 * from the session's own sandbox backend (D3), are fed committed receipts
 * from `workspace_versions`, and contribute bounded, recorded suffixes
 * through `model_input_contributions` (D2). A read-only log (replay, the
 * dashboard) starts nothing: it reads recorded rows only.
 *
 * `lsp_servers` is the ownership contract a second consumer (#229's
 * navigation) uses: `owner(profile).acquire(consumer)` returns a lease; the
 * process ends once when the last lease is released or this plugin unloads.
 */
export const plugin: PluginModule = {
  id: "lsp-diagnostics",
  claims: [
    { key: "tools", role: "consumer" },
    { key: "workspace_versions", role: "consumer" },
    { key: MODEL_INPUT_CONTRIBUTIONS_KEY, role: "consumer" },
    { key: "lsp_servers", role: "definition" },
    { key: "lsp_servers", role: "provider" },
  ],
  activate(ctx: HostContext) {
    if (ctx.log.isReadOnly) {
      // A replay loads what the recorded run loaded (constitution 5) and
      // starts nothing (register below).
      return ctx.log.events.some((event) => event.name === "plugin/load" && event.payload.id === "lsp-diagnostics")
        ? { active: true as const }
        : { active: false as const, reason: "not loaded in the recorded run", kind: "not_configured" as const };
    }
    const enabled = enabledProfileIds();
    if (!enabled.configured) return { active: false as const, reason: "DOKKABI_LSP_DIAGNOSTICS is not set", kind: "not_configured" as const };
    if ("invalid" in enabled) return { active: false as const, reason: enabled.invalid, kind: "invalid_configuration" as const };
    return { active: true as const };
  },
  register(ctx: HostContext) {
    ctx.define("lsp_servers", { visibility: "host_only", ownership: "lease", profiles: ["typescript", "python"] });
    if (ctx.log.isReadOnly) {
      ctx.provide("lsp_servers", { owner: () => undefined, replay: true });
      return;
    }
    const enabled = enabledProfileIds();
    if (!enabled.configured || "invalid" in enabled) return;
    const root = realpathSync.native(ctx.workspaceRoot);
    const stat = statSync(root, { bigint: true });
    const rootId = `${stat.dev}:${stat.ino}`;
    const tools = ctx.get<AgentTool[]>("tools");
    const sessionPolicy = workspaceToolsPolicy(tools);
    const versions = ctx.get<WorkspaceVersionsApi>("workspace_versions");
    const registry = ctx.get<ModelInputContributionRegistry>(MODEL_INPUT_CONTRIBUTIONS_KEY);
    const profiles: ServerProfile[] = [];
    const unavailable: Array<{ id: string; reason: string; extensions: readonly string[] }> = [];
    for (const id of enabled.ids) {
      const resolution = resolveProfile(id, { root });
      if (resolution.ok) profiles.push(resolution.profile);
      else unavailable.push({ id, reason: resolution.reason, extensions: id === "typescript" ? TYPESCRIPT_EXTENSIONS : PYTHON_EXTENSIONS });
    }
    // D3: the server's own policy — read-only (nothing it runs can write the
    // tree), network denied (read-only policies deny it), the session's
    // backend, the policy's allowlisted child environment and nothing more.
    let serverPolicy: SandboxPolicy | undefined;
    let policyRefusal: string | undefined;
    if (!sessionPolicy) policyRefusal = "no_session_policy";
    // A helper never runs unfenced: with the fence off it would run with the
    // operator's own environment and credentials.
    else if (sessionPolicy.disabled === true || sessionPolicy.backend === "none") policyRefusal = "sandbox_disabled";
    else if (sessionPolicy.backend === "docker") policyRefusal = "docker_backend_unsupported";
    else {
      try {
        serverPolicy = createPolicy({ mode: "read-only", workspaceRoot: root, backend: sessionPolicy.backend });
      } catch (error) {
        policyRefusal = `policy_refused:${error instanceof Error ? error.name : "error"}`;
      }
    }
    const spawn = (argv: readonly string[]): ServiceProcess => {
      if (!serverPolicy) throw new Error(policyRefusal ?? "no_policy");
      return spawnFencedService(serverPolicy, argv);
    };
    const provider = new DiagnosticsProvider({
      root,
      rootId,
      profiles: serverPolicy ? profiles : [],
      unavailableProfiles: serverPolicy ? unavailable : [...unavailable, ...profiles.map((profile) => ({
        id: String(profile.id), reason: policyRefusal ?? "no_policy", extensions: profile.extensions,
      }))],
      spawn,
      record: (name, payload) => ctx.log.append({ kind: "observe", name, payload }).seq,
    });
    for (const entry of unavailable) {
      try {
        ctx.log.append({ kind: "observe", name: "lsp/server", payload: { profile: entry.id, event: "unavailable", reason: entry.reason } });
      } catch { /* shown through the contribution notice as well */ }
    }
    const unsubscribe = versions.onCommitted((receipt) => provider.committed(receipt));
    const unregister = registry.register("lsp-diagnostics", provider);
    // #229 consumes the owners (leases) and, through `provider`, the shared
    // document contract: `syncCurrent` + `stateOf(profile).currentMatched`.
    ctx.provide("lsp_servers", { owner: (profile: string) => provider.owner(profile), source: DIAGNOSTICS_SOURCE, provider, root, rootId });
    ctx.effect(() => async () => {
      unsubscribe();
      unregister();
      await provider.dispose();
      if (serverPolicy) disposeSandboxPolicy(serverPolicy);
    });
  },
};
