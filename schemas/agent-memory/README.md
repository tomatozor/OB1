# Agent Memory

> Governed operational memory for agent runtimes, with provenance, review, recall traces, and audit trails.

```mermaid
flowchart LR
  Runtime["Agent runtime<br/>OpenClaw, Codex, local agents"] --> Recall["Recall request"]
  Recall --> OB1["OB1 Agent Memory"]
  OB1 --> Memories["Scoped memories<br/>provenance + use policy"]
  Memories --> Runtime
  Runtime --> Writeback["Compact write-back"]
  Writeback --> Review["Human review"]
  Review --> Future["Future recall"]
  Future --> Runtime
```

## What It Does

This schema adds sidecar tables that let Open Brain store agent-created operational memory safely. The core `thoughts` table remains the content store; agent memory records add provenance, confidence, scope, use policy, review status, source references, recall traces, and audit events.

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md))
- Supabase project with the core `thoughts` table
- PostgreSQL `vector` extension with 1,536-dimension embeddings
- The core dedupe setup from Step 2.6 is recommended

> [!CAUTION]
> Production installation is gated. First apply and verify this schema in a disposable local or staging database. The migration is data-preserving and idempotent, but it replaces one legacy index, tightens two nullable columns, revokes legacy privileges, and creates the complete Agent Memory persistence and governance surface.

## Credential Tracker

```text
AGENT MEMORY -- CREDENTIAL TRACKER
--------------------------------------

SUPABASE (from your Open Brain setup)
  Project URL:           ____________
  Secret key:            ____________

--------------------------------------
```

## Steps

1. Apply [`schema.sql`](./schema.sql) to a disposable local or staging database.
2. Apply the same migration again and verify that the second run is idempotent.
3. Run [`test/local-db-test.sh`](./test/local-db-test.sh), then inspect every `PASS` line before promoting the migration.

![Step 1](https://img.shields.io/badge/Step_1-Run_the_Agent_Memory_Schema-1E88E5?style=for-the-badge)

Open Supabase SQL Editor, paste the contents of [`schema.sql`](./schema.sql), and run it.

Run the same SQL a second time. A second successful execution is the installation idempotence check. The script creates eight `agent_memory_*` sidecar tables with `IF NOT EXISTS`, creates/replaces only Agent Memory helper functions, and conditionally creates its trigger and RLS policies. It does not add, alter, or remove any column on `public.thoughts`.

**Done when:** Table Editor shows `agent_memories`, `agent_memory_recall_traces`, `agent_memory_recall_items`, and `agent_memory_audit_events`.

![Step 2](https://img.shields.io/badge/Step_2-Verify_the_Trust_Defaults-1E88E5?style=for-the-badge)

Run this query:

```sql
SELECT column_name, column_default
FROM information_schema.columns
WHERE table_name = 'agent_memories'
  AND column_name IN (
    'can_use_as_instruction',
    'can_use_as_evidence',
    'requires_user_confirmation',
    'review_status'
  );
```

**Done when:** instruction defaults to `false`, evidence defaults to `true`, confirmation defaults to `true`, and review defaults to `pending`.

![Step 3](https://img.shields.io/badge/Step_3-Install_the_API-1E88E5?style=for-the-badge)

Deploy the runtime API from [`../../integrations/agent-memory-api/`](../../integrations/agent-memory-api/).

After copying the function into a Supabase project, deployment is intentionally a separate, gated operation:

```bash
supabase functions deploy agent-memory-api --no-verify-jwt
```

Do not run that command until the local/staging SQL checks and secret configuration are complete. The function performs its own mandatory header-only `MCP_ACCESS_KEY` authentication.

If `verify_jwt = false` is already configured for the function in `supabase/config.toml`, use `supabase functions deploy agent-memory-api` instead.

**Done when:** `GET /health` on the deployed API returns `{"ok":true}`.

## Expected outcome

After applying this schema, OB1 can store agent memories as governed records instead of raw transcript dumps. Agent-written memories start as evidence-only pending review. Only `user_confirmed` or trusted `imported` memories can become instruction-grade.

`idempotency_key` and `content_hash` are mandatory for every Agent Memory row, and idempotency is unique within a workspace. Indexes cover workspace/creation time, `thought_id`, review state, lifecycle state, runtime/task, and content hashes. Enum-like values for provenance, lifecycle, visibility, memory type, review state, relations, review actions, audit events, and actor kinds are protected by `CHECK` constraints.

The persistence visibility enum is deliberately limited to `workspace`,
`project`, `channel`, and `personal`; `workspace_id` is always required. The
API enforces the exact contextual matching and runtime ownership semantics
documented in [`integrations/agent-memory-api`](../../integrations/agent-memory-api/README.md#scope-model).

`restrict_scope` accepts the current visibility as an idempotent request and
accepts any narrower visibility. It rejects only widening: `personal` <
`channel` < `project` < `workspace`. Project and channel scopes still require
their corresponding identifiers.

Known retrieval ceilings are intentionally layered: REST returns at most 100
memories per request, MCP scans at most 1,000 memories in a workspace, the
server candidate pool is capped at 2,500, and the SQL semantic-match pool is
capped at 5,000.

The service role is granted `SELECT`, `INSERT`, and `UPDATE`, but not `DELETE`, on all eight sidecar tables. The API exposes no physical-delete route. Rejection, staleness, merging, dispute, and supersession are represented through `lifecycle_status`, reviewer records, relations, and `agent_memory_audit_events`. A database trigger writes an audit event in the same transaction as every transition to `stale`, `superseded`, `disputed`, or `rejected`, so the lifecycle change rolls back if its audit cannot be persisted.

## Transactional Governance RPCs

The schema installs these exact service-role-only signatures:

```sql
agent_memory_writeback_tx(
  text, text, text, jsonb, jsonb, jsonb, jsonb, text, jsonb, vector(1536)
) returns jsonb

agent_memory_writeback_batch_tx(
  text, jsonb, text, jsonb
) returns jsonb

agent_memory_match(
  text, vector(1536), integer, double precision
) returns table(memory_id uuid, similarity double precision)

agent_memory_review_tx(
  uuid, text, text, text, text, uuid, text, text, text, text
) returns jsonb
```

In declaration order, writeback accepts `p_workspace_id`, `p_idempotency_key`, `p_content_hash`, `p_memory`, `p_provenance`, `p_source_refs DEFAULT '[]'`, `p_artifacts DEFAULT '[]'`, `p_created_by DEFAULT NULL`, `p_request_context DEFAULT '{}'`, and `p_embedding vector(1536) DEFAULT NULL`. The default exists only for call-signature compatibility: a null embedding raises `embedding required — a writeback must be semantically recallable` before any memory, child, or audit write. A supplied embedding is stored atomically with the memory. Equal workspace/key pairs are serialized; same-hash replay returns the existing embedded row, while a different hash conflicts. New rows remain evidence-only and pending review, and writeback provenance is limited to `observed`, `inferred`, or `generated`.

Batch writeback accepts a JSON array of `{idempotency_key, content_hash, memory, provenance, source_refs?, artifacts?, embedding}` items. Every new item requires an array of exactly 1,536 numbers. A same-hash replay may omit it because the existing stored embedding governs the replay. The loop calls the single-item RPC inside one database function; any item failure rolls back every memory, child, and audit row created by the batch.

`agent_memory_match` computes cosine similarity only over non-null embeddings in the requested workspace and excludes `rejected` and `superseded` memories. Its optional threshold is applied before the ordered, capped result is returned; a request can never return a row from another workspace.

Review accepts `p_memory_id`, `p_workspace_id`, `p_action`, `p_actor_id`, `p_notes DEFAULT NULL`, `p_related_memory_id DEFAULT NULL`, `p_content DEFAULT NULL`, `p_summary DEFAULT NULL`, `p_visibility DEFAULT NULL`, and `p_actor_kind DEFAULT 'agent'`. Actor kind is restricted to `agent|human`; `confirm`/`approve`, `merge`, and `supersede` require `human`. An agent edit of a confirmed or instruction-grade memory atomically resets it to pending evidence (`can_use_as_instruction=false`, `requires_user_confirmation=true`) and audits the downgrade. A human edit preserves confirmed state. The row lock and related-memory lookup remain workspace-bounded.

`PUBLIC` and `authenticated` have no execution privilege on these four RPCs; execution is granted only to `service_role`. Keep the service key server-side.

## Upgrade Behavior

Applying this schema to the `origin/main` Agent Memory installation performs a real in-place upgrade:

- existing null `idempotency_key` and `content_hash` values become the deterministic value `legacy:<memory-id>`, then both columns become `NOT NULL`;
- the former global partial `idx_agent_memories_idempotency_key` is dropped and replaced by the unique workspace-scoped `idx_agent_memories_workspace_idempotency_key (workspace_id, idempotency_key)`;
- legacy `visibility='organization'` rows become `workspace` before the four-level visibility check is installed;
- `agent_memories.embedding vector(1536)` is added without rewriting or deleting existing memory rows;
- the old nine-argument writeback RPC is dropped transactionally and replaced by the ten-argument embedding signature;
- the old nine-argument review RPC is dropped transactionally and replaced by the ten-argument actor-authority signature;
- semantic match and atomic batch writeback RPCs are installed with service-role-only execution;
- `DELETE` is explicitly revoked from `service_role` on all eight tables, undoing the earlier grant rather than assuming a narrower later `GRANT` revokes it;
- existing memory and child rows are retained. The migration does not remove or rewrite `thoughts` columns.

The script runs in one transaction. Backfills and index replacement can lock or scan `agent_memories`, so schedule and verify the upgrade on a representative staging copy before production.

Use [Safe Agent Memory and Provenance](../../docs/safe-agent-memory-provenance.md) as the operating guide for provenance, review status, use policy, and scope decisions.

## Local SQL Verification

With Docker running, execute:

```bash
schemas/agent-memory/test/local-db-test.sh
```

The test starts `pgvector/pgvector:pg16` as `ob-thanos-am-pg` on local port `55433`, creates a minimal live-compatible UUID `thoughts` table, and applies `schema.sql` twice. It then verifies the real upgrade path, including replacement of the previous transactional RPC signatures, before running transactional authority, batch rollback, real audit-trigger fault injection, and semantic-match E2E groups. The E2E group proves same-vector similarity near 1, strict workspace isolation, and zero writes when embedding is null. The harness removes its container and refuses to remove a pre-existing container with the same name.

## Troubleshooting

**Issue: `agent-memory requires public.thoughts`**
Solution: Run the core Open Brain setup first.

**Issue: instruction-grade write fails**
Solution: This is usually correct. `can_use_as_instruction` is only allowed for `user_confirmed` or `imported` memory.

**Issue: API cannot read tables**
Solution: Re-run the GRANT section at the bottom of `schema.sql` and redeploy the Edge Function so PostgREST reloads the schema cache.

**Issue: `idempotency_key` or `content_hash` cannot be null**
Solution: Write through the Agent Memory API, which supplies row hashes, or include both fields when performing a deliberate direct insert.
