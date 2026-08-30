#!/usr/bin/env bash
# One-shot Vercel setup for Dispatch:
#   - links this folder to a Vercel project
#   - creates a Blob store and connects it (gives BLOB_READ_WRITE_TOKEN)
#   - pushes ADMIN_TOKEN from .env to all environments
#   - deploys to production
#
# Usage: ./setup-vercel.sh
set -euo pipefail

cd "$(dirname "$0")"
VC="npx --yes vercel@latest"

if [ ! -f .env ]; then
  echo "!! .env missing — it holds ADMIN_TOKEN. Aborting."; exit 1
fi
ADMIN_TOKEN=$(grep -E '^ADMIN_TOKEN=' .env | cut -d= -f2-)
if [ -z "$ADMIN_TOKEN" ]; then
  echo "!! ADMIN_TOKEN not found in .env. Aborting."; exit 1
fi

echo "==> 1/4  Checking login"
if ! $VC whoami >/dev/null 2>&1; then
  echo "    Not logged in — opening browser."
  $VC login
fi
echo "    Logged in as: $($VC whoami 2>/dev/null)"

echo "==> 2/4  Linking project"
if [ ! -f .vercel/project.json ]; then
  $VC link
else
  echo "    Already linked."
fi

echo "==> 3/4  Pushing environment variables"
# Values live in .env; the deployment needs the same ones.
push_env() {
  local KEY="$1"
  local VALUE
  VALUE=$(grep -E "^${KEY}=" .env | cut -d= -f2-)
  if [ -z "$VALUE" ]; then
    echo "    !! $KEY missing from .env — skipped"; return
  fi
  for ENVIRONMENT in production preview development; do
    $VC env rm "$KEY" "$ENVIRONMENT" --yes >/dev/null 2>&1 || true
    printf '%s' "$VALUE" | $VC env add "$KEY" "$ENVIRONMENT" >/dev/null
  done
  echo "    $KEY set for production, preview, development"
}

push_env BLOB_READ_WRITE_TOKEN
push_env BLOB_STORE_ID
push_env ADMIN_TOKEN
push_env MAX_MB

echo "==> 4/4  Deploying to production"
$VC deploy --prod

echo
echo "Done. Your admin log is at  <your-domain>/admin"
echo "Admin token (from .env):     $ADMIN_TOKEN"
