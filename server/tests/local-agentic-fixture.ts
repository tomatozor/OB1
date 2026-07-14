const fixtureKey = Deno.env.get("W11_FIXTURE_KEY") ??
  "w11-local-agentic-proof-key";
const fixtureClientId = Deno.env.get("W11_FIXTURE_CLIENT_ID") ??
  "w11-codex-client";
const port = Number(Deno.env.get("PORT") ?? "8765");

function fixtureLog(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event));
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

Deno.env.set("SUPABASE_URL", "http://postgrest.invalid");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "w11-fake-service-role");
Deno.env.set("OPENROUTER_API_KEY", "w11-fake-openrouter-key");
Deno.env.set("OPENROUTER_BASE_URL", "http://openrouter.invalid");
Deno.env.delete("MCP_ACCESS_KEY");
Deno.env.set(
  "MCP_CLIENT_KEYS",
  JSON.stringify([{
    client_id: fixtureClientId,
    key_sha256: await sha256Hex(fixtureKey),
  }]),
);
Deno.env.delete("MCP_ALLOWED_ORIGINS");

let backendRequestCount = 0;
let backendMutationCount = 0;

globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);

  if (url.hostname === "postgrest.invalid") {
    backendRequestCount++;
    const readOnlyRpc = url.pathname ===
      "/rest/v1/rpc/search_thoughts_text";
    const mutation = request.method !== "GET" && !readOnlyRpc;
    if (mutation) backendMutationCount++;
    fixtureLog({
      event: "w11.fixture_backend_request",
      method: request.method,
      path: url.pathname,
      mutation,
    });

    if (readOnlyRpc && request.method === "POST") {
      return json(200, [{
        id: "11111111-1111-4111-8111-111111111111",
        content: "Local fixture recall result.",
        metadata: { topics: ["local-proof"] },
        created_at: "2026-07-14T00:00:00.000Z",
        type: "reference",
        source_type: "fixture",
        importance: 3,
        total_count: 1,
      }]);
    }

    return json(503, {
      code: "W11_FIXTURE_REFUSED",
      message: "Fixture refuses non-read backend operations",
    });
  }

  if (url.hostname === "openrouter.invalid") {
    fixtureLog({
      event: "w11.fixture_aux_request",
      method: request.method,
      path: url.pathname,
    });
    if (url.pathname === "/embeddings") {
      return json(200, {
        data: [{ embedding: Array.from({ length: 1536 }, () => 0) }],
      });
    }
    if (url.pathname === "/chat/completions") {
      return json(200, {
        choices: [{
          message: {
            content: JSON.stringify({
              people: [],
              action_items: [],
              dates_mentioned: [],
              topics: ["local-proof"],
              type: "reference",
            }),
          },
        }],
      });
    }
  }

  fixtureLog({
    event: "w11.fixture_unexpected_outbound",
    method: request.method,
    host: url.hostname,
    path: url.pathname,
  });
  return json(502, { error: "Unexpected fixture outbound request" });
}) as typeof fetch;

const { app } = await import("../index.ts");

Deno.serve({
  hostname: "127.0.0.1",
  port,
  onListen: ({ hostname, port }) => {
    fixtureLog({
      event: "w11.fixture_ready",
      hostname,
      port,
      client_id: fixtureClientId,
    });
  },
  onError: (error) => {
    fixtureLog({
      event: "w11.fixture_http_error",
      error_type: error instanceof Error ? error.name : "unknown",
    });
    return json(500, { error: "Fixture HTTP failure" });
  },
}, (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/__fixture/ready") {
    return json(200, { ready: true });
  }
  if (url.pathname === "/__fixture/state") {
    return json(200, {
      backend_request_count: backendRequestCount,
      backend_mutation_count: backendMutationCount,
    });
  }
  return app.fetch(request);
});
