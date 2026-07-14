Deno.env.set("MCP_ACCESS_KEY", "local-smoke-access-key");
Deno.env.set("OPENROUTER_API_KEY", "local-smoke-openrouter-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "local-smoke-service-role-key");
Deno.env.set("SUPABASE_URL", "http://127.0.0.1:54321");

const { handler } = await import("../index.ts");
const accessKey = Deno.env.get("MCP_ACCESS_KEY");
const endpoint = "http://agent-memory-api.local";

async function expectStatus(name, expected, request) {
  const response = await handler(request);
  const responseText = await response.text();
  if (response.status !== expected) {
    throw new Error(
      `${name}: expected ${expected}, got ${response.status}: ${responseText}`,
    );
  }
  console.log(`PASS ${name}: ${response.status}`);
}

await expectStatus(
  "missing header auth",
  401,
  new Request(`${endpoint}/health`),
);
await expectStatus(
  "query-only auth rejected",
  401,
  new Request(`${endpoint}/health?key=${accessKey}`),
);
await expectStatus(
  "x-brain-key health",
  200,
  new Request(`${endpoint}/health`, { headers: { "x-brain-key": accessKey } }),
);
await expectStatus(
  "bearer health",
  200,
  new Request(`${endpoint}/health`, {
    headers: { Authorization: `Bearer ${accessKey}` },
  }),
);

const writebackWithoutIdempotency = {
  schema_version: "openbrain.agent_memory.writeback.v1",
  workspace_id: "local-smoke",
  memory_payload: { lessons: ["Synthetic local smoke memory."] },
};
await expectStatus(
  "writeback requires idempotency_key",
  400,
  new Request(`${endpoint}/writeback`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-brain-key": accessKey },
    body: JSON.stringify(writebackWithoutIdempotency),
  }),
);

const oversizedWriteback = {
  ...writebackWithoutIdempotency,
  idempotency_key: "oversized-local-smoke",
  memory_payload: { lessons: ["x".repeat(70_000)] },
};
await expectStatus(
  "oversized payload rejected",
  413,
  new Request(`${endpoint}/writeback`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-brain-key": accessKey },
    body: JSON.stringify(oversizedWriteback),
  }),
);

await expectStatus(
  "malformed JSON rejected",
  400,
  new Request(`${endpoint}/writeback`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-brain-key": accessKey },
    body: "{",
  }),
);

console.log("PASS local protocol smoke: 7 checks");
