/** Bound decoded response bytes, independently of untrusted response headers. */
export async function readResponseBounded(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid response byte limit");
  const reader = response.body?.getReader();
  if (!reader) { signal?.throwIfAborted(); return ""; }
  const bytes = new Uint8Array(maxBytes);
  let size = 0;
  let complete = false;
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort!(signal?.reason ?? new Error("response aborted"));
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      signal?.throwIfAborted();
      if (done) { complete = true; break; }
      if (value.byteLength > maxBytes - size) throw new Error("web response byte limit exceeded");
      bytes.set(value, size);
      size += value.byteLength;
    }
    return new TextDecoder().decode(bytes.subarray(0, size));
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // Cancellation must not hold the caller hostage to an uncooperative source.
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
