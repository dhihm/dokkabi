/** Dependency-free synchronous refusal protocol for sandboxed preloads. */
export const DESKTOP_SYNC_IPC_REFUSED_TYPE = "desktop-sync-ipc-refused";
export const DESKTOP_SYNC_IPC_REFUSED_MESSAGE = "This desktop operation was refused.";

export interface DesktopSyncIpcRefusal {
  readonly type: typeof DESKTOP_SYNC_IPC_REFUSED_TYPE;
  readonly message: string;
}

/** True when a sendSync result is the sanitized refusal envelope. */
export function isDesktopSyncIpcRefusal(value: unknown): value is DesktopSyncIpcRefusal {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; message?: unknown };
  return candidate.type === DESKTOP_SYNC_IPC_REFUSED_TYPE && typeof candidate.message === "string";
}
