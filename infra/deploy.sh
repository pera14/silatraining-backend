#!/usr/bin/env bash
#
# SILA Training — deploy / roll back on the VPS. Run from CI over SSH (.github/workflows/deploy.yml) or by hand,
# in the deploy folder (DEPLOY_PATH) next to docker-compose.yml and .env.prod.
#
#   ./deploy.sh --api ghcr.io/pera14/sila-api:<sha>      # new API image
#   ./deploy.sh --web ghcr.io/pera14/sila-web:<sha>      # new web image
#   ./deploy.sh                                          # re-apply the current pins (e.g. after editing .env.prod)
#   ./deploy.sh --rollback                               # back to the pins before the last deploy
#   ./deploy.sh --no-pull ...                            # use local images only (testing the stack locally)
#
# Image pins live in .env.images (API_IMAGE=..., WEB_IMAGE=...), the previous pins in .env.images.prev, and every
# change is appended to deploy-history.log. Migrations run when the API container starts; a failed start leaves
# the new pins in place and exits non-zero (see docs/DEPLOY.md "Rollback" before rolling back past a migration).

set -euo pipefail
umask 077

cd "$(dirname "${BASH_SOURCE[0]}")"

IMAGES=.env.images
PREV=.env.images.prev
HISTORY=deploy-history.log
IMAGE_RE='^ghcr\.io/[a-z0-9._/-]+(:[A-Za-z0-9._-]{1,128}|@sha256:[a-f0-9]{64})$'

log() { printf '%s [deploy] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() {
  log "ERROR: $*"
  exit 1
}

api_image=""
web_image=""
pull=true
rollback=false
while (($# > 0)); do
  case "$1" in
    --api) api_image="${2:?--api needs an image}"; shift 2 ;;
    --web) web_image="${2:?--web needs an image}"; shift 2 ;;
    --no-pull) pull=false; shift ;;
    --rollback) rollback=true; shift ;;
    -h | --help) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
for img in "${api_image}" "${web_image}"; do
  [[ -z "${img}" || "${img}" =~ ${IMAGE_RE} ]] || die "refusing image reference: ${img}"
done

[[ -f .env.prod ]] || die "missing .env.prod (copy .env.prod.example)"
touch "${IMAGES}"

exec 9>.deploy.lock
flock -w 600 9 || die "another deploy holds the lock"

current() { sed -n "s/^$1=//p" "${IMAGES}" | tail -n1; }

if [[ "${rollback}" == true ]]; then
  [[ -s "${PREV}" ]] || die "no previous image pins to roll back to"
  cp "${IMAGES}" "${IMAGES}.rollback-tmp"
  cp "${PREV}" "${IMAGES}"
  mv "${IMAGES}.rollback-tmp" "${PREV}"
  log "rolled pins back"
else
  new_api="${api_image:-$(current API_IMAGE)}"
  new_web="${web_image:-$(current WEB_IMAGE)}"
  if [[ "${new_api}" != "$(current API_IMAGE)" || "${new_web}" != "$(current WEB_IMAGE)" ]]; then
    cp "${IMAGES}" "${PREV}"
  fi
  {
    echo "# managed by deploy.sh: image pins for docker-compose.yml"
    [[ -n "${new_api}" ]] && echo "API_IMAGE=${new_api}"
    [[ -n "${new_web}" ]] && echo "WEB_IMAGE=${new_web}"
  } >"${IMAGES}.tmp"
  mv "${IMAGES}.tmp" "${IMAGES}"
fi
printf '%s api=%s web=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$(current API_IMAGE)" "$(current WEB_IMAGE)" >>"${HISTORY}"
log "api=$(current API_IMAGE) web=$(current WEB_IMAGE)"

compose() { docker compose --env-file .env.prod --env-file "${IMAGES}" "$@"; }

compose config --quiet
if [[ "${pull}" == true ]]; then
  log "pulling images"
  compose pull --quiet
fi

log "starting stack"
if ! compose up -d --remove-orphans --wait --wait-timeout 300; then
  log "stack did not become healthy; recent logs:"
  compose ps -a || true
  compose logs --no-color --tail 80 api web || true
  die "deploy failed (previous pins are in ${PREV}; ./deploy.sh --rollback)"
fi

compose ps
# Drop OUR unused images older than a week (label set in both Dockerfiles); everything else on the host is left
# alone. Recent ones stay for quick rollbacks; older tags can be pulled again from GHCR.
docker image prune --all --force --filter "until=168h" --filter "label=com.silatraining.component" >/dev/null || true
log "deploy ok"
