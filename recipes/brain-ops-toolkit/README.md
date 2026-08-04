# OB1 operational scripts

Dependency-free Node 22 ESM utilities for a PostgREST-backed Open Brain. They
read credentials only at runtime from `OPEN_BRAIN_URL` and
`OPEN_BRAIN_SERVICE_KEY`; `backfill-embeddings.mjs --apply` also needs
`OPENROUTER_API_KEY` (or `LLM_API_KEY`).

All backfills are dry-run by default. They never print thought content. Pass a
simple local environment file with `--env-file path`; each non-comment line is
`KEY=VALUE` and an already-exported environment value wins.

## Prerequisites

- Node.js 22+ and network access to the intended Open Brain PostgREST API.
- A local, uncommitted environment file containing `OPEN_BRAIN_URL` and
  `OPEN_BRAIN_SERVICE_KEY`; embedding apply runs also require an embedding key.
- Explicit operator approval before adding `--apply`, because it changes
  records even though every script starts in dry-run mode.

## Step-by-step

1. Create the local environment file and run the relevant script without
   `--apply` to inspect identifiers, counts, and eligibility.
2. Review the dry-run output and resolve API or configuration errors before
   changing records.
3. Rerun only the intended backfill with `--apply`, then use `verify-stats` or
   `health-signal` to confirm the operational result.

## Expected outcome

Dry runs make no changes and apply runs report bounded, fail-closed results
without printing thought content. Non-zero exit codes identify configuration,
network, API, or apply-work failures for operator follow-up.

```bash
node recipes/brain-ops-toolkit/backfill-embeddings.mjs --env-file .env.ob
node recipes/brain-ops-toolkit/backfill-embeddings.mjs --apply --batch 100 --min-length 5 --env-file .env.ob
node recipes/brain-ops-toolkit/backfill-source-type.mjs --env-file .env.ob
node recipes/brain-ops-toolkit/backfill-source-type.mjs --apply --batch 100 --env-file .env.ob
node recipes/brain-ops-toolkit/verify-stats.mjs --env-file .env.ob
node recipes/brain-ops-toolkit/health-signal.mjs --env-file .env.ob
```

## LLM enrichment backfill

### Prerequisites

- The standard PostgREST credentials above. Apply mode additionally needs
  `OPENROUTER_API_KEY` (or `LLM_API_KEY`); it uses
  `${OPENROUTER_BASE_URL:-https://openrouter.ai/api/v1}/chat/completions`.
- Explicit approval for `--apply`. The default dry-run makes no LLM request.

### Step-by-step

1. Run the dry-run to count `type IS NULL` and `enriched=false` candidates.
2. Review ids/counts and the estimated cost (`$0.0002` per candidate).
3. Apply the intended axis, then run the SLO report.

### Expected outcome

The script uses the existing structured extraction shape with DeepSeek V4 Pro and accepts only the
strict database type enum. It shallow-merges `topics`, `people`, and
`action_items` only when each metadata key is absent, never prints thought
content, and exits non-zero if any applied row fails.

```bash
node recipes/brain-ops-toolkit/backfill-enrichment.mjs --env-file .env.ob
node recipes/brain-ops-toolkit/backfill-enrichment.mjs --apply --only all --batch 25 --limit 100 --env-file .env.ob
```

## SLO report

### Prerequisites

- REST credentials plus `OPEN_BRAIN_MCP_URL` (or `MCP_URL`) and
  `OPEN_BRAIN_ACCESS_KEY` (or `MCP_ACCESS_KEY`) in the local environment file.
- Review the measurable targets and incident procedure in [SLO.md](SLO.md).

### Step-by-step

1. Run the point-in-time verifier with the intended local environment file.
2. Retain its JSON output with the monitoring run; it contains no thought
   content.
3. Treat a non-zero result as an alert and follow the named SLO procedure.

### Expected outcome

`slo-report.mjs` tests MCP availability, retrieval latency, four source
freshness signals, embedding/queue integrity, and statistics divergence. It
prints a table and JSON report and fails closed on any unavailable or violated
measurement.

```bash
node recipes/brain-ops-toolkit/slo-report.mjs --env-file .env.ob
```

## Weekly retrieval evaluation

### Prerequisites

- A human-curated real golden JSONL outside this repository.
- Retrieval credentials exported in cron or supplied via `ENV_FILE`.

### Step-by-step

1. Optionally set `GOLDEN_PATH`, `EVAL_OUT_DIR`, and `ENV_FILE`.
2. Schedule `weekly-eval.sh` weekly; it invokes the shared harness in semantic
   and hybrid modes at `k=10`.
3. Send cron stdout to the existing mail/ntfy route.

### Expected outcome

Each run writes a timestamped JSON report under
`~/.local/state/openbrain/evals/` by default. It compares hit@10 and MRR with
the previous report; a relative regression above 10% prints `ALERTE` and exits
2, which is directly consumable by cron alerting.

```bash
GOLDEN_PATH=~/.local/state/openbrain/golden-real.jsonl \
ENV_FILE=~/.local/state/openbrain/.env \
bash recipes/brain-ops-toolkit/weekly-eval.sh
```

`backfill-embeddings` accepts `--batch` (default 100) for its PostgREST page
size. Its apply summary is fail-closed: any per-thought embedding failure makes
the process return a non-zero exit code. Its output contains only identifiers,
counts, and lengths, never thought content.

`backfill-source-type --apply` repeatedly uses
`backfill_source_type(p_batch, p_dry_run)` until the RPC reports no qualified
rows remaining (maximum 1,000 iterations). If the RPC is unavailable before it
makes a change, it performs the same bounded loop with id-qualified PATCH
requests. An RPC or PATCH iteration failure returns a non-zero exit code.
Dry-run remains one read-only pass. `verify-stats`
uses `brain_stats_aggregate` and attempts `thought_stats_exact`; unavailable
RPCs are reported clearly rather than treated as a crash. `health-signal` uses
only REST-observable signals: latest `thoughts.created_at` per source, queue
status counts, and missing embeddings. It cannot inspect the unexposed
`cron.job_run_details` view.

Exit codes: all scripts return non-zero for configuration or network/API errors;
both backfills also return non-zero for failed apply work (including their
iteration safety limit);
`verify-stats` also returns 1 for a comparable discrepancy above 0.5%, and
`health-signal` returns 1 for yellow or red health.
