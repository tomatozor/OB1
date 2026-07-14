# Open Brain MCP server v2

This stateless MCP endpoint authenticates requests only with `x-brain-key` or
`Authorization: Bearer <key>`. URL query parameters are never accepted for
authentication.

## Tools

- `search(query)` and `fetch(id)` preserve the ChatGPT search/fetch contract.
- `search_thoughts(query, mode="hybrid", limit=10, offset=0, type?, source_type?, min_importance?, start_date?, end_date?, include_restricted=false, threshold=0.5)`
  provides filtered retrieval. Hybrid mode calls `hybrid_search_thoughts` first,
  then uses semantic/text RRF (`k=60`) only when that RPC is absent.
- `recall_context(scope_topics?, scope_people?, days=30, limit=12, min_importance=0, include_restricted=false)`
  performs deterministic SQL-only recall.
- `list_thoughts(limit=10, offset=0, type?, source_type?, min_importance?, topic?, person?, days?, include_restricted=false)`
  lists visible thoughts.
- `thought_stats(since_days=3650, include_restricted=false)` returns the exact
  `brain_stats_aggregate` result.
- `related_thoughts(thought_id, limit=10)` returns visible graph connections.
- `capture_thought(content)` captures and embeds a thought.
- `update_thought(id, content?, metadata_patch?, if_unchanged_since?)` re-embeds
  changed content, shallow-merges metadata, and supports optimistic concurrency.
- `delete_thought(id, confirm=false)` requires `confirm=true` and only marks
  metadata with `deleted`, `deleted_at`, and `deleted_by`. It never performs a
  database delete and writes a best-effort audit event when `thought_audit`
  exists.

Restricted thoughts are excluded from reads unless the tool explicitly accepts
and receives `include_restricted=true`. Logically deleted thoughts are excluded
from search, fetch, list, recall, and related-thought results.

This server follows the practical Open Brain systems shared by
[Nate B. Jones](https://natebjones.com). More operator-focused workflows are
available in [Nate's Newsletter](https://substack.com/@natesnewsletter).
