#!/usr/bin/env bash
# The requests the stack-comparison recipe makes, one company at a time.
# Reads the key from FIRMABLE_API_KEY. Nothing here runs on install.
# Tech Intel spends credits: up to 5 the first time your organisation gets a company, then later
# pages and repeat calls for that company are free. With withEvidence=true every page also costs 0.2.
set -euo pipefail
: "${FIRMABLE_API_KEY:?Set FIRMABLE_API_KEY to your developer API key}"
API="https://api.firmable.com"

for DOMAIN in "${@:-canva.com atlassian.com}"; do
  for D in $DOMAIN; do
    echo "First page of Tech Intel for $D (up to 5 credits once per company)"
    PAGE=$(curl -sS -G "$API/tech-intel" --data-urlencode "fqdn=$D" -H "Authorization: Bearer $FIRMABLE_API_KEY")
    echo "$PAGE" | head -c 800; echo
    CURSOR=$(echo "$PAGE" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("next_cursor") or "")')
    if [ -n "$CURSOR" ]; then
      echo "Next page for $D with the cursor (free without evidence; the recipe reads up to max_pages pages)"
      curl -sS -G "$API/tech-intel" --data-urlencode "fqdn=$D" --data-urlencode "cursor=$CURSOR" \
        -H "Authorization: Bearer $FIRMABLE_API_KEY" | head -c 800
      echo
    else
      echo "No next_cursor: the first page held every technology for $D."
    fi
  done
done
