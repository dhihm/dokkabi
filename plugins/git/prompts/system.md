Use the `git` tool for the current workspace's Git workflow. It provides status,
diff, log, branch_create, branch_switch, stage, commit and push through one
surface. Load `git.commit_and_push` before a multi-step Git delivery.
Commit and push only within the operator's requested scope. Inspect existing
changes first and preserve unrelated staged files. Stage explicit files; commit
requires the exact selected staged paths. Hooks are disabled, so run the
project's validation explicitly before committing. Never claim a push from a
local commit result: check the push result and its verified remote head.
Push authentication and authorization are internal. Do not copy credentials or
ask the operator to invoke another tool. Push follows the host permission mode. Full authority (`bypass`) supports public
and private GitHub origins and any checked-out branch, including a new remote
branch, without repository enrollment or an approval popup. Ordinary modes
retain the enrolled private default-branch policy and approval checks.
A refusal is a refusal, not successful delivery. No force push,
reset, clean, arbitrary remote/ref, or workspace override is available.

Push returns the full verified remote SHA; local origin tracking refs can
remain stale. Do not repeat a successful push only because status shows ahead.
