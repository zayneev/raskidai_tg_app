#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: scripts/backup.sh /secure/non-repository/output-directory" >&2
  exit 2
fi

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
OUT=$1
mkdir -p -- "$OUT"
chmod 700 -- "$OUT"
OUT=$(CDPATH= cd -- "$OUT" && pwd -P)
case "$OUT/" in
  "$ROOT/"*) echo "Refusing to write a database backup inside the repository" >&2; exit 2 ;;
esac

command -v supabase >/dev/null 2>&1 || { echo "supabase CLI is required" >&2; exit 2; }
cd -- "$ROOT"
supabase db dump --linked --file "$OUT/roles.sql" --role-only
supabase db dump --linked --file "$OUT/schema.sql"
supabase db dump --linked --file "$OUT/data.sql" --data-only --use-copy \
  --exclude storage.buckets_vectors --exclude storage.vector_indexes
supabase db query --linked --file scripts/backup-counts.sql --output csv > "$OUT/row-counts.csv"
supabase migration list --linked > "$OUT/migrations.txt"
supabase functions list --project-ref njzfzgqprgkyrqirkvhe > "$OUT/edge-functions.txt"

{
  echo "created_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "format=plain SQL (roles, schema, COPY data)"
  echo "tool=supabase CLI $(supabase --version)"
  echo "git_commit=$(git rev-parse HEAD)"
  echo "project_ref=njzfzgqprgkyrqirkvhe"
  echo "required_secret_names=TELEGRAM_BOT_TOKEN,ALLOWED_ORIGINS,SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,VITE_SUPABASE_URL"
  shasum -a 256 "$OUT/roles.sql" "$OUT/schema.sql" "$OUT/data.sql"
} > "$OUT/manifest.txt"
chmod 600 -- "$OUT"/*
echo "Backup written to $OUT; encrypt and move it to restricted off-site storage."
