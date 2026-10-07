import type { Analysis, StructuralGraph } from "../material.ts";
import type { LayoutManager } from "./layout.js";
export function assembleGraph(
  files: Map<string, { uid: string; hash: string; size: number; analysis: Analysis }>,
  layout: LayoutManager,
): StructuralGraph;
