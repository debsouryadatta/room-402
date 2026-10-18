#!/usr/bin/env bash
# Fallback hosting: run Room 402 on this machine and expose it with a Cloudflare quick tunnel.
# The app and cloudflared keep running in the background after this script exits.
#
#   scripts/tunnel.sh            start (reuses a Room 402 already on :4020), print the public URL
#   scripts/tunnel.sh --write    same, and write the public URL to docs/DEPLOYED_URL.txt
#   scripts/tunnel.sh stop       stop the tunnel (and the app, if this script started it)
#   scripts/tunnel.sh status     show what is running
#
# Local port: R402_LOCAL_PORT (default 4020; :3000 belongs to another app on this machine).
# cloudflared reaches the app from 127.0.0.1, and without ROOM402_ADMIN_TOKEN the server lets
# loopback callers operate (start runs, approve spend). So an app started here always gets the
# token from /tmp/r402-spikes/secrets/admin_token, and the script refuses to publish a URL whose
# operator routes answer without the token. Operator: open <url>/#key=<token>.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PORT="${R402_LOCAL_PORT:-4020}"
LOCAL="http://127.0.0.1:$PORT"
RUN="${TMPDIR:-/tmp}/room402-tunnel"
APP_LOG="$RUN/app.log"
CF_LOG="$RUN/cloudflared.log"   # replaced by a fresh file on every tunnel start
URL_FILE="docs/DEPLOYED_URL.txt"
TOKEN_FILE="${R402_ADMIN_TOKEN_FILE:-/tmp/r402-spikes/secrets/admin_token}"
mkdir -p "$RUN"

log() { printf '[tunnel %s] %s\n' "$(TZ=Asia/Kolkata date +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
alive() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }
# A brand-new quick-tunnel hostname is often NXDOMAIN-cached by this Mac's resolver for minutes
# while the rest of the world already reaches it, so public checks resolve it through 1.1.1.1.
pubcurl() {
  local a host="" ip=""
  for a in "$@"; do case "$a" in https://*.trycloudflare.com*) host="${a#https://}"; host="${host%%/*}" ;; esac; done
  [ -n "$host" ] && ip="$(dig +short @1.1.1.1 "$host" 2>/dev/null | grep -E '^[0-9.]+$' | head -1 || true)"
  if [ -n "$ip" ]; then curl --resolve "$host:443:$ip" "$@"; else curl "$@"; fi
}
code() { pubcurl -s -o /dev/null -w '%{http_code}' --max-time "${2:-8}" "$1" || true; }
# Room 402 answers /health with {"ok":true} and /api/leaderboard with JSON; anything else is not us.
is_room402() {
  pubcurl -s --max-time 8 "$1/health" 2>/dev/null | grep '"ok":true' >/dev/null && [ "$(code "$1/api/leaderboard")" = 200 ]
}

stop() {
  local p
  for p in caffeinate cloudflared app; do
    if alive "$p"; then kill "$(cat "$RUN/$p.pid")" 2>/dev/null || true; log "stopped $p"; fi
    rm -f "$RUN/$p.pid"
  done
  rm -f "$RUN/url"
}

case "${1:-start}" in
  stop) stop; exit 0 ;;
  status)
    for p in app cloudflared caffeinate; do alive "$p" && echo "$p: running (pid $(cat "$RUN/$p.pid"))" || echo "$p: not running"; done
    [ -f "$RUN/url" ] && echo "url: $(cat "$RUN/url")"
    exit 0 ;;
  start | --write) ;;
  *) die "usage: scripts/tunnel.sh [--write|stop|status]" ;;
esac
WRITE=0; [ "${1:-}" = --write ] && WRITE=1

command -v cloudflared >/dev/null || die "cloudflared not found (brew install cloudflared)"

# 1. The app: reuse a Room 402 already on :PORT, else start `npm start` detached with the token.
if is_room402 "$LOCAL"; then
  log "Room 402 already serving on :$PORT, reusing it"
elif [ "$(code "$LOCAL/")" != 000 ]; then
  die "something that is not Room 402 is listening on :$PORT (set R402_LOCAL_PORT)"
else
  if [ ! -s "$TOKEN_FILE" ]; then
    mkdir -p "$(dirname "$TOKEN_FILE")"
    ( umask 077; openssl rand -hex 16 >"$TOKEN_FILE" )
    log "generated a new admin token in $TOKEN_FILE"
  fi
  chmod 600 "$TOKEN_FILE"
  log "starting app (npm start) on :$PORT with the operator token, log $APP_LOG"
  ROOM402_ADMIN_TOKEN="$(tr -d '[:space:]' <"$TOKEN_FILE")" PORT="$PORT" nohup npm start >"$APP_LOG" 2>&1 &
  echo $! >"$RUN/app.pid"
  for i in $(seq 1 60); do
    is_room402 "$LOCAL" && break
    alive app || { tail -20 "$APP_LOG" >&2; die "app exited during startup"; }
    sleep 1
  done
  is_room402 "$LOCAL" || { tail -20 "$APP_LOG" >&2; die "app not healthy after 60 s"; }
  log "app is up"
fi

# 2. The tunnel: reuse a running one if its URL still answers.
URL=""
if alive cloudflared && [ -f "$RUN/url" ] && is_room402 "$(cat "$RUN/url")"; then
  URL="$(cat "$RUN/url")"
  log "reusing running tunnel"
else
  if alive cloudflared; then
    kill "$(cat "$RUN/cloudflared.pid")" 2>/dev/null || true
    for i in $(seq 1 10); do alive cloudflared || break; sleep 0.5; done
  fi
  # New log per start: the old process may still be flushing into the previous one.
  CF_LOG="$RUN/cloudflared.$(date +%s).log"
  nohup cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" >"$CF_LOG" 2>&1 &
  echo $! >"$RUN/cloudflared.pid"
  for i in $(seq 1 45); do
    URL="$(grep -aoE 'https://[a-z0-9-]+\.trycloudflare\.com' "$CF_LOG" | grep -v '^https://api\.' | head -1 || true)"
    [ -n "$URL" ] && break
    alive cloudflared || { tail -20 "$CF_LOG" >&2; die "cloudflared exited"; }
    sleep 1
  done
  [ -n "$URL" ] || die "no trycloudflare URL after 45 s (see $CF_LOG)"
  echo "$URL" >"$RUN/url"
  # Keep the Mac awake for as long as the tunnel lives.
  if command -v caffeinate >/dev/null; then
    nohup caffeinate -dimsu -w "$(cat "$RUN/cloudflared.pid")" >/dev/null 2>&1 &
    echo $! >"$RUN/caffeinate.pid"
  fi
fi

# 3. Verify through the public URL (new quick-tunnel hostnames take a few seconds to resolve).
ok=0
for i in $(seq 1 30); do [ "$(code "$URL/" 10)" = 200 ] && { ok=1; break; }; sleep 2; done
[ "$ok" = 1 ] || die "tunnel URL $URL did not answer 200 on / within 60 s"
is_room402 "$URL" || die "$URL answers but /health or /api/leaderboard is wrong"
ctype="$(pubcurl -sN -D - -o /dev/null --max-time 5 "$URL/events" 2>/dev/null | tr -d '\r' | awk 'tolower($1)=="content-type:"{print tolower($2)}' | tail -1 || true)"
log "GET / 200, /health ok, /api/leaderboard 200, /events content-type ${ctype:-none}"

# 4. Operator routes must demand the token. A bogus approval id changes nothing either way:
#    401 = token enforced (good); 404 = anyone on the internet can operate (refuse).
op="$(pubcurl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "$URL/api/approval/r402-tunnel-probe" || true)"
if [ "$op" != 401 ]; then
  if [ "${R402_ALLOW_OPEN:-0}" = 1 ]; then
    log "WARNING: operator routes answered $op without a token (R402_ALLOW_OPEN=1, publishing anyway)"
  else
    log "operator routes answered $op without a token through the tunnel; the running app has no ROOM402_ADMIN_TOKEN."
    log "restart it with the token (stop the app on :$PORT, then rerun) or set R402_ALLOW_OPEN=1"
    stop   # tear the tunnel down: an operable URL must not stay reachable
    die "refusing to publish an operable URL"
  fi
else
  log "operator routes require the token (401 without it)"
fi

if [ "$WRITE" = 1 ]; then
  mkdir -p docs
  printf '%s\n' "$URL" >"$URL_FILE"   # public URL only, never the operator key
  log "wrote $URL_FILE"
fi
echo "TUNNEL_URL=$URL"
