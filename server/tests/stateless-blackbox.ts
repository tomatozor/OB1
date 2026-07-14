/**
 * Socket-free black-box MCP v2 transport and database-contract tests.
 *
 * The production Hono app is invoked through app.request while global fetch is
 * replaced with an in-memory PostgREST/OpenRouter mock. This exercises the same
 * MCP transport and tool handlers without requiring permission to bind a port.
 */
const ACCESS_KEY = "test-mcp-key";
const ID = "11111111-1111-4111-8111-111111111111";
const ATOMIC_CAPTURE_ID = "22222222-2222-4222-8222-222222222222";
const LEGACY_CAPTURE_ID = "33333333-3333-4333-8333-333333333333";
const ATOMIC_DELETE_ID = "44444444-4444-4444-8444-444444444444";
const FALLBACK_DELETE_ID = "55555555-5555-4555-8555-555555555555";

Deno.env.set("SUPABASE_URL", "http://postgrest.invalid");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("OPENROUTER_API_KEY", "test-openrouter-key");
Deno.env.set("OPENROUTER_BASE_URL", "http://openrouter.invalid");
Deno.env.set("MCP_ACCESS_KEY", ACCESS_KEY);

type MockRequest = { method: string; url: string; body: string };
const requests: MockRequest[] = [];

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const request = input instanceof Request ? input : new Request(input, init);
  const rawBody = request.body ? await request.text() : "";
  const entry = { method: request.method, url: request.url, body: rawBody };
  requests.push(entry);
  const url = new URL(request.url);

  if (url.hostname === "openrouter.invalid" && url.pathname === "/embeddings") {
    return json(200, { data: [{ embedding: [0.1, 0.2, 0.3] }] });
  }
  if (
    url.hostname === "openrouter.invalid" &&
    url.pathname === "/chat/completions"
  ) {
    return json(200, {
      choices: [{
        message: {
          content: JSON.stringify({
            people: [],
            action_items: [],
            dates_mentioned: [],
            topics: ["launch"],
            type: "idea",
          }),
        },
      }],
    });
  }

  const rpc = url.pathname.match(/\/rest\/v1\/rpc\/([^/]+)$/)?.[1];
  if (rpc === "search_thoughts_text") {
    return json(200, [{
      id: "text-visible",
      content: "visible matching thought",
      metadata: { topics: ["launch"] },
      created_at: "2026-07-14T00:00:00.000Z",
      type: "idea",
      source_type: "note",
      importance: 4,
      total_count: 4,
    }, {
      id: "text-deleted",
      content: "deleted matching thought",
      metadata: { deleted: true },
      created_at: "2026-07-13T00:00:00.000Z",
      type: "idea",
      source_type: "note",
      importance: 5,
      total_count: 4,
    }, {
      id: "text-deleted-string",
      content: "string-deleted matching thought",
      metadata: { deleted: "true" },
      created_at: "2026-07-12T00:00:00.000Z",
      type: "idea",
      source_type: "note",
      importance: 5,
      total_count: 4,
    }, {
      id: "text-metadata-source",
      content: "metadata source thought",
      metadata: { source: "mcp" },
      created_at: "2026-07-11T00:00:00.000Z",
      type: "idea",
      source_type: null,
      importance: 4,
      total_count: 4,
    }]);
  }
  if (rpc === "hybrid_search_thoughts") {
    return json(404, {
      code: "PGRST202",
      message:
        "Could not find the function public.hybrid_search_thoughts in the schema cache",
    });
  }
  if (rpc === "match_thoughts") {
    return json(200, [{ id: "semantic-visible", similarity: 0.91 }]);
  }
  if (rpc === "capture_thought_atomic") {
    const payload = JSON.parse(rawBody);
    if (payload.p_content === "atomic capture") {
      return json(200, {
        id: ATOMIC_CAPTURE_ID,
        deduped: false,
        has_embedding: true,
      });
    }
    return json(404, {
      code: "PGRST202",
      message:
        "Could not find the function public.capture_thought_atomic in the schema cache",
    });
  }
  if (rpc === "upsert_thought") {
    return json(200, { id: LEGACY_CAPTURE_ID, deduped: false });
  }
  if (rpc === "soft_delete_thought") {
    const payload = JSON.parse(rawBody);
    if (payload.p_id === ATOMIC_DELETE_ID) {
      return json(200, {
        id: ATOMIC_DELETE_ID,
        deleted: true,
        deleted_by: "mcp",
      });
    }
    return json(404, {
      code: "PGRST202",
      message:
        "Could not find the function public.soft_delete_thought in the schema cache",
    });
  }
  if (rpc === "brain_stats_aggregate") {
    return json(200, { total: 7, types: { idea: 7 } });
  }

  if (url.pathname === "/rest/v1/thought_edges" && request.method === "GET") {
    if (url.searchParams.get("to_thought_id")?.includes("noedge")) {
      return json(404, {
        code: "PGRST205",
        message:
          "Could not find the table public.thought_edges in the schema cache",
      });
    }
    return json(200, [{ to_thought_id: "recall-superseded" }]);
  }

  if (url.pathname === "/rest/v1/thoughts" && request.method === "GET") {
    const idFilter = url.searchParams.get("id");
    if (idFilter?.startsWith("in.")) {
      const ids = [
        "semantic-visible",
        "text-visible",
        "text-deleted",
        "text-deleted-string",
        "text-metadata-source",
      ].filter((id) => idFilter.includes(id));
      return json(
        200,
        ids.map((id) => ({
          id,
          content: `hydrated ${id}`,
          metadata: id === "text-deleted"
            ? { deleted: true }
            : id === "text-deleted-string"
            ? { deleted: "true" }
            : id === "text-metadata-source"
            ? { source: "mcp" }
            : {},
          created_at: "2026-07-14T00:00:00.000Z",
          type: "idea",
          source_type: id === "text-visible" ? "note" : null,
          importance: 4,
        })),
      );
    }
    if (idFilter?.startsWith("eq.")) {
      return json(200, {
        id: idFilter.slice(3),
        content: "original",
        metadata: { topics: ["launch"] },
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-10T12:00:00.000Z",
      });
    }
    if (url.searchParams.get("select")?.includes("updated_at")) {
      return json(200, [
        {
          id: "list-new",
          content: "list new",
          metadata: {},
          created_at: "2026-07-14T00:00:00.000Z",
          type: "idea",
          source_type: "note",
          importance: 5,
        },
        {
          id: "list-source",
          content: "list source",
          metadata: { source: "mcp" },
          created_at: "2026-07-13T00:00:00.000Z",
          type: "idea",
          source_type: null,
          importance: 4,
        },
        {
          id: "list-more",
          content: "list more",
          metadata: {},
          created_at: "2026-07-12T00:00:00.000Z",
          type: "idea",
          source_type: "note",
          importance: 3,
        },
      ]);
    }
    if (url.searchParams.get("metadata")?.includes("no-edges")) {
      return json(200, [
        {
          id: "noedge-one",
          content: "no edge one",
          metadata: {},
          created_at: "2026-07-14T00:00:00.000Z",
          importance: 5,
          type: "idea",
        },
        {
          id: "noedge-two",
          content: "no edge two",
          metadata: {},
          created_at: "2026-07-13T00:00:00.000Z",
          importance: 4,
          type: "idea",
        },
      ]);
    }
    return json(200, [
      {
        id: "recall-superseded",
        content: "superseded",
        metadata: {},
        created_at: "2026-07-15T00:00:00.000Z",
        importance: 6,
        type: "idea",
      },
      {
        id: "recall-new",
        content: "new visible",
        metadata: {},
        created_at: "2026-07-14T00:00:00.000Z",
        importance: 5,
        type: "idea",
      },
      {
        id: "recall-old",
        content: "old visible",
        metadata: {},
        created_at: "2026-07-13T00:00:00.000Z",
        importance: 5,
        type: "idea",
      },
    ]);
  }

  if (url.pathname === "/rest/v1/thoughts" && request.method === "PATCH") {
    const requestedId = url.searchParams.get("id")?.replace(/^eq\./, "") ?? ID;
    return json(200, {
      id: requestedId,
      updated_at: "2026-07-14T00:00:00.000Z",
    });
  }
  if (
    url.pathname === "/rest/v1/thought_audit" && request.method === "POST"
  ) {
    return json(201, []);
  }
  return json(404, {
    message: `unhandled mock route ${request.method} ${url.pathname}`,
  });
}) as typeof fetch;

const { app } = await import("../index.ts");

const BASE_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "x-brain-key": ACCESS_KEY,
};
const expectedTools = [
  "search",
  "fetch",
  "search_thoughts",
  "recall_context",
  "list_thoughts",
  "thought_stats",
  "related_thoughts",
  "capture_thought",
  "update_thought",
  "delete_thought",
].sort();

let passed = 0;
let failed = 0;
function assert(condition: unknown, label: string): void {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}`);
    failed++;
  }
}

async function mcp(
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = BASE_HEADERS,
  url = "http://mcp.invalid",
) {
  const response = await app.request(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const raw = await response.text();
  const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
  const payload = dataLine ? dataLine.slice(6) : raw;
  let body: Record<string, any> | null = null;
  try {
    body = JSON.parse(payload);
  } catch {
    body = null;
  }
  return { response, body };
}

function toolResult(body: Record<string, any>): Record<string, any> {
  return JSON.parse(body.result.content[0].text);
}

console.log("\n[1] Stateless transport and authentication");
const cors = await app.request("http://mcp.invalid", { method: "OPTIONS" });
assert(
  cors.status === 200 &&
    cors.headers.get("access-control-allow-origin") === "*",
  "CORS preflight -> 200 with origin header",
);
assert(
  (await mcp("initialize", {}, { "content-type": "application/json" }))
    .response.status === 401,
  "no key -> 401",
);
assert(
  (await mcp(
    "initialize",
    {},
    { "content-type": "application/json" },
    `http://mcp.invalid?key=${ACCESS_KEY}`,
  )).response.status === 401,
  "query key only -> 401",
);
const initialized = await mcp("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "test", version: "1" },
});
assert(initialized.response.status === 200, "x-brain-key -> 200");
assert(
  !initialized.response.headers.has("mcp-session-id"),
  "initialize has no mcp-session-id",
);
assert(
  (await mcp("initialize", {}, {
    "content-type": "application/json",
    authorization: `Bearer ${ACCESS_KEY}`,
  })).response.status === 200,
  "Authorization Bearer -> 200",
);
const tools = await mcp("tools/list");
assert(tools.response.status === 200, "tools/list -> 200");
assert(
  JSON.stringify(
    tools.body?.result.tools.map((tool: { name: string }) => tool.name).sort(),
  ) === JSON.stringify(expectedTools),
  "tools/list contains exactly the ten v2 tools",
);

console.log("\n[2] Deterministic and filtered tool contracts");
const recallParams = { days: 0, limit: 2, min_importance: 0 };
const recallOne = await mcp("tools/call", {
  name: "recall_context",
  arguments: recallParams,
});
const recallTwo = await mcp("tools/call", {
  name: "recall_context",
  arguments: recallParams,
});
assert(
  JSON.stringify(recallOne.body) === JSON.stringify(recallTwo.body),
  "recall_context identical calls are byte-for-byte deterministic",
);
const recalled = toolResult(recallOne.body!).results;
assert(
  recalled.map((row: { id: string }) => row.id).join(",") ===
    "recall-new,recall-old",
  "recall_context stable importance/date/id ordering",
);
assert(
  !recalled.some((row: { id: string }) => row.id === "recall-superseded") &&
    recalled.length === 2,
  "recall_context removes a current superseded candidate and fills the page",
);
const edgeCall = requests.find((entry) =>
  entry.url.includes("/rest/v1/thought_edges")
);
assert(
  edgeCall?.url.includes("relation=eq.supersedes") &&
    edgeCall.url.includes("valid_until=is.null"),
  "recall_context queries only current supersedes edges",
);
const noEdges = await mcp("tools/call", {
  name: "recall_context",
  arguments: { ...recallParams, scope_topics: ["no-edges"] },
});
assert(
  toolResult(noEdges.body!).results.map((row: { id: string }) => row.id).join(
    ",",
  ) === "noedge-one,noedge-two",
  "recall_context preserves current behavior when thought_edges is absent",
);

const text = await mcp("tools/call", {
  name: "search_thoughts",
  arguments: {
    query: "launch",
    mode: "text",
    type: "idea",
    source_type: "note",
    min_importance: 4,
  },
});
assert(
  text.body?.result?.isError !== true,
  "text search completes without an embedding request",
);
assert(
  toolResult(text.body!).results.map((row: { id: string }) => row.id).join(
    ",",
  ) === "text-visible",
  "text search filters deleted rows locally",
);
assert(
  !toolResult(text.body!).results.some((row: { id: string }) =>
    row.id === "text-deleted-string"
  ),
  'text search treats metadata.deleted="true" as deleted',
);
const textCall = requests.find((entry) =>
  entry.url.includes("search_thoughts_text")
);
assert(
  textCall && JSON.parse(textCall.body).p_query === "launch",
  "text search forwards query to PostgREST RPC",
);
const metadataSource = await mcp("tools/call", {
  name: "search_thoughts",
  arguments: { query: "launch", mode: "text", source_type: "mcp" },
});
assert(
  toolResult(metadataSource.body!).results.map((row: { id: string }) => row.id)
    .join(",") === "text-metadata-source",
  "source_type falls back to metadata.source",
);
const pagedSearch = await mcp("tools/call", {
  name: "search_thoughts",
  arguments: { query: "launch", mode: "text", limit: 1 },
});
assert(
  toolResult(pagedSearch.body!).pagination.has_more === true &&
    toolResult(pagedSearch.body!).results.length === 1,
  "search_thoughts over-reads one row and reports has_more=true",
);
const invalidDate = await mcp("tools/call", {
  name: "search_thoughts",
  arguments: { query: "launch", mode: "text", start_date: "not-a-date" },
});
assert(
  invalidDate.body?.result?.isError === true &&
    invalidDate.body.result.content[0].text.includes("Invalid start_date"),
  "search_thoughts rejects invalid dates with a clear error",
);
const hybrid = await mcp("tools/call", {
  name: "search_thoughts",
  arguments: { query: "hybrid", mode: "hybrid", limit: 1, threshold: 0.77 },
});
assert(
  hybrid.body?.result?.isError !== true &&
    toolResult(hybrid.body!).source === "hybrid_rrf_fallback",
  "hybrid search reports RRF fallback when RPC is absent",
);
const semanticCall = requests.find((entry) =>
  entry.url.includes("/rest/v1/rpc/match_thoughts")
);
assert(
  semanticCall && JSON.parse(semanticCall.body).match_threshold === 0.77,
  "hybrid fallback semantic leg honors the caller threshold",
);

const list = await mcp("tools/call", {
  name: "list_thoughts",
  arguments: { limit: 2 },
});
const listed = toolResult(list.body!);
assert(
  listed.results.length === 2 && listed.pagination.has_more === true,
  "list_thoughts over-reads one row and reports has_more=true",
);
assert(
  listed.results.find((row: { id: string }) => row.id === "list-source")
    ?.source_type === "mcp",
  "list_thoughts uses metadata.source when the source_type column is null",
);

const requestCountBeforeUpdate = requests.length;
const stale = await mcp("tools/call", {
  name: "update_thought",
  arguments: {
    id: ID,
    metadata_patch: { topic: "new" },
    if_unchanged_since: "2026-07-01T00:00:00.000Z",
  },
});
assert(
  stale.body?.result?.isError === true &&
    stale.body.result.content[0].text.includes("STALE_READ"),
  "update_thought stale timestamp returns STALE_READ",
);
assert(
  !requests.slice(requestCountBeforeUpdate).some((entry) =>
    entry.method === "PATCH"
  ),
  "STALE_READ emits no PATCH",
);
const beforeRefusedDelete = requests.length;
const refused = await mcp("tools/call", {
  name: "delete_thought",
  arguments: { id: ID },
});
assert(
  refused.body?.result?.isError === true &&
    refused.body.result.content[0].text.includes("confirm=true"),
  "delete_thought without confirm is refused",
);
assert(
  !requests.slice(beforeRefusedDelete).some((entry) =>
    entry.url.includes("soft_delete_thought")
  ),
  "delete_thought confirm gate runs before the RPC",
);

console.log("\n[3] Atomic mutation RPCs and signaled compatibility fallbacks");
const beforeAtomicCapture = requests.length;
const atomicCapture = await mcp("tools/call", {
  name: "capture_thought",
  arguments: { content: "atomic capture" },
});
const atomicCaptureResult = toolResult(atomicCapture.body!);
assert(
  atomicCaptureResult.id === ATOMIC_CAPTURE_ID &&
    atomicCaptureResult.atomic === true &&
    atomicCaptureResult.via === "capture_thought_atomic",
  "capture_thought reports the atomic RPC path",
);
const atomicCaptureRequests = requests.slice(beforeAtomicCapture);
const atomicCaptureRpc = atomicCaptureRequests.find((entry) =>
  entry.url.includes("/rpc/capture_thought_atomic")
);
assert(
  atomicCaptureRpc &&
    JSON.parse(atomicCaptureRpc.body).p_embedding === "[0.1,0.2,0.3]",
  "capture_thought_atomic receives the precomputed embedding",
);
assert(
  !atomicCaptureRequests.some((entry) =>
    entry.url.includes("/rpc/upsert_thought") || entry.method === "PATCH"
  ),
  "successful atomic capture does not run legacy writes",
);

const beforeFallbackCapture = requests.length;
const fallbackCapture = await mcp("tools/call", {
  name: "capture_thought",
  arguments: { content: "fallback capture" },
});
const fallbackCaptureResult = toolResult(fallbackCapture.body!);
assert(
  fallbackCaptureResult.id === LEGACY_CAPTURE_ID &&
    fallbackCaptureResult.atomic === false &&
    fallbackCaptureResult.via === "fallback_non_atomic",
  "capture_thought signals the non-atomic fallback when RPC is absent",
);
const fallbackCaptureRequests = requests.slice(beforeFallbackCapture);
assert(
  fallbackCaptureRequests.findIndex((entry) =>
    entry.url.includes("/rpc/capture_thought_atomic")
  ) < fallbackCaptureRequests.findIndex((entry) =>
    entry.url.includes("/rpc/upsert_thought")
  ),
  "capture_thought attempts atomic RPC before legacy upsert",
);
assert(
  fallbackCaptureRequests.some((entry) =>
    entry.method === "PATCH" &&
    JSON.parse(entry.body).embedding === "[0.1,0.2,0.3]"
  ),
  "capture_thought fallback persists the embedding",
);

const beforeAtomicDelete = requests.length;
const atomicDelete = await mcp("tools/call", {
  name: "delete_thought",
  arguments: { id: ATOMIC_DELETE_ID, confirm: true },
});
const atomicDeleteResult = toolResult(atomicDelete.body!);
assert(
  atomicDeleteResult.atomic === true &&
    atomicDeleteResult.via === "soft_delete_thought",
  "delete_thought reports the atomic soft-delete RPC path",
);
const atomicDeleteRequests = requests.slice(beforeAtomicDelete);
const atomicDeleteRpc = atomicDeleteRequests.find((entry) =>
  entry.url.includes("/rpc/soft_delete_thought")
);
assert(
  atomicDeleteRpc && JSON.parse(atomicDeleteRpc.body).p_actor === "mcp" &&
    JSON.parse(atomicDeleteRpc.body).p_confirm === true,
  "soft_delete_thought receives actor=mcp and confirm=true",
);
assert(
  !atomicDeleteRequests.some((entry) =>
    entry.url.includes("/rest/v1/thoughts")
  ),
  "successful atomic delete does not run legacy reads or writes",
);

const beforeFallbackDelete = requests.length;
const deleted = await mcp("tools/call", {
  name: "delete_thought",
  arguments: { id: FALLBACK_DELETE_ID, confirm: true },
});
const deletedResult = toolResult(deleted.body!);
assert(
  deleted.body?.result?.isError !== true && deletedResult.atomic === false &&
    deletedResult.via === "fallback_non_atomic",
  "delete_thought signals the legacy fallback when RPC is absent",
);
const fallbackDeleteRequests = requests.slice(beforeFallbackDelete);
assert(
  fallbackDeleteRequests[0]?.url.includes("/rpc/soft_delete_thought"),
  "delete_thought attempts soft_delete_thought before fallback",
);
const deletePatch = fallbackDeleteRequests.find((entry) =>
  entry.method === "PATCH"
);
assert(
  deletePatch && JSON.parse(deletePatch.body).metadata.deleted === true,
  "logical delete PATCH writes metadata.deleted=true",
);
assert(
  !requests.some((entry) => entry.method === "DELETE"),
  "delete_thought never makes an HTTP DELETE",
);

const stats = await mcp("tools/call", {
  name: "thought_stats",
  arguments: { since_days: 31 },
});
assert(
  toolResult(stats.body!).aggregate.total === 7,
  "thought_stats returns aggregate RPC result",
);
assert(
  requests.some((entry) =>
    entry.url.includes("/rest/v1/rpc/brain_stats_aggregate")
  ),
  "thought_stats calls brain_stats_aggregate RPC URL",
);

console.log(
  `\n${passed + failed} assertions: ${passed} passed, ${failed} failed`,
);
if (failed) Deno.exit(1);
console.log("PASS");
