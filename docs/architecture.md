# Architecture and product decisions

## Product hierarchy

- A workspace contains ventures.
- A venture contains groups.
- A group contains channels and starts with a `#general` channel.
- Group membership is a subset of venture membership.
- In V1, channels inherit group membership; private channel membership can be added later.
- Direct messages are workspace-wide and are not nested under a venture.

## Planned technical shape

- npm TypeScript monorepo
- `apps/web`: Next.js and React
- `apps/api`: Express HTTP API and Socket.IO gateway
- `apps/worker`: durable reminders, escalation, and notification jobs
- MongoDB is the application source of truth
- Better Auth provides identity/session and magic-link primitives; application memberships and permissions remain app-owned
- Cloudflare R2 stores uploaded objects; MongoDB stores their metadata and authorization links
- Resend and Web Push deliver outbound notifications
- MCP begins read-only, authenticated with revocable scoped local PATs
- Hosted MCP authentication must use OAuth; local PATs are restricted to local development
  - Amended 2026-10-08 (owner-approved plan in `docs/mcp.md`): hosted MCP at `/mcp` phase 1 accepts personal access tokens for Claude Code. Tokens are hashed, scoped, expire within 366 days, bind to the owner's membership, are revocable immediately, and are revoked when the membership is renewed. Tools reach data only through the product API as the token's owner, and narrow, audited writes are allowed. OAuth 2.1 remains required for claude.ai and Claude Desktop connectors in phase 2.
- JEV may be used for research, but is not a V1 runtime dependency

## Recorded implementation decisions

- MongoDB transactions are mandatory for mutation fan-out; local development therefore uses the dedicated `ventureStudio` replica set on port `27018` and does not alter the user's default MongoDB instance.
- Browser clients should use the web application's same-origin proxy for `/v1` and Socket.IO. `API_ORIGIN` names the Express origin and `APP_ORIGIN` is the trusted web origin used by Better Auth and realtime CORS.
- Upload intents write to a staging object. Completion copies to the immutable final key and deletes staging so a still-valid upload URL cannot overwrite a ready file.
- Event replay is ordered by `(occurredAt, eventId)` and the cursor itself must still be visible to the caller.
- One active app membership per user is enforced until a workspace-selection flow is deliberately designed.
- The sidebar's active venture is a per-user, per-workspace browser preference for navigation and default page scope; "All ventures" combines only records the API already authorizes. It never grants access or replaces server-side venture/group authorization. Create actions in a selected venture inherit that destination; the All view requires an explicit destination.
- First-admin setup is a one-time, email-verified claim restricted to `BOOTSTRAP_ADMIN_EMAIL`. It uses a real Better Auth session (never local development identity), a MongoDB transaction, and a durable singleton claim. The sanitized `example.invalid` seed admin does not close this setup path; an actual admin does. After claim, `/signup` is unavailable and later members join by invitation.
- Group membership changes require transactions and are additive/idempotent within the active workspace. Adding a group grants its parent venture only if absent and records that inherited grant; removing the last group in that venture revokes only the inherited grant, never an explicit venture assignment.
- R2 development and production use separate private buckets and bucket-scoped credentials. `FILE_STORAGE=r2` must be explicit, and incomplete R2 configuration fails startup rather than falling back to local uploads.
- Invitation email and in-app reminder delivery are distinct: an invitation targets an email address before membership, while the reminder worker writes the signed-in member's in-app notification through the outbox.
- A Web Push endpoint belongs to one browser subscription, not one account. Re-registration transfers its owner; historically duplicated endpoints are retired without guessing an owner. API and worker accept only HTTPS endpoints from supported browser push providers, and the worker rechecks ownership before delivery. A push already in flight cannot be recalled, so shared-device sign-out should also unsubscribe where possible.
- In V1, `/assign` and `/notify` are manager shortcuts limited to workspace admins and scoped venture heads. Contributors may still create tasks through the ordinary task form/API; a distinct per-group manager role and whether it should own all delegation require a later product decision.
- Channel notifications are mentions-only (decided 2026-10-04): a channel message notifies only validated `@mentions`, never every group member, so inboxes and browser push stay quiet. DMs always notify. Admins are in scope for every channel for mentions, delivery, and visibility.
- The sample-data prototype under `/demo` is a development aid (decided 2026-10-04): production builds redirect `/demo` to the connected dashboard and hide demo links unless `NEXT_PUBLIC_ENABLE_DEMO=true` is set at build time.

## Reliability and security invariants

- Server authorization is checked on every resource operation and realtime subscription.
- Commands are parsed into a typed preview before execution and leave an audit trail.
- Reminder/escalation jobs are durable, idempotent, retryable, and timezone-aware.
- Notification delivery uses an outbox boundary so state changes and fan-out cannot silently diverge.
- File access uses short-lived signed URLs after application authorization.
- MCP tools never bypass the same membership and permission checks used by the product APIs.

