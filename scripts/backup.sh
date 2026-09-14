#!/bin/sh
set -eu

PROJECT_REF=njzfzgqprgkyrqirkvhe
PG_BIN=${RASKIDAI_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
PSQL=$PG_BIN/psql
PG_DUMP=$PG_BIN/pg_dump

fail() {
  echo "$*" >&2
  exit 2
}

if [ "$#" -ne 1 ]; then
  fail "Usage: scripts/backup.sh /Volumes/encrypted-volume/raskidai-YYYYMMDDTHHMMSSZ"
fi

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
OUT=$1
OUT_CREATED=0
TEMP_PGPASS=
TTY_HIDDEN=0
SUCCESS=0

cleanup() {
  if [ "$TTY_HIDDEN" -eq 1 ]; then
    stty echo 2>/dev/null || true
    printf '\n' >&2
  fi
  if [ -n "$TEMP_PGPASS" ]; then
    rm -f -- "$TEMP_PGPASS"
  fi
  if [ "$SUCCESS" -ne 1 ] && [ "$OUT_CREATED" -eq 1 ]; then
    rm -rf -- "$OUT"
  fi
}
trap cleanup EXIT HUP INT TERM

test -x "$PSQL" || fail "PostgreSQL 17 psql is required at $PSQL"
test -x "$PG_DUMP" || fail "PostgreSQL 17 pg_dump is required at $PG_DUMP"
test ! -e "$OUT" || fail "Backup destination already exists: $OUT"

case "$OUT/" in
  "$ROOT/"*) fail "Refusing to write a database backup inside the repository" ;;
esac
if [ "${RASKIDAI_BACKUP_TEST_MODE:-0}" != 1 ]; then
  case "$OUT" in
    /Volumes/*/*) ;;
    *) fail "Production backups must be written to a mounted encrypted volume under /Volumes" ;;
  esac
  test -z "$(git -C "$ROOT" status --porcelain)" || \
    fail "Commit or otherwise clean the Git worktree before a production backup"
fi

SOURCE_URL=${RASKIDAI_DB_URL:-}
if [ -z "$SOURCE_URL" ]; then
  test -t 0 || fail "Set RASKIDAI_DB_URL to a passwordless PostgreSQL URL"
  printf 'Passwordless Supabase Session pooler URL: ' >&2
  IFS= read -r SOURCE_URL
fi
case "$SOURCE_URL" in
  postgres://*|postgresql://*) ;;
  *) fail "RASKIDAI_DB_URL must be a PostgreSQL URL" ;;
esac
SOURCE_AUTHORITY=${SOURCE_URL#*://}
SOURCE_USERINFO=${SOURCE_AUTHORITY%%@*}
case "$SOURCE_AUTHORITY" in
  *@*) ;;
  *) fail "Database URL must include a username and host" ;;
esac
case "$SOURCE_USERINFO" in
  *:*) fail "Do not embed the database password in RASKIDAI_DB_URL" ;;
esac
if [ "${RASKIDAI_BACKUP_TEST_MODE:-0}" != 1 ]; then
  case "$SOURCE_URL" in
    *"$PROJECT_REF"*supabase.com*) ;;
    *) fail "Database URL does not match the expected Supabase project" ;;
  esac
fi

if [ "${RASKIDAI_BACKUP_TEST_MODE:-0}" != 1 ] && [ -z "${PGPASSFILE:-}" ]; then
  test -t 0 || fail "Run interactively or provide a protected PGPASSFILE"
  printf 'Supabase database password (hidden): ' >&2
  stty -echo
  TTY_HIDDEN=1
  IFS= read -r DB_PASSWORD
  stty echo
  TTY_HIDDEN=0
  printf '\n' >&2
  TEMP_PGPASS=$(mktemp "${TMPDIR:-/tmp}/raskidai-pgpass.XXXXXX")
  ESCAPED_PASSWORD=$(printf '%s' "$DB_PASSWORD" | sed 's/\\/\\\\/g; s/:/\\:/g')
  unset DB_PASSWORD
  printf '*:*:*:*:%s\n' "$ESCAPED_PASSWORD" > "$TEMP_PGPASS"
  unset ESCAPED_PASSWORD
  chmod 600 "$TEMP_PGPASS"
  PGPASSFILE=$TEMP_PGPASS
  export PGPASSFILE
fi

SERVER_INFO=$(
  "$PSQL" --no-psqlrc --no-password --tuples-only --no-align \
    --dbname "$SOURCE_URL" \
    --command "select current_database() || '|' || current_setting('server_version_num')"
)
SERVER_DATABASE=${SERVER_INFO%%|*}
SERVER_VERSION_NUM=${SERVER_INFO#*|}
case "$SERVER_VERSION_NUM" in
  17????) ;;
  *) fail "Expected PostgreSQL 17, got server_version_num=$SERVER_VERSION_NUM" ;;
esac

mkdir -p -- "$OUT"
chmod 700 "$OUT"
OUT_CREATED=1
OUT=$(CDPATH= cd -- "$OUT" && pwd -P)

cd -- "$ROOT"
"$PSQL" --quiet --no-psqlrc --no-password --set ON_ERROR_STOP=1 \
  --dbname "$SOURCE_URL" --file scripts/backup-roles.sql > "$OUT/roles.sql"
"$PG_DUMP" --no-password --dbname "$SOURCE_URL" --schema=public \
  --schema-only --no-owner --no-publications --no-subscriptions \
  --file "$OUT/schema.sql"
"$PG_DUMP" --no-password --dbname "$SOURCE_URL" --schema=public \
  --data-only --no-owner --no-privileges \
  --serializable-deferrable --file "$OUT/data.sql"
"$PSQL" --quiet --no-psqlrc --no-password --set ON_ERROR_STOP=1 --csv \
  --dbname "$SOURCE_URL" --file scripts/backup-counts.sql > "$OUT/row-counts.csv"
"$PSQL" --quiet --no-psqlrc --no-password --set ON_ERROR_STOP=1 --csv \
  --dbname "$SOURCE_URL" \
  --command "select extname, extversion from pg_extension order by extname" \
  > "$OUT/extensions.csv"
"$PSQL" --quiet --no-psqlrc --no-password --set ON_ERROR_STOP=1 --csv \
  --dbname "$SOURCE_URL" \
  --command "select version, name from supabase_migrations.schema_migrations order by version" \
  > "$OUT/remote-migrations.csv"

find supabase/migrations -maxdepth 1 -type f -name '*.sql' -print \
  | sed 's#supabase/migrations/##' | LC_ALL=C sort > "$OUT/local-migrations.txt"
find supabase/functions -mindepth 1 -maxdepth 1 -type d -print \
  | sed 's#supabase/functions/##' | LC_ALL=C sort > "$OUT/edge-functions.txt"

{
  echo "created_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "format=native PostgreSQL 17 plain SQL (application roles, public schema, COPY data)"
  echo "database=$SERVER_DATABASE"
  echo "server_version_num=$SERVER_VERSION_NUM"
  echo "pg_dump=$($PG_DUMP --version)"
  echo "git_commit=$(git rev-parse HEAD)"
  echo "project_ref=$PROJECT_REF"
  echo "required_secret_names=TELEGRAM_BOT_TOKEN,ALLOWED_ORIGINS,SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,VITE_SUPABASE_URL"
  echo "storage_objects=not_used"
} > "$OUT/manifest.txt"

(
  cd -- "$OUT"
  shasum -a 256 roles.sql schema.sql data.sql row-counts.csv extensions.csv \
    remote-migrations.csv local-migrations.txt edge-functions.txt manifest.txt \
    > checksums.sha256
)
chmod 600 "$OUT"/*
SUCCESS=1
echo "Backup written to $OUT. Eject the encrypted volume when finished."
