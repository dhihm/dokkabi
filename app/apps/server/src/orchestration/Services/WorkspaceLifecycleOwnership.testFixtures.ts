/**
 * Test fixtures for WorkspaceLifecycleOwnership.
 *
 * Production never falls back: `WorkspaceLifecycleOwnershipLive` fails
 * closed on lookup/canonicalization failure. These doubles exist ONLY in
 * test contexts — `WorkspaceLifecycleOwnershipNone` keeps harness-unaware
 * legacy tests application-owned, and `WorkspaceLifecycleOwnershipClaiming`
 * simulates an enabled harness adapter claiming exact roots.
 *
 * @module orchestration/Services/WorkspaceLifecycleOwnership.testFixtures
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  WorkspaceLifecycleOwnership,
  type WorkspaceLifecycleOwnershipShape,
} from "./WorkspaceLifecycleOwnership.ts";

const contains = (root: string, target: string): boolean => {
  const relative = NodePath.relative(NodePath.resolve(root), NodePath.resolve(target));
  return (
    relative === "" ||
    (!NodePath.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`))
  );
};

const shape = (roots: ReadonlyArray<string>): WorkspaceLifecycleOwnershipShape => ({
  harnessOwnedRoots: Effect.succeed([...roots]),
  instanceIsHarnessOwned: () => Effect.succeed(roots.length > 0),
  pathIsHarnessOwned: (target: string) =>
    Effect.succeed(roots.some((root) => contains(root, target))),
});

/** No harness ownership anywhere: existing legacy test contexts. */
export const WorkspaceLifecycleOwnershipNone = Layer.succeed(
  WorkspaceLifecycleOwnership,
  WorkspaceLifecycleOwnership.of(shape([])),
);

/** An enabled harness adapter claiming exact roots (lexical in tests). */
export const WorkspaceLifecycleOwnershipClaiming = (roots: ReadonlyArray<string>) =>
  Layer.succeed(WorkspaceLifecycleOwnership, WorkspaceLifecycleOwnership.of(shape(roots)));

/** Configurable per-path/instance behavior for fail-closed tests. */
export const WorkspaceLifecycleOwnershipBehavior = (impl: WorkspaceLifecycleOwnershipShape) =>
  Layer.succeed(WorkspaceLifecycleOwnership, WorkspaceLifecycleOwnership.of(impl));
