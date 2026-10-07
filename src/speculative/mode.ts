export const SPECULATIVE_MODE_ENV = "DOKKABI_SPECULATIVE";

export type SpeculativeMode = "off" | "read-only" | "full";
export type SpeculativeModeSource = "cli" | "env" | "default";

export function parseSpeculativeMode(raw: string | undefined, complaint: string): SpeculativeMode | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === "") return undefined;
  if (value === "off" || value === "read-only" || value === "full") return value;
  throw new Error(complaint);
}

export function resolveSpeculativeMode(input: {
  readonly explicit?: string;
  readonly env?: string;
} = {}): { readonly mode: SpeculativeMode; readonly source: SpeculativeModeSource } {
  const explicit = parseSpeculativeMode(
    input.explicit,
    "--speculative requires off, read-only, or full",
  );
  if (explicit !== undefined) return { mode: explicit, source: "cli" };
  const env = parseSpeculativeMode(
    input.env,
    `${SPECULATIVE_MODE_ENV} must be off, read-only, or full`,
  );
  if (env !== undefined) return { mode: env, source: "env" };
  return { mode: "off", source: "default" };
}
