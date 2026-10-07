import { fetchPublicHttps } from "./public-https.ts";
import type { EventLog } from "./event-log.ts";
import { redactText } from "./redact.ts";
import { BlobStore } from "./blob-store.ts";
import { readResponseBounded } from "./bounded-response.ts";

export interface WebFetchOutcome {
  text: string;
  error: boolean;
  final_url?: string;
  source_blob?: string;
  source_bytes?: number;
  format?: "text" | "readable_html";
}
export type WebFetcher = (url: string, options?: { signal: AbortSignal; maxBytes: number }) => Promise<{ status: number; body: string; location?: string; content_type?: string }>;
export const FETCH_SOURCE_LIMIT = 4 * 1024 * 1024;
export const FETCH_TOTAL_LIMIT = 8 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 30_000;
const FETCH_VIEW_LIMIT = 8 * 1024 * 1024;
/** Legacy presentation limit; full safe source now goes to result delivery. */
export const FETCH_BODY_LIMIT = 100_000;
export function redactUrl(url: string): string {
  return url.replace(/(https?:\/\/[^:/@]+:)[^@]+@/g, "$1[REDACTED]@");
}
const GITHUB_HOST = /^https?:\/\/(www\.)?github\.com\//i;
const defaultFetcher: WebFetcher = (url, options) => fetchPublicHttps(url, {
  signal: options?.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
  maxBytes: options?.maxBytes ?? FETCH_SOURCE_LIMIT,
});
function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, key: string) => {
    if (!key.startsWith("#")) return named[key.toLowerCase()] ?? match;
    const n = key[1]?.toLowerCase() === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : match;
  });
}
async function htmlView(body: string, sourceUrl: string): Promise<{ text: string; redirect?: string }> {
  let redirect: string | undefined, title = "";
  const rewritten = new HTMLRewriter()
    .on("meta", { element(e) {
      if (e.getAttribute("http-equiv")?.toLowerCase() === "refresh") {
        const target = /^\s*0(?:\.0*)?\s*;\s*url\s*=\s*(.+?)\s*$/i.exec(e.getAttribute("content") ?? "");
        if (target) redirect = decodeEntities(target[1]!.replace(/^['"]|['"]$/g, ""));
      }
    } })
    .on("title", { text(t) { title += t.text; } })
    .on("script, style, nav, header, footer, aside", { element(e) { e.remove(); } })
    .on("a[href]", { element(e) {
      try {
        const href = new URL(decodeEntities(e.getAttribute("href") ?? ""), sourceUrl);
        if (href.protocol === "https:" && !href.username && !href.password) e.append(` (${redactUrl(href.href)})`);
      } catch { /* Invalid destinations remain ordinary link text. */ }
    } })
    .on("p, div, pre, li, h1, h2, h3, h4, br, tr", { element(e) { e.before("\n"); e.after("\n"); } })
    .transform(new Response(body));
  const cleaned = await readResponseBounded(rewritten, FETCH_VIEW_LIMIT);
  // Prefer content landmarks over chrome. No site-specific scraping or JS.
  for (const selector of ["article", "main", '[role="main"]', "body"]) {
    let text = "";
    await new HTMLRewriter().on(selector, { text(t) { text += t.text; } }).transform(new Response(cleaned)).text();
    if (text.trim()) return { text: `${title.trim() ? "Title: " + decodeEntities(title.trim()) + "\n\n" : ""}${decodeEntities(text).replace(/\n{4,}/g, "\n\n\n").trim()}`, redirect };
  }
  return { text: decodeEntities(cleaned.replace(/<[^>]*>/g, "")).trim(), redirect };
}
/** Each anonymous HTTPS hop is recorded before fetching. Safe complete bytes
 * are retained; model projection and recovery belong to result delivery. */
export async function webFetch(input: { log: EventLog; url: string; fetcher?: WebFetcher }): Promise<WebFetchOutcome> {
  const denied = (url: string) => url.length > 8192 ? "web_fetch URL length limit exceeded" : GITHUB_HOST.test(url)
    ? "web_fetch is anonymous public HTTPS only. For GitHub issues, files, or directory listings use the github tool (op: issue | blob | tree)."
    : !/^https:\/\//.test(url) ? "web_fetch refuses non-https redirect or URL" : undefined;
  const initial = denied(input.url);
  if (initial) return { text: initial, error: true };
  const seen = new Set<string>();
  let url = input.url;
  const fetcher = input.fetcher ?? defaultFetcher;
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let remainingBytes = FETCH_TOTAL_LIMIT;
  for (let hop = 0; hop < 6; hop++) {
    const refusal = denied(url);
    if (refusal || seen.has(url)) return { text: refusal ?? "web_fetch redirect cycle refused", error: true };
    seen.add(url);
    input.log.append({ kind: "effect", name: "web/fetch", payload: { url: redactUrl(url), hop } });
    try {
      signal.throwIfAborted();
      const maxBytes = Math.min(FETCH_SOURCE_LIMIT, remainingBytes);
      const result = await fetcher(url, { signal, maxBytes });
      signal.throwIfAborted();
      const receivedBytes = Buffer.byteLength(result.body);
      if (receivedBytes > maxBytes) throw new Error("web response byte limit exceeded");
      remainingBytes -= receivedBytes;
      const safeBody = redactText(result.body);
      const html = /text\/html/i.test(result.content_type ?? "") || /^\s*(?:<!doctype\s+html|<(?:html|head|body|main|article|meta)\b)/i.test(result.body);
      const view = html ? await htmlView(result.body, url) : { text: safeBody, redirect: undefined };
      const redirect = result.status >= 300 && result.status < 400 ? result.location : result.status < 400 ? view.redirect : undefined;
      const blob = BlobStore.forSession(input.log.path).put(safeBody);
      input.log.append({ kind: "observe", name: "web/result", payload: { url: redactUrl(url), status: result.status, bytes: Buffer.byteLength(result.body), source_blob: blob, source_bytes: Buffer.byteLength(safeBody), format: html ? "readable_html" : "text", ...(redirect ? { redirect: redactUrl(new URL(redirect, url).href) } : {}) } });
      if (redirect) { url = new URL(redirect, url).href; continue; }
      const text = redactText(view.text);
      return { text: html ? `Source: ${redactUrl(url)}\n${text}` : text, error: result.status >= 400, final_url: redactUrl(url), source_blob: blob, source_bytes: Buffer.byteLength(safeBody), format: html ? "readable_html" : "text" };
    } catch (error) {
      const message = redactText(error instanceof Error ? error.message : String(error));
      input.log.append({ kind: "observe", name: "web/result", payload: { url: redactUrl(url), status: "error", error: message.slice(0, 200) } });
      return { text: `fetch failed: ${message}`, error: true };
    }
  }
  return { text: "web_fetch redirect limit exceeded", error: true };
}
