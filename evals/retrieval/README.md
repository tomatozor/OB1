# OB1 retrieval evaluation harness

This small, dependency-free Node 22 harness measures retrieval quality against a human-curated golden set. It is runtime-neutral: it calls the public OB1 PostgREST RPCs directly and performs no database writes.

```text
golden JSONL ──> query embedding cache ──> semantic / text / hybrid retrieval
     │                                                │
     └──────── expected thought IDs <── hit@k, MRR, network-inclusive latency
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

`semantic` calls `match_thoughts`; `text` calls `search_thoughts_text`; `hybrid` calls `hybrid_search_thoughts`. If that optional RPC returns HTTP 404, the mode is explicitly skipped rather than counted as a failed quality result. `hybrid-local` makes a semantic and text request with depth 60 and applies reciprocal-rank fusion (RRF, `k=60`) in the client. It is useful to assess hybrid value before deploying the RPC.

The runner caches embeddings in memory by query and reuses them across modes. Exit code `2` means the golden file or its syntax is invalid; ordinary per-query network/RPC failures are reported in the result and still exit `0`, so a partial or offline run remains inspectable.

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

- `hit_at_1`, `hit_at_5`, `hit_at_k`: fraction of successful queries with any expected ID in the first 1, 5, or configured `k` results.
- `mrr`: mean reciprocal rank of the first expected ID; it rewards placing the expected thought earlier.
- `latency_ms.p50` and `latency_ms.p95`: client wall time per retrieval request, including network time. Semantic and hybrid modes include an embedding call when it is not already cached; hybrid-local includes both retrieval calls.
- `failed`: requests that could not execute. Failed requests are excluded from quality averages, so read this alongside the scores.

Indicative initial gates, not universal promises: keep `failed` at zero in a healthy environment; target `hit@10 >= 0.80` and `MRR >= 0.55` before claiming a retrieval configuration is reliable; investigate a P95 above the product's interaction budget (often 1–2 seconds for interactive recall). Compare modes on the same unchanged golden set and database snapshot.

The example set is intentionally not expected to match any live brain. Its fabricated IDs exercise the valid “expected ID never returned” path, producing zero quality scores without crashing.
