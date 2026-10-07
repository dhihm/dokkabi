# Autonomous review workflow

Read authenticated github op=pull, then begin with owner/repo/number and omit
head/base so the host binds their exact retained values. Explicit values must
match the current authenticated metadata; do not reconstruct or abbreviate SHAs.
After begin, call review_assessment task with publish_general/publish_review
from the operator request, a literal operator_quote, and report_path under work/
(use the exact operator-requested JSON path when supplied).
Before local tests, register the concrete gap cases those assertions will resolve.
Do not run a broad suite first and retroactively attach it to newly invented
hypotheses. Preflight probes capability only; it is not a test plan. After a
planned assertion, conclude with its real result refs rather than rewriting the
contract. Use static or authenticated author evidence where appropriate.
These fields record intent; they grant no authority. For report-only requests,
both booleans are false. Do not invent an implementation plan for review work.

Before any review publication or completion, call audit with your verdict,
self-critical reasoning and dependencies. Reconsider each proposed blocker:
trace the changed production path versus base, look for counterexamples to
safety claims, read existing author validation and exact-head CI, and distinguish
a real product requirement from your own incomplete work or host limitations.
Do not equate passing tests or a clean ledger with correct code. Confirm each
finding's premises and whether the requested minimal action actually closes it.
COMMENT needs a named unresolved case and an authenticated quoted external-run,
deployment-asset or author-measurement dependency; uninspected source is work
for you, not for the developer. All changed files must be inspected for COMMENT.
Static/unit gaps must be investigated or checked by you; generic CI summaries
that omit named tests do not justify outsourcing available unit validation.
External holds concern actual integration/system/GPU obligations. Do not
change a case scope solely to evade this distinction; only a genuinely new
production obligation justifies an explicit new plan.

Publish only the requested general/formal deliveries. Reuse verified existing
same-session deliveries; never add a duplicate merely to satisfy a checkpoint.
Call finish after audit/delivery; it refreshes authenticated PR metadata and
CI itself. Changed facts invalidate the audit: inspect the changed evidence
and re-audit. Identical facts/verdict/contracts retain the existing checkpoint.
finish writes the final JSON report from the audited cases and actual delivery
receipts; do not overwrite it with an earlier freeform draft. Overwritten or
missing reports reopen completion until regenerated. The verified finish
outcome and matching report bytes are the completion receipt. If a checkpoint
continues the session, perform the named remaining work rather than asking the
operator to finish your available investigation. The bounded runtime does not
choose a verdict or infer permission from contributor prose.

On a structured refusal, use its recovery facts. hypothesis_changed preserves
the original case: close it with conclude or supply a genuine plan_change_reason.
stale_evidence names the planning boundary and previous commands: run the
relevant check once after that boundary, then conclude the matching cases using
its real result refs. Do not resend equivalent refs while changing limits prose.
invalid_probe_selection returns available_probes for the exact evidence_ref.
evidence_kind_scope_mismatch names the mutable evidence_kind attachment. Use
local for actual local execution or author for authenticated author validation;
changing limits prose cannot repair a static label on a runtime scope.
Recovery next_op follows actual registration: a refused new case needs case,
not conclude. Recovery context persists across fresh checks and refreshes
available_results after planned_at; use those actual tool/result refs and probe
IDs to conclude without rerunning a completed relevant check.
Choose only observed completed IDs relevant to the case; do not resend rejected
IDs or promote unrelated assertions. Use status(case_id) for a specific original
contract; default status is compact.

# Pull request review

Use `review_assessment` throughout the review, not as paperwork at the end.
Local checkout review does not require the unrelated repo registry/pin tool.
Use skill for skill reads, review_assessment for assessment operations, read for
local files and github for authenticated metadata. A refused unrelated tool is
not evidence that source or author validation is unavailable. Do not publish
an evidence-gap review before inspecting available source and author evidence.
Both scoped comments and changes requests require a grounded assessment case;
COMMENT evidence holds also require all changed files inspected and assessed;
only grounded confirmed defects may use a scoped REQUEST_CHANGES before
unrelated files are reviewed. Correct a premature existing
review body in place after investigation, then submit the supported final event.
For large existing files with small changes, use source region=changes at offset
zero and follow every next_offset with the same region. The host retains all
changed hunks with source context and line ranges. Use region=full or structured
local reads for additional callers/definitions required by the specific risk;
do not scan an entire catalog/workflow solely to satisfy a byte-coverage ledger.
Begin with the exact PR head/base, read changed source windows to completion,
and record failure hypotheses as gap cases before local execution. Each case
identifies trigger values, production path, an exact source quote, failure oracle,
actual scope and limitations. Review different risk dimensions separately: batch
growth/shrink, copy/skip paths, failure/timeout cleanup, ownership and concurrent
rank ordering as applicable. A helper-only assertion cannot close a production
worker or multi-rank hypothesis. Check whether the assertion really drives the
claimed branch; passing tests alone are not a failure search. Resolve cases from
observed successful tool-result refs (status.evidence[].ref, not CI source_ref
or source/mapping refs), authenticated author/CI evidence with revision
mapping, or specific static proof. Read status and report remaining actionable
gaps; the publication plugin rejects incomplete APPROVE submissions.


Read-only review does not require an implementation work graph or a nested
Dokkabi process. Source inspection, existing checks and explicitly authorized
review probes/reports are review artifacts. Apply implementation planning rules
when proposing tracked-source implementation, not as a reason to abandon an
authorized review. Respect explicit repository review restrictions and the
operator's requested scope.

1. Read `github op=pull` and retain `headRefOid`, `baseRefOid`, state and base
   branch. Review an isolated checkout of that head. Compare against the merge
   base of those exact commits, not a moving branch or merely the head parent.
   Use authoritative revision values from metadata, supplied evidence or local
   refs without reconstructing full hashes from memory. Before declaring a
   comparison commit unavailable, verify that the attempted SHA exactly matches
   its recorded source and try the local object database first. A lookup of a
   mistyped reference establishes neither object absence nor an evidence gap.
   Correct such attempts, preserve their results and update the report's cause.
   If a referenced exact comparison commit is genuinely absent, use structured
   git fetch_revision with its observed full SHA. It retrieves objects from the
   workspace GitHub origin without changing checkout or refs. Then compare the
   actual source delta; do not manufacture a developer gap from local absence.
2. If the exact-head checkout is provided, read AGENTS.md, applicable nested
   instructions and repository review docs with the structured local `read`
   tool before review. Use local `bash_probe` for diffs and source exploration.
   Do not fetch whole workflows or guess remote
   instruction filenames: local reads avoid repeated authenticated round trips.
   Use the structured local `read` tool for source anchors cited in the final
   report, so the host records file-read evidence; shell inspection alone does
   not establish a verified file citation.
   The GitHub tool supplies live metadata; remote source is only a fallback when
   the exact checkout/file is unavailable. Read repository review instructions. Use `git diff --name-only` then bounded
   per-file changed hunks (small context). Trace each changed production decision
   to its inputs and consumers. Avoid entire workflows or broad all-file searches.
3. If output omits bytes, use `probe_log(path="blob:<digest>", recover=true)`
   until the needed evidence is recovered. It chooses unread omitted UTF-8-safe
   ranges and caps each read. Never manually guess offsets, requery the producer,
   or interpret a clipped view as a complete review. For structured batch output,
   filter with a short probe_log script to extract only the needed keyed results.
   github_ci also exposes source_blob for the full redacted CI source: query
   blob:source_blob with probe_log script for the relevant job/assertions and
   their context. Do not page through unrelated advisory output or all successful
   logs just because next_offset is non-null. Full retention permits targeted
   inspection; it does not require an indiscriminate scan.
4. Before tests, call `review_preflight` once with the exact test Python (including
   its venv path). Record interpreter, pytest/forked availability and torch
   CUDA/graph-pool support. Do not pass `--forked` when unavailable. Separate
   CPU-safe checks from CUDA bootstrap-dependent fixtures; do not knowingly run
   the latter on an unsupported environment to accumulate setup errors. Report
   an unavailable required GPU suite as unrun with the preflight reason, not as
   a code failure or a passing suite. Reprobe only if the interpreter/environment
   changes. A preflight failure is not evidence that a dependency is absent.
   Inspect test imports and fixtures before collecting a suite. Check additional
   runtime dependencies with the selected interpreter and discover documented
   CPU modes or existing supported import harnesses before attempting CUDA
   bootstrap. An unavailable GPU module does not justify abandoning unrelated
   CPU-safe checks. If a broad suite fails because tests replace import modules,
   isolate the affected files in fresh subprocesses before declaring the installed
   dependency broken. Do not build ad hoc incompatible kernel stubs or count
   supported CPU substitutes as real GPU execution.
   Use `bash_probe(probes=[{id, command}, ...])` for independent bounded reads or
   `bash_probe(command="...")` for one command. Do not repeat successful tests
   unless source changed or an unresolved concern requires it. Static condition
   tests are not deployment or external-service integration evidence.
   Make prerequisite setup fail closed before executing checks: use checked
   subprocess results or explicit shell guards for directory creation, archive
   extraction and checkout selection. Keep scratch paths inside the provided
   workspace; do not assume system temporary directories are writable. Verify
   the selected checkout before running a baseline comparison. A later command's
   exit zero does not erase earlier stderr or failed setup. Preserve the initial
   failed attempt separately from the corrected result and name actual output
   files or event records in the report, not merely the extracted source folder.
5. Before an APPROVE verdict, record coverage for each changed production path
   and transition: ordinary/skip-copy or equivalent alternative branches,
   shrink/grow and reactivation, alias/shared-capacity bounds, and applicable
   error/cancellation transitions. Drive production methods with executable
   assertions where practical. Helper-only tests or an analogous reimplementation
   do not prove the caller paths. Record the actual branch hit, meaningful trigger,
   oracle and result, including CPU fakes/constructor bypasses and unverified
   runtime scope. A probe whose trigger never occurs is not coverage. Do not
   replace a failed oracle silently; distinguish incorrect assumptions,
   pre-existing behavior, an optimization miss and response corruption. Keep
   original failed output and final rerun output in separate files. Missing
   safety-critical path evidence means COMMENT with an actionable approval hold,
   not APPROVE. Evaluate existing author/CI evidence against the reviewed SHA,
   configuration, production path and oracle before calling evidence missing.
   Attribute external runs accurately, but do not require personally repeating
   them solely because the review host lacks a GPU or dependency.
   Resolve each coverage claim to the exact executed call arguments and assertion.
   A loop label is not evidence that every call inside it uses that branch.
   Check alternative branches independently at each claimed transition, and
   assert preserved active data as well as cleared tails. Before finalizing,
   audit the report against the probe source and captured execution results;
   correct overstated coverage and execute missing probes where practical.
   After new evidence, update every affected report paragraph and coverage row;
   stale claims that a completed probe remains wholly unrun are also inaccurate.
   Track coverage per changed file: inspected hunks, production path, tests and
   unresolved evidence. Recovery completion only means bytes were read. If a
   needed source cannot be recovered, report COMMENT and the missing scope,
   rather than an unsupported APPROVE. Respect documented accepted risks while
   checking concrete newly introduced paths. Report file:line findings, exact
   head/base, executed checks and unrun checks in the repository review skeleton.
6. Before reporting each Must fix, verify its premises in the exact named file:
   find the input declaration, the assignment/override, the build consumer and
   the changed decision. Quote those anchors. Never transfer a parameter from a
   similarly named workflow. An absent declaration invalidates that example;
   check the actual resolver instead. A suspicion without a reproducible source
   path belongs under an explicit question, not REQUEST_CHANGES.
7. Approval hold contract: when COMMENT means insufficient approval evidence,
   say explicitly that only a comment was submitted and approval is withheld.
   Keep confirmed code defects under Must fix; missing evidence is a separate
   approval-gap section. For every blocking gap identify the affected production
   path and risk, the existing evidence inspected, the specific missing link or
   assertion, and the smallest developer action plus expected result that closes
   it. Prefer links to existing logs, exact-SHA/config mapping and named cases
   over demanding a fresh full benchmark or test suite. Distinguish evidence not
   inspected from evidence demonstrably absent, accepted unmeasured performance
   from correctness risk, and reviewer environment limits from product defects.
   Before asking the developer for evidence, perform the accessible check yourself:
   resolve referenced source revisions, inspect matching source and compute pins
   from exact bytes when available. A reviewer has not yet performed a check is
   not a developer evidence gap. Likewise ledger paperwork is reviewer work.
   Host-only missing utilities or incompatible test setup cannot block approval
   when the changed behavior has adequate static, author or CI evidence. Judge
   sufficiency against the changed risk, not an exhaustive deployment wishlist.
   A generic "GPU/TP8 unverified" sentence does not satisfy this contract.
   If the available evidence resolves the risk, reconsider the verdict instead
   of inventing new approval requirements. State the reviewed SHA and call out
   head movement; never extend a previous verdict to an unreviewed new head.
   Audit the public body and final operator report for these requirements.
8. Review posting, edits and delivery require the operator's requested scope.
   Public review prose contains the verdict, concrete code findings, accepted
   validation and minimal actionable requests. Keep reviewer-host GPU/package
   availability, local import/setup failures, retry narration, self-defense and
   generic disclaimers in the private audit artifacts. Do not explain to the
   developer that a reviewer environment failure is not a code defect; omit the
   irrelevant failure. Mention a verification limit publicly only when it
   identifies a concrete product risk and a specific developer action. Prefer
   concise labeled evidence to first-person accounts of how the review ran.
   General review comments and formal review bodies both follow the repository's
   required section skeleton. Audit each body separately before submission.
   A request to review alone produces a report and does not post to GitHub.
   Inside the PR comment, omit that PR's canonical URL; related links and source
   anchors remain useful. Link-first style is not a requirement to self-link.
   A general comment containing APPROVE does not change GitHub review state.
   When the operator requests an actual approval/request-changes review, use
   github_write op=pull_review with the explicit event and reviewed commit_id.
   If both a body comment and actual review are requested, deliver both, then
   verify the returned state, commit_id, id and html_url. Retain returned identities
   instead of searching the thread again; a deduplicated retry retains them too. Keep their statuses separate in the final report.

Read each before/after diff with review_assessment change and retain change_refs
before planning cases. For case recording, you may omit change_refs/source_refs:
the host derives them only from the complete observed diff and an exact
source_anchor in a current-review source window for that file. Never guess or
copy event IDs from unrelated windows; explicit invalid references still refuse.
Runtime evidence_refs remain actual tool/result references, not source refs.
A finding must distinguish behavior introduced/exposed by
the diff from behavior already present in the base. For a surprising local
counterexample, compare the same trigger against base production code before
calling it a regression or asking the author to fix it. An ambiguous contract is
not itself evidence of a changed-code defect; inspect callers and existing tests.

Ground each production oracle in oracle_basis: the actual requirement, caller,
existing test or justified invariant. Do not invent a contract from an argument
name or call every behavioral delta a defect. Base behavior alone is not a spec;
a bug fix intentionally changes it. Inspect PR/issue intent before alleging a
regression. If the intended contract cannot be established, report the uncertainty
as a gap rather than a confirmed must-fix or a made-up implementation request.

When closing an existing hypothesis, use `review_assessment op=conclude` with
its recorded case_id and actual evidence_refs/probe_ids. Do not paraphrase the
planned trigger/path/oracle/scope with op=case: that changes the contract and
requires a new plan and execution. Use op=case to establish a new hypothesis or
intentionally change one, not to repeat a passed check during resume.

Reading this guidance is reference access, not a request to start a code review.
For discovery/queue tasks, inspect metadata and discussion without starting an
assessment. A requested code review explicitly starts review_assessment begin.

Status navigation distinguishes missing case reasoning from unread source. Use
status(file) to obtain recorded refs, retained blobs and the first uncovered
continuation. A complete source/diff does not need a repeated Git read merely
because its file is unassessed. Recover a needed exact quote from its retained
blob, then register the actual hypothesis or conclude the planned case.

### Approval contract reasoning

Treat a running check as current delivery state, not automatically a code-review
blocker. Before creating a CI dependency case, identify the concrete changed
production behavior and the actual requirement for that evidence. Evaluate
accepted author measurements, revision mappings, baseline failures and permitted
substitute validation together. Do not manufacture a new “all CI must finish”
oracle when the original code hypotheses are resolved. If evidence already
meets the actual contract, conclude the case with that reasoning. If a material
risk remains, state its specific trigger and missing assertion. Choose the
verdict from these facts, never to escape a host refusal or force approval.
A related PR is evidence only; finish the assigned PR before switching targets.
