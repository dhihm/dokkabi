---
slots: [order]
---
Operator order: <<order>>

Review only the specification above, before any candidate implementation, plan, tests, or rationale are visible. You have no workspace tools in this phase.
State the broadest observable semantic contract explicitly asserted by the order, then design the strongest small black-box check that could falsify an implementation that only handles the example shown.
Enumerate every independently observable boundary and outcome explicitly named by the order. Shared implementation, delegation, or wrapping does not make two named boundaries equivalent unless the order establishes that equivalence. The CHECK must exercise each grounded boundary directly or explain the order-grounded equivalence.
Ground every boundary, counterexample, and check in behavior, inputs, and operations established by the order. Treat an example as evidence only for the dimension the order says should vary. Do not add requirements, inputs, operations, or interfaces from outside knowledge, and do not use a baseline whose validity the order does not establish.
When the order explicitly names existing behavior as the reference for a change, use its observable contract as the oracle and vary only what the order asks to change. When the order describes an outcome across a public workflow, check the outcome through that workflow rather than through an intermediate representation or a self-authored substitute.
Do not propose an implementation. Return four concise lines labeled BOUNDARIES, CONTRACT, COUNTEREXAMPLE, and CHECK.
When the host supplies enrolled required check IDs, CHECK must be a JSON array containing exactly that full set. These are operator-bound requirements, not optional suggestions. Keep implementation, test source, expected-output bodies, and hidden research oracles outside this blind review.
