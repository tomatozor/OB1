#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const requests = [];
const server = createServer((request, response) => {
  requests.push(request.url);
  response.setHeader("content-type", "application/json");
  if (request.url.startsWith("/rest/v1/thoughts?")) response.end(JSON.stringify([{ id: "00000000-0000-0000-0000-000000000001", content: "Visible", created_at: "2026-08-10T00:00:00Z", metadata: {}, source_type: "manual", sensitivity_tier: "standard" }]));
  else if (request.url.startsWith("/rest/v1/entities?")) response.end(JSON.stringify([{ id: 1, canonical_name: "PostgreSQL", normalized_name: "postgresql", entity_type: "tool", aliases: [], metadata: {} }]));
  else if (request.url.startsWith("/rest/v1/thought_entities?")) response.end(JSON.stringify([{ thought_id: "00000000-0000-0000-0000-000000000001", mention_role: "mentioned", confidence: 1, source: "test", created_at: "2026-08-10T00:00:00Z", thoughts: { id: "00000000-0000-0000-0000-000000000001", content: "Visible", metadata: {}, created_at: "2026-08-10T00:00:00Z", sensitivity_tier: "standard" } }]));
  else if (request.url.startsWith("/rest/v1/edges?")) response.end("[]");
  else if (request.url.startsWith("/chat/completions")) response.end(JSON.stringify({ choices: [{ message: { content: "# PostgreSQL\n\nVisible." } }] }));
  else { response.statusCode = 404; response.end("{}"); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const repoRoot = process.cwd();
const testRoot = mkdtempSync(join(tmpdir(), "ob-wiki-filter-test-"));
const env = { ...process.env, OPEN_BRAIN_URL: base, OPEN_BRAIN_SERVICE_KEY: "test", LLM_BASE_URL: base, LLM_API_KEY: "test", WIKI_OUTPUT_DIR: join(testRoot, "wiki") };
async function run(command) {
  const child = spawn(process.execPath, command, { cwd: testRoot, env });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const status = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(status, 0, stderr);
}
await run([join(repoRoot, "recipes/wiki-synthesis/scripts/synthesize-wiki.mjs"), "--topic", "autobiography", "--dry-run", "--page-limit", "1"]);
await run([join(repoRoot, "recipes/entity-wiki/generate-wiki.mjs"), "--id", "1", "--dry-run"]);
const synthesisQuery = requests.find((url) => url.startsWith("/rest/v1/thoughts?"));
assert.match(decodeURIComponent(synthesisQuery), /or=\(sensitivity_tier\.is\.null,sensitivity_tier\.neq\.restricted\)/);
const entityQuery = requests.find((url) => url.startsWith("/rest/v1/thought_entities?"));
assert.match(decodeURIComponent(entityQuery), /thoughts!inner/);
assert.match(decodeURIComponent(entityQuery), /thoughts\.or=\(sensitivity_tier\.is\.null,sensitivity_tier\.neq\.restricted\)/);
server.close();
console.log("restricted wiki filter tests passed");
