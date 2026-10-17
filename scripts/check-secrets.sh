#!/usr/bin/env bash
# Fail if any file git would push (tracked + untracked-but-not-ignored) contains a secret-looking
# token: sk_test_, sk_live_, rk_ (Stripe restricted), skp_, sk-or- (OpenRouter).
# Matches are masked in the output; the secret itself is never printed.
#
#   scripts/check-secrets.sh        exit 0 = clean, 1 = secrets found
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# A prefix at a token boundary followed by 8+ key characters. Short placeholders such as
# "sk_test_..." do not match; a real key always does.
PATTERN='(^|[^A-Za-z0-9_])(sk_test_|sk_live_|rk_test_|rk_live_|rk_|skp_|sk-or-)[A-Za-z0-9_-]{8,}'
# Doc placeholders that do match the shape ("sk-or-v1-your-key-here", "sk_test_xxxxxxxx") are
# reported as ignored rather than failing the check.
PLACEHOLDER='your|xxxx|example|placeholder|dummy|redacted|here|changeme|1234567|abcdef'

found=0
files=0
while IFS= read -r -d '' f; do
  [ -f "$f" ] || continue
  files=$((files + 1))
  case "$(basename "$f")" in
    .env | .env.*)
      [ "$(basename "$f")" = .env.example ] || { echo "SECRET FILE  $f is not gitignored"; found=1; } ;;
  esac
  # grep -o prints the raw match, so it goes straight into the masking sed and nowhere else.
  if hits="$(grep -nIoE "$PATTERN" "$f" 2>/dev/null | grep -viE "$PLACEHOLDER" | sed -E 's/^([0-9]+):[^A-Za-z0-9_]?(sk_test_|sk_live_|rk_test_|rk_live_|rk_|skp_|sk-or-).*/\1: \2****/')"; then
    if [ -n "$hits" ]; then
      while IFS= read -r h; do echo "SECRET  $f:$h"; done <<<"$hits"
      found=1
    fi
  fi
  ph="$(grep -nIoE "$PATTERN" "$f" 2>/dev/null | grep -ciE "$PLACEHOLDER" || true)"
  [ "${ph:-0}" -gt 0 ] && echo "ignored $ph placeholder-looking token(s) in $f"
done < <(git ls-files -z --cached --others --exclude-standard)

if [ "$found" = 1 ]; then
  echo "check-secrets: FAIL. Remove the keys above or gitignore the files, then rotate any key that was pushed."
  exit 1
fi
echo "check-secrets: OK ($files files scanned, no sk_test_/sk_live_/rk_/skp_/sk-or- tokens)"
