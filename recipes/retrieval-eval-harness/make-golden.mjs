#!/usr/bin/env node
/** Read-only candidate helper: it never writes to Open Brain or a golden set. */
import fs from "node:fs";

function usage() { return `Usage: node make-golden.mjs --query "..." [options]\n\nOptions:\n  --query <text>         Query for candidate retrieval (required)\n  --candidates <n>       Candidates from each retrieval source (default: 15)\n  --semantic-weight <n>  Semantic RRF weight, finite and > 0 (default: 1.0)\n  --text-weight <n>      Full-text RRF weight, finite and > 0 (default: 2.0)\n  --env-file <path>      Optional local KEY=VALUE file\n  --help                 Show this message\n\nPrints semantic + text candidates fused with weighted RRF (semantic 1.0, text 2.0 by default) so a human can select relevant_ids manually. Network requests time out after 15s (embeddings) or 10s (PostgREST).`; }
function parseArgs(argv) {
  const options = { candidates: 15, semanticWeight: 1.0, textWeight: 2.0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") return { help: true };
    const value = argv[++i];
    if (!value) throw new Error(`Missing value for ${arg}`);
    if (arg === "--query") options.query = value;
    else if (arg === "--candidates") options.candidates = Number(value);
    else if (arg === "--semantic-weight") options.semanticWeight = Number(value);
    else if (arg === "--text-weight") options.textWeight = Number(value);
    else if (arg === "--env-file") options.envFile = value;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.query?.trim()) throw new Error("--query is required");
  if (!Number.isInteger(options.candidates) || options.candidates < 1) throw new Error("--candidates must be a positive integer");
  if (!Number.isFinite(options.semanticWeight) || options.semanticWeight <= 0) throw new Error("--semantic-weight must be a finite number > 0");
  if (!Number.isFinite(options.textWeight) || options.textWeight <= 0) throw new Error("--text-weight must be a finite number > 0");
  return options;
}
function loadEnvFile(file) {
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim(); const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!line || line.startsWith("#") || !match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}
class HttpError extends Error { constructor(label, status, body) { super(`${label} failed: HTTP ${status}${body ? ` — ${body.slice(0, 240)}` : ""}`); } }
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
function rowDate(row) { return row.created_at || row.updated_at || row.timestamp || "—"; }
function rowType(row) { return row.type || row.metadata?.type || row.source_type || "—"; }
function preview(row) { return String(row.content || row.text || row.metadata?.content || "").replace(/\s+/g, " ").slice(0, 140); }
function fuse(semanticRows, textRows, limit, semanticWeight, textWeight) {
  const scores = new Map(), rows = new Map(), sources = new Map();
  for (const [source, list, weight] of [["semantic", semanticRows, semanticWeight], ["text", textRows, textWeight]]) for (const [index, row] of (Array.isArray(list) ? list : []).entries()) {
    const id = String(row.id ?? ""); if (!id) continue;
    scores.set(id, (scores.get(id) || 0) + weight / (60 + index + 1)); rows.set(id, row); sources.set(id, `${sources.get(id) ? `${sources.get(id)}+` : ""}${source}`);
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([id, score]) => ({ id, score, sources: sources.get(id), row: rows.get(id) }));
}
async function main() {
  let options; try { options = parseArgs(process.argv.slice(2)); } catch (error) { console.error(`${error.message}\n\n${usage()}`); process.exitCode = 2; return; }
  if (options.help) { console.log(usage()); return; }
  if (options.envFile) { try { loadEnvFile(options.envFile); } catch (error) { console.error(`Could not read --env-file: ${error.message}`); process.exitCode = 2; return; } }
  const url = process.env.OPEN_BRAIN_URL?.replace(/\/$/, ""), serviceKey = process.env.OPEN_BRAIN_SERVICE_KEY, embeddingKey = process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY;
  if (!url || !serviceKey || !embeddingKey) { console.error("Configuration error: OPEN_BRAIN_URL, OPEN_BRAIN_SERVICE_KEY, and OPENROUTER_API_KEY or LLM_API_KEY are required"); process.exitCode = 2; return; }
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  try {
    const embeddingBase = (process.env.OPENROUTER_BASE || "https://openrouter.ai/api/v1").replace(/\/$/, "");
    const embedding = await postJson(`${embeddingBase}/embeddings`, { Authorization: `Bearer ${embeddingKey}` }, { model: "openai/text-embedding-3-small", input: options.query }, "Embedding", 15_000);
    const vector = embedding?.data?.[0]?.embedding;
    if (!Array.isArray(vector)) throw new Error("Embedding response did not contain data[0].embedding");
    const [semanticRows, textRows] = await Promise.all([
      postJson(`${url}/rest/v1/rpc/match_thoughts`, headers, { query_embedding: vector, match_threshold: 0.3, match_count: options.candidates }, "match_thoughts", 10_000),
      postJson(`${url}/rest/v1/rpc/search_thoughts_text`, headers, { p_query: options.query, p_limit: options.candidates, p_filter: {}, p_offset: 0 }, "search_thoughts_text", 10_000),
    ]);
    console.log(`Candidates for: ${options.query}\nRRF weights: semantic=${options.semanticWeight}, text=${options.textWeight}.\nRead-only: choose relevant IDs manually; no golden file or database row was written.\n`);
    for (const [index, candidate] of fuse(semanticRows, textRows, options.candidates, options.semanticWeight, options.textWeight).entries()) {
      const row = candidate.row;
      console.log(`${String(index + 1).padStart(2)}. ${candidate.id}\n    date: ${rowDate(row)} | type: ${rowType(row)} | sources: ${candidate.sources}\n    ${preview(row)}\n`);
    }
  } catch (error) { console.error(`Candidate lookup failed: ${error.message}`); process.exitCode = 1; }
}
main().catch((error) => { console.error(`Unexpected error: ${error.stack || error.message}`); process.exitCode = 1; });
