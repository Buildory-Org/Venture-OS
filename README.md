# Venture Studio OS

A collaboration and execution workspace organized as:

`Workspace -> Ventures -> Groups -> Channels`

The first milestone is a local, high-fidelity dashboard prototype based on the existing AIBOS visual system. Backend services and production integrations are deliberately deferred until the dashboard direction is approved.

## Repository layout

- `apps/web` — Next.js web application
- `apps/api` — Express API (future phase)
- `apps/worker` — background jobs and notifications (future phase)
- `packages/contracts` — shared schemas and API/event contracts
- `packages/core` — framework-independent domain logic
- `docs` — product and architecture decisions
- `TODO.md` — phased delivery checklist and approval gates

## Current commands

```bash
npm install
npm run dev:web
npm run smoke:web
```

