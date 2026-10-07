# Model-facing prompts

These files are what the model reads. TypeScript only fills `<<slots>>`.

- Slots are `<<name>>`, never `{{name}}`. A `{{` brace pair is refused.
- YAML `slots: [a, b]` is the contract. A missing fill or an extra fill fails closed.
- A leftover `<<name>>` after fill fails closed.
- Files are English. Host classifiers may still match a Korean operator order.

`system.md` is the sealed session prefix. `work/` and `swe/` are turn templates.
`work/ralph-plan-scout.md`, `work/ralph-plan-critic.md`, and
`work/ralph-plan-synthesize.md` are fresh-session, read-only planning passes;
their JSON is host-validated before it can become a DraftPlan artifact.
