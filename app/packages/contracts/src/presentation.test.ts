import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  PRESENTATION_GRAPH_LAYOUT_DEFAULTS,
  PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS,
  PRESENTATION_SCHEMA_VERSION,
  PRESENTATION_TOKEN_PROPERTY_PATHS,
  PresentationConfigSchema,
  canonicalPresentationConfigJson,
  decodePresentationOverrideText,
  decodePresentationOverrideValue,
  mergePresentationConfig,
  validatePresentationConfig,
  type PresentationConfig,
} from "./presentation.ts";

const decodeOverride = decodePresentationOverrideValue;
const decodeConfig = Schema.decodeUnknownSync(PresentationConfigSchema);

const baseConfig: PresentationConfig = {
  schemaVersion: PRESENTATION_SCHEMA_VERSION,
  tokens: {
    color: {
      background: null,
      surface: null,
      text: null,
      muted: null,
      border: null,
      accent: null,
    },
    radius: { panel: null, control: null },
    spacing: { base: null },
    font: { family: null, familyMono: null, sizePrompt: null, sizeCode: null, lineHeight: null },
    transition: { durationMs: 160 },
  },
  layout: {
    mainWindow: { minWidth: 840, minHeight: 620, defaultWidth: 1100, defaultHeight: 780 },
    navigation: { minWidth: 200, defaultWidth: 240, maxWidth: 320 },
    conversation: { minWidth: 480 },
    rightPanel: { minWidth: 280, defaultWidth: 320, maxWidth: 440 },
    graph: PRESENTATION_GRAPH_LAYOUT_DEFAULTS,
    recordCompanion: PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS,
    inlineBreakpoint: 1200,
  },
};

describe("presentation override decoding", () => {
  it("accepts a valid override document", () => {
    const result = decodeOverride({
      schemaVersion: 1,
      tokens: { color: { background: "#101010" }, radius: { panel: "0.75rem" } },
      layout: { navigation: { defaultWidth: 280 } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.tokens?.color?.background).toBe("#101010");
      expect(result.document.layout?.navigation?.defaultWidth).toBe(280);
    }
  });

  it("rejects an unsupported schema version", () => {
    const result = decodeOverride({ schemaVersion: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path === "/schemaVersion")).toBe(true);
    }
  });

  it("rejects unknown token property names with a pointer to the field", () => {
    const result = decodeOverride({ schemaVersion: 1, tokens: { color: { shell: "#fff" } } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((candidate) => candidate.path !== null);
      expect(issue?.path).toBe("/tokens/color/shell");
    }
  });

  it("rejects unknown layout component names", () => {
    const result = decodeOverride({ schemaVersion: 1, layout: { goalSummary: {} } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path === "/layout/goalSummary")).toBe(true);
    }
  });

  it("rejects unknown top-level keys", () => {
    const result = decodeOverride({ schemaVersion: 1, components: {} });
    expect(result.ok).toBe(false);
  });

  it("rejects custom-property expressions, url() and arbitrary color text", () => {
    for (const value of ["var(--x)", "url(https://evil.example/x.png)", "not a color!", "#ff"]) {
      expect(decodeOverride({ schemaVersion: 1, tokens: { color: { text: value } } }).ok).toBe(
        false,
      );
    }
  });

  it("rejects malformed functional color literals, including numeric prefixes and empty arguments", () => {
    for (const value of [
      "rgb(1oops, 2, 3)",
      "rgb(1, 2,)",
      "rgb(1, 2, 3,)",
      "rgba()",
      "rgb(1 2 3 / )",
      "rgb(1 2 3 / 50% / 60%)",
      "rgb(1, 2, 3 / 50%)",
      "hsl(120, 50, 50%)",
      "hsl(120 50 50 / )",
      "rgb(1 2 3 4 5)",
      "rgb(--x, 2, 3)",
      "calc(1px + 2)",
      "hsl(400, 50%, 50%)",
      "rgb(300, 0, 0)",
      "rgb (12, 34, 56)",
      "rgb  (12, 34, 56)",
    ]) {
      const result = decodeOverride({ schemaVersion: 1, tokens: { color: { text: value } } });
      expect(result.ok).toBe(false);
    }
  });

  it("accepts well-formed functional color literals in both syntaxes", () => {
    for (const value of [
      "rgb(12, 34, 56)",
      "rgb( 12 34 56 )",
      "rgb(12 34 56 / 50%)",
      "rgba(12, 34, 56, 0.5)",
      "hsl(120, 50%, 50%)",
      "hsl(120 50% 50% / 25%)",
      "hsla(120, 50%, 50%, 0.25)",
      "rgb(0%, 100%, 50%)",
    ]) {
      const result = decodeOverride({ schemaVersion: 1, tokens: { color: { text: value } } });
      expect(result.ok).toBe(true);
    }
  });

  it("accepts supported safe color literals", () => {
    for (const value of [
      "#fff",
      "#ffffff",
      "#ffffffff",
      "rgb(12, 34, 56)",
      "rgba(12, 34, 56, 0.5)",
      "hsl(120, 50%, 50%)",
      "transparent",
      "rebeccapurple",
    ]) {
      const result = decodeOverride({ schemaVersion: 1, tokens: { color: { text: value } } });
      expect(result.ok).toBe(true);
    }
  });

  it("rejects negative and out-of-unit dimensions", () => {
    for (const value of ["-4px", "10em", "12", "calc(1rem + 1px)"]) {
      expect(decodeOverride({ schemaVersion: 1, tokens: { radius: { panel: value } } }).ok).toBe(
        false,
      );
    }
  });

  it("bounds dimensions per property", () => {
    expect(decodeOverride({ schemaVersion: 1, tokens: { radius: { panel: "99rem" } } }).ok).toBe(
      false,
    );
    expect(decodeOverride({ schemaVersion: 1, tokens: { font: { sizeCode: "40px" } } }).ok).toBe(
      false,
    );
  });

  it("rejects non-finite and out-of-range numbers", () => {
    expect(
      decodeOverride({ schemaVersion: 1, tokens: { transition: { durationMs: Number.NaN } } }).ok,
    ).toBe(false);
    expect(
      decodeOverride({ schemaVersion: 1, tokens: { transition: { durationMs: 99_999 } } }).ok,
    ).toBe(false);
    expect(decodeOverride({ schemaVersion: 1, layout: { inlineBreakpoint: 120 } }).ok).toBe(false);
  });

  it("preserves the 840x620 native main-window safety floor", () => {
    expect(
      decodeOverride({
        schemaVersion: 1,
        layout: { mainWindow: { minWidth: 600, minHeight: 400 } },
      }).ok,
    ).toBe(false);
    expect(
      decodeOverride({
        schemaVersion: 1,
        layout: { mainWindow: { minWidth: 900, minHeight: 700 } },
      }).ok,
    ).toBe(true);
  });

  it("rejects unsafe font family values", () => {
    for (const value of ["</style>", "Fake; url(x)", ""]) {
      const result = decodeOverride({ schemaVersion: 1, tokens: { font: { family: value } } });
      expect(result.ok).toBe(false);
    }
  });
});

describe("presentation text decoding", () => {
  it("reports a line pointer for malformed JSON", () => {
    const result = decodePresentationOverrideText('{\n  "schemaVersion": 1,\n}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const syntax = result.issues.find((issue) => issue.kind === "syntax");
      expect(syntax).toBeDefined();
      expect(syntax?.line).not.toBeNull();
      expect(syntax?.line).toBeGreaterThan(1);
    }
  });

  it("decodes from text exactly like from a value", () => {
    const result = decodePresentationOverrideText(
      JSON.stringify({ schemaVersion: 1, layout: { conversation: { minWidth: 520 } } }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("presentation config merge and layout rules", () => {
  it("merges object overrides by key and produces a complete config", () => {
    const merged = mergePresentationConfig(baseConfig, {
      schemaVersion: 1,
      tokens: { color: { background: "#0a0a0a" }, font: { lineHeight: 1.6 } },
      layout: { navigation: { defaultWidth: 280 } },
    });
    expect(merged.tokens.color.background).toBe("#0a0a0a");
    expect(merged.tokens.color.text).toBeNull();
    expect(merged.tokens.font.lineHeight).toBe(1.6);
    expect(merged.layout.navigation.minWidth).toBe(200);
    expect(merged.layout.navigation.defaultWidth).toBe(280);
    expect(merged.layout.navigation.maxWidth).toBe(320);
  });

  it("keeps unspecified token groups untouched", () => {
    const merged = mergePresentationConfig(baseConfig, {
      schemaVersion: 1,
      layout: { inlineBreakpoint: 1400 },
    });
    expect(merged.tokens).toEqual(baseConfig.tokens);
    expect(merged.layout.inlineBreakpoint).toBe(1400);
  });

  it("restores shipped defaults on null resets without breaking the complete config", () => {
    const overridden = mergePresentationConfig(baseConfig, {
      schemaVersion: 1,
      tokens: {
        color: { background: "#101418" },
        font: { lineHeight: 1.8 },
        transition: { durationMs: 300 },
      },
      layout: { navigation: { defaultWidth: 300 } },
    });
    expect(overridden.tokens.transition.durationMs).toBe(300);
    // A save is a fresh defaults ⊕ override merge: null restores the shipped
    // default for every token it names.
    const reset = mergePresentationConfig(baseConfig, {
      schemaVersion: 1,
      tokens: {
        color: { background: null },
        font: { lineHeight: null },
        transition: { durationMs: null },
      },
    });
    expect(reset).toEqual(baseConfig);
    expect(() => decodeConfig(reset)).not.toThrow();
  });

  it("treats a null transition policy as delegation, not a number", () => {
    const delegating: PresentationConfig = {
      ...baseConfig,
      tokens: { ...baseConfig.tokens, transition: { durationMs: null } },
    };
    expect(() => decodeConfig(delegating)).not.toThrow();
    // An explicit resource default like 160 stays valid; null overrides keep
    // delegating on a null-default resource.
    const pinned = mergePresentationConfig(delegating, {
      schemaVersion: 1,
      tokens: { transition: { durationMs: 160 } },
    });
    expect(pinned.tokens.transition.durationMs).toBe(160);
    // A null reset is a fresh defaults ⊕ override merge: on a null-default
    // resource it keeps delegating.
    const unpinned = mergePresentationConfig(delegating, {
      schemaVersion: 1,
      tokens: { transition: { durationMs: null } },
    });
    expect(unpinned.tokens.transition.durationMs).toBeNull();
    expect(() => decodeConfig(unpinned)).not.toThrow();
  });

  it("rejects inconsistent min/max ranges with a pointer", () => {
    const config = mergePresentationConfig(baseConfig, {
      schemaVersion: 1,
      layout: { navigation: { minWidth: 360 } },
    });
    const issues = validatePresentationConfig(config);
    expect(issues.some((issue) => issue.path === "/layout/navigation")).toBe(true);
  });

  it("rejects constraints that would hide the composer at minimum size", () => {
    const config = mergePresentationConfig(baseConfig, {
      schemaVersion: 1,
      layout: { mainWindow: { minWidth: 600 } },
    });
    const issues = validatePresentationConfig(config);
    expect(issues.some((issue) => issue.path === "/layout/mainWindow")).toBe(true);
  });

  it("rejects an inline breakpoint smaller than the panel minima sum", () => {
    const config = mergePresentationConfig(baseConfig, {
      schemaVersion: 1,
      layout: { inlineBreakpoint: 800 },
    });
    const issues = validatePresentationConfig(config);
    expect(issues.some((issue) => issue.path === "/layout/inlineBreakpoint")).toBe(true);
  });

  it("accepts the base config itself", () => {
    expect(validatePresentationConfig(baseConfig)).toEqual([]);
    expect(decodeOverride(baseConfig).ok).toBe(true);
  });
});

describe("presentation registry exports", () => {
  it("lists exactly the supported token property paths", () => {
    expect(PRESENTATION_TOKEN_PROPERTY_PATHS).toEqual([
      "color.background",
      "color.surface",
      "color.text",
      "color.muted",
      "color.border",
      "color.accent",
      "radius.panel",
      "radius.control",
      "spacing.base",
      "font.family",
      "font.familyMono",
      "font.sizePrompt",
      "font.sizeCode",
      "font.lineHeight",
      "transition.durationMs",
    ]);
  });

  it("canonical JSON is deterministic and key-ordered", () => {
    const first = canonicalPresentationConfigJson(baseConfig);
    const second = canonicalPresentationConfigJson(
      JSON.parse(JSON.stringify(baseConfig)) as PresentationConfig,
    );
    expect(first).toBe(second);
    expect(first).toContain('"layout":');
  });

  it("round-trips a complete config as an override-shaped document", () => {
    const decoded = decodeOverride(baseConfig);
    expect(decoded.ok).toBe(true);
  });

  it("rejects an override-shaped document as a complete config at IPC boundaries", () => {
    expect(() => decodeConfig({ schemaVersion: 1 })).toThrow();
    expect(() => decodeConfig({ schemaVersion: 1, tokens: {}, layout: {} })).toThrow();
    expect(() =>
      decodeConfig(
        mergePresentationConfig(baseConfig, {
          schemaVersion: 1,
          tokens: { transition: { durationMs: 220 } },
        }),
      ),
    ).not.toThrow();
    expect(() => decodeConfig(baseConfig)).not.toThrow();
  });
});
