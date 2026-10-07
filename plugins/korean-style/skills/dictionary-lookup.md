# 국립국어원 dictionary lookup

Use this skill when a Korean word question needs an authority: does this
headword exist, is this the standard spelling, is this 한자어 written
correctly, is this compound one word or two, is a coined term already taken.
A dictionary answers word questions. It does not answer style questions —
translation register belongs to `korean-style.text_polish`.

## 1. The three official sources

국립국어원 (the National Institute of Korean Language) publishes Open APIs,
not an official MCP server. Each is a separate service with a separately
issued key.

- **표준국어대사전** — `stdict.korean.go.kr/openapi`. The normative
  dictionary. Ask it first: headword existence, part of speech, 한자 form,
  standard spelling, sense-numbered definitions. If a word is not here, it
  is not 표준어.
- **우리말샘** — `opendict.korean.go.kr`. The open, collaboratively edited
  dictionary. It carries 신어, 방언, 전문용어, and regional forms that the
  standard dictionary excludes. Ask it second, when 표준국어대사전 returns
  nothing.
- **한국어기초사전** — `krdict.korean.go.kr`. The learner dictionary: plain
  definitions, usage examples, and multilingual glosses. Ask it when you need
  a usage example or a gloss in another language rather than a ruling.

Each API has a search operation (headword list) and a view operation (one
entry in full). Prefer search first, then view the exact target id.

## 2. Route: the `mcp` capability

There is no built-in dictionary tool. Reach these APIs through the `mcp`
capability, which is the only external-capability seam.

1. Ask the operator for the exact stdio server they want. Community wrappers
   exist — `koreandict-mcp-server` is one that appears in the MCP registry —
   but never enroll a server the operator has not named. You are proposing
   that their machine run that executable.
2. Enrol once with `mcp` `op=enroll`, giving the exact executable, bounded
   arguments, and the credential **environment variable name** only:
   `KOREAN_DICT_API_KEY`. Never paste, accept, echo, or store the key value
   itself — not in the enrollment call, not in an argument, not in a
   workspace file, not in a message to the operator. The operator owns the
   value in their environment.
3. Discover with `op=tools`, then invoke the exact server and tool with
   `op=call`.

If the operator has no key or does not want the server enrolled, say so and
stop there. A public web page read is weak evidence at best: it returns
rendered HTML, not an API result, so label it as such and never present it as
a dictionary ruling.

## 3. Do not invent entries

Do not invent, guess, or reconstruct a dictionary entry from memory. Model
recall of 표제어 and 뜻풀이 is exactly the thing this skill exists to replace.
Without a tool result you have no dictionary finding — you have an opinion,
and you must say which one you are giving.

Report findings with their source and sense, and keep the three outcomes
distinct:

- `표준국어대사전에 있다` — standard, safe to use in formal text.
- `우리말샘에만 있다` — attested but not normative; usable, worth flagging.
- `어느 사전에도 없다` — a coinage. Not an error, but the writer should know
  it is new, and it needs a definition on first use.

## 4. Typical checks

- **한자어 spelling.** Confirm the 한자 form before writing it beside the
  Hangul. 경종(警鐘) is a real headword; a coined compound may not be.
- **Invented terminology.** Before minting a term, check whether it already
  exists with a conflicting sense. A worldbuilding coinage that collides with
  a common noun will read as a typo.
- **띄어쓰기.** Whether a compound is one word is a dictionary fact, not a
  judgement call. If the headword exists as one word, write it as one word.
- **표준어 vs 방언.** 우리말샘 marks regional and non-standard forms; use that
  mark rather than your own sense of how common a word feels.
