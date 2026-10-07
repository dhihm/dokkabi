# youtube-study plugin

Thin adapter for Malgwi (말귀), the study-page product: static study
pages and userscripts built from YouTube subtitles for any language
pair. The domain sources of truth — the lesson-v2 schema, the panel
runtimes, the compiler, and the legal review — live in the
`dhihm/malgwi` repository. This package embeds frozen copies:

- `runtime/index.template.html` and `lesson-lib.ts` are byte-identical
  copies from the pinned commit recorded in `PINNED.json`; the build refuses
  to run if the template drifts from its recorded SHA-256.
- `captions.ts` is the caption acquisition seam. v1 ships only the local
  subtitle-file adapter (`.vtt`/`.srt`/neutral JSON). Any unofficial network
  fetcher must stay a separate, replaceable, off-by-default experiment.

The plugin never calls a model. The session's selected model (whatever the
operator picked) authors `pronunciation_ko` and `translation_ko` through the
`draft` operation; originals and timecodes are bound to the capture digest
and every operation refuses to alter them. `verify` re-derives every
guarantee from disk — capture integrity, schema, verbatim originals,
timecodes, and byte-identity of the page with the pinned runtime output —
and doubles as the status surface (line counts, drafted counts, built).

Local subtitle files make inspect deterministic, so record and replay see
the same capture and output digests without network access. Generated pages
are local artifacts; nothing here deploys or publishes them.

To update the pinned runtime: commit in `malgwi`, run
`bun scripts/pin.ts` there, copy `runtime/index.template.html`,
`src/lesson.ts` (as `lesson-lib.ts`), and the pin output into this package
in one commit.
