import type { ExactPreparation } from "./exact-cache-types.ts";
import { validExactProof } from "./exact-cache-value.ts";
import { boundedValueSnapshot, type BoundedValueSnapshot } from "./prefetch-result.ts";
import { attachReadVersion, readVersionOf } from "../host/received-calls.ts";

type ExactDisposer = (() => void | Promise<void>) | undefined;

export type ExactAdmission =
  | { readonly kind: "reusable"; readonly snapshot: BoundedValueSnapshot;
    readonly validate: () => boolean; readonly dispose: ExactDisposer }
  | { readonly kind: "warm-only"; readonly dispose: ExactDisposer }
  | { readonly kind: "stale"; readonly dispose: ExactDisposer }
  | { readonly kind: "drop"; readonly dispose: ExactDisposer };

export function inspectExactPreparation(
  prepared: ExactPreparation<unknown>,
  maxResultBytes: number,
): ExactAdmission {
  let dispose: ExactDisposer;
  try {
    dispose = prepared.dispose;
    switch (prepared.kind) {
      case "warm-only":
        return { kind: "warm-only", dispose };
      case "reusable": {
        if (!validExactProof(prepared.validate)) return { kind: "stale", dispose };
        const snapshot = boundedValueSnapshot(prepared.result, maxResultBytes);
        // #224 P1''': the snapshot is a copy; the version of the bytes the
        // read returned travels with it, so an early lease that adopts this
        // candidate (SO-O2) still compares its re-hash to the read's digest.
        const version = readVersionOf(prepared.result);
        if (snapshot && version && snapshot.value !== null && typeof snapshot.value === "object") attachReadVersion(snapshot.value, version);
        return snapshot && snapshot.value !== undefined
          ? { kind: "reusable", snapshot, validate: prepared.validate, dispose }
          : { kind: "drop", dispose };
      }
      default:
        return { kind: "drop", dispose };
    }
  } catch (error) {
    if (error instanceof Error) return { kind: "drop", dispose };
    return { kind: "drop", dispose };
  }
}

export function inspectExactDisposer(
  prepared: ExactPreparation<unknown>,
): ExactDisposer {
  try {
    return prepared.dispose;
  } catch (error) {
    if (error instanceof Error) return undefined;
    return undefined;
  }
}
