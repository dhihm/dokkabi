# Retrieve knowledge

1. Call `wiki_status` when vault availability or revision matters.
2. Call `wiki_search` with the narrowest useful scope, project, task, type, or
   tag filters. An empty text query is allowed only for filtered discovery.
3. Call `wiki_read` on the exact stable ID before citing or applying a hit.
4. Call `wiki_follow` to inspect `wiki:derivedFrom`, `wiki:dependsOn`,
   `wiki:partOf`, `wiki:contradicts`, `wiki:supersedes`, ordinary Markdown
   links, or backlinks.
5. Use `wiki_brief` when a bounded goal-oriented summary with stable IDs and
   an explicit sufficiency verdict is more useful than independent hits.
6. State the reported truth state: current, unverified, contested,
   superseded, or deprecated. Never present contested material as current.

Search and read results are sealed into the session blob store. Replay uses
those recorded bytes and never re-queries the live vault.
