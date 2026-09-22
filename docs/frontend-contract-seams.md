# Frontend contract seams

The Phase 2 UI currently runs on browser-local demo records under `apps/web/src/lib/studio-demo.ts` and `studio-store.tsx`. This is a reviewable interaction prototype, not an authorization layer or an API cache. The demo identity selector, activity log, reminders, and notification preferences do not prove backend behavior. Replace the demo source only after the backend publishes shared contracts and representative authorization tests.

## Read models needed

| UI consumer | Backend capability needed | Key semantics |
| --- | --- | --- |
| Shell, Dashboard, Today, Ventures | Session bootstrap and workspace hierarchy | Stable opaque IDs; effective roles; venture → group → inherited channels; venture freshness and selected context |
| Dashboard, Today, Tasks, Board, Timeline | Authorized task and outcome lists/detail | One canonical task in all views; cursor filters for venture, group, person, tag, status, due range; absolute dates and server timestamps |
| Channels and DMs | Channel/DM history and realtime subscriptions | Server join authorization, thread parent, mentions, reactions, pins/saves, reconnect cursor |
| Notifications | Personal inbox and preference read | Read/snooze/delivery states, absolute scheduled time, IANA timezone, source record ID |
| Knowledge | Authorized Markdown search and detail | Source ID, evidence class, sensitivity, owner, version history, last review, related records; exclude inaccessible results on the server |
| Decisions, Classes, Requests, Sales | Venture-scoped lists/detail | Canonical IDs and source links; class assessment is distinct from attendance; pipeline is partitioned by venture |
| Admin, sign-in, invite | Identity and membership reads | No trust in client-selected demo identity; group subset of venture membership; role scope and server audit records |

## Mutations needed

- Task create/update/accept, evidence attachment, blocker, status, reminder, snooze, and completion. Completion must reject missing evidence unless a recorded exception is permitted.
- Group/venture/channel creation and membership/role changes with server checks and audit identity.
- Message/thread send, mention resolution, reactions, pins, and saves. `/assign` and `/notify` require typed server preview followed by execution with an idempotency key; the client command preview is only a demo.
- Knowledge create/edit/import/export. Version increments and sensitivity enforcement must be server-owned.
- Decision, class, outcome, request, and pipeline edits return the canonical updated record.
- Invite issuance/acceptance, notification preferences, scoped PAT creation/revocation, and focus-session recovery require backend services; corresponding UI surfaces are explicitly labelled unavailable or demo-only until connected.

The first integration point should use the shared Zod envelope and error format from `packages/contracts` when the backend task publishes it. Do not derive API field names from the temporary demo types without a contract review.
