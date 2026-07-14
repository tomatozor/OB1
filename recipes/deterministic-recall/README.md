# Deterministic Recall

This recipe makes Open Brain context recall consistent across Claude Code,
Codex CLI, ChatGPT, and any other MCP client. The client-specific integration
changes, but the request shape and the three-step protocol stay the same.

> [!NOTE]
> Built by Nate B. Jones / OB1. For practical systems and implementation notes,
> see [Nate's Substack](https://substack.com/@natesnewsletter) and
> [natebjones.com](https://natebjones.com).

## What It Does

The problem is uneven continuity: Claude Code may inject Open Brain context
from session hooks while Codex CLI has no equivalent instruction unless its
agent configuration provides one. This recipe standardizes the behavior:

1. **Start:** call `recall_context` with the common defaults.
2. **Work:** use the result as scoped evidence while doing the task.
3. **End:** call `capture_thought` with a compact session summary when the
   session was significant.

`recall_context` is deterministic SQL-only retrieval. With the same explicit
parameters and unchanged data, it returns the same ordered result: importance
descending, then `created_at` descending, then `id`.

## Prerequisites

- A working Open Brain MCP v2 deployment with `recall_context` and
  `capture_thought` ([setup guide](../../docs/01-getting-started.md)).
- A remote MCP HTTP URL and access key. Send the key in `x-brain-key` or
  `Authorization: Bearer ...`; never put it in a URL.
- Node.js 18+ and `curl` for the included examples and parity check.

## Common Protocol

All clients use these defaults unless the user explicitly requests a narrower
scope:

```json
{
  "days": 30,
  "limit": 12,
  "min_importance": 0
}
```

`scope_topics` and `scope_people` may be added when the task gives a clear
scope. Keep them explicit and identical across retries or client adapters.
Restricted and logically deleted thoughts remain excluded by the server's
normal read policy; do not bypass that policy just to improve recall.

### Supersedes and contradictions

If the server filters superseded facts, record that in the recall trace. If it
does not, prefer the most recent fact when two returned memories contradict one
another, and surface the contradiction when it affects an action. Recall is
evidence by default: inferred or generated memories are not instruction-grade
without human confirmation or trusted import.

Write back only a compact summary of decisions, outputs, lessons, constraints,
unresolved questions, or next steps. Do not write raw transcripts, hidden
reasoning, credentials, private customer data, or large code blocks.

## Install by Client

### Claude Code

Copy the two scripts from [`examples/claude-code/`](examples/claude-code/) to a
user-owned executable directory, set the two environment variables in the hook
environment, and register them as `SessionStart` and `SessionEnd` hooks. The
start script posts this exact request and prints the response for injection:

```json
{"jsonrpc":"2.0","id":"recall-start","method":"tools/call","params":{"name":"recall_context","arguments":{"days":30,"limit":12,"min_importance":0}}}
```

Example hook command entries (adapt the surrounding settings schema to the
Claude Code version in use):

```json
{
  "hooks": {
    "SessionStart": [{"command": "/PATH/session-start-recall.sh"}],
    "SessionEnd": [{"command": "/PATH/session-end-capture.sh"}]
  }
}
```

`SessionEnd` reads `SESSION_SUMMARY`, its first argument, or stdin and sends it
to `capture_thought`. Keep `OPEN_BRAIN_ACCESS_KEY` in the process environment
or a local secret manager; do not place it in a committed settings file.

### Codex CLI

Paste [`examples/codex/AGENTS-block.md`](examples/codex/AGENTS-block.md) into
the relevant `AGENTS.md`. It requires the first-turn recall and the end-of-
significant-session write-back, while preserving the same defaults and
provenance rules.

Configure the remote MCP HTTP connector in the Codex CLI configuration:

```json
{
  "mcpServers": {
    "open-brain": {
      "type": "http",
      "url": "https://YOUR_PROJECT_REF.supabase.co/functions/v1/open-brain-mcp",
      "headers": {"x-brain-key": "YOUR_OPEN_BRAIN_ACCESS_KEY"}
    }
  }
}
```

Replace placeholders locally, then verify that both tools are listed. The
connector configuration path can vary by Codex CLI release; the protocol does
not depend on that path.

### ChatGPT and other MCP clients

Connect the same remote HTTP MCP endpoint and make this the client instruction
or workflow preamble:

```text
At session start, call recall_context with days=30, limit=12,
min_importance=0. Use the returned memories as scoped evidence. At the end of
a significant session, call capture_thought with a compact summary of
decisions, outputs, lessons, constraints, unresolved questions, or next steps.
Do not store raw transcripts, hidden reasoning, secrets, private customer data,
or large code blocks. If facts conflict, prefer the most recent one unless the
server reports supersedes filtering; surface action-changing contradictions.
```

For a client that cannot speak MCP, the advanced Agent Memory API is an option:
use `integrations/agent-memory-api`'s REST `/recall`, `/writeback`, and
`/recall/:id/usage` endpoints with the same explicit recall defaults and the
same provenance rules. Keep the MCP protocol as the canonical shape when the
client supports it.

## Verify parity

Use a local, uncommitted env file (never commit it):

```dotenv
OPEN_BRAIN_MCP_URL=https://YOUR_PROJECT_REF.supabase.co/functions/v1/open-brain-mcp
OPEN_BRAIN_ACCESS_KEY=replace-locally
```

Then run:

```bash
node examples/verify-recall-parity.mjs --env-file .env.recall
```

The script calls `recall_context` twice with the same parameters and exits `0`
only when the returned MCP results are identical. `--help` documents the
alternative `--url` and `--key` flags.

## Expected Outcome

Every client performs the same initial recall (`days=30`, `limit=12`,
`min_importance=0`) and can explain which recalled items informed the work.
Significant sessions leave one compact `capture_thought` summary, while
secrets and raw traces remain out of the brain.

## Troubleshooting

**`recall_context` is not visible.** Confirm that the connected server is MCP
v2 and that the connector points to the remote HTTP endpoint, not a local
server. Reconnect and check the tool list.

**The hook returns HTTP 401.** Check the exact access key and use the
`x-brain-key` header or a Bearer header. Do not add the key as a query
parameter.

**Parity verification reports different results.** Confirm the dataset did not
change between calls, that both calls use the explicit common defaults, and
that no client-side filtering or formatting is being applied. If the data is
changing, rerun against a quiet instance and inspect the returned ordering.

**A session summary is not captured.** Supply `SESSION_SUMMARY`, a first
argument, or stdin to `session-end-capture.sh`, and check that
`capture_thought` is exposed and the hook process can reach the MCP URL.
