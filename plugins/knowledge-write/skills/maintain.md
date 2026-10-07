# Maintain knowledge

1. Retrieve existing notes first so a new entry extends rather than duplicates
   the corpus.
2. Use `journal_record` for worklogs, research observations, decisions, and
   Error Book entries. Structured research supplies hypothesis, method, setup,
   results, analysis, conclusion, and source evidence. Keep uncertainty
   explicit.
3. Run `wiki_lint` after structural edits or promotion.
4. Use `knowledge_promote` only after reading the source and checking that the
   wider claim is supported. Promotion creates `wiki:derivedFrom` provenance.
   A wider visibility requires explicit promotion authority.
5. Use `knowledge_resolve` to retain an evidence-backed contradiction or mark
   an older claim superseded. Never delete history to make a conflict vanish.
6. Use `wiki_migrate` only for an exact stable ID after lint reports that the
   explicit schema migration is required.
7. Use `wiki_publish` only for the exact paths changed by this knowledge task.
   A push requires both the tool request and a protected profile grant.

Writes use atomic compare-and-swap replacement. A stale base is a conflict to
re-read and reconcile, never permission to overwrite.
