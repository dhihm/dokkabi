# YouTube study lesson authoring

Use this skill to turn one YouTube video plus a local subtitle file into a
static study page for one study language (the learner's language). You
author natural text in the study language; the tool owns everything else.

0. Read `youtube-study/style.md` first when it exists: it is the operator's
   standing translation policy (pronunciation notation, register, speaker
   markers, terminology), organized per language pair when the workspace
   serves more than one. Follow it over your own defaults. If it does not
   exist and you are about to author a first lesson, propose one to the
   operator and create it, so later videos stay consistent. Write the
   policy itself in English; only output samples are in study languages.
1. Locate the subtitle file inside the workspace (`.vtt`, `.srt`, or the
   neutral JSON capture form). If the operator has none, ask for one; do
   not fetch subtitles from the network or reconstruct them from memory.
2. Run `youtube_study` with `op=inspect`, the video URL, `captions_path`,
   the video's `source_language`, and the learner's `study_language`
   (default `ko`). Read the returned numbered lines; they are the only
   source of original text. Note `lineCount` and `sourceDigest`.
3. Translate in windows. For each window of consecutive indices (about
   20-40 lines), run `op=draft` with `lines` entries carrying exactly
   `index`, `pronunciation`, and `translation`.
   - `pronunciation` renders the source speech in the learner's script,
     close to natural connected speech (e.g. en->ko: "왓 아 유 두잉 히어?";
     ko->en: romanization; en->zh: hanzi phonetic approximation).
   - `translation` is natural spoken text in the study language matching
     the line's register.
   - Never paraphrase, merge, split, or re-time lines; if a caption looks
     wrong, keep it verbatim and mention the concern to the operator.
   - Set `sentence_end: true` on a line that completes a spoken sentence
     and `sentence_end: false` on a line whose punctuation misleads (an
     abbreviation period, for example). You already know the sentence
     structure while translating, so annotate as you go — it powers the
     sentence-scope repeat. Lines you leave unannotated fall back to
     display-time heuristics.
4. Repeat drafts until `missingCount` is 0, then run `op=build`. A long
   video is just more windows; the draft file accumulates across turns.
   Pass `mode: "sheet"` when the operator wants the lines standalone or
   the video does not allow embedding; the default embeds the player with
   line sync.
5. Run `op=verify` and report its status: line counts, drafted counts, and
   the six checks. Only a fully green verify counts as done. If a check
   fails, fix by re-running the earlier operation; never edit generated
   files by hand.
5b. Optionally gloss key terms: vocabulary cards always carry usage
   examples from the lines and a web dictionary link, so a glossary is an
   enhancement, not a requirement. When the operator wants inline
   meanings, run `op=words` and gloss only the domain terms worth it
   (typically the top 100-200 by frequency) via `op=gloss` with entries
   carrying exactly `word` and `meaning` — short glosses (1-6 words) in
   the study language matching this video's usage. Never gloss the whole
   word list by default. Run `op=build` again afterwards so the glossary
   is embedded.
6. After a green verify, run `op=library` to refresh
   `library/study-library.user.js`, the single userscript covering every
   verified video; `op=list` shows the whole catalog with per-video
   progress. The results stay local. Tell the operator where the outputs
   are; do not deploy, publish, or share them anywhere.
