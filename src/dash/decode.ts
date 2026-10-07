/**
 * stdin delivers bytes, keys arrive as characters.
 *
 * A read() can end in the middle of a multi-byte sequence: "안녕" is six
 * bytes, and a chunk boundary between them turned the first syllable into a
 * replacement character in the operator's note. Decoding each chunk
 * independently cannot fix that, so the incomplete tail is carried over to
 * the next chunk instead.
 *
 * This is deliberately not a full grapheme segmenter — it only guarantees
 * that no code point is split across a read.
 */
export class Utf8Stream {
  private pending: Uint8Array = new Uint8Array(0);

  /** Decode everything that is complete; hold an unfinished tail for later. */
  push(chunk: Uint8Array): string {
    const buffer = this.pending.length > 0 ? concat(this.pending, chunk) : chunk;
    const cut = completeLength(buffer);
    this.pending = buffer.subarray(cut);
    return cut === 0 ? "" : new TextDecoder("utf-8").decode(buffer.subarray(0, cut));
  }

  /** Bytes held back because they are an unfinished character. */
  get pendingBytes(): number {
    return this.pending.length;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Length of the prefix that decodes cleanly. A UTF-8 sequence is at most four
 * bytes, so at most the last three can be incomplete.
 */
export function completeLength(bytes: Uint8Array): number {
  for (let back = 1; back <= 3 && back <= bytes.length; back += 1) {
    const at = bytes.length - back;
    const byte = bytes[at]!;
    if ((byte & 0xc0) === 0x80) {
      // A continuation byte: keep walking back to its leader.
      continue;
    }
    const needed = sequenceLength(byte);
    if (needed === 0) {
      // Not a leader either (stray byte): nothing is pending.
      return bytes.length;
    }
    return needed <= back ? bytes.length : at;
  }
  return bytes.length;
}

function sequenceLength(byte: number): number {
  if ((byte & 0x80) === 0) {
    return 1;
  }
  if ((byte & 0xe0) === 0xc0) {
    return 2;
  }
  if ((byte & 0xf0) === 0xe0) {
    return 3;
  }
  if ((byte & 0xf8) === 0xf0) {
    return 4;
  }
  return 0;
}
