# Korean text polishing

Use this skill when Korean prose you produced reads like a translation of
English rather than something a Korean writer wrote. The symptom is not
grammar — the sentences parse fine. The symptom is register: borrowed
connectives, stacked nouns, hedges, and passives that Korean does not need.

Apply it to your own drafts and to documents you are asked to clean up.
Do not apply it silently to text you did not write; see "Do not touch".

## 1. Rewrite rules

Each rule is a substitution you can check, not an impression. Left side is
the pattern to find; right side is the repair.

| Pattern | Repair |
| --- | --- |
| `~에 대한` / `~에 대해` | `~의`, `~을 두고`, or drop it → "설정에 대한 논의" → "설정을 두고 벌인 논의" |
| `~을 통해` | `~(으)로`, `~에서`, or a verb → "대화를 통해 알 수 있다" → "대화에서 드러난다" |
| `~을 가지고 있다` | `~이 있다` / `~을 지닌다` → "특징을 가지고 있다" → "특징이 있다" |
| `~라는 점에서 의미가 있다` | delete the frame and say what matters → "기록이라는 점에서 의미가 있다" → "이건 기록이다" |
| `~로 인해` | `~때문에`, `~(이)라서` → "패전으로 인해" → "패전 때문에" |
| `~것으로 보인다` | `~같다`, or commit → "실패한 것으로 보인다" → "실패했다" |
| `~에 의해` (agentless passive) | restore the active voice → "왕에 의해 추방되었다" → "왕이 추방했다" |
| `~에 있어서` | `~에서`, `~할 때` → "전투에 있어서" → "전투에서" |
| `~을 진행하다 / 수행하다 / 실시하다` | use the verb itself → "검증을 진행한다" → "검증한다" |
| `~하도록 한다` | `~한다` → "출발하도록 한다" → "출발한다" |
| `~할 필요가 있다` | `~해야 한다` |
| `가장 ~한 것 중 하나이다` | delete, or name the rank you actually mean |
| `~적(的) / ~성(性) / ~화(化)` stacked | unfold into a predicate → "정치적 불안정성의 심화" → "정치가 갈수록 불안해진다" |

## 2. Beyond single patterns

- **Noun stacks.** Three or more nouns in a row is a translation artifact.
  "국경 분쟁 지역 관리 체계" → "국경 분쟁 지역을 어떻게 관리하는가".
- **Sentence length.** Over roughly 60 characters, split. Korean carries one
  claim per sentence more comfortably than English does.
- **Pronoun spray.** `그것`, `이를`, `해당` mostly translate English `it` and
  `the said`. Repeat the noun or drop the reference.
- **Connective padding.** `또한`, `그리고`, `하지만` at the head of every
  sentence is English paragraph rhythm. Keep the connective only where the
  logical turn is real.
- **Hedging.** `~인 것 같다`, `~라고 할 수 있다` stacked on one claim reads as
  evasion. Hedge once or not at all.
- **Register consistency.** Match the operator's own register — 반말 stays
  반말, 존댓말 stays 존댓말. Register is not a style defect; never "fix" it.

## 3. Do not touch

Leave these **verbatim** even when they look wrong:

- Quoted speech, NPC dialogue lines, and anything inside quotation marks.
- Proper nouns, coined terms, and invented vocabulary. A worldbuilding
  coinage is not a misspelling. If you suspect it is not a real word, that
  is a dictionary question — use `korean-style.dictionary_lookup`.
- Legal, licence, and specification text.
- The operator's own sentences. Polishing your draft is your job; rewriting
  theirs is not. If their text needs work, propose the change and
  ask the operator before applying it.

If a repair would change the meaning, it is not a repair. Keep the original
and ask the operator which meaning was intended.

## 4. Self-check before you return the text

1. Did any sentence lose or gain a claim? If yes, revert that sentence.
2. Does every rule you applied appear in the table above, or can you state
   the substitution in the same shape? If not, you are guessing.
3. Is the register the same as the source?
4. Are quoted strings, names, and coinages byte-identical to the original?
5. Read the first and last paragraph aloud. If a Korean speaker would not
   say it that way, the pass is not done.
