# Venture Studio OS delivery plan

Checkboxes are updated only after implementation and verification. Approval gates remain unchecked until the user explicitly approves them.

## Phase 0 â€” Foundation

- [x] Confirm product hierarchy: Workspace -> Ventures -> Groups -> Channels
- [x] Record the agreed architecture and security boundaries
- [x] Create the npm/TypeScript monorepo skeleton
- [x] Seed `apps/web` from the approved AIBOS UI reference
- [x] Install and verify the Ponytail backend skill
- [x] Create persistent Frontend and Backend Codex tasks in the Venture Studio project

## Phase 1 â€” Dashboard design prototype (approved)

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

## Phase 2 â€” Complete dummy product UI

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
- [x] Browser-test editor save/reload using a disposable Knowledge record; do not alter an existing user record for testing. Verified 2026-10-04 in the signed-in dev workspace: version 2 saved and shown after reload, a stale editor save was blocked with the newer-version message while keeping the typed text, the leave-page guard and Discard edits dialog worked, and the test record was archived.
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
- [x] Second pre-hosting fix pass: channel notifications are mentions-only (admins are always in channel scope and mentionable); production builds redirect /demo and hide demo links unless NEXT_PUBLIC_ENABLE_DEMO=true; signed-out visitors are sent to sign-in with a return path while signed-in non-members get an explanation; document saves carry baseVersionId and return 409 instead of overwriting a newer version, with version numbers assigned inside the transaction; blank Markdown is a 400; TRUST_PROXY is configurable (true rejected in production); NODE_ENV=production requires APP_MODE=production; start scripts added and the root build compiles shared packages first. Verified core 4/4, API 6/6 and worker 4/4 on a real replica set, web lint and production build (demo redirects in the routes manifest), a signed-out browser redirect, and independent backend review.
- [x] Real-service smoke on the dev stack: a synthetic PNG uploaded through the Knowledge dialog to the private R2 dev bucket (Uploading, Finalizing, Ready), its thumbnail was generated from R2, and the signed download matched the source SHA-256; the test object and record were then deleted. Development VAPID keys were added to the ignored local .env and push-config reports available; browser subscription and delivery remain for a manual check.
- [x] Fix verified defects without changing intended flows: store create-route dates as BSON dates (plus idempotent migration `003-string-dates`) so context packets and date queries work; validate evidence URIs as http(s) and stop persisting absent evidence URIs and opportunity next-action dates as null (which broke task detail and the whole Sales screen); add opt-in newest-first channel paging so channels over 100 messages open on the latest page and Load older prepends with the reading position kept; start cursor-less event replay at the newest window; map malformed/oversized bodies to 400/413 and unhandled duplicate keys to 409; scope MCP venture status outcomes/decisions to the workspace; refresh the shell sidebar after Channels creates a venture, group, or channel without snapping back to the previous scope; keep demo stub redirects inside `/demo`; make the muted-DM worker test exercise the preference path. Verified contracts/core build, API/worker typecheck, core 4/4, API 6/6 and worker 3/3 against a real replica set, web lint and production build, an isolated seeded browser smoke (paging, live arrival, scope handoff in selected and All scope, demo redirects, evidence submit/reload/review, Sales list), and independent backend review.
- [x] Multi-user QA pass (2026-10-04): six read-only tester agents used an isolated seeded stack (`*.localhost:3012`, separate database) as admins, venture heads, contributors, reviewers, and learners across chat, DMs and notifications, tasks/board/focus, knowledge, planning/sales, navigation/mobile, and admin/permissions. Server-side authorization and venture isolation held everywhere. Fixed the findings that change behavior or lose data: an opportunity stage change no longer wipes its contact (partial update schemas no longer inject defaults); whitespace-only titles, answers, and descriptions are 400s; outcome review dates must follow start dates (checked only when a date changes); requests follow open â†’ answered â†’ reviewed â†’ closed (only the respondent answers, only from open; only the requester or a venture lead reviews, closes, or reopens; nobody reviews their own answer; review never overwrites the answer and a new answer clears the old review); evidence comes from the assignee or a venture lead, and non-admins cannot review their own submission or evidence on their own task; an access save refuses to overwrite a concurrent group change; snoozing a repeating reminder never moves it earlier; Mark stale only applies to approved records, race-safe; documents cannot be created at a sensitivity the creator cannot read; venture and group names are unique case-insensitively; a no-op access save keeps inherited venture access; `POST /notifications/read` marks a conversation's (or all) alerts read; a Next proxy keep-alive race (intermittent 500s) is closed. In the UI: readable validation messages everywhere, notification deep links to the task/channel/DM, Mark all read, toasts on chat routes, thread/reply/reaction/saved indicators and long-text wrapping in chat, document-not-found and unsaved-editor-navigation guards, task not-found/deadline-risk/activity authors/evidence-form gating, board and planning overflow, phone top bar and inert closed drawer, branded 404, plain page titles, ventures not-available state, People & access highlighting and admin-only links, dashboard counts excluding draft/cancelled outcomes and past classes, timeline without cancelled items, request review/close/reopen controls, class applicant names, one sales column per stage, drawer-scoped errors, learner composers disabled, `@handle` DM search, and a per-tab dev identity for multi-user local testing (documented in README). Verified core 4/4, API 7/7 and worker 4/4 on a real replica set, typecheck, web lint and production build, browser checks on the isolated stack at desktop, 375px, and 320px, and two independent backend reviews (all Medium findings fixed).
- [ ] Remaining low-risk review items: enforce case-insensitive venture/group uniqueness with a collated unique index after de-duplicating existing names (today it is a check before insert); mark legacy message notifications without chatKind read when their conversation is opened; pin document approval to the reviewed version; guard concurrent outcome date edits in the update filter.
- [x] Interaction and motion pass (2026-10-04), following the motion review page (recommended defaults): shared motion primitives (exit transitions for drawers, dialogs, popovers, and the group sheet; collapses; skeletons; stacked toasts with Undo; rolling numbers; label swaps; row highlights), board and group-sheet drag-and-drop with card glide and optimistic moves that roll back on failure, optimistic chat sends and reactions with day separators, grouping, a new-messages pill, slash commands, paste/drop attachments, upload placeholder chips, and a per-browser message-sound mute; sliding active pill, collapsed-rail tooltips, remembered collapse with Ctrl+B, Ctrl+K arrow/Enter navigation, Back/Forward scroll restore, unread count in the tab title, and a top-bar focus countdown in the shell; live Unread signals and skeleton/Try again on Dashboard and Today; venture sections in the URL with counts and scope-follows-sidebar; member search and a confirm step that lists removed access in People & access; focus ring and presets; Unread tab, undoable Mark read, and Saved states in the inbox; removed two unused screens. Verified typecheck, web lint, production build, and browser checks on the isolated stack (desktop) for the sidebar, palette, collapse persistence, chat sheet and saved-message jump, board moves, ventures tabs/scope, admin confirm and discard guard, focus start/complete, and inbox Undo/commit. An independent review found no crash or data-loss issues; its behavior findings were fixed (member picker never picks from a stale search, Mark read is sent when its Undo toast closes and survives a racing inbox poll, moved board cards keep keyboard focus, preview stepping keeps focus, Back/Forward restore only for a different page, the sidebar pill cannot stick, editing a failed message restores its files and reply without overwriting a draft, admin promotion and double-clicks are confirmed safely, and editor drafts are per member).
- [x] Apply the motion review choices (2026-10-05): tab content fades and slides 10 px from the side of the chosen tab (200 ms); board cards glide on a soft spring (bounce 0.25) and a dragged card lifts and tilts (scale 1.04, -2.5Â°) then springs into place; the bell swings with its badge pop (620 ms); progress bars grow in on load (650 ms, staggered) and slide on change; dashboard numbers roll digit by digit (450 ms); the sidebar pill uses a strong ease-out; rows leave by fading (120 ms) then folding (180 ms); the theme icon is unchanged as requested. Verified typecheck, web lint, production build, and browser checks of the odometer, tab direction, spring glide, and drag lift/tilt on the isolated stack.
- [ ] Motion follow-ups: focus pause/+5 minutes needs an API change; Mark read Undo is client-side (the read is sent when the Undo window closes) until a mark-unread endpoint exists; recheck the pass at 375px and in Safari.

### 2.4 Verification

- [x] Route-level UI smoke tests
- [x] Responsive pass at 390px and 320px for all studio routes
- [x] Connected keyboard pass: named controls, tab order across core routes, and task drawer focus trap, Escape, and focus return
- [ ] Keyboard-accessibility pass
- [ ] User approval of the complete dummy UI

## Phase 3 â€” Backend foundation

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

## Phase 4 â€” Realtime work, commands, and automation

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

## Phase 5 â€” Files, knowledge, and MCP

- [ ] R2 upload flow with signed URLs, metadata, authorization, and lifecycle rules
- [ ] Configure separate private R2 development/production buckets with scoped keys; verify real browser upload/download and no local fallback when R2 is selected. On 2026-09-23, private `venture-studio-dev` and `venture-studio-prod` buckets existed/created, and dev CORS was limited to `http://localhost:3011`; scoped credentials and live R2 smoke remain pending.
- [x] Add authorized, paginated group file and saved-message feeds with cross-group/cross-workspace Mongo smoke checks
- [ ] Validate uploaded media contents and playback for image/video/audio previews; the current allowlist checks declared MIME type and size only
- [x] Search/indexing across authorized messages, tasks, and documents
- [x] Repair missing/legacy-null workspace document scope and admin all-venture visibility across REST and MCP; verify role/sensitivity boundaries in real Mongo and independent review
- [x] Omit absent document version source URLs on write and normalize legacy null URLs on read; verify POST/GET/PUT contracts with real Mongo
- [x] Read-only MCP server with scoped local PATs, revocation, and audit logs
- [x] Threat-model and reviewer-agent pass for file and MCP data boundaries
- [x] Hosted MCP for Claude Code, phase 1 (2026-10-08, local only, not deployed). Plan and reference are in `docs/mcp.md`; the decision log in `docs/architecture.md` is amended.
  - **Endpoint:** stateless Streamable HTTP at `/mcp`, proxied by the web app.
  - **Tokens:** personal access tokens that are hashed, scoped, expire within 366 days, are bound to the owner's membership, revoke immediately, and are revoked when the membership is renewed.
  - **Tools:** 17 tools and 3 prompts that reach data only through the product API as the token's owner, on an allowlist of routes.
  - **Scopes:** enforced per tool and inside tool output. A write scope needs its read scope. Direct messages are never exposed.
  - **Retries:** atomic retry de-duplication by `requestId`, refused when the arguments differ.
  - **Limits:** per token, per person, and per IP before sign-in; a separate API bucket so Claude never throttles the browser; no batches; 64 KB bodies; Origin check.
  - **Output:** hidden characters stripped from people-written text, an untrusted-text note, and UTC labels.
  - **Switches:** `MCP_ENABLED` and `MCP_WRITES_ENABLED`. Production keeps MCP off until `deploy\.env` sets `MCP_ENABLED=true`.
  - **Connect Claude page:** create a token (read and update, or read only), copy the `claude mcp add` command and an hourly `/loop` prompt, and revoke tokens.
  - **Reminders:** personal reminders via `POST /v1/reminders`, delivered by the worker.
  - **Removed:** the old stdio server, which leaked other ventures' outcomes and decisions.
  - **Verified:**
    - Backend smoke suite (core 4/4, API 12/12, worker 4/4, typechecks) and web typecheck and lint.
    - Two Sonnet QA agents against a throwaway seeded stack, one functional (every tool and prompt, the SDK client, sizes and latency) and one adversarial (auth, scopes, cross-venture and archived data, foreign writes, injection, batches, idempotency races, rate limits). Their findings were fixed and re-verified.
    - Two rounds of independent backend review, with all Medium and Low findings fixed.
    - A 12-check live smoke through the official MCP client.
    - A final pass on the final code with the worker running: worker-created notifications in `whats_new`, reminders firing on time, direct-message text hidden from every tool, the review flow, the per-person cap, and the route allowlist with all 17 tools.
    - The Connect Claude page in a browser: create, copy, the `/mcp` proxy through the web app, and revoke.
  - **Not verified:** a real Claude Code session, because the CLI's weekly limit was reached.
  - **Follow-ups:** phase 2 OAuth plus an in-chat view for claude.ai and Desktop; phase 3 `post_message` and `create_task`.
- [ ] Turn hosted MCP on in production: set `MCP_ENABLED=true` in `deploy\.env`, rebuild, create a token on os.buildory.dev, and connect one real Claude Code session end to end (owner approval required).
- [x] Integration smoke tests

## Phase 6 â€” Production hardening

- [x] Local production stack for one Windows PC (2026-10-06): `deploy/` Docker Compose with Node 22 images for web (Next standalone), API and worker; MongoDB 8 as an authenticated single-node replica set (not published); a backup service (full `mongodump --oplog` at start and every 24 h, 14 days local, optional R2 copy with 30-day pruning, hourly upload retry, unhealthy when stale, failed, or mid-restore); a pinned Cloudflare Tunnel; and `deploy\prod.cmd` (init with generated secrets and push keys, check, up, status, logs, backup, verify-backup, restore with a gzip check, safety copy, backup pause, and restart only on success). The API keys per-IP limits on `CLIENT_IP_HEADER` (also passed to better-auth), groups IPv6 by /64, and treats blank env values as unset (blank `APP_MODE`/`NODE_ENV` still fail); the signup pages forward the visitor address. Verified API 8/8, worker 4/4, core 4/4 on a real replica set, typecheck and lint, image builds, and a throwaway full stack: health, rewrites, polling handshake, demo hidden, client-IP and IPv6 rate-limit keys, verify-restore, refused damaged file, restore with safety copy, and an upload-failure marker. An independent review's findings were fixed.
- [x] Sign-in and sign-out flow (2026-10-07): `/sign-in/live` checks the session on the server and sends signed-in visitors on to a sanitized `next` (same-site only, re-checked after dot-segment normalization, never back to sign-in/signup or API routes; 35 bypass cases pass), with 3 s API timeouts. It links to `/signup` only while first-admin setup is open, and the "Open workspace" button is gone. Sign-out now exists: in the sidebar user card (also when collapsed), on the signed-in-without-access screen, and as "Use a different account" on the invite page; a failed sign-out shows an error instead of bouncing. Verified on a throwaway stack with real magic-link sessions (signed-out form and setup link, signed-in redirect, `//` and `/.//` bypasses refused, no-access screen, admin claim, sign-out from the expanded and collapsed sidebar, invite page in both states), typecheck and lint, an independent review (its open-redirect, sign-out failure, and timeout findings fixed), and on os.buildory.dev after the rebuild.
- [x] Editable venture 30-day goal (2026-10-07): `PATCH /v1/ventures/:id` takes only `goal30Day` (strict, trimmed, max 500, empty clears) from an admin or a venture head assigned to that venture, scoped to the actor's workspace, with the update and a `venture.goal.update` audit event (venture ID, cleared flag) in one transaction. Venture Overview shows "No 30-day goal yet" and a Set goal/Edit button for those people only, with an inline editor (Escape cancels, Ctrl/Cmd+Enter saves, focus returns to the button), and refreshes the shell after a save; demo mode edits local demo data. Verified with a new API test (admin, own head, other head, contributor, cross-workspace both ways, unknown venture, unauthenticated, length, extra fields, non-string, whitespace clear, audit events), the backend smoke suite (core 4/4, API 9/9, worker 4/4, typechecks), web typecheck and lint, a browser run on a throwaway stack (set, save, reload, Escape cancel, clear, keyboard-only flow), and an independent review whose audit, venture-matching, accessibility, and wording findings were fixed. Concurrent edits are last-writer-wins and other open sessions see the change on their next load.
- [x] Workspace-level invitations (2026-10-07): People & access has an admin-only Invite member drawer (email, role with a plain-language description, ventures, and groups within chosen ventures; admins get a trust warning and no venture list). It needs at least one venture for non-admin roles, notes that a person without a group cannot open tasks, board, or channels, shows a copyable one-time link when email delivery is off, and explains an existing-member conflict. It uses the existing admin-checked `POST /v1/admin/invitations`; the group panel's invite now shares the same client call, which checks that the response matches the requested access exactly. Verified with web typecheck and lint and a throwaway stack: no-venture check, contributor invite to one venture and group, acceptance by the invitee giving exactly that access (other venture hidden), the new member listed, existing-member conflict message, and an admin invite.
- [x] Auth screens restyled after VoiceOPS (2026-10-07): sign-in, first-admin setup, setup completion, and the invitation page share an `AuthShell` (animated WebGL silk background with a static fallback image, a white-framed showcase panel with a serif headline on wide screens, and a white form panel), VoiceOPS-style fields and dark buttons, a fade on content swaps, and a shake on errors. The invitation page now shows which account is signed in, offers "Sign in to accept" when signed out, and "Use a different account" when signed in. Verified with web typecheck and lint and a throwaway stack: each screen on desktop, the invite page signed out, signed in, and with an invalid invitation error, and the 375 px phone layout without horizontal scroll.
- [x] Layout polish (2026-10-08): tab bars size to their tabs everywhere; the Kanban boards (demo and live) drop the labelled filter panel for a row of content-width pill filters above the columns, highlighted while active, with Clear and a filter-icon toggle (card count and active-filter badge) that collapses the row and is remembered per browser; People & access (demo and live) lists members as a table (member and handle, gradient role pill per role family, two venture chips then +N, group count, Edit) that stacks into cards on phones. Verified with web typecheck and lint, the demo pages in a browser at phone, 800 px, and 1440 px widths in light and dark themes, and the live board and People pages signed in to the dev workspace.
- [x] Focus sessions pause and resume (2026-10-08): `POST /v1/focus/:id/pause` and `/resume` are single atomic updates on the caller's own running session (`pausedAt` freezes the clock; resuming moves `endsAt` by the pause and adds it to `pausedMs`; completing while paused counts the open pause). The live focus page has Pause/Resume, logged minutes exclude paused time, and the top-bar timer shows "Paused" with an amber dot. The demo dock labels a paused sprint Resume and picks one of your own tasks. The misleading hand-gesture icon became a circular reset arrow (and a reply arrow in chat). Verified with a new API test (owner-only, double pause and resume refused, `endsAt` shift equals `pausedMs`, finishing while paused, finished sessions refused), the API suite 10/10, web typecheck and lint, and start, pause, refresh, resume, and complete on the live focus page in the dev workspace.
- [x] Venture archive, restore, and permanent delete (2026-10-08): admins, and venture heads for ventures they lead, archive or restore a venture from the Ventures page's more menu (with Undo) and an Archived ventures panel; admins can permanently delete an archived venture after typing its exact name. An archived venture is hidden from everyone, admins included, and frozen: the request membership drops it (`withArchiveScope`), `can()` refuses it, and admin-wide reads exclude it across navigation, dashboard, tasks, outcomes, reminders, knowledge, files, search, sales, chat, events, notifications, and MCP; the worker holds its reminders and notices and restore re-arms them. Delete runs in one transaction (refused without transactions), cascades every venture-linked collection, strips it from memberships and pending invitations, and keeps every removed or rewritten document in `deleted_records` for 30 days (TTL); file objects stay in storage for recovery. Verified with a new API test (permissions, hiding and freezing for admins and members, archived list, restore and re-arm, delete guards, cascade scope, membership and invitation cleanup, recovery copies, audit), the backend smoke suite (core 4/4, API 11/11, worker 4/4), web typecheck and lint, an independent review whose findings were fixed, and archive, restore, and delete of a throwaway venture in the dev workspace. Follow-ups: a storage cleanup for deleted ventures' files, and batching very large deletes.
- [x] Empty states and layout pass (2026-10-08), from an owner-reviewed audit of all 18 live screens (the review page decided each item).
  - **Empty-state kit:** a shared `EmptyState` (`components/ui/empty-state.tsx`) with page, card, filtered, select, error, column, and compact variants. It has tone-coloured gradient icon tiles and an ordered (Bayer) dither drawn by `components/ui/dither.tsx` from theme tokens. `Empty` now renders the card variant.
  - **Screens converted:** Tasks, Board, Decisions, Requests, Classes, Planning, Timeline, Sales, Notifications, Channels, Messages, Knowledge, Ventures, Admin, Focus, Dashboard, Today, and the group workspace sheet. Blank cards (venture overview, dashboard) are filled.
  - **Correctness:** "nothing yet" and "filtered out" are now separate, with Clear filters. A failed load shows an error with Try again instead of "No â€¦ yet". Skeletons replace the empty flashes on classes, reminders, the people list and the board. Copy follows the venture scope and the person's access.
  - **Layout:**
    - Page headers use one order: icon-only Refresh, then secondary actions, then primary; secondary labels hide on phones.
    - Tab rows fade at the edge that scrolls. Cards size to their content. Detail panes are centred and hidden on phones until something is selected.
    - The board has a Grid/Row switch, remembered per browser. The People rows on phones keep Edit beside the name.
    - The duplicate header New task buttons are gone; the top-bar New task now shows on phones as an icon and opens the form even when Tasks is open.
    - The phone shadow bleed is fixed, and the sidebar shows a fade when more links sit below.
  - **Dashboard and Today:** shared stat cards that link to their lists. A tone-coloured dither always sits in the corner and spreads on hover or focus (an eased reach tween in `Dither`).
  - **New task from anywhere:** the top-bar New task (an icon on phones), every Draft or Create task shortcut, the board, and the Tasks page's `c` key open one shared popup (`components/studio/new-task-dialog.tsx`) over the current screen. There is no redirect, the current venture is preselected, and a half-filled form asks before closing. Its header has a slowly drifting dither (`Dither animated`: about 24 fps, paused off-screen or in a hidden tab, still under reduced motion). Creating a task shows a toast with Open task, and the Tasks page, board and dashboard refresh. Old `?new=1` links still work. Verified with 16 browser checks at desktop and phone width.
  - **Focus:** start uses a two-ring dial (minutes outer, hours inner, max 4 h). It snaps to detents, carries across 12 o'clock, vibrates where supported, and works from the keyboard.
  - **Connect Claude:** the token is readable in dark mode with a copy fallback, and the page is one flow (empty state, create dialog, key cards, setup guide drawer).
  - **Verified:** web typecheck and lint; screenshots of every screen in light and dark at desktop and phone with no overflow or console errors; an independent code review whose findings were fixed; the owner reviewed the screens.
- [x] Designed invitation and sign-in emails (2026-10-08), the owner-chosen "dither hero" direction.
  - **Templates:** email-safe HTML (tables and inline styles) plus a plain-text part, in `apps/api/src/email/templates.ts`. Cabinet Grotesk headings where clients load web fonts, otherwise Plus Jakarta Sans or Helvetica.
  - **Artwork:** a dithered banner, a fully rounded and centred dither button, and the Venture Studio OS logo in the header and the brand footer. All embedded inline (`cid:`, about 14 KB) so emails render even when the site is down; regenerate with `apps/api/scripts/email-art.mjs`.
  - **Invitation content:** the inviter, role, ventures, groups, a fallback link, the real expiry date, and "wrong address?" guidance. Subject: "<first name> invited you to <workspace>". The sign-in link email matches it, with an explicit 5-minute expiry.
  - **Accepted invitations:** the inviter gets a `member_joined` notification (in-app, plus push or email per their preferences). It is created in the accept transaction and delivered only while they are still an admin.
  - **Verified:** the API test asserts the subject, HTML, plain text, inline images, and the single notification. Backend smoke (core 4/4, API 12/12, worker 4/4); typechecks; web lint; an independent review whose findings were fixed; previews at desktop and phone width.
- [x] Group access per venture (2026-10-08). Inviting or editing a member offers three choices for each venture.
  - **The choices:** **All groups** (the default, and includes groups created later), **Pick groups** (only the ticked ones), or **No groups** (venture pages only). Each comes with a plain sentence saying what it means.
  - **How it works:** memberships and invitations store `allGroupVentureIds`, and access is written into `groupIds`. Every existing permission check is unchanged.
  - **New groups:** a new group is added to "all groups" members in the same transaction. A `groupsRevision` bump on the venture stops it racing a membership save or invitation accept.
  - **Existing members:** they keep exactly the groups they had.
  - **Removing someone from one group:** this switches that venture to picked groups for them. The Undo in the toast restores "all groups" as well.
  - **Email and member list:** the invitation email says "All groups in <venture>". The member list shows "All".
  - **Verified:**
    - The API test covers the default, picked and none choices, accept, edit, remove and Undo, the audit entry, a create-versus-save race, the email line, and venture deletion.
    - Backend smoke: core 4/4, API 13/13, worker 4/4.
    - Typechecks and web lint pass.
    - An independent review found no blockers, and its should-fix points were fixed.
    - Tried end to end on an isolated local copy, at desktop and phone width, in light and dark.
    - Two flaky MCP test checks (time of day, minute rollover) were hardened.
- [ ] Go live on the PC: fill `deploy/.env` (domain, Resend, production R2 bucket with CORS and token, backup bucket, tunnel token), run `deploy\prod.cmd up`, then verify first-admin signup, invitations, chat, uploads, email, and push from another device on the public domain; run `verify-backup`; set Docker Desktop to start on sign-in and Windows to never sleep.
- [ ] Observability dashboards and alerts
- [ ] Backup/restore and disaster-recovery rehearsal
- [ ] Security, accessibility, performance, and dependency audits
- [ ] Cross-browser and critical-path end-to-end test suite
- [ ] Run the local reminder worker with the preview app and verify in-app delivery, snooze, and completion from a browser session
- [ ] Show newly delivered in-app notifications without manual refresh (unread bell and accessible reminder toast); verify no duplicate initial-load alerts
- [ ] Staging sign-off and release checklist

