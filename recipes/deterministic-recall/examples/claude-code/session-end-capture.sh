#!/usr/bin/env bash
set -euo pipefail

# Claude Code SessionEnd hook: capture one compact session summary.
: "${OPEN_BRAIN_MCP_URL:?Set OPEN_BRAIN_MCP_URL to the remote MCP HTTP endpoint}"
: "${OPEN_BRAIN_ACCESS_KEY:?Set OPEN_BRAIN_ACCESS_KEY in the hook environment}"

summary="${SESSION_SUMMARY:-${1:-}}"
if [[ -z "$summary" ]]; then
  summary="$(cat)"
fi
if [[ -z "$summary" ]]; then
  echo "No session summary supplied; nothing captured." >&2
  exit 0
fi

node -e 'const fs = require("fs"); const summary = fs.readFileSync(0, "utf8").trim(); const payload = {jsonrpc:"2.0", id:"capture-end", method:"tools/call", params:{name:"capture_thought", arguments:{content:`Session summary (generated; evidence pending confirmation):\n${summary}`}}}; process.stdout.write(JSON.stringify(payload));' \
  <<<"$summary" \
  | curl --fail-with-body --silent --show-error \
    -X POST "$OPEN_BRAIN_MCP_URL" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -H "x-brain-key: $OPEN_BRAIN_ACCESS_KEY" \
    --data-binary @-
printf '\n'
