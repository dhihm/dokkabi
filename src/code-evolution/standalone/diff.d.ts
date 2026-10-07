import type { StructuralGraph } from "../material.ts";
export function diffText(before: string, after: string): unknown;
export function structuralChanges(
  before: StructuralGraph | null,
  after: StructuralGraph,
  fileEvents: unknown[],
): unknown;
