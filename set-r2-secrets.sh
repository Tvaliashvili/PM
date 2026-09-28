#!/usr/bin/env bash
# Pushes the R2 credentials in .r2.env to Supabase, trimming any stray
# whitespace or quotes - a secret with a space in it builds a hostname the
# browser cannot resolve. Run from the project root: bash set-r2-secrets.sh
set -euo pipefail
cd "$(dirname "$0")"
[ -f .r2.env ] || { echo ".r2.env not found"; exit 1; }

trim() { printf '%s' "$1" | tr -d '\r\n"'"'"' ' ; }
while IFS='=' read -r key value; do
  case "$key" in R2_*) eval "$key=\$(trim \"\$value\")" ;; esac
done < .r2.env

: "${R2_ACCOUNT_ID:?missing in .r2.env}" "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}"
echo "Account id: ${#R2_ACCOUNT_ID} chars (should be 32)"

npx --yes supabase@latest secrets set \
  "R2_ACCOUNT_ID=$R2_ACCOUNT_ID" \
  "R2_BUCKET=site-photos" \
  "R2_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID" \
  "R2_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY"

npx --yes supabase@latest functions deploy photo-url
