#!/usr/bin/env node

import fs from "node:fs";

const DEFAULTS = { days: 30, limit: 12, min_importance: 0 };

function help() {
  console.log(`Usage: node examples/verify-recall-parity.mjs [options]

Calls recall_context twice with identical explicit parameters and compares the
MCP results. Environment: OPEN_BRAIN_MCP_URL (or MCP_URL),
OPEN_BRAIN_ACCESS_KEY (or MCP_ACCESS_KEY).

Options:
  --env-file PATH  Load KEY=VALUE pairs from PATH before reading the environment
  --url URL        Override the MCP HTTP endpoint
  --key KEY        Deprecated: override the MCP access key (prefer environment variable)
  --help           Show this help
`);
}

function loadEnvFile(path) {
  for (const raw of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") return { help: true };
    if (arg === "--env-file" || arg === "--url" || arg === "--key") {
      if (!argv[i + 1]) throw new Error(`${arg} requires a value`);
      options[arg.slice(2).replace("-", "_")] = argv[++i];
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

async function mcpCall(url, key, id) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": key }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "recall_context", arguments: DEFAULTS } }), signal: AbortSignal.timeout(10_000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body}`);
  const dataLine = body.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).pop();
  try { return JSON.parse(dataLine || body); } catch { throw new Error(`MCP returned non-JSON: ${body}`); }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return help();
  if (options.key) console.warn("WARNING: --key is deprecated because command-line arguments can expose credentials; prefer OPEN_BRAIN_ACCESS_KEY or MCP_ACCESS_KEY.");
  if (options.env_file) loadEnvFile(options.env_file);
  const url = options.url || process.env.OPEN_BRAIN_MCP_URL || process.env.MCP_URL;
  const key = options.key || process.env.OPEN_BRAIN_ACCESS_KEY || process.env.MCP_ACCESS_KEY;
  if (!url || !key) throw new Error("Set OPEN_BRAIN_MCP_URL and OPEN_BRAIN_ACCESS_KEY (or MCP_URL and MCP_ACCESS_KEY; --key is deprecated)");
  const first = await mcpCall(url, key, "parity-1");
  const second = await mcpCall(url, key, "parity-2");
  if (JSON.stringify(stable(first?.result)) !== JSON.stringify(stable(second?.result))) throw new Error("recall_context results differ");
  console.log("PASS: recall_context returned identical results for both calls");
}

main().catch(error => { console.error(`FAIL: ${error.message}`); process.exitCode = 1; });
