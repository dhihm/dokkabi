import type { PermissionMode } from "../host/permissions.ts";
import type { EventRecord } from "../host/schema.ts";
import { toolProfileToolNames, type ToolProfileName } from "./tool-profiles.ts";

/**
 * What happens when a step calls a tool outside its profile.
 *
 * A todo's profile narrows the tools it works with. It used to do that by
 * sending the model only those tools, which cost twice. The model could not
 * know a tool existed, let alone ask for it: a live campaign scoped a step to
 * kernel_work, which has no ssh, and the step could not reach the only host
 * its work lived on. And every change of profile changed the tool block at the
 * head of the prompt, so the provider's prompt cache missed in full -- 72k
 * tokens rewritten the moment that campaign went from planning (28 tools) to
 * its first step (4), and again on every switch back.
 *
 * Now a working profile sends every tool and holds the profile at the call:
 *   ask    -- refuse, naming the profile's tools and how to widen it
 *   auto   -- widen this step's profile by that tool, record it, run it
 *   bypass -- run it, and record that it was outside the profile
 * `verify` and `last_word` refuse in every mode and still send only their own
 * tools: they exist to keep a verifier and a closing turn to their surface.
 *
 * No safety guard depends on this. Workspace, secret, private-coordinate and
 * approval checks run on every call whatever the profile.
 */

export type OutOfProfileAction = "refuse" | "widen" | "allow";
export const PROFILE_EXCEEDED = "tool/profile_exceeded";

const CLOSED_PROFILES: ReadonlySet<ToolProfileName> = new Set(["verify", "last_word"]);

/** A working profile sends the full tool surface; a closed one only its own. */
export function sendsFullSurface(profile: ToolProfileName): boolean {
  return !CLOSED_PROFILES.has(profile);
}

export function outOfProfileAction(mode: PermissionMode, profile: ToolProfileName): OutOfProfileAction {
  if (CLOSED_PROFILES.has(profile) || mode === "ask") return "refuse";
  return mode === "bypass" ? "allow" : "widen";
}

/** The tools a step may call: its profile, plus what auto mode widened it by. */
export function enforcedTools(
  events: readonly EventRecord[],
  profile: ToolProfileName,
  todo: string,
  available: readonly string[],
): string[] {
  if (profile === "default") return [...available];
  const base = toolProfileToolNames(profile).filter((name) => available.includes(name));
  const widened = new Set<string>();
  for (const event of events) {
    if (event.name !== PROFILE_EXCEEDED) continue;
    const p = event.payload;
    if (p.action === "widen" && p.profile === profile && p.todo === todo && typeof p.tool === "string"
      && available.includes(p.tool) && !base.includes(p.tool)) widened.add(p.tool);
  }
  return [...base, ...[...widened].sort()];
}

export function refusalText(tool: string, profile: ToolProfileName, allowed: readonly string[]): string {
  return `tool ${tool} is outside this step's tool profile (${profile}: ${allowed.join(", ")}). `
    + (CLOSED_PROFILES.has(profile)
      ? `The ${profile} profile is closed; do the work with the tools above.`
      : "Use one of the tools above, or widen this todo's profile in the ledger on the next replan.");
}
