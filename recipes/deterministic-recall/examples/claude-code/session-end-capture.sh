#!/usr/bin/env bash
set -euo pipefail

# Claude Code SessionEnd hook. This script proposes a write-back by default;
# it never sends one unless OB_CAPTURE_CONFIRM=auto is explicitly configured.
# The governed path uses memory_writeback, which is evidence-only and pending
# human review. The legacy capture_thought path is deliberately opt-in.

max_chars=4000
confirmation="${OB_CAPTURE_CONFIRM:-required}"
legacy="${OB_CAPTURE_LEGACY:-0}"
workspace_id="${OB_WORKSPACE_ID:-default}"
session_id="${OB_SESSION_ID:-${SESSION_ID:-${CLAUDE_SESSION_ID:-}}}"

summary="${SESSION_SUMMARY:-${1:-}}"
if [[ -z "$summary" ]]; then
  summary="$(cat)"
fi
if [[ -z "$summary" ]]; then
  echo "No session summary supplied; no write-back proposed." >&2
  exit 0
fi

# Do not disclose a potentially sensitive proposed summary. Reject it before
# printing or sending it when it resembles a credential or authorization data.
if [[ "$summary" =~ sk-[A-Za-z0-9_-]+ || "$summary" =~ eyJ[A-Za-z0-9_-]+ || "$summary" =~ -----BEGIN[[:space:]]PRIVATE[[:space:]]KEY----- || "$summary" =~ [Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd][[:space:]]*= || "$summary" =~ [Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]: ]]; then
  echo "Capture abstained: proposed summary contains a sensitive-data pattern; nothing was sent." >&2
  exit 0
fi

if (( ${#summary} > max_chars )); then
  truncation_note=$'\n[Truncated by governance policy: original summary exceeded 4000 characters.]'
  summary="${summary:0:$((max_chars - ${#truncation_note}))}${truncation_note}"
fi

if [[ "$confirmation" != "auto" ]]; then
  echo "Governed capture proposed; awaiting human validation. Set OB_CAPTURE_CONFIRM=auto only after review to send." >&2
  printf '%s\n' "$summary"
  exit 0
fi

if [[ -z "$session_id" ]]; then
  echo "Capture abstained: OB_SESSION_ID, SESSION_ID, or CLAUDE_SESSION_ID is required for an idempotent governed write-back." >&2
  exit 0
fi

: "${OPEN_BRAIN_MCP_URL:?Set OPEN_BRAIN_MCP_URL to the remote MCP HTTP endpoint}"
: "${OPEN_BRAIN_ACCESS_KEY:?Set OPEN_BRAIN_ACCESS_KEY in the hook environment}"

curl_config="$(mktemp)"
trap 'rm -f "$curl_config"' EXIT
chmod 600 "$curl_config"
# Keep the credential in a protected config file, never in curl's argv.
printf 'header = "content-type: application/json"\nheader = "accept: application/json, text/event-stream"\nheader = "x-brain-key: %s"\n' "$OPEN_BRAIN_ACCESS_KEY" >"$curl_config"

if [[ "$legacy" == "1" ]]; then
  echo "WARNING: using legacy capture_thought path; it is non-governed and does not create a pending-review Agent Memory record." >&2
  TOOL_NAME="capture_thought" WORKSPACE_ID="$workspace_id" IDEMPOTENCY_KEY="session-end:${session_id}" node -e '
    const fs = require("fs");
    const summary = fs.readFileSync(0, "utf8").trim();
    process.stdout.write(JSON.stringify({jsonrpc:"2.0", id:"capture-end", method:"tools/call", params:{name:process.env.TOOL_NAME, arguments:{content:`Session summary (generated; legacy non-governed path):\\n${summary}`}}}));
  ' <<<"$summary"
else
  WORKSPACE_ID="$workspace_id" SESSION_ID_VALUE="$session_id" node -e '
    const crypto = require("crypto");
    const fs = require("fs");
    const content = fs.readFileSync(0, "utf8").trim();
    const summary = content.replace(/\s+/g, " ").slice(0, 500);
    const idempotency_key = `session-end:${crypto.createHash("sha256").update(process.env.SESSION_ID_VALUE).digest("hex")}`;
    const payload = {jsonrpc:"2.0", id:"capture-end", method:"tools/call", params:{name:"memory_writeback", arguments:{workspace_id:process.env.WORKSPACE_ID, idempotency_key, memory:{type:"session_summary", summary, content, visibility:"workspace"}, provenance:{status:"generated"}, created_by:"agent"}}};
    process.stdout.write(JSON.stringify(payload));
  ' <<<"$summary"
fi | curl --fail-with-body --silent --show-error --max-time 10 --config "$curl_config" -X POST "$OPEN_BRAIN_MCP_URL" --data-binary @-
printf '\n'
