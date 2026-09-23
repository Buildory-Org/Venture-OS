# Venture Studio OS

A collaboration and execution workspace organized as:

`Workspace -> Ventures -> Groups -> Channels`

The dashboard direction and whole-app implementation were approved on 2026-09-23. The repository now contains the UI plus an Express/Socket.IO API, MongoDB persistence, a durable reminder/outbox worker, shared contracts, local development adapters, and read-only MCP tools.

## Repository layout

- `apps/web` — Next.js web application
- `apps/api` — Express HTTP API, Better Auth, Socket.IO gateway, uploads, search, and MCP server
- `apps/worker` — durable reminders, notification outbox claims, retry, email, and Web Push
- `packages/contracts` — shared schemas and API/event contracts
- `packages/core` — framework-independent domain logic
- `docs` — product and architecture decisions
- `TODO.md` — phased delivery checklist and approval gates

## Current commands

Use Node.js 20.19 or newer.

```bash
npm install
npm run build
npm run typecheck
npm test
npm run smoke:backend
npm run dev:web
npm run smoke:web
```

Copy `.env.example` to `.env` and use a MongoDB replica set. Local mode can use labelled development identity, email, push, and object-storage adapters; production mode fails closed when required credentials or transaction support are missing.

For Cloudflare R2 development uploads, use a private development bucket and a bucket-scoped Object Read & Write token. Set `FILE_STORAGE=r2`, `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` in the ignored root `.env`; API startup fails if any are missing. Configure bucket CORS for the local web origin (`http://localhost:3011` in the current preview): allow `PUT`, `GET`, and `HEAD`, allow `Content-Type`, and expose `ETag`. Use a separate private bucket and token in production. An actual signed browser upload/download smoke test still requires configured credentials and must not be inferred from local-adapter tests.

Member notifications default to in-app delivery, plus browser push once the member subscribes and VAPID keys are configured. Email notifications are opt-in, so repeating task reminders do not flood inboxes when Resend is configured; invitation and sign-in emails use their separate delivery flow.
Web Push currently accepts Chrome/FCM, Firefox/Mozilla, Safari/Apple, and Edge/Windows push-service endpoints. The endpoint ownership index upgrade retires ambiguous legacy duplicates and requires those browsers to subscribe again. Real closed-tab delivery remains unverified until VAPID keys are configured.

