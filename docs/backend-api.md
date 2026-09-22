# Backend API and contract seams

All product routes use `/v1`, return `{ ok: true, data }`, and use the shared safe error envelope on failure. Dates are ISO 8601 strings at the HTTP boundary and IDs are stable opaque strings.

Cursor-paginated lists return `{ ok: true, data: { items, nextCursor? } }`; other purpose-built read models use their exported shared schemas. The contracts package exports `sessionBootstrapResponseSchema`, `dashboardResponseSchema`, and the generic `pagedSuccessEnvelope` helper.

## Identity and hierarchy

- Better Auth is mounted at `/api/auth/*`; magic-link email uses Resend when configured and a labelled local logger otherwise.
- `POST /v1/invitations/accept` attaches an authenticated Better Auth user to the app-owned membership from an admin invitation.
- `GET /v1/members` returns a paged, active-member directory with `id`, `name`, optional `handle`, and `role` (no email). Workspace-wide lookup supports DMs; `ventureId` and `groupId` filters require access to that scope. `handle` is an exact lookup; `q` searches names and handles. New invitees receive a stable generated handle, but older users with no stored handle remain discoverable by name.
- `GET /v1/session/bootstrap`, `GET /v1/hierarchy`, `GET /v1/dashboard` return the current user, role, authorized hierarchy, and canonical Today read model.
- Admin routes create invitations and ventures. `POST /v1/admin/groups` creates a group with `#general`; `POST /v1/admin/channels` accepts `{ groupId, name }` and creates an additional slugged channel (409 on a duplicate within the group).
- `GET /v1/admin/memberships` lists workspace memberships. `PUT /v1/admin/memberships/:id` replaces `{ role, ventureIds, groupIds }` for another active member. Groups must belong to assigned ventures; admins cannot edit their own membership through this route. The shared inputs are `createChannelSchema` and `updateMembershipSchema`.

## Collaboration and work

- Channel messages: `GET|POST /v1/channels/:channelId/messages`; direct messages: `GET /v1/direct-messages/:userId` (latest 100, chronological response), `POST /v1/direct-messages`.
- Channel history accepts `?pinned=true` or `?threadRootId=<id>` in addition to the ordinary cursor/limit query. `PUT /v1/messages/:id/reaction` accepts `{ emoji, active }`; `PUT /v1/messages/:id/save` accepts `{ saved }`; `PUT /v1/messages/:id/pin` accepts `{ pinned }`. `GET /v1/messages/saved` returns up to 100 saved, still-visible messages for the caller. Message reads include `reactions` (emoji-to-count map), `myReactions`, `savedByMe`, `pinned`, and optional `pinnedAt`/`pinnedBy`. Pins require an admin or venture head in a channel; reactions require message-write permission and saves require current message access. DM pins are unsupported.
- Socket.IO authorizes the initial connection and every `channel:join`; it emits channel-scoped presence, and `message:create` persists the message/event/outbox before emitting. Every channel/user fan-out rechecks the current session and membership. Browser clients authenticate through the Better Auth cookie. Local development also accepts `auth: { devUserId }` when `ALLOW_DEV_AUTH=true`; production ignores it. Socket requests carrying an Origin must match `APP_ORIGIN`. The web deployment must proxy `/socket.io` (including WebSocket upgrade) on the same origin as its auth cookie; the current Next rewrite only covers HTTP routes. Message history uses a total `(createdAt, id)` cursor order and `clientId` retries return the canonical prior result.
- Thread replies require an existing top-level root in the same channel or DM conversation. DM `clientId` retries also return the canonical message. REST and socket message creation, reactions, and pins emit authorized Socket.IO `event` payloads after persistence, and are also replayable through `GET /v1/events`; personal saves are not broadcast. Connected clients should resume from the event cursor after reconnect.
- Tasks: `GET|POST /v1/tasks`, `GET|PATCH /v1/tasks/:id`, comments, evidence submission/review, saved task filters, and outcome routes.
- Focus: `POST /v1/focus`, `GET /v1/focus/current`, `GET /v1/focus/history` (paged completed sessions, caller only), `POST /v1/focus/:id/complete`.
- Commands: `POST /v1/commands/preview`, then `POST /v1/commands/execute` with an idempotency key.
- Reminders: `GET /v1/reminders` (paged, caller only), `GET /v1/reminders/:id` (caller only), and `POST /v1/reminders/:id/snooze` accepting `10`, `20`, `30`, or `never`. Task-reminder notifications preserve `resourceType: "task"` and `resourceId: taskId`, and now also carry `reminderId` for snooze actions.

## Knowledge, operating records, and search

- Versioned Markdown: `POST /v1/documents`, `GET /v1/documents` (authorized paged metadata, optional `ventureId`/`status`), `GET|PUT /v1/documents/:id`, and metadata approval at `PATCH /v1/documents/:id/metadata`.
- Authorized cited retrieval: `GET /v1/knowledge/search`; bounded export: `GET /v1/context-packets/tasks/:id`.
- Cross-resource authorized search: `GET /v1/search` for tasks, messages, and ready file metadata.
- Decisions, classes/applied assignments, information requests, outcomes/timeline records, pipelines, and opportunities use their named `/v1` route groups. `PATCH /v1/decisions/:id`, `/classes/:id`, `/outcomes/:id`, `/pipelines/:id`, and `/opportunities/:id` accept non-empty partial updates from the exported `update*Schema` contracts. Venture scope is immutable; decisions/classes/outcomes/pipelines require an admin or venture head in scope, while an opportunity owner may also update their own record. All updates return the updated record.
- Class creation and updates require every facilitator/participant to be an active member of the class venture. Class lists, Today, dashboard, applications, and MCP schedules also enforce current venture access; workspace-wide classes remain available to their participants.
- `GET /v1/classes/:id` provides authorized detail. `POST /v1/classes/:id/applications` requires a different active same-venture reviewer. `GET /v1/classes/:id/applications` is paged; applicants see their own submissions, assigned reviewers theirs, and the facilitator/admin/venture head all in scope. `GET /v1/classes/:id/applications/:applicationId` and `PATCH /v1/classes/:id/applications/:applicationId/review` provide detail and an audited assessment (`{ assessment, nextGap? }`). Assigned reviewers can discover these classes through `GET /v1/classes`.

## Files, notifications, and MCP

- `POST /v1/uploads` creates constrained metadata and a short-lived upload URL, optionally linked to a same-scope task; recoverable completion rechecks metadata and promotes staging through `pending -> finalizing -> ready`; `GET /v1/files/:id/download` authorizes metadata before signing.
- Local object URLs are HMAC-signed and operation-scoped. Production uses Cloudflare R2 credentials and refuses the local adapter.
- `GET|PUT /v1/notification-preferences` exposes separate message, mention, assignment, reminder, email, and Web Push controls. Push is at-least-once and includes stable `notificationId` for client deduplication.
- Local development PATs are created/revoked under `/v1/pats`. The stdio MCP exposes ten read-only tools with PAT scope, membership filtering, citations, revocation, and audits. Hosted access must replace PATs with OAuth.
