#!/usr/bin/env node
/**
 * Read-only retrieval evaluation harness for an OB1 brain.
 * Requires Node.js 22+ (uses global fetch and performance).
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT_MODES = ["semantic", "text", "hybrid", "hybrid-local"];
const VALID_MODES = new Set(DEFAULT_MODES);

function usage() {
  return `Usage: node run-eval.mjs --golden <path> [options]

Options:
  --golden <path>       JSONL golden set (required)
  --modes <list>        Comma-separated: ${DEFAULT_MODES.join(",")} (default: all)
  --k <number>          Ranking depth (default: 10)
  --threshold <number>  Semantic similarity floor (default: 0.3)
  --semantic-weight <n> Semantic RRF weight, finite and > 0 (default: 1.0)
  --text-weight <n>     Full-text RRF weight, finite and > 0 (default: 2.0)
  --recency-half-life-days <n>
                         Optional recency half-life in days, finite and > 0 (default: disabled)
  --allow-partial       Exclude failed queries from quality metrics; permits partial failures
  --env-file <path>     Optional KEY=VALUE file; never committed
  --out <path>          Write complete JSON report (warns outside HOME or .planning)
  --help                Show this message`;
}

function parseArgs(argv) {
  const options = { modes: DEFAULT_MODES, k: 10, threshold: 0.3, thresholdProvided: false, semanticWeight: 1.0, textWeight: 2.0, recencyHalfLifeDays: undefined, allowPartial: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") return { help: true };
    if (!arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
    if (arg === "--allow-partial") { options.allowPartial = true; continue; }
    const value = argv[++i];
    if (!value) throw new Error(`Missing value for ${arg}`);
    if (arg === "--golden") options.golden = value;
    else if (arg === "--modes") options.modes = value.split(",").map((x) => x.trim()).filter(Boolean);
    else if (arg === "--k") options.k = Number(value);
    else if (arg === "--threshold") { options.threshold = Number(value); options.thresholdProvided = true; }
    else if (arg === "--semantic-weight") options.semanticWeight = Number(value);
    else if (arg === "--text-weight") options.textWeight = Number(value);
    else if (arg === "--recency-half-life-days") options.recencyHalfLifeDays = Number(value);
    else if (arg === "--env-file") options.envFile = value;
    else if (arg === "--out") options.out = value;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.golden) throw new Error("--golden is required");
  if (!Number.isInteger(options.k) || options.k < 1) throw new Error("--k must be a positive integer");
  if (!Number.isFinite(options.threshold)) throw new Error("--threshold must be a number");
  if (!Number.isFinite(options.semanticWeight) || options.semanticWeight <= 0) throw new Error("--semantic-weight must be a finite number > 0");
  if (!Number.isFinite(options.textWeight) || options.textWeight <= 0) throw new Error("--text-weight must be a finite number > 0");
  if (options.recencyHalfLifeDays !== undefined && (!Number.isFinite(options.recencyHalfLifeDays) || options.recencyHalfLifeDays <= 0)) throw new Error("--recency-half-life-days must be a finite number > 0");
  for (const mode of options.modes) if (!VALID_MODES.has(mode)) throw new Error(`Unknown mode: ${mode}`);
  return options;
}

function loadEnvFile(file) {
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

function loadGolden(file) {
  if (!fs.existsSync(file)) throw new Error(`Golden set not found: ${file}`);
  const cases = [];
  for (const [index, raw] of fs.readFileSync(file, "utf8").split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    let entry;
    try { entry = JSON.parse(raw); } catch { throw new Error(`Invalid JSON on golden line ${index + 1}`); }
    if (!entry || typeof entry.id !== "string" || !entry.id || typeof entry.query !== "string" || !entry.query.trim() || !Array.isArray(entry.relevant_ids) || !entry.relevant_ids.length || !entry.relevant_ids.every((id) => typeof id === "string" && id)) {
      throw new Error(`Invalid golden case on line ${index + 1}: id, query, and non-empty relevant_ids are required`);
    }
    cases.push(entry);
  }
  if (!cases.length) throw new Error("Golden set contains no cases");
  return cases;
}

class HttpError extends Error {
  constructor(label, status, body) { super(`${label} failed: HTTP ${status}${body ? ` — ${body.slice(0, 240)}` : ""}`); this.status = status; this.body = body; }
}

function config() {
  const url = process.env.OPEN_BRAIN_URL?.replace(/\/$/, "");
  const serviceKey = process.env.OPEN_BRAIN_SERVICE_KEY;
  const embeddingKey = process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY;
  if (!url) throw new Error("OPEN_BRAIN_URL is not configured");
  if (!serviceKey) throw new Error("OPEN_BRAIN_SERVICE_KEY is not configured");
  if (!embeddingKey) throw new Error("OPENROUTER_API_KEY or LLM_API_KEY is not configured");
  return { url, serviceKey, embeddingKey, embeddingBase: (process.env.OPENROUTER_BASE || "https://openrouter.ai/api/v1").replace(/\/$/, "") };
}

async function postJson(url, headers, body, label, timeoutMs) {
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new HttpError(label, response.status, await response.text().catch(() => ""));
    return response.json();
  } catch (error) {
    if (error.name === "TimeoutError") throw new Error(`${label} timed out after ${timeoutMs}ms`);
    throw error;
  }
}

function rpcHeaders(c) { return { apikey: c.serviceKey, Authorization: `Bearer ${c.serviceKey}` }; }

async function embed(query, c) {
  const data = await postJson(`${c.embeddingBase}/embeddings`, { Authorization: `Bearer ${c.embeddingKey}` }, { model: "openai/text-embedding-3-small", input: query }, "Embedding", 15_000);
  if (!Array.isArray(data?.data?.[0]?.embedding)) throw new Error("Embedding response did not contain data[0].embedding");
  return data.data[0].embedding;
}

async function semantic(query, c, embeddingCache, k, threshold) {
  const vector = await embeddingFor(query, embeddingCache);
  return postJson(`${c.url}/rest/v1/rpc/match_thoughts`, rpcHeaders(c), { query_embedding: vector, match_threshold: threshold, match_count: k }, "match_thoughts", 10_000);
}

async function textSearch(query, c, k) {
  return postJson(`${c.url}/rest/v1/rpc/search_thoughts_text`, rpcHeaders(c), { p_query: query, p_limit: k, p_filter: {}, p_offset: 0 }, "search_thoughts_text", 10_000);
}

function hybridPayload(query, vector, k, threshold, weights, recencyHalfLifeDays) {
  return { p_query: query, p_query_embedding: vector, p_limit: k, p_offset: 0, p_filter: {}, p_include_restricted: false, p_rrf_k: 60, ...(threshold === undefined ? {} : { p_semantic_threshold: threshold }), ...(weights === undefined ? {} : { p_semantic_weight: weights.semanticWeight, p_text_weight: weights.textWeight }), ...(recencyHalfLifeDays === undefined ? {} : { p_recency_half_life_days: recencyHalfLifeDays }) };
}

function isSignatureError(error) {
  return error instanceof HttpError && (error.status === 400 || error.status === 404) && /function|parameter|argument|p_semantic_threshold|p_recency_half_life_days|schema cache/i.test(error.body || error.message);
}

async function hybrid(query, c, embeddingCache, k, semanticThreshold, semanticWeight, textWeight, recencyHalfLifeDays) {
  const vector = await embeddingFor(query, embeddingCache);
  const attempts = [];
  if (recencyHalfLifeDays !== undefined) {
    attempts.push(hybridPayload(query, vector, k, semanticThreshold, { semanticWeight, textWeight }, recencyHalfLifeDays));
  }
  attempts.push(hybridPayload(query, vector, k, semanticThreshold, { semanticWeight, textWeight }));
  attempts.push(hybridPayload(query, vector, k, semanticThreshold));
  if (semanticThreshold !== undefined) attempts.push(hybridPayload(query, vector, k));

  let lastError;
  for (const payload of attempts) {
    try {
      return await postJson(`${c.url}/rest/v1/rpc/hybrid_search_thoughts`, rpcHeaders(c), payload, "hybrid_search_thoughts", 10_000);
    } catch (error) {
      if (!isSignatureError(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function embeddingFor(query, cache) {
  if (!cache.has(query)) throw new Error(`Query embedding was not precomputed for: ${query}`);
  return cache.get(query);
}

function ids(rows) { return Array.isArray(rows) ? rows.map((row) => row?.id == null ? "" : String(row.id)).filter(Boolean) : []; }

function fuseRrf(semanticRows, textRows, limit, rrfK = 60, semanticWeight = 1.0, textWeight = 2.0, recencyHalfLifeDays) {
  const scores = new Map();
  const rows = new Map();
  for (const list of [semanticRows, textRows]) {
    for (const row of (Array.isArray(list) ? list : [])) {
      const id = String(row.id ?? "");
      if (id) rows.set(id, { ...(rows.get(id) || {}), ...row });
    }
  }
  const scoringTime = Date.now();
  for (const [list, weight] of [[semanticRows, semanticWeight], [textRows, textWeight]]) {
    for (const [index, row] of (Array.isArray(list) ? list : []).entries()) {
      const id = String(row.id ?? "");
      if (!id) continue;
      let recencyMultiplier = 1;
      if (recencyHalfLifeDays !== undefined) {
        const createdAt = Date.parse(rows.get(id)?.created_at);
        if (!Number.isFinite(createdAt)) throw new Error(`hybrid-local recency requires a valid created_at for thought ${id}`);
        recencyMultiplier = Math.exp(-Math.LN2 * ((scoringTime - createdAt) / 86_400_000) / recencyHalfLifeDays);
      }
      scores.set(id, (scores.get(id) || 0) + recencyMultiplier * weight / (rrfK + index + 1));
    }
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([id]) => rows.get(id));
}

async function execute(mode, entry, c, cache, options) {
  const started = performance.now();
  let rows;
  if (mode === "semantic") rows = await semantic(entry.query, c, cache, options.k, options.threshold);
  else if (mode === "text") rows = await textSearch(entry.query, c, options.k);
  else if (mode === "hybrid") rows = await hybrid(entry.query, c, cache, options.k, options.thresholdProvided ? options.threshold : undefined, options.semanticWeight, options.textWeight, options.recencyHalfLifeDays);
  else {
    const [semanticRows, textRows] = await Promise.all([
      semantic(entry.query, c, cache, 60, options.threshold),
      textSearch(entry.query, c, 60),
    ]);
    rows = fuseRrf(semanticRows, textRows, options.k, 60, options.semanticWeight, options.textWeight, options.recencyHalfLifeDays);
  }
  return { ids: ids(rows), latency_ms: performance.now() - started };
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((p / 100) * sorted.length) - 1];
}

function metrics(results, k, allowPartial) {
  const succeeded = results.filter((r) => !r.error);
  const scored = allowPartial ? succeeded : results;
  const found = (r, depth) => r.returned_ids.slice(0, depth).some((id) => r.relevant_ids.includes(id));
  const reciprocalRanks = scored.map((r) => {
    const index = r.returned_ids.findIndex((id) => r.relevant_ids.includes(id));
    return index < 0 ? 0 : 1 / (index + 1);
  });
  const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  return {
    total: results.length,
    succeeded: succeeded.length,
    failed: results.length - succeeded.length,
    quality_denominator: scored.length,
    hit_at_1: average(scored.map((r) => found(r, 1) ? 1 : 0)),
    hit_at_5: average(scored.map((r) => found(r, Math.min(5, k)) ? 1 : 0)),
    hit_at_k: average(scored.map((r) => found(r, k) ? 1 : 0)),
    mrr: average(reciprocalRanks),
    latency_ms: { p50: percentile(succeeded.map((r) => r.latency_ms), 50), p95: percentile(succeeded.map((r) => r.latency_ms), 95) },
  };
}

function formatNumber(value) { return value.toFixed(3); }
function printTable(report) {
  console.log(`\nRetrieval evaluation: ${report.case_count} cases, k=${report.options.k}, threshold=${report.options.threshold}`);
  console.log(`RRF weights: semantic=${report.options.semantic_weight}, text=${report.options.text_weight} (lexical-priority baseline-derived default is 1:2).`);
  console.log(`Recency half-life: ${report.options.recency_half_life_days === null ? "disabled" : `${report.options.recency_half_life_days} days`}.`);
  console.log(`Quality denominator: ${report.options.allow_partial ? "successful queries only (--allow-partial)" : "all queries; failures count as misses (fail-closed default)"}.`);
  console.log("Warmup: query embeddings were precomputed before timed retrieval; latency measures retrieval calls only.");
  console.log("mode           hit@1  hit@5  hit@k  MRR    P50 ms  P95 ms  failed  denom");
  for (const [mode, result] of Object.entries(report.modes)) {
    if (result.status === "skipped") { console.log(`${mode.padEnd(14)} skipped (${result.note})`); continue; }
    const m = result.metrics;
    console.log(`${mode.padEnd(14)} ${formatNumber(m.hit_at_1).padStart(5)}  ${formatNumber(m.hit_at_5).padStart(5)}  ${formatNumber(m.hit_at_k).padStart(5)}  ${formatNumber(m.mrr).padStart(5)}  ${m.latency_ms.p50.toFixed(1).padStart(6)}  ${m.latency_ms.p95.toFixed(1).padStart(6)}  ${String(m.failed).padStart(6)}  ${String(m.quality_denominator).padStart(5)}`);
  }
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { console.error(`${error.message}\n\n${usage()}`); process.exitCode = 2; return; }
  if (options.help) { console.log(usage()); return; }
  if (options.envFile) {
    try { loadEnvFile(options.envFile); } catch (error) { console.error(`Could not read --env-file: ${error.message}`); process.exitCode = 2; return; }
  }
  let golden;
  try { golden = loadGolden(options.golden); } catch (error) { console.error(`Golden set error: ${error.message}`); process.exitCode = 2; return; }
  let c;
  try { c = config(); } catch (error) { console.error(`Configuration error: ${error.message}`); process.exitCode = 2; return; }

  const report = { generated_at: new Date().toISOString(), golden: path.resolve(options.golden), case_count: golden.length, options: { modes: options.modes, k: options.k, threshold: options.threshold, threshold_provided: options.thresholdProvided, semantic_weight: options.semanticWeight, text_weight: options.textWeight, recency_half_life_days: options.recencyHalfLifeDays ?? null, allow_partial: options.allowPartial }, notes: ["No database writes are performed.", "Query embeddings are precomputed in an unmeasured warmup phase. Mode latency measures retrieval calls and their network time only.", "The lexical-priority 1:2 default is baseline-derived from 21 real cases measured on 2026-07-14 and must be revalidated out of sample.", "Recency weighting is optional and disabled by default; no baseline-derived half-life is assumed.", options.allowPartial ? "Partial mode: failed queries are excluded from quality denominators." : "Fail-closed mode: failed queries count as quality misses and cause a non-zero exit."], modes: {} };
  const cache = new Map();
  const uniqueQueries = [...new Set(golden.map((entry) => entry.query))];
  console.log(`Warmup: precomputing embeddings for ${uniqueQueries.length} unique queries (not timed).`);
  const warmups = uniqueQueries.map((query) => {
    const pending = embed(query, c);
    cache.set(query, pending);
    return pending;
  });
  await Promise.allSettled(warmups);
  for (const mode of options.modes) {
    const results = [];
    let skipped;
    for (const entry of golden) {
      if (skipped) break;
      try {
        const outcome = await execute(mode, entry, c, cache, options);
        results.push({ id: entry.id, relevant_ids: entry.relevant_ids, returned_ids: outcome.ids, latency_ms: outcome.latency_ms });
      } catch (error) {
        if (mode === "hybrid" && error instanceof HttpError && error.status === 404) {
          skipped = "hybrid_search_thoughts RPC is not installed (HTTP 404)";
          break;
        }
        results.push({ id: entry.id, relevant_ids: entry.relevant_ids, returned_ids: [], error: error.message });
      }
    }
    report.modes[mode] = skipped ? { status: "skipped", note: skipped } : { status: "executed", metrics: metrics(results, options.k, options.allowPartial), results };
  }
  printTable(report);
  if (options.out) {
    const outputPath = path.resolve(options.out);
    const home = process.env.HOME ? path.resolve(process.env.HOME) : null;
    if (!outputPath.includes(`${path.sep}.planning${path.sep}`) || !(home && (outputPath === home || outputPath.startsWith(`${home}${path.sep}`)))) console.warn("Warning: le rapport peut contenir des données personnelles — ne pas committer");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Full report: ${options.out}`);
  }
  const executed = Object.values(report.modes).filter((result) => result.status === "executed");
  const hasFailure = executed.some((result) => result.metrics.failed > 0);
  const allFailedMode = executed.some((result) => result.metrics.total > 0 && result.metrics.succeeded === 0);
  if ((!options.allowPartial && hasFailure) || (options.allowPartial && allFailedMode)) process.exitCode = 1;
}

main().catch((error) => { console.error(`Unexpected error: ${error.stack || error.message}`); process.exitCode = 1; });
