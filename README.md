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

