#!/usr/bin/env bash
# The request the ecosystem-explorer recipe makes for each company in the cohort.
# Reads the key from FIRMABLE_API_KEY. Nothing here runs on install.
# Tech Intel spends credits: up to 5 the first time your organisation gets a company, then later
# pages and repeat calls for that company are free. With withEvidence=true every page also costs 0.2.
set -euo pipefail
: "${FIRMABLE_API_KEY:?Set FIRMABLE_API_KEY to your developer API key}"
API="https://api.firmable.com"
DOMAIN="${1:-canva.com}"

echo "1. First page of Tech Intel by domain (up to 5 credits once per company)"
PAGE=$(curl -sS -G "$API/tech-intel" --data-urlencode "fqdn=$DOMAIN" -H "Authorization: Bearer $FIRMABLE_API_KEY")
echo "$PAGE" | head -c 1200; echo
CURSOR=$(echo "$PAGE" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("next_cursor") or "")')

if [ -n "$CURSOR" ]; then
  echo "2. Next page with the same identifier and the cursor (free without evidence; used when max_pages is above 1)"
  curl -sS -G "$API/tech-intel" --data-urlencode "fqdn=$DOMAIN" --data-urlencode "cursor=$CURSOR" \
    -H "Authorization: Bearer $FIRMABLE_API_KEY" | head -c 1200
  echo
else
  echo "2. No next_cursor: the first page held every technology."
fi

echo "3. A row with a Firmable company ID instead of a domain uses id= (same price)"
echo "   curl -sS -G \"$API/tech-intel\" --data-urlencode \"id=f000000740279\" -H \"Authorization: Bearer \$FIRMABLE_API_KEY\""
