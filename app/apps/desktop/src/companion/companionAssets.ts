/**
 * Restricted companion shell policy (Dokkabi R6).
 *
 * The companion child runs in its own isolated nonpersistent session
 * partition, whose protocol handler serves ONLY the bundled same-origin
 * companion entry and its static assets — never the main app's index.html
 * and never an SPA fallback. The content security policy denies every
 * network egress (connect-src 'none'), so the restricted renderer cannot
 * fetch or open a WebSocket even if it wanted to; navigation, new windows
 * and permissions are refused by the shell that installs this policy.
 *
 * Everything here is pure policy: the registry applies it to the real
 * session, and the tests exercise traversal, fallback and CSP strictness
 * without Electron.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Mime from "effect/unstable/http/Mime";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/** Isolated nonpersistent partition serving the companion shell. */
export const RECORD_COMPANION_PARTITION = "record-companion";

/** The one HTML document the partition serves. */
export const RECORD_COMPANION_ENTRY_PATH = "/companion.html";

/** Static asset extensions the bundled companion build emits. */
const COMPANION_ASSET_EXTENSION = /\.[a-z0-9]+$/;
const COMPANION_ALLOWED_ASSET_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".map",
  ".svg",
  ".png",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".wasm",
  ".json",
]);

/**
 * True when a request path may carry companion shell content. The main
 * application document ("/", "/index.html") is NOT companion content: a
 * compromised or curious renderer must not be able to boot the full app
 * (with its bridge assumptions) inside the restricted partition.
 */
export function isAllowedCompanionRequestPath(pathname: string): boolean {
  if (pathname === RECORD_COMPANION_ENTRY_PATH) return true;
  if (pathname.startsWith("/assets/")) return true;
  const extension = COMPANION_ASSET_EXTENSION.exec(pathname)?.[0]?.toLowerCase();
  if (extension === undefined) return false;
  return COMPANION_ALLOWED_ASSET_EXTENSIONS.has(extension);
}

/**
 * Development proxy gate: the Vite dev server addresses modules through
 * paths the production allowlist cannot know ("/src/…", "/@vite/…",
 * "/node_modules/…"), so development refuses exactly the main application
 * documents and lets the dev server serve the rest. The strict CSP still
 * applies; only the path grammar widens.
 */
export function isBlockedCompanionDevelopmentPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/index.html";
}

/**
 * The companion content security policy. Production denies every script
 * inline source and every connection; development additionally allows the
 * inline module preamble Vite injects for React refresh, and nothing else.
 * There is no configuration surface: the shell is restricted by design.
 */
export function makeCompanionContentSecurityPolicy(isDevelopment: boolean): string {
  return [
    "default-src 'none'",
    `script-src 'self'${isDevelopment ? " 'unsafe-inline'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'none'",
    "worker-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/** Applies the policy headers to a response served to the companion shell. */
export function withCompanionContentSecurityPolicy(response: Response, policy: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", policy);
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Serve one bundled companion asset. Unlike the main desktop asset server
 * there is NO index.html fallback: a path that is not an allowed companion
 * path, escapes the asset root, or does not exist is a hard 404, and only
 * GET/HEAD are honored.
 */
export const serveCompanionAsset = Effect.fn("desktop.companion.serveAsset")(function* (
  request: Request,
  assetDirectory: string,
): Effect.fn.Return<Response, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405 });
  }
  const pathname = yield* Effect.try(() => decodeURIComponent(url.pathname)).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (pathname === null || pathname.includes("\0")) return new Response(null, { status: 400 });
  if (!isAllowedCompanionRequestPath(pathname)) return new Response(null, { status: 404 });
  const root = path.resolve(assetDirectory);
  const assetPath = path.resolve(root, `.${pathname}`);
  if (assetPath !== root && !assetPath.startsWith(root + path.sep)) {
    return new Response(null, { status: 404 });
  }
  const stat = yield* fileSystem.stat(assetPath).pipe(Effect.orElseSucceed(() => null));
  if (stat?.type !== "File") return new Response(null, { status: 404 });
  const contents = yield* fileSystem.readFile(assetPath).pipe(Effect.orElseSucceed(() => null));
  if (contents === null) return new Response(null, { status: 404 });
  return new Response(request.method === "HEAD" ? null : new Uint8Array(contents), {
    headers: {
      "content-type": Option.getOrElse(Mime.getType(assetPath), () => "application/octet-stream"),
    },
  });
});
