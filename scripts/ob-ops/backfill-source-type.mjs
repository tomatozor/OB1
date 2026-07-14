#!/usr/bin/env node
/** Backfill source_type from metadata.source. Dry-run unless --apply is supplied. */
import fs from "node:fs";
const HELP = `Usage: node scripts/ob-ops/backfill-source-type.mjs [options]

Counts thoughts where source_type is NULL. --apply tries backfill_source_type
first, then falls back to qualified PostgREST PATCH requests.

Options:
  --apply             Persist source_type values
  --batch <number>    Fallback batch size (default: 100)
  --env-file <path>   Load simple KEY=VALUE environment entries
  --help              Show this help`;
function fail(message) { console.error(`Error: ${message}`); process.exitCode = 1; }
function loadEnvFile(path) { for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/); if (m && !m[1].startsWith("#")) process.env[m[1]] ??= m[2].replace(/^['"]|['"]$/g, ""); } }
function parse() { const o = { apply: false, batch: 100 }; for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a === "--help") { console.log(HELP); process.exit(0); } if (a === "--apply") o.apply = true; else if (a === "--batch") o.batch = Number(process.argv[++i]); else if (a === "--env-file") o.envFile = process.argv[++i]; else throw new Error(`Unknown or incomplete option: ${a}`); } if (!Number.isInteger(o.batch) || o.batch < 1 || o.batch > 1000) throw new Error("--batch must be an integer from 1 to 1000"); return o; }
async function request(url, options = {}) { try { const r = await fetch(url, options); if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`); return r; } catch (e) { throw new Error(`Network/API request failed: ${e.message}`); } }
async function main() {
  const o = parse(); if (o.envFile) loadEnvFile(o.envFile); const base = process.env.OPEN_BRAIN_URL?.replace(/\/$/, ""); const key = process.env.OPEN_BRAIN_SERVICE_KEY; if (!base || !key) throw new Error("OPEN_BRAIN_URL and OPEN_BRAIN_SERVICE_KEY must be configured"); const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const fetchMissing = async () => { const all = []; let offset = 0; while (true) { const page = await (await request(`${base}/rest/v1/thoughts?${new URLSearchParams({ select: "id,metadata", source_type: "is.null", order: "id.asc", limit: "100", offset: String(offset) })}`, { headers })).json(); all.push(...page); if (page.length < 100) return all; offset += 100; } };
  let rows = await fetchMissing(); const counts = Object.fromEntries(Object.entries(rows.reduce((a, r) => { const s = r.metadata?.source ?? "unknown"; a[s] = (a[s] ?? 0) + 1; return a; }, {})).sort()); console.log(JSON.stringify({ mode: o.apply ? "apply" : "dry-run", by_source: counts, sample_ids: rows.slice(0, 10).map((r) => r.id) }, null, 2));
  let updated = 0; let method = "dry-run";
  if (o.apply) {
    try { const rpc = await request(`${base}/rest/v1/rpc/backfill_source_type`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ p_batch: o.batch, p_dry_run: false }) }); const data = await rpc.json(); updated = typeof data === "number" ? data : (data?.updated ?? data?.count ?? 0); method = "rpc"; }
    catch (error) {
      console.error(`RPC backfill_source_type unavailable; using qualified PATCH fallback: ${error.message}`); method = "patch-fallback"; rows = await fetchMissing();
      const groups = new Map(); for (const row of rows) { const source = row.metadata?.source; if (typeof source === "string" && source) groups.set(source, [...(groups.get(source) ?? []), row.id]); }
      for (const [source, ids] of groups) for (let start = 0; start < ids.length; start += o.batch) { const batch = ids.slice(start, start + o.batch); await request(`${base}/rest/v1/thoughts?${new URLSearchParams({ id: `in.(${batch.join(",")})`, source_type: "is.null", "metadata->>source": `eq.${source}` })}`, { method: "PATCH", headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ source_type: source }) }); updated += batch.length; }
    }
  }
  console.log(JSON.stringify({ scanned: rows.length, updated, method }));
}
main().catch((e) => fail(e.message));
