import { createHash } from "node:crypto";

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const MAX_DOCUMENT_BYTES = 4 * 1024;
const MAX_SYMBOLS_PER_DOCUMENT = 128;
const MAX_POSTINGS = 8 * 1024;
const MAX_TERM_CODE_UNITS = 64;
const MAX_QUERY_BYTES = 2 * 1024;
const SECRET_PATH = /(?:^|\/)(?:\.env(?:\..*)?|secrets?|credentials?|passwords?|tokens?|keys?|private)(?:\/|$)|(?:^|\/)(?:id_(?:rsa|ed25519)|auth\.json|\.npmrc)(?:$|\/)/iu;

export const MAX_LEXICAL_DOCUMENTS = 256;
export const MAX_LEXICAL_BYTES = 64 * 1024;
export const MAX_LEXICAL_QUERY_TERMS = 16;
export const MAX_LEXICAL_RESULTS = 16;

export type LexicalDocument = {
  readonly path: string;
  readonly symbols: readonly string[];
};

export interface LexicalIndex {
  readonly digest: string;
  /** Canonical document bytes, not an estimate or bound on retained heap. */
  readonly byteLength: number;
  search(query: string, limit?: number): readonly string[];
}

type IndexedDocument = {
  readonly path: string;
  readonly length: number;
};

type Posting = {
  readonly documentIndex: number;
  readonly termFrequency: number;
};

export class LexicalIndexInputError extends Error {
  readonly name = "LexicalIndexInputError";

  constructor() {
    super("lexical index input is not a safe, well-formed document");
  }
}

export class LexicalIndexBoundError extends Error {
  readonly name = "LexicalIndexBoundError";

  constructor() {
    super("lexical index input exceeds a fixed bound");
  }
}

export function buildLexicalIndex(documents: readonly LexicalDocument[]): LexicalIndex {
  if (documents.length > MAX_LEXICAL_DOCUMENTS) throw new LexicalIndexBoundError();
  const merged = mergeDocuments(documents);
  const canonical = canonicalDocuments(merged);
  const byteLength = Buffer.byteLength(canonical, "utf8");
  if (byteLength > MAX_LEXICAL_BYTES) throw new LexicalIndexBoundError();

  const indexed: IndexedDocument[] = [];
  const postings = new Map<string, Posting[]>();
  let postingCount = 0;
  for (const [path, symbols] of merged) {
    const terms = termFrequencies(path, symbols);
    const documentIndex = indexed.length;
    indexed.push({ path, length: terms.length });
    for (const [term, termFrequency] of terms.frequencies.entries()) {
      const termPostings = postings.get(term);
      if (termPostings) termPostings.push({ documentIndex, termFrequency });
      else postings.set(term, [{ documentIndex, termFrequency }]);
      postingCount += 1;
      if (postingCount > MAX_POSTINGS) throw new LexicalIndexBoundError();
    }
  }
  const averageLength = indexed.reduce((total, document) => total + document.length, 0) / indexed.length;
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");

  return Object.freeze({
    digest,
    byteLength,
    search(query: string, limit = 4): readonly string[] {
      return searchIndex({ indexed, postings, averageLength }, query, limit);
    },
  });
}

type SearchIndex = {
  readonly indexed: readonly IndexedDocument[];
  readonly postings: ReadonlyMap<string, readonly Posting[]>;
  readonly averageLength: number;
};

function mergeDocuments(documents: readonly LexicalDocument[]): readonly (readonly [string, readonly string[]])[] {
  const byPath = new Map<string, Set<string>>();
  for (const document of documents) {
    const path = safePath(document.path);
    if (!path) continue;
    if (document.symbols.length > MAX_SYMBOLS_PER_DOCUMENT) throw new LexicalIndexBoundError();
    const symbols = byPath.get(path) ?? new Set<string>();
    for (const symbol of document.symbols) {
      assertText(symbol);
      if (Buffer.byteLength(symbol, "utf8") > MAX_DOCUMENT_BYTES) throw new LexicalIndexBoundError();
      symbols.add(symbol);
    }
    byPath.set(path, symbols);
  }
  return [...byPath.entries()]
    .map(([path, symbols]) => [path, [...symbols].sort(compareLexical)] as const)
    .sort(([left], [right]) => compareLexical(left, right));
}

function canonicalDocuments(documents: readonly (readonly [string, readonly string[]])[]): string {
  return documents.map(([path, symbols]) => `${path}\0${symbols.join("\0")}\n`).join("");
}

function termFrequencies(path: string, symbols: readonly string[]): { readonly frequencies: ReadonlyMap<string, number>; readonly length: number } {
  const terms = [
    ...tokenize(path),
    ...symbols.flatMap(tokenize),
  ].sort(compareLexical);
  if (terms.length > MAX_SYMBOLS_PER_DOCUMENT * 2) throw new LexicalIndexBoundError();
  const frequencies = new Map<string, number>();
  for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  return { frequencies, length: terms.length };
}

function searchIndex(index: SearchIndex, query: string, limit: number): readonly string[] {
  if (!Number.isSafeInteger(limit) || limit <= 0 || Buffer.byteLength(query, "utf8") > MAX_QUERY_BYTES || !isWellFormed(query)) return [];
  const terms = [...new Set(tokenize(query))].sort(compareLexical).slice(0, MAX_LEXICAL_QUERY_TERMS);
  if (terms.length === 0 || index.indexed.length === 0) return [];
  const scores = new Map<number, number>();
  for (const term of terms) {
    const matches = index.postings.get(term);
    if (!matches) continue;
    const inverseFrequency = Math.log(1 + (index.indexed.length - matches.length + 0.5) / (matches.length + 0.5));
    for (const match of matches) {
      const document = index.indexed[match.documentIndex];
      if (!document) continue;
      const normalizer = match.termFrequency + BM25_K1 * (1 - BM25_B + BM25_B * document.length / index.averageLength);
      scores.set(match.documentIndex, (scores.get(match.documentIndex) ?? 0) + inverseFrequency * match.termFrequency * (BM25_K1 + 1) / normalizer);
    }
  }
  return Object.freeze([...scores.entries()]
    .sort(([leftIndex, leftScore], [rightIndex, rightScore]) => rightScore - leftScore || compareLexical(index.indexed[leftIndex]?.path ?? "", index.indexed[rightIndex]?.path ?? ""))
    .slice(0, Math.min(limit, MAX_LEXICAL_RESULTS))
    .flatMap(([documentIndex]) => index.indexed[documentIndex]?.path ?? []));
}

function safePath(path: string): string | undefined {
  assertText(path);
  if (!path || path.includes("\\") || path.includes("\0") || path.startsWith("/") || SECRET_PATH.test(path)) return undefined;
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /^[a-z]:$/iu.test(segment))) throw new LexicalIndexInputError();
  if (Buffer.byteLength(path, "utf8") > MAX_DOCUMENT_BYTES) throw new LexicalIndexBoundError();
  return path;
}

function tokenize(value: string): string[] {
  return value.normalize("NFKC")
    .replace(/([a-z\d])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .toLocaleLowerCase("en-US")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0 && term.length <= MAX_TERM_CODE_UNITS);
}

function assertText(value: string): void {
  if (!isWellFormed(value) || value.includes("\0") || value.includes("\n") || value.includes("\r")) throw new LexicalIndexInputError();
}

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function compareLexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
