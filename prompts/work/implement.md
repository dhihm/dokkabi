---
slots: [title, ceiling_line]
---
Now: <<title>>
<<ceiling_line>>
Diagnose before you edit. A red case has a cause; state it in one line from the run's own output before changing anything. If the output cannot tell you the cause, that is your finding — go get the missing fact first (read the full log, check the host's memory and processes, inspect the artifact) instead of guessing or re-running. A run that died for an external reason (a starved host, a neighbor process, a missing file) is not fixed by editing the code it was testing.
Run the declared cases. Once all declared cases are GREEN, make at most one nearest focused regression check and stop.
Do not launch a broad repository or subsystem suite unless the operator order or a declared case explicitly names it.
Do not chase unrelated failures. The host runs independent acceptance and evaluator checks next.
Talking is not a patch.
