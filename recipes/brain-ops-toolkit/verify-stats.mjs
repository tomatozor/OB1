#!/usr/bin/env node
/** Compare exact PostgREST counts with installed aggregate RPCs. */
import fs from "node:fs";
const HELP = `Usage: node recipes/brain-ops-toolkit/verify-stats.mjs [options]

Compares exact PostgREST counts with brain_stats_aggregate and, when installed,
thought_stats_exact. Exits 1 when a comparable metric differs by more than 0.5%.

Options:
  --since-days <number>  Compare a matching lookback period (default: all-time)
  --env-file <path>      Load simple KEY=VALUE environment entries
  Network requests time out after 10 seconds
  --help                 Show this help`;
function fail(m) { console.error(`Error: ${m}`); process.exitCode = 1; }
function env(path) { for (const l of fs.readFileSync(path, "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/); if (m && !m[1].startsWith("#")) process.env[m[1]] ??= m[2].replace(/^['"]|['"]$/g, ""); } }
function parse() { const o = { sinceDays: null }; for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a === "--help") { console.log(HELP); process.exit(0); } if (a === "--since-days") o.sinceDays = Number(process.argv[++i]); else if (a === "--env-file") o.envFile = process.argv[++i]; else throw new Error(`Unknown or incomplete option: ${a}`); } if (o.sinceDays !== null && (!Number.isFinite(o.sinceDays) || o.sinceDays < 0)) throw new Error("--since-days must be non-negative"); return o; }
async function request(url, options = {}) { try { const r = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) }); if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`); return r; } catch (e) { throw new Error(`Network/API request failed${e.name === "TimeoutError" ? " after 10000ms" : ""}: ${e.message}`); } }
function numeric(value) { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function findMetric(value, aliases) { if (!value || typeof value !== "object") return undefined; for (const [key, item] of Object.entries(value)) { if (aliases.includes(key.toLowerCase())) { const n = numeric(item); if (n !== undefined) return n; } if (item && typeof item === "object") { const n = findMetric(item, aliases); if (n !== undefined) return n; } } return undefined; }
async function main() {
  const o = parse(); if (o.envFile) env(o.envFile); const base = process.env.OPEN_BRAIN_URL?.replace(/\/$/, ""); const key = process.env.OPEN_BRAIN_SERVICE_KEY; if (!base || !key) throw new Error("OPEN_BRAIN_URL and OPEN_BRAIN_SERVICE_KEY must be configured"); const headers = { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" };
  const count = async (filter = {}) => { const r = await request(`${base}/rest/v1/thoughts?${new URLSearchParams({ select: "id", ...filter })}`, { headers: { ...headers, Range: "0-0" } }); const total = r.headers.get("content-range")?.match(/\/(\d+|\*)$/)?.[1]; if (!total || total === "*") throw new Error("PostgREST did not return an exact count (missing Content-Range)"); return Number(total); };
  const timeFilter = o.sinceDays === null ? {} : { created_at: `gte.${new Date(Date.now() - o.sinceDays * 86400000).toISOString()}` };
  const total = await count(timeFilter); const embeddingNull = await count({ ...timeFilter, embedding: "is.null" }); const restricted = await count({ ...timeFilter, sensitivity_tier: "eq.restricted" });
  const types = new Set(); let offset = 0; while (true) { const r = await (await request(`${base}/rest/v1/thoughts?${new URLSearchParams({ select: "type", order: "id.asc", limit: "1000", offset: String(offset), ...timeFilter })}`, { headers })).json(); for (const row of r) if (row.type) types.add(row.type); if (r.length < 1000) break; offset += 1000; }
  const rest = { since_days: o.sinceDays, total, embedding_null: embeddingNull, restricted, by_type: {} }; for (const type of [...types].sort()) rest.by_type[type] = await count({ ...timeFilter, type: `eq.${type}` });
  const rpcResults = {};
  for (const [name, body] of [["brain_stats_aggregate", { p_since_days: o.sinceDays, p_exclude_restricted: false }], ["thought_stats_exact", {}]]) { try { rpcResults[name] = await (await request(`${base}/rest/v1/rpc/${name}`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(); } catch (e) { rpcResults[name] = { unavailable: e.message }; console.error(`${name} unavailable: ${e.message}`); } }
  const comparisons = [];
  for (const [rpcName, data] of Object.entries(rpcResults)) {
    if (data?.unavailable) continue;
    for (const [metric, expected] of [["total", total], ["embedding_null", embeddingNull], ["restricted", restricted]]) { const actual = findMetric(data, [metric, metric.replace("_", ""), metric === "total" ? "total_thoughts" : metric]); if (actual !== undefined) { const deltaPct = expected === 0 ? (actual === 0 ? 0 : 100) : Math.abs(actual - expected) / expected * 100; comparisons.push({ rpc: rpcName, metric, postgrest: expected, rpc_value: actual, delta_pct: Number(deltaPct.toFixed(3)), pass: deltaPct <= 0.5 }); } }
    const typeMap = data?.by_type ?? data?.types ?? data?.type_counts; if (typeMap && typeof typeMap === "object") for (const [type, expected] of Object.entries(rest.by_type)) { const actual = numeric(typeMap[type]); if (actual !== undefined) { const deltaPct = expected === 0 ? (actual === 0 ? 0 : 100) : Math.abs(actual - expected) / expected * 100; comparisons.push({ rpc: rpcName, metric: `type:${type}`, postgrest: expected, rpc_value: actual, delta_pct: Number(deltaPct.toFixed(3)), pass: deltaPct <= 0.5 }); } }
  }
  console.table(comparisons); console.log(JSON.stringify({ postgrest: rest, rpc: rpcResults, comparisons }, null, 2)); if (comparisons.some((x) => !x.pass)) process.exitCode = 1;
}
main().catch((e) => fail(e.message));
