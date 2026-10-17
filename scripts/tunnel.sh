#!/usr/bin/env bash
# Fallback hosting: run Room 402 on this machine and expose it with a Cloudflare quick tunnel.
# The app and cloudflared keep running in the background after this script exits.
#
#   scripts/tunnel.sh            start (reuses an app already on :PORT), print the public URL
#   scripts/tunnel.sh --write    same, and write the URL (marked as a tunnel) to docs/DEPLOYED_URL.txt
#   scripts/tunnel.sh stop       stop the tunnel (and the app, if this script started it)
#   scripts/tunnel.sh status     show what is running
#
# The app reads .env / .env.local itself; this script never touches the secrets.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PORT="${PORT:-3000}"
RUN="${TMPDIR:-/tmp}/room402-tunnel"
APP_LOG="$RUN/app.log"
CF_LOG="$RUN/cloudflared.log"
URL_FILE="docs/DEPLOYED_URL.txt"
mkdir -p "$RUN"

log() { printf '[tunnel %s] %s\n' "$(TZ=Asia/Kolkata date +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
alive() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }
healthy() { [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1/" || true)" = 200 ]; }

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

# 1. The app: reuse whatever already answers on :PORT, else start `npm start` detached.
if healthy "http://127.0.0.1:$PORT"; then
  log "app already serving on :$PORT, reusing it"
else
  log "starting app (npm start) on :$PORT, log $APP_LOG"
  PORT="$PORT" nohup npm start >"$APP_LOG" 2>&1 &
  echo $! >"$RUN/app.pid"
  for i in $(seq 1 60); do
    healthy "http://127.0.0.1:$PORT" && break
    alive app || { tail -20 "$APP_LOG" >&2; die "app exited during startup"; }
    sleep 1
  done
  healthy "http://127.0.0.1:$PORT" || { tail -20 "$APP_LOG" >&2; die "app not healthy after 60 s"; }
  log "app is up"
fi

# 2. The tunnel: reuse a running one if its URL still answers.
URL=""
if alive cloudflared && [ -f "$RUN/url" ] && healthy "$(cat "$RUN/url")"; then
  URL="$(cat "$RUN/url")"
  log "reusing running tunnel"
else
  alive cloudflared && kill "$(cat "$RUN/cloudflared.pid")" 2>/dev/null || true
  : >"$CF_LOG"
  nohup cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" >"$CF_LOG" 2>&1 &
  echo $! >"$RUN/cloudflared.pid"
  for i in $(seq 1 45); do
    URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$CF_LOG" | head -1 || true)"
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
for i in $(seq 1 30); do healthy "$URL" && { ok=1; break; }; sleep 2; done
[ "$ok" = 1 ] || die "tunnel URL $URL did not answer 200 on / within 60 s"
lb="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$URL/api/leaderboard" || true)"
ctype="$(curl -sN -D - -o /dev/null --max-time 5 "$URL/events" 2>/dev/null | tr -d '\r' | awk 'tolower($1)=="content-type:"{print tolower($2)}' | tail -1 || true)"
log "GET / 200, /api/leaderboard $lb, /events content-type ${ctype:-none}"

if [ "$WRITE" = 1 ]; then
  mkdir -p docs
  printf '%s\n# kind=tunnel (cloudflared quick tunnel to this laptop; dies if the laptop sleeps or the process stops) verified=%s\n' \
    "$URL" "$(TZ=Asia/Kolkata date '+%Y-%m-%d %H:%M IST')" >"$URL_FILE"
  log "wrote $URL_FILE"
fi
echo "TUNNEL_URL=$URL"
