# API

Express 5 API and Socket.IO gateway backed by MongoDB. Better Auth owns identity/session and magic links; `memberships` remains the only application authorization source.

Local setup from the repository root:

```powershell
Copy-Item .env.example .env
$env:MONGODB_URI='mongodb://127.0.0.1:27018/venture_studio_dev?replicaSet=ventureStudio'
$env:MONGODB_DB='venture_studio_dev'
$env:ALLOW_DEV_AUTH='true'
npm run migrate --workspace @venture-studio/api
npm run seed --workspace @venture-studio/api
npm run dev --workspace @venture-studio/api
```

The sanitized seed supports `x-dev-user-id: user-divyansh` only when `APP_MODE=local` and `ALLOW_DEV_AUTH=true`. Never enable it in production.

Primary route groups are documented in [`docs/backend-api.md`](../../docs/backend-api.md). Local PAT MCP runs with `VSO_MCP_PAT` via `npm run mcp --workspace @venture-studio/api`; hosted MCP requires OAuth and is intentionally not claimed here.

