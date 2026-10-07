import type { LayoutState } from "../material.ts";
export class LayoutManager {
  constructor(state?: LayoutState);
  toJSON(): LayoutState;
}
