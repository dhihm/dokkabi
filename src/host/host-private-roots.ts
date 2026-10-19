import { basename, dirname, join } from "node:path";
import { DOCKER_TOOL_CACHE_ROOT, SANDBOX_DOKKABI_HOME } from "./sandbox-env.ts";

/** Seatbelt per-policy runtime (sandbox.ts createSeatbeltRuntime). */
export const SEATBELT_SESSION_DIR_PREFIX = "dokkabi-seatbelt-session-";
/** Linux judged/session tool-cache holder (tool-cache.ts makeHolder). */
export const TOOL_CACHE_HOLDER_DIR_PREFIX = "dokkabi-tool-cache-";
export const SEATBELT_HOME_DIR = "home";
export const SEATBELT_TEMP_DIR = "tmp";
export const SEATBELT_HOME_TOOL_CACHE_SUFFIX = ".cache/dokkabi-tools";

export function homeDefaultToolCachePath(home: string): string {
  return join(home, SEATBELT_HOME_TOOL_CACHE_SUFFIX);
}

export function seatbeltRuntimePaths(sessionRoot: string): { readonly root: string; readonly home: string; readonly temp: string } {
  return Object.freeze({
    root: sessionRoot,
    home: join(sessionRoot, SEATBELT_HOME_DIR),
    temp: join(sessionRoot, SEATBELT_TEMP_DIR),
  });
}

function seatbeltRoleSessionRoot(path: string, role: "home" | "temp"): string | undefined {
  const leaf = role === "home" ? SEATBELT_HOME_DIR : SEATBELT_TEMP_DIR;
  if (!path.endsWith(`/${leaf}`)) return undefined;
  const sessionRoot = dirname(path);
  return basename(sessionRoot).startsWith(SEATBELT_SESSION_DIR_PREFIX) ? sessionRoot : undefined;
}

export function isHomeDefaultToolCachePath(toolCachePath: string, home?: string): boolean {
  if (home !== undefined) return toolCachePath === homeDefaultToolCachePath(home);
  return toolCachePath.endsWith(`/${SEATBELT_HOME_TOOL_CACHE_SUFFIX}`);
}

export function toolCacheHolderPath(cacheDir: string): string {
  if (!cacheDir.endsWith("/cache")) throw new Error("execution_view_dispatch_private_roots");
  const holder = dirname(cacheDir);
  if (!basename(holder).startsWith(TOOL_CACHE_HOLDER_DIR_PREFIX)) throw new Error("execution_view_dispatch_private_roots");
  return holder;
}

function isDockerToolCachePath(path: string): boolean {
  return path === DOCKER_TOOL_CACHE_ROOT;
}

export type ToolCacheKind = "holder" | "home-default" | "docker";

/** Which tool-cache layout a private root path uses (execute and replay must agree). */
export function toolCacheKind(path: string): ToolCacheKind {
  if (isDockerToolCachePath(path)) return "docker";
  if (path.endsWith("/cache")) {
    toolCacheHolderPath(path);
    return "holder";
  }
  if (isHomeDefaultToolCachePath(path)) return "home-default";
  throw new Error("execution_view_dispatch_private_roots");
}

function homeDefaultToolCacheHomePath(toolCachePath: string): string {
  return toolCachePath.slice(0, -(SEATBELT_HOME_TOOL_CACHE_SUFFIX.length + 1));
}

/** Host tmpdir for a home-default tool cache: dirname(sessionRoot), not dirname(home). */
function homeDefaultToolCacheHostTmpdirAnchor(toolCachePath: string): string {
  const homePath = homeDefaultToolCacheHomePath(toolCachePath);
  const sessionRoot = seatbeltRoleSessionRoot(homePath, "home");
  return sessionRoot ? dirname(sessionRoot) : dirname(homePath);
}

/** Enrolled holders must live directly under the host tmpdir anchor, not nested deeper. */
export function assertHostPrivateRootDirectChildOfAnchor(anchor: string, path: string, role: "home" | "temp" | "tool_cache"): void {
  if (role === "tool_cache") {
    if (path.endsWith("/cache")) {
      const holder = dirname(path);
      if (dirname(holder) !== anchor) throw new Error("execution_view_dispatch_private_roots");
      return;
    }
    if (isHomeDefaultToolCachePath(path)) {
      if (homeDefaultToolCacheHostTmpdirAnchor(path) !== anchor) throw new Error("execution_view_dispatch_private_roots");
      return;
    }
    if (isDockerToolCachePath(path) && dirname(DOCKER_TOOL_CACHE_ROOT) !== anchor) {
      throw new Error("execution_view_dispatch_private_roots");
    }
    return;
  }
  const session = seatbeltRoleSessionRoot(path, role);
  if (!session || dirname(session) !== anchor) throw new Error("execution_view_dispatch_private_roots");
}

function isBwrapSandboxHomePath(path: string): boolean {
  return path === SANDBOX_DOKKABI_HOME;
}

/** Host tmpdir: parent of a Seatbelt session root or a tool-cache holder. */
export function hostPrivateTmpdirAnchor(path: string, role: "home" | "temp" | "tool_cache"): string {
  if (role === "tool_cache") {
    if (path.endsWith("/cache")) return dirname(toolCacheHolderPath(path));
    if (isHomeDefaultToolCachePath(path)) return homeDefaultToolCacheHostTmpdirAnchor(path);
    if (isDockerToolCachePath(path)) return dirname(DOCKER_TOOL_CACHE_ROOT);
    throw new Error("execution_view_dispatch_private_roots");
  }
  const session = seatbeltRoleSessionRoot(path, role);
  if (session) return dirname(session);
  throw new Error("execution_view_dispatch_private_roots");
}

export function assertHostPrivateRootShape(path: string, role: "home" | "temp" | "tool_cache"): void {
  if (role === "tool_cache") {
    if (path.endsWith("/cache")) {
      toolCacheHolderPath(path);
      return;
    }
    if (isHomeDefaultToolCachePath(path)) return;
    if (isDockerToolCachePath(path)) return;
    throw new Error("execution_view_dispatch_private_roots");
  }
  if (seatbeltRoleSessionRoot(path, role)) return;
  if (role === "home" && isBwrapSandboxHomePath(path)) return;
  throw new Error("execution_view_dispatch_private_roots");
}

/** Seatbelt dispatch home and temp must share one session root. */
export function assertSeatbeltHomeTempPair(home?: string, temp?: string): void {
  if (!home || !temp) return;
  const homeSession = seatbeltRoleSessionRoot(home, "home");
  const tempSession = seatbeltRoleSessionRoot(temp, "temp");
  if (!homeSession || !tempSession || homeSession !== tempSession) throw new Error("execution_view_dispatch_private_roots");
}
