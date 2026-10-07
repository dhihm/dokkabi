import type { EventLog } from "./event-log.ts";

/**
 * The evidence gate: cross-check what an answer cites against what the
 * session actually read.
 *
 * This is not a model judging a model. Every read the loop performs is
 * already an observe or effect event — workspace reads, repository reads at a
 * pinned commit, authenticated GitHub reads, anonymous fetches — so a claim
 * that names a file, a commit, or an issue can be checked against that record
 * mechanically, at no token cost. A citation nothing ever read is the exact
 * shape of a fabricated one.
 */

export type CitationKind = "path" | "sha" | "issue" | "url";

export interface Citation {
  kind: CitationKind;
  value: string;
}

export interface EvidenceReview {
  cited: Citation[];
  unverified: Citation[];
}

export interface RecordedEvidence {
  paths: string[];
  shas: string[];
  issues: string[];
  urls: string[];
}

const URL_PATTERN = /https?:\/\/[^\s)>\]"'`]+/g;
/** Issue references need a marker: a bare number in prose is not a citation. */
const ISSUE_PATTERN = /(?:#|issues?[\s/#-]{0,2})(\d{2,7})\b/gi;
/** Hex that contains at least one letter, so decimal figures stay out. */
const SHA_PATTERN = /\b(?=[0-9a-f]{7,40}\b)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g;
const SOURCE_EXTENSIONS = "ts|tsx|js|jsx|mjs|cjs|py|rs|go|c|h|cc|cpp|hpp|java|rb|sh|md|json|ya?ml|toml|sql|cu|cuh";
/** A path with a directory separator, or a bare file name with a code extension. */
const PATH_PATTERN = new RegExp(
  `(?:[\\w.\\-]+/)*[\\w.\\-]+\\.(?:${SOURCE_EXTENSIONS})\\b`,
  "g",
);

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Pull the checkable claims out of an answer: paths, commits, issues, urls. */
export function extractCitations(text: string): Citation[] {
  const urls = unique(text.match(URL_PATTERN) ?? []);
  // Paths and shas inside a url are part of the url, not separate claims.
  let rest = text;
  for (const url of urls) {
    rest = rest.replaceAll(url, " ");
  }
  const paths = unique(rest.match(PATH_PATTERN) ?? []);
  const shas = unique(rest.match(SHA_PATTERN) ?? []);
  const issues = unique([...rest.matchAll(ISSUE_PATTERN)].map((match) => match[1] ?? ""));
  return [
    ...paths.map((value) => ({ kind: "path" as const, value })),
    ...shas.map((value) => ({ kind: "sha" as const, value })),
    ...issues.filter((value) => value !== "").map((value) => ({ kind: "issue" as const, value })),
    ...urls.map((value) => ({ kind: "url" as const, value })),
  ];
}

type LoggedEvent = { name: string; payload: Record<string, unknown> };

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Everything this session demonstrably read, by trust domain. */
export function recordedEvidence(events: readonly LoggedEvent[]): RecordedEvidence {
  const paths: string[] = [];
  const shas: string[] = [];
  const issues: string[] = [];
  const urls: string[] = [];
  for (const event of events) {
    const payload = event.payload;
    if (event.name === "tool/start") {
      const hint = asString(payload.arg_hint);
      if (hint) {
        // read/write/edit carry a path; bash carries a command that names them.
        paths.push(...(hint.match(PATH_PATTERN) ?? []), hint);
      }
      continue;
    }
    if (event.name === "repo/read" || event.name === "repo/result" || event.name === "github/read" || event.name === "github/result") {
      const sha = asString(payload.sha);
      if (sha) {
        shas.push(sha);
      }
      if (event.name === "github/result" && payload.status === 200 && Array.isArray(payload.shas)) {
        shas.push(...payload.shas.filter((item): item is string => typeof item === "string" && /^[0-9a-f]{40}$/.test(item)));
      }
      const target = asString(payload.target) ?? asString(payload.path);
      if (target) {
        paths.push(...(target.match(PATH_PATTERN) ?? []), target);
      }
      if (Array.isArray(payload.paths)) {
        paths.push(...payload.paths.filter((item): item is string => typeof item === "string"));
      }
      if (typeof payload.number === "number") {
        issues.push(String(payload.number));
      }
      continue;
    }
    if (event.name === "web/fetch" || event.name === "web/result") {
      const url = asString(payload.url);
      if (url) {
        urls.push(url);
      }
    }
  }
  return { paths: unique(paths), shas: unique(shas), issues: unique(issues), urls: unique(urls) };
}

function pathBacked(cited: string, recorded: string[]): boolean {
  return recorded.some(
    (known) => known === cited || known.endsWith(`/${cited}`) || cited.endsWith(`/${known}`),
  );
}

function urlBacked(cited: string, recorded: RecordedEvidence): boolean {
  if (recorded.urls.some((known) => known === cited || known.startsWith(cited) || cited.startsWith(known))) {
    return true;
  }
  const issue = /github\.com\/[\w.-]+\/[\w.-]+\/issues\/(\d+)/.exec(cited);
  if (issue?.[1] && recorded.issues.includes(issue[1])) {
    return true;
  }
  const blob = /github\.com\/[\w.-]+\/[\w.-]+\/(?:blob|tree)\/[^/]+\/(.+)$/.exec(cited);
  return Boolean(blob?.[1] && pathBacked(blob[1], recorded.paths));
}

/** Check every citation in a text against the session's recorded reads. */
export function reviewEvidence(input: { text: string; events: readonly LoggedEvent[] }): EvidenceReview {
  const cited = extractCitations(input.text);
  const recorded = recordedEvidence(input.events);
  const unverified = cited.filter((citation) => {
    switch (citation.kind) {
      case "path":
        return !pathBacked(citation.value, recorded.paths);
      case "sha":
        return !recorded.shas.some((known) => known.startsWith(citation.value) || citation.value.startsWith(known));
      case "issue":
        return !recorded.issues.includes(citation.value);
      case "url":
        return !urlBacked(citation.value, recorded);
    }
  });
  return { cited, unverified };
}

/** Record the review so the dashboard and a later audit can both see it. */
export function appendEvidenceReview(log: EventLog, review: EvidenceReview, stage: string): void {
  log.append({
    kind: "observe",
    name: "review/evidence",
    payload: {
      stage,
      cited: review.cited.length,
      unverified: review.unverified.map((citation) => citation.value),
    },
  });
}

/** One operator-facing line when an answer cites something nothing read. */
export function evidenceWarning(review: EvidenceReview): string | undefined {
  if (review.unverified.length === 0) {
    return undefined;
  }
  const names = review.unverified.map((citation) => citation.value).slice(0, 5).join(", ");
  return `Unverified citations (nothing in this session read them): ${names}`;
}
