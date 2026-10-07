/**
 * #222 D4: a server's range is a UTF-16 position (LSP's default encoding,
 * and tsserver's offsets), validated against the exact bytes the host sent
 * for that document version and mapped to byte offsets exactly. A position
 * past its line, inside a surrogate pair, on a line that does not exist, or
 * in bytes that are not UTF-8 is refused — never clamped or guessed.
 */

export type PositionRefusal =
  | "invalid_utf8"
  | "not_integer"
  | "line_out_of_range"
  | "character_out_of_range"
  | "inside_surrogate_pair"
  | "inverted_range";

export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

export interface MappedRange {
  /** 0-based line and UTF-16 character, as validated. */
  readonly start: LspPosition;
  readonly end: LspPosition;
  /** Byte offsets into the document's bytes, half-open. */
  readonly startByte: number;
  readonly endByte: number;
  /** The server's end was past its line; the line's end was used (LSP rule). */
  readonly endDefaulted?: boolean;
}

/** A document's text indexed by line, built once per version. */
export class DocumentText {
  readonly text: string;
  /** UTF-16 index where each line starts. */
  private readonly starts: number[];
  /** UTF-16 length of each line without its terminator. */
  private readonly lengths: number[];
  /** Byte offset where each line starts. */
  private readonly byteStarts: number[];

  private constructor(text: string) {
    this.text = text;
    this.starts = [];
    this.lengths = [];
    this.byteStarts = [];
    let index = 0;
    let bytes = 0;
    for (;;) {
      this.starts.push(index);
      this.byteStarts.push(bytes);
      let end = index;
      while (end < text.length && text[end] !== "\n" && text[end] !== "\r") end += 1;
      this.lengths.push(end - index);
      if (end >= text.length) break;
      // LSP line terminators: \n, \r\n and \r.
      const terminator = text[end] === "\r" && text[end + 1] === "\n" ? 2 : 1;
      bytes += Buffer.byteLength(text.slice(index, end + terminator), "utf8");
      index = end + terminator;
    }
  }

  /** Undefined when the bytes are not UTF-8 (a BOM is kept as a character). */
  static fromBytes(bytes: Uint8Array): DocumentText | undefined {
    try {
      return new DocumentText(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
    } catch {
      return undefined;
    }
  }

  get lineCount(): number {
    return this.starts.length;
  }

  /** The byte offset of a validated position, or why it is refused. */
  byteOffset(position: LspPosition): number | PositionRefusal {
    const { line, character } = position;
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(character) || line < 0 || character < 0) return "not_integer";
    if (line >= this.starts.length) return "line_out_of_range";
    if (character > this.lengths[line]!) return "character_out_of_range";
    const index = this.starts[line]! + character;
    const before = this.text.charCodeAt(index - 1);
    const at = this.text.charCodeAt(index);
    if (character > 0 && before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff) return "inside_surrogate_pair";
    return this.byteStarts[line]! + Buffer.byteLength(this.text.slice(this.starts[line]!, index), "utf8");
  }

  /** The start is validated strictly. The end follows the LSP
   * specification's own rule: a character past its line's length defaults
   * to the line's length (servers mark "to the end of the line" this way);
   * such an end is reported as `endDefaulted`. Nothing else is adjusted. */
  mapRange(range: LspRange): MappedRange | PositionRefusal {
    const startByte = this.byteOffset(range.start);
    if (typeof startByte === "string") return startByte;
    let end = range.end;
    let endDefaulted = false;
    if (Number.isSafeInteger(end.line) && end.line >= 0 && end.line < this.starts.length
      && Number.isSafeInteger(end.character) && end.character > this.lengths[end.line]!) {
      end = { line: end.line, character: this.lengths[end.line]! };
      endDefaulted = true;
    }
    const endByte = this.byteOffset(end);
    if (typeof endByte === "string") return endByte;
    if (endByte < startByte) return "inverted_range";
    return { start: range.start, end, startByte, endByte, ...(endDefaulted ? { endDefaulted } : {}) };
  }
}

/** Parse an LSP range from untrusted server data. */
export function readRange(value: unknown): LspRange | undefined {
  if (!value || typeof value !== "object") return undefined;
  const start = readPosition((value as { start?: unknown }).start);
  const end = readPosition((value as { end?: unknown }).end);
  return start && end ? { start, end } : undefined;
}

function readPosition(value: unknown): LspPosition | undefined {
  if (!value || typeof value !== "object") return undefined;
  const line = (value as { line?: unknown }).line;
  const character = (value as { character?: unknown }).character;
  return typeof line === "number" && typeof character === "number" ? { line, character } : undefined;
}
