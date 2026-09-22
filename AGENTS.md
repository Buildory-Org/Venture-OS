# Venture Studio OS agent instructions

## Shared workflow

- Treat `TODO.md` as the delivery ledger. Update checkboxes only when the matching work and verification are complete.
- Preserve the hierarchy `Workspace -> Ventures -> Groups -> Channels` and the decision log in `docs/architecture.md`.
- Keep changes scoped to the task's ownership area. Do not overwrite unrelated or user-authored changes.
- Before handing off a milestone, run the most relevant lint, typecheck, build, and smoke tests and record any limitation.
- Important backend changes require an independent code-review subagent before completion. This is especially required for authentication/authorization, permissions, reminder scheduling, outbox/idempotency, uploads, and MCP access.

## Phase gate

Phase 1 is dashboard-only. Do not implement the rest of the dummy product or production backend features until the user approves the dashboard direction.

