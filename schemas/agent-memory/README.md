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
- The core dedupe setup from Step 2.6 is recommended

> [!CAUTION]
> Production installation is gated. First apply and verify this schema in a disposable local or staging database. The migration is additive and idempotent, but it creates the complete Agent Memory persistence and governance surface.

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

## Expected Outcome

After applying this schema, OB1 can store agent memories as governed records instead of raw transcript dumps. Agent-written memories start as evidence-only pending review. Only `user_confirmed` or trusted `imported` memories can become instruction-grade.

`idempotency_key` and `content_hash` are mandatory for every Agent Memory row, and idempotency is unique within a workspace. Indexes cover workspace/creation time, `thought_id`, review state, lifecycle state, runtime/task, and content hashes. Enum-like values for provenance, lifecycle, visibility, memory type, review state, relations, review actions, audit events, and actor kinds are protected by `CHECK` constraints.

The service role is granted `SELECT`, `INSERT`, and `UPDATE`, but not `DELETE`, on all eight sidecar tables. The API exposes no physical-delete route. Rejection, staleness, merging, dispute, and supersession are represented through `lifecycle_status`, reviewer records, relations, and `agent_memory_audit_events`. A database trigger writes an audit event in the same transaction as every transition to `stale`, `superseded`, `disputed`, or `rejected`, so the lifecycle change rolls back if its audit cannot be persisted.

Use [Safe Agent Memory and Provenance](../../docs/safe-agent-memory-provenance.md) as the operating guide for provenance, review status, use policy, and scope decisions.

## Local SQL Verification

With Docker running, execute:

```bash
schemas/agent-memory/test/local-db-test.sh
```

The test starts `pgvector/pgvector:pg16` as `ob-thanos-am-pg` on local port `55433`, creates a minimal live-compatible UUID `thoughts` table, applies `schema.sql` twice, inserts one synthetic memory, verifies the atomic lifecycle audit, rejects invalid provenance/lifecycle/visibility/review-action values, checks the required indexes, and removes the container. It refuses to remove a pre-existing container with the same name.

## Troubleshooting

**Issue: `agent-memory requires public.thoughts`**
Solution: Run the core Open Brain setup first.

**Issue: instruction-grade write fails**
Solution: This is usually correct. `can_use_as_instruction` is only allowed for `user_confirmed` or `imported` memory.

**Issue: API cannot read tables**
Solution: Re-run the GRANT section at the bottom of `schema.sql` and redeploy the Edge Function so PostgREST reloads the schema cache.

**Issue: `idempotency_key` or `content_hash` cannot be null**
Solution: Write through the Agent Memory API, which supplies row hashes, or include both fields when performing a deliberate direct insert.
