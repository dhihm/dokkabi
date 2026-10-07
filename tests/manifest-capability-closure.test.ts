import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * A manifest that cannot satisfy its own plugins boots into a silent hang.
 *
 * A campaign ran a full pipeline to completion, recorded its goal done, and
 * then died on the independent acceptance gate with "acceptance verifier
 * requires llm and loop capabilities". The gate boots a reduced manifest, and
 * in that manifest the loop plugin declared a required consumer claim whose
 * provider was not listed. Nothing errored at load: the plugin simply stayed
 * `pending` forever, the loop capability never appeared, and the whole
 * verification of hours of work was lost at the last step.
 *
 * The claim was also wrong — the loop reaches that capability through tryGet
 * and an optional call, so it tolerates absence perfectly well. But the shape
 * of the failure is what matters: a manifest is a promise that its plugins can
 * be satisfied, and nothing was checking that promise. This does, statically,
 * for every manifest that ships.
 */

interface Claim {
  key: string;
  role: "definition" | "provider" | "consumer";
  optional?: boolean;
}

const MANIFEST_DIR = "plugins";

interface ManifestEntry {
  id: string;
  path?: string;
  package?: string;
}

/** The module a manifest entry resolves to. An entry may name the module
 * directly, or name a package whose descriptor names it. */
function moduleOf(manifestPath: string, entry: ManifestEntry): string {
  const base = dirname(manifestPath);
  if (entry.path) return resolve(base, entry.path);
  const descriptorPath = resolve(base, entry.package as string);
  const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as { module: string };
  return resolve(dirname(descriptorPath), descriptor.module);
}

function manifests(): { path: string; plugins: ManifestEntry[] }[] {
  return readdirSync(MANIFEST_DIR)
    .filter((name) => name.startsWith("manifest") && name.endsWith(".json"))
    .map((name) => {
      const path = join(MANIFEST_DIR, name);
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { plugins: ManifestEntry[] };
      return { path, plugins: parsed.plugins ?? [] };
    });
}

/**
 * Claims as the plugin itself declares them.
 *
 * Read by importing the module, not by parsing its text: one plugin builds its
 * claim list with a helper call rather than a literal, and a text scanner
 * reported it as claiming nothing — which reads exactly like a real gap.
 * Importing a plugin module only defines it; its effects run in register().
 */
async function claimsOf(sourcePath: string): Promise<Claim[]> {
  const mod = await import(sourcePath) as { plugin?: { claims?: Claim[] } };
  return mod.plugin?.claims ?? [];
}

async function capabilityMap(manifest: { path: string; plugins: ManifestEntry[] }) {
  const entries = await Promise.all(manifest.plugins.map(async (plugin) => ({
    id: plugin.id,
    claims: await claimsOf(moduleOf(manifest.path, plugin)),
  })));
  const provided = new Set(entries.flatMap((entry) =>
    entry.claims.filter((claim) => claim.role === "provider").map((claim) => claim.key)));
  return { entries, provided };
}

describe("every shipped manifest can satisfy its own plugins", () => {
  const all = manifests();

  test("the manifests are found and parsed", () => {
    // A discovery that silently returns nothing would pass everything below.
    expect(all.length).toBeGreaterThan(1);
    expect(all.every((manifest) => manifest.plugins.length > 0)).toBe(true);
  });

  test("claim extraction actually finds claims", async () => {
    // Likewise: an extractor that finds nothing would report every manifest
    // closed. Both a provider and a consumer must come back.
    const loop = await claimsOf(resolve("src/plugins/loop-pi.ts"));
    expect(loop.some((claim) => claim.key === "loop" && claim.role === "provider")).toBe(true);
    expect(loop.some((claim) => claim.role === "consumer")).toBe(true);
    const routes = await claimsOf(resolve("src/plugins/llm-routes.ts"));
    expect(routes.some((claim) => claim.key === "llm" && claim.role === "provider")).toBe(true);
  });

  test("no manifest leaves a required consumer without a provider", async () => {
    for (const manifest of all) {
      const { entries, provided } = await capabilityMap(manifest);
      const unmet = entries.flatMap((entry) =>
        entry.claims
          .filter((claim) => claim.role === "consumer" && !claim.optional && !provided.has(claim.key))
          .map((claim) => `${entry.id} needs ${claim.key}`));
      expect({ manifest: manifest.path, unmet }).toEqual({ manifest: manifest.path, unmet: [] });
    }
  });

  test("the acceptance manifests can raise a loop, which is what the gate needs", async () => {
    // Named directly because these two are the capabilities whose absence cost
    // a completed campaign its independent verification.
    const gates = all.filter((manifest) => manifest.path.includes("accept"));
    expect(gates.length).toBeGreaterThan(0);
    for (const manifest of gates) {
      const { provided } = await capabilityMap(manifest);
      expect({ manifest: manifest.path, loop: provided.has("loop"), llm: provided.has("llm") })
        .toEqual({ manifest: manifest.path, loop: true, llm: true });
    }
  });
});
