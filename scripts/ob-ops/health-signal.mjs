#!/usr/bin/env node
/** REST-observable health signal; does not depend on unexposed pg_cron views. */
import fs from "node:fs";
const HELP = `Usage: node scripts/ob-ops/health-signal.mjs [options]

Checks source-write freshness, entity_extraction_queue depth, and missing
embeddings. Output is stable JSON; non-green states exit non-zero.

Options:
  --max-age-hours <source=hours>  Repeatable; defaults: notion=2, voice-memo=2,
                                  claude-code-session=48
  --max-pending <number>          Expected pending queue maximum (default: 49)
  --max-missing-embeddings <n>    Expected missing embedding maximum (default: 9)
  --env-file <path>               Load simple KEY=VALUE environment entries
  Network requests time out after 10 seconds
  --help                          Show this help`;
function fail(m) { console.error(`Error: ${m}`); process.exitCode = 1; }
function env(path) { for (const l of fs.readFileSync(path, "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/); if (m && !m[1].startsWith("#")) process.env[m[1]] ??= m[2].replace(/^['"]|['"]$/g, ""); } }
function parse() { const o = { maxAge: new Map([["notion", 2], ["voice-memo", 2], ["claude-code-session", 48]]), maxPending: 49, maxMissing: 9 }; for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a === "--help") { console.log(HELP); process.exit(0); } if (a === "--max-age-hours") { const [s, raw] = (process.argv[++i] ?? "").split("="); const n = Number(raw); if (!s || !Number.isFinite(n) || n < 0) throw new Error("--max-age-hours must be source=non-negative-hours"); o.maxAge.set(s, n); } else if (a === "--max-pending") o.maxPending = Number(process.argv[++i]); else if (a === "--max-missing-embeddings") o.maxMissing = Number(process.argv[++i]); else if (a === "--env-file") o.envFile = process.argv[++i]; else throw new Error(`Unknown or incomplete option: ${a}`); } if (![o.maxPending, o.maxMissing].every((n) => Number.isInteger(n) && n >= 0)) throw new Error("queue and embedding thresholds must be non-negative integers"); return o; }
async function request(url, options = {}) { try { const r = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) }); if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`); return r; } catch (e) { throw new Error(`Network/API request failed${e.name === "TimeoutError" ? " after 10000ms" : ""}: ${e.message}`); } }
async function main() {
  const o = parse(); if (o.envFile) env(o.envFile); const base = process.env.OPEN_BRAIN_URL?.replace(/\/$/, ""); const key = process.env.OPEN_BRAIN_SERVICE_KEY; if (!base || !key) throw new Error("OPEN_BRAIN_URL and OPEN_BRAIN_SERVICE_KEY must be configured"); const headers = { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" }; const checks = [];
  for (const [source, maxHours] of o.maxAge) { const q = new URLSearchParams({ select: "created_at", "metadata->>source": `eq.${source}`, order: "created_at.desc", limit: "1" }); const data = await (await request(`${base}/rest/v1/thoughts?${q}`, { headers })).json(); const latest = data[0]?.created_at ?? null; const ageHours = latest ? (Date.now() - Date.parse(latest)) / 3600000 : null; checks.push({ name: `freshness:${source}`, status: ageHours !== null && ageHours <= maxHours ? "green" : "red", latest_created_at: latest, age_hours: ageHours === null ? null : Number(ageHours.toFixed(2)), max_age_hours: maxHours }); }
  const queueCount = async (status) => { const r = await request(`${base}/rest/v1/entity_extraction_queue?${new URLSearchParams({ select: "id", status: `eq.${status}` })}`, { headers: { ...headers, Range: "0-0" } }); const total = r.headers.get("content-range")?.match(/\/(\d+)$/)?.[1]; if (total === undefined) throw new Error("PostgREST did not return an exact queue count"); return Number(total); };
  try { const pending = await queueCount("pending"); const failed = await queueCount("failed"); checks.push({ name: "entity_extraction_queue", status: failed > 0 ? "red" : pending > o.maxPending ? "yellow" : "green", pending, failed, max_pending: o.maxPending, expected_failed: 0 }); } catch (e) { checks.push({ name: "entity_extraction_queue", status: "yellow", unavailable: e.message }); }
  const e = await request(`${base}/rest/v1/thoughts?${new URLSearchParams({ select: "id", embedding: "is.null" })}`, { headers: { ...headers, Range: "0-0" } }); const missing = Number(e.headers.get("content-range")?.match(/\/(\d+)$/)?.[1]); if (!Number.isFinite(missing)) throw new Error("PostgREST did not return an exact embedding count"); checks.push({ name: "missing_embeddings", status: missing > o.maxMissing ? "yellow" : "green", missing, max_missing: o.maxMissing });
  const severity = { green: 0, yellow: 1, red: 2 }; const status = checks.reduce((worst, c) => severity[c.status] > severity[worst] ? c.status : worst, "green"); console.log(JSON.stringify({ status, checks })); if (status !== "green") process.exitCode = 1;
}
main().catch((e) => fail(e.message));
