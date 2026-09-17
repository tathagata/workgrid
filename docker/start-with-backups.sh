#!/bin/sh
set -eu

mkdir -p "${LOCAL_DATA_PATH}" "${WORKGRID_BACKUP_PATH:-${LOCAL_DATA_PATH}/backups}"

lock_dir="${LOCAL_DATA_PATH}/.workgrid-database.lock"
if ! mkdir "${lock_dir}" 2>/dev/null; then
  echo '{"component":"startup","event":"error","message":"database maintenance lock is held"}' >&2
  exit 1
fi
trap 'rmdir "${lock_dir}" 2>/dev/null || true' EXIT INT TERM

node /app/scripts/backup-manager.mjs create pre-migration --lock-held --allow-missing
npx --no-install wrangler d1 migrations apply site-creator-d1 \
  --local \
  --persist-to "${LOCAL_DATA_PATH}" \
  --config /app/wrangler.local.jsonc
node /app/scripts/backup-manager.mjs integrity

rmdir "${lock_dir}"
trap - EXIT INT TERM

node /app/scripts/backup-manager.mjs schedule &
exec npm run dev -- --host 0.0.0.0 --port 4173
