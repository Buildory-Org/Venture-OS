#!/usr/bin/env bash
# Re-seed the DEMO database (vso_demo). Needs the demo API running on 4100 (see demo-start.ps1). Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"
source ./demo-env.sh
[ "$MONGODB_DB" = "vso_demo" ] || { echo "refusing: MONGODB_DB is not vso_demo"; exit 1; }
npm run seed --workspace @venture-studio/api          # base workspace: 3 ventures, 5 users
npm run migrate --workspace @venture-studio/api
npx tsx apps/api/scripts/seed-demo.ts                  # tasks, knowledge, decisions, chat, classes, Sales
