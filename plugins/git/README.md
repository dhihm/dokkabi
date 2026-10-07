# Git workspace workflow

The bundled `git` package provides one structured tool and the
`git.commit_and_push` skill. Install it once in Dokkabi; the current workspace,
not the package directory, determines which repository is operated on.

| Operation | Contract |
| --- | --- |
| `status` | Current branch and worktree status |
| `diff` | Worktree diff; `staged=true` selects the index |
| `log` | Bounded recent commit history |
| `branch_create` | Create and switch to a new local branch |
| `branch_switch` | Switch normally; never discard changes |
| `stage` | Stage explicit relative files, including deletions |
| `commit` | Commit only when the changed staged paths exactly match `paths` |
| `fetch_revision` | Fetch an exact full commit SHA from the workspace GitHub origin into objects only |
| `push` | Delegate internally to the existing authenticated push service |

Local commands execute through the existing fenced workspace bash capability.
They receive no GitHub credentials and never run arbitrary host Git. Hooks are
disabled, so run repository validation explicitly. Paths use literal pathspecs;
metadata paths, directories, traversal, control characters and arbitrary
operations/options are refused. Shell quoting preserves spaces and quotes.
The commit scope check compares NUL-delimited names, avoiding display quoting
and newline ambiguity. Unrelated staged paths refuse the commit rather than
being silently included or unstaged. A command error or timeout remains an
error. Normal Git index/branch locks apply; avoid concurrent mutations of the
same workspace while delivering a commit.

Push is part of this same model-facing tool. Authentication, repository
allowlists, approvals, descendant checks and remote-SHA verification reuse
`github_admin` internally rather than implementing another policy or exposing
credentials. Push follows the host permission mode: full authority (`bypass`)
allows public and private GitHub origins, any checked-out branch and new remote
branches without enrollment or approval. Ordinary modes retain the private
checked-out default-branch, enrolled-repository, 256-commit policy. Full mode
also permits tracked worktree changes, which are excluded from commit push.
Authentication, origin validation, non-rewriting existing-branch history and
remote-SHA verification apply in every mode. A new branch uses an empty lease
so a racing ref cannot be overwritten. Permission downgrade before dispatch
cancels the call. Non-GitHub remotes, force push, tags and deletion are not
supported. If the service is absent, push refuses and local operations remain
available.
The older `github_admin.repo_push` entry remains compatible with existing
clients; new Git workflow skills use `git.push` exclusively.

The host records the outer Git call/result and underlying sandbox execution
or GitHub push evidence. Model output is projected from retained sources by
the existing result pipeline. Removing this package removes its tool, prompt
and skill without adding branches to the agent loop.

Linked worktrees keep refs, objects and per-worktree index/HEAD state in a
common Git directory outside the workspace. Only this package's private,
fixed-command executor enrolls write access to that host-resolved metadata
under native Seatbelt/bubblewrap. Generic workspace bash and derived read-only
policies keep it read-only. The enrollment is sealed in the policy digest and
included in host-owned write-root protection. Normal checkout behavior and push
authorization are unchanged. Existing Docker worlds mount linked metadata
read-only; the package retains that boundary there; local metadata mutations still
fail rather than claiming success.

`fetch_revision` is a read-only remote operation for missing comparison commits.
The host reads origin as data, chooses the canonical GitHub HTTPS endpoint and
uses sealed Git plus existing in-memory authentication. It accepts no arbitrary
remote, branch, hook, helper or option. It disables tags, submodules and FETCH_HEAD
writes, verifies the commit and leaves HEAD, the index and refs unchanged.
Only repository/SHA/status are logged; transport credentials are never returned.
