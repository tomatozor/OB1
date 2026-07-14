# OB1 operational scripts

Dependency-free Node 22 ESM utilities for a PostgREST-backed Open Brain. They
read credentials only at runtime from `OPEN_BRAIN_URL` and
`OPEN_BRAIN_SERVICE_KEY`; `backfill-embeddings.mjs --apply` also needs
`OPENROUTER_API_KEY` (or `LLM_API_KEY`).

All backfills are dry-run by default. They never print thought content. Pass a
simple local environment file with `--env-file path`; each non-comment line is
`KEY=VALUE` and an already-exported environment value wins.

```bash
node scripts/ob-ops/backfill-embeddings.mjs --env-file .env.ob
node scripts/ob-ops/backfill-embeddings.mjs --apply --min-length 5 --env-file .env.ob
node scripts/ob-ops/backfill-source-type.mjs --env-file .env.ob
node scripts/ob-ops/backfill-source-type.mjs --apply --batch 100 --env-file .env.ob
node scripts/ob-ops/verify-stats.mjs --env-file .env.ob
node scripts/ob-ops/health-signal.mjs --env-file .env.ob
```

`backfill-source-type` uses `backfill_source_type(p_batch, p_dry_run)` when it
is available, otherwise it performs id-qualified PATCH requests. `verify-stats`
uses `brain_stats_aggregate` and attempts `thought_stats_exact`; unavailable
RPCs are reported clearly rather than treated as a crash. `health-signal` uses
only REST-observable signals: latest `thoughts.created_at` per source, queue
status counts, and missing embeddings. It cannot inspect the unexposed
`cron.job_run_details` view.

Exit codes: all scripts return non-zero for configuration or network/API errors;
`verify-stats` also returns 1 for a comparable discrepancy above 0.5%, and
`health-signal` returns 1 for yellow or red health.
