#!/bin/sh
set -eu

PG_BIN=${RASKIDAI_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
INITDB=$PG_BIN/initdb
PG_CTL=$PG_BIN/pg_ctl
CREATEDB=$PG_BIN/createdb
PORT=${RASKIDAI_RESTORE_PORT:-55432}
DATABASE=raskidai_restore_drill

fail() {
  echo "$*" >&2
  exit 2
}

if [ "$#" -ne 1 ]; then
  fail "Usage: scripts/local-restore-drill.sh /secure/backup-directory"
fi
test -x "$INITDB" || fail "PostgreSQL 17 initdb is required at $INITDB"
test -x "$PG_CTL" || fail "PostgreSQL 17 pg_ctl is required at $PG_CTL"
test -x "$CREATEDB" || fail "PostgreSQL 17 createdb is required at $CREATEDB"

BACKUP=$(CDPATH= cd -- "$1" && pwd -P)
TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/raskidai-restore-drill.XXXXXX")
DATA_DIR=$TEMP_ROOT/data
SERVER_LOG=$TEMP_ROOT/postgres.log
PASSWORD_FILE=$TEMP_ROOT/postgres-password
PGPASSFILE=$TEMP_ROOT/pgpass
SERVER_STARTED=0

cleanup() {
  if [ "$SERVER_STARTED" -eq 1 ]; then
    "$PG_CTL" -D "$DATA_DIR" -m fast stop >/dev/null 2>&1 || true
  fi
  rm -rf -- "$TEMP_ROOT"
}
trap cleanup EXIT HUP INT TERM

umask 077
/usr/bin/openssl rand -hex 32 > "$PASSWORD_FILE"
"$INITDB" --username=postgres --pwfile="$PASSWORD_FILE" \
  --auth-local=trust --auth-host=scram-sha-256 --encoding=UTF8 \
  --locale=en_US.UTF-8 "$DATA_DIR" >/dev/null
LOCAL_PASSWORD=$(sed -n '1p' "$PASSWORD_FILE")
printf '127.0.0.1:%s:*:postgres:%s\n' "$PORT" "$LOCAL_PASSWORD" > "$PGPASSFILE"
unset LOCAL_PASSWORD
chmod 600 "$PGPASSFILE"
export PGPASSFILE

if "$PG_BIN/pg_isready" --host=127.0.0.1 --port="$PORT" >/dev/null 2>&1; then
  fail "Port $PORT is already occupied by PostgreSQL"
fi

"$PG_CTL" -D "$DATA_DIR" -l "$SERVER_LOG" \
  -o "-c listen_addresses=127.0.0.1 -c port=$PORT -c unix_socket_directories=$TEMP_ROOT -c shared_preload_libraries=pg_cron -c cron.database_name=$DATABASE" \
  start >/dev/null
SERVER_STARTED=1
"$CREATEDB" --host=127.0.0.1 --port="$PORT" --username=postgres "$DATABASE"

STARTED_AT=$(date +%s)
"$(dirname -- "$0")/restore-verify.sh" "$BACKUP" \
  "postgresql://postgres@127.0.0.1:$PORT/$DATABASE"
FINISHED_AT=$(date +%s)
ELAPSED_SECONDS=$((FINISHED_AT - STARTED_AT))

if [ "$ELAPSED_SECONDS" -eq 0 ]; then
  echo "Restore drill completed in less than 1s."
else
  echo "Restore drill completed in ${ELAPSED_SECONDS}s."
fi
echo "The temporary database, credentials, log and restored production data will now be deleted."
