#!/usr/bin/env node
/** Point-in-time SLO verifier. Read-only and safe for scheduled execution. */
import fs from "node:fs";

const HELP = `Usage: node recipes/brain-ops-toolkit/slo-report.mjs --env-file <path>

Measures the OB1 operational SLOs: MCP tools/list availability, neutral
search_thoughts latency, per-source freshness, embedding integrity, extraction
queue failures older than 24 hours, and aggregate statistics divergence.
Output is a compact table followed by JSON. It never prints thought content.

Options:
  --env-file <path>  Load simple KEY=VALUE environment entries
  --help             Show this help

Required REST env: OPEN_BRAIN_URL, OPEN_BRAIN_SERVICE_KEY.
Required MCP env: OPEN_BRAIN_MCP_URL (or MCP_URL), OPEN_BRAIN_ACCESS_KEY (or
MCP_ACCESS_KEY). Network calls time out after 10 seconds. Exit 1 on any SLO
violation or unavailable required measurement.`;
const NEUTRAL_QUERIES = ["réunion projet", "note de référence", "décision produit"];
function fail(m) { console.error(`Error: ${m}`); process.exitCode = 1; }
function env(path) { for (const l of fs.readFileSync(path, "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/); if (m && !m[1].startsWith("#")) process.env[m[1]] ??= m[2].replace(/^['"]|['"]$/g, ""); } }
function parse() { const o = {}; for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a === "--help") { console.log(HELP); process.exit(0); } if (a === "--env-file") o.envFile = process.argv[++i]; else throw new Error(`Unknown or incomplete option: ${a}`); } if (!o.envFile) throw new Error("--env-file is required"); return o; }
async function request(url, options = {}) { try { const r = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) }); const text = await r.text(); if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`); return { response: r, text }; } catch (e) { throw new Error(`Network/API request failed${e.name === "TimeoutError" ? " after 10000ms" : ""}: ${e.message}`); } }
function json(text) { const line = text.split(/\r?\n/).filter((x) => x.startsWith("data:")).map((x) => x.slice(5).trim()).pop(); try { return JSON.parse(line || text); } catch { throw new Error("MCP returned non-JSON"); } }
async function mcp(url, key, name, args, id) { const start = performance.now(); const result = await request(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": key }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) }); const value = json(result.text); if (value.error) throw new Error(`MCP error: ${value.error.message || "unknown"}`); return { value, ms: performance.now() - start }; }
function percentile(values, p) { const s = [...values].sort((a, b) => a - b); return s[Math.ceil(s.length * p / 100) - 1] ?? Infinity; }
function countFrom(r) { const n = r.response.headers.get("content-range")?.match(/\/(\d+)$/)?.[1]; if (n === undefined) throw new Error("PostgREST did not return an exact count"); return Number(n); }
function findMetric(value, aliases) { if (!value || typeof value !== "object") return undefined; for (const [key, item] of Object.entries(value)) { if (aliases.includes(key.toLowerCase()) && typeof item === "number" && Number.isFinite(item)) return item; if (item && typeof item === "object") { const found = findMetric(item, aliases); if (found !== undefined) return found; } } return undefined; }
async function main() {
  const o = parse(); env(o.envFile); const base = process.env.OPEN_BRAIN_URL?.replace(/\/$/, ""), serviceKey = process.env.OPEN_BRAIN_SERVICE_KEY, mcpUrl = process.env.OPEN_BRAIN_MCP_URL || process.env.MCP_URL, mcpKey = process.env.OPEN_BRAIN_ACCESS_KEY || process.env.MCP_ACCESS_KEY; if (!base || !serviceKey || !mcpUrl || !mcpKey) throw new Error("Set REST and MCP URL/key environment variables documented in --help"); const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Prefer: "count=exact" }; const checks = [];
  let probes = 0; const probeLatencies = []; for (let i = 0; i < 5; i++) try { const r = await mcp(mcpUrl, mcpKey, "tools/list", {}, `slo-list-${i}`); probes++; probeLatencies.push(r.ms); } catch { /* counted below */ } const availability = probes / 5 * 100; checks.push({ name: "mcp_availability", value: `${availability.toFixed(1)}% (${probes}/5); P50 ${percentile(probeLatencies, 50).toFixed(1)}ms`, threshold: ">=99%", pass: availability >= 99 });
  const latencies = []; let searchFailures = 0; for (const [i, query] of NEUTRAL_QUERIES.entries()) try { const r = await mcp(mcpUrl, mcpKey, "search_thoughts", { query, limit: 10, mode: "hybrid" }, `slo-search-${i}`); latencies.push(r.ms); } catch { searchFailures++; } const p50 = percentile(latencies, 50), p95 = percentile(latencies, 95); checks.push({ name: "search_thoughts_latency", value: searchFailures ? `${latencies.length}/3 successful` : `P50 ${p50.toFixed(1)}ms; P95 ${p95.toFixed(1)}ms`, threshold: "P50<2500ms; P95<4000ms", pass: searchFailures === 0 && p50 < 2500 && p95 < 4000 });
  // Fraîcheur : dépend de l'ARRIVÉE d'entrées (un week-end sans mémo vocal n'est
  // pas une panne). Les seuils détectent une interruption multi-jours du pipeline,
  // pas l'absence d'activité humaine.
  const FRESHNESS_HOURS = { "notion-meetings": 168, gcal: 26, gmail: 26, "voice-memo": 168 };
  for (const [source, maxHours] of Object.entries(FRESHNESS_HOURS)) { try { const q = new URLSearchParams({ select: "created_at", "metadata->>source": `eq.${source}`, order: "created_at.desc", limit: "1" }); const rows = JSON.parse((await request(`${base}/rest/v1/thoughts?${q}`, { headers })).text); const latest = rows[0]?.created_at; const age = latest ? (Date.now() - Date.parse(latest)) / 3600000 : Infinity; checks.push({ name: `freshness:${source}`, value: Number.isFinite(age) ? `${age.toFixed(2)}h` : "missing", threshold: `<${maxHours}h (input-dependent)`, pass: age < maxHours }); } catch (e) { checks.push({ name: `freshness:${source}`, value: "unavailable", threshold: `<${maxHours}h (input-dependent)`, pass: false }); } }
  try { const missingRows = []; let offset = 0; while (true) { const q = new URLSearchParams({ select: "id,content", embedding: "is.null", order: "id.asc", limit: "1000", offset: String(offset) }); const page = JSON.parse((await request(`${base}/rest/v1/thoughts?${q}`, { headers })).text); missingRows.push(...page); if (page.length < 1000) break; offset += 1000; } const missing = missingRows.filter((row) => String(row.content ?? "").length >= 5).length; checks.push({ name: "embedding_integrity", value: String(missing), threshold: "0 (excluding <5 chars)", pass: missing === 0 }); } catch { checks.push({ name: "embedding_integrity", value: "unavailable", threshold: "0", pass: false }); }
  try { const cutoff = new Date(Date.now() - 24 * 3600000).toISOString(); const q = new URLSearchParams({ select: "thought_id", status: "eq.failed", queued_at: `lt.${cutoff}` }); const r = await request(`${base}/rest/v1/entity_extraction_queue?${q}`, { headers: { ...headers, Range: "0-0" } }); const failed = countFrom(r); checks.push({ name: "extraction_queue_failed_24h", value: String(failed), threshold: "0", pass: failed === 0 }); } catch { checks.push({ name: "extraction_queue_failed_24h", value: "unavailable", threshold: "0", pass: false }); }
  try { const restResponse = await request(`${base}/rest/v1/thoughts?select=id`, { headers: { ...headers, Range: "0-0" } }); const restTotal = countFrom(restResponse); const rpc = JSON.parse((await request(`${base}/rest/v1/rpc/brain_stats_aggregate`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ p_since_days: null, p_exclude_restricted: false }) })).text); const rpcTotal = findMetric(rpc, ["total", "totalthoughts", "total_thoughts"]); if (rpcTotal === undefined) throw new Error("aggregate total unavailable"); const divergence = restTotal === 0 ? (rpcTotal === 0 ? 0 : 100) : Math.abs(restTotal - rpcTotal) / restTotal * 100; checks.push({ name: "statistics_accuracy", value: `${divergence.toFixed(3)}%`, threshold: "<0.5%", pass: divergence < 0.5, postgrest_total: restTotal, aggregate_total: rpcTotal }); } catch { checks.push({ name: "statistics_accuracy", value: "unavailable", threshold: "<0.5%", pass: false }); }
  console.table(checks.map(({ name, value, threshold, pass }) => ({ name, value, threshold, status: pass ? "PASS" : "FAIL" }))); const report = { generated_at: new Date().toISOString(), status: checks.every((x) => x.pass) ? "pass" : "fail", checks }; console.log(JSON.stringify(report, null, 2)); if (report.status !== "pass") process.exitCode = 1;
}
main().catch((e) => fail(e.message));
