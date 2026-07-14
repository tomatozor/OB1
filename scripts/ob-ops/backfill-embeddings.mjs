#!/usr/bin/env node
/** Backfill missing thought embeddings. Dry-run unless --apply is supplied. */
import fs from "node:fs";

const HELP = `Usage: node scripts/ob-ops/backfill-embeddings.mjs [options]

Lists thoughts whose embedding is NULL. Dry-run is the default and never sends
content to an embedding provider.

Options:
  --apply                 Generate and persist embeddings
  --min-length <number>   Minimum content length (default: 5)
  --env-file <path>       Load simple KEY=VALUE environment entries
  --help                  Show this help`;

function fail(message) { console.error(`Error: ${message}`); process.exitCode = 1; }
function loadEnvFile(path) {
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && !match[1].startsWith("#")) process.env[match[1]] ??= match[2].replace(/^['"]|['"]$/g, "");
  }
}
function args() {
  const out = { apply: false, minLength: 5 };
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--help") { console.log(HELP); process.exit(0); }
    if (arg === "--apply") out.apply = true;
    else if (arg === "--min-length") out.minLength = Number(process.argv[++i]);
    else if (arg === "--env-file") out.envFile = process.argv[++i];
    else throw new Error(`Unknown or incomplete option: ${arg}`);
  }
  if (!Number.isInteger(out.minLength) || out.minLength < 0) throw new Error("--min-length must be a non-negative integer");
  return out;
}
function config() {
  const url = process.env.OPEN_BRAIN_URL?.replace(/\/$/, "");
  const key = process.env.OPEN_BRAIN_SERVICE_KEY;
  if (!url || !key) throw new Error("OPEN_BRAIN_URL and OPEN_BRAIN_SERVICE_KEY must be configured");
  return { url, key };
}
async function request(url, options = {}) {
  try {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return response;
  } catch (error) { throw new Error(`Network/API request failed: ${error.message}`); }
}
async function main() {
  const options = args(); if (options.envFile) loadEnvFile(options.envFile);
  const { url, key } = config(); const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const rows = []; let offset = 0;
  while (true) {
    const query = new URLSearchParams({ select: "id,content,metadata", embedding: "is.null", order: "id.asc", limit: "100", offset: String(offset) });
    const page = await (await request(`${url}/rest/v1/thoughts?${query}`, { headers })).json();
    rows.push(...page); if (page.length < 100) break; offset += 100;
  }
  const short = rows.filter((row) => (row.content ?? "").length < options.minLength);
  const eligible = rows.filter((row) => (row.content ?? "").length >= options.minLength);
  const bySource = Object.fromEntries(Object.entries(eligible.reduce((a, row) => { const source = row.metadata?.source ?? "unknown"; a[source] = (a[source] ?? 0) + 1; return a; }, {})).sort());
  console.log(JSON.stringify({ mode: options.apply ? "apply" : "dry-run", by_source: bySource, sample_ids: rows.slice(0, 10).map((r) => r.id), skipped_short_ids: short.slice(0, 10).map((r) => r.id) }, null, 2));
  let embedded = 0; let failed = 0;
  if (options.apply) {
    const embeddingUrl = `${(process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "")}/embeddings`;
    const apiKey = process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY or LLM_API_KEY must be configured for --apply");
    for (const row of eligible) {
      try {
        const stillNull = await (await request(`${url}/rest/v1/thoughts?${new URLSearchParams({ select: "id", id: `eq.${row.id}`, embedding: "is.null" })}`, { headers })).json();
        if (!stillNull.length) continue;
        let vector;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await request(embeddingUrl, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "openai/text-embedding-3-small", input: row.content.slice(0, 8000) }) });
            vector = (await response.json())?.data?.[0]?.embedding;
            if (!Array.isArray(vector) || !vector.length) throw new Error("embedding response missing vector data");
            break;
          } catch (error) { if (attempt === 2) throw error; await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt))); }
        }
        await request(`${url}/rest/v1/thoughts?${new URLSearchParams({ id: `eq.${row.id}`, embedding: "is.null" })}`, { method: "PATCH", headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ embedding: vector }) });
        embedded++;
      } catch (error) { failed++; console.error(`Failed id ${row.id}: ${error.message}`); }
    }
  }
  console.log(JSON.stringify({ scanned: rows.length, embedded, skipped_short: short.length, failed }));
}
main().catch((error) => fail(error.message));
