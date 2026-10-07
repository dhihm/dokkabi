/**
 * Compatibility facade for the retired crunchmode name.
 * New product code imports HEUNG from heung.ts.
 */
import type { EventRecord } from "../host/schema.ts";
import type { DriveResult } from "./drive.ts";
import {
  DEFAULT_HEUNG_WAVES,
  isHeungFalsey,
  isHeungTruthy,
  lastHeungOn,
  lastHeungWave,
  progressFingerprint,
  resolveHeung,
  runHeungWaves,
  shouldHeungContinue,
  takeHeungSignal,
} from "./heung.ts";

export const CRUNCH_TOKEN = "crunchmode";
export const DEFAULT_CRUNCH_WAVES = DEFAULT_HEUNG_WAVES;

export interface CrunchTake {
  order: string;
  keyword: boolean;
}

export interface ResolveCrunchInput {
  flag?: boolean;
  keyword?: boolean;
  env?: NodeJS.Dict<string>;
  config?: boolean;
}

export function takeCrunchKeyword(text: string): CrunchTake {
  const taken = takeHeungSignal(text);
  return { order: taken.order, keyword: taken.activated };
}

export const isCrunchTruthy = isHeungTruthy;
export const isCrunchFalsey = isHeungFalsey;

export function resolveCrunchMode(input: ResolveCrunchInput): boolean {
  return resolveHeung({
    flag: input.flag,
    activated: input.keyword,
    env: input.env,
    legacyConfig: input.config,
  });
}

export function lastCrunchOn(events: readonly EventRecord[]): boolean {
  return lastHeungOn(events);
}

export function lastCrunchWave(events: readonly EventRecord[]): number | undefined {
  return lastHeungWave(events);
}

export function shouldCrunchContinue(result: DriveResult): boolean {
  return shouldHeungContinue(result);
}

export { progressFingerprint };

export const crunchUntilDone = runHeungWaves;
