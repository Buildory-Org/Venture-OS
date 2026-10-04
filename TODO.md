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

### 2.0a Demo-to-connected UI parity correction

- [x] Reuse the demo shell for connected routes and populate its workspace, venture, task, member, and notification context from the API; verify the connected dashboard in the local authenticated browser fixture.
- [x] Reuse the demo dashboard, Today, and Ventures presentations for connected data, with an API-backed venture creation entry point; verify routes, People tab, scoped creation drawer, and New task navigation in-browser. Venture creation was not submitted in this visual pass.
- [x] Give connected Decisions, Classes, Timeline, and Requests distinct routes and active sidebar states; verify Decisions read in-browser.
- [x] Align connected Sales with the demo venture tabs and stage board while retaining API-backed creation and status controls; verify the board and Add record drawer in-browser.
- [x] Align connected Tasks search/filter row and named assignees, and group the connected Kanban board into the demo's six visual stages while preserving exact backend statuses on cards; verify live reads and task search in-browser.
- [x] Align connected People & access Members/Structure tabs and show real member names rather than IDs; verify both tabs with API-backed data in-browser.
- [x] Preserve venture and document context when navigating from the connected Ventures tabs into Sales and Knowledge; verify selected venture and exact document drawer in-browser.
- [x] Bring connected Knowledge records into a demo-like list/detail layout, keep the authorized full-record drawer and evidence search, and verify record selection plus direct document links in the isolated API-backed browser fixture.
- [x] Bring connected Decisions and Classes into demo-like list/detail layouts, add workspace-level creation entry points with destination selection, and verify a synthetic decision create/reload in a separate seeded smoke database. Browser inspection confirmed a venture-scoped destination after selection; signed-in production creation remains unverified.
- [x] Bring connected Questions & requests into a searchable list/detail layout with named requester/respondent labels from the authorized member directory; verify selection and search/empty/restore in the isolated API-backed browser fixture. Answer submission remains unverified in a real signed-in session.
- [x] Browser-smoke a connected Ready-to-In-progress drag, verify it persists after reload, then restore the tested task to its original Accepted status and verify that persists after reload.
- [ ] Browser-smoke the remaining connected board drop targets and task-status transition rules.
- [ ] Complete visual and interaction parity for connected Knowledge, Planning detail views, remaining People & access tabs, and remaining task/board details; test all real mutations without relying on demo-local state.
- [ ] Verify signed-in production UI with a real account/session on port 3011, including create/edit/reload flows. The isolated development preview uses `x-dev-user-id` and does not prove the real auth flow.

### 2.1 Collaboration

- [x] Venture/group/channel navigation and channel chat
- [x] `@mentions`, threads, reactions, pins, saved items, and search
- [x] Direct messages and notification center
- [x] Move connected DMs and channels to independent full-viewport, three-pane messenger routes
- [x] Keep Channels and Messages in the shared workspace shell: slide the chrome away on sidebar entry, omit the shared top header throughout chat, and animate the sidebar plus chat-area resize on double Escape. Verify both connected chat routes, intermediate sidebar widths, header absence, and web lint/build in the local preview.
- [x] Start chat navigation immediately and wait for the destination screen to render before sliding the sidebar away; verify Channels and Messages in the connected browser preview, the demo loading fallback, double-Escape resize, and web lint/build.
- [x] Animate newly arriving channel and DM bubbles, align avatars with bubbles, use a keyboard/right-click/hold channel action menu and paper-plane send icon, and add active-chat sound cues. Verify the live browser layout/menu, web lint/build, worker push tests, Mongo notification authorization tests, and independent backend review. Closed-tab VAPID delivery remains tracked below.
- [x] Let the chat-nav icon toggle the workspace sidebar, remove the channel-list search and idle file strip, add group message/file search in the channel header, tighten header actions, and provide inline group @mentions plus an attachment-type menu. Verify connected Channels and Messages navigation, modal/menu keyboard behavior, mid-message mention insertion, web lint/build, API typecheck, real-Mongo search isolation/overflow tests, and independent backend review.
- [x] Slide the connected Channels group-details panel while it resizes chat, enter the group workspace sheet from fully below the viewport, fit its tabs to content, and float the composer within chat without covering command preview. Remove avatar-credit copy from Group Details while preserving app attribution. Verify the live browser layout, panel transition geometry, sheet/tab sizing, command preview and cancellation, console, web lint, and production build.
- [x] Slow the group workspace sheet to a fast-start/ease-out entrance without moving chat or Group Details, distinguish its tab bar, and read active-venture knowledge in a fourth tab. Verify settled and opening geometry, venture switching, record detail, browser errors, web lint, and production build.
- [x] Replace connected and demo Knowledge list/side-preview layouts with document-thumbnail grids and full-width readers; keep the group-sheet reader scoped to its active venture. Verify tile open/back, direct document links, packet mode, search/files tabs, demo parity, web lint, and production build.
- [x] Unify connected and demo Knowledge browsing into a record/file library, add distinct Markdown and file upload dialogs with multi-file queues and per-file status/progress, and display supplied Markdown/PDF artwork plus type/fallback file icons. Verify connected and demo dialog/layout states in-browser, authorized file-list API tests, web lint/typecheck/build, and API typecheck/tests.
- [x] Keep the custom venture menu inside the native Knowledge upload dialog's top layer and center the file picker; verify all three ventures display, venture selection, Escape behavior, browser layout, and web lint/typecheck/build.
- [x] Animate the Ventures submenu, add a persistent sidebar venture/All scope across connected Dashboard, Today, Tasks, Board, Knowledge, Planning, Sales, and Channels, remove redundant page venture filters, merge Markdown into Upload file, open Knowledge files in a full-area reader, and use switches for settings booleans. Verify Buildory/All data changes, scoped upload destination, text reader, accessible switches, web lint/build, and diff check. PDF rendering and a real upload still need separate browser checks.
- [x] Keep New pipeline visible for authorized managers in All ventures, require an explicit venture destination there, and show a read-only destination in a selected venture. Verify both browser entry states and destination choices, isolated API parent IDs and resulting scope, web lint/build, and API tests without adding a test pipeline to live user data.
- [x] Add an admin-only "New venture" entry to the sidebar venture-scope menu that opens a shared Create venture drawer (also used by the Ventures page), navigates to the new venture, and hands the sidebar scope to it once the shell reloads. Verify keyboard and mouse entry, Escape with focus returning to the opener (also fixed for the Ventures page), creation from a selected-venture scope, the entry hidden for a venture head, web lint/typecheck, and production build in an isolated test workspace.
- [x] Give connected Knowledge files and Markdown records the same edge-to-edge reader with a full-width header flush to the content top; retain record details/actions. Verify the Buildory Markdown tile, TXT tile, Back control, details drawer, web lint, and production build in the preview.
- [x] Show authorized, size-bounded image thumbnails in connected Knowledge tiles, load them only near the viewport and release off-screen image URLs, and remove the extra blank row below short filenames. Verify the existing WEBP tile in-browser, API authorization and failure cases, lint, typecheck, build, tests, and independent backend review.
- [x] Render connected Knowledge records and uploaded `.md`/`.markdown` files with shared Markdown/GFM formatting and a Rendered/Raw reader control. Verify a Buildory record in both modes in the browser, and pass web lint, typecheck, and production build; the uploaded-Markdown branch is compile-checked but still needs a live file fixture.
- [x] Add permission-aware Edit icons to connected Knowledge records and a full-page Markdown/plain-text editor with Write/Split/Preview modes, formatting tools, change summary, versioned draft save, and an in-app unsaved-edits confirmation. Verify tile and reader navigation, heading formatting, both discard choices, targeted lint, and web build in the local preview; an actual save/reload still needs a disposable document fixture.
- [ ] Browser-test editor save/reload using a disposable Knowledge record; do not alter an existing user record for testing.
- [ ] Scope Word `.doc`/`.docx` editing separately with a formatting-preserving editor/conversion path; do not offer plain-text editing for Word files.
- [ ] Browser-test an uploaded Markdown file in both Rendered and Raw modes, including a reload, using a disposable fixture rather than a private user file.
- [ ] Browser-test an actual connected Knowledge file upload against the configured object store, including progress, reload, and preview; do not use private user files as test fixtures.
- [x] Fix the development R2 bucket's browser-upload CORS for the active `localhost:3012` preview while preserving `localhost:3011`, `PUT/GET/HEAD`, `Content-Type`, and exposed `ETag`; verify the previously denied signed-upload preflight now returns 204 for both origins. Do not change the production bucket.
- [ ] Add pagination to group message/file search; the current modal returns the first 50 combined matches.
- [x] Add visible admin controls for venture, group, and channel creation in connected Channels
- [x] Fix scoped Channels creation dialogs to inherit the clicked venture/group without a redundant selector; verify both dialogs in-browser and created scope in the isolated Mongo API test
- [x] Show deterministic DiceBear Adventurer avatars for connected workspace users
- [x] Smoke-check desktop and 390px chat layouts, admin create dialog, API-backed data, lint, and production build
- [ ] Decide whether non-admin members or venture heads may create ventures, groups, or channels; update server permissions and reviewer tests only after policy approval
- [x] Replace the flattened connected Channels list with a venture selector, expandable group rail, and selected-group-only channel list; verify desktop and 390px/320px navigation, deep links, and keyboard focus
- [x] Dock Channels details beside chat and open a group-scoped Kanban/Attachments/Saved workspace sheet; verify paged feeds, authorized status moves, image preview and invalid-media fallback, desktop/320px layout, scope switching, and Escape/focus return in an isolated browser fixture
- [x] Add admin-only group People controls in connected Channels: named roster, fixed-scope existing-member search/add and precise group removal, with invite-by-email manual-link fallback; verify submitted group IDs, resulting roster, Escape/focus, and desktop/390px/320px layout in an isolated fixture
- [x] Polish invitation/link delivery copy, replace web interface icons with Hugeicons, and add restrained contextual motion; verify web lint/build, connected link-only invite and clipboard flow, group sheet, reduced-motion styles, and full-viewport mobile invitation dialog
- [x] Unify light/dark surfaces around grayscale and emerald, add shell-preserving route motion and sliding active-tab indicators, and persist theme preference; verify lint/build plus production-browser tab, route, theme-reload, and console smoke checks on localhost:3011
- [x] Shift the primary accent to a lighter, contrast-safe money green; reduce small-label/body weight while preserving heading emphasis; stage page sections, dashboard cards, and task rows on route navigation. Verify web lint/build, light/dark screenshots, keyboard navigation, and settled browser routes with no console errors.
- [x] Remove redundant page-level eyebrow and crumb labels from shared headers and dashboard headings, keeping the actual page titles and useful descriptions. Verify web lint/build and production-browser Today, Timeline, Requests, and demo Dashboard; connected visual verification remains auth-gated.
- [x] Move venture links into the Ventures sidebar submenu, fit venture tabs to their labels, and show the 30-day goal only on Overview; verify submenu switching resets Overview in the production browser.
- [x] Replace single-choice native dropdown menus with the shared styled combobox, including keyboard navigation; verify mouse/keyboard filtering in the production browser, plus web lint/build. The participant multi-select remains a listbox, not a dropdown.
- [x] Add drag-and-drop status moves to demo, connected, and group Kanban boards, with visible drop targets and a keyboard/touch Move menu; verify demo drag, reload persistence, and restoration in the production browser, plus web lint/build. Connected boards remain authentication-gated for browser smoke.
- [ ] Verify real invitation email delivery and the email-sent response UI after configuring a verified Resend sender; the user approved Resend for invitations on 2026-09-23, but development currently returns a manual link
- [x] Verify a browser-originated channel message in an isolated UI fixture; send and reload passed against the 2026-09-23 local MongoDB preview
- [ ] Connect active-group member discovery, additive Add people/Remove access, and real invitation issuance/acceptance; verify parent scope, delivery mode, authorization, and browser flow
- [ ] Attach uploaded files to channel and DM messages; verify send, receive, reload, previews, authorization, and group media discovery
  - [x] Browser-select synthetic text files, send in channel and DM, reload both conversations, find the file in group Attachments, and verify exact download bytes plus unrelated-user denial in the isolated local-storage preview
  - [ ] Verify image/video/audio previews and repeat the browser flow against private Cloudflare R2 storage

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
- [ ] Add first-admin email-verified signup with a one-time claim and close `/signup` afterward; independently review auth and verify API/browser flow
- [x] Verify connected knowledge search and planning reads for outcomes, decisions, classes, and information requests against the local API
- [x] Verify planning, sales, and admin connected controls in the browser, and channel action contracts in the Mongo-backed API smoke suite
- [x] Connect authorized member discovery to task assignment, board filtering, channel mentions, DM recipients, and class reviewers; inspect the pickers in the browser
- [x] Connect reminder IDs and preferences, focus history, document browse/edit, class applications/review, and DM history/send to the published contracts; verify the new reads in the browser and mutations in Mongo-backed API tests
- [x] Verify same-origin Socket.IO polling in the browser by receiving another local member's channel message without reloading
- [x] Connect signed file upload/completion, authorized file-name search/download preparation, and task-scoped attachments; verify a synthetic local browser upload and downloaded bytes by SHA-256
- [x] Verify scoped venture-head document approval in the browser on a synthetic local record
- [x] Add connected Knowledge draft creation/Markdown import and venture/workspace destinations, plus scoped Planning creation for outcomes, decisions, classes, and information requests; verify browser create/reload, resulting IDs and scopes, denied roles, validation error, and desktop/390px/320px layouts in the isolated local fixture
- [x] Make the connected workspace the default at `/` and `/dashboard`, route the main navigation to API-backed pages, and isolate the sample-only prototype under `/demo`; verify desktop/mobile navigation and keyboard behavior
- [ ] Verify physical browser save/download in a browser that exposes a download event or saved file
- [x] Repair and verify admin document list/detail scope for venture and workspace records in the backend (real-Mongo scope tests)
- [ ] Verify browser Socket.IO with a real Better Auth cookie and staging reverse-proxy/sticky-session configuration
- [ ] Integrate shared contracts when the backend publishes them
- [x] Fix verified defects without changing intended flows: store create-route dates as BSON dates (plus idempotent migration `003-string-dates`) so context packets and date queries work; validate evidence URIs as http(s) and stop persisting absent evidence URIs and opportunity next-action dates as null (which broke task detail and the whole Sales screen); add opt-in newest-first channel paging so channels over 100 messages open on the latest page and Load older prepends with the reading position kept; start cursor-less event replay at the newest window; map malformed/oversized bodies to 400/413 and unhandled duplicate keys to 409; scope MCP venture status outcomes/decisions to the workspace; refresh the shell sidebar after Channels creates a venture, group, or channel without snapping back to the previous scope; keep demo stub redirects inside `/demo`; make the muted-DM worker test exercise the preference path. Verified contracts/core build, API/worker typecheck, core 4/4, API 6/6 and worker 3/3 against a real replica set, web lint and production build, an isolated seeded browser smoke (paging, live arrival, scope handoff in selected and All scope, demo redirects, evidence submit/reload/review, Sales list), and independent backend review.

### 2.4 Verification

- [x] Route-level UI smoke tests
- [x] Responsive pass at 390px and 320px for all studio routes
- [x] Connected keyboard pass: named controls, tab order across core routes, and task drawer focus trap, Escape, and focus return
- [ ] Keyboard-accessibility pass
- [ ] User approval of the complete dummy UI

## Phase 3 — Backend foundation

- [x] Define shared Zod contracts and error/event envelopes
- [x] Implement Better Auth identity/session flows and magic-link delivery adapter
- [ ] Verify real magic-link and invitation email delivery with a configured sender and Resend account; user approved Resend invitation delivery on 2026-09-23
- [x] Implement app-owned workspace, venture, group, channel, role, and membership authorization
- [x] Add MongoDB models, indexes, migrations/backfills, and seed data
- [x] Add API request validation, structured logging, audit records, and rate limits
- [x] Fix the local 429 regression: avoid route-change shell refetches, separate authenticated read/write buckets (300/120 per actor per minute), keep anonymous and invitation ingress limits, and return Retry-After; verify real-Mongo API tests, web lint/build, independent review, and a connected browser route smoke on ports 3012/4010.
- [ ] Harden production auth ingress against abusive unauthenticated traffic with a verified proxy/IP strategy; generic anonymous requests currently resolve session identity before their limit, and `/api/auth/*` depends on Better Auth production-mode limiting.
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
- [ ] Complete Web Push browser subscription and credentialed delivery checks; worker adapters and server-side preferences exist, but closed-tab push is not yet verified
- [x] Show a connected in-app unread bell and new-notification banner with visible-tab polling, no first-load or duplicate toast, inbox refresh, and reminder snooze/open actions; verify desktop/390px/320px behavior in an isolated browser fixture
- [ ] Add browser permission/subscription UX for push outside an open tab; in-app polling does not deliver closed-tab alerts
  - [x] Add user-initiated browser controls and safe notification-click routing to the authenticated inbox; verify the unavailable state, worker routing tests, and web lint/build. Push text is generic to protect shared-browser account switches. Live VAPID subscribe/unsubscribe remains unverified.
- [x] Independent reviewer-agent approval for realtime and scheduling paths
- [x] End-to-end smoke tests for assignment, reminders, snooze, and completion

## Phase 5 — Files, knowledge, and MCP

- [ ] R2 upload flow with signed URLs, metadata, authorization, and lifecycle rules
- [ ] Configure separate private R2 development/production buckets with scoped keys; verify real browser upload/download and no local fallback when R2 is selected. On 2026-09-23, private `venture-studio-dev` and `venture-studio-prod` buckets existed/created, and dev CORS was limited to `http://localhost:3011`; scoped credentials and live R2 smoke remain pending.
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
- [ ] Run the local reminder worker with the preview app and verify in-app delivery, snooze, and completion from a browser session
- [ ] Show newly delivered in-app notifications without manual refresh (unread bell and accessible reminder toast); verify no duplicate initial-load alerts
- [ ] Staging sign-off and release checklist

