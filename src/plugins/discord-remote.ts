import type { PluginModule } from "../loader/types.ts";
import { readDiscordRemoteConfig } from "../remote/discord-config.ts";
import { createDiscordRemoteAdapter } from "../remote/discord-adapter.ts";
import type { RemoteHost } from "../remote/types.ts";
import { RemoteConfigurationError } from "../remote/types.ts";
import { safeNoteText } from "../work/inbox.ts";

export const plugin: PluginModule = {
  id: "discord-remote",
  claims: [{ key: "remote", role: "consumer" }],
  activate() {
    const configured = readDiscordRemoteConfig();
    return configured.active ? { active: true } : { active: false, reason: configured.reason, kind: configured.kind };
  },
  // Activation already declines an unconfigured adapter; the same reading is
  // the boot's refusal should it change between the two (#230 round 4, D1'').
  preflight() {
    const configured = readDiscordRemoteConfig();
    if (!configured.active) throw new RemoteConfigurationError(configured.reason);
  },
  async register(ctx) {
    const configured = readDiscordRemoteConfig();
    if (!configured.active) throw new RemoteConfigurationError(configured.reason);
    const remove = await ctx.get<RemoteHost>("remote").registerAdapter(createDiscordRemoteAdapter({
      config: configured.config,
      onError(error) {
        ctx.log.append({
          kind: "observe",
          name: "remote/transport_failed",
          payload: { adapter_id: "discord", reason: safeNoteText(error.message) },
        });
      },
    }));
    ctx.effect(() => remove);
  },
};
