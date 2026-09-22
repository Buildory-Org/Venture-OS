# Frontend contract seams

The Phase 2 UI runs on browser-local demo records under `apps/web/src/lib/studio-demo.ts` and `studio-store.tsx`. This is a reviewable interaction prototype, not an authorization layer or an API cache. The demo identity selector, activity log, reminders, and notification preferences do not prove backend behavior. The separate `/dashboard/live` preview uses the published session, dashboard, and task contracts; it does not make the other pages live.

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

The first integration point now uses the shared Zod envelope and error format from `packages/contracts`. Do not derive API field names from the temporary demo types without a contract review.

The web app reserves same-origin `/v1/*` and `/api/auth/*` rewrites for the API, using server-side `VSO_API_ORIGIN` (default `http://localhost:4000`). The `/dashboard/live` preview reads authenticated bootstrap, dashboard, and paged tasks, validates the responses, shows API errors instead of demo fallback, and can move an authorized task to `in_progress` through the canonical task PATCH endpoint. For local development only, it sends the backend's opt-in `x-dev-user-id: user-divyansh` header on `localhost`; production uses the session cookie. The sidebar and all other screens remain on the explicitly labelled demo store. Their mutations, auth screens, and failure states still require per-screen integration.
