## Open Brain deterministic recall

At the first turn of every session, always call the Open Brain MCP v2 tool
`recall_context` before doing substantive work. Before sending the first
substantive response, self-check that this happened. If it did not, state
explicitly in that response: **"recall non effectué"**, then apply the
transitional availability policy below. Use these exact defaults unless
the user explicitly asks for a narrower scope:

```json
{
  "days": 30,
  "limit": 12,
  "min_importance": 0
}
```

You may add explicit `scope_topics` or `scope_people` when the task provides
them. Treat returned memories as evidence unless their provenance and review
state make them instruction-grade. If memories contradict one another, prefer
the most recent item; if the server exposes supersedes filtering, note that
filtering in the recall trace.

Before concluding a significant session, propose one compact, professional
summary of decisions, outputs, lessons, constraints, unresolved questions, or
next steps for human review. Never send a write-back without explicit human
validation. Do not capture raw transcripts, hidden reasoning, credentials,
private customer data, or large code blocks.

When a validated write-back is requested and `memory_writeback` is available,
prefer it to `capture_thought`. Supply a workspace-scoped idempotency key and
`provenance.status="generated"`; that tool creates evidence-only memory in
`pending` review and requires confirmation before it can become
instruction-grade. `capture_thought` is a legacy, non-governed fallback and
must not be presented as a confirmation workflow.

Configure the Open Brain MCP connector as a remote HTTP server in
`~/.codex/config.toml`. Replace the placeholders locally; never commit the
access key:

```toml
[mcp_servers.open-brain]
url = "https://YOUR_PROJECT_REF.supabase.co/functions/v1/open-brain-mcp"

[mcp_servers.open-brain.http_headers]
x-brain-key = "YOUR_OPEN_BRAIN_ACCESS_KEY"
```

Check the MCP section of the Codex CLI documentation for your installed
version — key names for remote HTTP servers have evolved across releases.

Tool availability is not guaranteed to match this protocol's ideal set.
Apply this transitional policy, in order:

1. If `recall_context` is visible, call it first with the shared defaults.
2. Otherwise, if `search_thoughts` is visible, call it with a query built
   from the task at hand.
3. Otherwise, continue the task and state explicitly that Open Brain recall
   was unavailable.

Recall is mandatory before substantive work; never write back sensitive data
automatically. Once the v2 server is deployed, step 1 applies without any
edit to this file.

### Coverage audit

When PostgREST service credentials are available, measure the runtime outcome
rather than relying on this instruction alone:

```bash
node examples/recall-coverage.mjs --env-file .env.openbrain --days 7 --min-coverage 0.8
```

The report counts legacy `thoughts` with `type=session_recap`, Agent Memory
`work_log` captures, and persisted `agent_memory_recall_traces`. Its coverage
is the share of UTC dates with a capture that also have at least one persisted
recall trace. `recall_context` currently has application-level observability,
but does not itself write `agent_memory_recall_traces`; do not claim that this
script proves those unpersisted calls.
