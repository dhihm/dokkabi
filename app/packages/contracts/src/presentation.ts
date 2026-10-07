/**
 * Dokkabi presentation contracts (R1).
 *
 * One PresentationConfig owns the color/typography/spacing tokens and shell
 * layout constraints the desktop renderer consumes at runtime. The desktop
 * main process owns configuration I/O; this module owns the closed document
 * shape, the safe value grammars, the merge semantics and the layout rules
 * every writer and reader share.
 *
 * The registry below is exhaustive: only the listed token property paths and
 * layout components have a runtime effect in R1. Unknown names are decode
 * errors, never silently ignored values.
 */
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
// The one shared immutable JSON default resource for graph layout, consumed
// by BOTH the desktop host's normalization and the renderer's fallback.
import graphDefaultsJson from "./presentation-graph-defaults.json" with { type: "json" };

/** Discriminant of the presentation document family understood by this build. */
export const PRESENTATION_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Safe value grammars
// ---------------------------------------------------------------------------

const NAMED_COLOR_ALLOWLIST: ReadonlySet<string> = new Set([
  "transparent",
  "black",
  "silver",
  "gray",
  "grey",
  "white",
  "maroon",
  "red",
  "purple",
  "fuchsia",
  "magenta",
  "green",
  "lime",
  "olive",
  "yellow",
  "navy",
  "blue",
  "teal",
  "aqua",
  "cyan",
  "orange",
  "pink",
  "rebeccapurple",
]);

const HEX_DIGIT = /^[0-9a-f]$/i;

function parseHexChannel(digits: string): number | null {
  if (digits.length === 1) {
    return HEX_DIGIT.test(digits) ? Number.parseInt(`${digits}${digits}`, 16) : null;
  }
  for (const digit of digits) {
    if (!HEX_DIGIT.test(digit)) return null;
  }
  return Number.parseInt(digits, 16);
}

interface FunctionalParts {
  readonly tag: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * Minimal functional-literal splitter: `rgb(1 2 3 / 50%)` and
 * `rgba(1, 2, 3, 0.5)` both arrive as tag + argument list. Anything nested,
 * empty or unterminated is rejected, and empty arguments are preserved as
 * invalid rather than silently dropped.
 */
function parseFunctionalLiteral(value: string): FunctionalParts | null {
  const open = value.indexOf("(");
  if (open <= 0 || !value.endsWith(")")) return null;
  // A CSS function token has no whitespace between the name and "(".
  if (/\s/.test(value.slice(0, open))) return null;
  const tag = value.slice(0, open).toLowerCase();
  const body = value.slice(open + 1, -1);
  if (tag.length === 0 || /[()]/.test(body)) return null;
  // Commas and slash-separated alpha never mix in one literal.
  const hasComma = body.includes(",");
  const hasSlash = body.includes("/");
  if (hasComma && hasSlash) return null;
  let args: ReadonlyArray<string>;
  if (hasSlash) {
    // Exactly one alpha separator: `1 2 3 / 50% / more` is not a color.
    const parts = body.split("/");
    if (parts.length !== 2) return null;
    const [channels, alpha] = parts as [string, string];
    if (alpha.trim().length === 0) return null;
    args = [...channels.trim().split(/\s+/), alpha.trim()];
  } else if (hasComma) {
    args = body.split(",").map((part) => part.trim());
  } else {
    args = body.trim().split(/\s+/);
  }
  if (args.some((part) => part.length === 0)) return null;
  return { tag, args };
}

/** Strict numeric literal: no numeric prefixes such as `1oops`, no `calc()`. */
const NUMERIC_LITERAL = /^[0-9]*\.?[0-9]+$/;

function channelValue(raw: string, maximum: number): number | null {
  const isPercent = raw.endsWith("%");
  const numericPart = isPercent ? raw.slice(0, -1) : raw;
  if (!NUMERIC_LITERAL.test(numericPart)) return null;
  const numeric = Number.parseFloat(numericPart);
  if (!Number.isFinite(numeric)) return null;
  if (isPercent) {
    if (numeric < 0 || numeric > 100) return null;
    return (numeric / 100) * maximum;
  }
  if (numeric < 0 || numeric > maximum) return null;
  return numeric;
}

function alphaValue(raw: string): number | null {
  const value = channelValue(raw, 1);
  return value === null ? null : value;
}

/**
 * Accepts exactly the safe CSS color literals the presentation resolver
 * understands: `transparent`, a small named-color allowlist, hex triples and
 * functional rgb()/rgba()/hsl()/hsla() literals. Custom-property references,
 * url(), gradients and any other expression are rejected.
 */
export function parseSafeColorLiteral(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;

  if (NAMED_COLOR_ALLOWLIST.has(trimmed.toLowerCase())) return trimmed;

  if (trimmed.startsWith("#")) {
    const hex = trimmed.slice(1);
    if (![3, 4, 6, 8].includes(hex.length)) return null;
    const pairs =
      hex.length === 3 || hex.length === 4
        ? ([...hex].map((digit) => `${digit}${digit}`) as Array<string>)
        : (hex.match(/.{2}/g) ?? []);
    if (pairs.length < 3 || pairs.length > 4) return null;
    for (const pair of pairs) {
      const channel = parseHexChannel(pair);
      if (channel === null || channel > 255) return null;
    }
    return trimmed;
  }

  const functional = parseFunctionalLiteral(trimmed);
  if (functional === null) return null;
  const { tag, args } = functional;
  if (tag === "rgb" || tag === "rgba") {
    const hasSlashAlpha = /[/]/.test(trimmed.slice(trimmed.indexOf("(")));
    const expected = hasSlashAlpha || tag === "rgba" ? 4 : 3;
    if (args.length !== expected) return null;
    for (const arg of args.slice(0, 3)) {
      if (channelValue(arg, 255) === null) return null;
    }
    if (args.length === 4 && alphaValue(args[3]!) === null) return null;
    return trimmed;
  }
  if (tag === "hsl" || tag === "hsla") {
    const hasSlashAlpha = /[/]/.test(trimmed.slice(trimmed.indexOf("(")));
    const expected = hasSlashAlpha || tag === "hsla" ? 4 : 3;
    if (args.length !== expected) return null;
    if (channelValue(args[0]!, 360) === null) return null;
    // Saturation and lightness are percentages.
    for (const arg of args.slice(1, 3)) {
      if (!arg.endsWith("%")) return null;
      if (channelValue(arg, 100) === null) return null;
    }
    if (args.length === 4 && alphaValue(args[3]!) === null) return null;
    return trimmed;
  }
  return null;
}

const safeColorFilter = Schema.makeFilter((value: string) =>
  parseSafeColorLiteral(value) === null
    ? "expected a supported safe CSS color literal (hex, rgb(), rgba(), hsl(), hsla(), transparent or a basic named color)"
    : undefined,
);

export const PresentationColorSchema: Schema.Codec<string> = Schema.String.check(safeColorFilter);

interface DimensionBounds {
  readonly minimumPx: number;
  readonly maximumPx: number;
}

interface ParsedDimension {
  readonly value: number;
  readonly unit: "px" | "rem";
}

export function parseSafeDimensionLiteral(value: unknown): ParsedDimension | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match = /^([0-9]*\.?[0-9]+)(px|rem)$/.exec(trimmed);
  if (match === null) return null;
  const numeric = Number.parseFloat(match[1]!);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return { value: numeric, unit: match[2] as "px" | "rem" };
}

const dimensionInPx = (parsed: ParsedDimension): number =>
  parsed.unit === "rem" ? parsed.value * 16 : parsed.value;

const dimension = (bounds: DimensionBounds): Schema.Codec<string> =>
  Schema.String.check(
    Schema.makeFilter((value: string) => {
      const parsed = parseSafeDimensionLiteral(value);
      if (parsed === null) {
        return `expected a dimension literal like "12px" or "0.75rem" between ${bounds.minimumPx}px and ${bounds.maximumPx}px`;
      }
      const px = dimensionInPx(parsed);
      if (px < bounds.minimumPx || px > bounds.maximumPx) {
        return `dimension ${value} is outside the supported range of ${bounds.minimumPx}px to ${bounds.maximumPx}px`;
      }
      return undefined;
    }),
  );

/** Font families are sanitized lists; no expressions, quotes only as names. */
const FONT_FAMILY_MAX_LENGTH = 200;
export function parseSafeFontFamilyLiteral(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > FONT_FAMILY_MAX_LENGTH) return null;
  if (!/[a-zA-Z0-9]/.test(trimmed)) return null;
  if (!/^[\t a-zA-Z0-9,.'"_-]+$/.test(trimmed)) return null;
  return trimmed;
}

const fontFamilyLiteral = Schema.String.check(
  Schema.makeFilter((value: string) =>
    parseSafeFontFamilyLiteral(value) === null
      ? "expected a comma-separated font family list of letters, digits, spaces, quotes, hyphens, underscores or periods"
      : undefined,
  ),
);

const unitlessLineHeight = Schema.Finite.check(Schema.isBetween({ minimum: 1.0, maximum: 2.5 }));

// ---------------------------------------------------------------------------
// Token registry (exhaustive for R1)
// ---------------------------------------------------------------------------

export const PRESENTATION_COLOR_TOKENS = [
  "background",
  "surface",
  "text",
  "muted",
  "border",
  "accent",
] as const;
export type PresentationColorToken = (typeof PRESENTATION_COLOR_TOKENS)[number];

export const PRESENTATION_TOKEN_PROPERTY_PATHS = [
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
] as const;
export type PresentationTokenPropertyPath = (typeof PRESENTATION_TOKEN_PROPERTY_PATHS)[number];

const optionalColor = () => Schema.optionalKey(Schema.NullOr(PresentationColorSchema));

const PresentationColorTokensOverrideSchema = Schema.Struct({
  background: optionalColor(),
  surface: optionalColor(),
  text: optionalColor(),
  muted: optionalColor(),
  border: optionalColor(),
  accent: optionalColor(),
});

const PresentationRadiusTokensOverrideSchema = Schema.Struct({
  panel: Schema.optionalKey(Schema.NullOr(dimension({ minimumPx: 0, maximumPx: 48 }))),
  control: Schema.optionalKey(Schema.NullOr(dimension({ minimumPx: 0, maximumPx: 32 }))),
});

const PresentationSpacingTokensOverrideSchema = Schema.Struct({
  base: Schema.optionalKey(Schema.NullOr(dimension({ minimumPx: 1, maximumPx: 12 }))),
});

const PresentationFontTokensOverrideSchema = Schema.Struct({
  family: Schema.optionalKey(Schema.NullOr(fontFamilyLiteral)),
  familyMono: Schema.optionalKey(Schema.NullOr(fontFamilyLiteral)),
  sizePrompt: Schema.optionalKey(Schema.NullOr(dimension({ minimumPx: 10, maximumPx: 28 }))),
  sizeCode: Schema.optionalKey(Schema.NullOr(dimension({ minimumPx: 10, maximumPx: 24 }))),
  lineHeight: Schema.optionalKey(Schema.NullOr(unitlessLineHeight)),
});

const PresentationTransitionTokensSchema = Schema.Struct({
  durationMs: Schema.optionalKey(
    Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2_000 }))),
  ),
});

export interface PresentationTokensOverride {
  readonly color?: {
    readonly background?: string | null;
    readonly surface?: string | null;
    readonly text?: string | null;
    readonly muted?: string | null;
    readonly border?: string | null;
    readonly accent?: string | null;
  };
  readonly radius?: { readonly panel?: string | null; readonly control?: string | null };
  readonly spacing?: { readonly base?: string | null };
  readonly font?: {
    readonly family?: string | null;
    readonly familyMono?: string | null;
    readonly sizePrompt?: string | null;
    readonly sizeCode?: string | null;
    readonly lineHeight?: number | null;
  };
  readonly transition?: { readonly durationMs?: number | null };
}

export const PresentationTokensOverrideSchema: Schema.Codec<PresentationTokensOverride> =
  Schema.Struct({
    color: Schema.optionalKey(PresentationColorTokensOverrideSchema),
    radius: Schema.optionalKey(PresentationRadiusTokensOverrideSchema),
    spacing: Schema.optionalKey(PresentationSpacingTokensOverrideSchema),
    font: Schema.optionalKey(PresentationFontTokensOverrideSchema),
    transition: Schema.optionalKey(PresentationTransitionTokensSchema),
  });

// ---------------------------------------------------------------------------
// Layout registry (exhaustive for R1)
// ---------------------------------------------------------------------------

const boundedInt = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));

/**
 * R1 keeps the shipped native safety floor: the main window cannot be
 * configured below 840×620, because a smaller native shell has not been
 * verified to keep the composer accessible. Narrower layouts are exercised by
 * renderer fixtures, not by native window constraints.
 */
export const PRESENTATION_MAIN_WINDOW_FLOOR = {
  width: 840,
  height: 620,
} as const;

const MainWindowLayoutOverrideSchema = Schema.Struct({
  minWidth: Schema.optionalKey(boundedInt(PRESENTATION_MAIN_WINDOW_FLOOR.width, 2_560)),
  minHeight: Schema.optionalKey(boundedInt(PRESENTATION_MAIN_WINDOW_FLOOR.height, 1_440)),
  defaultWidth: Schema.optionalKey(boundedInt(480, 5_120)),
  defaultHeight: Schema.optionalKey(boundedInt(360, 2_880)),
});

const NavigationLayoutOverrideSchema = Schema.Struct({
  minWidth: Schema.optionalKey(boundedInt(160, 480)),
  defaultWidth: Schema.optionalKey(boundedInt(160, 600)),
  maxWidth: Schema.optionalKey(boundedInt(160, 960)),
});

const ConversationLayoutOverrideSchema = Schema.Struct({
  minWidth: Schema.optionalKey(boundedInt(240, 1_200)),
});

const RightPanelLayoutOverrideSchema = Schema.Struct({
  minWidth: Schema.optionalKey(boundedInt(200, 720)),
  defaultWidth: Schema.optionalKey(boundedInt(240, 960)),
  maxWidth: Schema.optionalKey(boundedInt(240, 1_440)),
});

// --- Graph canvas layout (Dokkabi R4) ---
//
// One shared immutable JSON default resource drives BOTH the desktop host's
// normalization and the renderer's fallback: old v1 documents lacking graph
// inherit these values, partial overrides deep-merge per key, and unknown,
// non-finite or out-of-bounds values refuse the whole document. Layout
// changes apply at runtime without a rebuild; positions are view
// preferences, never execution instructions.

/** Bounds of every layout.graph property; the schema and the editor share them. */
export const PRESENTATION_GRAPH_LAYOUT_BOUNDS = {
  nodeWidth: { minimum: 160, maximum: 480 },
  nodeHeight: { minimum: 64, maximum: 200 },
  rankGap: { minimum: 24, maximum: 240 },
  siblingGap: { minimum: 12, maximum: 160 },
  canvasPadding: { minimum: 8, maximum: 96 },
} as const;

export type PresentationGraphDirection = "LR" | "TB";

export interface PresentationGraphLayoutConfig {
  readonly direction: PresentationGraphDirection;
  readonly nodeWidth: number;
  readonly nodeHeight: number;
  readonly rankGap: number;
  readonly siblingGap: number;
  readonly canvasPadding: number;
}

const decodeGraphDefaults = Schema.decodeUnknownSync(
  Schema.Struct({
    direction: Schema.Literals(["LR", "TB"]),
    nodeWidth: boundedInt(
      PRESENTATION_GRAPH_LAYOUT_BOUNDS.nodeWidth.minimum,
      PRESENTATION_GRAPH_LAYOUT_BOUNDS.nodeWidth.maximum,
    ),
    nodeHeight: boundedInt(
      PRESENTATION_GRAPH_LAYOUT_BOUNDS.nodeHeight.minimum,
      PRESENTATION_GRAPH_LAYOUT_BOUNDS.nodeHeight.maximum,
    ),
    rankGap: boundedInt(
      PRESENTATION_GRAPH_LAYOUT_BOUNDS.rankGap.minimum,
      PRESENTATION_GRAPH_LAYOUT_BOUNDS.rankGap.maximum,
    ),
    siblingGap: boundedInt(
      PRESENTATION_GRAPH_LAYOUT_BOUNDS.siblingGap.minimum,
      PRESENTATION_GRAPH_LAYOUT_BOUNDS.siblingGap.maximum,
    ),
    canvasPadding: boundedInt(
      PRESENTATION_GRAPH_LAYOUT_BOUNDS.canvasPadding.minimum,
      PRESENTATION_GRAPH_LAYOUT_BOUNDS.canvasPadding.maximum,
    ),
  }),
);

/** Frozen decoded graph defaults; the shipped JSON is validated once here. */
export const PRESENTATION_GRAPH_LAYOUT_DEFAULTS: Readonly<PresentationGraphLayoutConfig> =
  Object.freeze(decodeGraphDefaults(graphDefaultsJson));

const GraphLayoutOverrideSchema = Schema.Struct({
  direction: Schema.optionalKey(Schema.Literals(["LR", "TB"])),
  nodeWidth: Schema.optionalKey(
    boundedInt(
      PRESENTATION_GRAPH_LAYOUT_BOUNDS.nodeWidth.minimum,
      PRESENTATION_GRAPH_LAYOUT_BOUNDS.nodeWidth.maximum,
    ),
  ),
  nodeHeight: Schema.optionalKey(
    boundedInt(
      PRESENTATION_GRAPH_LAYOUT_BOUNDS.nodeHeight.minimum,
      PRESENTATION_GRAPH_LAYOUT_BOUNDS.nodeHeight.maximum,
    ),
  ),
  rankGap: Schema.optionalKey(
    boundedInt(
      PRESENTATION_GRAPH_LAYOUT_BOUNDS.rankGap.minimum,
      PRESENTATION_GRAPH_LAYOUT_BOUNDS.rankGap.maximum,
    ),
  ),
  siblingGap: Schema.optionalKey(
    boundedInt(
      PRESENTATION_GRAPH_LAYOUT_BOUNDS.siblingGap.minimum,
      PRESENTATION_GRAPH_LAYOUT_BOUNDS.siblingGap.maximum,
    ),
  ),
  canvasPadding: Schema.optionalKey(
    boundedInt(
      PRESENTATION_GRAPH_LAYOUT_BOUNDS.canvasPadding.minimum,
      PRESENTATION_GRAPH_LAYOUT_BOUNDS.canvasPadding.maximum,
    ),
  ),
});

// --- Record companion geometry (Dokkabi R6) ---
//
// Optional like graph: an old v1 document without recordCompanion inherits
// the shared defaults, partial overrides deep-merge per key, and unknown or
// out-of-bounds values refuse the whole document. The block owns only the
// native default/minimal geometry; position and the user's persisted size
// are scoped view preferences, never theme JSON.

/** Bounds of every layout.recordCompanion property; the schema shares them. */
export const PRESENTATION_RECORD_COMPANION_LAYOUT_BOUNDS = {
  defaultWidth: { minimum: 560, maximum: 2_000 },
  defaultHeight: { minimum: 420, maximum: 1_600 },
  minWidth: { minimum: 400, maximum: 1_200 },
  minHeight: { minimum: 300, maximum: 1_000 },
} as const;

/** Frozen shared defaults every v1 document without the block inherits. */
export const PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS = Object.freeze({
  defaultWidth: 760,
  defaultHeight: 680,
  minWidth: 560,
  minHeight: 420,
} as const satisfies RecordCompanionLayoutConfigShape);

interface RecordCompanionLayoutConfigShape {
  readonly defaultWidth: number;
  readonly defaultHeight: number;
  readonly minWidth: number;
  readonly minHeight: number;
}

const RecordCompanionLayoutOverrideSchema = Schema.Struct({
  defaultWidth: Schema.optionalKey(
    boundedInt(
      PRESENTATION_RECORD_COMPANION_LAYOUT_BOUNDS.defaultWidth.minimum,
      PRESENTATION_RECORD_COMPANION_LAYOUT_BOUNDS.defaultWidth.maximum,
    ),
  ),
  defaultHeight: Schema.optionalKey(
    boundedInt(
      PRESENTATION_RECORD_COMPANION_LAYOUT_BOUNDS.defaultHeight.minimum,
      PRESENTATION_RECORD_COMPANION_LAYOUT_BOUNDS.defaultHeight.maximum,
    ),
  ),
  minWidth: Schema.optionalKey(
    boundedInt(
      PRESENTATION_RECORD_COMPANION_LAYOUT_BOUNDS.minWidth.minimum,
      PRESENTATION_RECORD_COMPANION_LAYOUT_BOUNDS.minWidth.maximum,
    ),
  ),
  minHeight: Schema.optionalKey(
    boundedInt(
      PRESENTATION_RECORD_COMPANION_LAYOUT_BOUNDS.minHeight.minimum,
      PRESENTATION_RECORD_COMPANION_LAYOUT_BOUNDS.minHeight.maximum,
    ),
  ),
});

export interface PresentationLayoutOverride {
  readonly mainWindow?: {
    readonly minWidth?: number;
    readonly minHeight?: number;
    readonly defaultWidth?: number;
    readonly defaultHeight?: number;
  };
  readonly navigation?: {
    readonly minWidth?: number;
    readonly defaultWidth?: number;
    readonly maxWidth?: number;
  };
  readonly conversation?: { readonly minWidth?: number };
  readonly rightPanel?: {
    readonly minWidth?: number;
    readonly defaultWidth?: number;
    readonly maxWidth?: number;
  };
  readonly graph?: {
    readonly direction?: PresentationGraphDirection;
    readonly nodeWidth?: number;
    readonly nodeHeight?: number;
    readonly rankGap?: number;
    readonly siblingGap?: number;
    readonly canvasPadding?: number;
  };
  readonly recordCompanion?: {
    readonly defaultWidth?: number;
    readonly defaultHeight?: number;
    readonly minWidth?: number;
    readonly minHeight?: number;
  };
  readonly inlineBreakpoint?: number;
}

export const PresentationLayoutOverrideSchema: Schema.Codec<PresentationLayoutOverride> =
  Schema.Struct({
    mainWindow: Schema.optionalKey(MainWindowLayoutOverrideSchema),
    navigation: Schema.optionalKey(NavigationLayoutOverrideSchema),
    conversation: Schema.optionalKey(ConversationLayoutOverrideSchema),
    rightPanel: Schema.optionalKey(RightPanelLayoutOverrideSchema),
    graph: Schema.optionalKey(GraphLayoutOverrideSchema),
    recordCompanion: Schema.optionalKey(RecordCompanionLayoutOverrideSchema),
    inlineBreakpoint: Schema.optionalKey(boundedInt(480, 3_840)),
  });

export interface PresentationOverride {
  readonly schemaVersion: typeof PRESENTATION_SCHEMA_VERSION;
  readonly tokens?: PresentationTokensOverride;
  readonly layout?: PresentationLayoutOverride;
}

export const PresentationOverrideSchema: Schema.Codec<PresentationOverride> = Schema.Struct({
  schemaVersion: Schema.Literals([PRESENTATION_SCHEMA_VERSION]),
  tokens: Schema.optionalKey(PresentationTokensOverrideSchema),
  layout: Schema.optionalKey(PresentationLayoutOverrideSchema),
});

// ---------------------------------------------------------------------------
// Resolved configuration shape (complete; null token means "not overridden")
// ---------------------------------------------------------------------------

export interface PresentationTokensConfig {
  readonly color: {
    readonly background: string | null;
    readonly surface: string | null;
    readonly text: string | null;
    readonly muted: string | null;
    readonly border: string | null;
    readonly accent: string | null;
  };
  readonly radius: { readonly panel: string | null; readonly control: string | null };
  readonly spacing: { readonly base: string | null };
  readonly font: {
    readonly family: string | null;
    readonly familyMono: string | null;
    readonly sizePrompt: string | null;
    readonly sizeCode: string | null;
    readonly lineHeight: number | null;
  };
  readonly transition: { readonly durationMs: number | null };
}

export interface PresentationLayoutConfig {
  readonly mainWindow: {
    readonly minWidth: number;
    readonly minHeight: number;
    readonly defaultWidth: number;
    readonly defaultHeight: number;
  };
  readonly navigation: {
    readonly minWidth: number;
    readonly defaultWidth: number;
    readonly maxWidth: number;
  };
  readonly conversation: { readonly minWidth: number };
  readonly rightPanel: {
    readonly minWidth: number;
    readonly defaultWidth: number;
    readonly maxWidth: number;
  };
  readonly graph: PresentationGraphLayoutConfig;
  readonly recordCompanion: {
    readonly defaultWidth: number;
    readonly defaultHeight: number;
    readonly minWidth: number;
    readonly minHeight: number;
  };
  readonly inlineBreakpoint: number;
}

export interface PresentationConfig {
  readonly schemaVersion: typeof PRESENTATION_SCHEMA_VERSION;
  readonly tokens: PresentationTokensConfig;
  readonly layout: PresentationLayoutConfig;
}

const PresentationColorTokensConfigSchema = Schema.Struct({
  background: Schema.NullOr(PresentationColorSchema),
  surface: Schema.NullOr(PresentationColorSchema),
  text: Schema.NullOr(PresentationColorSchema),
  muted: Schema.NullOr(PresentationColorSchema),
  border: Schema.NullOr(PresentationColorSchema),
  accent: Schema.NullOr(PresentationColorSchema),
});

const PresentationRadiusTokensConfigSchema = Schema.Struct({
  panel: Schema.NullOr(dimension({ minimumPx: 0, maximumPx: 48 })),
  control: Schema.NullOr(dimension({ minimumPx: 0, maximumPx: 32 })),
});

const PresentationSpacingTokensConfigSchema = Schema.Struct({
  base: Schema.NullOr(dimension({ minimumPx: 1, maximumPx: 12 })),
});

const PresentationFontTokensConfigSchema = Schema.Struct({
  family: Schema.NullOr(fontFamilyLiteral),
  familyMono: Schema.NullOr(fontFamilyLiteral),
  sizePrompt: Schema.NullOr(dimension({ minimumPx: 10, maximumPx: 28 })),
  sizeCode: Schema.NullOr(dimension({ minimumPx: 10, maximumPx: 24 })),
  lineHeight: Schema.NullOr(unitlessLineHeight),
});

const PresentationTransitionTokensConfigSchema = Schema.Struct({
  /**
   * The transition duration policy: a number pins motion everywhere; null
   * delegates to the current appearance preference.
   */
  durationMs: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2_000 }))),
});

/**
 * The safe normalized token configuration (Dokkabi R6 exports this codec for
 * the Record companion snapshot): every value is either null ("not
 * overridden") or a strictly validated literal from the safe grammars above.
 * It is the resolved PresentationConfig token block — never computed-style
 * samples, never free-form CSS.
 */
export const PresentationTokensConfigSchema: Schema.Codec<PresentationTokensConfig> = Schema.Struct(
  {
    color: PresentationColorTokensConfigSchema,
    radius: PresentationRadiusTokensConfigSchema,
    spacing: PresentationSpacingTokensConfigSchema,
    font: PresentationFontTokensConfigSchema,
    transition: PresentationTransitionTokensConfigSchema,
  },
);

const MainWindowLayoutConfigSchema = Schema.Struct({
  minWidth: boundedInt(PRESENTATION_MAIN_WINDOW_FLOOR.width, 2_560),
  minHeight: boundedInt(PRESENTATION_MAIN_WINDOW_FLOOR.height, 1_440),
  defaultWidth: boundedInt(480, 5_120),
  defaultHeight: boundedInt(360, 2_880),
});

const NavigationLayoutConfigSchema = Schema.Struct({
  minWidth: boundedInt(160, 480),
  defaultWidth: boundedInt(160, 600),
  maxWidth: boundedInt(160, 960),
});

const ConversationLayoutConfigSchema = Schema.Struct({
  minWidth: boundedInt(240, 1_200),
});

const RightPanelLayoutConfigSchema = Schema.Struct({
  minWidth: boundedInt(200, 720),
  defaultWidth: boundedInt(240, 960),
  maxWidth: boundedInt(240, 1_440),
});

const GraphLayoutConfigSchema = Schema.Struct({
  direction: Schema.Literals(["LR", "TB"]),
  nodeWidth: boundedInt(
    PRESENTATION_GRAPH_LAYOUT_BOUNDS.nodeWidth.minimum,
    PRESENTATION_GRAPH_LAYOUT_BOUNDS.nodeWidth.maximum,
  ),
  nodeHeight: boundedInt(
    PRESENTATION_GRAPH_LAYOUT_BOUNDS.nodeHeight.minimum,
    PRESENTATION_GRAPH_LAYOUT_BOUNDS.nodeHeight.maximum,
  ),
  rankGap: boundedInt(
    PRESENTATION_GRAPH_LAYOUT_BOUNDS.rankGap.minimum,
    PRESENTATION_GRAPH_LAYOUT_BOUNDS.rankGap.maximum,
  ),
  siblingGap: boundedInt(
    PRESENTATION_GRAPH_LAYOUT_BOUNDS.siblingGap.minimum,
    PRESENTATION_GRAPH_LAYOUT_BOUNDS.siblingGap.maximum,
  ),
  canvasPadding: boundedInt(
    PRESENTATION_GRAPH_LAYOUT_BOUNDS.canvasPadding.minimum,
    PRESENTATION_GRAPH_LAYOUT_BOUNDS.canvasPadding.maximum,
  ),
});

const RecordCompanionLayoutConfigSchema = Schema.Struct({
  defaultWidth: boundedInt(
    PRESENTATION_RECORD_COMPANION_LAYOUT_BOUNDS.defaultWidth.minimum,
    PRESENTATION_RECORD_COMPANION_LAYOUT_BOUNDS.defaultWidth.maximum,
  ),
  defaultHeight: boundedInt(
    PRESENTATION_RECORD_COMPANION_LAYOUT_BOUNDS.defaultHeight.minimum,
    PRESENTATION_RECORD_COMPANION_LAYOUT_BOUNDS.defaultHeight.maximum,
  ),
  minWidth: boundedInt(
    PRESENTATION_RECORD_COMPANION_LAYOUT_BOUNDS.minWidth.minimum,
    PRESENTATION_RECORD_COMPANION_LAYOUT_BOUNDS.minWidth.maximum,
  ),
  minHeight: boundedInt(
    PRESENTATION_RECORD_COMPANION_LAYOUT_BOUNDS.minHeight.minimum,
    PRESENTATION_RECORD_COMPANION_LAYOUT_BOUNDS.minHeight.maximum,
  ),
});

/**
 * The complete resolved configuration: every layout field populated and
 * `tokens.transition.durationMs` a concrete number. Color/typography tokens
 * stay nullable because `null` is their real resolved value ("not overridden";
 * the shipped theme provides the base). This is the schema used at IPC
 * boundaries — an override-shaped document must never decode as a config.
 */
export const PresentationConfigSchema: Schema.Codec<PresentationConfig> = Schema.Struct({
  schemaVersion: Schema.Literals([PRESENTATION_SCHEMA_VERSION]),
  tokens: Schema.Struct({
    color: PresentationColorTokensConfigSchema,
    radius: PresentationRadiusTokensConfigSchema,
    spacing: PresentationSpacingTokensConfigSchema,
    font: PresentationFontTokensConfigSchema,
    transition: PresentationTransitionTokensConfigSchema,
  }),
  layout: Schema.Struct({
    mainWindow: MainWindowLayoutConfigSchema,
    navigation: NavigationLayoutConfigSchema,
    conversation: ConversationLayoutConfigSchema,
    rightPanel: RightPanelLayoutConfigSchema,
    graph: GraphLayoutConfigSchema,
    recordCompanion: RecordCompanionLayoutConfigSchema,
    inlineBreakpoint: boundedInt(480, 3_840),
  }),
});

// ---------------------------------------------------------------------------
// Decode with pointer issues
// ---------------------------------------------------------------------------

export interface PresentationDocumentIssue {
  readonly kind: "syntax" | "schema" | "layout" | "io";
  readonly message: string;
  readonly path: string | null;
  readonly line: number | null;
  readonly column: number | null;
}

export type PresentationDecodeResult =
  | { readonly ok: true; readonly document: PresentationOverride }
  | { readonly ok: false; readonly issues: ReadonlyArray<PresentationDocumentIssue> };

const decodeOverrideStrict = Schema.decodeUnknownSync(PresentationOverrideSchema, {
  onExcessProperty: "error",
});

interface IssuePath {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}

const formatIssueMessage = SchemaIssue.makeFormatterDefault();

function collectIssuePaths(
  issue: SchemaIssue.Issue,
  prefix: ReadonlyArray<PropertyKey> = [],
): Array<IssuePath> {
  switch (issue._tag) {
    case "Pointer": {
      return collectIssuePaths(issue.issue, [...prefix, ...issue.path]);
    }
    case "Filter": {
      const nested = collectIssuePaths(issue.issue, prefix);
      const own = { path: prefix, message: formatIssueMessage(issue) } satisfies IssuePath;
      return nested.length > 0 ? [...nested, own] : [own];
    }
    case "Composite": {
      return issue.issues.flatMap((child) => collectIssuePaths(child, prefix));
    }
    case "AnyOf": {
      // Literal mismatches report as an AnyOf whose per-member issues are
      // already folded into its own formatted message.
      if (issue.issues.length === 0) {
        return [{ path: prefix, message: formatIssueMessage(issue) }];
      }
      return issue.issues.flatMap((child) => collectIssuePaths(child, prefix));
    }
    default: {
      return [{ path: prefix, message: formatIssueMessage(issue) }];
    }
  }
}

const formatPointer = (path: ReadonlyArray<PropertyKey>): string =>
  path.length === 0 ? "" : `/${path.map(String).join("/")}`;

function schemaIssuesToPresentationIssues(
  error: unknown,
): ReadonlyArray<PresentationDocumentIssue> {
  const issue: SchemaIssue.Issue | undefined =
    typeof error === "object" && error !== null && "issue" in error
      ? (error as { issue: SchemaIssue.Issue }).issue
      : undefined;
  if (issue === undefined) {
    return [
      {
        kind: "schema",
        message: error instanceof Error ? error.message : String(error),
        path: null,
        line: null,
        column: null,
      },
    ];
  }
  return collectIssuePaths(issue).map((entry) => ({
    kind: "schema" as const,
    message: entry.message,
    path: entry.path.length === 0 ? null : formatPointer(entry.path),
    line: null,
    column: null,
  }));
}

export function decodePresentationOverrideValue(value: unknown): PresentationDecodeResult {
  try {
    return { ok: true, document: decodeOverrideStrict(value) };
  } catch (error) {
    return { ok: false, issues: schemaIssuesToPresentationIssues(error) };
  }
}

interface SyntaxPosition {
  readonly line: number;
  readonly column: number;
}

function locateJsonSyntaxPosition(text: string, error: unknown): SyntaxPosition | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = /position (\d+)/i.exec(message);
  if (match === null) return null;
  const offset = Math.min(Number.parseInt(match[1]!, 10), text.length);
  const upToOffset = text.slice(0, offset);
  const line = upToOffset.split("\n").length;
  const lastLineStart = upToOffset.lastIndexOf("\n");
  return {
    line,
    column: offset - (lastLineStart === -1 ? 0 : lastLineStart + 1) + 1,
  };
}

export function decodePresentationOverrideText(text: string): PresentationDecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const position = locateJsonSyntaxPosition(text, error);
    return {
      ok: false,
      issues: [
        {
          kind: "syntax",
          message: error instanceof Error ? error.message : String(error),
          path: null,
          line: position?.line ?? null,
          column: position?.column ?? null,
        },
      ],
    };
  }
  return decodePresentationOverrideValue(parsed);
}

// ---------------------------------------------------------------------------
// Merge and layout rules
// ---------------------------------------------------------------------------

type AnyRecord = { readonly [key: string]: unknown };

const isPlainRecord = (value: unknown): value is AnyRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function mergeRecords(base: AnyRecord, override: AnyRecord): AnyRecord {
  const result: Record<string, unknown> = { ...base };
  for (const [key, overrideValue] of Object.entries(override)) {
    if (overrideValue === undefined) continue;
    // An explicit null is a token reset: it restores the shipped default
    // rather than replacing the default with null.
    if (overrideValue === null) continue;
    const baseValue = result[key];
    if (isPlainRecord(baseValue) && isPlainRecord(overrideValue)) {
      result[key] = mergeRecords(baseValue, overrideValue);
    } else {
      result[key] = overrideValue;
    }
  }
  return result;
}

/** Object overrides merge by key; a `null` token restores the shipped default.
 * The graph and recordCompanion blocks inherit the shared defaults when either
 * side lacks them, so an old v1 document without those blocks resolves to a
 * complete config. */
export function mergePresentationConfig(
  defaults: PresentationConfig,
  override: PresentationOverride,
): PresentationConfig {
  const merged = mergeRecords(
    {
      ...defaults,
      layout: {
        ...defaults.layout,
        graph: defaults.layout.graph ?? PRESENTATION_GRAPH_LAYOUT_DEFAULTS,
        recordCompanion:
          defaults.layout.recordCompanion ?? PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS,
      },
    } as unknown as AnyRecord,
    override as unknown as AnyRecord,
  ) as unknown as PresentationConfig;
  return {
    ...merged,
    layout: {
      ...merged.layout,
      graph: merged.layout.graph ?? PRESENTATION_GRAPH_LAYOUT_DEFAULTS,
      recordCompanion: {
        ...PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS,
        ...merged.layout.recordCompanion,
      },
    },
  };
}

const layoutIssue = (path: string, message: string): PresentationDocumentIssue => ({
  kind: "layout",
  message,
  path,
  line: null,
  column: null,
});

/**
 * Cross-field layout rules. Bounds themselves live in the schema; this
 * validates that a merged candidate keeps the shell usable: minima ordered,
 * the composer reachable at minimum size and every inline column fitting
 * under the breakpoint.
 */
export function validatePresentationConfig(
  config: PresentationConfig,
): ReadonlyArray<PresentationDocumentIssue> {
  const issues: Array<PresentationDocumentIssue> = [];
  const { layout } = config;

  if (
    layout.navigation.minWidth > layout.navigation.defaultWidth ||
    layout.navigation.defaultWidth > layout.navigation.maxWidth
  ) {
    issues.push(
      layoutIssue("/layout/navigation", "navigation requires minWidth ≤ defaultWidth ≤ maxWidth"),
    );
  }

  if (
    layout.rightPanel.minWidth > layout.rightPanel.defaultWidth ||
    layout.rightPanel.defaultWidth > layout.rightPanel.maxWidth
  ) {
    issues.push(
      layoutIssue("/layout/rightPanel", "rightPanel requires minWidth ≤ defaultWidth ≤ maxWidth"),
    );
  }

  if (
    layout.mainWindow.minWidth > layout.mainWindow.defaultWidth ||
    layout.mainWindow.minHeight > layout.mainWindow.defaultHeight
  ) {
    issues.push(
      layoutIssue("/layout/mainWindow", "mainWindow minimum exceeds its default dimensions"),
    );
  }

  if (
    layout.recordCompanion !== undefined &&
    (layout.recordCompanion.minWidth > layout.recordCompanion.defaultWidth ||
      layout.recordCompanion.minHeight > layout.recordCompanion.defaultHeight)
  ) {
    issues.push(
      layoutIssue(
        "/layout/recordCompanion",
        "recordCompanion minimum exceeds its default dimensions",
      ),
    );
  }

  if (layout.navigation.minWidth + layout.conversation.minWidth > layout.mainWindow.minWidth) {
    issues.push(
      layoutIssue(
        "/layout/mainWindow",
        "mainWindow.minWidth must fit the expanded navigation and the conversation minimum, otherwise the composer is unreachable at minimum size",
      ),
    );
  }

  if (
    layout.navigation.minWidth + layout.conversation.minWidth + layout.rightPanel.minWidth >
    layout.inlineBreakpoint
  ) {
    issues.push(
      layoutIssue(
        "/layout/inlineBreakpoint",
        "inlineBreakpoint must fit the navigation, conversation and right-panel minimum widths",
      ),
    );
  }

  return issues;
}

/** Deterministic key-ordered JSON used for digests and comparisons. */
export function canonicalPresentationConfigJson(config: PresentationConfig): string {
  const sortValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortValue);
    if (isPlainRecord(value)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        sorted[key] = sortValue((value as Record<string, unknown>)[key]);
      }
      return sorted;
    }
    return value;
  };
  return JSON.stringify(sortValue(config));
}

// ---------------------------------------------------------------------------
// Applied state, save/reset receipts (IPC)
// ---------------------------------------------------------------------------

export const PresentationDocumentIssueSchema: Schema.Codec<PresentationDocumentIssue> =
  Schema.Struct({
    kind: Schema.Literals(["syntax", "schema", "layout", "io"]),
    message: Schema.String,
    path: Schema.NullOr(Schema.String),
    line: Schema.NullOr(Schema.Int),
    column: Schema.NullOr(Schema.Int),
  });

export interface PresentationAppliedState {
  readonly schemaVersion: typeof PRESENTATION_SCHEMA_VERSION;
  /** Monotonic across applies, errors and recoveries, even with an unchanged digest. */
  readonly revision: number;
  readonly digest: string;
  readonly location: string;
  readonly status: "defaults" | "applied" | "invalid";
  /** Raw text of the last-valid override file; null when the file is absent. */
  readonly overrideDocument: string | null;
  /** Decoded last-valid override; drives the renderer's explicit token layer. */
  readonly override: PresentationOverride | null;
  /** Complete resolved (defaults ⊕ override) configuration in use. */
  readonly config: PresentationConfig;
  readonly error: PresentationDocumentIssue | null;
}

export const PresentationAppliedStateSchema: Schema.Codec<PresentationAppliedState> = Schema.Struct(
  {
    schemaVersion: Schema.Literals([PRESENTATION_SCHEMA_VERSION]),
    revision: Schema.Int,
    digest: Schema.String,
    location: Schema.String,
    status: Schema.Literals(["defaults", "applied", "invalid"]),
    overrideDocument: Schema.NullOr(Schema.String),
    override: Schema.NullOr(PresentationOverrideSchema),
    config: PresentationConfigSchema,
    error: Schema.NullOr(PresentationDocumentIssueSchema),
  },
);

export interface PresentationSaveInput {
  readonly expectedRevision: number;
  readonly document: string;
}

export const PresentationSaveInputSchema: Schema.Codec<PresentationSaveInput> = Schema.Struct({
  expectedRevision: Schema.Int,
  document: Schema.String,
});

/**
 * Save outcomes are fail-closed: `applied` means the override was written and
 * the audit outcome recorded. `error` means the edit was refused before the
 * override file was modified (for example the audit writer is unavailable).
 * `uncertain` means the override write succeeded but the audit outcome could
 * not be recorded — an explicit incomplete outcome, never reported as success.
 */
export type PresentationSaveResult =
  | {
      readonly type: "applied";
      readonly state: PresentationAppliedState;
    }
  | {
      readonly type: "conflict";
      readonly state: PresentationAppliedState;
      readonly message: string;
    }
  | {
      readonly type: "invalid";
      readonly state: PresentationAppliedState;
      readonly issues: ReadonlyArray<PresentationDocumentIssue>;
    }
  | {
      readonly type: "error";
      readonly state: PresentationAppliedState;
      readonly message: string;
    }
  | {
      readonly type: "uncertain";
      readonly state: PresentationAppliedState;
      readonly message: string;
    };

export const PresentationSaveResultSchema: Schema.Codec<PresentationSaveResult> = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("applied"),
    state: PresentationAppliedStateSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("conflict"),
    state: PresentationAppliedStateSchema,
    message: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("invalid"),
    state: PresentationAppliedStateSchema,
    issues: Schema.Array(PresentationDocumentIssueSchema),
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    state: PresentationAppliedStateSchema,
    message: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("uncertain"),
    state: PresentationAppliedStateSchema,
    message: Schema.String,
  }),
]);

export type PresentationResetResult =
  | {
      readonly type: "applied";
      readonly state: PresentationAppliedState;
    }
  | {
      readonly type: "error";
      readonly state: PresentationAppliedState;
      readonly message: string;
    }
  | {
      readonly type: "uncertain";
      readonly state: PresentationAppliedState;
      readonly message: string;
    };

export const PresentationResetResultSchema: Schema.Codec<PresentationResetResult> = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("applied"),
    state: PresentationAppliedStateSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    state: PresentationAppliedStateSchema,
    message: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("uncertain"),
    state: PresentationAppliedStateSchema,
    message: Schema.String,
  }),
]);

// ---------------------------------------------------------------------------
// Layout snapshot (measured, never invented)
// ---------------------------------------------------------------------------

export const PRESENTATION_SURFACE_IDS = [
  "root",
  "navigation",
  "conversation",
  "composer",
  "right-panel",
  // Recorded graph panels (Dokkabi R4): registered when mounted, reported
  // as explicitly absent otherwise.
  "work-graph",
  "context-graph",
] as const;
export type PresentationSurfaceId = (typeof PRESENTATION_SURFACE_IDS)[number];

/** Stable DOM attribute carrying a surface's presentation ID on the element. */
export const PRESENTATION_SURFACE_DATA_ATTRIBUTE = "data-presentation-id";

export interface PresentationLayoutRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Computed-style sample of one registered surface, measured from the live
 * element at capture time: resolved colors (including derived ones), fonts,
 * sizes, spacing, radius and motion actually in effect — never token
 * promises. Null when the environment reports no computed value.
 */
export interface PresentationComputedStyleSample {
  readonly backgroundColor: string | null;
  readonly color: string | null;
  readonly borderColor: string | null;
  readonly fontFamily: string | null;
  readonly fontSize: string | null;
  readonly lineHeight: string | null;
  readonly borderRadius: string | null;
  readonly paddingInline: string | null;
  readonly transitionDuration: string | null;
}

/**
 * Values the root element actually resolves for every registered token
 * variable (theme base, explicit alias and motion consumers): evidence that
 * an override reaches real consumers, not just the variable map.
 */
export type PresentationResolvedTokens = {
  readonly [path in PresentationTokenPropertyPath]: string | null;
};

export type PresentationSurfaceMeasurement =
  | {
      readonly status: "measured";
      readonly rect: PresentationLayoutRect;
      /**
       * False when the registered element is disconnected, hidden or entirely
       * outside the viewport; measured from the live element, not the config.
       */
      readonly visible: boolean;
      /** True when any part of the rect lies outside the viewport. */
      readonly clipped: boolean;
      /** Computed styles of the registered element at capture time. */
      readonly styles: PresentationComputedStyleSample;
    }
  | { readonly status: "absent" };

export interface PresentationLayoutSnapshot {
  readonly schemaVersion: typeof PRESENTATION_SCHEMA_VERSION;
  readonly capturedAt: string;
  readonly configRevision: number;
  readonly configDigest: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly zoom: number;
  readonly devicePixelRatio: number;
  readonly surfaces: Readonly<Record<PresentationSurfaceId, PresentationSurfaceMeasurement>>;
  readonly resolvedTokens: PresentationResolvedTokens;
}

export const PresentationLayoutRectSchema: Schema.Codec<PresentationLayoutRect> = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});

const nullableComputedString = () => Schema.NullOr(Schema.String);

export const PresentationComputedStyleSampleSchema: Schema.Codec<PresentationComputedStyleSample> =
  Schema.Struct({
    backgroundColor: nullableComputedString(),
    color: nullableComputedString(),
    borderColor: nullableComputedString(),
    fontFamily: nullableComputedString(),
    fontSize: nullableComputedString(),
    lineHeight: nullableComputedString(),
    borderRadius: nullableComputedString(),
    paddingInline: nullableComputedString(),
    transitionDuration: nullableComputedString(),
  });

export const PresentationResolvedTokensSchema: Schema.Codec<PresentationResolvedTokens> =
  Schema.Struct({
    "color.background": nullableComputedString(),
    "color.surface": nullableComputedString(),
    "color.text": nullableComputedString(),
    "color.muted": nullableComputedString(),
    "color.border": nullableComputedString(),
    "color.accent": nullableComputedString(),
    "radius.panel": nullableComputedString(),
    "radius.control": nullableComputedString(),
    "spacing.base": nullableComputedString(),
    "font.family": nullableComputedString(),
    "font.familyMono": nullableComputedString(),
    "font.sizePrompt": nullableComputedString(),
    "font.sizeCode": nullableComputedString(),
    "font.lineHeight": nullableComputedString(),
    "transition.durationMs": nullableComputedString(),
  });

export const PresentationSurfaceMeasurementSchema: Schema.Codec<PresentationSurfaceMeasurement> =
  Schema.Union([
    Schema.Struct({
      status: Schema.Literal("measured"),
      rect: PresentationLayoutRectSchema,
      visible: Schema.Boolean,
      clipped: Schema.Boolean,
      styles: PresentationComputedStyleSampleSchema,
    }),
    Schema.Struct({ status: Schema.Literal("absent") }),
  ]);

export const PresentationLayoutSnapshotSchema: Schema.Codec<PresentationLayoutSnapshot> =
  Schema.Struct({
    schemaVersion: Schema.Literals([PRESENTATION_SCHEMA_VERSION]),
    capturedAt: Schema.String,
    configRevision: Schema.Int,
    configDigest: Schema.String,
    viewport: Schema.Struct({ width: Schema.Finite, height: Schema.Finite }),
    zoom: Schema.Finite,
    devicePixelRatio: Schema.Finite,
    surfaces: Schema.Struct({
      root: PresentationSurfaceMeasurementSchema,
      navigation: PresentationSurfaceMeasurementSchema,
      conversation: PresentationSurfaceMeasurementSchema,
      composer: PresentationSurfaceMeasurementSchema,
      "right-panel": PresentationSurfaceMeasurementSchema,
      "work-graph": PresentationSurfaceMeasurementSchema,
      "context-graph": PresentationSurfaceMeasurementSchema,
    }),
    resolvedTokens: PresentationResolvedTokensSchema,
  });

/** Longest override document the host will read or accept (bytes). */
export const PRESENTATION_CONFIG_MAX_BYTES = 262_144;
