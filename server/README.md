# Open Brain MCP server v2

This stateless MCP endpoint authenticates requests only with `x-brain-key` or
`Authorization: Bearer <key>`. URL query parameters are never accepted for
authentication.

## Tools

- `search(query)` and `fetch(id)` preserve the ChatGPT search/fetch contract.
- `search_thoughts(query, mode="hybrid", limit=10, offset=0, type?, source_type?, min_importance?, start_date?, end_date?, include_restricted=false, threshold=0.5)`
  provides filtered retrieval. Hybrid mode calls `hybrid_search_thoughts` first,
  then uses semantic/text RRF (`k=60`) only when that RPC is absent. The caller's
  `threshold` applies to the semantic fallback leg. Dates must be parseable by
  `Date.parse`. Pagination includes `has_more` when a page-plus-one read can
  determine it.
- `recall_context(scope_topics?, scope_people?, days=30, limit=12, min_importance=0, include_restricted=false)`
  performs deterministic SQL-only recall and excludes thoughts targeted by a
  current `supersedes` edge (`valid_until IS NULL`). It over-reads a bounded
  candidate set to fill the requested page after filtering; an empty or absent
  `thought_edges` table preserves the legacy result behavior.
- `list_thoughts(limit=10, offset=0, type?, source_type?, min_importance?, topic?, person?, days?, include_restricted=false)`
  lists visible thoughts and returns pagination with `has_more`.
- `thought_stats(since_days=3650, include_restricted=false)` returns the exact
  `brain_stats_aggregate` result.
- `related_thoughts(thought_id, limit=10)` returns visible graph connections.
- `capture_thought(content)` captures and embeds a thought through
  `capture_thought_atomic`. If that RPC is not deployed, it uses the legacy
  upsert-plus-embedding path and explicitly returns `atomic: false` and
  `via: "fallback_non_atomic"`.
- `update_thought(id, content?, metadata_patch?, if_unchanged_since?)` re-embeds
  changed content, shallow-merges metadata, and supports optimistic concurrency.
- `delete_thought(id, confirm=false)` requires server-validated `confirm=true`
  before calling `soft_delete_thought(id, "mcp", true)`. If that RPC is not
  deployed, it explicitly reports `atomic: false` / `via:
  "fallback_non_atomic"`, marks metadata with `deleted`, `deleted_at`, and
  `deleted_by`, and writes a best-effort audit event when `thought_audit`
  exists. It never performs a database delete.

## Agent Memory

The MCP v2 server exposes the runtime-neutral Agent Memory sidecars from
[`schemas/agent-memory`](../schemas/agent-memory/). These tools require that
schema to be installed. A missing sidecar table (PostgREST 404 / `PGRST205`)
returns `Agent Memory schema not installed — see schemas/agent-memory`; the
server never substitutes core `thoughts` behavior or silently skips the write.

- `memory_recall(workspace_id, query?, project_id?, channel_id?, task_type?, entities?, limits?{max_results, recency_days, max_tokens}, restrict_scope?)`
  recalls only memories visible inside the requested workspace and context,
  then writes `agent_memory_recall_traces`, `agent_memory_recall_items`, and
  audit events. A non-empty `query` uses the live three-argument
  `match_thoughts` RPC and ranks semantic candidates first. Without `query`,
  ordering is deterministic: `confidence DESC`, newest of
  `last_confirmed_at/created_at DESC`, then `id ASC`. `restrict_scope` is an
  exact visibility filter and therefore only narrows the otherwise eligible
  set. Token budgeting is the same hard-prefix estimate as the Agent Memory
  API: `ceil((summary characters + content characters) / 4)`.
- `memory_writeback(workspace_id, idempotency_key, memory{type, summary, content, visibility?, project_id?, channel_id?}, provenance{status, source_refs?}, created_by?)`
  accepts only `observed`, `inferred`, or `generated` provenance. Every row is
  created with `can_use_as_instruction=false`, `can_use_as_evidence=true`,
  `requires_user_confirmation=true`, and `review_status=pending`. Idempotency
  is scoped by `(workspace_id, idempotency_key)`; identical canonical content
  returns the existing row, while changed content is rejected.
- `memory_usage_report(request_id, used_memory_ids, ignored?{memory_id, reason}[])`
  validates the complete report against the trace before updating any recall
  item. A memory outside the trace is rejected.
- `memory_review_queue(workspace_id, limit=20, offset=0)` returns pending rows
  oldest first with `has_more` pagination.
- `memory_review(memory_id, workspace_id, action, actor_id, notes?, related_memory_id?, content?, summary?, visibility?)`
  performs logical review transitions only. Actions are `approve` (an alias
  persisted as REST `confirm`), `confirm`, `edit`, `evidence_only`,
  `restrict_scope`, `mark_stale`, `merge`, `reject`, `dispute`, and
  `supersede`. Lifecycle actions require notes; merge/supersede require a
  related memory in the same workspace; edit requires content or summary; and
  `restrict_scope` follows the monotone
  `workspace -> project -> channel -> personal` order. No action deletes a
  database row.

Because this MCP surface has no caller-supplied runtime field, personal scope
is bound to the stable runtime identity `open-brain-mcp-v2`. Project and channel
dimensions retain the exact contextual matching rules documented by the Agent
Memory REST API.

Restricted thoughts are excluded from reads unless the tool explicitly accepts
and receives `include_restricted=true`. Logically deleted thoughts are excluded
from search, fetch, list, recall, and related-thought results whether
`metadata.deleted` is boolean `true` or string `"true"`. A row's `source_type`
comes from its column first, then from `metadata.source`.

This server follows the practical Open Brain systems shared by
[Nate B. Jones](https://natebjones.com). More operator-focused workflows are
available in [Nate's Newsletter](https://substack.com/@natesnewsletter).
