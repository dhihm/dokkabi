# GitHub source navigation

Use this skill when the requested evidence lives in a remote GitHub repository
that is not available through the local `repo` capability.

1. Search before naming a path. Use `github` with `op=search_code` and a narrow code
   query; treat returned paths as candidates, not conclusions.
2. Read the containing tree when names or package boundaries are ambiguous.
3. Read the candidate file with `op=blob`. Omit `ref` only when the repository's
   actual default branch is the intended source; the provider resolves and logs
   that branch.
4. Keep reported source separate from inference. Cite the repository, resolved
   ref, and path in the conclusion.
5. If the tool cannot read the repository, report the missing access or missing
   ref. Do not replace evidence with a guessed `main` path.

For latest-version research, read `op=release` with owner/repo and no ref.
Inspect returned tag_name, draft, prerelease, published_at and release notes;
then read source using that exact tag. `ref` on release selects an exact tag.
Document version banners and release blogs do not establish the latest patch.
Issue/code searches and PR listings are not release metadata substitutes.

Large blob reads return Unicode character windows, with total_chars and
next_start_char when content is omitted. Continue with start_char and the
same repository/ref/path; use max_chars for a smaller focused window. Do
not infer end-of-file from a bounded source body. Recover the relevant
implementation before claiming source coverage.

For a known file and symbol/literal, use `op=blob find_text` to search the full
remote source and obtain its exact match/context. A code-search miss does not
prove absence: the search index can omit workflow files or lag the current ref.
Use `next_match_start_char` for another literal occurrence. A no-match response
needs no recovery. Retained blob probes search only the recorded source window;
sequential recovery does not extend that window to the full remote file. Never
leave an available continuation unread merely because the first window ended.

If a source path is missing or legacy, use `op=tree filename="basename"` to
locate paths at the same current ref without relying on the code index. The
result reports recursive-tree truncation honestly. Never retry a 404 path by
changing only its literal or window; recent failures are reused for five minutes
in the same operator turn. `refresh=true` is reserved for concrete evidence of
a repository change, not defeating that guidance.
