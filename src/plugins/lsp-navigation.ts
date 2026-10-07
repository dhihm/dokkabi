import type { AgentTool } from "@earendil-works/pi-agent-core";
import { realpathSync, statSync } from "node:fs";
import type { HostContext, PluginModule, ToolContributionRegistry } from "../loader/types.ts";
import type { WorkspaceVersionsApi } from "../host/workspace-versions.ts";
import { LspNavigator, type LspServersCapability } from "../host/lsp/navigation.ts";
import { LspRenamer } from "../host/lsp-rename.ts";
import { createLspNavigationTool } from "../tools/lsp-navigation.ts";
import { createLspRenameTools } from "../tools/lsp-rename.ts";
import { registerWorkspaceVersionsWriter } from "./workspace-tools.ts";

/**
 * LSP navigation and rename plans (#229, design memo §134).
 *
 * Opt-in, and only on top of #222: `DOKKABI_LSP_NAVIGATION=1` adds the
 * read-only `lsp_navigate` tool; `DOKKABI_LSP_RENAME=1` adds
 * `lsp_rename_plan` / `lsp_rename_apply` (kept off by default: rename ships
 * after LN-C5–C10 are green, and the operator turns it on). The servers are
 * #222's — this plugin holds a lease per profile and syncs documents through
 * the shared provider (N5) — and every write goes through #221's
 * `workspace_versions` with the apply tool registered as its writer. On a
 * read-only log (replay, dashboard) the plugin activates exactly when the
 * recorded run loaded it, contributes the same tools so the tool profile
 * matches, and starts no server and no writer: each tool answers
 * `unavailable` (replay) without touching anything.
 */
export const LSP_NAVIGATION_ENV = "DOKKABI_LSP_NAVIGATION";
export const LSP_RENAME_ENV = "DOKKABI_LSP_RENAME";

function enabled(value: string | undefined): boolean {
  const normalised = value?.trim().toLowerCase();
  return normalised === "1" || normalised === "on" || normalised === "true";
}

export const plugin: PluginModule = {
  id: "lsp-navigation",
  claims: [
    { key: "tools", role: "consumer" },
    { key: "workspace_versions", role: "consumer" },
    { key: "lsp_servers", role: "consumer" },
    { key: "tool_contributions", role: "consumer", modelFacing: true },
  ],
  activate(ctx: HostContext) {
    if (ctx.log.isReadOnly) {
      return ctx.log.events.some((event) => event.name === "plugin/load" && event.payload.id === "lsp-navigation")
        ? { active: true as const }
        : { active: false as const, reason: "not loaded in the recorded run", kind: "not_configured" as const };
    }
    if (!enabled(process.env[LSP_NAVIGATION_ENV])) return { active: false as const, reason: `${LSP_NAVIGATION_ENV} is not set`, kind: "not_configured" as const };
    return { active: true as const };
  },
  register(ctx: HostContext) {
    const registry = ctx.inject<ToolContributionRegistry<AgentTool>>("tool_contributions");
    const servers = ctx.inject<LspServersCapability>("lsp_servers");
    const renameWanted = enabled(process.env[LSP_RENAME_ENV]);
    const contribute = (tool: AgentTool) => ctx.effect(() => {
      const dispose = registry.register(plugin.id, tool);
      return () => {
        void dispose();
      };
    });
    if (ctx.log.isReadOnly || servers.replay || !servers.provider) {
      // Constitution 5: a replay loads what the run loaded and runs nothing;
      // the recorded `lsp/navigation_tools` row says which tools that was.
      const recorded = [...ctx.log.events].reverse().find((event) => event.name === "lsp/navigation_tools");
      contribute(createLspNavigationTool({ replay: true }));
      if (recorded ? recorded.payload.rename === true : renameWanted) {
        for (const tool of createLspRenameTools({ replay: true })) contribute(tool);
      }
      return;
    }
    const root = servers.root ?? realpathSync.native(ctx.workspaceRoot);
    const rootId = servers.rootId ?? (() => {
      const stat = statSync(root, { bigint: true });
      return `${stat.dev}:${stat.ino}`;
    })();
    const record = (name: string, payload: Record<string, unknown>) => ctx.log.append({ kind: "observe", name, payload }).seq;
    const navigator = new LspNavigator({ servers, root, rootId, record });
    contribute(createLspNavigationTool({ navigator }));
    let renameContributed = false;
    if (renameWanted) {
      const tools = ctx.get<AgentTool[]>("tools");
      const versions = ctx.get<WorkspaceVersionsApi>("workspace_versions");
      let renamer: LspRenamer | undefined;
      const [planTool, applyTool] = createLspRenameTools({ renamer: () => renamer });
      // The apply tool's own object is the authority's registered writer.
      if (registerWorkspaceVersionsWriter(tools, applyTool)) {
        // M7: each apply's spans plan is minted by host code (the renamer's
        // default `mintSpansPlan`), never through the provided facade.
        renamer = new LspRenamer({ navigator, versions, writer: applyTool, root, rootId, log: ctx.log, record });
        contribute(planTool);
        contribute(applyTool);
        renameContributed = true;
      } else {
        ctx.log.append({ kind: "observe", name: "lsp/rename_plan", payload: { status: "unsupported", reason: "no_version_authority", plan: "", request: "", call: "", files: 0, edits: 0, patch_bytes: 0, documents: [] } });
      }
    }
    ctx.log.append({ kind: "observe", name: "lsp/navigation_tools", payload: { navigation: true, rename: renameContributed } });
    ctx.effect(() => async () => {
      await navigator.dispose();
    });
  },
};
