#!/usr/bin/env bash
# Deploy Room 402 to CreateOS as an "upload" project. Idempotent: reuses the project and its
# environment when they exist, refreshes the env vars, uploads a staged copy of the app, waits
# for the build, verifies the live URL and prints it.
#
#   scripts/deploy.sh             create/reuse project + env vars, deploy, verify, print URL
#   scripts/deploy.sh setup       create/reuse project + env vars only (no deploy)
#   scripts/deploy.sh verify      verify the current live URL only
#   scripts/deploy.sh credits     print the CreateOS credit balance
#   scripts/deploy.sh status      project, environment, latest deployments (no secrets)
#
# Overrides: R402_UNIQUE_NAME (default room402), R402_SRC (dir to stage, default repo root),
#            R402_URL_FILE (default docs/DEPLOYED_URL.txt; empty = don't write),
#            R402_CONFIG_FILE (default .createos.json).
# Secrets come from .env / .env.local and go to the API through a 0600 temp file. Never printed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
MODE="${1:-deploy}"
UNIQUE="${R402_UNIQUE_NAME:-room402}"
DISPLAY_NAME="${R402_DISPLAY_NAME:-Room 402}"
SRC="${R402_SRC:-$ROOT}"
URL_FILE="${R402_URL_FILE-docs/DEPLOYED_URL.txt}"
CONFIG_FILE="${R402_CONFIG_FILE:-$ROOT/.createos.json}"
ENV_UNIQUE=production
API="https://api-createos.nodeops.network"
CREATEOS="${CREATEOS_BIN:-$HOME/.local/bin/createos}"
# The node:20 builder runs `npm run build` when no build command is set, and package.json has
# no build script (that is why the first spike failed with build_error). Use a no-op instead.
BUILD_CMD="${R402_BUILD_CMD:-node --version}"
SANDBOX_URL=https://api-eu.sb.createos.sh

set -a
[ -f .env ] && . ./.env
[ -f .env.local ] && . ./.env.local
set +a
: "${CREATEOS_PROJECT_API_KEY:?not set (expected in .env)}"
export CREATEOS_API_KEY="$CREATEOS_PROJECT_API_KEY"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/room402-deploy.XXXXXX")"
chmod 700 "$TMP"
CLI_PID=""
cleanup() { [ -n "$CLI_PID" ] && kill "$CLI_PID" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT
printf 'header = "X-Api-Key: %s"\n' "$CREATEOS_API_KEY" >"$TMP/curl.cfg"
chmod 600 "$TMP/curl.cfg"

log() { printf '[deploy %s] %s\n' "$(TZ=Asia/Kolkata date +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
redact() { sed -E 's/(sk_test_|sk_live_|rk_test_|rk_live_|skp_|sk-or-)[A-Za-z0-9_-]+/\1<redacted>/g'; }

# api METHOD PATH [curl args...]  -> response body on stdout; fails on HTTP >= 400
api() {
  local method="$1" path="$2"; shift 2
  curl -sS --fail-with-body --max-time 60 -K "$TMP/curl.cfg" -X "$method" \
    -H 'Content-Type: application/json' "$@" "$API$path"
}

credits() { api GET /v1/credits | jq -r '.data.amount | . * 100 | round / 100'; }

# List endpoints are paginated ({data: {data: [...], pagination}}); environments return a plain array.
find_project() { api GET '/v1/projects?limit=100' | jq -r --arg u "$UNIQUE" '[.data.data[] | select(.uniqueName == $u)][0].id // empty'; }
deployments() { api GET "/v1/projects/$PID/deployments" | jq '{data: (.data.data // [])}'; }
find_env() { api GET "/v1/projects/$1/environments" | jq -r --arg u "$ENV_UNIQUE" '[(.data | if type == "object" then .data else . end)[] | select(.uniqueName == $u)][0].id // empty'; }

ensure_project() {
  PID="$(find_project)"
  if [ -z "$PID" ]; then
    log "creating upload project $UNIQUE (node:20, port 3000, build: '$BUILD_CMD')"
    "$CREATEOS" projects add --name "$DISPLAY_NAME" --unique-name "$UNIQUE" --type upload \
      --runtime node:20 --port 3000 --install-command "npm install" \
      --build-command "$BUILD_CMD" --run-command "npm start" 2>&1 | redact >&2
    PID="$(find_project)"
    [ -n "$PID" ] || die "project $UNIQUE was not created (unique name taken? set R402_UNIQUE_NAME)"
  else
    log "reusing project $UNIQUE ($PID)"
  fi
  local scan
  scan="$(api GET "/v1/projects/$PID" | jq -r '"enabledSecurityScan=\(.data.enabledSecurityScan) addonsQuota.securityScanEnabled=\(.data.addonsQuota.securityScanEnabled // false)"')"
  log "security scan flags: $scan"
  case "$scan" in *true*) [ "${R402_ALLOW_SCAN:-0}" = 1 ] || die "security scan is enabled on $UNIQUE (480 CC per deployment); refusing. R402_ALLOW_SCAN=1 overrides." ;; esac
}

# runEnvs JSON, built from the environment so no value is ever on a command line.
run_envs_json() {
  local k
  for k in STRIPE_SECRET_KEY OPENROUTER_API_KEY CREATEOS_PROJECT_API_KEY; do
    [ -n "${!k:-}" ] || die "$k is empty; check .env / .env.local"
  done
  CREATEOS_SANDBOX_API_KEY="$CREATEOS_PROJECT_API_KEY" CREATEOS_SANDBOX_BASE_URL="$SANDBOX_URL" \
    jq -n '{STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
            OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
            CREATEOS_PROJECT_API_KEY: env.CREATEOS_PROJECT_API_KEY,
            CREATEOS_SANDBOX_API_KEY: env.CREATEOS_SANDBOX_API_KEY,
            CREATEOS_SANDBOX_BASE_URL: env.CREATEOS_SANDBOX_BASE_URL,
            NODE_ENV: "production"}
           + ([env | to_entries[] | select(.key | startswith("ROOM402_")) | {(.key): .value}] | add // {})'
}

ensure_env() {
  EID="$(find_env "$PID")"
  if [ -z "$EID" ]; then
    log "creating environment $ENV_UNIQUE with runEnvs (auto-promote on)"
    run_envs_json | jq '{displayName: "production", uniqueName: "production",
        settings: {runEnvs: .}, resources: {cpu: 200, memory: 500, replicas: 1},
        isAutoPromoteEnabled: true}' >"$TMP/env.json"
    api POST "/v1/projects/$PID/environments" --data-binary "@$TMP/env.json" >/dev/null
    EID="$(find_env "$PID")"
    [ -n "$EID" ] || die "environment was not created"
  else
    log "reusing environment $ENV_UNIQUE ($EID); refreshing runEnvs"
    api GET "/v1/projects/$PID/environments" | jq --arg e "$EID" '[(.data | if type == "object" then .data else . end)[] | select(.id == $e)][0].settings.runEnvs // {}' >"$TMP/old.json"
    run_envs_json >"$TMP/new.json"
    jq -s '{runEnvs: (.[0] + .[1])}' "$TMP/old.json" "$TMP/new.json" >"$TMP/env.json"
    api PUT "/v1/projects/$PID/environments/$EID/environment-variables" --data-binary "@$TMP/env.json" >/dev/null
  fi
  rm -f "$TMP/env.json" "$TMP/old.json" "$TMP/new.json"
  log "env var names set: $(api GET "/v1/projects/$PID/environments" | jq -r --arg e "$EID" '[(.data | if type == "object" then .data else . end)[] | select(.id == $e)][0].settings.runEnvs // {} | keys | join(",")')"
  printf '{\n  "projectId": "%s",\n  "projectName": "%s",\n  "environmentId": "%s"\n}\n' "$PID" "$DISPLAY_NAME" "$EID" >"$CONFIG_FILE"
}

env_url() {
  api GET "/v1/projects/$PID/environments" | jq -r --arg e "$EID" '[(.data | if type == "object" then .data else . end)[] | select(.id == $e)][0].extra.endpoint // empty'
}

stage() {
  local dst="$TMP/stage"
  mkdir -p "$dst"
  local f
  for f in package.json package-lock.json tsconfig.json src public; do
    [ -e "$SRC/$f" ] && cp -R "$SRC/$f" "$dst/"
  done
  [ -f "$dst/package.json" ] || die "no package.json in $SRC"
  rm -rf "$dst/node_modules" "$dst/data"
  find "$dst" \( -name '.env' -o -name '.env.*' -o -name '.DS_Store' \) -exec rm -rf {} + 2>/dev/null || true
  if grep -rIlE '(^|[^A-Za-z0-9])(sk_test_|sk_live_|rk_test_|rk_live_|skp_|sk-or-)[A-Za-z0-9_-]{8,}' "$dst" >"$TMP/hits" 2>/dev/null; then
    die "secret-looking strings in staged files: $(sed "s#$dst/##" "$TMP/hits" | tr '\n' ' ')"
  fi
  log "staged $(find "$dst" -type f | wc -l | tr -d ' ') files ($(du -sk "$dst" | cut -f1) KB) from $SRC"
  STAGE="$dst"
}

http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time "${2:-20}" "$1" || true; }

# verify URL -> 0 when GET /, GET /api/leaderboard and a 10 s /events stream all work
verify() {
  local url="${1%/}" code i ok=1
  for i in $(seq 1 30); do   # cold start / waking from sleep
    code="$(http_code "$url/" 15)"
    [ "$code" = 200 ] && break
    [ "$i" = 1 ] && [ -n "${PID:-}" ] && [ -n "${DID:-}" ] && api POST "/v1/projects/$PID/deployments/$DID/wakeup" >/dev/null 2>&1 || true
    log "GET / -> $code, waiting for the app ($i/30)"
    sleep 5
  done
  if [ "$code" = 200 ] && curl -s --max-time 20 "$url/" | grep -qi '<html\|<!doctype\|<h1'; then
    log "OK   GET / -> 200 html"
  else log "FAIL GET / -> $code"; ok=0; fi

  code="$(curl -s -o "$TMP/lb.json" -w '%{http_code}' --max-time 20 "$url/api/leaderboard" || true)"
  if [ "$code" = 200 ] && jq -e . "$TMP/lb.json" >/dev/null 2>&1; then
    log "OK   GET /api/leaderboard -> 200 json ($(jq -c 'if type=="array" then "\(length) entries" else (keys|join(",")) end' "$TMP/lb.json"))"
  else log "FAIL GET /api/leaderboard -> $code"; ok=0; fi

  code="$(http_code "$url/health" 15)"
  [ "$code" = 200 ] && log "OK   GET /health -> 200" || log "warn GET /health -> $code"

  local rc=0
  curl -sN -D "$TMP/ev.h" -o "$TMP/ev.b" --max-time 10 -H 'Accept: text/event-stream' "$url/events" || rc=$?
  local ctype events
  ctype="$(tr -d '\r' <"$TMP/ev.h" | awk 'tolower($1)=="content-type:"{print tolower($2)}' | tail -1)"
  events="$(grep -c '^data:' "$TMP/ev.b" 2>/dev/null || true)"
  if [ "$rc" = 28 ] && [[ "$ctype" == text/event-stream* ]]; then
    log "OK   /events stayed open 10 s as text/event-stream ($events data frames)"
  else log "FAIL /events rc=$rc content-type=${ctype:-none} frames=$events"; ok=0; fi
  [ "$ok" = 1 ]
}

write_url() {
  [ -n "$URL_FILE" ] || return 0
  mkdir -p "$(dirname "$ROOT/$URL_FILE")"
  printf '%s\n# kind=createos project=%s verified=%s (GET / 200, /api/leaderboard 200, /events SSE open 10 s)\n' \
    "$1" "$UNIQUE" "$(TZ=Asia/Kolkata date '+%Y-%m-%d %H:%M IST')" >"$ROOT/$URL_FILE"
  log "wrote $URL_FILE"
}

deploy() {
  stage
  local before t0 last
  before="$(credits)"
  log "credits before: $before"
  last="$(deployments | jq -r '[.data[].id] | join(" ")')"
  t0=$(date +%s)
  log "uploading via createos deploy"
  ( cd "$STAGE" && "$CREATEOS" deploy --project "$PID" --dir . ) >"$TMP/cli.log" 2>&1 &
  CLI_PID=$!

  DID=""
  local status="" deps i
  for i in $(seq 1 200); do   # 200 x 3 s = 10 min
    sleep 3
    deps="$(deployments 2>/dev/null || true)"
    if [ -z "$DID" ]; then
      DID="$(jq -r --arg old "$last" '[.data[] | select(.id as $i | ($old | split(" ") | index($i)) | not)] | sort_by(.createdAt) | last | .id // empty' <<<"$deps" 2>/dev/null || true)"
      if [ -z "$DID" ]; then
        if ! kill -0 "$CLI_PID" 2>/dev/null; then redact <"$TMP/cli.log" | tail -20 >&2; die "createos deploy exited before a deployment appeared"; fi
        continue
      fi
      log "deployment $DID created"
    fi
    status="$(jq -r --arg d "$DID" '.data[] | select(.id == $d) | .status' <<<"$deps" 2>/dev/null || true)"
    case "$status" in
      successful|running|active|deployed|ready|live) break ;;
      *error*|*fail*|cancelled|canceled)
        log "deployment $DID status=$status; build log tail:"
        api GET "/v1/projects/$PID/deployments/$DID/build-logs" | jq -r '.data[].log' | tail -25 | redact >&2 || true
        die "deploy failed ($status) after $(( $(date +%s) - t0 )) s" ;;
    esac
    (( i % 10 == 0 )) && log "status=$status ($(( $(date +%s) - t0 )) s)"
  done
  case "$status" in successful|running|active|deployed|ready|live) ;; *) die "timed out, last status=$status" ;; esac
  DEPLOY_SECONDS=$(( $(date +%s) - t0 ))
  log "deployment $DID is $status after ${DEPLOY_SECONDS} s"

  # Make sure the environment serves this deployment (auto-promote should already have done it).
  local cur
  cur="$(api GET "/v1/projects/$PID/environments" | jq -r --arg e "$EID" '[(.data | if type == "object" then .data else . end)[] | select(.id == $e)][0].projectDeploymentId // empty')"
  if [ "$cur" != "$DID" ]; then
    log "promoting $DID to $ENV_UNIQUE (was ${cur:-none})"
    jq -n --arg d "$DID" '{deploymentId: $d}' >"$TMP/assign.json"
    api POST "/v1/projects/$PID/environments/$EID/assign-deployment" --data-binary "@$TMP/assign.json" >/dev/null || log "warn: assign-deployment failed"
  fi

  URL="$(env_url)"
  [ -n "$URL" ] || URL="$(deployments | jq -r --arg d "$DID" '.data[] | select(.id == $d) | .extra.endpoint // empty')"
  [ -n "$URL" ] || URL="$(grep -o 'https://[^ ]*' "$TMP/cli.log" | grep -v createos.sh | tail -1 || true)"
  [ -n "$URL" ] || die "deployed but no endpoint found; check: createos status --project $PID"
  [[ "$URL" == http* ]] || URL="https://$URL"
  kill "$CLI_PID" 2>/dev/null || true; CLI_PID=""
  log "live at $URL"

  if verify "$URL"; then
    write_url "$URL"
    log "credits after: $(credits) (before: $before)"
    echo "LIVE_URL=$URL"
    echo "DEPLOY_SECONDS=$DEPLOY_SECONDS"
  else
    log "credits after: $(credits) (before: $before)"
    die "verification failed for $URL (not written to $URL_FILE)"
  fi
}

case "$MODE" in
  credits) credits ;;
  setup) ensure_project; ensure_env; log "setup done: project=$PID env=$EID url=$(env_url)"; log "credits: $(credits)" ;;
  status)
    PID="$(find_project)"; [ -n "$PID" ] || die "no project $UNIQUE"
    api GET "/v1/projects/$PID" | jq '.data | {id, uniqueName, status, enabledSecurityScan, settings: (.settings | {runtime, port, installCommand, buildCommand, runCommand})}'
    api GET "/v1/projects/$PID/environments" | jq '[(.data | if type == "object" then .data else . end)[] | {id, uniqueName, status, projectDeploymentId, endpoint: .extra.endpoint, envNames: (.settings.runEnvs // {} | keys)}]'
    deployments | jq '[.data[:5][] | {id, status, createdAt, endpoint: .extra.endpoint}]' ;;
  verify)
    U="${2:-}"
    if [ -z "$U" ]; then PID="$(find_project)"; EID="$(find_env "$PID")"; U="$(env_url)"; fi
    [ -n "$U" ] || die "no URL"; [[ "$U" == http* ]] || U="https://$U"
    verify "$U" && log "verified $U" ;;
  deploy) ensure_project; ensure_env; deploy ;;
  *) die "unknown mode $MODE (deploy|setup|verify|credits|status)" ;;
esac
