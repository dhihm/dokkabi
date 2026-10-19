import { create } from "zustand";

import { terminalOpenRefusalKey, type TerminalOpenRefusalTarget } from "./lib/terminalOpenRefusal";

interface TerminalOpenRefusalStoreState {
  readonly byKey: Readonly<Record<string, string>>;
  setRefusal: (target: TerminalOpenRefusalTarget, message: string) => void;
  clearRefusal: (target: TerminalOpenRefusalTarget) => void;
}

export const useTerminalOpenRefusalStore = create<TerminalOpenRefusalStoreState>((set) => ({
  byKey: {},
  setRefusal: (target, message) =>
    set((state) => ({
      byKey: { ...state.byKey, [terminalOpenRefusalKey(target)]: message },
    })),
  clearRefusal: (target) =>
    set((state) => {
      const key = terminalOpenRefusalKey(target);
      if (!(key in state.byKey)) return state;
      const next = { ...state.byKey };
      delete next[key];
      return { byKey: next };
    }),
}));

export function selectTerminalOpenRefusal(
  byKey: Readonly<Record<string, string>>,
  target: TerminalOpenRefusalTarget,
): string | null {
  return byKey[terminalOpenRefusalKey(target)] ?? null;
}
