#!/usr/bin/env bash
# Fail if anything git would push contains a secret: sk_test_, sk_live_, rk_ (Stripe restricted),
# skp_, sk-or- (OpenRouter) tokens, or the literal value of any secret this project uses locally
# (.env, .env.local, the operator token file). Scans tracked + untracked-not-ignored files in the
# working tree AND the staged (index) copies. Output is path:line only; matched text is never shown.
#
#   scripts/check-secrets.sh        exit 0 = clean, 1 = secrets found, 2 = could not scan
set +x
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# A prefix at a token boundary followed by 8+ key characters. Short placeholders such as
# "sk_test_..." do not match; a real key always does.
PATTERN='(^|[^A-Za-z0-9_])(sk_test_|sk_live_|rk_test_|rk_live_|rk_|skp_|sk-or-)[A-Za-z0-9_-]{8,}'
# Doc placeholders that do match the shape ("sk-or-v1-your-key-here", "sk_test_xxxxxxxx") are
# reported as ignored instead of failing. Matched against the token only, case-sensitively.
PLACEHOLDER='your-|YOUR_|xxxxxxxx|XXXXXXXX|example|placeholder|-here|_here|changeme'

TMP="$(mktemp -d "${TMPDIR:-/tmp}/r402-secrets.XXXXXX")"
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT

# Literal values of local secrets (one per line, >= 12 chars), kept in a 0600 temp file.
: >"$TMP/values"; chmod 600 "$TMP/values"
for f in .env .env.local; do
  [ -f "$f" ] && sed -nE 's/^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=[[:space:]]*["'\'']?([^"'\''#[:space:]]{12,})["'\'']?[[:space:]]*$/\2/p' "$f" >>"$TMP/values"
done
TOKEN_FILE="${R402_ADMIN_TOKEN_FILE:-/tmp/r402-spikes/secrets/admin_token}"
if [ -s "$TOKEN_FILE" ]; then { tr -d '[:space:]' <"$TOKEN_FILE"; echo; } >>"$TMP/values"; fi
# Drop values that are plainly not secret (URLs, booleans) so they do not flag docs.
{ grep -vE '^(https?://|true$|false$)' "$TMP/values" || true; } | awk 'length($0) >= 12' | sort -u >"$TMP/v"
mv "$TMP/v" "$TMP/values"; chmod 600 "$TMP/values"

git ls-files -z --cached --others --exclude-standard >"$TMP/files" || { echo "check-secrets: git ls-files failed"; exit 2; }

found=0
files=0
report() { echo "SECRET  $1"; found=1; }

while IFS= read -r -d '' f; do
  [ -f "$f" ] || continue
  files=$((files + 1))
  case "$(basename "$f")" in
    .env | .env.*) [ "$(basename "$f")" = .env.example ] || report "$f (env file is not gitignored)" ;;
  esac
  # Prefix tokens: decide per match whether it is a placeholder; print only the line number.
  # -a so a file with a stray NUL byte is still scanned.
  grep -naoE "$PATTERN" "$f" 2>/dev/null >"$TMP/m" || true
  if [ -s "$TMP/m" ]; then
    while IFS= read -r m; do
      line="${m%%:*}"
      if printf '%s' "${m#*:}" | grep -qE "$PLACEHOLDER"; then
        echo "ignored placeholder token  $f:$line"
      else
        report "$f:$line (token)"
      fi
    done <"$TMP/m"
  fi
  # Literal secret values (CreateOS key, operator token, ...): line numbers only.
  if [ -s "$TMP/values" ]; then
    for line in $(grep -naF -f "$TMP/values" "$f" 2>/dev/null | cut -d: -f1 || true); do
      report "$f:$line (value of a local secret)"
    done
  fi
done <"$TMP/files"

# Staged copies: what `git commit` takes even if the working file was edited since `git add`.
for hit in $(git grep --cached -naIE "$PATTERN" 2>/dev/null | cut -d: -f1,2 | sort -u || true); do
  if git show ":${hit%:*}" 2>/dev/null | sed -n "${hit##*:}p" | grep -oE "$PATTERN" | grep -vE "$PLACEHOLDER" >/dev/null; then
    report "$hit (staged)"
  fi
done
if [ -s "$TMP/values" ]; then
  for hit in $(git grep --cached -naF -f "$TMP/values" 2>/dev/null | cut -d: -f1,2 | sort -u || true); do
    report "$hit (staged, value of a local secret)"
  done
fi

if [ "$found" = 1 ]; then
  echo "check-secrets: FAIL. Remove the secrets above (or gitignore the files), then rotate any key that was ever pushed."
  exit 1
fi
echo "check-secrets: OK ($files files + index scanned; no sk_test_/sk_live_/rk_/skp_/sk-or- tokens, no local secret values)"
