#!/usr/bin/env bash
# One-time Railway setup for social-activity-service. Run from your own machine
# after `npm i -g @railway/cli && railway login`.
#
#   ./scripts/railway-setup.sh                      # new project named "growthhackz"
#   PROJECT_NAME=foo ./scripts/railway-setup.sh
#
# Re-running is not idempotent: it creates a new project each time.
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-growthhackz}"
SERVICE="social-activity-service"
REPO="growthhackz/growthhackz"

command -v railway >/dev/null || { echo "Install the Railway CLI: npm i -g @railway/cli"; exit 1; }
railway whoami >/dev/null || { echo "Run: railway login"; exit 1; }

echo "==> Creating project $PROJECT_NAME"
railway init --name "$PROJECT_NAME"

echo "==> Adding $SERVICE from $REPO"
railway add --service "$SERVICE" --repo "$REPO"
railway service "$SERVICE"

echo "==> Attaching volume at /data (SQLite lives here)"
railway volume add --mount-path /data

echo "==> Setting variables"
TOKEN="$(openssl rand -hex 24)"
railway variables --service "$SERVICE" --skip-deploys \
  --set "SERVICE_API_TOKEN=$TOKEN" \
  --set "DATABASE_PATH=/data/social-activity.db" \
  --set "PROVIDER=mock" \
  --set "RAILPACK_NODE_VERSION=22"

echo "==> Generating public domain"
railway domain --service "$SERVICE"

cat <<MSG

Done. Two settings the CLI can't set. In the dashboard, open $SERVICE -> Settings:
  1. Source -> Root Directory:        social-activity-service
  2. Config-as-code -> Config file:   /social-activity-service/railway.json
Then click Deploy.

SERVICE_API_TOKEN=$TOKEN   (save this; callers send it as a Bearer token)

To go live later:
  railway variables --service $SERVICE --set "FOLLOWIZ_API_KEY=..." --set "PROVIDER=followiz"
  railway ssh --service $SERVICE -- npm run setup:provider:prod
MSG
