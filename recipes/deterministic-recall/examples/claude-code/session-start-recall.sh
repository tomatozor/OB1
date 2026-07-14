#!/usr/bin/env bash
set -euo pipefail

# Claude Code SessionStart hook: print the deterministic recall as context.
# Set OPEN_BRAIN_MCP_URL and OPEN_BRAIN_ACCESS_KEY in the hook environment.
: "${OPEN_BRAIN_MCP_URL:?Set OPEN_BRAIN_MCP_URL to the remote MCP HTTP endpoint}"
: "${OPEN_BRAIN_ACCESS_KEY:?Set OPEN_BRAIN_ACCESS_KEY in the hook environment}"

payload='{"jsonrpc":"2.0","id":"recall-start","method":"tools/call","params":{"name":"recall_context","arguments":{"days":30,"limit":12,"min_importance":0}}}'
curl_config="$(mktemp)"
trap 'rm -f "$curl_config"' EXIT
chmod 600 "$curl_config"
# Keep the credential out of curl's argv and shell history.
printf 'header = "content-type: application/json"\nheader = "accept: application/json, text/event-stream"\nheader = "x-brain-key: %s"\n' "$OPEN_BRAIN_ACCESS_KEY" >"$curl_config"
response="$(curl --fail-with-body --silent --show-error --max-time 10 \
  --config "$curl_config" \
  -X POST "$OPEN_BRAIN_MCP_URL" \
  --data "$payload")"

# MCP Streamable HTTP may return JSON or an SSE data frame. Keep hook output
# readable and let Claude inject it as session context.
printf '%s\n' "$response" | node -e '
let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const frame = input.split(/\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).pop();
  try {
    const value = JSON.parse(frame || input);
    const text = value?.result?.content?.map(item => item.text || "").filter(Boolean).join("\n") || JSON.stringify(value?.result ?? value, null, 2);
    process.stdout.write(text + "\n");
  } catch {
    process.stdout.write(input);
  }
});'
