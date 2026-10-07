import { parseKey, StdinBuffer } from "@dokkabi/pi-tui";
import { Utf8Stream } from "./decode.ts";

/**
 * Input decoding for the board, on the @dokkabi/pi-tui StdinBuffer
 * (#37 T4, D-2026-08-21-23). The fork owns sequence completeness — CSI,
 * OSC, DCS, APC, kitty disambiguation, bracketed paste extraction, and the
 * escape timeout the tui used to juggle by hand. This adapter owns the two
 * contracts that must not move:
 *
 * 1. The keymap still receives plain key strings; a paste is still
 *    PASTE_START / body / PASTE_END, so the proven state machine and its
 *    tests hold unchanged.
 * 2. A read carrying a newline AND other characters without bracketed-paste
 *    markers is still treated as a bare paste (the keysFromChunk rule): a
 *    pasted note must never submit mid-line as if Enter were pressed.
 *
 * A lone ESC is held by the buffer's timeout; dispose() flushes whatever is
 * still pending so a board teardown never swallows a keypress.
 */

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** A CSI-u sequence: kitty's unicode-key encoding (`CSI codepoint;mods u`). */
const KITTY_CSI_U = /^\x1b\[[0-9;:]*u$/;

/** Normalize terminal-specific plain vertical arrows to the keymap's proven
 * legacy sequences. Modified arrows keep their distinct raw forms. */
function verticalArrowLegacyKey(sequence: string): string | undefined {
  const id = parseKey(sequence);
  if (id === "up") return "\x1b[A";
  if (id === "down") return "\x1b[B";
  return undefined;
}

/**
 * Kitty keyboard protocol flag 1 (disambiguate): Escape arrives as CSI 27 u
 * — no timeout guessing — and ctrl/alt chords arrive as CSI-u instead of
 * ESC-glued bytes, and some terminals encode plain arrows as Kitty special
 * key codepoints. Translate those controls back to the legacy keymap contract.
 *
 * Returns the legacy key string the keymap already proves, or undefined
 * for keys the keymap never understood (those drop — they must never reach
 * a note as literal text).
 */
export function kittyLegacyKey(sequence: string): string | undefined {
  if (!KITTY_CSI_U.test(sequence)) {
    return undefined;
  }
  const id = parseKey(sequence);
  if (id === undefined) {
    return undefined;
  }
  const arrow = verticalArrowLegacyKey(sequence);
  if (arrow !== undefined) {
    return arrow;
  }
  if (id === "escape") {
    return "\x1b";
  }
  if (id === "enter") {
    return "\r";
  }
  if (id === "tab") {
    return "\t";
  }
  if (id === "shift+tab") {
    return "\x1b[Z";
  }
  if (id === "backspace") {
    return "\x7f";
  }
  if (id.startsWith("ctrl+")) {
    const char = id.slice("ctrl+".length);
    if (char.length === 1) {
      const code = char.codePointAt(0)!;
      // Letters map to their legacy control byte; other single chars
      // (ctrl+@, ctrl+[, ...) have no keymap binding and drop.
      if ((code >= 97 && code <= 122) || (code >= 64 && code <= 95)) {
        return String.fromCharCode(code & 0x1f);
      }
    }
    return undefined;
  }
  if (id.startsWith("alt+")) {
    const name = id.slice("alt+".length);
    // Named keys map to their legacy form; single characters to the
    // meta-chord form the keymap already tolerates as one key.
    const named: Record<string, string> = {
      backspace: "\x7f",
      enter: "\r",
      tab: "\t",
    };
    if (named[name] !== undefined) {
      return `\x1b${named[name]}`;
    }
    if (name.length === 1) {
      return `\x1b${name}`;
    }
    return undefined;
  }
  return undefined;
}

/** One read carrying a newline and other characters is a bare paste. */
function looksLikeBarePaste(text: string): boolean {
  return text.length > 1 && /[\n]/.test(text);
}

export interface KeySource {
  /** Feed raw stdin bytes; complete keys are delivered to onKeys. */
  push(bytes: Uint8Array): void;
  /** Flush pending sequences (lone ESC, incomplete tail) and detach. */
  dispose(): void;
}

export function createKeySource(onKeys: (keys: string[]) => void): KeySource {
  const decoder = new Utf8Stream();
  const buffer = new StdinBuffer();
  let disposed = false;
  const emit = (keys: string[]): void => {
    if (!disposed && keys.length > 0) {
      onKeys(keys);
    }
  };
  buffer.on("data", (sequence: string) => {
    const arrow = verticalArrowLegacyKey(sequence);
    if (arrow !== undefined) {
      emit([arrow]);
      return;
    }
    if (KITTY_CSI_U.test(sequence)) {
      // Kitty encoding: translate to the legacy key string, or drop what
      // the keymap never understood — it must not paste into a note.
      const legacy = kittyLegacyKey(sequence);
      if (legacy !== undefined) {
        emit([legacy]);
      }
      return;
    }
    emit([sequence]);
  });
  buffer.on("paste", (body: string) => {
    emit(body.length > 0 ? [PASTE_START, body, PASTE_END] : [PASTE_START, PASTE_END]);
  });
  return {
    push(bytes: Uint8Array): void {
      if (disposed) {
        return;
      }
      const text = decoder.push(bytes);
      if (text.length === 0) {
        return;
      }
      // Terminals without bracketed paste send a paste bare, and the buffer
      // emits plain text per glyph — so the bare-paste inference happens on
      // the decoded read, before the buffer shreds it (the keysFromChunk
      // rule: a newline plus other characters is a paste, a lone "\r" is
      // Enter).
      if (!text.includes(PASTE_START) && looksLikeBarePaste(text)) {
        emit([PASTE_START, text, PASTE_END]);
        return;
      }
      buffer.process(text);
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      const pending = buffer.flush();
      // Anything the decoder still holds is an unfinished character: its
      // bytes cannot form a key, so they are dropped with the stream.
      for (const sequence of pending) {
        emit([sequence]);
      }
      disposed = true;
      buffer.removeAllListeners();
    },
  };
}
