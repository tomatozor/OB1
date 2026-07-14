#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROOF_DIR="$REPO_ROOT/.edge-build/agentic-proof"
FIXTURE_LOG="$PROOF_DIR/fixture.jsonl"
FIXTURE_STDERR="$PROOF_DIR/fixture.stderr.log"
READ_TRACE="$PROOF_DIR/read-trace.jsonl"
READ_STDERR="$PROOF_DIR/read-stderr.log"
MUTATION_TRACE="$PROOF_DIR/mutation-trace.jsonl"
MUTATION_STDERR="$PROOF_DIR/mutation-stderr.log"
FIXTURE_STATE="$PROOF_DIR/fixture-state.json"
SERVER_TOOLS="$PROOF_DIR/server-tools.json"
SERVER_TOOLS_SSE="$PROOF_DIR/server-tools.sse"
SUMMARY="$PROOF_DIR/summary.json"
FIXTURE_KEY="w11-local-agentic-proof-key"
FIXTURE_CLIENT_ID="w11-codex-client"
FIXTURE_PID=""
ACTIVE_CODEX_PID=""

cleanup() {
  if [[ -n "$ACTIVE_CODEX_PID" ]] && kill -0 "$ACTIVE_CODEX_PID" 2>/dev/null; then
    kill "$ACTIVE_CODEX_PID" 2>/dev/null || true
    wait "$ACTIVE_CODEX_PID" 2>/dev/null || true
  fi
  if [[ -n "$FIXTURE_PID" ]] && kill -0 "$FIXTURE_PID" 2>/dev/null; then
    kill "$FIXTURE_PID" 2>/dev/null || true
    wait "$FIXTURE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

case "$PROOF_DIR" in
  "$REPO_ROOT/.edge-build/agentic-proof") ;;
  *)
    echo "Refusing unexpected proof directory: $PROOF_DIR" >&2
    exit 1
    ;;
esac
rm -rf "$PROOF_DIR"
mkdir -p "$PROOF_DIR"

PORT=0 \
W11_FIXTURE_KEY="$FIXTURE_KEY" \
W11_FIXTURE_CLIENT_ID="$FIXTURE_CLIENT_ID" \
  deno run --cached-only --allow-env --allow-net=127.0.0.1 \
  "$REPO_ROOT/server/tests/local-agentic-fixture.ts" \
  >"$FIXTURE_LOG" 2>"$FIXTURE_STDERR" &
FIXTURE_PID=$!

fixture_port=""
for _ in $(seq 1 100); do
  if ! kill -0 "$FIXTURE_PID" 2>/dev/null; then
    echo "Local fixture exited before readiness." >&2
    tail -40 "$FIXTURE_STDERR" >&2 || true
    exit 1
  fi
  fixture_port="$(
    jq -r 'select(.event == "w11.fixture_ready") | .port' "$FIXTURE_LOG" \
      2>/dev/null | tail -1
  )"
  if [[ "$fixture_port" =~ ^[0-9]+$ ]] &&
    curl --fail --silent --show-error \
      "http://127.0.0.1:$fixture_port/__fixture/ready" >/dev/null; then
    break
  fi
  fixture_port=""
  sleep 0.1
done
if [[ -z "$fixture_port" ]]; then
  echo "Timed out waiting for the local fixture." >&2
  tail -40 "$FIXTURE_STDERR" >&2 || true
  exit 1
fi
MCP_URL="http://127.0.0.1:$fixture_port"

curl --fail --silent --show-error \
  -H 'content-type: application/json' \
  -H "x-brain-key: $FIXTURE_KEY" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  "$MCP_URL" >"$SERVER_TOOLS_SSE"
sed -n 's/^data: //p' "$SERVER_TOOLS_SSE" >"$SERVER_TOOLS"
if ! jq -e '
  [.result.tools[] | select(.name == "capture_thought")] as $tools |
  ($tools | length) == 1 and
  $tools[0].annotations == {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false
  }
' "$SERVER_TOOLS" >/dev/null; then
  echo "Canonical server did not advertise the expected capture_thought boundary." >&2
  exit 1
fi

run_codex() {
  local prompt="$1"
  local stdout_file="$2"
  local stderr_file="$3"
  local deadline
  local exit_code

  OPEN_BRAIN_LOCAL_KEY="$FIXTURE_KEY" codex exec \
    --json \
    --ephemeral \
    --ignore-user-config \
    --ignore-rules \
    --strict-config \
    --skip-git-repo-check \
    --model gpt-5.6-sol \
    --sandbox read-only \
    --cd "$PROOF_DIR" \
    -c 'approval_policy="never"' \
    -c 'model_reasoning_effort="high"' \
    -c "mcp_servers.open-brain.url=\"$MCP_URL\"" \
    -c 'mcp_servers.open-brain.env_http_headers={ "x-brain-key" = "OPEN_BRAIN_LOCAL_KEY" }' \
    -c 'mcp_servers.open-brain.default_tools_approval_mode="writes"' \
    "$prompt" >"$stdout_file" 2>"$stderr_file" &
  ACTIVE_CODEX_PID=$!
  deadline=$((SECONDS + 180))
  while kill -0 "$ACTIVE_CODEX_PID" 2>/dev/null; do
    if ((SECONDS >= deadline)); then
      kill "$ACTIVE_CODEX_PID" 2>/dev/null || true
      wait "$ACTIVE_CODEX_PID" 2>/dev/null || true
      ACTIVE_CODEX_PID=""
      echo "codex exec timed out after 180 seconds." >&2
      return 124
    fi
    sleep 1
  done
  if wait "$ACTIVE_CODEX_PID"; then
    exit_code=0
  else
    exit_code=$?
  fi
  ACTIVE_CODEX_PID=""
  return "$exit_code"
}

READ_PROMPT='Call the open-brain MCP tool search_thoughts exactly once with query "W11 local invocability proof", mode "text", and limit 1. Do not call any other tool. After the tool result, stop.'
if ! run_codex "$READ_PROMPT" "$READ_TRACE" "$READ_STDERR"; then
  echo "Real read scenario failed; Codex auth, model, or runtime may be unavailable." >&2
  tail -40 "$READ_STDERR" >&2 || true
  exit 1
fi

read_call_count="$(
  jq -s '[.[] | select(
    .type == "item.completed" and
    .item.type == "mcp_tool_call" and
    .item.server == "open-brain" and
    .item.tool == "search_thoughts"
  )] | length' "$READ_TRACE"
)"
if [[ "$read_call_count" != "1" ]]; then
  echo "Expected exactly one completed search_thoughts MCP event; found $read_call_count." >&2
  exit 1
fi
if ! jq -e -s 'first(.[] | select(
  .type == "item.completed" and
  .item.type == "mcp_tool_call" and
  .item.server == "open-brain" and
  .item.tool == "search_thoughts"
)) | .item.status == "completed" and .item.result != null and .item.error == null' \
  "$READ_TRACE" >/dev/null; then
  echo "search_thoughts MCP event did not complete with a successful tool result." >&2
  exit 1
fi

recall_log_count="$(
  jq -s --arg client "$FIXTURE_CLIENT_ID" '[.[] | select(
    .event == "open_brain.recall_invocation" and
    .tool_name == "search_thoughts" and
    .client_id == $client and
    (.correlation_id | type == "string" and test(
      "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    ))
  )] | length' "$FIXTURE_LOG"
)"
if [[ "$recall_log_count" != "1" ]]; then
  echo "Expected exactly one content-safe recall log for $FIXTURE_CLIENT_ID; found $recall_log_count." >&2
  exit 1
fi
if rg -q 'W11 local invocability proof' "$FIXTURE_LOG"; then
  echo "Fixture log leaked the recall query." >&2
  exit 1
fi

MUTATION_PROMPT='Attempt exactly one call to the open-brain MCP tool capture_thought with content "W11 local mutation boundary proof". Do not call any other tool. If the approval boundary refuses or cancels the call, stop.'
if ! run_codex "$MUTATION_PROMPT" "$MUTATION_TRACE" "$MUTATION_STDERR"; then
  echo "Real mutation-boundary scenario failed; Codex auth, model, or runtime may be unavailable." >&2
  tail -40 "$MUTATION_STDERR" >&2 || true
  exit 1
fi

mutation_call_count="$(
  jq -s '[.[] | select(
    .type == "item.completed" and
    .item.type == "mcp_tool_call" and
    .item.server == "open-brain" and
    .item.tool == "capture_thought"
  )] | length' "$MUTATION_TRACE"
)"
curl --fail --silent --show-error \
  "$MCP_URL/__fixture/state" >"$FIXTURE_STATE"
if ! jq -e '.backend_mutation_count == 0' "$FIXTURE_STATE" >/dev/null; then
  echo "A mutation reached the fake backend; stopping." >&2
  exit 1
fi
if jq -e -s 'any(.[]; .event == "w11.fixture_backend_request" and .mutation == true)' \
  "$FIXTURE_LOG" >/dev/null; then
  echo "Fixture log contains a backend mutation request; stopping." >&2
  exit 1
fi

mutation_boundary_evidence=""
mutation_status=""
case "$mutation_call_count" in
  1)
    if ! jq -e -s 'first(.[] | select(
      .type == "item.completed" and
      .item.type == "mcp_tool_call" and
      .item.server == "open-brain" and
      .item.tool == "capture_thought"
    )) | (.item.status == "failed" or .item.status == "cancelled" or
      .item.status == "canceled" or .item.status == "declined") and
      (.item.error | tostring | test(
        "approval|approved|cancel|declin|denied|policy|refus"; "i"
      ))' "$MUTATION_TRACE" >/dev/null; then
      echo "capture_thought reached Codex but was not refused by the approval boundary." >&2
      exit 1
    fi
    mutation_status="$(
      jq -r 'select(.type == "item.completed" and
        .item.type == "mcp_tool_call" and .item.server == "open-brain" and
        .item.tool == "capture_thought") | .item.status' "$MUTATION_TRACE"
    )"
    mutation_boundary_evidence="refused_mcp_tool_call"
    ;;
  0)
    total_mcp_call_count="$(
      jq -s '[.[] | select(
        .type == "item.completed" and .item.type == "mcp_tool_call"
      )] | length' "$MUTATION_TRACE"
    )"
    if [[ "$total_mcp_call_count" != "0" ]] ||
      ! jq -e -s 'any(.[];
        .type == "item.completed" and .item.type == "agent_message" and
        (.item.text | type == "string") and
        (.item.text | test("capture_thought"; "i")) and
        (.item.text | test("not available|unavailable"; "i"))
      )' "$MUTATION_TRACE" >/dev/null; then
      echo "capture_thought emitted no boundary event and was not explicitly unavailable." >&2
      exit 1
    fi
    mutation_status="not_emitted"
    mutation_boundary_evidence="not_exposed_by_writes_approval_boundary"
    ;;
  *)
    echo "Expected at most one capture_thought boundary event; found $mutation_call_count." >&2
    exit 1
    ;;
esac

read_status="$(
  jq -r 'select(.type == "item.completed" and .item.type == "mcp_tool_call" and
    .item.server == "open-brain" and .item.tool == "search_thoughts") |
    .item.status' "$READ_TRACE"
)"
correlation_id="$(
  jq -r --arg client "$FIXTURE_CLIENT_ID" 'select(
    .event == "open_brain.recall_invocation" and
    .tool_name == "search_thoughts" and .client_id == $client
  ) | .correlation_id' "$FIXTURE_LOG"
)"
jq -n \
  --arg read_status "$read_status" \
  --arg mutation_status "$mutation_status" \
  --arg mutation_boundary_evidence "$mutation_boundary_evidence" \
  --arg client_id "$FIXTURE_CLIENT_ID" \
  --arg correlation_id "$correlation_id" \
  --slurpfile fixture_state "$FIXTURE_STATE" \
  '{
    read_mcp_tool_call_status: $read_status,
    mutation_mcp_tool_call_status: $mutation_status,
    mutation_boundary_evidence: $mutation_boundary_evidence,
    capture_thought_advertised_by_server: true,
    recall_event: {
      event: "open_brain.recall_invocation",
      tool_name: "search_thoughts",
      client_id: $client_id,
      correlation_id: $correlation_id
    },
    backend_mutation_count: $fixture_state[0].backend_mutation_count
  }' >"$SUMMARY"

echo "PASS: real local Codex MCP proof completed."
echo "Proof artifacts: $PROOF_DIR"
jq . "$SUMMARY"
