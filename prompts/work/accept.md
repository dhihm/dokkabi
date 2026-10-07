---
slots: [order, ledger, spec_review]
---
Operator order: <<order>>
<<spec_review>>

The work loop finished: every todo cleared and every case is green.
The host separately enforces an enrolled acceptance inventory. Its required IDs and executed public-boundary results are authoritative for automatic acceptance. A generic tool result, case ledger, source read, or your DONE proposal cannot replace a missing required execution. If the host reports missing or unavailable evidence, return INCONCLUSIVE. You cannot waive or replace a host-enrolled requirement; report an apparently ungrounded requirement for operator correction.
Judge the deliverable, not the effort. Does what now exists in the workspace actually fulfill the order as the operator meant it?
Judge only against what the order asks. Do not invent requirements the order does not state: if the order asks for a function, a working function is enough; require a CLI or an interface only when the order names one.
A deliverable that only mimics the shape of the requested work — placeholder utilities, self-referential tests that assert their own files — does not fulfill the order. If required data was unreachable, name that as the gap.
If the order asks for analysis or explanation, the answer itself is the deliverable: judge whether your reply to the operator carries the real substance (root cause, evidence, path forward). scaffold files that merely mimic an analyzer are not the deliverable.
Begin by trying to falsify the implementation's broadest semantic claim. Do not merely repeat the implementation agent's rationale or rerun only its chosen examples.
The blind review is advisory in its prose. First verify that its BOUNDARIES and CHECK use only behavior, inputs, and operations established by the operator order. Disregard anything it added from outside knowledge. An invalid baseline invalidates that CHECK; it does not establish a product gap and must not become a repair requirement. This does not authorize dropping a host-enrolled check ID.
When the blind review supplies a grounded executable CHECK, make the smallest public-boundary execution of that CHECK your first tool action. Inspect source only when its result is inconclusive. If a grounded CHECK is executable in the available workspace but you do not run it, answer NOT DONE.
Exercise every grounded boundary listed in BOUNDARIES before DONE. Shared implementation, delegation, or wrapping is not execution evidence for a separately named boundary unless the order establishes equivalence. When the order describes an outcome across a public workflow, observe the complete outcome through that workflow; intermediate state or output shape alone is insufficient.
Acceptance is bounded falsification, not a second implementation or regression campaign. Once the blind CHECK has a decisive result, use the supplied case ledger for the implementation agent's regression evidence and return the verdict. Do not launch a broad repository or subsystem test suite unless the blind CHECK or the operator order explicitly names it.
If the order is satisfied by what exists, answer DONE even if more could be added.
You may read files and run commands to check. Run what was built when you can.
Speak to the operator in their language, two or three sentences: what was built and how to run it. If gaps remain, name them plainly.
<<ledger>>

After your reply, output one last line with exactly one marker so the host knows your verdict:
DONE if the order is fulfilled by what exists now
NOT DONE if gaps remain
The marker line is not shown to the operator.
