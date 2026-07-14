#!/usr/bin/env node
/** Backfill source_type from metadata.source. Dry-run unless --apply is supplied. */
import fs from "node:fs";

const MAX_ITERATIONS = 1000;
const HELP = `Usage: node recipes/brain-ops-toolkit/backfill-source-type.mjs [options]

Counts thoughts where source_type is NULL. --apply repeatedly calls
backfill_source_type(p_batch, p_dry_run) until no qualified rows remain, then
falls back to qualified PostgREST PATCH batches if the RPC is unavailable.
Dry-run makes one read-only pass.

Options:
  --apply             Persist source_type values
  --batch <number>    RPC and fallback batch size (default: 100)
  --env-file <path>   Load simple KEY=VALUE environment entries
  Network requests time out after 10 seconds
  --help              Show this help

Exit codes:
  0  Completed successfully
  1  Configuration, network/API, iteration-limit, or apply failure`;

function fail(message) { console.error(`Error: ${message}`); process.exitCode = 1; }
function loadEnvFile(path) { for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/); if (m && !m[1].startsWith("#")) process.env[m[1]] ??= m[2].replace(/^['"]|['"]$/g, ""); } }
function parse() { const o = { apply: false, batch: 100 }; for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a === "--help") { console.log(HELP); process.exit(0); } if (a === "--apply") o.apply = true; else if (a === "--batch") o.batch = Number(process.argv[++i]); else if (a === "--env-file") o.envFile = process.argv[++i]; else throw new Error(`Unknown or incomplete option: ${a}`); } if (!Number.isInteger(o.batch) || o.batch < 1 || o.batch > 1000) throw new Error("--batch must be an integer from 1 to 1000"); return o; }
async function request(url, options = {}) { try { const r = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) }); if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`); return r; } catch (e) { throw new Error(`Network/API request failed${e.name === "TimeoutError" ? " after 10000ms" : ""}: ${e.message}`); } }
function nonNegativeInteger(value, name) { if (!Number.isInteger(value) || value < 0) throw new Error(`backfill_source_type returned invalid ${name}`); return value; }
function rpcUnavailable(error) { return /HTTP (404|405):/.test(error.message); }
async function main() {
  const o = parse(); if (o.envFile) loadEnvFile(o.envFile); const base = process.env.OPEN_BRAIN_URL?.replace(/\/$/, ""); const key = process.env.OPEN_BRAIN_SERVICE_KEY; if (!base || !key) throw new Error("OPEN_BRAIN_URL and OPEN_BRAIN_SERVICE_KEY must be configured"); const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const fetchMissing = async () => { const all = []; let offset = 0; while (true) { const page = await (await request(`${base}/rest/v1/thoughts?${new URLSearchParams({ select: "id,metadata", source_type: "is.null", order: "id.asc", limit: "100", offset: String(offset) })}`, { headers })).json(); all.push(...page); if (page.length < 100) return all; offset += 100; } };
  const fetchQualifiedBatch = async () => {
    const qualified = []; let offset = 0;
    while (qualified.length < o.batch) {
      const query = new URLSearchParams({ select: "id,metadata", source_type: "is.null", "metadata->>source": "not.is.null", order: "id.asc", limit: String(o.batch), offset: String(offset) });
      const page = await (await request(`${base}/rest/v1/thoughts?${query}`, { headers })).json();
      qualified.push(...page.filter((row) => typeof row.metadata?.source === "string" && row.metadata.source.trim()));
      if (page.length < o.batch) break;
      offset += o.batch;
    }
    return qualified.slice(0, o.batch);
  };
  const rows = await fetchMissing(); const counts = Object.fromEntries(Object.entries(rows.reduce((a, r) => { const s = r.metadata?.source ?? "unknown"; a[s] = (a[s] ?? 0) + 1; return a; }, {})).sort()); console.log(JSON.stringify({ mode: o.apply ? "apply" : "dry-run", by_source: counts, sample_ids: rows.slice(0, 10).map((r) => r.id) }, null, 2));
  let updated = 0; let failed = 0; let iterations = 0; let method = "dry-run"; let remaining = null;
  if (o.apply) {
    try {
      method = "rpc";
      do {
        if (iterations >= MAX_ITERATIONS) throw new Error(`backfill_source_type exceeded ${MAX_ITERATIONS} iterations`);
        const rpc = await request(`${base}/rest/v1/rpc/backfill_source_type`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ p_batch: o.batch, p_dry_run: false }) });
        const data = await rpc.json();
        if (!data || typeof data !== "object") throw new Error("backfill_source_type returned an invalid response");
        updated += nonNegativeInteger(data.updated, "updated");
        remaining = nonNegativeInteger(data.remaining, "remaining");
        iterations++;
      } while (remaining > 0);
    } catch (error) {
      if (iterations > 0 || !rpcUnavailable(error)) { failed++; console.error(`RPC backfill_source_type failed: ${error.message}`); }
      else {
      console.error(`RPC backfill_source_type unavailable; using qualified PATCH fallback: ${error.message}`);
      method = "patch-fallback";
      try {
        while (true) {
          if (iterations >= MAX_ITERATIONS) throw new Error(`source_type PATCH fallback exceeded ${MAX_ITERATIONS} iterations`);
          const batch = await fetchQualifiedBatch();
          if (!batch.length) { remaining = 0; break; }
          iterations++;
          const groups = new Map();
          for (const row of batch) { const source = row.metadata.source.trim(); groups.set(source, [...(groups.get(source) ?? []), row.id]); }
          for (const [source, ids] of groups) {
            await request(`${base}/rest/v1/thoughts?${new URLSearchParams({ id: `in.(${ids.join(",")})`, source_type: "is.null", "metadata->>source": `eq.${source}` })}`, { method: "PATCH", headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ source_type: source }) });
            updated += ids.length;
          }
          remaining = (await fetchQualifiedBatch()).length;
          if (remaining === 0) break;
        }
      } catch (fallbackError) { failed++; console.error(`source_type PATCH fallback failed: ${fallbackError.message}`); }
      }
    }
  }
  console.log(JSON.stringify({ scanned: rows.length, updated, failed, iterations, method, remaining }));
  if (o.apply && failed > 0) process.exitCode = 1;
}
main().catch((e) => fail(e.message));
