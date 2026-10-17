#!/bin/sh
# After a deploy: the home page and one tool page answer 200, and the tool page shows bellman_start's
# <role> as text. Usage: sh ./smoke.sh [base URL], https://docs.bellman.sh by default. A new custom
# domain can take minutes to answer, so each page gets TRIES attempts (default 30), ten seconds apart.
set -eu
base=${1:-https://docs.bellman.sh}
tries=${TRIES:-30}
for path in / /reference/tools/bellman_start/; do
  n=0
  while :; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$base$path" || true)
    [ "$code" = "200" ] && break
    n=$((n + 1))
    [ "$n" -ge "$tries" ] && { echo "::error::$base$path answered $code"; exit 1; }
    sleep 10
  done
done
curl -sf "$base/reference/tools/bellman_start/" | grep -q '&lt;role&gt;' \
  || { echo "::error::$base/reference/tools/bellman_start/ does not show <role> as text"; exit 1; }
echo "smoke: $base serves the home page and bellman_start"
