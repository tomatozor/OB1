# OB1 operational SLOs

These SLOs are measured by `slo-report.mjs` against the configured production
endpoints. Owner for every objective: **Thomas**. A failed measurement is an
alert, not evidence that the service was continuously unavailable.

| Objective | Definition and measurement | Alert threshold | Response procedure |
| --- | --- | --- | --- |
| MCP availability | Successful HTTP 200 JSON-RPC `tools/list` probes divided by five probes. Target: at least 99%. | Below 99%, including any failed probe in a five-probe run. | Check endpoint/key and provider status; preserve the report; retry once after five minutes; escalate/deploy rollback if repeated. |
| `search_thoughts` latency | End-to-end network time of three neutral fixed `search_thoughts` calls (includes the query-embedding round-trip and client↔us-west-2 RTT). Target P50 under 2,500 ms and P95 under 4,000 ms — thresholds derived from the 2026-07-14 production measurement (P50 ≈ 1.9 s e2e from Tahiti). | P50 >= 2,500 ms or P95 >= 4,000 ms. | Check MCP and database latency, then retrieval/embedding-provider health; compare against the prior report before changing weights or indexes. |
| Ingestion freshness | Age of newest `thoughts.created_at` for each source: `gcal`, `gmail` (target < 26 h) and `notion-meetings`, `voice-memo` (target < 168 h — meeting notes and voice memos are event-driven). Freshness is INPUT-DEPENDENT: it detects a multi-day pipeline outage, not the absence of human activity (a weekend without a voice memo is not an incident). | A source missing or older than its threshold. | Check the named connector schedule, auth, and latest ingestion logs; repair/re-run only that connector after confirming scope. |
| Embedding integrity | Count of thoughts with `embedding IS NULL` and content length at least five characters. Target zero. | Count > 0. | Run `backfill-embeddings.mjs` dry-run, inspect ids/lengths, then apply only with explicit approval. |
| Extraction queue integrity | Count of `entity_extraction_queue` rows in `failed` state older than 24 hours. Target zero. | Count > 0. | Inspect worker/API errors and source row ids, repair the worker cause, then retry the affected queue deliberately. |
| Statistics accuracy | Largest relative divergence between exact PostgREST counts and installed aggregate RPC metrics. Target below 0.5%. | Divergence >= 0.5%, or the comparison cannot be measured. | Run `verify-stats.mjs`, identify the metric/RPC version mismatch, and fix the aggregate query before trusting dashboard totals. |

`slo-report.mjs` is a point-in-time verifier. Schedule it frequently and retain
its JSON output to calculate a rolling monthly availability percentage.
