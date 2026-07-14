#!/usr/bin/env node

import fs from "node:fs";

function help() {
  console.log(`Usage: node examples/recall-coverage.mjs [options]

Measures daily recall coverage from Open Brain PostgREST data. A covered day has
at least one captured session recap and at least one persisted recall trace.

Environment: OPEN_BRAIN_URL and OPEN_BRAIN_SERVICE_KEY.
Optional environment: OPEN_BRAIN_WORKSPACE (used unless --workspace is given).

Options:
  --env-file PATH       Load KEY=VALUE pairs from PATH before reading environment
  --days NUMBER         Calendar days ending today in UTC (default: 7)
  --min-coverage NUMBER Minimum acceptable ratio from 0 to 1 (default: 0.8)
  --workspace ID        Limit agent-memory captures and recall traces to a workspace
  --json                Print JSON only (otherwise prints a table then JSON)
  --help                Show this help
`);
}

function loadEnvFile(path) {
  for (const raw of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

function parseArgs(argv) {
  const options = { days: 7, minCoverage: 0.8, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") return { help: true };
    if (arg === "--json") { options.json = true; continue; }
    if (!["--env-file", "--days", "--min-coverage", "--workspace"].includes(arg)) throw new Error(`Unknown option: ${arg}`);
    const value = argv[++i];
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === "--env-file") options.envFile = value;
    if (arg === "--workspace") options.workspace = value;
    if (arg === "--days") options.days = Number(value);
    if (arg === "--min-coverage") options.minCoverage = Number(value);
  }
  if (!Number.isInteger(options.days) || options.days < 1 || options.days > 3650) throw new Error("--days must be an integer from 1 to 3650");
  if (!Number.isFinite(options.minCoverage) || options.minCoverage < 0 || options.minCoverage > 1) throw new Error("--min-coverage must be a number from 0 to 1");
  return options;
}

function restBase(url) {
  const normalized = url.replace(/\/$/, "");
  return normalized.endsWith("/rest/v1") ? normalized : `${normalized}/rest/v1`;
}

function startDate(days) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return start;
}

function day(timestamp) {
  return timestamp.slice(0, 10);
}

async function getRows(base, key, table, params) {
  const response = await fetch(`${base}/${table}?${params.toString()}`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`PostgREST ${table} request failed (HTTP ${response.status})`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error(`PostgREST ${table} returned an unexpected response`);
  return data;
}

function paramsFor(select, since, extra = {}) {
  const params = new URLSearchParams({ select, created_at: `gte.${since.toISOString()}`, order: "created_at.asc" });
  for (const [key, value] of Object.entries(extra)) if (value) params.set(key, value);
  return params;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return help();
  if (options.envFile) loadEnvFile(options.envFile);
  const url = process.env.OPEN_BRAIN_URL;
  const key = process.env.OPEN_BRAIN_SERVICE_KEY;
  if (!url || !key) throw new Error("Set OPEN_BRAIN_URL and OPEN_BRAIN_SERVICE_KEY");

  const workspace = options.workspace || process.env.OPEN_BRAIN_WORKSPACE;
  const since = startDate(options.days);
  const base = restBase(url);
  const workspaceFilter = workspace ? { workspace_id: `eq.${workspace}` } : {};
  const [legacyRecaps, workLogs, traces] = await Promise.all([
    getRows(base, key, "thoughts", paramsFor("created_at", since, { type: "eq.session_recap" })),
    getRows(base, key, "agent_memories", paramsFor("created_at", since, { memory_type: "eq.work_log", ...workspaceFilter })),
    getRows(base, key, "agent_memory_recall_traces", paramsFor("created_at,request_id,workspace_id", since, workspaceFilter)),
  ]);

  const capturesByDay = new Map();
  for (const row of [...legacyRecaps, ...workLogs]) {
    const date = day(row.created_at);
    capturesByDay.set(date, (capturesByDay.get(date) ?? 0) + 1);
  }
  const recallsByDay = new Map();
  for (const row of traces) {
    const date = day(row.created_at);
    recallsByDay.set(date, (recallsByDay.get(date) ?? 0) + 1);
  }
  const captureDays = [...capturesByDay.keys()].sort();
  const daysWithoutRecall = captureDays.filter((date) => !recallsByDay.has(date));
  const coveredDays = captureDays.length - daysWithoutRecall.length;
  const coverage = captureDays.length ? coveredDays / captureDays.length : 0;
  const report = {
    window: { days: options.days, since_utc: since.toISOString(), workspace: workspace ?? null },
    metric: "covered_capture_days / capture_days; a covered capture day has one or more session recap captures and one or more persisted agent_memory_recall_traces rows on the same UTC date",
    captures: { total: legacyRecaps.length + workLogs.length, thoughts_session_recap: legacyRecaps.length, agent_memory_work_log: workLogs.length, days: captureDays.length },
    recalls: { persisted_agent_memory_recall_traces: traces.length, note: "recall_context emits application observability but does not currently persist rows in agent_memory_recall_traces" },
    coverage: { ratio: coverage, percent: Number((coverage * 100).toFixed(1)), covered_days: coveredDays, capture_days: captureDays.length, min_coverage: options.minCoverage, passes: coverage >= options.minCoverage },
    days_without_recall: daysWithoutRecall,
  };

  if (!options.json) {
    console.log("Recall coverage (UTC)");
    console.table([
      { metric: "Session recap captures", value: report.captures.total },
      { metric: "- thoughts type=session_recap", value: report.captures.thoughts_session_recap },
      { metric: "- agent_memories memory_type=work_log", value: report.captures.agent_memory_work_log },
      { metric: "Persisted recall traces", value: report.recalls.persisted_agent_memory_recall_traces },
      { metric: "Capture days", value: report.coverage.capture_days },
      { metric: "Covered capture days", value: report.coverage.covered_days },
      { metric: "Coverage", value: `${report.coverage.percent}%` },
    ]);
  }
  console.log(JSON.stringify(report));
  if (!report.coverage.passes) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
});
