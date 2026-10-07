import type { PluginModule } from "../loader/types.ts";
import { createRemoteStatusRegistry } from "../remote/status.ts";

export const plugin: PluginModule = {
  id: "remote-status",
  claims: [
    { key: "remote_status", role: "definition" },
    { key: "remote_status", role: "provider" },
  ],
  register(ctx) {
    ctx.define("remote_status", { ordering: "manifest", modelFacing: false });
    ctx.provide("remote_status", createRemoteStatusRegistry());
  },
};
