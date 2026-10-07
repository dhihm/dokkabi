/**
 * Token-to-CSS adapter for the presentation override layer.
 *
 * Maps exactly the registered R1 token property paths onto the shipped theme
 * variables. Values are installed as one removable root CSSOM stylesheet
 * whose declarations carry `!important`: the root element's inline style
 * keeps owning the user-selected appearance base (contrast derivations
 * re-resolve against the overridden base), and removing the layer restores
 * the current appearance values untouched.
 */
import type { PresentationTokenPropertyPath, PresentationTokensConfig } from "@t3tools/contracts";

import {
  DEFAULT_CODE_FONT_STACK,
  DEFAULT_SANS_FONT_STACK,
  cssFontFamilies,
} from "./appearanceFonts";

export const PRESENTATION_TOKEN_VARIABLES = {
  "color.background": "--background",
  "color.surface": "--card",
  "color.text": "--foreground",
  "color.muted": "--muted-foreground",
  "color.border": "--border",
  "color.accent": "--accent",
  "radius.panel": "--radius",
  // Tailwind inlines the derived radius scale (rounded-sm/md/xl consume
  // calc(var(--radius) ± Npx)), so the control token binds the semantic
  // control radius that buttons, inputs, badges and sidebar controls read.
  "radius.control": "--control-radius",
  "spacing.base": "--spacing",
  "font.family": "--font-sans",
  "font.familyMono": "--font-mono",
  "font.sizePrompt": "--font-size-prompt",
  "font.sizeCode": "--font-size-code",
  "font.lineHeight": "--text-base--line-height",
  "transition.durationMs": "--panel-animation-duration",
} as const;

/**
 * Additional compiled aliases wired to the same tokens so the override
 * reaches every actual consumer: the diffs surfaces read their own font size
 * variable that the appearance layer sets alongside --font-size-code.
 */
const PRESENTATION_TOKEN_ALIASES: Partial<Record<PresentationTokenPropertyPath, string>> = {
  "font.sizeCode": "--diffs-font-size",
};

/** Formats one token value for its CSS variable. */
export function presentationTokenValueFor(
  path: PresentationTokenPropertyPath,
  value: string | number,
): string {
  if (path === "transition.durationMs") {
    return `${value}ms`;
  }
  if (path === "font.family" || path === "font.familyMono") {
    const list = cssFontFamilies(String(value));
    if (list === null) return String(value);
    const fallback = path === "font.family" ? DEFAULT_SANS_FONT_STACK : DEFAULT_CODE_FONT_STACK;
    return `${list}, ${fallback}`;
  }
  return String(value);
}

/**
 * Reads one resolved token by its registered path. The exhaustive switch is
 * the type-safe access: every registry path resolves through its concrete
 * field, never an untyped index.
 */
function resolvedTokenValue(
  tokens: PresentationTokensConfig,
  path: PresentationTokenPropertyPath,
): string | number | null {
  switch (path) {
    case "color.background":
      return tokens.color.background;
    case "color.surface":
      return tokens.color.surface;
    case "color.text":
      return tokens.color.text;
    case "color.muted":
      return tokens.color.muted;
    case "color.border":
      return tokens.color.border;
    case "color.accent":
      return tokens.color.accent;
    case "radius.panel":
      return tokens.radius.panel;
    case "radius.control":
      return tokens.radius.control;
    case "spacing.base":
      return tokens.spacing.base;
    case "font.family":
      return tokens.font.family;
    case "font.familyMono":
      return tokens.font.familyMono;
    case "font.sizePrompt":
      return tokens.font.sizePrompt;
    case "font.sizeCode":
      return tokens.font.sizeCode;
    case "font.lineHeight":
      return tokens.font.lineHeight;
    case "transition.durationMs":
      return tokens.transition.durationMs;
  }
}

/**
 * CSS declarations for the resolved (defaults ⊕ override) token policy:
 * every non-null value is emitted with `!important`; null tokens are omitted
 * so the current appearance base continues to provide them.
 */
export function presentationTokenDeclarations(tokens: PresentationTokensConfig): string {
  const declarations: Array<string> = [];
  for (const path of Object.keys(PRESENTATION_TOKEN_VARIABLES) as Array<
    keyof typeof PRESENTATION_TOKEN_VARIABLES
  >) {
    const value = resolvedTokenValue(tokens, path);
    if (value === null) continue;
    const formatted = presentationTokenValueFor(path, value);
    declarations.push(`${PRESENTATION_TOKEN_VARIABLES[path]}: ${formatted} !important;`);
    const alias = PRESENTATION_TOKEN_ALIASES[path];
    if (alias !== undefined) {
      declarations.push(`${alias}: ${formatted} !important;`);
    }
  }
  return declarations.join(" ");
}

/**
 * The single removable root override layer: one dedicated `<style>` element
 * per window whose `:root` declarations carry `!important`, so they win over
 * the root element's non-important inline appearance values while those base
 * values stay intact underneath. Installing a new policy rewrites the
 * element's text; removing it detaches the element so the appearance base
 * shows through again.
 */
export class PresentationOverrideLayer {
  private styleElement: HTMLStyleElement | null = null;

  install(document: Document, tokens: PresentationTokensConfig): void {
    const css = presentationTokenDeclarations(tokens);
    if (css.length === 0) {
      this.remove(document);
      return;
    }
    const rule = `:root { ${css} }`;
    if (this.styleElement === null) {
      const element = document.createElement("style");
      element.dataset.dokkabiPresentationOverride = "true";
      element.textContent = rule;
      document.head.append(element);
      this.styleElement = element;
      return;
    }
    this.styleElement.textContent = rule;
  }

  remove(_document: Document): void {
    const element = this.styleElement;
    if (element === null) return;
    this.styleElement = null;
    element.remove();
  }
}

/** The app's single override layer instance. */
export const presentationOverrideLayer = new PresentationOverrideLayer();
