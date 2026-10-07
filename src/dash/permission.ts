import type { UiAction } from "./keymap.ts";
import { pendingOperatorApproval } from "./operator-approval.ts";
import type { EventRecord } from "../host/schema.ts";

export interface PermissionInputRoute {
  captured: boolean;
  action?: UiAction;
}

/** The TUI calls this before the ordinary editor/keymap. */
export function routePermissionInput(
  events: readonly EventRecord[],
  key: string,
  interactive: boolean,
): PermissionInputRoute {
  const pending = pendingOperatorApproval(events);
  if (!interactive || !pending) return { captured: false };
  const action = key === "\x03"
    ? { type: "quit" } as const
    : permissionPromptAction(key, pending.kind, {
        persistentAuthorization: pending.kind === "github-admin"
          && (pending.approval.authorizeOwner || pending.approval.authorizeRepository),
        mcpEnrollment: pending.kind === "mcp" && pending.approval.operation === "server_enroll",
      });
  return {
    captured: true,
    ...(action ? { action } : {}),
  };
}

/** Direct modal routing. Unrecognised keys stay captured by the dialog. */
export function permissionPromptAction(
  key: string,
  kind: "ssh" | "github-admin" | "mcp" | "plugin-install" = "ssh",
  options: { persistentAuthorization?: boolean; mcpEnrollment?: boolean } | boolean = {},
): UiAction | undefined {
  const persistentAuthorization = typeof options === "boolean"
    ? options
    : options.persistentAuthorization === true;
  if (kind === "github-admin") {
    if (key === "1") return { type: "github-admin", text: "approve once" };
    if (key === "3" || key === "\x1b") return { type: "github-admin", text: "deny" };
    if (key === "4" && !persistentAuthorization) return { type: "permissions", text: "bypass" };
    return undefined;
  }
  if (kind === "mcp") {
    const enrollment = typeof options === "object" && options.mcpEnrollment === true;
    if (key === "1") return { type: "mcp", text: "approve once" };
    if (key === "2" && !enrollment) return { type: "mcp", text: "approve session" };
    if (key === "3" || key === "\x1b") return { type: "mcp", text: "deny" };
    if (key === "4" && !enrollment) return { type: "permissions", text: "bypass" };
    return undefined;
  }
  if (kind === "plugin-install") {
    if (key === "1") return { type: "plugin", text: "approve once" };
    if (key === "3" || key === "\x1b") return { type: "plugin", text: "deny" };
    return undefined;
  }
  if (key === "1") return { type: "ssh", text: "approve once" };
  if (key === "2") return { type: "ssh", text: "approve session" };
  if (key === "3" || key === "\x1b") return { type: "ssh", text: "deny" };
  if (key === "4") return { type: "permissions", text: "bypass" };
  return undefined;
}
