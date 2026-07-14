# OB1 retrieval evaluation harness

This small, dependency-free Node 22 harness measures retrieval quality against a human-curated golden set. It is runtime-neutral: it calls the public OB1 PostgREST RPCs directly and performs no database writes.

```text
golden JSONL ──> unmeasured embedding warmup ──> semantic / text / hybrid retrieval
     │                                                     │
     └────────── expected thought IDs <── hit@k, MRR, retrieval-only latency
```

## Privacy first

Do **not** commit a real golden set. Queries, expected thought IDs, and notes can expose personal or confidential information. Store real sets outside this public repository, for example `~/.local/share/ob1/evals/retrieval/golden.jsonl` or a private `.planning/` path. The committed [`examples/synthetic-golden.jsonl`](examples/synthetic-golden.jsonl) contains only ten fictional cases and fabricated UUIDs.

## Run an evaluation

Create a local, untracked env file:

```bash
OPEN_BRAIN_URL=https://your-project.supabase.co
OPEN_BRAIN_SERVICE_KEY=your-service-role-key
OPENROUTER_API_KEY=your-openrouter-key
```

Then run:

```bash
node evals/retrieval/run-eval.mjs \
  --golden ~/.local/share/ob1/evals/retrieval/golden.jsonl \
  --env-file ~/.local/share/ob1/evals/retrieval/.env \
  --modes semantic,text,hybrid,hybrid-local \
  --k 10 --threshold 0.3 \
  --out /tmp/ob1-retrieval-report.json
```

`OPENROUTER_API_KEY` may be replaced with `LLM_API_KEY`. The embedding endpoint defaults to `https://openrouter.ai/api/v1/embeddings`, using `openai/text-embedding-3-small`; set `OPENROUTER_BASE` for a compatible local/proxy endpoint. The service key is sent only as HTTP headers to `${OPEN_BRAIN_URL}/rest/v1/rpc/*`.

`semantic` calls `match_thoughts`; `text` calls `search_thoughts_text`; `hybrid` calls `hybrid_search_thoughts`. The hybrid call uses the deployed `schemas/hybrid-recall` parameter names: `p_query`, `p_query_embedding`, `p_limit`, `p_offset`, `p_filter`, `p_include_restricted`, and `p_rrf_k`. When `--threshold` is explicitly supplied it also tries `p_semantic_threshold`, then retries without that final parameter if the installed RPC does not accept it. If the optional RPC returns HTTP 404, the mode is explicitly skipped rather than counted as a failed quality result. `hybrid-local` makes a semantic and text request with depth 60 and applies reciprocal-rank fusion (RRF, `k=60`) in the client. It is useful to assess hybrid value before deploying the RPC.

Before the timed evaluation, the runner precomputes every unique query embedding in an unmeasured warmup phase. Embedding time therefore cannot be assigned to whichever mode happens to run first; reported latency measures only retrieval RPC calls and their network time. The runner reports this warmup explicitly.

By default the runner is fail-closed: every failed query counts as a miss in the `hit@k` and MRR denominators, and any failed query in an executed mode exits with code `1`. Use `--allow-partial` only for diagnostic comparison runs: it restores the legacy successful-queries-only denominator and permits partial failures, but still exits `1` if every query in any executed mode failed. Exit code `2` means the golden file, command line, or configuration is invalid.

## Build a real golden set locally

Aim for at least 20 real cases, sampled across the important retrieval intents: exact names, paraphrases, dates, decisions, tasks, projects, and difficult ambiguous wording. Include multiple expected IDs only where either thought is genuinely acceptable. Do not force one expected document when the correct answer is ambiguous.

For each candidate query, use the read-only helper:

```bash
node evals/retrieval/make-golden.mjs \
  --query "What did we decide about the onboarding pilot?" \
  --candidates 15 \
  --env-file ~/.local/share/ob1/evals/retrieval/.env
```

It prints the RRF-fused semantic and text candidates (ID, date, type, source, and the first 140 characters). Review those candidates and write the JSONL line yourself:

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
