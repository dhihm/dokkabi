import { createHash } from "node:crypto";
import type { EventRecord } from "../host/schema.ts";
import { LEDGER_PLANNER } from "./ledger-label.ts";
import { caseSpecDigest } from "./case-spec.ts";
import { FIX_ORDER_CHECK_TEXT_MAX_BYTES, fixOrderCheckSpec, isCheckCase } from "./ledger-check.ts";
import { LEDGER_CASE_EVENT, LEDGER_EVENT, projectLedger, revisionCases, type LedgerCase } from "./plan-ledger.ts";
import { propertyFieldsOf, propertyRowStatus } from "./property-verdict.ts";

/**
 * VERIFIED WORK (D37): the order text of a build → verify → fix chain.
 *
 * A unit of real work is a CHAIN of ordinary ledger sessions on one workspace
 * lineage. The build session works from the operator's order. A second session
 * — fresh context, a copy of the build's final tree, the same ledger surface —
 * reads the order as a SPECIFICATION and uses the delivered product against
 * it. A third session, only when the second left a check red, fixes what was
 * found. Nothing about a session changes: each has its own log, its own cases
 * and its own label, and no host here invents a verdict.
 *
 * What lives in this module is only the text and the reading of rows: the two
 * preambles, the two order compositions, and the extraction of the verifier's
 * findings from its recorded log. Everything is pure — rows in, text out — so
 * the controller (scripts/run-verified-work.ts) is the only part that touches
 * a filesystem or a process, and the composition can be tested without either.
 *
 * Since D39 a verifier reports a defect through the `defect` TOOL, never
 * through a case's colour: the `work/defect` rows are the primary source of
 * the findings, and the red-case reading below stays as a secondary one, so a
 * verifier that does use exit codes still reaches the fix session. Everything
 * else is read from rows that already exist (`ledger/case` on the final tree,
 * `work/finish`, `ledger/case_targets`, and the `tool/result` row each case
 * run lands), so a chain can still be run over a log recorded before any of
 * this existed.
 */

/** The verifier's preamble: the fixed text that turns the operator's order
 * into a specification to check, in front of the order itself (D37). It says
 * what the session is, what its evidence is, and what it must not touch. */
export const VERIFIER_PREAMBLE = `You did not build this workspace. Another session did, from the order that follows.

Your work is to find out whether what was delivered does what the order says.

The order below is the specification. Derive the checks from it — from what the
order asks for, not from the code in front of you and not from the tests that
are already in the tree. The tests in the tree were written by the session that
built it, and they share its blind spots.

Run the product the way somebody who asked for it would run it, on data that
covers every state the order names — including the states the existing fixtures
do not reach: the empty one, the one with a missing value, the one the order
mentions in a single clause.

Use the interface exactly as the order — and the documentation delivered with
the work — states it: the commands, options, argument forms, formats and
outputs they show are the contract. When a stated form fails, or its output
differs from what they say, that is a defect to report. Do not switch to
another form that happens to work, and do not reread the order in the light of
what the product does.

Report what you find with the \`defect\` tool: one call per defect, with a short
title, the behaviour the order specifies (expected), the behaviour you observed,
and how to reproduce it. That call IS the report. Nothing else in this session
carries a defect to whoever fixes it, and the tool keeps no state: a second call
about the same thing simply records a second observation.

Confirm each behaviour with the \`check\` tool: it runs a command with its input and expected output and records it as a case.
A check that stays red is either a defect (report it with \`defect\`) or a wrong check (correct it); do not leave red checks unexplained.

Name the principle each defect violates in its \`principle\` field. Where the order
implies a rule over many inputs — round trips, orderings, escaping, idempotence,
anything that must hold for every input — state it as an invariant with the
\`property\` tool, which runs your generator over many seeded inputs, and name
that property in the defect's \`property\` field.

Record your checks as ledger cases as usual — a case is a command somebody else
can run, and its exit code is that case's own verdict, nothing more. A check
whose command demonstrates a defect is worth recording as a case: name that case
in the \`case\` field of the defect it demonstrates, so the next session can
reproduce the defect in one step.

Do not change the product. Write your own scripts, fixtures and data wherever
you need them, in their own files; leave every file the previous session
delivered exactly as you found it.

Your order may list checks that a fix session disputed as contradicting the
order. Rule on each one with the \`ruling\` tool, judging it against the order
only — not against the product, the tests in the tree or the reasons given: a
check is \`invalid\` only when the order does not require what it expects, and
\`upheld\` otherwise. Cite the exact order text your ruling rests on.

Finish with a summary of what you checked and what you found.`;

/** The fix session's preamble: the fixed text that introduces the verifier's
 * report between the original order and the findings composed from rows. */
export const FIX_PREAMBLE = `A verifier session ran the delivered product against the order above. It did not
build the product and it did not change it. Each defect below is one it reported
through its \`defect\` tool: the behaviour the order specifies, the behaviour it
observed, and how to reproduce it. Any case listed after the defects is a check
it left red on the tree you are working from, with the command it ran and what
that command printed.

Fix the product so that each defect is gone and each of those checks passes. The
order above is still the specification — nothing in the report below replaces
it, and a defect that contradicts the order is the order's to win. Record your
own cases as usual and finish with a summary.`;

/** The heading the composed orders put in front of the operator's own text, so
 * a reader (and the model) can see where the preamble ends. */
const ORDER_HEADING = "## The order";
const REPORT_HEADING = "## The verifier's report";

/** At most this many characters of one red case's recorded output ride along
 * in the findings and the fix order: enough to show the failure, bounded so a
 * runaway command cannot grow the next session's order without limit. */
export const MAX_RED_CASE_OUTPUT_TAIL = 2_000;
/** At most this many red cases enter the findings and the composed fix order.
 * A verifier that recorded more has found more than one round can fix. */
export const MAX_RED_CASES = 32;
/** At most this many changed product files are reported. */
export const MAX_PRODUCT_FILES_CHANGED = 64;

/** The bounds of one defect's text (D39). A `work/defect` row is a model-authored
 * payload, so every field of it is capped the way the host caps every other one
 * it records: the title to a headline, the three statements to a paragraph each,
 * the case id to an identifier. The tool applies them where the model's words
 * enter the log, and the reader below applies them again, so a row from a log
 * this host did not write cannot grow the next session's order without bound. */
export const MAX_DEFECT_TITLE = 200;
export const MAX_DEFECT_TEXT = 2_000;
export const MAX_DEFECT_CASE_ID = 128;
/** At most this many defect rows enter the findings and the composed fix order:
 * a verifier that reported more has found more than one round can fix. */
export const MAX_DEFECTS = 32;

function boundString(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** The four statements one defect is made of, plus the case that reproduces it
 * and, since D58, the principle it breaks and the property that states that
 * principle over many inputs. Exactly the model-facing shape of the `defect`
 * tool and of the row it appends — the tool bounds its arguments through
 * this, and nothing else. */
export interface DefectStatement {
  readonly title: string;
  readonly expected: string;
  readonly observed: string;
  readonly reproduce: string;
  readonly case?: string;
  /** D58: the rule the defect breaks, in words. */
  readonly principle?: string;
  /** D58: the id of a recorded property case that captures it. */
  readonly property?: string;
  /** D58b V3: the spec digest (case-spec.ts) of that property as the ledger
   * declared it when the defect was reported — the host's, never the
   * model's: the recheck re-runs exactly that spec, whatever the verifier
   * declares under the id afterwards. */
  readonly property_digest?: string;
}

/** One defect statement with every field cut to its bound. */
export function boundDefect(input: DefectStatement): DefectStatement {
  return {
    title: boundString(input.title, MAX_DEFECT_TITLE),
    expected: boundString(input.expected, MAX_DEFECT_TEXT),
    observed: boundString(input.observed, MAX_DEFECT_TEXT),
    reproduce: boundString(input.reproduce, MAX_DEFECT_TEXT),
    ...(input.case === undefined ? {} : { case: boundString(input.case, MAX_DEFECT_CASE_ID) }),
    ...(input.principle === undefined ? {} : { principle: boundString(input.principle, MAX_DEFECT_TEXT) }),
    ...(input.property === undefined ? {} : { property: boundString(input.property, MAX_DEFECT_CASE_ID) }),
    ...(input.property_digest === undefined || !/^[0-9a-f]{64}$/u.test(input.property_digest) ? {} : { property_digest: input.property_digest }),
  };
}

/** One defect a verifier session reported through the `defect` tool (D39): the
 * row's own fields, plus the declared command of the case it named — derived
 * from the recorded ledger exactly as a red case's `output_tail` is derived
 * from the `tool/result` row, so the fix session can run the reproduction
 * instead of reading about it. */
export interface VerifierDefect extends DefectStatement {
  readonly id: string;
  /** The command of the case the row names, when the ledger declares it. */
  readonly case_command?: string;
  /** D58: the property the row names, as the fix session's own `property`
   * tool takes it, when the ledger declares it; texts left out by digest.
   * D58b V3: the declaration the defect bound (`property_case`), not
   * whatever the ledger declares under the id at the end. */
  readonly property_spec?: Record<string, unknown>;
  readonly property_omitted?: readonly { readonly what: string; readonly bytes: number; readonly digest: string }[];
  /** D58b V3: the property as the defect bound it — the declaration whose
   * spec digest the row carries, read off the verifier's log — which the
   * recheck re-runs; absent when the log holds no such declaration. */
  readonly property_case?: LedgerCase;
}

/** One check the verifier left red on its final tree: the case as the session
 * recorded it, plus the tail of what its command printed. */
export interface VerifierRedCase {
  readonly id: string;
  readonly command: string;
  /** The case's declared working directory, when it named one. */
  readonly dir?: string;
  /** The tail of the case run's recorded output, when the log carries it. */
  readonly output_tail?: string;
  /** A case recorded by `check` (D48): its recorded spec as the fix session's
   * own `check` tool takes it, and the texts left out of it (over the fix
   * order's bound, or no longer in the verifier's store) by digest. */
  readonly check?: Record<string, unknown>;
  readonly check_omitted?: readonly { readonly what: string; readonly bytes: number; readonly digest: string }[];
  /** D58: the case was recorded by `property`: `check` is then the spec its
   * `property` tool takes. */
  readonly property?: true;
}

/** What the controller reads out of a verifier session's log. */
export interface VerifierFindings {
  /** The defects the verifier reported through the tool: the primary source
   * since D39, in the order it reported them. */
  readonly defects: readonly VerifierDefect[];
  /** The checks it left red on its final tree: the secondary source, kept so a
   * verifier that reports through exit codes still reaches the fix session. */
  readonly red_cases: readonly VerifierRedCase[];
  /** The digest the verifier's `work/finish` row carries, when it finished.
   * The summary TEXT is not in the log — the finish tool records the digest
   * alone — so the digest is the citation and the red cases are the content. */
  readonly summary_digest?: string;
  /** Product files the verifier changed against its base, as the conclusion's
   * `ledger/case_targets` rows record them: the non-test targets of its own
   * case commands. The verifier was told not to touch the product, so a
   * non-empty list is something the operator reads, never a refusal. It is
   * what those rows carry and no more — a changed file no case command names
   * is not in the log at all. */
  readonly product_files_changed: readonly string[];
}

/** Whether a verifier session found anything at all — the one question the
 * chain's fix stage is gated on (D39). A defect it reported and a case it left
 * red are both findings; which of the two it used is the verifier's business,
 * not the gate's. */
export function hasFindings(findings: VerifierFindings): boolean {
  return findings.defects.length > 0 || findings.red_cases.length > 0;
}

/** The identity a recheck keeps a check open by (D49), as the orders state it
 * and the `dispute` and `ruling` tools take it (D54): the session that
 * recorded the check, its case id, and the digest of its spec. */
export interface CheckIdentity {
  readonly source: string;
  readonly case: string;
  readonly spec: string;
}

/** The evidence of one disputed check as the verifier's order states it
 * (D55): where it is in the verifier's scratch (`dir`, and `in_scratch`
 * relative to `$DOKKABI_SCRATCH`), its manifest's sha256, whether it is
 * complete and what is missing, and every file with its digest — `content`
 * for an input file when the order's budget allows. Since D56 also `scratch`,
 * the mapping from the scratch the check's command names (`source`) to the
 * evidence's `dir`, whose files are listed with their `scratch_path` and
 * whose links under `links`. Since D57 the files are what the check's
 * failing run ran with, as snapshotted before it ran: `failing_recheck` is
 * that run (with the snapshot's digest), `latest_recheck` the latest one. */
export interface VerifyOrderEvidence {
  readonly dir?: string;
  readonly in_scratch?: string;
  readonly manifest?: string;
  readonly manifest_sha256?: string;
  readonly complete: boolean;
  readonly missing?: readonly string[];
  readonly scratch?: { readonly source: string; readonly dir: string };
  readonly failing_recheck?: Record<string, unknown>;
  readonly latest_recheck?: Record<string, unknown>;
  readonly files: readonly Record<string, unknown>[];
  readonly links?: readonly Record<string, unknown>[];
}

/** One disputed check as the next verifier's order states it (D54): its
 * identity, the check as recorded (the JSON a `check` call takes: command,
 * dir, stdin, fixtures, expectations), the texts left out of it, and the
 * dispute — the fix session, its reason and the order text it relies on —
 * and since D55 its evidence, with the authored files the budget left out. */
export interface VerifyOrderDispute {
  readonly identity: CheckIdentity;
  readonly check: Record<string, unknown>;
  readonly omitted?: readonly { readonly what: string; readonly bytes: number; readonly digest: string }[];
  readonly disputed_by: string;
  readonly reason: string;
  readonly order_text: string;
  readonly evidence?: VerifyOrderEvidence;
  readonly evidence_omitted?: readonly { readonly path: string; readonly bytes: number; readonly digest: string }[];
}

const DISPUTES_HEADING = "## Disputed checks";

/** How a disputed check's evidence is to be read (D55, D56, D57, D57b): one
 * general paragraph, no product text. */
const EVIDENCE_RULE =
  "Each check comes with its evidence in your scratch directory (`$DOKKABI_SCRATCH`), apart from the tree you are checking: " +
  "the check as recorded and what its failing recheck ran with, as it was before that run started (`failing_recheck`) — " +
  "for a check a verifier recorded, the files that verifier wrote, under `files` at their paths in its tree — " +
  "each listed with its sha256 in the manifest. The files of the scratch that run was given are under the evidence's " +
  "`scratch` directory at their paths in that scratch: where the check's command names `$DOKKABI_SCRATCH` " +
  "(`evidence.scratch.source`), read the same path there. A link is there as it was, with its exact target; `resolves_to` is where in the " +
  "evidence its target was captured — read that, not the target, which may name the original place. " +
  "What a check expects includes what its own files assert: read them before you rule. " +
  "A check whose evidence is not `complete` is missing part of what it ran with; an `invalid` ruling on it does not close it.";

/** How a disputed property is read (D58): one general sentence, stated only
 * when a property is among the disputed checks. */
const PROPERTY_RULE =
  "A check with a `principle` is a property: it holds when its command exits 0 for every generated case, and its evidence holds each counterexample's generated input, as its case left it, under `counterexamples/<k>/input`.";

/** The disputed checks section of a verifier's order (D54). Every
 * model-authored text in it sits inside a JSON string, so no line of it can
 * pass for a heading of the order — since D55 the evidence's file texts too. */
function disputesSection(disputes: readonly VerifyOrderDispute[]): string {
  const lines: string[] = [
    DISPUTES_HEADING,
    "",
    "A fix session disputed each check below as contradicting the order, and each is still open on the tree you are checking.",
    "Rule on each one with the `ruling` tool, passing its `identity` unchanged. A check passes when its command exits with `expect.exit` and every other expectation in `expect` holds.",
    ...(disputes.some((item) => "principle" in item.check) ? [PROPERTY_RULE] : []),
    ...(disputes.some((item) => item.evidence !== undefined) ? [EVIDENCE_RULE] : []),
  ];
  for (const item of disputes) {
    lines.push("", "```json", JSON.stringify({
      identity: { source: item.identity.source, case: item.identity.case, spec: item.identity.spec },
      check: item.check,
      disputed_by: item.disputed_by,
      reason: item.reason,
      order_text: item.order_text,
      ...(item.evidence === undefined ? {} : { evidence: item.evidence }),
    }, null, 2), "```");
    for (const left of item.omitted ?? []) lines.push(`Not included: ${left.what} (${left.bytes} bytes, sha256 ${left.digest}).`);
    for (const left of item.evidence_omitted ?? []) {
      lines.push(`Not included: evidence file ${JSON.stringify(left.path)} (${left.bytes} bytes, sha256 ${left.digest}); read it in the evidence directory.`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The verify session's order: the preamble, then — when a fix session
 * disputed checks that are still open and unruled (D54) — the disputed checks
 * section, then the operator's own order, unchanged, under a heading. Without
 * disputes it is exactly what it always was. */
export function composeVerifyOrder(originalOrder: string, disputes: readonly VerifyOrderDispute[] = []): string {
  const section = disputes.length === 0 ? "" : `${disputesSection(disputes)}\n`;
  return `${VERIFIER_PREAMBLE}\n\n${section}${ORDER_HEADING}\n\n${originalOrder.trim()}\n`;
}

// --- reading the orders back (D54) -------------------------------------------
//
// The `dispute` and `ruling` tools read the order their session was given
// from its log (the work/goal statement) and nothing else, so what they accept
// is a pure function of the log: the identities the order states, and the
// operator's own order inside it — the text a dispute or a ruling must quote.

function checkIdentity(value: unknown): CheckIdentity | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.source !== "string" || typeof item.case !== "string" || typeof item.spec !== "string") return undefined;
  return { source: item.source, case: item.case, spec: item.spec };
}

/** The operator's own order inside a composed order: in a fix order the text
 * before the fix preamble, in a verifier's order the text after its order
 * heading; any other order is its own text. */
export function orderSpecification(order: string): string {
  const fix = order.indexOf(`\n\n${FIX_PREAMBLE}`);
  if (fix >= 0) return order.slice(0, fix);
  if (order.startsWith(VERIFIER_PREAMBLE)) {
    const heading = order.indexOf(`\n${ORDER_HEADING}\n\n`, VERIFIER_PREAMBLE.length);
    if (heading >= 0) return order.slice(heading + ORDER_HEADING.length + 3);
  }
  return order;
}

/** Whether `quote` is text of `specification`, runs of whitespace read as one
 * space: a quote may break its lines differently, never change a word. */
export function orderQuoteFound(specification: string, quote: string): boolean {
  const flat = (text: string) => text.replace(/\s+/gu, " ").trim();
  const needle = flat(quote);
  return needle.length > 0 && flat(specification).includes(needle);
}

/** The identities a fix order states as open (D54): the `identity:` lines of
 * its last `## Observed after the previous fix` section — the section the
 * orchestrator composes last, after every model-authored text. */
export function fixOrderOpenIdentities(order: string): CheckIdentity[] {
  const at = order.lastIndexOf(`\n${RECHECK_HEADING}\n`);
  if (at < 0) return [];
  const identities: CheckIdentity[] = [];
  for (const line of order.slice(at).split("\n")) {
    if (!line.startsWith(IDENTITY_PREFIX)) continue;
    try {
      const identity = checkIdentity(JSON.parse(line.slice(IDENTITY_PREFIX.length)));
      if (identity !== undefined) identities.push(identity);
    } catch {
      // Not an identity line the orchestrator wrote.
    }
  }
  return identities;
}

/** The identities a verifier's order lists as disputed (D54): the JSON blocks
 * of its disputed checks section, between the preamble and the order. */
export function verifyOrderDisputedIdentities(order: string): CheckIdentity[] {
  if (!order.startsWith(VERIFIER_PREAMBLE)) return [];
  const end = order.indexOf(`\n${ORDER_HEADING}\n\n`, VERIFIER_PREAMBLE.length);
  const head = order.slice(VERIFIER_PREAMBLE.length, end < 0 ? order.length : end);
  const at = head.indexOf(`\n${DISPUTES_HEADING}\n`);
  if (at < 0) return [];
  const identities: CheckIdentity[] = [];
  for (const match of head.slice(at).matchAll(/```json\n([\s\S]*?)\n```/gu)) {
    try {
      const identity = checkIdentity((JSON.parse(match[1]!) as Record<string, unknown>).identity);
      if (identity !== undefined) identities.push(identity);
    } catch {
      // Not a block the orchestrator wrote.
    }
  }
  return identities;
}

/**
 * The fix session's order: the operator's own order first (it is still the
 * specification), then the fix preamble, then the verifier's report — its
 * finish summary when the controller could read one, then every defect it
 * reported through the tool, then every red case with the command, the
 * directory and the output tail the rows carry.
 */
export function composeFixOrder(
  originalOrder: string,
  findings: VerifierFindings,
  verifierSummaryText?: string,
  recheck?: FixOrderRecheck,
): string {
  const report = composeFixReport(originalOrder, findings, verifierSummaryText);
  const section = recheckSection(recheck);
  return section === undefined ? report : `${report}\n${section}`;
}

/** What the orchestrator observed after the previous fix (D45 R3), as data
 * for the next fix order: every recheck still open (D49) — the reported
 * reproductions still red on the tree (or that could not run there) and the
 * checks recorded green before a fix that are red on it now — ids and
 * commands, each as it was recorded (D50), and each one's identity (the
 * session that recorded it and its spec digest), which is what a `dispute`
 * names (D54). */
export interface FixOrderRecheck {
  readonly reported_red: readonly { readonly id: string; readonly command: string; readonly not_runnable?: true; readonly source?: string; readonly spec?: string }[];
  /** Kept checks red now — or not shown green (D58c K1): cut by the host or
   * not startable, `not_runnable` with the reason the recheck gave — or whose
   * target test the fix tampered with or whose targets could not be observed
   * (U1, D57f: `tampered`). */
  readonly kept_red: readonly {
    readonly id: string;
    readonly command: string;
    readonly not_runnable?: true;
    readonly reason?: string;
    readonly source?: string;
    readonly spec?: string;
    readonly tampered?: true;
  }[];
}

const RECHECK_HEADING = "## Observed after the previous fix";

/** The line under an open check that states its identity (D54): the JSON the
 * `dispute` tool takes as `identity`. */
const IDENTITY_PREFIX = "  identity: ";

/** How the open cases close (D50), and how one is disputed (D54): one general
 * sentence, no product text. */
const RECHECK_CLOSE_RULE =
  "These checks are re-run exactly as recorded until the product passes them, and changing, weakening or re-declaring one closes nothing; " +
  "if you believe a check contradicts the order, dispute it with the `dispute` tool — its identity as stated below, your reason and the exact order text you rely on — and a later verifier rules on it against the order.";

/** A model- or host-authored text on one bounded line. */
function oneLineText(text: string, max = 200): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** One open check of the recheck section: its id and command, and its
 * identity on the line under it when the data carries one. */
function recheckLines(item: { readonly id: string; readonly command: string; readonly source?: string; readonly spec?: string }, note = ""): string[] {
  return [
    `- ${item.id}: ${item.command}${note}`,
    ...(item.source === undefined || item.spec === undefined
      ? []
      : [`${IDENTITY_PREFIX}${JSON.stringify({ source: item.source, case: item.id, spec: item.spec })}`]),
  ];
}

/** The recheck section of a fix order, or undefined when both lists are
 * empty (the order is then exactly what it was without a recheck). */
function recheckSection(recheck: FixOrderRecheck | undefined): string | undefined {
  if (recheck === undefined || (recheck.reported_red.length === 0 && recheck.kept_red.length === 0)) return undefined;
  const lines: string[] = [
    RECHECK_HEADING,
    "",
    "The host ran these recorded commands on a copy of the tree you are working from, as the previous fix session left it.",
    RECHECK_CLOSE_RULE,
  ];
  if (recheck.reported_red.length > 0) {
    lines.push("", "Cases a verifier left red that are still red:", "");
    for (const item of recheck.reported_red) {
      lines.push(...recheckLines(item, item.not_runnable === true ? " (the command could not run there)" : ""));
    }
  }
  const keptRed = recheck.kept_red.filter((item) => item.not_runnable !== true);
  const keptUnknown = recheck.kept_red.filter((item) => item.not_runnable === true);
  const tamperedNote = " (its test was changed in a way that removes or hides assertions, or could not be read: restore it)";
  if (keptRed.length > 0) {
    lines.push("", keptRed.some((item) => item.tampered === true)
      ? "Cases recorded green before a fix that are red now, or whose test the fix weakened:"
      : "Cases recorded green before a fix that are red now:", "");
    for (const item of keptRed) lines.push(...recheckLines(item, item.tampered === true ? tamperedNote : ""));
  }
  // D58c K1: a kept check the host could not observe green — cut (its time, a
  // hang, its output bound) or not startable — stays open like a red one.
  if (keptUnknown.length > 0) {
    lines.push("", "Cases recorded green before a fix that did not run to a verdict there (each stays open until it is observed green again):", "");
    for (const item of keptUnknown) {
      lines.push(...recheckLines(item, ` (${oneLineText(item.reason ?? "it did not run to a verdict")})${item.tampered === true ? tamperedNote : ""}`));
    }
  }
  return `${lines.join("\n")}\n`;
}

/** A defect that names a property is fixed when the property holds (D58). */
const PROPERTY_FIX_RULE =
  "The fix is done when this property holds, not when the reproduction passes: the recheck after your session re-runs it — its recorded counterexamples first, then a fresh sample of inputs.";

/** A defect whose property the verifier's log does not hold as the defect
 * named it (D58b V3): nothing re-runs it, and the order says so. */
const PROPERTY_UNBOUND =
  "The verifier's log holds no declaration of this property as the defect named it, so the recheck cannot re-run it; the fix is done when the principle holds for every input it covers.";

/** A defect that names only its principle (D58). */
const PRINCIPLE_FIX_RULE =
  "The fix is done when this principle holds for every input it covers, not when the reproduction passes.";

function composeFixReport(
  originalOrder: string,
  findings: VerifierFindings,
  verifierSummaryText?: string,
): string {
  const lines: string[] = [originalOrder.trim(), "", FIX_PREAMBLE, "", REPORT_HEADING, ""];
  const summary = verifierSummaryText?.trim();
  if (summary !== undefined && summary.length > 0) {
    lines.push(summary, "");
  } else if (findings.summary_digest !== undefined) {
    // The finish row records the digest of the summary, never its text. When
    // the controller has no text to quote it says so rather than inventing a
    // report, and the cases below carry the content.
    lines.push(
      `The verifier finished; its summary text is not retained in the log (summary digest ${findings.summary_digest}).`,
      "",
    );
  } else {
    lines.push("The verifier stopped without a finish summary; what follows is composed from its rows alone.", "");
  }
  // The defects first (D39): they are what the verifier set out to produce,
  // and each one is a statement the fix session can act on without running
  // anything. A case is named beside the defect it reproduces, never instead
  // of it.
  if (findings.defects.length === 0 && findings.red_cases.length === 0) {
    lines.push("It reported no defect and left no red case.");
    return `${lines.join("\n")}\n`;
  }
  if (findings.defects.length === 0) {
    lines.push("It reported no defect.", "");
  } else {
    lines.push("It reported these defects:", "");
    for (const item of findings.defects) {
      lines.push(`### ${item.id} — ${item.title}`, "");
      lines.push(`Expected: ${item.expected}`);
      lines.push(`Observed: ${item.observed}`);
      lines.push(`Reproduce: ${item.reproduce}`);
      if (item.case !== undefined) {
        lines.push(`Reproducing case: ${item.case}`);
        if (item.case_command !== undefined) lines.push(`Command: ${item.case_command}`);
      }
      // D58: the rule the defect breaks, and the property that states it.
      if (item.principle !== undefined) lines.push(`Principle: ${item.principle}`);
      if (item.property !== undefined) {
        // D58b V3: the promise holds only for a property the recheck will
        // re-run — the declaration the defect bound.
        lines.push(`Property: ${item.property}`, "", item.property_case !== undefined ? PROPERTY_FIX_RULE : PROPERTY_UNBOUND);
        if (item.property_spec !== undefined) {
          lines.push("", "Run it with your `property` tool, passing this JSON unchanged (the same id):", "", "```json", JSON.stringify(item.property_spec, null, 2), "```");
          for (const left of item.property_omitted ?? []) lines.push(`Not included: ${left.what} (${left.bytes} bytes, sha256 ${left.digest}).`);
        }
      } else if (item.principle !== undefined) {
        lines.push("", PRINCIPLE_FIX_RULE);
      }
      lines.push("");
    }
  }
  if (findings.red_cases.length === 0) {
    lines.push("It left no red case.");
    return `${lines.join("\n").trimEnd()}\n`;
  }
  lines.push("Each of these cases is red on the tree you are working from:", "");
  for (const item of findings.red_cases) {
    lines.push(`### ${item.id}`, "");
    lines.push(`Command: ${item.command}`);
    if (item.dir !== undefined) lines.push(`Directory: ${item.dir}`);
    if (item.output_tail !== undefined) {
      lines.push("", "Output:", "", "```", item.output_tail, "```");
    }
    if (item.check !== undefined && item.property === true) {
      lines.push("", PROPERTY_FIX_RULE, "", "The verifier recorded this as a property. Run it with your `property` tool, passing this JSON unchanged (the same id):", "", "```json", JSON.stringify(item.check, null, 2), "```");
      for (const left of item.check_omitted ?? []) {
        lines.push(`Not included: ${left.what} (${left.bytes} bytes, sha256 ${left.digest}).`);
      }
    } else if (item.check !== undefined) {
      lines.push("", `The verifier recorded this as a check. To confirm your fix, re-run it with your \`check\` tool, passing this JSON unchanged (the same id):`, "", "```json", JSON.stringify(item.check, null, 2), "```");
      for (const left of item.check_omitted ?? []) {
        lines.push(`Not included: ${left.what} (${left.bytes} bytes, sha256 ${left.digest}).`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** The last end-of-run observation per case of the FINAL pass, in the order
 * the conclusion wrote them. The anchor rule is the label's (ledger-label.ts):
 * a row carrying a new `final_image` opens a new pass, and the previous pass's
 * rows are history. */
export function finalCaseRows(events: readonly EventRecord[]): EventRecord[] {
  let rows: EventRecord[] = [];
  let anchor: string | undefined;
  for (const event of events) {
    if (event.name !== "ledger/case" || event.payload.planner !== LEDGER_PLANNER) continue;
    if (typeof event.payload.id !== "string") continue;
    const finalImage = typeof event.payload.final_image === "string" ? event.payload.final_image : undefined;
    if (finalImage !== undefined) {
      if (anchor !== undefined && finalImage !== anchor) rows = [];
      anchor = finalImage;
    }
    rows = rows.filter((row) => row.payload.id !== event.payload.id);
    rows.push(event);
  }
  return rows;
}

/** The tail of what one case's command printed, from the `tool/result` row the
 * conclusion's execution landed. The call id is the conclusion's own
 * construction (ledger-conclude.ts), so the link is exact; the row's `text` is
 * already bounded by the tool boundary and is bounded again here. */
function caseOutputTail(events: readonly EventRecord[], caseId: string): string | undefined {
  const callId = `ledger-case-${createHash("sha256").update(caseId).digest("hex").slice(0, 16)}`;
  const row = [...events].reverse().find(
    (event) => event.name === "tool/result" && event.payload.id === callId,
  );
  const text = typeof row?.payload.text === "string" ? row.payload.text.trim() : "";
  if (text.length === 0) return undefined;
  return text.length <= MAX_RED_CASE_OUTPUT_TAIL ? text : text.slice(-MAX_RED_CASE_OUTPUT_TAIL);
}

/** What a red property's final row says it saw (D58): each counterexample by
 * seed, case and exit code with the end of its output, bounded. */
function propertyOutputTail(value: unknown): string | undefined {
  const fields = propertyFieldsOf(value);
  if (fields === undefined || fields.counterexamples.length === 0) return undefined;
  const text = fields.counterexamples
    .map((item) => `counterexample seed ${item.seed} case ${item.case} exit ${item.exit_code}:\n${item.output_tail.trim()}`)
    .join("\n\n");
  return text.length <= MAX_RED_CASE_OUTPUT_TAIL ? text : text.slice(0, MAX_RED_CASE_OUTPUT_TAIL);
}

/** The declarations a log recorded of some case ids, in the order recorded:
 * every whole graph's cases and every case row's (D58b V3). */
interface BoundDeclarations {
  /** The latest declaration of `id` at or before row `seq` whose spec digest
   * (case-spec.ts) is `digest`, when it states a property. */
  bound(id: string, digest: string, seq: number): LedgerCase | undefined;
}

/** The property ids a log's defect rows bind by digest. */
function namedProperties(events: readonly EventRecord[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.name !== "work/defect" || typeof event.payload.property_digest !== "string") continue;
    const id = statement(event.payload.property);
    if (id !== undefined) ids.add(id);
  }
  return ids;
}

/** One pass over the log for the declarations of `ids`; each candidate's
 * digest computed once, when asked. */
function declarationsOf(events: readonly EventRecord[], ids: ReadonlySet<string>): BoundDeclarations {
  const byId = new Map<string, { readonly seq: number; readonly item: LedgerCase }[]>();
  const add = (seq: number, item: unknown): void => {
    if (typeof item !== "object" || item === null) return;
    const id = (item as { readonly id?: unknown }).id;
    if (typeof id !== "string" || !ids.has(id)) return;
    let list = byId.get(id);
    if (list === undefined) byId.set(id, list = []);
    list.push({ seq, item: item as LedgerCase });
  };
  if (ids.size > 0) {
    for (const event of events) {
      if (event.name === LEDGER_EVENT) {
        const cases = (event.payload.graph as { readonly cases?: unknown } | undefined)?.cases;
        if (Array.isArray(cases)) for (const item of cases) add(event.seq, item);
      } else if (event.name === LEDGER_CASE_EVENT) {
        add(event.seq, event.payload.case);
      }
    }
  }
  const digests = new Map<LedgerCase, string>();
  return {
    bound(id, digest, seq) {
      let found: LedgerCase | undefined;
      for (const entry of byId.get(id) ?? []) {
        if (entry.seq > seq) break;
        if (entry.item.property === undefined) continue;
        let own = digests.get(entry.item);
        if (own === undefined) digests.set(entry.item, own = caseSpecDigest(entry.item));
        if (own === digest) found = entry.item;
      }
      return found;
    },
  };
}

/** One non-empty string field of a row payload, or undefined. */
function statement(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * What one verifier session's log says, read from its rows alone.
 *
 * A defect is a `work/defect` row the verifier's `defect` tool appended (D39):
 * the primary source, in the order it reported them. A row that does not carry
 * all four statements is not a defect — the tool never writes one, and half a
 * row must not reach the fix session as a specification.
 *
 * A red case is a non-guard case the host observed red on the final tree: the
 * secondary source, so a verifier that reports through exit codes still
 * reaches the fix session. A case the host could not RUN (`unrunnable`) is not
 * a defect of the product: it is a check that did not happen, and reporting it
 * as one would send the fix session after the harness instead of the work.
 */
export function verifierFindings(
  events: readonly EventRecord[],
  /** The verifier session's scratch directory (D48): a red check case's
   * fixture texts too large to ride on its ledger row are read from its store
   * there, verified by digest. Without it only the inline texts are carried. */
  options: { readonly scratch?: string } = {},
): VerifierFindings {
  const checkBudget = { left: FIX_ORDER_CHECK_TEXT_MAX_BYTES };
  const declared = new Map(revisionCases(projectLedger(events)).map((item) => [item.id, item]));

  const defects: VerifierDefect[] = [];
  let bindings: BoundDeclarations | undefined;
  for (const event of events) {
    if (event.name !== "work/defect") continue;
    const title = statement(event.payload.title);
    const expected = statement(event.payload.expected);
    const observed = statement(event.payload.observed);
    const reproduce = statement(event.payload.reproduce);
    if (title === undefined || expected === undefined || observed === undefined || reproduce === undefined) continue;
    const caseId = statement(event.payload.case);
    const command = caseId === undefined ? undefined : declared.get(caseId)?.command;
    const principle = statement(event.payload.principle);
    const propertyId = statement(event.payload.property);
    const digest = typeof event.payload.property_digest === "string" && /^[0-9a-f]{64}$/u.test(event.payload.property_digest)
      ? event.payload.property_digest
      : undefined;
    // D58b V3: the declaration the defect bound, by its digest, as the log
    // held it when the defect was reported — whatever the verifier declared
    // under the id later. A row bound to nothing (recorded before D58b)
    // names the ledger's declaration at the end, as D58 read it.
    const property = propertyId === undefined
      ? undefined
      : digest !== undefined
        ? (bindings ??= declarationsOf(events, namedProperties(events))).bound(propertyId, digest, event.seq)
        : declared.get(propertyId)?.property !== undefined ? declared.get(propertyId) : undefined;
    const spec = property?.property === undefined ? undefined : fixOrderCheckSpec(property, options.scratch, checkBudget);
    defects.push({
      id: statement(event.payload.id) ?? `defect-${defects.length + 1}`,
      ...boundDefect({
        title, expected, observed, reproduce,
        ...(caseId === undefined ? {} : { case: caseId }),
        ...(principle === undefined ? {} : { principle }),
        ...(propertyId === undefined ? {} : { property: propertyId }),
        ...(digest === undefined ? {} : { property_digest: digest }),
      }),
      ...(typeof command === "string" && command.length > 0
        ? { case_command: boundString(command, MAX_DEFECT_TEXT) }
        : {}),
      ...(spec === undefined ? {} : { property_spec: spec.spec }),
      ...(spec === undefined || spec.omitted.length === 0 ? {} : { property_omitted: spec.omitted }),
      ...(property?.property === undefined ? {} : { property_case: property }),
    });
    if (defects.length >= MAX_DEFECTS) break;
  }

  const redCases: VerifierRedCase[] = [];
  for (const row of finalCaseRows(events)) {
    const id = String(row.payload.id);
    const item = declared.get(id);
    if (row.payload.guard === true || item?.guard === true) continue;
    // A property row's status is the verdict of its own fields (D58b V2):
    // red only when a case completed and violated it.
    if (row.payload.property !== undefined) {
      if (propertyRowStatus(row.payload.property) !== "red") continue;
    } else {
      if (row.payload.status === "green") continue;
      if (typeof row.payload.unrunnable === "string" && row.payload.unrunnable.length > 0) continue;
    }
    const command = typeof row.payload.command === "string" ? row.payload.command : item?.command ?? "";
    const dir = typeof item?.dir === "string" && item.dir.length > 0 ? item.dir : undefined;
    const isProperty = item?.property !== undefined;
    // A property's run is many executions: its output is its counterexamples
    // (D58), as the final row records them.
    const tail = isProperty ? propertyOutputTail(row.payload.property) : caseOutputTail(events, id);
    const check = item !== undefined && (isCheckCase(item) || isProperty) ? fixOrderCheckSpec(item, options.scratch, checkBudget) : undefined;
    redCases.push({
      id,
      command,
      ...(dir === undefined ? {} : { dir }),
      ...(tail === undefined ? {} : { output_tail: tail }),
      ...(check === undefined ? {} : { check: check.spec }),
      ...(check === undefined || check.omitted.length === 0 ? {} : { check_omitted: check.omitted }),
      ...(isProperty ? { property: true as const } : {}),
    });
    if (redCases.length >= MAX_RED_CASES) break;
  }

  const finish = [...events].reverse().find(
    (event) => event.name === "work/finish" && typeof event.payload.summary_digest === "string",
  );

  // The conclusion's target rows, last row per case, non-test paths only: a
  // test file the verifier wrote is its own work, a product file is not.
  const targetRows = new Map<string, EventRecord>();
  for (const event of events) {
    if (event.name !== "ledger/case_targets" || event.payload.planner !== LEDGER_PLANNER) continue;
    if (typeof event.payload.case === "string") targetRows.set(event.payload.case, event);
  }
  const changed = new Set<string>();
  for (const row of targetRows.values()) {
    const targets = Array.isArray(row.payload.targets) ? row.payload.targets : [];
    for (const target of targets) {
      if (typeof target !== "object" || target === null) continue;
      const { path, test } = target as Record<string, unknown>;
      if (typeof path !== "string" || test === true) continue;
      changed.add(path);
    }
  }

  return {
    defects,
    red_cases: redCases,
    ...(finish === undefined ? {} : { summary_digest: String(finish.payload.summary_digest) }),
    product_files_changed: [...changed].sort().slice(0, MAX_PRODUCT_FILES_CHANGED),
  };
}
