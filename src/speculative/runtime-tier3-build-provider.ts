import { createHash } from "node:crypto";

export const BUILD_TIER3_PROVIDER_DIGEST = createHash("sha256")
  .update("tier3:workspace-build:bun-transpiler-cache-v1")
  .digest("hex");
