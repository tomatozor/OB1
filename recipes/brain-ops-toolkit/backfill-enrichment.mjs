#!/usr/bin/env node
/** Backfill missing thought types and metadata enrichment. Dry-run by default. */
import fs from "node:fs";

const TYPES = new Set(["event", "email", "meeting", "voice_memo", "decision", "session_recap", "note", "observation", "task", "reference", "idea", "person_note"]);
const HELP = `Usage: node recipes/brain-ops-toolkit/backfill-enrichment.mjs [options]

Backfills rows where type is NULL and/or enriched is false. Dry-run is the
default: it makes no LLM calls and prints only counts and identifiers.

Options:
  --apply                 Call the LLM and persist eligible changes
  --only <types|enrichment|all>  Target axis (default: all)
  --batch <number>        Read page size (default: 25)
  --limit <number>        Maximum rows to scan
  --env-file <path>       Load simple KEY=VALUE environment entries
  --help                  Show this help

Environment: OPEN_BRAIN_URL, OPEN_BRAIN_SERVICE_KEY; --apply also requires
OPENROUTER_API_KEY or LLM_API_KEY. PostgREST requests time out after 10s and
LLM requests after 15s. Failed applied rows make the process exit non-zero.`;

function fail(message) { console.error(`Error: ${message}`); process.exitCode = 1; }
function loadEnvFile(path) { for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/); if (m && !m[1].startsWith("#")) process.env[m[1]] ??= m[2].replace(/^['"]|['"]$/g, ""); } }
function parse() { const o = { apply: false, only: "all", batch: 25, limit: Infinity }; for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a === "--help") { console.log(HELP); process.exit(0); } if (a === "--apply") o.apply = true; else if (a === "--only") o.only = process.argv[++i]; else if (a === "--batch") o.batch = Number(process.argv[++i]); else if (a === "--limit") o.limit = Number(process.argv[++i]); else if (a === "--env-file") o.envFile = process.argv[++i]; else throw new Error(`Unknown or incomplete option: ${a}`); } if (!["types", "enrichment", "all"].includes(o.only)) throw new Error("--only must be types, enrichment, or all"); if (!Number.isInteger(o.batch) || o.batch < 1 || o.batch > 1000) throw new Error("--batch must be an integer from 1 to 1000"); if (o.limit !== Infinity && (!Number.isInteger(o.limit) || o.limit < 1)) throw new Error("--limit must be a positive integer"); return o; }
async function request(url, options = {}, timeoutMs = 10_000) { try { const r = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) }); if (!r.ok) { const error = new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`); error.status = r.status; throw error; } return r; } catch (e) { throw new Error(`Network/API request failed${e.name === "TimeoutError" ? ` after ${timeoutMs}ms` : ""}: ${e.message}`); } }
function filterFor(only) { return only === "types" ? "type.is.null" : only === "enrichment" ? "enriched.eq.false" : "type.is.null,enriched.eq.false"; }
function strings(value, max = Infinity) { return Array.isArray(value) ? value.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()).slice(0, max) : []; }
function extracted(value) { return { type: TYPES.has(value?.type) ? value.type : null, topics: strings(value?.topics, 3), people: strings(value?.people), action_items: strings(value?.action_items) }; }
async function llm(content, key) {
  const endpoint = `${(process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "")}/chat/completions`;
  const body = { model: process.env.OPENROUTER_ENRICHMENT_MODEL || "deepseek/deepseek-v4-pro", response_format: { type: "json_object" }, messages: [{ role: "system", content: `Extract metadata from one Open Brain thought using the standard extraction shape. Return strict JSON only with type, topics, people, action_items, and dates_mentioned. type must be one of ${[...TYPES].join(", ")}; topics must contain 1 to 3 concise topics when explicit; people and action_items must contain only explicit facts; dates_mentioned uses YYYY-MM-DD or []. Never invent.` }, { role: "user", content }] };
  let last;
  for (let attempt = 0; attempt < 3; attempt++) { try { const r = await request(endpoint, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }, 15_000); const raw = (await r.json())?.choices?.[0]?.message?.content; const value = typeof raw === "string" ? JSON.parse(raw) : raw; return extracted(value); } catch (e) { last = e; if (!(e.message.includes("HTTP 429") || /HTTP 5\d\d/.test(e.message)) || attempt === 2) throw e; await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt))); } } throw last;
}
async function main() {
  const o = parse(); if (o.envFile) loadEnvFile(o.envFile); const base = process.env.OPEN_BRAIN_URL?.replace(/\/$/, ""); const serviceKey = process.env.OPEN_BRAIN_SERVICE_KEY; if (!base || !serviceKey) throw new Error("OPEN_BRAIN_URL and OPEN_BRAIN_SERVICE_KEY must be configured"); const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const rows = []; let after = null;
  while (rows.length < o.limit) { const q = new URLSearchParams({ select: "id,type,enriched,metadata,content", or: `(${filterFor(o.only)})`, order: "id.asc", limit: String(Math.min(o.batch, o.limit - rows.length)) }); if (after) q.set("id", `gt.${after}`); const page = await (await request(`${base}/rest/v1/thoughts?${q}`, { headers })).json(); rows.push(...page); if (page.length < Number(q.get("limit"))) break; after = page.at(-1).id; }
  const category = (row) => ({ needs_type: row.type == null, needs_enrichment: row.enriched === false }); const byCategory = rows.reduce((a, row) => { const c = category(row); if (c.needs_type) a.missing_type++; if (c.needs_enrichment) a.missing_enrichment++; return a; }, { missing_type: 0, missing_enrichment: 0 });
  if (!o.apply) { console.log(JSON.stringify({ mode: "dry-run", scanned: rows.length, ...byCategory, sample_ids: rows.slice(0, 10).map((r) => r.id), cost_estimate_usd: Number((rows.length * 0.0002).toFixed(4)) }, null, 2)); console.log(JSON.stringify({ scanned: rows.length, typed: 0, enriched: 0, skipped: 0, failed: 0, cost_estimate_usd: Number((rows.length * 0.0002).toFixed(4)) })); return; }
  const llmKey = process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY; if (!llmKey) throw new Error("OPENROUTER_API_KEY or LLM_API_KEY must be configured for --apply"); let typed = 0; let enriched = 0; let skipped = 0; let failed = 0;
  for (const row of rows) { try {
    const q = new URLSearchParams({ select: "id,type,enriched,metadata,content", id: `eq.${row.id}`, or: `(${filterFor(o.only)})`, limit: "1" }); const current = (await (await request(`${base}/rest/v1/thoughts?${q}`, { headers })).json())[0]; if (!current) { skipped++; continue; }
    const data = await llm(String(current.content ?? ""), llmKey); const metadata = current.metadata && typeof current.metadata === "object" && !Array.isArray(current.metadata) ? { ...current.metadata } : {}; for (const key of ["topics", "people", "action_items"]) if (!(key in metadata)) metadata[key] = data[key]; const patch = { metadata, enriched: true }; if (current.type == null && data.type) patch.type = data.type;
    await request(`${base}/rest/v1/thoughts?${new URLSearchParams({ id: `eq.${current.id}`, or: `(${filterFor(o.only)})` })}`, { method: "PATCH", headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(patch) }); if (patch.type) typed++; if (current.enriched === false) enriched++;
  } catch (e) { failed++; console.error(`Failed id ${row.id}: ${e.message}`); } }
  console.log(JSON.stringify({ scanned: rows.length, typed, enriched, skipped, failed, cost_estimate_usd: Number((rows.length * 0.0002).toFixed(4)) })); if (failed > 0) process.exitCode = 1;
}
main().catch((e) => fail(e.message));
