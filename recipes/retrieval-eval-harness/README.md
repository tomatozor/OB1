# OB1 retrieval evaluation harness

This small, dependency-free Node 22 harness measures retrieval quality against a human-curated golden set. It is runtime-neutral: it calls the public OB1 PostgREST RPCs directly and performs no database writes.

```text
golden JSONL ──> unmeasured embedding warmup ──> semantic / text / hybrid retrieval
     │                                                     │
     └────────── expected thought IDs <── hit@k, MRR, retrieval-only latency
```

## Privacy first

Do **not** commit a real golden set. Queries, expected thought IDs, and notes can expose personal or confidential information. Store real sets outside this public repository, for example `~/.local/share/ob1/recipes/retrieval-eval-harness/golden.jsonl` or a private `.planning/` path. The committed [`examples/synthetic-golden.jsonl`](examples/synthetic-golden.jsonl) contains only ten fictional cases and fabricated UUIDs.

## Prerequisites

- Node.js 22+ with global `fetch` support.
- An Open Brain URL and service-role key that can call the documented retrieval
  RPCs, plus an OpenRouter-compatible embedding API key.
- A human-curated golden JSONL stored outside this repository; use the
  synthetic example only to exercise the harness.

## Step-by-step

1. Create an untracked environment file with the URL and API keys shown below.
2. Build or review a local golden JSONL whose expected IDs were selected by a
   human.
3. Run the evaluation and compare modes using the same golden set and database
   snapshot.

## Expected outcome

The runner prints comparable retrieval metrics and exits non-zero for invalid
configuration or failed queries by default. It never writes to Open Brain.

## Run an evaluation

Create a local, untracked env file:

```bash
OPEN_BRAIN_URL=https://your-project.supabase.co
OPEN_BRAIN_SERVICE_KEY=your-service-role-key
OPENROUTER_API_KEY=your-openrouter-key
```

Then run:

```bash
node recipes/retrieval-eval-harness/run-eval.mjs \
  --golden ~/.local/share/ob1/recipes/retrieval-eval-harness/golden.jsonl \
  --env-file ~/.local/share/ob1/recipes/retrieval-eval-harness/.env \
  --modes semantic,text,hybrid,hybrid-local \
  --k 10 --threshold 0.3 \
  --semantic-weight 1.0 --text-weight 2.0 \
  --recency-half-life-days 30 \
  --out /tmp/ob1-retrieval-report.json
```

`OPENROUTER_API_KEY` may be replaced with `LLM_API_KEY`. The embedding endpoint defaults to `https://openrouter.ai/api/v1/embeddings`, using `openai/text-embedding-3-small`; set `OPENROUTER_BASE` for a compatible local/proxy endpoint. The service key is sent only as HTTP headers to `${OPEN_BRAIN_URL}/rest/v1/rpc/*`.

All network calls have bounded timeouts: 15 seconds for embeddings and 10 seconds for PostgREST RPCs. When `--out` writes outside `$HOME` or outside a path containing `.planning`, the runner warns: `le rapport peut contenir des données personnelles — ne pas committer`. The warning does not block report generation.

`semantic` calls `match_thoughts`; `text` calls `search_thoughts_text`; `hybrid` calls `hybrid_search_thoughts`. The hybrid call sends `p_semantic_weight` and `p_text_weight` in addition to the deployed `schemas/hybrid-recall` parameters. When `--recency-half-life-days` is supplied, it also sends `p_recency_half_life_days`; a previous ten-parameter RPC is retried without recency while preserving the threshold and weights. Older signatures are then retried without weights and, when `--threshold` was explicitly supplied, without `p_semantic_threshold`. If the optional RPC returns HTTP 404, the mode is explicitly skipped rather than counted as a failed quality result. `hybrid-local` makes a semantic and text request with depth 60 and applies the same weighted RRF (`k=60`) and optional exponential recency decay in the client. With recency enabled, every fused candidate must expose a valid `created_at` in at least one retrieval leg or that query fails closed.

## Lexical-priority methodology and out-of-sample warning

The defaults are `--semantic-weight 1.0 --text-weight 2.0`. They are **baseline-derived from 21 real cases measured on 2026-07-14**. Unweighted hybrid retrieval measured `hit@10=0.6667` and `MRR=0.4512`; the 2:1 lexical-priority simulation preserved `hit@10=0.6667` and estimated `MRR≈0.533`. On that same corpus, text-only MRR was `0.505` and semantic-only MRR was `0.218`.

This is in-sample tuning. Revalidate the weighting on a separate, untouched golden set before using it as evidence of general improvement. Record the weights with every comparison; the console table and JSON report both expose the effective values. Both CLI weights must be finite and strictly greater than zero.

Recency is separate from the baseline-derived lexical weights. Its default is disabled, and the harness assumes no tuned half-life. `--recency-half-life-days <n>` requires a finite positive number and multiplies each RRF contribution by `exp(-ln(2) * age_days / n)`. The console header and JSON report record either the supplied half-life or `disabled`/`null`.

Before the timed evaluation, the runner precomputes every unique query embedding in an unmeasured warmup phase. Embedding time therefore cannot be assigned to whichever mode happens to run first; reported latency measures only retrieval RPC calls and their network time. The runner reports this warmup explicitly.

By default the runner is fail-closed: every failed query counts as a miss in the `hit@k` and MRR denominators, and any failed query in an executed mode exits with code `1`. Use `--allow-partial` only for diagnostic comparison runs: it restores the legacy successful-queries-only denominator and permits partial failures, but still exits `1` if every query in any executed mode failed. Exit code `2` means the golden file, command line, or configuration is invalid.

## Build a real golden set locally

Aim for at least 20 real cases, sampled across the important retrieval intents: exact names, paraphrases, dates, decisions, tasks, projects, and difficult ambiguous wording. Include multiple expected IDs only where either thought is genuinely acceptable. Do not force one expected document when the correct answer is ambiguous.

For each candidate query, use the read-only helper:

```bash
node recipes/retrieval-eval-harness/make-golden.mjs \
  --query "What did we decide about the onboarding pilot?" \
  --candidates 15 \
  --semantic-weight 1.0 --text-weight 2.0 \
  --env-file ~/.local/share/ob1/recipes/retrieval-eval-harness/.env
```

It prints the weighted-RRF-fused semantic and text candidates (ID, date, type, source, and the first 140 characters). Its defaults match `run-eval.mjs`: semantic weight `1.0` and text weight `2.0`; both options must be finite and greater than zero. Review those candidates and write the JSONL line yourself:

```json
{"id":"onboarding-decision","query":"What did we decide about the onboarding pilot?","relevant_ids":["00000000-0000-4000-8000-000000000000"],"note":"Human-validated; stored locally."}
```

The helper never writes a database row or a golden file. Keep the completed real JSONL and its env file outside the repository.

## Read the report

For each executed mode, the table and JSON report include:

- `hit_at_1`, `hit_at_5`, `hit_at_k`: fraction of all queries with any expected ID in the first 1, 5, or configured `k` results. A failed query is a miss by default; `--allow-partial` explicitly changes this denominator to successful queries only.
- `mrr`: mean reciprocal rank of the first expected ID; it rewards placing the expected thought earlier.
- `latency_ms.p50` and `latency_ms.p95`: client wall time for retrieval calls, including their network time but excluding the precomputed embedding warmup. `hybrid-local` includes both retrieval calls.
- `failed`: requests that could not execute. They count as quality misses and cause a non-zero exit by default. `quality_denominator` makes the active denominator explicit in the JSON report.

Indicative initial gates, not universal promises: keep `failed` at zero in a healthy environment; target `hit@10 >= 0.80` and `MRR >= 0.55` before claiming a retrieval configuration is reliable; investigate a P95 above the product's interaction budget (often 1–2 seconds for interactive recall). Compare modes on the same unchanged golden set and database snapshot.

The example set is intentionally not expected to match any live brain. Its fabricated IDs exercise the valid “expected ID never returned” path, producing zero quality scores without crashing.
