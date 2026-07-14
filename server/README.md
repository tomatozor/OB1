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

Restricted thoughts are excluded from reads unless the tool explicitly accepts
and receives `include_restricted=true`. Logically deleted thoughts are excluded
from search, fetch, list, recall, and related-thought results whether
`metadata.deleted` is boolean `true` or string `"true"`. A row's `source_type`
comes from its column first, then from `metadata.source`.

This server follows the practical Open Brain systems shared by
[Nate B. Jones](https://natebjones.com). More operator-focused workflows are
available in [Nate's Newsletter](https://substack.com/@natesnewsletter).
