import { createHash } from "node:crypto";
import { canonicalJson } from "../host/canonical.ts";
import type { ManifestPlugin } from "./types.ts";

export function manifestDigest(plugins: readonly ManifestPlugin[]): string {
  return createHash("sha256").update(canonicalJson(plugins)).digest("hex");
}
