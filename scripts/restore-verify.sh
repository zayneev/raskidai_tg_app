#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: scripts/restore-verify.sh /secure/backup-directory postgres://...@localhost:PORT/DATABASE" >&2
  exit 2
fi

BACKUP=$1
TARGET=$2
case "$TARGET" in
  *njzfzgqprgkyrqirkvhe*|*supabase.co*)
    echo "Refusing to restore to a Supabase cloud or production target" >&2
    exit 2
    ;;
  postgres://*@localhost:*/*|postgresql://*@localhost:*/*|postgres://*@127.0.0.1:*/*|postgresql://*@127.0.0.1:*/*) ;;
  *) echo "Target must be an explicit localhost/127.0.0.1 PostgreSQL URL" >&2; exit 2 ;;
esac

for file in roles.sql schema.sql data.sql manifest.txt row-counts.csv; do
  test -f "$BACKUP/$file" || { echo "Missing backup file: $file" >&2; exit 2; }
done
command -v psql >/dev/null 2>&1 || { echo "psql is required" >&2; exit 2; }
command -v supabase >/dev/null 2>&1 || { echo "supabase CLI is required" >&2; exit 2; }

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
RESTORED_COUNTS=$(mktemp "${TMPDIR:-/tmp}/raskidai-restored-counts.XXXXXX")
trap 'rm -f -- "$RESTORED_COUNTS"' EXIT HUP INT TERM
echo "Verified restore target is local: $TARGET"
psql --dbname "$TARGET" --tuples-only --command "select current_database(), inet_server_addr(), version();"
psql --dbname "$TARGET" --single-transaction --variable ON_ERROR_STOP=1 \
  --file "$BACKUP/roles.sql" --file "$BACKUP/schema.sql" \
  --command "set session_replication_role=replica" --file "$BACKUP/data.sql"
cd -- "$ROOT"
psql --dbname "$TARGET" --variable ON_ERROR_STOP=1 --file scripts/verify-restore.sql
supabase db query --db-url "$TARGET" --file scripts/backup-counts.sql --output csv > "$RESTORED_COUNTS"
cmp -s "$BACKUP/row-counts.csv" "$RESTORED_COUNTS" || {
  echo "Restored row counts do not match backup counts" >&2
  exit 1
}
supabase test db --db-url "$TARGET" supabase/tests
echo "Restore verification passed, including exact application row counts."
