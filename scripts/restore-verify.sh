#!/bin/sh
set -eu

PG_BIN=${RASKIDAI_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
PSQL=$PG_BIN/psql

fail() {
  echo "$*" >&2
  exit 2
}

if [ "$#" -ne 2 ]; then
  fail "Usage: scripts/restore-verify.sh /secure/backup-directory postgresql://postgres@127.0.0.1:PORT/raskidai_restore_drill"
fi

BACKUP=$1
TARGET=$2
case "$TARGET" in
  *njzfzgqprgkyrqirkvhe*|*supabase.co*)
    fail "Refusing to restore to a Supabase cloud or production target"
    ;;
  postgres://*@localhost:*/*|postgresql://*@localhost:*/*|postgres://*@127.0.0.1:*/*|postgresql://*@127.0.0.1:*/*) ;;
  *) fail "Target must be an explicit localhost/127.0.0.1 PostgreSQL URL" ;;
esac

for file in roles.sql schema.sql data.sql manifest.txt row-counts.csv \
  extensions.csv remote-migrations.csv local-migrations.txt edge-functions.txt \
  checksums.sha256; do
  test -s "$BACKUP/$file" || fail "Missing or empty backup file: $file"
done
test -x "$PSQL" || fail "PostgreSQL 17 psql is required at $PSQL"

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
RESTORE_DRIVER=$(mktemp "${TMPDIR:-/tmp}/raskidai-restore-driver.XXXXXX")
RESTORED_COUNTS=$(mktemp "${TMPDIR:-/tmp}/raskidai-restored-counts.XXXXXX")
TEST_OUTPUT=$(mktemp "${TMPDIR:-/tmp}/raskidai-pgtap-output.XXXXXX")
cleanup() {
  rm -f -- "$RESTORE_DRIVER" "$RESTORED_COUNTS" "$TEST_OUTPUT"
}
trap cleanup EXIT HUP INT TERM

(
  cd -- "$BACKUP"
  shasum -a 256 -c checksums.sha256
)

BACKUP_SHA=$(sed -n 's/^git_commit=//p' "$BACKUP/manifest.txt")
CURRENT_SHA=$(git -C "$ROOT" rev-parse HEAD)
test -n "$BACKUP_SHA" || fail "Backup manifest has no Git commit"
test "$BACKUP_SHA" = "$CURRENT_SHA" || fail "Backup Git SHA does not match the checked-out repository"

TARGET_INFO=$(
  "$PSQL" --no-psqlrc --no-password --tuples-only --no-align --field-separator '|' \
    --dbname "$TARGET" \
    --command "select current_database(), coalesce(inet_server_addr()::text, ''), current_setting('server_version_num'), (select rolsuper from pg_roles where rolname=current_user), current_setting('shared_preload_libraries')"
)
OLD_IFS=$IFS
IFS='|'
set -- $TARGET_INFO
IFS=$OLD_IFS
TARGET_DATABASE=$1
TARGET_ADDRESS=$2
TARGET_VERSION_NUM=$3
TARGET_SUPERUSER=$4
TARGET_PRELOAD=$5
case "$TARGET_DATABASE" in
  raskidai_restore_*) ;;
  *) fail "Local restore database must be named raskidai_restore_*" ;;
esac
case "$TARGET_ADDRESS" in
  127.*|::1) ;;
  *) fail "Restore server is not bound to loopback: $TARGET_ADDRESS" ;;
esac
case "$TARGET_VERSION_NUM" in
  17????) ;;
  *) fail "Restore target must run PostgreSQL 17" ;;
esac
test "$TARGET_SUPERUSER" = t || fail "Restore target user must be a local superuser"
case ",$TARGET_PRELOAD," in
  *,pg_cron,*) ;;
  *) fail "Restore target must preload pg_cron" ;;
esac

APPLICATION_OBJECTS=$(
  "$PSQL" --no-psqlrc --no-password --tuples-only --no-align --dbname "$TARGET" \
    --command "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m','S')"
)
test "$APPLICATION_OBJECTS" = 0 || fail "Restore target public schema is not empty"

sql_include() {
  ESCAPED_PATH=$(printf '%s' "$1" | sed "s/'/''/g")
  printf "\\i '%s'\n" "$ESCAPED_PATH" >> "$RESTORE_DRIVER"
}

printf '%s\n' '\set ON_ERROR_STOP on' > "$RESTORE_DRIVER"
sql_include "$BACKUP/roles.sql"
printf '%s\n' 'create schema if not exists extensions;' >> "$RESTORE_DRIVER"
printf '%s\n' 'create extension if not exists pgtap with schema extensions;' >> "$RESTORE_DRIVER"
printf '%s\n' 'grant usage on schema extensions to public;' >> "$RESTORE_DRIVER"
for migration in "$ROOT"/supabase/migrations/*.sql; do
  sql_include "$migration"
done
printf '%s\n' 'set session_replication_role=replica;' >> "$RESTORE_DRIVER"
sql_include "$BACKUP/data.sql"
printf '%s\n' 'set session_replication_role=origin;' >> "$RESTORE_DRIVER"

echo "Verified isolated PostgreSQL 17 target: $TARGET_DATABASE on $TARGET_ADDRESS"
"$PSQL" --no-psqlrc --no-password --single-transaction \
  --variable ON_ERROR_STOP=1 --dbname "$TARGET" --file "$RESTORE_DRIVER"

cd -- "$ROOT"
"$PSQL" --no-psqlrc --no-password --variable ON_ERROR_STOP=1 \
  --dbname "$TARGET" --file scripts/verify-restore.sql
"$PSQL" --quiet --no-psqlrc --no-password --variable ON_ERROR_STOP=1 --csv \
  --dbname "$TARGET" --file scripts/backup-counts.sql > "$RESTORED_COUNTS"
cmp -s "$BACKUP/row-counts.csv" "$RESTORED_COUNTS" || fail "Restored row counts do not match backup counts"

PGOPTIONS="-c search_path=public,extensions ${PGOPTIONS:-}"
export PGOPTIONS
for test_file in supabase/tests/*.sql; do
  echo "Running $test_file"
  if ! "$PSQL" --no-psqlrc --no-password --variable ON_ERROR_STOP=1 \
    --dbname "$TARGET" --file "$test_file" > "$TEST_OUTPUT" 2>&1; then
    sed -n '1,240p' "$TEST_OUTPUT" >&2
    exit 1
  fi
  if grep -Eq '^[[:space:]]*not ok' "$TEST_OUTPUT"; then
    sed -n '1,240p' "$TEST_OUTPUT" >&2
    exit 1
  fi
done

echo "Restore verification passed, including exact application row counts and all SQL tests."
