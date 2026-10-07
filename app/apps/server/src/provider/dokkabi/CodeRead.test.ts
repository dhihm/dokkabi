import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import type { WorkbenchCode } from "@t3tools/contracts";
import { verifyCodeRead } from "./CodeRead.ts";
const hex = (seed: string) => NodeCrypto.createHash("sha256").update(seed).digest("hex");
const cursor = {
  sessionId: "owned-code",
  seq: 10,
  hash: hex("head"),
  generation: hex("generation"),
};
const acknowledged = { ...cursor, seq: 8, hash: hex("acknowledged") };
const read = (revision: number | undefined, changed: boolean): WorkbenchCode => ({
  version: 1,
  sessionCursor: cursor,
  gatewayCursor: { seq: 1, hash: hex("gateway"), generation: hex("gateway-generation") },
  versions: [],
  body: null,
  resnapshot: false,
  changed,
  ...(revision === undefined
    ? {}
    : {
        observer: {
          state: "active",
          policyDigest: hex("policy"),
          paths: 1,
          checks: 1,
          reason: null,
          revision,
          window: 0,
          lifetimeChecks: 1,
          retainedVersions: 0,
          retainedBytes: 0,
        },
      }),
});

describe("recorded observer updates in Code reads", () => {
  it("acknowledges an in-prefix modern observer control without inventing a publication", () => {
    expect(verifyCodeRead(read(9, true), { after: acknowledged })).toBeNull();
    expect(verifyCodeRead(read(9, false), { after: acknowledged })).toContain("change flag");
  });
  it("quiet, absent, genesis or already acknowledged observer state does not grant changed", () => {
    for (const revision of [undefined, 0, 8]) {
      expect(verifyCodeRead(read(revision, false), { after: acknowledged })).toBeNull();
      expect(verifyCodeRead(read(revision, true), { after: acknowledged })).toContain(
        "change flag",
      );
    }
  });
  it("rejects an observer outside the authenticated source prefix, even for resnapshot", () => {
    for (const revision of [11, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(verifyCodeRead(read(revision, true), { after: acknowledged })).toContain(
        "observer revision",
      );
      expect(verifyCodeRead({ ...read(revision, true), resnapshot: true }, {})).toContain(
        "observer revision",
      );
    }
  });
  it("still rejects foreign or diverged acknowledgements before observer metadata", () => {
    expect(
      verifyCodeRead(read(9, true), { after: { ...acknowledged, sessionId: "foreign" } }),
    ).toContain("another session");
    expect(verifyCodeRead(read(9, true), { after: { ...cursor, hash: hex("forged") } })).toContain(
      "continuity",
    );
  });
});
