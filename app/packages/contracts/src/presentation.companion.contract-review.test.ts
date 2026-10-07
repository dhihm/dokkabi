import { expect, it } from "vite-plus/test";
import {
  PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS,
  decodePresentationOverrideValue,
  mergePresentationConfig,
  validatePresentationConfig,
  type PresentationConfig,
} from "./presentation.ts";
const oldDefaults = {
  schemaVersion: 1,
  tokens: {
    color: { background: null, surface: null, text: null, muted: null, border: null, accent: null },
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
    inlineBreakpoint: 1200,
  },
} as unknown as PresentationConfig;

it("old v1 defaults inherit a complete companion geometry before validation", () => {
  const result = mergePresentationConfig(oldDefaults, { schemaVersion: 1 });
  expect(result.layout.recordCompanion).toEqual(PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS);
  expect(validatePresentationConfig(result)).toEqual([]);
});
it("a partial companion override merges with shared defaults field by field", () => {
  const decoded = decodePresentationOverrideValue({
    schemaVersion: 1,
    layout: { recordCompanion: { defaultWidth: 900 } },
  });
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) return;
  const result = mergePresentationConfig(oldDefaults, decoded.document);
  expect(result.layout.recordCompanion).toEqual({
    ...PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS,
    defaultWidth: 900,
  });
  expect(validatePresentationConfig(result)).toEqual([]);
});
it("minimum/default contradictions refuse even when each integer is individually valid", () => {
  const result = mergePresentationConfig(oldDefaults, {
    schemaVersion: 1,
    layout: { recordCompanion: { defaultWidth: 600, minWidth: 800 } },
  });
  expect(
    validatePresentationConfig(result).some((issue) => issue.path === "/layout/recordCompanion"),
  ).toBe(true);
});
