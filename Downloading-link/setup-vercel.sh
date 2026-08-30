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

echo "==> 1/5  Checking login"
if ! $VC whoami >/dev/null 2>&1; then
  echo "    Not logged in — opening browser."
  $VC login
fi
echo "    Logged in as: $($VC whoami 2>/dev/null)"

echo "==> 2/5  Linking project"
if [ ! -f .vercel/project.json ]; then
  $VC link
else
  echo "    Already linked."
fi

echo "==> 3/5  Blob store"
if $VC env ls production 2>/dev/null | grep -q BLOB_READ_WRITE_TOKEN; then
  echo "    BLOB_READ_WRITE_TOKEN already set."
else
  $VC blob create-store dispatch-files
  echo "    Store created. If BLOB_READ_WRITE_TOKEN is still missing below,"
  echo "    connect the store to this project in the Vercel dashboard:"
  echo "    Storage -> dispatch-files -> Connect Project."
fi

echo "==> 4/5  ADMIN_TOKEN"
for ENVIRONMENT in production preview development; do
  if $VC env ls "$ENVIRONMENT" 2>/dev/null | grep -q ADMIN_TOKEN; then
    $VC env rm ADMIN_TOKEN "$ENVIRONMENT" --yes >/dev/null 2>&1 || true
  fi
  printf '%s' "$ADMIN_TOKEN" | $VC env add ADMIN_TOKEN "$ENVIRONMENT" >/dev/null
  echo "    set for $ENVIRONMENT"
done

echo "==> 5/5  Deploying to production"
$VC deploy --prod

echo
echo "Done. Your admin log is at  <your-domain>/admin"
echo "Admin token (from .env):     $ADMIN_TOKEN"
