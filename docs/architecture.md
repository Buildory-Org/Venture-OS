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
- JEV may be used for research, but is not a V1 runtime dependency

## Reliability and security invariants

- Server authorization is checked on every resource operation and realtime subscription.
- Commands are parsed into a typed preview before execution and leave an audit trail.
- Reminder/escalation jobs are durable, idempotent, retryable, and timezone-aware.
- Notification delivery uses an outbox boundary so state changes and fan-out cannot silently diverge.
- File access uses short-lived signed URLs after application authorization.
- MCP tools never bypass the same membership and permission checks used by the product APIs.

