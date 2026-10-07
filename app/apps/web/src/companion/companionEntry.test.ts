// @vitest-environment jsdom
/**
 * Entry and geometry contracts of the restricted companion shell (R6).
 *
 * The desktop host serves `/companion.html` from the web dist root through the
 * isolated partition and its CSP allows only same-origin scripts — these
 * checks pin the entry wiring the bundler must emit and the safe-token /
 * geometry facts the web side relies on from the runtime-validated
 * PresentationConfig.
 */
import {
  PRESENTATION_RECORD_COMPANION_LAYOUT_BOUNDS,
  PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS,
  PresentationTokensConfigSchema,
  RecordCompanionSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import companionHtml from "../../companion.html?raw";
import mainHtml from "../../index.html?raw";
import entrySource from "./main.tsx?raw";

it("ships a dedicated companion entry outside the main application entry", () => {
  // The one module script is the restricted child entry — no main bootstrap.
  const moduleScripts = [...companionHtml.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)];
  expect(moduleScripts.map((match) => match[1])).toEqual(["/src/companion/main.tsx"]);
  // The CSP the shell installs denies inline scripts: the document itself
  // must not carry any.
  expect(companionHtml.match(/<script(?![^>]*src=)/g)).toBeNull();
  expect(mainHtml).toContain('/src/bootstrap.ts"');
  // The main entry keeps its own document; the companion never mounts it.
  expect(companionHtml).not.toContain("/src/bootstrap.ts");
  expect(companionHtml).not.toContain('id="boot-shell"');
});

it("the restricted entry module mounts only the companion window", () => {
  expect(entrySource).toContain("RecordCompanionWindow");
  // The entry imports neither the application root nor any of its hosts,
  // coordinators or senders — only React DOM, the shared stylesheet and the
  // companion window component (prose mentions are not imports).
  expect(entrySource).toMatch(
    /import\s+\{[^}]*RecordCompanionWindow[^}]*\}\s+from\s+"\.\/RecordCompanionWindow"/,
  );
  expect(entrySource).toMatch(/import\s+"\.\.\/index\.css"/);
  expect(entrySource).toMatch(/import\s+ReactDOM\s+from\s+"react-dom\/client"/);
  for (const forbidden of [
    /from\s+"[^"]*AppRoot/,
    /from\s+"[^"]*(router|Router)/,
    /from\s+"[^"]*QueuedMessageSender/,
    /from\s+"[^"]*ElectronBrowserHost/,
    /from\s+"[^"]*\/state\//,
    /from\s+"~\//,
  ]) {
    expect(entrySource.match(forbidden)).toBeNull();
  }
});

it("the record companion layout defaults stay within their validated bounds", () => {
  const { defaultWidth, defaultHeight, minWidth, minHeight } =
    PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS;
  const bounds = PRESENTATION_RECORD_COMPANION_LAYOUT_BOUNDS;
  expect(defaultWidth).toBeGreaterThanOrEqual(bounds.defaultWidth.minimum);
  expect(defaultWidth).toBeLessThanOrEqual(bounds.defaultWidth.maximum);
  expect(defaultHeight).toBeGreaterThanOrEqual(bounds.defaultHeight.minimum);
  expect(defaultHeight).toBeLessThanOrEqual(bounds.defaultHeight.maximum);
  expect(minWidth).toBeGreaterThanOrEqual(bounds.minWidth.minimum);
  expect(minWidth).toBeLessThanOrEqual(bounds.minWidth.maximum);
  expect(minHeight).toBeGreaterThanOrEqual(bounds.minHeight.minimum);
  expect(minHeight).toBeLessThanOrEqual(bounds.minHeight.maximum);
  expect(defaultWidth).toBeGreaterThanOrEqual(minWidth);
  expect(defaultHeight).toBeGreaterThanOrEqual(minHeight);
});

it("relayed snapshots carry only the safe normalized token block", () => {
  const decode = Schema.decodeUnknownSync(RecordCompanionSnapshot);
  const encode = Schema.encodeUnknownSync(PresentationTokensConfigSchema);
  const tokens = encode({
    color: {
      background: "#0a0a0a",
      surface: null,
      text: null,
      muted: null,
      border: null,
      accent: null,
    },
    radius: { panel: "6px", control: "4px" },
    spacing: { base: "4px" },
    font: { family: null, familyMono: null, sizePrompt: "13px", sizeCode: "12px", lineHeight: 1.5 },
    transition: { durationMs: 120 },
  });
  const snapshot = {
    companionId: "c",
    scope: { environmentId: "env", threadId: "thread", providerInstanceId: null },
    scopeKey: '["env","thread",null]',
    descriptorRevision: 0,
    viewRevision: 0,
    presentationRevision: 1,
    view: { tab: "record", pin: null, after: null, selectedSeq: null },
    result: { status: "pending" },
    sourceLabel: "label",
    theme: { dark: true },
    tokens,
  };
  expect(() => decode(snapshot)).not.toThrow();
  // A computed-style-shaped or CSS-url value can never cross the closed
  // schema: url(...) and var(...) are refused by the safe token grammar.
  expect(() =>
    decode({
      ...snapshot,
      tokens: { ...tokens, color: { ...tokens.color, background: "url(https://evil.example/x)" } },
    }),
  ).toThrow();
});
