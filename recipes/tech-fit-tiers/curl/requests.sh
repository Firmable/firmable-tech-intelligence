#!/usr/bin/env bash
# The requests the tech-fit-tiers recipe makes, one company at a time.
# Reads the key from FIRMABLE_API_KEY. Nothing here runs on install.
# Tech Intel spends credits: up to 5 the first time you get a company. Further pages without
# evidence are free. With withEvidence=true (with_evidence in the config) every page also costs 0.2
# credits and holds 10 technologies instead of 100.
set -euo pipefail
: "${FIRMABLE_API_KEY:?Set FIRMABLE_API_KEY to your developer API key}"
API="https://api.firmable.com"
DOMAIN="${1:-canva.com}"

echo "1. First page of Tech Intel (up to 5 credits once per company)"
PAGE=$(curl -sS -G "$API/tech-intel" --data-urlencode "fqdn=$DOMAIN" -H "Authorization: Bearer $FIRMABLE_API_KEY")
echo "$PAGE" | head -c 1200; echo
CURSOR=$(echo "$PAGE" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("next_cursor") or "")')

if [ -n "$CURSOR" ]; then
  echo "2. Next page with the same identifier and the cursor (free without evidence)"
  curl -sS -G "$API/tech-intel" --data-urlencode "fqdn=$DOMAIN" --data-urlencode "cursor=$CURSOR" \
    -H "Authorization: Bearer $FIRMABLE_API_KEY" | head -c 1200
  echo
else
  echo "2. No next_cursor: the first page held every technology."
fi

echo "3. Optional: first page with evidence (0.2 credits for the evidence request; used when with_evidence is true)"
curl -sS -G "$API/tech-intel" --data-urlencode "fqdn=$DOMAIN" --data-urlencode "withEvidence=true" \
  -H "Authorization: Bearer $FIRMABLE_API_KEY" | head -c 1200
echo
