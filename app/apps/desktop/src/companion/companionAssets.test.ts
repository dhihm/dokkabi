// @effect-diagnostics nodeBuiltinImport:off -- Real temporary files exercise traversal refusal and the bundled-entry policy through the node APIs the asset server wraps.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePlatformPath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  RECORD_COMPANION_ENTRY_PATH,
  isAllowedCompanionRequestPath,
  isBlockedCompanionDevelopmentPath,
  makeCompanionContentSecurityPolicy,
  serveCompanionAsset,
  withCompanionContentSecurityPolicy,
} from "./companionAssets.ts";

describe("companion request path policy", () => {
  it("serves only the companion entry and static assets", () => {
    expect(isAllowedCompanionRequestPath(RECORD_COMPANION_ENTRY_PATH)).toBe(true);
    expect(isAllowedCompanionRequestPath("/assets/companion-B3x.js")).toBe(true);
    expect(isAllowedCompanionRequestPath("/assets/companion.css")).toBe(true);
    expect(isAllowedCompanionRequestPath("/favicon.ico")).toBe(true);
  });

  it("refuses the main application document and unknown shapes", () => {
    expect(isAllowedCompanionRequestPath("/")).toBe(false);
    expect(isAllowedCompanionRequestPath("/index.html")).toBe(false);
    expect(isAllowedCompanionRequestPath("/manifest.webmanifest")).toBe(false);
    expect(isAllowedCompanionRequestPath("/apple-touch-icon.png.webmanifest")).toBe(false);
    expect(isAllowedCompanionRequestPath("/some/route")).toBe(false);
    expect(isAllowedCompanionRequestPath("/api/anything")).toBe(false);
  });

  it("blocks exactly the main documents in development proxy mode", () => {
    expect(isBlockedCompanionDevelopmentPath("/")).toBe(true);
    expect(isBlockedCompanionDevelopmentPath("/index.html")).toBe(true);
    expect(isBlockedCompanionDevelopmentPath("/src/companionBootstrap.ts")).toBe(false);
    expect(isBlockedCompanionDevelopmentPath("/@vite/client")).toBe(false);
  });
});

describe("companion content security policy", () => {
  it("denies all network egress and inline scripts in production", () => {
    const policy = makeCompanionContentSecurityPolicy(false);
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("default-src 'none'");
    const directives = Object.fromEntries(
      policy.split("; ").map((directive) => {
        const [name, ...rest] = directive.split(" ");
        return [name, rest.join(" ")];
      }),
    );
    expect(directives["script-src"]).toBe("'self'");
    expect(directives["style-src"]).toBe("'self' 'unsafe-inline'");
    expect(directives["frame-src"]).toBe("'none'");
    expect(directives["form-action"]).toBe("'none'");
  });

  it("adds only the development inline module preamble", () => {
    const policy = makeCompanionContentSecurityPolicy(true);
    expect(policy).toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).toContain("connect-src 'none'");
  });

  it("stamps the policy and nosniff onto responses", () => {
    const response = withCompanionContentSecurityPolicy(
      new Response("body", { headers: { "content-type": "text/html" } }),
      makeCompanionContentSecurityPolicy(false),
    );
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

let assetDirCounter = 0;
function makeAssetRoot(): string {
  assetDirCounter += 1;
  return NodePath.join(
    NodeOs.tmpdir(),
    `dokkabi-companion-assets-${process.pid}-${assetDirCounter}`,
  );
}
function writeAssetsPlain(root: string, withEntry: boolean): void {
  NodeFs.mkdirSync(NodePath.join(root, "assets"), { recursive: true });
  if (withEntry) {
    NodeFs.writeFileSync(NodePath.join(root, "companion.html"), "<!doctype html>");
  }
  NodeFs.writeFileSync(NodePath.join(root, "assets", "companion.js"), "export {}");
  NodeFs.writeFileSync(NodePath.join(root, "index.html"), "<!doctype html>");
}
function removeAssetRootPlain(root: string): void {
  NodeFs.rmSync(root, { recursive: true, force: true });
}

describe("companion asset serving", () => {
  const runtime = Layer.mergeAll(NodeFileSystem.layer, NodePlatformPath.layer);

  it.effect("serves the bundled companion entry with its content type", () =>
    Effect.gen(function* () {
      const root = makeAssetRoot();
      yield* Effect.sync(() => writeAssetsPlain(root, true));

      const page = yield* serveCompanionAsset(new Request("dokkabi://app/companion.html"), root);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");

      const asset = yield* serveCompanionAsset(
        new Request("dokkabi://app/assets/companion.js"),
        root,
      );
      expect(asset.status).toBe(200);

      yield* Effect.sync(() => removeAssetRootPlain(root));
    }).pipe(Effect.provide(runtime)),
  );

  it.effect("refuses the main document, traversal and missing files without fallback", () =>
    Effect.gen(function* () {
      const root = makeAssetRoot();
      yield* Effect.sync(() => writeAssetsPlain(root, false));
      const main = yield* serveCompanionAsset(new Request("dokkabi://app/"), root);
      const index = yield* serveCompanionAsset(new Request("dokkabi://app/index.html"), root);
      const missing = yield* serveCompanionAsset(new Request("dokkabi://app/companion.html"), root);
      const traversal = yield* serveCompanionAsset(
        new Request("dokkabi://app/../../etc/passwd"),
        root,
      );
      const encoded = yield* serveCompanionAsset(
        new Request("dokkabi://app/%2e%2e%2f%2e%2e/passwd"),
        root,
      );
      const nul = yield* serveCompanionAsset(new Request("dokkabi://app/companion.html%00"), root);
      expect(main.status).toBe(404);
      expect(index.status).toBe(404);
      // No SPA fallback: a missing companion asset stays missing.
      expect(missing.status).toBe(404);
      // Traversal toward the operator's files cannot escape the asset root.
      expect(traversal.status).toBe(404);
      expect(encoded.status).toBe(404);
      expect(nul.status).toBe(400);
      yield* Effect.sync(() => removeAssetRootPlain(root));
    }).pipe(Effect.provide(runtime)),
  );
});
