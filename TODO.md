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
- [x] Move connected DMs and channels to independent full-viewport, three-pane messenger routes
- [x] Add visible admin controls for venture, group, and channel creation in connected Channels
- [x] Fix scoped Channels creation dialogs to inherit the clicked venture/group without a redundant selector; verify both dialogs in-browser and created scope in the isolated Mongo API test
- [x] Show deterministic DiceBear Adventurer avatars for connected workspace users
- [x] Smoke-check desktop and 390px chat layouts, admin create dialog, API-backed data, lint, and production build
- [ ] Decide whether non-admin members or venture heads may create ventures, groups, or channels; update server permissions and reviewer tests only after policy approval
- [x] Replace the flattened connected Channels list with a venture selector, expandable group rail, and selected-group-only channel list; verify desktop and 390px/320px navigation, deep links, and keyboard focus
- [x] Dock Channels details beside chat and open a group-scoped Kanban/Attachments/Saved workspace sheet; verify paged feeds, authorized status moves, image preview and invalid-media fallback, desktop/320px layout, scope switching, and Escape/focus return in an isolated browser fixture
- [ ] Verify a browser-originated channel message in an isolated UI fixture; the Mongo-backed API smoke test covers a real send, but the current browser points to shared seed data

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
- [x] Verify a separate connected dashboard preview against session, dashboard, and paged task contracts
- [x] Verify connected sign-in request, invitation acceptance path, task/board, channel/command preview, inbox, and focus UI slices against the local API and Mongo tests
- [x] Verify connected knowledge search and planning reads for outcomes, decisions, classes, and information requests against the local API
- [x] Verify planning, sales, and admin connected controls in the browser, and channel action contracts in the Mongo-backed API smoke suite
- [x] Connect authorized member discovery to task assignment, board filtering, channel mentions, DM recipients, and class reviewers; inspect the pickers in the browser
- [x] Connect reminder IDs and preferences, focus history, document browse/edit, class applications/review, and DM history/send to the published contracts; verify the new reads in the browser and mutations in Mongo-backed API tests
- [x] Verify same-origin Socket.IO polling in the browser by receiving another local member's channel message without reloading
- [x] Connect signed file upload/completion, authorized file-name search/download preparation, and task-scoped attachments; verify a synthetic local browser upload and downloaded bytes by SHA-256
- [x] Verify scoped venture-head document approval in the browser on a synthetic local record
- [x] Make the connected workspace the default at `/` and `/dashboard`, route the main navigation to API-backed pages, and isolate the sample-only prototype under `/demo`; verify desktop/mobile navigation and keyboard behavior
- [ ] Verify physical browser save/download in a browser that exposes a download event or saved file
- [ ] Repair and verify admin document list/detail scope for venture and workspace records in the backend
- [ ] Verify browser Socket.IO with a real Better Auth cookie and staging reverse-proxy/sticky-session configuration
- [ ] Integrate shared contracts when the backend publishes them

### 2.4 Verification

- [x] Route-level UI smoke tests
- [x] Responsive pass at 390px and 320px for all studio routes
- [x] Connected keyboard pass: named controls, tab order across core routes, and task drawer focus trap, Escape, and focus return
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
- [x] UX-parity API slice: additional channels, membership role/scope replacement, message reactions/pins/saves, and planning/sales edits
- [x] Independent auth/realtime review of the UX-parity slice and real-Mongo backend smoke verification
- [x] Reviewed backend contract slice: member directory, browser socket authentication, reminder IDs and reads, focus history, document browse, and class application review; real-Mongo smoke verification
- [x] Backfill legacy handles without overwriting existing values; verify seeded @commands and mentions with real Mongo and independent authorization review
- [x] Support safe positional command timing aliases while preserving named syntax, preview/execute idempotency, and real-Mongo verification

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
- [x] Add authorized, paginated group file and saved-message feeds with cross-group/cross-workspace Mongo smoke checks
- [ ] Validate uploaded media contents and playback for image/video/audio previews; the current allowlist checks declared MIME type and size only
- [x] Search/indexing across authorized messages, tasks, and documents
- [x] Repair missing/legacy-null workspace document scope and admin all-venture visibility across REST and MCP; verify role/sensitivity boundaries in real Mongo and independent review
- [x] Omit absent document version source URLs on write and normalize legacy null URLs on read; verify POST/GET/PUT contracts with real Mongo
- [x] Read-only MCP server with scoped local PATs, revocation, and audit logs
- [x] Threat-model and reviewer-agent pass for file and MCP data boundaries
- [x] Integration smoke tests

## Phase 6 — Production hardening

- [ ] Observability dashboards and alerts
- [ ] Backup/restore and disaster-recovery rehearsal
- [ ] Security, accessibility, performance, and dependency audits
- [ ] Cross-browser and critical-path end-to-end test suite
- [ ] Staging sign-off and release checklist

