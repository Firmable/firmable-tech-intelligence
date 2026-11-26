#!/usr/bin/env bash
# The requests the integration-audience-map recipe makes, one company at a time.
# Reads the key from FIRMABLE_API_KEY. Nothing here runs on install.
# Tech Intel spends credits: up to 5 the first time you get a company. Further pages without
# evidence are free. Companies your organisation already paid for cost nothing.
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

echo "3. The same company by Firmable ID (the id field of the first response)"
echo "   curl -sS -G \"$API/tech-intel\" --data-urlencode \"id=<firmable id>\" -H \"Authorization: Bearer \$FIRMABLE_API_KEY\""
