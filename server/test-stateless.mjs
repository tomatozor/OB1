/**
 * Black-box MCP v2 transport and database-contract tests.
 *
 * This starts index.ts against an in-memory PostgREST-shaped HTTP server; no
 * Supabase project or OpenRouter credentials are involved.
 * Run from server/: node test-stateless.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const ACCESS_KEY = "test-mcp-key";
const ID = "11111111-1111-4111-8111-111111111111";
const BASE_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "x-brain-key": ACCESS_KEY,
};
const expectedTools = [
  "search", "fetch", "search_thoughts", "recall_context", "list_thoughts",
  "thought_stats", "related_thoughts", "capture_thought", "update_thought",
  "delete_thought",
].sort();

let passed = 0;
let failed = 0;
const requests = [];
function assert(condition, label) {
  if (condition) { console.log(`  ✓  ${label}`); passed++; }
  else { console.error(`  ✗  ${label}`); failed++; }
}
function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}
async function body(request) {
  const parts = [];
  for await (const part of request) parts.push(part);
  return Buffer.concat(parts).toString();
}

const postgrest = createServer(async (request, response) => {
  const rawBody = await body(request);
  const entry = { method: request.method, url: request.url, body: rawBody };
  requests.push(entry);
  const url = new URL(request.url, "http://postgrest.invalid");
  const rpc = url.pathname.match(/\/rest\/v1\/rpc\/([^/]+)$/)?.[1];
  if (rpc === "search_thoughts_text") {
    return json(response, 200, [{
      id: "text-visible", content: "visible matching thought", metadata: { topics: ["launch"] },
      created_at: "2026-07-14T00:00:00.000Z", type: "idea", source_type: "note",
      importance: 4, total_count: 2,
    }, {
      id: "text-deleted", content: "deleted matching thought", metadata: { deleted: true },
      created_at: "2026-07-13T00:00:00.000Z", type: "idea", source_type: "note",
      importance: 5, total_count: 2,
    }]);
  }
  if (rpc === "brain_stats_aggregate") return json(response, 200, { total: 7, types: { idea: 7 } });
  if (url.pathname === "/rest/v1/thoughts" && request.method === "GET") {
    if (url.searchParams.get("select")?.includes("updated_at")) {
      // .single() côté supabase-js attend un OBJET (Accept: pgrst.object+json), pas un tableau.
      return json(response, 200, {
        id: ID, content: "original", metadata: { topics: ["launch"] },
        created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-10T12:00:00.000Z",
      });
    }
    return json(response, 200, [
      { id: "recall-new", content: "new visible", metadata: {}, created_at: "2026-07-14T00:00:00.000Z", importance: 5, type: "idea" },
      { id: "recall-old", content: "old visible", metadata: {}, created_at: "2026-07-13T00:00:00.000Z", importance: 5, type: "idea" },
    ]);
  }
  if (url.pathname === "/rest/v1/thoughts" && request.method === "PATCH") {
    return json(response, 200, [{ id: ID, updated_at: "2026-07-14T00:00:00.000Z" }]);
  }
  if (url.pathname === "/rest/v1/thought_audit" && request.method === "POST") return json(response, 201, []);
  return json(response, 404, { message: `unhandled mock route ${request.method} ${url.pathname}` });
});

const postgrestPort = await listen(postgrest);
const serverPort = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  probe.on("error", reject);
});
const child = spawn("deno", ["run", "--allow-env", "--allow-net", "index.ts"], {
  cwd: new URL(".", import.meta.url),
  env: {
    ...process.env, SUPABASE_URL: `http://127.0.0.1:${postgrestPort}`,
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key", OPENROUTER_API_KEY: "test-openrouter-key",
    MCP_ACCESS_KEY: ACCESS_KEY, PORT: String(serverPort),
  }, stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
child.stdout.on("data", (data) => { serverOutput += data; });
child.stderr.on("data", (data) => { serverOutput += data; });
const base = `http://127.0.0.1:${serverPort}`;
async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { if ((await fetch(base, { method: "OPTIONS" })).status === 200) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`MCP server did not start:\n${serverOutput}`);
}
async function mcp(method, params = {}, headers = BASE_HEADERS, url = base) {
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const raw = await response.text();
  // Le transport MCP streamable répond en SSE (event: message / data: {...})
  // ou en JSON brut selon le cas — accepter les deux.
  let body = null;
  const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
  const payload = dataLine ? dataLine.slice(6) : raw;
  try { body = JSON.parse(payload); } catch { body = null; }
  return { response, body };
}
function toolResult(body) { return JSON.parse(body.result.content[0].text); }

try {
  await waitForServer();
  console.log("\n[1] Stateless transport and authentication");
  const cors = await fetch(base, { method: "OPTIONS" });
  assert(cors.status === 200 && cors.headers.get("access-control-allow-origin") === "*", "CORS preflight → 200 with origin header");
  assert((await mcp("initialize", {}, { "content-type": "application/json" })).response.status === 401, "no key → 401");
  assert((await mcp("initialize", {}, { "content-type": "application/json" }, `${base}?key=${ACCESS_KEY}`)).response.status === 401, "query key only → 401");
  const initialized = await mcp("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert(initialized.response.status === 200, "x-brain-key → 200");
  assert(!initialized.response.headers.has("mcp-session-id"), "initialize has no mcp-session-id");
  assert((await mcp("initialize", {}, { "content-type": "application/json", authorization: `Bearer ${ACCESS_KEY}` })).response.status === 200, "Authorization Bearer → 200");
  const tools = await mcp("tools/list");
  assert(tools.response.status === 200, "tools/list → 200");
  assert(JSON.stringify(tools.body.result.tools.map((tool) => tool.name).sort()) === JSON.stringify(expectedTools), "tools/list contains exactly the ten v2 tools");

  console.log("\n[2] Deterministic and filtered tool contracts");
  const recallParams = { days: 0, limit: 12, min_importance: 0 };
  const recallOne = await mcp("tools/call", { name: "recall_context", arguments: recallParams });
  const recallTwo = await mcp("tools/call", { name: "recall_context", arguments: recallParams });
  assert(JSON.stringify(recallOne.body) === JSON.stringify(recallTwo.body), "recall_context identical calls are byte-for-byte deterministic");
  const recalled = toolResult(recallOne.body).results;
  assert(recalled.map((row) => row.id).join(",") === "recall-new,recall-old", "recall_context stable importance/date/id ordering");
  assert(!recalled.some((row) => row.id === "text-deleted"), "recall_context excludes logically deleted rows (PostgREST predicate)");
  const text = await mcp("tools/call", { name: "search_thoughts", arguments: { query: "launch", mode: "text", type: "idea", source_type: "note", min_importance: 4 } });
  assert(text.body.result?.isError !== true, "text search completes without an embedding request");
  assert(toolResult(text.body).results.map((row) => row.id).join(",") === "text-visible", "text search filters deleted rows locally");
  const textCall = requests.find((entry) => entry.url.includes("search_thoughts_text"));
  assert(textCall && JSON.parse(textCall.body).p_query === "launch", "text search forwards query to PostgREST RPC");

  const requestCountBeforeUpdate = requests.length;
  const stale = await mcp("tools/call", { name: "update_thought", arguments: { id: ID, metadata_patch: { topic: "new" }, if_unchanged_since: "2026-07-01T00:00:00.000Z" } });
  assert(stale.body.result?.isError === true && stale.body.result.content[0].text.includes("STALE_READ"), "update_thought stale timestamp returns STALE_READ");
  assert(!requests.slice(requestCountBeforeUpdate).some((entry) => entry.method === "PATCH"), "STALE_READ emits no PATCH");
  const refused = await mcp("tools/call", { name: "delete_thought", arguments: { id: ID } });
  assert(refused.body.result?.isError === true && refused.body.result.content[0].text.includes("confirm=true"), "delete_thought without confirm is refused");
  const deleted = await mcp("tools/call", { name: "delete_thought", arguments: { id: ID, confirm: true } });
  assert(deleted.body.result?.isError !== true, "delete_thought with confirm succeeds logically");
  const deletePatch = requests.filter((entry) => entry.method === "PATCH").at(-1);
  assert(deletePatch && JSON.parse(deletePatch.body).metadata.deleted === true, "logical delete PATCH writes metadata.deleted=true");
  assert(!requests.some((entry) => entry.method === "DELETE"), "delete_thought never makes an HTTP DELETE");
  const stats = await mcp("tools/call", { name: "thought_stats", arguments: { since_days: 31 } });
  assert(toolResult(stats.body).aggregate.total === 7, "thought_stats returns aggregate RPC result");
  assert(requests.some((entry) => entry.url.includes("/rest/v1/rpc/brain_stats_aggregate")), "thought_stats calls brain_stats_aggregate RPC URL");
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve) => postgrest.close(resolve));
}

console.log(`\n${passed + failed} assertions: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("PASS");
