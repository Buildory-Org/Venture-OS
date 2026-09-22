# Backend agent instructions

- Use the installed `$ponytail` skill in full mode for backend implementation. Do not simplify away validation, authorization, durability, security, error handling, or the required smoke check.
- Use `$ponytail-review` as an additional over-engineering pass after the normal correctness/security review; it does not replace that review.
- Do not begin production feature implementation before the Phase 1 dashboard approval gate. Until then, restrict work to reading decisions, tightening backend plans/contracts, and identifying test seams without speculative scaffolding.
- Spawn an independent code-review subagent for important backend boundaries: authentication/authorization, membership permissions, reminder/outbox/idempotency, uploads, and MCP access.
- Run the smallest relevant runnable check during development, then the complete backend smoke suite before milestone handoff.

