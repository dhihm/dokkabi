---
slots: [order, ralph_draft_block, case_hint, work_classes, tool_profiles, planning_constraints, prior_refusals]
---
Operator order: <<order>>

<<ralph_draft_block>>

<<planning_constraints>>

<<prior_refusals>>

Turn this order into an executable work plan. Do not change product code yet.
Think about the outcome, then write only the todos the work actually needs. There is no required count. Not a fixed three.
If one change and one check suffice, write one todo. If later work must wait on earlier work, put that in blocked_by. A flat bag of independent todos with no edges is fine when they truly do not depend on each other.
The host drives ready todos (blocked_by all clear). Derive todo boundaries from real dependencies and observable outcomes; do not force a fixed phase or component template.
Preserve every explicitly requested terminal action, including commit, push, issue comment or state change, and deployment. Keep it in the goal and represent it in the executable graph when the mounted tools can perform it; never demote it to an operator postscript.

Workflow actions (recall, recording a lesson, inspecting evidence) belong in the responsible todo statement and remain explicit in the goal. Do not invent a separate product test claiming those actions occurred or reuse one product check as independent proof of unrelated workflow claims. Their actual observe receipts are separate evidence. Every product outcome still needs its genuine executable case. Never change already-bound obligations without their existing authority.

This is a narrow planning-and-RED turn, not an implementation investigation. For a localized bug without host enrollment, inspect the likely source and nearest existing test, add the smallest focused RED case, run it once, write the plan, and stop. With host enrollment, use its original authorized checker unchanged. Without host enrollment, reuse an existing failing test unchanged when it already proves the behavior; otherwise put the private RED in a new test file. Planning must not rewrite a tracked test. Do not search for or reconstruct an upstream solution. Use one scenario and one case per todo unless separate observable outcomes genuinely require more. Do not add a whole-file regression case when the focused case proves the behavior. Do not reread or validate the JSON or diff after writing it; the host owns that validation.
You have at most 16 inspection and execution tool calls. In this decomposition turn, reserve write/edit for the focused RED and work/current.json; those finalization tools remain available when exploration closes. If the host later opens a separate refused-plan repair turn, that turn may additionally receive a declared ssh op=put for a safe case artifact under its enrolled remote workspace. Do not spend the exploration budget reconstructing the repository's full test infrastructure.

The RED case proves the reported present failure; it does not predict incidental implementation or representation details. Reuse any runnable input or operation supplied by the operator and derive the smallest observable assertion directly from the order. Do not replace product behavior or simulate a prospective fix during decompose. If the order separately names several observable boundaries, the plan must account for each; one case may cover several only when it executes them or the order establishes their equivalence. For a runner labeled [native outcomes], `red_means` describes the observed behavioral failure; do not turn incidental rendered values or exception names into requirements. Other runners retain their legacy diagnostic matching: describe the actual pre-fix value or failure message, not only the expected value. A native report establishes that a test failed, not that its assertion covers the operator's requirement. Once the focused case reproduces the required behavioral failure, write the plan and stop.

Write work/current.json as one WorkPlan object:
- goal: id, statement (one short single-line sentence naming the operator's outcome in their words; the host re-attaches the full order verbatim after the seal). Do not paste logs, tracebacks, or any multi-line text into a JSON string. Use work/REPRO.md only when the case's red_means cannot hold the necessary evidence. Do not replace the order with a CLI contract, exact output string, or file path
- todos[]: id, title (short noun phrase), class (<<work_classes>>), priority (number; among ready todos the LOWEST number runs first, so 1 is the most urgent), blocked_by (id[]), statement (one line), optional profile (`<<tool_profiles>>`). A profile is not a class: kernel_work belongs only in profile
  - choose `docs` for documentation edits, `inspect` for read-only evidence inspection, `kernel_work` for local implementation, or `remote` for SSH-bound work. Omit `profile` when the todo needs the existing full tool surface (`default`)
  - optional consumes[] / produces[]: {id, kind} artifact ports, ONLY when one todo actually hands a named artifact to another (a reproduction test, a captured patch). Omit them entirely otherwise — most plans need none. A consumed id must be produced by exactly one todo, the kinds must match, and the consumer must reach its producer through blocked_by
- scenarios[]: id, todo, given, when, then — Given / When / Then
- cases[]: id, scenario, layer (unit|contract|replay), command, red_means, green_means
  - preserve an existing host-authorized guard exactly when carrying an admitted plan forward. An initial model draft cannot create a guard or turn an implementation case into one. A guard protects an already authorized invariant; a genuine failing guard becomes repair work, while a setup failure cannot establish a broken invariant
  - each implementation todo needs a genuine failing reproduction. Additional existing regression checks may already pass: keep them on that todo, or on a verify todo that depends on it. The host authenticates their supplemental role from native execution; do not fabricate a failure or add a guard to make them admissible. A passing check cannot replace an unproven implementation requirement

Rules:
- rewrite work/current.json completely; do not leave the host's placeholder template
- keep every JSON string single-line and short; omit long logs and tracebacks unless a minimal work/REPRO.md is necessary
- every todo needs scenarios AND cases with RED-capable test files on disk; the file may already exist
- a case that declares a `host` runs there, so its RED test file must be created THERE, in the case's `dir` — writing it into this workspace instead leaves the runner with nothing to execute
- Use an existing failing test directly when the order names one. Do not create a duplicate homework test for the same behavior
- Preserve the executable and environment paths supplied by the operator or repository. Runner examples show syntax; they do not authorize replacing the workspace interpreter with a different installation. Correct an unavailable invocation during draft preparation before implementing product changes
- todos alone without scenarios/cases still fail seal
- a case whose green depends on a NUMBER declares a typed `measurement` contract supported by a host-enrolled observer. Fix workload, unit, source, `ge`/`le`/`eq` requirements and explicit equality tolerance before the run. The host supplies inputs, checks outputs, and computes measurements; stdout cannot attest them. Example reference contract: `"measurement":{"schema_version":1,"evidence_level":"attested","sensor":"u32-square-v1","workload":{"elements":64},"requirements":[{"metric":"correct_elements","unit":"elements","source":"observer.correct_outputs","op":"eq","value":64,"tolerance":0}],"required_axes":{"workload":{"level":"full","rule":"checked_elements"}}}`. Use only an enrolled sensor and its registered runner protocol; unsupported domain sensors remain unavailable.
- every required substrate axis needs a supported observer witness rule. Device presence, a positive printed witness or elapsed time alone does not prove work. Metadata belongs in `measurement.metadata`, not a numeric bar.
- legacy report-only checks must explicitly declare `"evidence_level":"workspace_reported"`, with e.g. `"thresholds":{"accuracy":">=0.70","latency_ms":"<=250"}`. They may print `threshold: accuracy=>=0.70` and `measured: accuracy=<number>` for comparison of their report; this weaker mode cannot satisfy an attested claim. Without a declared bar the number judges nothing: a gate that only checks a score was RECORDED passes on any score at all, including one worse than chance
- name the bar for what must be beaten, not for what will be produced. "an artifact exists", "the report parses", "the score is between 0 and 1" are not bars — they are satisfied by a run that did the work badly, and by a run that did no work at all
- a bar is set before the run and never from its result. If you cannot say what must be beaten, the case is not ready to be written; ask the order, and leave the case red rather than closing it on a number nobody chose
- if you declare a port, wire it: an artifact nobody produces, two producers, a kind mismatch, or a consumer that does not depend on its producer all refuse the plan
- case commands must use a runner registered for this repository: <<case_hint>>
- if the repository uses another runner, write `work/runners/<id>.json` with `id`, `example`, `invocations`, and `test_file`, then use an executable command matched by that spec in the cases
- in a runner spec, `programs` is an array of alternative executable basenames; put fixed tokens after the executable in `subcommand`
- `example` must start with a real matching program and subcommand, not the runner id or an invented alias
- exact custom-runner shape: `{"id":"repo-check","example":"check-tool verify tests/example.spec","invocations":[{"programs":["check-tool","check-tool-alt"],"subcommand":["verify"]}],"test_file":{"extensions":[".spec"]}}`
- case commands use the executable form matched by `invocations`, never the runner id: `{"command":"check-tool verify tests/example.spec"}`
- in this turn you may write under tests/ and work/ only

Tools in this turn: read, write, edit, grep, glob, ls, git_status, git_diff, git_log, bash (sandboxed; workspace-write network is available by default; fenced in read-only or DOKKABI_SANDBOX_NET=deny), web_fetch (host HTTPS), github, repository-authorized github_write, repo, and maek when mounted.
