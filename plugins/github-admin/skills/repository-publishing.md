# Private repository publishing

Use this skill when the operator explicitly asks Dokkabi to publish one bounded directory snapshot rather than preserve and push existing Git commits. For committed current-branch work, use the repository-pushing skill and `repo_push`.

1. Choose `op=repo_publish`, the exact existing private `owner` and `repo`, and one relative `source_path` directory. Do not publish `.` or the Dokkabi workspace as a whole.
2. Files below `source_path` become repository-root paths. Publishing accepts bounded UTF-8 text files, rejects protected filenames and secret-shaped content, and omits unsafe filesystem entries.
3. The operation adds or updates captured paths on the default branch without deleting unrelated remote paths and never force-updates a ref. GitHub forbids refs in a branchless repository, so a freshly empty target uses one Contents API initialization commit before the final additive commit; a one-file snapshot needs only initialization.
4. In live ask mode, a first request for an unlisted target opens one combined approval that persistently authorizes that exact repository and continues the same tool call. Do not tell the operator to clone, copy, or hand-run Git.
5. Wait for the TUI decision. Denial, cancellation, non-interactive ask mode, or bypass without prior repository policy starts no GitHub API mutation.
6. Authentication remains in the host `gh` store. Never request or pass a token, and never route around this operation with bash, curl, `git push`, or another client.
7. The operator can authorize in advance with `/github-admin allow-repo OWNER/REPO`, inspect policy with `/github-admin status`, and revoke with `/github-admin remove-repo OWNER/REPO`.
