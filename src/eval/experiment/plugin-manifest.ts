import { basename, dirname, join } from "node:path";

/** Each research surface is an explicit registered manifest. No capability
 * is synthesized by the work loop, and unknown surfaces refuse at boot. */
export function researchManifestPath(path: string): string {
  const name = basename(path);
  if (/^manifest\.research(?:\.[a-z-]+)*\.json$/u.test(name)) return path;
  const variants: Record<string, string> = {
    "manifest.json": "manifest.research.json",
    "manifest.model-loop.json": "manifest.research.model-loop.json",
    "manifest.ledger.json": "manifest.research.ledger.json",
    "manifest.plan-v2.json": "manifest.research.plan-v2.json",
    "manifest.experiment.json": "manifest.research.experiment.json",
    "manifest.plan-review.json": "manifest.research.plan-review.json",
    "manifest.accept-spec.json": "manifest.research.accept-spec.json",
    "manifest.accept-review.json": "manifest.research.accept-review.json",
    "manifest.experiment.plan-review.json": "manifest.research.experiment.plan-review.json",
    "manifest.experiment.accept-spec.json": "manifest.research.experiment.accept-spec.json",
    "manifest.experiment.accept-review.json": "manifest.research.experiment.accept-review.json",
  };
  if (!variants[name]) throw new Error("research manifest surface is not registered");
  return join(dirname(path), variants[name]);
}
