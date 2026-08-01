#!/usr/bin/env bash
set -u

# Claude Code SessionStart hook: print the deterministic recall as context.
# Set OPEN_BRAIN_MCP_URL and OPEN_BRAIN_ACCESS_KEY in the hook environment.
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/openbrain"
log_file="$state_dir/recall.log"

log_result() {
  mkdir -p "$state_dir" 2>/dev/null || return 0
  printf '%s session-start-recall status=%s attempts=%s detail=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" >>"$log_file" 2>/dev/null || true
}

if [[ -z "${OPEN_BRAIN_MCP_URL:-}" || -z "${OPEN_BRAIN_ACCESS_KEY:-}" ]]; then
  printf '%s\n' 'Open Brain recall hook failed: OPEN_BRAIN_MCP_URL or OPEN_BRAIN_ACCESS_KEY is not configured; continuing without injected recall.' >&2
  log_result "failure" "0" "missing_environment"
  exit 0
fi

payload='{"jsonrpc":"2.0","id":"recall-start","method":"tools/call","params":{"name":"recall_context","arguments":{"days":30,"limit":6,"min_importance":2}}}'
curl_config="$(mktemp)"
trap 'rm -f "$curl_config"' EXIT
chmod 600 "$curl_config"
# Keep the credential out of curl's argv and shell history.
printf 'header = "content-type: application/json"\nheader = "accept: application/json, text/event-stream"\nheader = "x-brain-key: %s"\n' "$OPEN_BRAIN_ACCESS_KEY" >"$curl_config"
response_file="$(mktemp)"
trap 'rm -f "$curl_config" "$response_file"' EXIT
attempt=0
curl_status=1
while (( attempt < 3 )); do
  ((attempt += 1))
  if curl --fail-with-body --silent --show-error --max-time "${OB_RECALL_TIMEOUT_SECONDS:-10}" \
    --config "$curl_config" \
    -X POST "$OPEN_BRAIN_MCP_URL" \
    --data "$payload" >"$response_file"; then
    curl_status=0
    break
  else
    curl_status=$?
  fi
  # Curl 28 is a timeout. Retry it twice with a short linear backoff.
  if [[ "$curl_status" -eq 28 && "$attempt" -lt 3 ]]; then
    sleep "$attempt"
  else
    break
  fi
done

if [[ "$curl_status" -ne 0 ]]; then
  printf '%s\n' "Open Brain recall hook failed after $attempt attempt(s) (curl exit $curl_status); continuing without injected recall." >&2
  log_result "failure" "$attempt" "curl_exit_$curl_status"
  exit 0
fi
response="$(<"$response_file")"
log_result "success" "$attempt" "mcp_response"

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
