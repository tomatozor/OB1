# Hybrid Recall and Safe Thought Operations

![OB1 Schema](https://img.shields.io/badge/OB1-Hybrid_Recall-5B4BDB?style=for-the-badge)

> Hybrid semantic and full-text recall, atomic capture, exact statistics, logical deletion, and append-only audit for Open Brain.

## What It Does

This additive schema fuses pgvector cosine retrieval and PostgreSQL full-text search with Reciprocal Rank Fusion (RRF). It also makes common write and maintenance paths safer: one-transaction capture, bounded source backfill, auditable logical deletion, restoration, and exact unpaginated statistics.

```text
query + embedding
       |
       +--> cosine top-N ---- rank --+
       |                             +--> RRF --> filtered page
       +--> FTS top-N ------- rank --+

capture --> fingerprint lock --> canonical upsert --> embedding
                                      |
thought INSERT/UPDATE ----------------+--> audit trigger --> thought_audit
```

The migration never replaces `upsert_thought`, never physically deletes a thought, and never removes or changes an existing `thoughts` column.

## Why This Matters

Embedding similarity catches conceptual matches while full-text search catches exact names and phrases. RRF combines both rank lists without pretending their raw scores are comparable. The companion write helpers keep capture and lifecycle operations transactional and reviewable.

Implementation and review corrections in this schema are authored by [Thomas Verdenne](https://github.com/tomatozor).

Upstream credit remains separate: this contribution builds on the practical Open Brain systems shared by [Nate B. Jones](https://natebjones.com). Nate gives away more useful, operator-focused systems in [Nate's Newsletter](https://substack.com/@natesnewsletter).

## Prerequisites

- Working Open Brain setup ([getting-started guide](../../docs/01-getting-started.md))
- PostgreSQL with the `vector` extension and a `thoughts.embedding vector(1536)` column
- The canonical `upsert_thought(p_content text, p_payload jsonb)` RPC
- Enhanced thought columns: `type`, `sensitivity_tier`, `importance`, `source_type`, and `content_fingerprint`
- Permission to create functions, tables, extensions, and indexes in Supabase

## Install in Supabase

![Step 1](https://img.shields.io/badge/Step_1-Open_SQL_Editor-5B4BDB?style=for-the-badge)

1. Open the Supabase dashboard for your Open Brain project.
2. Select **SQL Editor** and create a new query.

✅ **Done when:** A blank SQL query is open for the correct project.

![Step 2](https://img.shields.io/badge/Step_2-Run_the_Schema-5B4BDB?style=for-the-badge)

Copy the complete contents of [`schema.sql`](schema.sql) into the editor and click **Run**. Run it as one ordered script. It is safe to run again.

> [!IMPORTANT]
> The trigram GIN index is built normally for SQL Editor compatibility. On a large, write-active table, schedule the migration because index construction consumes I/O and briefly blocks conflicting writes.

> [!NOTE]
> An HNSW recommendation is included as commented SQL only. It is intentionally disabled because the first build can be expensive. Measure the existing IVFFlat index and schedule any HNSW build separately.

✅ **Done when:** Supabase reports success and Database Functions lists the seven RPCs below.

![Step 3](https://img.shields.io/badge/Step_3-Verify-5B4BDB?style=for-the-badge)

Run these non-mutating checks:

```sql
select public.thought_stats_exact();

select id, left(content, 80), rrf_score, semantic_rank, text_rank
from public.hybrid_search_thoughts(
  'project decision',
  '[YOUR_1536_DIMENSION_QUERY_VECTOR]'::vector(1536),
  10,
  0,
  '{"min_importance": 3}'::jsonb,
  false,
  60
);
```

✅ **Done when:** Statistics return one complete JSON object and hybrid results include at least one of `semantic_rank` or `text_rank` per row.

## Installed SQL Signatures

```sql
hybrid_search_thoughts(text, vector(1536), int, int, jsonb, boolean, int,
                       double precision)
  returns table (id uuid, content text, metadata jsonb, created_at timestamptz,
                 type text, importance smallint, rrf_score double precision,
                 semantic_rank int, text_rank int)

capture_thought_atomic(text, jsonb, vector(1536)) returns jsonb
backfill_source_type(int, boolean) returns jsonb
log_thought_audit(uuid, text, text, jsonb) returns void
soft_delete_thought(uuid, text, boolean) returns jsonb
restore_thought(uuid, text, boolean) returns jsonb
thought_stats_exact() returns jsonb
```

In declaration order, the hybrid-search parameters are `p_query`, `p_query_embedding`, `p_limit DEFAULT 10`, `p_offset DEFAULT 0`, `p_filter DEFAULT '{}'`, `p_include_restricted DEFAULT false`, `p_rrf_k DEFAULT 60`, and `p_semantic_threshold DEFAULT NULL`. When the threshold is present, the semantic candidate leg keeps only cosine similarity values greater than or equal to it.

`hybrid_search_thoughts` accepts these optional `p_filter` keys: `type`, `source_type`, `min_importance`, `start_date`, and `end_date`. Dates must be valid `timestamptz` strings. Restricted thoughts are excluded unless explicitly requested; logically deleted thoughts are always excluded.

`backfill_source_type(500, true)` is a read-only preview grouped by `metadata.source`. Pass `false` only after reviewing that output. Apply mode updates at most `p_batch` eligible rows and reports both `updated` and `remaining`.

Logical lifecycle writes are confirmation-gated. Both `soft_delete_thought` and `restore_thought` declare `p_actor text DEFAULT 'mcp'` and `p_confirm boolean DEFAULT false`; callers must explicitly pass `p_confirm => true` or the RPC raises `confirm required`.

## Access and Audit Model

The read RPCs `hybrid_search_thoughts` and `thought_stats_exact` remain executable by `authenticated` and `service_role`. The mutation and maintenance RPCs `capture_thought_atomic`, `backfill_source_type`, `soft_delete_thought`, `restore_thought`, and `log_thought_audit` are executable only by `service_role`; access is revoked from `PUBLIC`, `authenticated`, and `anon` when that role exists. Keep the service key server-side.

An `AFTER INSERT OR UPDATE` trigger on `thoughts` is the single mutation-audit path. Inserts record `capture`; ordinary updates record `update`; `metadata.deleted` transitions record `delete` or `restore`. Update diffs contain only changed audit indicators: `content_changed`, `metadata_keys_changed`, and `embedding_set`. Capture/delete/restore helpers do not call `log_thought_audit` explicitly, which avoids double counting. `thought_audit` has no trigger, so logging cannot recurse.

## Logical Rollback

The schema is additive, so leaving the indexes and audit history in place is the safest rollback. To retire only the callable surface, review and run the following lines individually. They are commented to prevent accidental execution.

```sql
-- DROP FUNCTION IF EXISTS public.hybrid_search_thoughts(text, vector(1536), int, int, jsonb, boolean, int, double precision);
-- DROP FUNCTION IF EXISTS public.capture_thought_atomic(text, jsonb, vector(1536));
-- DROP FUNCTION IF EXISTS public.backfill_source_type(int, boolean);
-- DROP FUNCTION IF EXISTS public.log_thought_audit(uuid, text, text, jsonb);
-- DROP FUNCTION IF EXISTS public.soft_delete_thought(uuid, text, boolean);
-- DROP FUNCTION IF EXISTS public.restore_thought(uuid, text, boolean);
-- DROP FUNCTION IF EXISTS public.thought_stats_exact();
```

> [!WARNING]
> Audit history is intentionally append-only. This guide does not provide table removal or physical thought deletion commands.

## Compatibility and Guardrails

- Objects are created with `IF NOT EXISTS`, `CREATE OR REPLACE`, or guarded `DO` blocks. The only executable drops remove superseded function signatures immediately before their default-compatible replacements.
- The migration is additive and can be applied multiple times.
- `capture_thought_atomic` preserves the canonical `upsert_thought` behavior and only adds transaction serialization and optional embedding storage; the table trigger supplies audit.
- `soft_delete_thought` writes deletion markers into `metadata`; `restore_thought` removes those markers. Both require explicit confirmation and neither performs physical deletion.
- `thought_audit` has no foreign key to `thoughts`, so audit rows survive future archival operations.
- An older `schemas/thought-audit` installation is tolerated: missing `actor` and `session_id` columns are added. If its legacy action check rejects `restore`, the helper records `action='update'` with `diff.logical_action='restore'` instead of weakening or dropping the old constraint.
- SECURITY DEFINER functions use a fixed search path. Read RPCs allow `authenticated`; mutation and maintenance RPCs are restricted to `service_role`; no RPC is executable by `anon` or `PUBLIC`.

## Local Test

The test harness expects an empty disposable PostgreSQL 16 instance on port `55432`:

```bash
docker run -d --name ob-thanos-pg \
  -e POSTGRES_PASSWORD=test \
  -p 55432:5432 \
  pgvector/pgvector:pg16

until docker exec ob-thanos-pg pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done

schemas/hybrid-recall/test/local-test.sh

docker rm -f ob-thanos-pg
```

The harness creates the full minimal live-compatible `thoughts` shape, installs the schema twice, loads nine synthetic rows through its assertions, and verifies grants, hybrid recall and thresholding, filters, capture validation and deduplication, backfill, gated logical deletion/restoration, trigger audit counts and compact diffs, and exact statistics.

## Expected Outcome

- Hybrid search returns stable RRF scores plus both source ranks.
- Restricted and logically deleted content stays out of default recall.
- Repeated normalized content resolves to one thought, with an embedding attached atomically when supplied.
- Source backfill can be previewed and then applied in bounded batches.
- Logical delete and restore operations leave append-only audit evidence.
- Exact statistics scan the complete table without client pagination.

## Troubleshooting

**`type "vector" does not exist`**

Install the pgvector extension first with `create extension if not exists vector;`, then rerun the schema.

**`function upsert_thought(text, jsonb) does not exist`**

Apply the Content Fingerprint Dedup step in the Open Brain getting-started guide. This contribution deliberately reuses rather than replaces that canonical RPC.

**The migration takes a long time while creating the trigram index**

Index build cost scales with content volume. Run the migration during a quieter write window. If you need `CONCURRENTLY`, execute that index as a separate non-transactional operational migration.

**A date filter raises an input syntax error**

Use an ISO 8601 timestamp with timezone, for example `2026-07-01T00:00:00Z`.
