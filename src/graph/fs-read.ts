import type { GraphStore } from "./store.ts";

/**
 * Constitution check (docs/graph.md): an fs.read observe digest must equal
 * the digest of that file node at this graph rev. A mismatch means the world
 * moved under the reader — fail closed.
 */
export function verifyFsReadDigest(store: GraphStore, relativePath: string, readDigest: string): void {
  const node = store.fileNode(relativePath);
  if (!node) {
    throw new Error(`fs.read mismatch: no file node for ${relativePath} at graph_rev ${store.rev}`);
  }
  if (node.digest !== readDigest) {
    throw new Error(
      `fs.read mismatch: ${relativePath} digest ${readDigest} != graph node ${node.digest} at graph_rev ${store.rev}`,
    );
  }
}
