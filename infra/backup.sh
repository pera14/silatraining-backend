#!/usr/bin/env bash
#
# SILA Training — nightly off-site backup (SPEC §7). Runs on the VPS from the deploy folder (DEPLOY_PATH),
# next to docker-compose.yml, .env.prod and backup.env (see backup.env.example, docs/DEPLOY.md, docs/RESTORE.md).
#
#   1. pg_dump -Fc of the app database (inside the postgres container), verified with pg_restore --list
#   2. upload to <bucket>/<prefix>/db/daily/, plus db/weekly/ on Sundays
#   3. mc mirror of the documents bucket to <prefix>/documents/current/ (incremental, deletions propagate),
#      then a snapshot copy to documents/daily/<date>/ (and documents/weekly/<date>/ on Sundays)
#   4. retention: newest BACKUP_KEEP_DAILY daily + BACKUP_KEEP_WEEKLY weekly copies; local dumps for
#      BACKUP_KEEP_LOCAL days
#   5. optional healthchecks.io pings: /start, success, /fail
#
# Cron (deploy user, `crontab -e`; 03:15 server time, logs to the journal: `journalctl -t sila-backup`):
#   15 3 * * * /opt/sila/backup.sh 2>&1 | /usr/bin/logger -t sila-backup
#
# Exit codes: 0 ok, non-zero on any failure (and HEALTHCHECK_URL/fail is pinged).

set -euo pipefail
umask 077
((BASH_VERSINFO[0] >= 4)) || { echo "backup.sh needs bash >= 4" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_PROD="${SILA_ENV_FILE:-${SCRIPT_DIR}/.env.prod}"
BACKUP_ENV="${SILA_BACKUP_ENV:-${SCRIPT_DIR}/backup.env}"

log() { printf '%s [backup] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() {
  log "ERROR: $*"
  exit 1
}

# --- configuration ------------------------------------------------------------------------------------------
[[ -r "${ENV_PROD}" ]] || die "missing ${ENV_PROD}"
[[ -r "${BACKUP_ENV}" ]] || die "missing ${BACKUP_ENV} (copy backup.env.example)"
# shellcheck source=/dev/null
source "${BACKUP_ENV}"

: "${BACKUP_S3_ENDPOINT:?BACKUP_S3_ENDPOINT is required}"
: "${BACKUP_S3_ACCESS_KEY:?BACKUP_S3_ACCESS_KEY is required}"
: "${BACKUP_S3_SECRET_KEY:?BACKUP_S3_SECRET_KEY is required}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-prod}"
BACKUP_KEEP_DAILY="${BACKUP_KEEP_DAILY:-14}"
BACKUP_KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-8}"
BACKUP_LOCAL_DIR="${BACKUP_LOCAL_DIR:-/var/backups/sila}"
BACKUP_KEEP_LOCAL="${BACKUP_KEEP_LOCAL:-3}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-}"

for n in BACKUP_KEEP_DAILY BACKUP_KEEP_WEEKLY BACKUP_KEEP_LOCAL; do
  [[ "${!n}" =~ ^[1-9][0-9]*$ ]] || die "${n} must be a positive integer"
done
[[ "${BACKUP_S3_ENDPOINT}" =~ ^(https?)://([^/]+)/?$ ]] ||
  die "BACKUP_S3_ENDPOINT must look like https://host[:port]"
OFFSITE_SCHEME="${BASH_REMATCH[1]}"
OFFSITE_HOST="${BASH_REMATCH[2]}"

# --- helpers ------------------------------------------------------------------------------------------------
hc_ping() {
  # $1: "" (success) | start | fail. Never fails the backup itself.
  [[ -n "${HEALTHCHECK_URL}" ]] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null "${HEALTHCHECK_URL%/}${1:+/$1}" ||
    log "warning: healthcheck ping '${1:-success}' failed"
}

compose() {
  docker compose --project-directory "${SCRIPT_DIR}" \
    --env-file "${ENV_PROD}" "$@"
}

# mc in a throwaway container on the stack's networks. `src` (local MinIO, root credentials) is configured
# in docker-compose.yml; `offsite` comes from this environment variable (`-e NAME` copies it from our env,
# so the secret never appears on a command line).
# mc takes the credentials verbatim (no percent-decoding; it splits on the last "@"), so B2-style secrets with
# "/" or "+" work as-is; only ":" in the key id and "@" anywhere are impossible.
[[ "${BACKUP_S3_ACCESS_KEY}" != *[:@]* && "${BACKUP_S3_SECRET_KEY}" != *@* ]] ||
  die "BACKUP_S3_ACCESS_KEY must not contain ':' or '@', BACKUP_S3_SECRET_KEY must not contain '@'"
MC_HOST_offsite="${OFFSITE_SCHEME}://${BACKUP_S3_ACCESS_KEY}:${BACKUP_S3_SECRET_KEY}@${OFFSITE_HOST}"
export MC_HOST_offsite
mc() {
  compose --progress quiet --profile tools run --rm --no-deps -T -e MC_HOST_offsite \
    -v "${BACKUP_LOCAL_DIR}:/backup:ro" mc "$@"
}

# Lists the entry names (files or "dir/") directly under an mc path, oldest first (names start with a date).
mc_names() {
  mc ls --json "$1" 2>/dev/null | sed -n 's/.*"key":"\([^"]*\)".*/\1/p' | sort
}

# Keeps the newest $2 entries under mc path $1, removes the rest. (Iterates over an array, not a `while read`
# loop: `docker compose run` would swallow the loop's stdin.)
prune() {
  local path="$1" keep="$2" name
  local -a names
  mapfile -t names < <(mc_names "${path}")
  ((${#names[@]} > keep)) || return 0
  for name in "${names[@]:0:${#names[@]}-keep}"; do
    log "retention: removing ${path#offsite/}${name}"
    if [[ "${name}" == */ ]]; then
      mc rm --recursive --force "${path}${name}" >/dev/null
    else
      mc rm --force "${path}${name}" >/dev/null
    fi
  done
}

on_exit() {
  local rc=$?
  if ((rc == 0)); then
    log "backup finished"
    hc_ping ""
  else
    log "backup FAILED (exit ${rc})"
    hc_ping fail
  fi
}

# --- run ----------------------------------------------------------------------------------------------------
mkdir -p "${BACKUP_LOCAL_DIR}"
chmod 700 "${BACKUP_LOCAL_DIR}"
exec 9>"${BACKUP_LOCAL_DIR}/.lock"
flock -n 9 || die "another backup is still running"

trap on_exit EXIT
hc_ping start
log "backup started"

DAY="$(date -u +%Y-%m-%d)"
IS_SUNDAY=false
[[ "$(date -u +%u)" == 7 ]] && IS_SUNDAY=true
ROOT="offsite/${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX}"
DUMP_NAME="sila-${DAY}.dump"
DUMP="${BACKUP_LOCAL_DIR}/${DUMP_NAME}"

compose ps --status running --services | grep -qx postgres || die "postgres is not running"
compose ps --status running --services | grep -qx minio || die "minio is not running"

# 1. database ------------------------------------------------------------------------------------------------
log "pg_dump -> ${DUMP}"
# Superuser over the container's local socket; APP_DB_NAME is expanded inside the container.
# shellcheck disable=SC2016
compose exec -T postgres sh -c 'exec pg_dump -U postgres -d "${APP_DB_NAME}" -Fc' >"${DUMP}.partial"
compose exec -T postgres pg_restore --list <"${DUMP}.partial" >/dev/null ||
  die "dump failed verification (pg_restore --list)"
mv -f "${DUMP}.partial" "${DUMP}"
log "dump ok ($(du -h "${DUMP}" | cut -f1))"

# 2. upload the dump -------------------------------------------------------------------------------------------
mc cp --quiet "/backup/${DUMP_NAME}" "${ROOT}/db/daily/${DUMP_NAME}" >/dev/null
if [[ "${IS_SUNDAY}" == true ]]; then
  mc cp --quiet "${ROOT}/db/daily/${DUMP_NAME}" "${ROOT}/db/weekly/${DUMP_NAME}" >/dev/null
fi
log "dump uploaded to ${ROOT#offsite/}/db/"

# 3. documents bucket ----------------------------------------------------------------------------------------
S3_BUCKET_NAME="$(grep -E '^S3_BUCKET=' "${ENV_PROD}" | tail -n1 | cut -d= -f2- | tr -d "\"'" || true)"
S3_BUCKET_NAME="${S3_BUCKET_NAME:-sila-documents}"
log "mirroring bucket ${S3_BUCKET_NAME}"
mc mirror --quiet --overwrite --remove "src/${S3_BUCKET_NAME}" "${ROOT}/documents/current" >/dev/null
SNAPSHOT="${ROOT}/documents/daily/${DAY}/"
if [[ -n "$(mc ls --recursive "${ROOT}/documents/current/" | head -n1)" ]]; then
  mc cp --quiet --recursive "${ROOT}/documents/current/" "${SNAPSHOT}" >/dev/null
else
  # empty bucket: still create the day's snapshot so retention counts it
  printf 'empty bucket on %s\n' "${DAY}" | mc pipe "${SNAPSHOT}.empty" >/dev/null
fi
if [[ "${IS_SUNDAY}" == true ]]; then
  mc cp --quiet --recursive "${SNAPSHOT}" "${ROOT}/documents/weekly/${DAY}/" >/dev/null
fi
log "documents mirrored"

# 4. retention -----------------------------------------------------------------------------------------------
prune "${ROOT}/db/daily/" "${BACKUP_KEEP_DAILY}"
prune "${ROOT}/db/weekly/" "${BACKUP_KEEP_WEEKLY}"
prune "${ROOT}/documents/daily/" "${BACKUP_KEEP_DAILY}"
prune "${ROOT}/documents/weekly/" "${BACKUP_KEEP_WEEKLY}"
find "${BACKUP_LOCAL_DIR}" -maxdepth 1 -name 'sila-*.dump' -mtime "+$((BACKUP_KEEP_LOCAL - 1))" -delete
