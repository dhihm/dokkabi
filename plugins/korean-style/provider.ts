/**
 * Korean writing style package.
 *
 * Skills only: the package contributes no tool, no routing prompt, and no
 * capability of its own. Everything its skills describe is carried out through
 * capabilities that already exist — `mcp` for a dictionary server, the
 * workspace edit tools for the rewrite itself. The loader owns skill
 * installation from `plugin.json`, so this module only has to declare that the
 * package is inert and consumes nothing.
 */
import type { HostContext, PluginModule } from "../../src/loader/types.ts";

export const plugin: PluginModule = {
  id: "korean-style",
  claims: [],
  register(_ctx: HostContext): void {
    // Intentionally empty. The loader installs plugin.json's skills into the
    // skill registry; adding a runtime effect here would only make an inert
    // knowledge package look like a capability.
  },
};
