/**
 * RX (D58c, design memo §116): the host evaluates a check's regular
 * expression in BOUNDED time, and past the bound it does not judge.
 *
 * A `matches` expectation is the model's pattern run by the host over the
 * command's output. The host's own engine (JavaScriptCore's backtracking
 * RegExp) takes time exponential in the output for a pattern with nested or
 * overlapping quantifiers (`^(a+)+$` on thirty a's and a `!`), and past an
 * internal limit it answers "no match" — a verdict it did not reach. So the
 * host does not run the pattern through it. It compiles the pattern into a
 * Thompson automaton and simulates it one code point at a time (a Pike VM
 * without captures: for `test` only whether a match exists matters, so
 * greedy and lazy quantifiers, groups and captures change nothing). The
 * simulation is linear in the output — every code point advances a set of at
 * most the automaton's states — and it is bounded besides: a compiled
 * program of at most REGEX_STATE_LIMIT states, at most REGEX_STEP_LIMIT state
 * operations per evaluation and REGEX_TIME_LIMIT_MS of wall time. Past either
 * bound the verdict is `not_judged` with the reason: never a match, never a
 * failure it did not observe.
 *
 * The syntax is ECMAScript's with the `m` and `u` flags the check tool has
 * always compiled with (so a line anchor matches at every line, and the text
 * is read as code points). Every construct that is regular is supported:
 * literals, `.`, classes, class escapes (`\d \w \s \p{…}` and their
 * negations), character escapes, groups (capturing, named, non-capturing),
 * alternation, `* + ? {n} {n,} {n,m}` greedy or lazy, `^ $ \b \B`. What one
 * code point matches is decided by the platform's own RegExp on that single
 * code point — `[^]`, `.`, `\p{L}`, `\s` mean exactly what they mean there,
 * in bounded time (a pattern of one atom over one code point). What is not
 * regular — backreferences (`\1`, `\k<name>`) and lookaround (`(?=`, `(?!`,
 * `(?<=`, `(?<!`) — and inline modifiers are refused with the reason: the
 * check tool returns it as a finding, and an evaluator that meets one in a
 * recorded case does not judge it.
 */

/** The largest compiled program: counted repetitions are expanded. */
export const REGEX_STATE_LIMIT = 20_000;
/** State operations one evaluation may take (each state entered, each code
 * point tested). */
export const REGEX_STEP_LIMIT = 200_000_000;
/** Wall time one evaluation may take, however few its steps. */
export const REGEX_TIME_LIMIT_MS = 5_000;

type Node =
  | { readonly t: "empty" }
  | { readonly t: "char"; readonly source: string }
  | { readonly t: "seq"; readonly items: readonly Node[] }
  | { readonly t: "alt"; readonly items: readonly Node[] }
  | { readonly t: "repeat"; readonly item: Node; readonly min: number; readonly max: number }
  | { readonly t: "assert"; readonly kind: AssertKind };

type AssertKind = "bol" | "eol" | "wordb" | "nwordb";

/** Why a pattern is refused, and what to do instead. */
class Unsupported extends Error {
  constructor(message: string, readonly hint = "state it without backreferences, lookaround or inline modifiers") {
    super(message);
  }
}

const SMALLER = "state it with smaller repetition counts";

/** A parse of one pattern (u-mode ECMAScript syntax, already accepted by the
 * platform's RegExp) into the regular subset, or Unsupported. */
class Parser {
  private at = 0;

  constructor(private readonly source: string) {}

  parse(): Node {
    const node = this.disjunction();
    if (this.at !== this.source.length) throw new Unsupported(`unexpected ${JSON.stringify(this.source[this.at])} at ${this.at}`);
    return node;
  }

  private peek(offset = 0): string | undefined {
    return this.source[this.at + offset];
  }

  private disjunction(): Node {
    const items = [this.alternative()];
    while (this.peek() === "|") {
      this.at += 1;
      items.push(this.alternative());
    }
    return items.length === 1 ? items[0]! : { t: "alt", items };
  }

  private alternative(): Node {
    const items: Node[] = [];
    for (;;) {
      const ch = this.peek();
      if (ch === undefined || ch === "|" || ch === ")") break;
      items.push(this.term());
    }
    if (items.length === 0) return { t: "empty" };
    return items.length === 1 ? items[0]! : { t: "seq", items };
  }

  private term(): Node {
    const ch = this.peek();
    if (ch === "^") {
      this.at += 1;
      return { t: "assert", kind: "bol" };
    }
    if (ch === "$") {
      this.at += 1;
      return { t: "assert", kind: "eol" };
    }
    if (ch === "\\" && (this.peek(1) === "b" || this.peek(1) === "B")) {
      this.at += 2;
      return { t: "assert", kind: this.source[this.at - 1] === "b" ? "wordb" : "nwordb" };
    }
    if (ch === "(" && this.peek(1) === "?") {
      const next = this.peek(2);
      if (next === "=" || next === "!") throw new Unsupported("lookahead is not regular");
      if (next === "<" && (this.peek(3) === "=" || this.peek(3) === "!")) throw new Unsupported("lookbehind is not regular");
    }
    const atom = this.atom();
    return this.quantified(atom);
  }

  private quantified(atom: Node): Node {
    const ch = this.peek();
    let min: number;
    let max: number;
    if (ch === "*") {
      min = 0;
      max = Infinity;
      this.at += 1;
    } else if (ch === "+") {
      min = 1;
      max = Infinity;
      this.at += 1;
    } else if (ch === "?") {
      min = 0;
      max = 1;
      this.at += 1;
    } else if (ch === "{") {
      const match = /^\{(\d+)(,(\d*))?\}/u.exec(this.source.slice(this.at));
      if (match === null) throw new Unsupported("a brace that is not a quantifier");
      min = Number(match[1]);
      max = match[2] === undefined ? min : match[3] === "" ? Infinity : Number(match[3]);
      this.at += match[0].length;
    } else {
      return atom;
    }
    // Lazy and greedy match the same strings: only existence matters here.
    if (this.peek() === "?") this.at += 1;
    if (!Number.isSafeInteger(min) || (max !== Infinity && !Number.isSafeInteger(max)) || min > REGEX_STATE_LIMIT || (max !== Infinity && max > REGEX_STATE_LIMIT)) {
      throw new Unsupported(`a repetition count past ${REGEX_STATE_LIMIT}`, SMALLER);
    }
    return { t: "repeat", item: atom, min, max };
  }

  private atom(): Node {
    const ch = this.peek();
    if (ch === undefined) throw new Unsupported("the pattern ends where an atom was expected");
    if (ch === ".") {
      this.at += 1;
      return { t: "char", source: "." };
    }
    if (ch === "(") return this.group();
    if (ch === "[") return { t: "char", source: this.characterClass() };
    if (ch === "\\") return { t: "char", source: this.escape(false) };
    // A pattern character: one code point.
    const code = this.source.codePointAt(this.at)!;
    this.at += code > 0xffff ? 2 : 1;
    return { t: "char", source: `\\u{${code.toString(16)}}` };
  }

  private group(): Node {
    this.at += 1;
    if (this.peek() === "?") {
      if (this.peek(1) === ":") {
        this.at += 2;
      } else if (this.peek(1) === "<") {
        const end = this.source.indexOf(">", this.at);
        if (end < 0) throw new Unsupported("a group name without its end");
        this.at = end + 1;
      } else {
        throw new Unsupported("an inline group modifier");
      }
    }
    const inner = this.disjunction();
    if (this.peek() !== ")") throw new Unsupported("a group without its end");
    this.at += 1;
    return inner;
  }

  /** A class, as its source text: `[…]` matches one code point in u-mode. */
  private characterClass(): string {
    const start = this.at;
    this.at += 1;
    if (this.peek() === "^") this.at += 1;
    while (this.peek() !== "]") {
      if (this.peek() === undefined) throw new Unsupported("a class without its end");
      if (this.peek() === "\\") this.escape(true);
      else this.at += this.source.codePointAt(this.at)! > 0xffff ? 2 : 1;
    }
    this.at += 1;
    return this.source.slice(start, this.at);
  }

  /** One escape, as its source text; a backreference is refused. */
  private escape(inClass: boolean): string {
    const start = this.at;
    this.at += 1;
    const ch = this.peek();
    if (ch === undefined) throw new Unsupported("a pattern that ends in a backslash");
    if (/[1-9]/u.test(ch)) throw new Unsupported("a backreference is not regular");
    if (ch === "k" && !inClass) throw new Unsupported("a named backreference is not regular");
    if (ch === "p" || ch === "P") {
      const end = this.source.indexOf("}", this.at);
      if (this.peek(1) !== "{" || end < 0) throw new Unsupported("a property escape without its braces");
      this.at = end + 1;
    } else if (ch === "c") {
      this.at += 2;
    } else if (ch === "x") {
      this.at += 3;
    } else if (ch === "u") {
      if (this.peek(1) === "{") {
        const end = this.source.indexOf("}", this.at);
        if (end < 0) throw new Unsupported("a code point escape without its end");
        this.at = end + 1;
      } else {
        this.at += 5;
        // A surrogate pair spelled as two escapes is one code point.
        const high = Number.parseInt(this.source.slice(this.at - 4, this.at), 16);
        if (high >= 0xd800 && high <= 0xdbff && this.source.slice(this.at, this.at + 2) === "\\u") {
          const low = Number.parseInt(this.source.slice(this.at + 2, this.at + 6), 16);
          if (low >= 0xdc00 && low <= 0xdfff) this.at += 6;
        }
      }
    } else {
      // \d \D \s \S \w \W, \f \n \r \t \v, \0, \b (a class's backspace),
      // an identity escape: one code point.
      this.at += this.source.codePointAt(this.at)! > 0xffff ? 2 : 1;
    }
    return this.source.slice(start, this.at);
  }
}

// --- the program ---------------------------------------------------------------

const OP_CHAR = 0;
const OP_SPLIT = 1;
const OP_JUMP = 2;
const OP_ASSERT = 3;
const OP_MATCH = 4;

const ASSERT_CODES: Readonly<Record<AssertKind, number>> = { bol: 0, eol: 1, wordb: 2, nwordb: 3 };

/** What one code point matches, decided by the platform's RegExp on that
 * code point alone, remembered per code point. */
class CodePointPredicate {
  private readonly ascii = new Int8Array(128);
  private readonly other = new Map<number, boolean>();
  private readonly expression: RegExp;

  constructor(source: string) {
    this.expression = new RegExp(`^(?:${source})$`, "u");
  }

  /** The answer (bit 0) and whether it had to be computed (bit 1: a step
   * of its own), without allocating. */
  test(code: number): number {
    if (code < 128) {
      const known = this.ascii[code]!;
      if (known !== 0) return known === 2 ? 1 : 0;
      const pass = this.expression.test(String.fromCharCode(code));
      this.ascii[code] = pass ? 2 : 1;
      return pass ? 3 : 2;
    }
    const known = this.other.get(code);
    if (known !== undefined) return known ? 1 : 0;
    const pass = this.expression.test(String.fromCodePoint(code));
    this.other.set(code, pass);
    return pass ? 3 : 2;
  }
}

/** A compiled pattern: flat states (op, first and second out, argument). */
export interface BoundedRegexProgram {
  readonly op: Uint8Array;
  readonly out: Int32Array;
  readonly out1: Int32Array;
  /** OP_CHAR: the predicate index; OP_ASSERT: the assertion code. */
  readonly arg: Int32Array;
  readonly predicates: readonly CodePointPredicate[];
  readonly start: number;
}

interface Fragment {
  readonly start: number;
  /** State slots still to be patched: [state, which out (0 | 1)]. */
  readonly outs: [number, 0 | 1][];
}

class Compiler {
  readonly op: number[] = [];
  readonly out: number[] = [];
  readonly out1: number[] = [];
  readonly arg: number[] = [];
  readonly predicates: CodePointPredicate[] = [];
  private readonly bySource = new Map<string, number>();

  private state(op: number, arg = 0): number {
    if (this.op.length >= REGEX_STATE_LIMIT) throw new Unsupported(`a pattern that compiles past ${REGEX_STATE_LIMIT} states`, SMALLER);
    this.op.push(op);
    this.out.push(-1);
    this.out1.push(-1);
    this.arg.push(arg);
    return this.op.length - 1;
  }

  private patch(outs: readonly [number, 0 | 1][], to: number): void {
    for (const [state, which] of outs) {
      if (which === 0) this.out[state] = to;
      else this.out1[state] = to;
    }
  }

  private predicate(source: string): number {
    let index = this.bySource.get(source);
    if (index === undefined) {
      index = this.predicates.length;
      this.predicates.push(new CodePointPredicate(source));
      this.bySource.set(source, index);
    }
    return index;
  }

  compile(node: Node): Fragment {
    switch (node.t) {
      case "empty": {
        const s = this.state(OP_JUMP);
        return { start: s, outs: [[s, 0]] };
      }
      case "char": {
        const s = this.state(OP_CHAR, this.predicate(node.source));
        return { start: s, outs: [[s, 0]] };
      }
      case "assert": {
        const s = this.state(OP_ASSERT, ASSERT_CODES[node.kind]);
        return { start: s, outs: [[s, 0]] };
      }
      case "seq": {
        let first: Fragment | undefined;
        let last: Fragment | undefined;
        for (const item of node.items) {
          const fragment = this.compile(item);
          if (last === undefined) first = fragment;
          else this.patch(last.outs, fragment.start);
          last = fragment;
        }
        return { start: first!.start, outs: last!.outs };
      }
      case "alt": {
        const fragments = node.items.map((item) => this.compile(item));
        let start = fragments.at(-1)!.start;
        for (let i = fragments.length - 2; i >= 0; i -= 1) {
          const split = this.state(OP_SPLIT);
          this.out[split] = fragments[i]!.start;
          this.out1[split] = start;
          start = split;
        }
        return { start, outs: fragments.flatMap((fragment) => fragment.outs) };
      }
      case "repeat":
        return this.repeat(node.item, node.min, node.max);
    }
  }

  /** item{min,max}: min copies, then either a loop (max unbounded) or
   * max − min optional copies, each one's skip leading past the rest. */
  private repeat(item: Node, min: number, max: number): Fragment {
    const parts: Fragment[] = [];
    for (let i = 0; i < min; i += 1) parts.push(this.compile(item));
    let tail: Fragment | undefined;
    if (max === Infinity) {
      const split = this.state(OP_SPLIT);
      const body = this.compile(item);
      this.out[split] = body.start;
      this.patch(body.outs, split);
      tail = { start: split, outs: [[split, 1]] };
    } else if (max > min) {
      const skips: [number, 0 | 1][] = [];
      let previous: Fragment | undefined;
      let first: number | undefined;
      for (let i = min; i < max; i += 1) {
        const split = this.state(OP_SPLIT);
        const body = this.compile(item);
        this.out[split] = body.start;
        skips.push([split, 1]);
        if (previous !== undefined) this.patch(previous.outs, split);
        else first = split;
        previous = body;
      }
      tail = { start: first!, outs: [...skips, ...previous!.outs] };
    }
    if (tail !== undefined) parts.push(tail);
    if (parts.length === 0) {
      const s = this.state(OP_JUMP);
      return { start: s, outs: [[s, 0]] };
    }
    for (let i = 1; i < parts.length; i += 1) this.patch(parts[i - 1]!.outs, parts[i]!.start);
    return { start: parts[0]!.start, outs: parts.at(-1)!.outs };
  }
}

/**
 * Compile a pattern for bounded evaluation: the platform's RegExp must accept
 * it with the `mu` flags, and it must be regular and compile within
 * REGEX_STATE_LIMIT states. Otherwise the reason, in the words a finding or a
 * not-judged expectation uses.
 */
export function compileBoundedRegex(pattern: string): { readonly ok: true; readonly program: BoundedRegexProgram } | { readonly ok: false; readonly reason: string } {
  try {
    new RegExp(pattern, "mu");
  } catch (error) {
    return { ok: false, reason: `is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const tree = new Parser(pattern).parse();
    const compiler = new Compiler();
    const fragment = compiler.compile(tree);
    const match = compiler.op.length;
    if (match >= REGEX_STATE_LIMIT) throw new Unsupported(`a pattern that compiles past ${REGEX_STATE_LIMIT} states`, SMALLER);
    compiler.op.push(OP_MATCH);
    compiler.out.push(-1);
    compiler.out1.push(-1);
    compiler.arg.push(0);
    for (const [state, which] of fragment.outs) {
      if (which === 0) compiler.out[state] = match;
      else compiler.out1[state] = match;
    }
    return {
      ok: true,
      program: {
        op: Uint8Array.from(compiler.op),
        out: Int32Array.from(compiler.out),
        out1: Int32Array.from(compiler.out1),
        arg: Int32Array.from(compiler.arg),
        predicates: compiler.predicates,
        start: fragment.start,
      },
    };
  } catch (error) {
    if (error instanceof Unsupported) {
      return { ok: false, reason: `cannot be evaluated in bounded linear time (${error.message}); ${error.hint}` };
    }
    return { ok: false, reason: `could not be compiled for bounded evaluation: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export type RegexVerdict =
  | { readonly kind: "match" }
  | { readonly kind: "no_match" }
  | { readonly kind: "not_judged"; readonly reason: string };

/** The bounds of one evaluation (tests pass smaller ones). */
export interface RegexLimits {
  readonly steps: number;
  readonly ms: number;
}

const DEFAULT_LIMITS: RegexLimits = { steps: REGEX_STEP_LIMIT, ms: REGEX_TIME_LIMIT_MS };

const isLineTerminator = (code: number) => code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;
/** `\w` with the `u` flag and no `i`: ASCII letters, digits and `_`. */
const isWord = (code: number) => (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f;

/**
 * One streaming evaluation of a compiled program over text that arrives in
 * pieces (a string, or a large output read in bounded chunks): `push` each
 * piece, then `end`. Whether the pattern matches anywhere, as `test` with
 * the `mu` flags answers — or not_judged past the bounds.
 */
export class BoundedRegexRun {
  private readonly marks: Int32Array;
  private current: number[] = [];
  private next: number[] = [];
  private readonly stack: number[] = [];
  private generation = 0;
  private steps = 0;
  private readonly startedAt = Date.now();
  private verdict: RegexVerdict | undefined;
  /** The code point before the current position (-1 at the start). */
  private previous = -1;
  /** A code point read but not consumed: the high half of a pair split
   * across two pieces. */
  private pendingHigh = -1;
  private readonly held: number[] = [];

  constructor(private readonly program: BoundedRegexProgram, private readonly limits: RegexLimits = DEFAULT_LIMITS) {
    this.marks = new Int32Array(program.op.length).fill(-1);
  }

  /** The verdict once known (a match can be known early). */
  get done(): RegexVerdict | undefined {
    return this.verdict;
  }

  push(text: string): void {
    if (this.verdict !== undefined) return;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (this.pendingHigh >= 0) {
        const high = this.pendingHigh;
        this.pendingHigh = -1;
        if (code >= 0xdc00 && code <= 0xdfff) {
          this.held.push((high - 0xd800) * 0x400 + (code - 0xdc00) + 0x10000);
          continue;
        }
        this.held.push(high);
      }
      if (code >= 0xd800 && code <= 0xdbff) {
        this.pendingHigh = code;
        continue;
      }
      this.held.push(code);
      // Keep one code point in hand: an assertion at a position reads the
      // code point after it.
      while (this.held.length > 1 && this.verdict === undefined) this.advance(this.held.shift()!, this.held[0]!);
      if (this.verdict !== undefined) return;
    }
  }

  end(): RegexVerdict {
    if (this.verdict !== undefined) return this.verdict;
    if (this.pendingHigh >= 0) {
      this.held.push(this.pendingHigh);
      this.pendingHigh = -1;
    }
    while (this.held.length > 0 && this.verdict === undefined) {
      const code = this.held.shift()!;
      this.advance(code, this.held[0] ?? -1);
    }
    if (this.verdict !== undefined) return this.verdict;
    // The end of the text: the search's last start. Every thread that
    // reached the end already said so when it reached the match.
    if (this.addThread(this.current, this.program.start, this.generation, this.previous, -1)) return this.verdict = { kind: "match" };
    if (this.verdict !== undefined) return this.verdict;
    return this.verdict = { kind: "no_match" };
  }

  /** Consume one code point: the search's start at this position joins the
   * current threads, then every thread that can read `code` moves on. */
  private advance(code: number, following: number): void {
    const { program } = this;
    // Threads at this position (already in `current`, from the previous
    // step) plus a new start here.
    const at = this.generation;
    if (this.addThread(this.current, program.start, at, this.previous, code)) {
      this.verdict = { kind: "match" };
      return;
    }
    if (this.verdict !== undefined) return;
    this.generation += 1;
    const nextAt = this.generation;
    this.next.length = 0;
    for (const state of this.current) {
      if (program.op[state] !== OP_CHAR) continue;
      const answer = program.predicates[program.arg[state]!]!.test(code);
      if (!this.step((answer & 2) !== 0 ? 8 : 1)) return;
      if ((answer & 1) === 0) continue;
      if (this.addThread(this.next, program.out[state]!, nextAt, code, following)) {
        this.verdict = { kind: "match" };
        return;
      }
      if (this.verdict !== undefined) return;
    }
    const swap = this.current;
    this.current = this.next;
    this.next = swap;
    this.previous = code;
  }

  /** Count steps; false (and the verdict not_judged) past a bound. */
  private step(by: number): boolean {
    this.steps += by;
    if (this.steps > this.limits.steps) {
      this.verdict = { kind: "not_judged", reason: `the regular expression took more than ${this.limits.steps} steps over this output, so it was not judged` };
      return false;
    }
    if ((this.steps & 0xffff) < by && Date.now() - this.startedAt > this.limits.ms) {
      this.verdict = { kind: "not_judged", reason: `the regular expression took more than ${this.limits.ms} ms over this output, so it was not judged` };
      return false;
    }
    return true;
  }

  /** Add a state and everything reachable from it without reading a code
   * point — assertions decided between `before` and `after` — to `list`;
   * true when that reaches the match. */
  private addThread(list: number[], state: number, generation: number, before: number, after: number): boolean {
    const { program, stack, marks } = this;
    stack.length = 0;
    stack.push(state);
    while (stack.length > 0) {
      const s = stack.pop()!;
      if (s < 0 || marks[s] === generation) continue;
      marks[s] = generation;
      if (!this.step(1)) return false;
      const op = program.op[s]!;
      if (op === OP_MATCH) return true;
      if (op === OP_CHAR) {
        list.push(s);
        continue;
      }
      if (op === OP_JUMP) {
        stack.push(program.out[s]!);
        continue;
      }
      if (op === OP_SPLIT) {
        stack.push(program.out1[s]!, program.out[s]!);
        continue;
      }
      // OP_ASSERT
      const kind = program.arg[s]!;
      const holds = kind === 0 ? before < 0 || isLineTerminator(before)
        : kind === 1 ? after < 0 || isLineTerminator(after)
          : kind === 2 ? isWord(before) !== isWord(after)
            : isWord(before) === isWord(after);
      if (holds) stack.push(program.out[s]!);
    }
    return false;
  }
}

/** Whether `pattern` matches `text` anywhere (as `new RegExp(pattern,
 * "mu").test(text)` answers when it finishes), within the bounds; the reason
 * when the pattern cannot be evaluated that way or the bounds were passed. */
export function boundedRegexTest(pattern: string | BoundedRegexProgram, text: string, limits: RegexLimits = DEFAULT_LIMITS): RegexVerdict {
  const compiled = typeof pattern === "string" ? compileBoundedRegex(pattern) : { ok: true as const, program: pattern };
  if (!compiled.ok) return { kind: "not_judged", reason: `the regular expression ${compiled.reason}` };
  const run = new BoundedRegexRun(compiled.program, limits);
  run.push(text);
  return run.end();
}
