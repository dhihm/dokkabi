import { createHash } from "node:crypto";

/** A pattern plus the refusal-safe name of what it matches. A refusal names
 * the CLASS, never the value — the model cannot comply with a refusal it
 * cannot locate in its own arguments. */
interface LabeledPattern {
  readonly pattern: RegExp;
  readonly label: string;
}

/** Secret shapes that are self-evidently credentials wherever they appear. */
const CERTAIN_SECRET_CLASSES: readonly LabeledPattern[] = [
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g, label: "an API key token (sk-…)" },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, label: "an API key token (sk-ant-…)" },
  { pattern: /\bsk-or-[A-Za-z0-9_-]{8,}\b/g, label: "an API key token (sk-or-…)" },
  { pattern: /\bnvapi-[A-Za-z0-9_-]{8,}\b/g, label: "an API key token (nvapi-…)" },
  // Model checkpoints come from the HuggingFace hub, so this is the credential
  // this workload actually handles — and it was the one shape the guard missed.
  { pattern: /\bhf_(?:oauth_)?[A-Za-z0-9]{20,}\b/g, label: "a HuggingFace token (hf_…)" },
  { pattern: /\bapi_org_[A-Za-z0-9]{20,}\b/g, label: "an API key token (api_org_…)" },
  { pattern: /\bxai-[A-Za-z0-9_-]{8,}\b/g, label: "an API key token (xai-…)" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, label: "a GitHub token (gh*_…)" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: "a GitHub token (github_pat_…)" },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: "a Slack token (xox…)" },
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)?/g,
    label: "a private key block (-----BEGIN … PRIVATE KEY-----)",
  },
  { pattern: /(?:auth\.json[^A-Za-z0-9]{0,4})?"token"\s*:\s*"[A-Za-z0-9._\-]{16,}"/gi, label: "a token field in JSON" },
  { pattern: /[?&](?:access_token|refresh_token|id_token|code|state)=[^&\s"']+/gi, label: "an OAuth query parameter (access_token=…)" },
  { pattern: /(?:^|[\s"'])(?:eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, label: "a JWT (eyJ…)" },
];

/** Assignment- and Bearer-shaped matches whose captured VALUE decides.
 * The guard's own rejection message says "use a safe placeholder" — so a
 * value that is self-evidently one (an env reference, a template, dummy/
 * changeme/xxxx) must actually pass. Live, `api_key=EMPTY`-style benchmark
 * invocations were blocked eleven times in one run with no way to comply. */
const VALUE_JUDGED_SECRET_CLASSES: readonly LabeledPattern[] = [
  { pattern: /\bBearer\s+([A-Za-z0-9._\-+/=]{12,})\b/gi, label: "a Bearer token" },
  { pattern: /"(?:refresh_token|access_token|api_key)"\s*:\s*"([A-Za-z0-9._\-]{8,})"/gi, label: "a credential field in JSON" },
  {
    pattern: /["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*["']?([^\s,"'}]{8,})/gi,
    label: "a credential assignment (api_key=… style)",
  },
];

const CERTAIN_SECRET_PATTERNS: readonly RegExp[] = CERTAIN_SECRET_CLASSES.map((entry) => entry.pattern);
const VALUE_JUDGED_SECRET_PATTERNS: readonly RegExp[] = VALUE_JUDGED_SECRET_CLASSES.map((entry) => entry.pattern);

const PLACEHOLDER_VALUE = new RegExp(
  // The value capture stops at whitespace, quotes, and `}`, so a template's
  // closing braces may be cut off — the OPENING marker is what identifies a
  // placeholder, and the closings are optional here.
  "^(?:"
    + "<[^>]*>?"                          // <your-key-here>
    + "|\\{\\{[^}]*\\}?\\}?"              // {{TEMPLATE}}
    + "|\\$\\{[^}]*\\}?"                  // ${ENV_VAR}
    + "|['\"]?\\$[A-Za-z_][A-Za-z0-9_]*"  // $ENV_VAR
    + "|%[A-Za-z_]+%"                     // %ENV_VAR%
    + "|[xX]{4,}|\\*{3,}|[.]{3,}"         // xxxx / *** / ...
    + "|(?:dummy|fake|test|example|sample|placeholder|redacted|masked|empty|none|null|missing|changeme|change[-_]me|your|my)[A-Za-z0-9._-]*"
    + ")$",
  "iu",
);

function isPlaceholderValue(value: string): boolean {
  return PLACEHOLDER_VALUE.test(value.trim());
}

/** All shapes, for redaction: masking a placeholder is harmless. */
const SECRET_PATTERNS: readonly RegExp[] = [
  ...CERTAIN_SECRET_PATTERNS,
  ...VALUE_JUDGED_SECRET_PATTERNS,
];

// Private infrastructure coordinates belong in operator-owned runtime
// configuration, never in model-authored repository files. Keep this guard
// separate from the credential guard: private endpoints may be resolved only
// behind operator-owned capabilities, never supplied in model-authored tool
// arguments or persisted in source/EventLog. The list is NETWORK coordinates
// only: a home-directory path is not one (its only sensitive part is the
// account name, which normalizeHomePaths strips from durable records), and
// classing it as one fenced every call that named the session's own
// workspace — twenty bash calls in one live run — behind a refusal that
// named the wrong guard.
const PRIVATE_INFRASTRUCTURE_CLASSES: readonly LabeledPattern[] = [
  { pattern: /(?:^|[^0-9])10(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})){3}(?![0-9])/g, label: "a private IPv4 address (10.0.0.0/8)" },
  { pattern: /(?:^|[^0-9])172\.(?:1[6-9]|2[0-9]|3[01])(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})){2}(?![0-9])/g, label: "a private IPv4 address (172.16.0.0/12)" },
  { pattern: /(?:^|[^0-9])192\.168(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})){2}(?![0-9])/g, label: "a private IPv4 address (192.168.0.0/16)" },
  { pattern: /(?:^|[^A-Fa-f0-9:])f[cd][A-Fa-f0-9]{2}(?::[A-Fa-f0-9]{0,4}){1,7}(?![A-Fa-f0-9:])/g, label: "a unique-local IPv6 address (fc00::/7)" },
  { pattern: /\/dev\/(?:tcp|udp)\//gi, label: "a /dev/tcp or /dev/udp transport" },
  { pattern: /(?:\b(?:ssh|scp|sftp)\s+(?:[a-z0-9._-]+@)?|\b(?:on|host|server|node|machine)\s+|@)[a-z][a-z0-9-]*-[a-f0-9]{4,16}\b/gi, label: "a host coordinate (user@host or a hex-suffixed machine label)" },
];

const PRIVATE_INFRASTRUCTURE_PATTERNS: readonly RegExp[] = PRIVATE_INFRASTRUCTURE_CLASSES.map((entry) => entry.pattern);

export class SecretRejectedError extends Error {
  readonly code = "secret_rejected" as const;

  constructor(message = "refusing to append: payload looks like a secret") {
    super(message);
    this.name = "SecretRejectedError";
  }
}

/** Only GitHub REST issue/PR enum filters are public state, never OAuth state.
 * Match coordinates without trusting an arbitrary URL's query parameter. */
function publicGithubState(text: string, match: RegExpMatchArray): boolean {
  if (!/^[?&]state=(?:open|closed|all)$/i.test(match[0])) return false;
  const prefix = text.slice(0, match.index!);
  const endpoint = /(?:^|[\s"'`])(?:https:\/\/api\.github\.com\/)?repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:pulls|issues)\?(?:[^?\s"'`]*&)?$/i;
  return endpoint.test(prefix + match[0][0]);
}

function certainMatches(text: string, pattern: RegExp): RegExpMatchArray[] {
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)].filter(match => !publicGithubState(text, match));
}

export function containsSecret(text: string): boolean {
  const certain = CERTAIN_SECRET_PATTERNS.some((pattern) => {
    return certainMatches(text, pattern).length > 0;
  });
  if (certain) return true;
  return VALUE_JUDGED_SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = match[1];
      if (typeof value === "string" && !isPlaceholderValue(value)) return true;
    }
    return false;
  });
}

/** Where `containsSecret` finds its matches: [start, end) UTF-16 indexes of
 * every certain match and every value-judged match whose value is not a
 * placeholder. Each span starts on an ASCII character, so never inside a
 * surrogate pair. Used to shorten a cut piece by exactly the credential-
 * shaped span a cut exposed (#223). */
export function secretSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const pattern of CERTAIN_SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of certainMatches(text, pattern)) spans.push([match.index!, match.index! + match[0].length]);
  }
  for (const pattern of VALUE_JUDGED_SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = match[1];
      if (typeof value === "string" && !isPlaceholderValue(value)) spans.push([match.index, match.index + match[0].length]);
    }
  }
  return spans;
}

export function collectStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") {
    into.push(value);
    return into;
  }
  if (value === null || typeof value !== "object") {
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, into);
    }
    return into;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    collectStrings(nested, into);
  }
  return into;
}

/** Apply the EventLog's recursive string semantics before a value is shaped
 * or JSON-escaped for a narrower transport. */
export function containsSecretValue(value: unknown): boolean {
  return collectStrings(value).some((text) => containsSecret(text));
}

/** A credential the guard matched: the VALUE that decides a VALUE_JUDGED
 * class, or the whole match for a CERTAIN one, with the class it belongs to.
 * The value is carried so the boundary can ask who wrote it; it is never
 * recorded — only its digest is. */
interface SecretMatch {
  readonly value: string;
  readonly label: string;
  readonly certain: boolean;
}

function secretMatches(text: string): SecretMatch[] {
  const out: SecretMatch[] = [];
  for (const { pattern, label } of CERTAIN_SECRET_CLASSES) {
    pattern.lastIndex = 0;
    for (const match of certainMatches(text, pattern)) out.push({ value: match[0], label, certain: true });
  }
  for (const { pattern, label } of VALUE_JUDGED_SECRET_CLASSES) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = match[1];
      if (typeof value === "string" && !isPlaceholderValue(value)) out.push({ value, label, certain: false });
    }
  }
  return out;
}

/** The provenance record of a credential value: its digest, never the value.
 * A digest is enough to ask "did this session write this string before", and
 * carries no credential a reader of the log could use. */
export function secretValueDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The VALUE_JUDGED values a raw string or nested value carries, placeholders
 * excluded. Run on the model's RAW output, before any scrub withholds it. */
export function valueJudgedSecretValues(value: unknown): string[] {
  const out: string[] = [];
  for (const text of collectStrings(value)) {
    for (const match of secretMatches(text)) {
      if (match.certain || out.includes(match.value)) continue;
      out.push(match.value);
    }
  }
  return out;
}

function digestsOf(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const digest = secretValueDigest(value);
    if (!out.includes(digest)) out.push(digest);
  }
  return out;
}

/** The provenance a row built from the model's own raw output carries. A
 * digest the session has already seen in a result, the order or an operator
 * note is NOT authored — the model can only be echoing what it read — so it
 * is left out here as well as at the boundary. The observed set is a getter:
 * an ordinary row never carries a credential shape and never pays for it. */
export function authoredSecretDigests(value: unknown, observed: () => ReadonlySet<string>): string[] {
  const values = valueJudgedSecretValues(value);
  if (values.length === 0) return [];
  const seen = observed();
  return digestsOf(values).filter(digest => !seen.has(digest));
}

/** The provenance a row built from something the session READ carries: a tool
 * result, the operator's order, an operator note. */
export function observedSecretDigests(value: unknown): string[] {
  return digestsOf(valueJudgedSecretValues(value));
}

const AUTHORED_DIGEST_FIELD = "authored_secret_digests";
const OBSERVED_DIGEST_FIELD = "observed_secret_digests";
const DIGEST_HEX = /^[a-f0-9]{64}$/u;

/** Any row may carry provenance; only a builder that saw the model's own raw
 * output writes the authored field, and only one that saw a result, the order
 * or an operator note writes the observed field. */
export interface SecretProvenanceEvent {
  readonly name?: string;
  readonly payload?: unknown;
}

function digestField(event: SecretProvenanceEvent, field: string): string[] {
  const payload = event.payload;
  if (payload === null || typeof payload !== "object") return [];
  const digests = (payload as Record<string, unknown>)[field];
  if (!Array.isArray(digests)) return [];
  return digests.filter((digest): digest is string => typeof digest === "string" && DIGEST_HEX.test(digest));
}

/**
 * Both provenance sets in one pass over the log, decided by which came FIRST.
 *
 * A digest whose first appearance is an authorship claim is authored; one
 * whose first appearance is an observation is observed, and the model cannot
 * author it afterwards by repeating it. The order matters in both directions:
 * a session that writes a password fixture and then READS the file back has
 * not turned its own product into an operator credential, so a later
 * observation does not withdraw an earlier claim. Within one row an
 * observation wins — a row that both read and claimed a value cannot show the
 * model had it first.
 */
export function sessionSecretProvenance(events: readonly SecretProvenanceEvent[]):
  { authored: ReadonlySet<string>; observed: ReadonlySet<string> } {
  const origin = new Map<string, "authored" | "observed">();
  for (const event of events) {
    for (const digest of digestField(event, OBSERVED_DIGEST_FIELD)) {
      if (!origin.has(digest)) origin.set(digest, "observed");
    }
    for (const digest of digestField(event, AUTHORED_DIGEST_FIELD)) {
      if (!origin.has(digest)) origin.set(digest, "authored");
    }
  }
  const authored = new Set<string>(), observed = new Set<string>();
  for (const [digest, source] of origin) (source === "authored" ? authored : observed).add(digest);
  return { authored, observed };
}

/**
 * The digests of the credential values this session authored through the
 * model.
 *
 * Provenance is established where a row is BUILT from the model's raw output —
 * a `tool/call` row's arguments before `safeToolCallArgs` withholds them, an
 * `assistant/message` text before `safeGeneratedText` replaces it — because
 * the scrub is what removes the only copy the log would otherwise hold. What
 * is retained is the digest, never the value. A `provider/response` body is a
 * third source and needs no builder: it IS the model's own output, and it is
 * retained before any row is built from it. A digest the session first saw in
 * a tool RESULT, the order or an operator note is never authored, however
 * often the model repeats it afterwards.
 */
export function sessionAuthoredSecretValues(events: readonly SecretProvenanceEvent[]): ReadonlySet<string> {
  return sessionSecretProvenance(events).authored;
}

/** The digests of the credential values this session READ rather than wrote. */
export function sessionObservedSecretValues(events: readonly SecretProvenanceEvent[]): ReadonlySet<string> {
  return sessionSecretProvenance(events).observed;
}

/**
 * The credential values in a candidate body that are new to the session.
 *
 * A CERTAIN class is always new: those shapes are self-evidently credentials
 * wherever they appear, and no authorship claim exempts them. A VALUE_JUDGED
 * match is new unless its value is a self-evident placeholder, or its digest
 * is in the authored set and not in the observed one. An empty result means
 * the body carries no credential the session must keep out.
 */
export function newSecretValues(value: unknown, authored: ReadonlySet<string>,
  observed: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  for (const text of collectStrings(value)) {
    for (const match of secretMatches(text)) {
      if (!match.certain) {
        const digest = secretValueDigest(match.value);
        if (authored.has(digest) && !observed.has(digest)) continue;
      }
      if (!out.includes(match.value)) out.push(match.value);
    }
  }
  return out;
}

/** The classes and count of the matches a body carries only because the
 * session authored them. Labels and counts only: never a value, never a
 * digest. */
export function authoredSecretMatches(value: unknown, authored: ReadonlySet<string>,
  observed: ReadonlySet<string> = new Set()): { classes: string[]; count: number } {
  const classes: string[] = [];
  let count = 0;
  for (const text of collectStrings(value)) {
    for (const match of secretMatches(text)) {
      if (match.certain) continue;
      const digest = secretValueDigest(match.value);
      if (!authored.has(digest) || observed.has(digest)) continue;
      count += 1;
      if (!classes.includes(match.label)) classes.push(match.label);
    }
  }
  return { classes, count };
}

export function containsPrivateInfrastructure(text: string): boolean {
  return PRIVATE_INFRASTRUCTURE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

/**
 * Rewrite `/home/<user>/` and `/Users/<user>/` to `~/`.
 *
 * A home directory path is not a network coordinate — the only sensitive part
 * is the account name, which combined with a host would form a login. Stripping
 * it leaves the path usable. This matters because a remote Linux workspace puts
 * that prefix on nearly every line it prints: without this, one home path in a
 * pytest traceback withheld the entire body and the model worked blind.
 */
export function normalizeHomePaths(text: string): string {
  return text.replaceAll(/\/(?:home|Users)\/[A-Za-z0-9._-]+(\/|$)/g, "~$1");
}

/**
 * Whether a tool call's arguments carry a private coordinate.
 *
 * The strings are home-normalized first as defence in depth: the coordinate
 * list is network shapes only, and normalization additionally keeps an
 * account-named segment that merely LOOKS like a coordinate's charset (a
 * home directory named `10.0.0.1`) from reading as an address.
 */
export function toolArgsCarryPrivateInfrastructure(args: unknown): boolean {
  return collectStrings(args).some((text) =>
    containsPrivateInfrastructure(normalizeHomePaths(text))
  );
}

export function containsPrivateInfrastructureValue(value: unknown): boolean {
  return collectStrings(value).some((text) => containsPrivateInfrastructure(text));
}

/** The class of the first secret shape in the text — for a refusal that names
 * what matched without echoing the value. */
export function secretShapeClass(text: string): string | undefined {
  for (const { pattern, label } of CERTAIN_SECRET_CLASSES) {
    pattern.lastIndex = 0;
    if (certainMatches(text, pattern).length > 0) return label;
  }
  for (const { pattern, label } of VALUE_JUDGED_SECRET_CLASSES) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = match[1];
      if (typeof value === "string" && !isPlaceholderValue(value)) return label;
    }
  }
  return undefined;
}

/** secretShapeClass over every nested string, in collection order. */
export function secretShapeClassInValue(value: unknown): string | undefined {
  for (const text of collectStrings(value)) {
    const label = secretShapeClass(text);
    if (label !== undefined) return label;
  }
  return undefined;
}

/** The class of the first private network coordinate in the text. */
export function privateInfrastructureClass(text: string): string | undefined {
  for (const { pattern, label } of PRIVATE_INFRASTRUCTURE_CLASSES) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return label;
  }
  return undefined;
}

/** privateInfrastructureClass over every nested string, raw — the same
 * footing as containsPrivateInfrastructureValue. */
export function privateInfrastructureClassInValue(value: unknown): string | undefined {
  for (const text of collectStrings(value)) {
    const label = privateInfrastructureClass(text);
    if (label !== undefined) return label;
  }
  return undefined;
}

/** The coordinate class of a tool call's arguments, on the same
 * home-normalized footing as toolArgsCarryPrivateInfrastructure. */
export function toolArgsPrivateInfrastructureClass(args: unknown): string | undefined {
  for (const text of collectStrings(args)) {
    const label = privateInfrastructureClass(normalizeHomePaths(text));
    if (label !== undefined) return label;
  }
  return undefined;
}

/** normalizeHomePaths over every string in a nested tool-argument value, for
 * the durable copy of a tool call. Keys are field names, not paths, and stay
 * as they are; execution always uses the original value. */
export function normalizeHomePathsValue(value: unknown): unknown {
  if (typeof value === "string") return normalizeHomePaths(value);
  if (Array.isArray(value)) return value.map(normalizeHomePathsValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, entry]) => [key, normalizeHomePathsValue(entry)]),
    );
  }
  return value;
}

export function assertNoSecrets(value: unknown): void {
  if (containsSecretValue(value)) {
    throw new SecretRejectedError();
  }
}

/** Redact known secret shapes in operator-facing strings. A caller that uses
 * the result in EventLog must re-check it or fall back to a fixed placeholder. */
export function redactText(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, (value, ...args) => {
      const index = args.at(-2) as number;
      return publicGithubState(out, Object.assign([value], { index }) as RegExpMatchArray) ? value : "[redacted]";
    });
  }
  return out;
}

/**
 * `redactText`, with the redactor's own records of what it replaced (#221
 * M2''): every `[redacted]` it substituted, as the [start, end) span of the
 * ORIGINAL text it stands for (UTF-16 offsets). The same patterns, in the
 * same order, with the same global/first-match semantics — so `text` equals
 * `redactText(input)`; a later pattern matching across an earlier marker
 * widens that span to everything both covered. Never derived by diffing the
 * output (a value ending in `]` or `d]` would lend its tail to the marker).
 */
export function redactTextWithSpans(input: string): { readonly text: string; readonly spans: readonly (readonly [number, number])[] } {
  // The current text as pieces: original characters kept at `at`, or
  // literal text the redactor wrote (a marker, or part of one a later match
  // cut) standing for an original span.
  type Piece =
    | { readonly kind: "kept"; readonly text: string; readonly at: number }
    | { readonly kind: "lit"; readonly text: string; readonly span: readonly [number, number] };
  const MARKER = "[redacted]";
  let pieces: Piece[] = input.length > 0 ? [{ kind: "kept", text: input, at: 0 }] : [];
  const render = (list: readonly Piece[]) => list.map((piece) => piece.text).join("");
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    const current = render(pieces);
    const matches: [number, number][] = [];
    if (pattern.global) {
      for (const match of current.matchAll(pattern)) {
        if (!publicGithubState(current, match)) matches.push([match.index!, match.index! + match[0].length]);
      }
    } else {
      const match = pattern.exec(current);
      if (match) matches.push([match.index, match.index + match[0].length]);
    }
    pattern.lastIndex = 0;
    if (matches.length === 0) continue;
    const slice = (from: number, to: number): Piece[] => {
      const out: Piece[] = [];
      let offset = 0;
      for (const piece of pieces) {
        const width = piece.text.length;
        const start = Math.max(from, offset);
        const end = Math.min(to, offset + width);
        if (start < end) {
          out.push(piece.kind === "kept"
            ? { kind: "kept", text: piece.text.slice(start - offset, end - offset), at: piece.at + start - offset }
            : { kind: "lit", text: piece.text.slice(start - offset, end - offset), span: piece.span });
        }
        offset += width;
      }
      return out;
    };
    /** The original span current-text characters [from, to) stand for; an
     * empty match stands for the empty span where it sits. */
    const origin = (from: number, to: number): readonly [number, number] => {
      let low = Number.POSITIVE_INFINITY;
      let high = Number.NEGATIVE_INFINITY;
      for (const piece of slice(from, to)) {
        const [a, b] = piece.kind === "kept" ? [piece.at, piece.at + piece.text.length] : piece.span;
        low = Math.min(low, a);
        high = Math.max(high, b);
      }
      if (low !== Number.POSITIVE_INFINITY) return [low, high];
      const before = slice(0, from).at(-1);
      const at = before === undefined ? 0 : before.kind === "kept" ? before.at + before.text.length : before.span[1];
      return [at, at];
    };
    const next: Piece[] = [];
    let cursor = 0;
    for (const [start, end] of matches) {
      next.push(...slice(cursor, start));
      next.push({ kind: "lit", text: MARKER, span: origin(start, end) });
      cursor = end;
    }
    next.push(...slice(cursor, current.length));
    pieces = next;
  }
  const text = render(pieces);
  const spans: [number, number][] = [];
  for (const piece of pieces) {
    if (piece.kind !== "lit") continue;
    const last = spans.at(-1);
    if (last && piece.span[0] <= last[1]) last[1] = Math.max(last[1], piece.span[1]);
    else spans.push([piece.span[0], piece.span[1]]);
  }
  return { text, spans };
}

/**
 * Terminal output quoted into a model prompt must not smuggle terminal
 * control bytes. A test runner's tail carries ANSI color, cursor moves, and
 * carriage-return progress bars; embedded raw in a request they are junk at
 * best and a provider rejection at worst. Strip escape sequences and C0
 * controls; \r becomes a newline so progress-bar frames stay readable.
 */
export function stripTerminalControls(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/gu, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b[@-_]/gu, "")
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
}
