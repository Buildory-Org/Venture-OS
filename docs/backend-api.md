# Backend API and contract seams

All product routes use `/v1`, return `{ ok: true, data }`, and use the shared safe error envelope on failure. Dates are ISO 8601 strings at the HTTP boundary and IDs are stable opaque strings.

Cursor-paginated lists return `{ ok: true, data: { items, nextCursor? } }`; other purpose-built read models use their exported shared schemas. The contracts package exports `sessionBootstrapResponseSchema`, `dashboardResponseSchema`, and the generic `pagedSuccessEnvelope` helper.

## Identity and hierarchy

- Better Auth is mounted at `/api/auth/*`; magic-link email uses Resend when configured and a labelled local logger otherwise.
- `POST /v1/invitations/accept` attaches an authenticated Better Auth user to the app-owned membership from an admin invitation.
- `GET /v1/session/bootstrap`, `GET /v1/hierarchy`, `GET /v1/dashboard` return the current user, role, authorized hierarchy, and canonical Today read model.
- Admin routes create invitations, ventures, groups with an ordinary `#general` channel, and list memberships.

## Collaboration and work

- Channel messages: `GET|POST /v1/channels/:channelId/messages`; direct messages: `GET /v1/direct-messages/:userId`, `POST /v1/direct-messages`.
- Socket.IO authorizes the initial connection and every `channel:join`; it emits channel-scoped presence, and `message:create` persists the message/event/outbox before emitting. Message history uses a total `(createdAt, id)` cursor order and `clientId` retries return the canonical prior result.
- Tasks: `GET|POST /v1/tasks`, `GET|PATCH /v1/tasks/:id`, comments, evidence submission/review, saved task filters, and outcome routes.
- Focus: `POST /v1/focus`, `GET /v1/focus/current`, `POST /v1/focus/:id/complete`.
- Commands: `POST /v1/commands/preview`, then `POST /v1/commands/execute` with an idempotency key.
- Reminders: `POST /v1/reminders/:id/snooze` accepts `10`, `20`, `30`, or `never`.

## Knowledge, operating records, and search

- Versioned Markdown: `POST /v1/documents`, `GET|PUT /v1/documents/:id`, and metadata approval at `PATCH /v1/documents/:id/metadata`.
- Authorized cited retrieval: `GET /v1/knowledge/search`; bounded export: `GET /v1/context-packets/tasks/:id`.
- Cross-resource authorized search: `GET /v1/search` for tasks, messages, and ready file metadata.
- Decisions, classes/applied assignments, information requests, outcomes/timeline records, pipelines, and opportunities use their named `/v1` route groups.

## Files, notifications, and MCP

- `POST /v1/uploads` creates constrained metadata and a short-lived upload URL, optionally linked to a same-scope task; recoverable completion rechecks metadata and promotes staging through `pending -> finalizing -> ready`; `GET /v1/files/:id/download` authorizes metadata before signing.
- Local object URLs are HMAC-signed and operation-scoped. Production uses Cloudflare R2 credentials and refuses the local adapter.
- Notification preferences include separate message, mention, assignment, reminder, email, and Web Push controls. Push is at-least-once and includes stable `notificationId` for client deduplication.
- Local development PATs are created/revoked under `/v1/pats`. The stdio MCP exposes ten read-only tools with PAT scope, membership filtering, citations, revocation, and audits. Hosted access must replace PATs with OAuth.
