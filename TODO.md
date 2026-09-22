# Venture Studio OS delivery plan

Checkboxes are updated only after implementation and verification. Approval gates remain unchecked until the user explicitly approves them.

## Phase 0 — Foundation

- [x] Confirm product hierarchy: Workspace -> Ventures -> Groups -> Channels
- [x] Record the agreed architecture and security boundaries
- [x] Create the npm/TypeScript monorepo skeleton
- [x] Seed `apps/web` from the approved AIBOS UI reference
- [x] Install and verify the Ponytail backend skill
- [ ] Create persistent Frontend and Backend Codex tasks in the Venture Studio project

## Phase 1 — Dashboard design prototype (current)

### 1.1 Shell and visual system

- [ ] Repurpose the AIBOS shell, typography, spacing, icons, surfaces, and interaction patterns
- [ ] Add Venture Studio navigation and venture/group context
- [ ] Make the dashboard responsive at desktop, tablet, and mobile widths

### 1.2 Dashboard content

- [ ] Build a high-fidelity home/dashboard page using realistic dummy data
- [ ] Show assigned work, urgency/deadline signals, venture health, mentions, and recent activity
- [ ] Expose clear entry points for focus mode, chat/channels, and the Kanban board
- [ ] Cover empty/loading/error-like presentation states where useful for approval

### 1.3 Verification and approval

- [ ] Run lint and production build smoke tests
- [ ] Perform a visual pass for overflow, accessibility, and responsive behavior
- [ ] Present the dashboard to the user
- [ ] **Approval gate: user approves the dashboard direction**

## Phase 2 — Complete dummy product UI

_Blocked by the Phase 1 approval gate._

### 2.1 Collaboration

- [ ] Venture/group/channel navigation and channel chat
- [ ] `@mentions`, threads, reactions, pins, saved items, and search
- [ ] Direct messages and notification center

### 2.2 Work management

- [ ] Task detail and assignment flows
- [ ] Kanban board with people, tag, venture, group, status, and deadline filters
- [ ] Focus-mode timer popup and session history
- [ ] Reminder/snooze/completion interaction states

### 2.3 Admin and knowledge

- [ ] Group/venture creation and member/role management
- [ ] Slash-command composer and admin command feedback
- [ ] Files, links, notes, and lightweight knowledge search
- [ ] Settings, notification preferences, and integration surfaces

### 2.4 Verification

- [ ] Route-level UI smoke tests
- [ ] Responsive and keyboard-accessibility pass
- [ ] User approval of the complete dummy UI

## Phase 3 — Backend foundation

- [ ] Define shared Zod contracts and error/event envelopes
- [ ] Implement Better Auth identity/session flows and magic-link delivery
- [ ] Implement app-owned workspace, venture, group, channel, role, and membership authorization
- [ ] Add MongoDB models, indexes, migrations/backfills, and seed data
- [ ] Add API request validation, structured logging, audit records, and rate limits
- [ ] Independent reviewer-agent approval for auth and permission boundaries
- [ ] Backend unit/integration smoke tests

## Phase 4 — Realtime work, commands, and automation

- [ ] Socket.IO channel messaging, presence, mentions, and notification fan-out
- [ ] Task lifecycle, comments, attachments, Kanban views, and saved filters
- [ ] `/assign` and `/notify` parsing with permissions, previews, and auditability
- [ ] Durable reminder worker with outbox, retries, idempotency, and escalation rules
- [ ] Focus sessions and timer recovery across refresh/reconnect
- [ ] Web Push and email notification channels with per-user preferences
- [ ] Independent reviewer-agent approval for realtime and scheduling paths
- [ ] End-to-end smoke tests for assignment, reminders, snooze, and completion

## Phase 5 — Files, knowledge, and MCP

- [ ] R2 upload flow with signed URLs, metadata, authorization, and lifecycle rules
- [ ] Search/indexing across authorized messages, tasks, and documents
- [ ] Read-only MCP server with scoped local PATs, revocation, and audit logs
- [ ] Threat-model and reviewer-agent pass for file and MCP data boundaries
- [ ] Integration smoke tests

## Phase 6 — Production hardening

- [ ] Observability dashboards and alerts
- [ ] Backup/restore and disaster-recovery rehearsal
- [ ] Security, accessibility, performance, and dependency audits
- [ ] Cross-browser and critical-path end-to-end test suite
- [ ] Staging sign-off and release checklist

