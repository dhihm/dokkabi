/**
 * Language-server wire framing (#222 L1). Both dialects a v1 profile speaks
 * — the Language Server Protocol and TypeScript's tsserver — write
 * `Content-Length: N\r\n\r\n<json>` frames; what the host writes differs
 * (LSP frames, tsserver one JSON line). A server's bytes are data: a frame
 * over the bound, a malformed header or an unparsable body breaks the
 * connection (the generation ends) or is dropped and counted; nothing a
 * server writes is ever executed.
 */

/** One frame's body, bytes. Anything larger ends the connection. */
export const LSP_FRAME_MAX_BYTES = 8 * 1024 * 1024;
const HEADER_MAX_BYTES = 1024;

export class FrameError extends Error {
  constructor(readonly code: "header_oversize" | "header_malformed" | "frame_oversize") {
    super(code);
    this.name = "FrameError";
  }
}

export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  /** Bodies that were not JSON objects (dropped, counted). */
  malformed = 0;

  /** Feed bytes; returns the complete JSON messages. Throws FrameError when
   * the stream cannot be framed any more. */
  push(chunk: Uint8Array): unknown[] {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const out: unknown[] = [];
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (this.buffer.length > HEADER_MAX_BYTES) throw new FrameError("header_oversize");
        return out;
      }
      if (headerEnd > HEADER_MAX_BYTES) throw new FrameError("header_oversize");
      const header = this.buffer.subarray(0, headerEnd).toString("latin1");
      let length: number | undefined;
      for (const line of header.split("\r\n")) {
        const match = /^content-length:\s*(\d{1,10})\s*$/iu.exec(line);
        if (match) length = Number(match[1]);
      }
      if (length === undefined || !Number.isSafeInteger(length)) throw new FrameError("header_malformed");
      if (length > LSP_FRAME_MAX_BYTES) throw new FrameError("frame_oversize");
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return out;
      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      try {
        const value = JSON.parse(body.trim()) as unknown;
        if (value !== null && typeof value === "object" && !Array.isArray(value)) out.push(value);
        else this.malformed += 1;
      } catch {
        this.malformed += 1;
      }
    }
  }
}

export function encodeLspFrame(message: unknown): Uint8Array {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "latin1"), body]);
}

export function encodeJsonLine(message: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
