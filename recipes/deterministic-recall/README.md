# Task-Aware Recall

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

1. **Start:** call `search_thoughts` with a compact query derived from the task.
2. **Work:** use the result as scoped evidence while doing the task.
3. **End:** propose a compact session summary for human review. A governed
   write-back happens only after explicit validation.

`search_thoughts` is the relevance path. `recall_context` remains a deterministic,
SQL-only ambient fallback for clients that cannot provide a task query. It
normalizes topic/person labels and diversifies result types and sources so one
capture stream cannot monopolize the context window.

## Prerequisites

- A working Open Brain MCP v2 deployment with `search_thoughts`,
  `recall_context`, and, for
  governed write-back, `memory_writeback` ([setup guide](../../docs/01-getting-started.md)).
- A remote MCP HTTP URL and access key. Send the key in `x-brain-key` or
  `Authorization: Bearer ...`; never put it in a URL.
- Node.js 18+ and `curl` for the included examples and parity check.

## Common Protocol

All query-capable clients use these defaults unless the user explicitly
requests a narrower scope:

```json
{
  "query": "<4-12 discriminating words from the current task>",
  "mode": "hybrid",
  "limit": 6,
  "threshold": 0.3
}
```

Include known project, client, person, feature, and failure terms. Avoid generic
query padding such as "context" or "memory". If `search_thoughts` is absent,
call `recall_context(days=30, limit=6, min_importance=2)` and add
`scope_topics`/`scope_people` when the task gives a clear scope. Scope labels
are normalized and use OR semantics within each category. Restricted and
logically deleted thoughts remain excluded by the server's normal read policy.

### Supersedes and contradictions

If the server filters superseded facts, record that in the recall trace. If it
does not, prefer the most recent fact when two returned memories contradict one
another, and surface the contradiction when it affects an action. Recall is
evidence by default: inferred or generated memories are not instruction-grade
without human confirmation or trusted import.

Write back only a compact summary of decisions, outputs, lessons, constraints,
unresolved questions, or next steps. Do not write raw transcripts, hidden
reasoning, credentials, private customer data, or large code blocks.

## Write-back governance

The included SessionEnd hook is safe by default: `OB_CAPTURE_CONFIRM=required`
means it sends nothing and prints the proposed summary for human validation.
It rejects common credential and authorization patterns before printing or
sending, caps a proposed summary at 4,000 characters with an explicit
truncation note, and never puts the access key in `curl` arguments. Network
requests have a 10-second timeout.

After a human has reviewed the proposal, set `OB_CAPTURE_CONFIRM=auto` for the
specific hook invocation. The governed path requires `OB_SESSION_ID`,
`SESSION_ID`, or `CLAUDE_SESSION_ID`, accepts an optional `OB_WORKSPACE_ID`
(default `default`), and calls `memory_writeback`. Its idempotency key is a
SHA-256 derivation of the session id. The server records generated content as
evidence-only with `review_status=pending`; the hook does not claim that it was
confirmed.

### Memory type contract

`memory_writeback.memory.type` must be one of the MCP enum's eight valid
values: `decision`, `output`, `lesson`, `constraint`, `open_question`,
`failure`, `artifact_reference`, or `work_log`. The SessionEnd hook writes a
generated session recap as `work_log`; `session_summary` is not a valid MCP
type.

`OB_CAPTURE_LEGACY=1` together with `OB_CAPTURE_CONFIRM=auto` switches to
`capture_thought`. This is a non-governed compatibility path: it does not
create a pending-review Agent Memory record and must be used only when that
risk is explicitly accepted. It is never enabled by default.

## Step-by-step SessionEnd verification

1. Run the hook without `OB_CAPTURE_CONFIRM=auto` and provide a non-sensitive
   summary through `SESSION_SUMMARY`, its first argument, or standard input.
2. Review the printed proposal and ensure it does not contain credentials,
   private data, raw transcript content, or hidden reasoning.
3. Only after that review, rerun the specific invocation with
   `OB_CAPTURE_CONFIRM=auto` and a stable session id.

## Expected outcome

The default invocation sends no write-back. A reviewed automatic invocation
creates one evidence-only, pending-review `work_log` with an idempotency key
derived from the session id.

## Enforcement & measurement

### Rule 9 — fail open, measure the outcome

The Claude Code `SessionStart` hook is runtime enforcement: Claude Code runs
it automatically at session start. It attempts the deterministic
`recall_context` request once plus up to two timeout retries, logs a compact
timestamped success or failure record in `~/.local/state/openbrain/recall.log`,
and always exits `0` so an unavailable recall service never blocks a session.
Codex CLI has no equivalent automatic hook; its `AGENTS.md` block requires a
first-turn self-check and the explicit phrase `recall non effectué` if recall
was missed.

Server evidence measures the outcome across both clients. With a local,
uncommitted service-role env file:

```dotenv
OPEN_BRAIN_URL=https://YOUR_PROJECT_REF.supabase.co
OPEN_BRAIN_SERVICE_KEY=replace-locally
# Optional: limits Agent Memory rows and recall traces to one workspace.
OPEN_BRAIN_WORKSPACE=default
```

run:

```bash
node examples/recall-coverage.mjs --env-file .env.openbrain --days 7 --min-coverage 0.8
```

The script reads only PostgREST rows and prints aggregate counts plus JSON; it
never prints memory, query, or recap content. It counts captured sessions as
`thoughts.type=session_recap` plus `agent_memories.memory_type=work_log`, and
reads persisted recalls from `agent_memory_recall_traces`. Coverage is:

```text
UTC capture dates with at least one persisted recall trace
----------------------------------------------------------
all UTC capture dates
```

The command exits non-zero when the ratio is below `--min-coverage` (default
`0.8`), and lists the capture dates without a recall trace. The deployed v2
server persists Agent Memory `memory_recall` traces; `recall_context` currently
emits application observability but does not insert this table. Therefore the
coverage gate is a conservative, measurable floor rather than proof of every
unpersisted `recall_context` call. Pair it with Claude's local `recall.log`
when auditing hook enforcement.

## Install by Client

### Claude Code

Copy the two scripts from [`examples/claude-code/`](examples/claude-code/) to a
user-owned executable directory, set the two environment variables in the hook
environment, and register them as `SessionStart` and `SessionEnd` hooks. The
start script posts this exact request and prints the response for injection:

```json
{"jsonrpc":"2.0","id":"recall-start","method":"tools/call","params":{"name":"recall_context","arguments":{"days":30,"limit":6,"min_importance":2}}}
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

`SessionEnd` reads `SESSION_SUMMARY`, its first argument, or stdin. By default
it proposes the capped, non-sensitive summary and sends nothing. After human
validation, `OB_CAPTURE_CONFIRM=auto` sends it through `memory_writeback`;
`OB_CAPTURE_LEGACY=1` is the explicitly non-governed `capture_thought`
fallback. Keep `OPEN_BRAIN_ACCESS_KEY` in the process environment or a local
secret manager; do not place it in a committed settings file or command line.

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
At the first substantive task, call search_thoughts with a compact query built
from the project, client, person, feature, and failure terms in the request;
use mode=hybrid, limit=6, and threshold=0.3. Treat only relevant results as
evidence. If search_thoughts is unavailable, call recall_context with days=30,
limit=6, and min_importance=2 as ambient fallback. At the end of
a significant session, propose a compact summary for human validation; never
send it automatically. When a validated write-back is requested, prefer
memory_writeback with generated provenance and an idempotency key so it starts
evidence-only and pending review. Do not store raw transcripts, hidden
reasoning, secrets, private customer data, or large code blocks. If facts
conflict, prefer the most recent one unless the server reports supersedes
filtering; surface action-changing contradictions.
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
only when the returned MCP results are identical. `--key` remains available
only for compatibility and prints a deprecation warning because command-line
arguments can expose credentials; use `OPEN_BRAIN_ACCESS_KEY` or
`MCP_ACCESS_KEY` instead. Requests time out after 10 seconds.

## Expected Outcome

Every query-capable client performs the same task-aware hybrid search
(`limit=6`, `threshold=0.3`) and can explain which returned items informed the
work. Queryless clients use the same compact ambient fallback
(`days=30`, `limit=6`, `min_importance=2`).
Significant sessions produce a human-reviewed proposal; validated governed
write-backs become evidence-only pending records, while secrets and raw traces
remain out of the brain.

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

**A session summary is not sent.** This is the default. Review the proposal,
then invoke the hook with `OB_CAPTURE_CONFIRM=auto`, a session id, and a
working `memory_writeback` tool. Use the legacy switch only with explicit
acceptance of its non-governed behavior.
