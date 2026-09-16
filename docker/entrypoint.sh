#!/bin/sh
set -eu

mkdir -p "${LOCAL_DATA_PATH}"

npx --no-install wrangler d1 migrations apply site-creator-d1 \
  --local \
  --persist-to "${LOCAL_DATA_PATH}" \
  --config /app/wrangler.local.jsonc

exec npm run dev -- --host 0.0.0.0 --port 4173
