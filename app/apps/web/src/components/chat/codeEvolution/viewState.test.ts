import { describe, it, expect } from "vite-plus/test";
import fixture from "./retained.fixture.json";
import { acceptCodeIndex, codeReferenceKey, initialCodeView, selectCodeVersion } from "./viewState";
import type { WorkbenchCode } from "@t3tools/contracts";
const page: WorkbenchCode = { ...fixture, version: 1, body: null };
describe("owned Code live and historical selection", () => {
  it("keeps a historical pin when a new version is published, and live follows the last version", () => {
    let state = acceptCodeIndex(initialCodeView(), page);
    state = selectCodeVersion(state, codeReferenceKey(page.versions[0]!.reference));
    const last = page.versions.at(-1)!;
    const next = {
      ...page,
      sessionCursor: {
        ...page.sessionCursor,
        seq: page.sessionCursor.seq + 1,
        hash: "a".repeat(64),
      },
      versions: [
        ...page.versions,
        {
          ...last,
          reference: {
            ...last.reference,
            version: { seq: page.sessionCursor.seq + 1, hash: "a".repeat(64) },
            digest: "b".repeat(64),
          },
        },
      ],
    };
    state = acceptCodeIndex(state, next);
    expect(state.selected).toBe(codeReferenceKey(page.versions[0]!.reference));
    expect(selectCodeVersion(state, null).selected).toBe(
      codeReferenceKey(next.versions.at(-1)!.reference),
    );
  });
  it("keeps the last same-scope picture with a visible error on rewind or source replacement", () => {
    const state = acceptCodeIndex(initialCodeView(), page);
    const rewind = acceptCodeIndex(state, {
      ...page,
      sessionCursor: { ...page.sessionCursor, seq: 1 },
    });
    expect(rewind.error).not.toBeNull();
    expect(rewind.index).toBe(state.index);
    const replacement = acceptCodeIndex(state, {
      ...page,
      gatewayCursor: { ...page.gatewayCursor, generation: "c".repeat(64) },
    });
    expect(replacement.error).not.toBeNull();
    expect(replacement.index).toBe(state.index);
    expect(initialCodeView().index).toBeNull();
  });
  it("refuses immutable descriptor substitution and body-bearing indexes", () => {
    const state = acceptCodeIndex(initialCodeView(), page);
    const changed = {
      ...page,
      body: null,
      versions: page.versions.map((v) => ({ ...v, bytes: v.bytes + 1 })),
    };
    expect(acceptCodeIndex(state, changed).error).not.toBeNull();
    expect(acceptCodeIndex(initialCodeView(), { ...fixture, version: 1 }).error).not.toBeNull();
  });
});

it("unchanged acknowledgements reuse the picture and immutable descriptors", () => {
  const state = acceptCodeIndex(initialCodeView(), page);
  const copied: WorkbenchCode = {
    ...page,
    versions: page.versions.map((v) => ({
      ...v,
      reference: { ...v.reference, version: { ...v.reference.version } },
    })),
    changed: false,
  };
  expect(acceptCodeIndex(state, copied)).toBe(state);
  const advanced = acceptCodeIndex(state, {
    ...copied,
    sessionCursor: {
      ...copied.sessionCursor,
      seq: copied.sessionCursor.seq + 1,
      hash: "d".repeat(64),
    },
  });
  expect(advanced.index!.versions[0]).toBe(state.index!.versions[0]);
});
