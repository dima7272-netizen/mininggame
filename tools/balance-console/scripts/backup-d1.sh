#!/bin/sh
set -eu

mode="${1:---local}"
case "$mode" in
  --local|--remote) ;;
  *) echo "Usage: pnpm db:backup [--local|--remote]" >&2; exit 2 ;;
esac

database_name="${BALANCE_DB_NAME:-site-creator-d1}"
backup_dir="${BACKUP_DIR:-backups}"
timestamp="$(TZ=Europe/Moscow date +%Y-%m-%dT%H-%M-%S%z)"
export WRANGLER_WRITE_LOGS=false
export WRANGLER_LOG_PATH="${WRANGLER_LOG_PATH:-.wrangler/logs}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-.wrangler/config}"
mkdir -p "$backup_dir"

pnpm exec wrangler d1 export "$database_name" "$mode" \
  --output "$backup_dir/dig-get-stronger-d1-$timestamp.sql"

echo "Backup created in $backup_dir"
