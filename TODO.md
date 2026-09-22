# Venture Studio OS delivery plan

Checkboxes are updated only after implementation and verification. Approval gates remain unchecked until the user explicitly approves them.

## Phase 0 — Foundation

- [x] Confirm product hierarchy: Workspace -> Ventures -> Groups -> Channels
- [x] Record the agreed architecture and security boundaries
- [x] Create the npm/TypeScript monorepo skeleton
- [x] Seed `apps/web` from the approved AIBOS UI reference
- [x] Install and verify the Ponytail backend skill
- [x] Create persistent Frontend and Backend Codex tasks in the Venture Studio project

## Phase 1 — Dashboard design prototype (approved)

### 1.1 Shell and visual system

- [x] Repurpose the AIBOS shell, typography, spacing, icons, surfaces, and interaction patterns
- [x] Add Venture Studio navigation and venture/group context
- [x] Make the dashboard responsive at desktop, tablet, and mobile widths

### 1.2 Dashboard content

- [x] Build a high-fidelity home/dashboard page using realistic dummy data
- [x] Show assigned work, urgency/deadline signals, venture health, mentions, and recent activity
- [x] Expose clear entry points for focus mode, chat/channels, and the Kanban board
- [x] Cover empty/loading/error-like presentation states where useful for approval

### 1.3 Verification and approval

- [x] Run lint and production build smoke tests
- [x] Perform a visual pass for overflow, accessibility, and responsive behavior
- [x] Present the dashboard to the user
- [x] **Approval gate: user approved the dashboard direction on 2026-09-23**

## Phase 2 — Complete dummy product UI

Approved on 2026-09-23. The full interface is being built against shared demo records; backend integration is tracked by contract seams and remains a separate verification gate.

### 2.0 Studio command center

- [x] Today, venture overview, 30-day outcomes, and weekly timeline
- [x] Decisions register and structured questions/information requests
- [x] Classes with objectives, applied assignments, and assessment evidence
- [x] Venture-specific sales pipeline

### 2.1 Collaboration

- [x] Venture/group/channel navigation and channel chat
- [x] `@mentions`, threads, reactions, pins, saved items, and search
- [x] Direct messages and notification center

### 2.2 Work management

- [x] Task detail and assignment flows
- [x] Kanban board with people, tag, venture, group, status, and deadline filters
- [x] Focus-mode timer popup and session history
- [x] Reminder/snooze/completion interaction states

### 2.3 Admin and knowledge

- [x] Group/venture creation and member/role management in the demo UI
- [x] Slash-command composer and admin command feedback
- [ ] Files, links, notes, and lightweight knowledge search
- [x] Settings, notification preferences, and integration surfaces in the demo UI
- [x] Sign-in/invite demo surfaces and founder admin audit/PAT surfaces
- [x] Document UI-to-backend contract seams
- [ ] Integrate shared contracts when the backend publishes them

### 2.4 Verification

- [x] Route-level UI smoke tests
- [x] Responsive pass at 390px and 320px for all studio routes
- [ ] Keyboard-accessibility pass
- [ ] User approval of the complete dummy UI

## Phase 3 — Backend foundation

- [x] Define shared Zod contracts and error/event envelopes
- [x] Implement Better Auth identity/session flows and magic-link delivery
- [x] Implement app-owned workspace, venture, group, channel, role, and membership authorization
- [x] Add MongoDB models, indexes, migrations/backfills, and seed data
- [x] Add API request validation, structured logging, audit records, and rate limits
- [x] Independent reviewer-agent approval for auth and permission boundaries
- [x] Backend unit/integration smoke tests

## Phase 4 — Realtime work, commands, and automation

- [x] Socket.IO channel messaging, presence, mentions, and notification fan-out
- [x] Task lifecycle, comments, attachments, Kanban views, and saved filters
- [x] `/assign` and `/notify` parsing with permissions, previews, and auditability
- [x] Durable reminder worker with outbox, retries, idempotency, and escalation rules
- [x] Focus sessions and timer recovery across refresh/reconnect
- [x] Web Push and email notification channels with per-user preferences
- [x] Independent reviewer-agent approval for realtime and scheduling paths
- [x] End-to-end smoke tests for assignment, reminders, snooze, and completion

## Phase 5 — Files, knowledge, and MCP

- [ ] R2 upload flow with signed URLs, metadata, authorization, and lifecycle rules
- [x] Search/indexing across authorized messages, tasks, and documents
- [x] Read-only MCP server with scoped local PATs, revocation, and audit logs
- [x] Threat-model and reviewer-agent pass for file and MCP data boundaries
- [x] Integration smoke tests

## Phase 6 — Production hardening

- [ ] Observability dashboards and alerts
- [ ] Backup/restore and disaster-recovery rehearsal
- [ ] Security, accessibility, performance, and dependency audits
- [ ] Cross-browser and critical-path end-to-end test suite
- [ ] Staging sign-off and release checklist

