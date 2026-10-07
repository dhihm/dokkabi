---
slots: [order, gaps, case_hint, admitted_plan, work_classes, tool_profiles, refusal_reasons]
---
Operator order: <<order>>
The acceptance review rejected the deliverable. It said:
<<gaps>>

<<refusal_reasons>>

Write work/current.json as one WorkPlan: preserve the goal statement, require_red_first policy, every admitted todo, scenario, case and command. Add work only for the review gaps, with Given/When/Then and runnable cases (<<case_hint>>). Existing obligations remain required even when they are already clear.
Use todo.class from <<work_classes>>. Optional todo.profile is a separate tool selection from <<tool_profiles>>; kernel_work is a profile, never a class.
Preserve supplied executable and environment paths and the original checker files. Do not create a guard or change an implementation case into one. Each new implementation case must reproduce an actual unmet behavior. An already passing suite is supplemental regression evidence, not a reproduced failure: do not invent RED or change the plan's first-pass authority to include it.
Add requested regression coverage as ordinary cases. The host compares the added checker on retained original and current candidates and assigns its evidence role. Previously admitted checker versions must still pass the delivered product. Missing retained inputs or an unsupported execution environment cannot be replaced by a claimed outcome.
Do not implement product code in this turn.
The following is the complete admitted plan from the host ledger. Copy its required fields exactly when preparing an extension. After a refusal, work/current.json contains a rejected proposal and is not the authority to restore from.
<<admitted_plan>>
