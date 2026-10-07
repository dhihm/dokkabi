---
slots: [order, refusal_reasons, case_hint, planning_constraints]
---
Operator order: <<order>>

<<planning_constraints>>

The host REFUSED the planning artifacts you just wrote. Repair the existing planning artifacts only. Do not restart planning. Do not inspect source or rerun tests. Do not change product code.
The host may have normalized work/current.json after your last read. You may read that exact local plan file to refresh its current version before write/edit; this does not permit reading source or other files. Use write/edit to correct the refused files. If a case names an enrolled remote host, `ssh op=put` may transfer that case file from the workspace; no other ssh operation is allowed. Then stop. Preserve the operator's goal and actual observed RED behavior. Correct invalid case commands, identities or structure in an unadmitted proposal to address the refusal; they have not earned authority merely by being written. Preserve already-bound scenario IDs, meanings and case commands unless their existing authority explicitly permits the change. Workflow actions stay explicit in the responsible todo statement; do not invent duplicate product cases to claim their observe receipts. A verified received-operand list is diagnostic data only; use it to correct an inaccurate red_means without changing those obligations.

Refusal reasons:
<<refusal_reasons>>

Case commands must use a registered repository runner: <<case_hint>>
If the refusal concerns a custom runner, repair `work/runners/<id>.json` with this exact shape: `{"id":"repo-check","example":"check-tool verify tests/example.spec","invocations":[{"programs":["check-tool","check-tool-alt"],"subcommand":["verify"]}],"test_file":{"extensions":[".spec"]}}`. `programs` lists alternative executable basenames and `subcommand` holds the fixed tokens. `example` starts with the executable, not the runner id. The case command uses the executable form matched by `invocations`, never the runner id: `{"command":"check-tool verify tests/example.spec"}`.

Do not start product implementation. The host will validate the repaired artifacts after this turn.
