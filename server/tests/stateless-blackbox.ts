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
const MEMORY_A_ID = "66666666-6666-4666-8666-666666666666";
const MEMORY_B_ID = "77777777-7777-4777-8777-777777777777";
const MEMORY_PENDING_ID = "88888888-8888-4888-8888-888888888888";
const MEMORY_OUTSIDE_TRACE_ID = "99999999-9999-4999-8999-999999999999";
const DELETED_STRING_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const BASE_SCHEMA_ID = "aaaaaaaa-2222-4222-8222-222222222222";
const HYBRID_RPC_ID = "aaaaaaaa-3333-4333-8333-333333333333";
const VALID_EMBEDDING = Array.from(
  { length: 1536 },
  (_, index) => index < 3 ? [0.1, 0.2, 0.3][index] : 0,
);

Deno.env.set("SUPABASE_URL", "http://postgrest.invalid");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("OPENROUTER_API_KEY", "test-openrouter-key");
Deno.env.set("OPENROUTER_BASE_URL", "http://openrouter.invalid");
Deno.env.set("MCP_ACCESS_KEY", ACCESS_KEY);

type MockRequest = {
  method: string;
  url: string;
  body: string;
  hasSignal: boolean;
};
const requests: MockRequest[] = [];
let memorySequence = 10;
let traceSequence = 20;
let failNextAudit = false;
const embeddingAttempts = new Map<string, number>();
const writebackByKey = new Map<string, Record<string, any>>();
const agentMemories: Array<Record<string, any>> = [
  {
    id: MEMORY_A_ID,
    thought_id: "semantic-visible",
    workspace_id: "workspace-a",
    project_id: null,
    channel_id: null,
    visibility: "workspace",
    memory_type: "decision",
    summary: "Workspace A decision",
    content: "Workspace A private decision",
    lifecycle_status: "active",
    provenance_status: "observed",
    confidence: 0.9,
    created_by: "agent",
    runtime_name: "open-brain-mcp-v2",
    can_use_as_instruction: false,
    can_use_as_evidence: true,
    requires_user_confirmation: false,
    review_status: "evidence_only",
    last_confirmed_at: null,
    stale_after: null,
    idempotency_key: "seed-a",
    content_hash: "seed-a-hash",
    metadata: {},
    created_at: "2026-07-12T00:00:00.000Z",
  },
  {
    id: MEMORY_B_ID,
    thought_id: "semantic-visible",
    workspace_id: "workspace-b",
    project_id: null,
    channel_id: null,
    visibility: "workspace",
    memory_type: "decision",
    summary: "Workspace B decision",
    content: "Workspace B must never cross the boundary",
    lifecycle_status: "active",
    provenance_status: "observed",
    confidence: 1,
    created_by: "agent",
    runtime_name: "open-brain-mcp-v2",
    can_use_as_instruction: false,
    can_use_as_evidence: true,
    requires_user_confirmation: false,
    review_status: "evidence_only",
    last_confirmed_at: null,
    stale_after: null,
    idempotency_key: "seed-b",
    content_hash: "seed-b-hash",
    metadata: {},
    created_at: "2026-07-13T00:00:00.000Z",
  },
  {
    id: MEMORY_PENDING_ID,
    thought_id: "semantic-visible",
    workspace_id: "workspace-a",
    project_id: null,
    channel_id: null,
    visibility: "workspace",
    memory_type: "lesson",
    summary: "Pending memory",
    content: "Pending memories are review-only until accepted",
    lifecycle_status: "active",
    provenance_status: "generated",
    confidence: 0.7,
    created_by: "agent",
    runtime_name: "open-brain-mcp-v2",
    can_use_as_instruction: false,
    can_use_as_evidence: true,
    requires_user_confirmation: true,
    review_status: "pending",
    last_confirmed_at: null,
    stale_after: null,
    idempotency_key: "seed-pending",
    content_hash: "seed-pending-hash",
    metadata: {},
    created_at: "2026-07-11T00:00:00.000Z",
  },
];
const recallTraces: Array<Record<string, any>> = [];
const recallItems: Array<Record<string, any>> = [];
const memoryAuditEvents: Array<Record<string, any>> = [];

function eqFilter(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  return value?.startsWith("eq.") ? value.slice(3) : undefined;
}

function postgrestRows(
  request: Request,
  rows: Array<Record<string, any>>,
  status = 200,
): Response {
  if (request.headers.get("accept")?.includes("application/vnd.pgrst.object")) {
    if (rows.length === 1) return json(status, rows[0]);
    return json(406, {
      code: "PGRST116",
      message: "JSON object requested, multiple (or no) rows returned",
    });
  }
  return json(status, rows);
}

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
  const entry = {
    method: request.method,
    url: request.url,
    body: rawBody,
    hasSignal: Boolean(init?.signal),
  };
  requests.push(entry);
  const url = new URL(request.url);

  if (url.hostname === "openrouter.invalid" && url.pathname === "/embeddings") {
    const inputText = String(JSON.parse(rawBody).input ?? "");
    const attempt = (embeddingAttempts.get(inputText) ?? 0) + 1;
    embeddingAttempts.set(inputText, attempt);
    if (inputText === "retry-embedding" && attempt < 3) {
      return json(429, { message: "rate limited internal detail" });
    }
    if (inputText === "bad-embedding") {
      return json(200, { data: [{ embedding: [0.1, 0.2] }] });
    }
    const embedding = [...VALID_EMBEDDING];
    if (inputText === "base-schema") embedding[0] = 0.42;
    return json(200, { data: [{ embedding }] });
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
    if (JSON.parse(rawBody).p_query === "base-schema") {
      return json(404, {
        code: "PGRST202",
        message:
          "Could not find the function public.search_thoughts_text in the schema cache",
      });
    }
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
    const payload = JSON.parse(rawBody);
    if (payload.p_query === "hybrid-rpc") {
      if (
        payload.p_semantic_threshold !== 0.83 ||
        payload.p_semantic_weight !== 0.75 ||
        payload.p_text_weight !== 3
      ) {
        return json(400, {
          code: "P0001",
          message: "weighted payload missing",
        });
      }
      return json(200, [{
        id: HYBRID_RPC_ID,
        similarity: 0.9,
        content: "hybrid RPC result",
        metadata: {},
        created_at: "2026-07-14T00:00:00.000Z",
      }]);
    }
    if (
      payload.p_query === "hybrid-legacy" &&
      (Object.hasOwn(payload, "p_semantic_weight") ||
        Object.hasOwn(payload, "p_text_weight"))
    ) {
      return json(404, {
        code: "PGRST202",
        message:
          "Could not find the function public.hybrid_search_thoughts(p_query, p_semantic_threshold, p_semantic_weight, p_text_weight) in the schema cache",
      });
    }
    if (payload.p_query === "hybrid-legacy") {
      return json(200, [{
        id: HYBRID_RPC_ID,
        similarity: 0.88,
        content: "legacy hybrid RPC result",
        metadata: {},
        created_at: "2026-07-14T00:00:00.000Z",
      }]);
    }
    return json(404, {
      code: "PGRST202",
      message:
        "Could not find the function public.hybrid_search_thoughts in the schema cache",
    });
  }
  if (rpc === "match_thoughts") {
    if (JSON.parse(rawBody).query_embedding?.[0] === 0.42) {
      return json(200, [{ id: BASE_SCHEMA_ID, similarity: 0.89 }]);
    }
    return json(200, [{ id: "semantic-visible", similarity: 0.91 }]);
  }
  if (rpc === "agent_memory_match") {
    const payload = JSON.parse(rawBody);
    if (payload.p_workspace_id === "match-rpc-absent") {
      return json(404, {
        code: "PGRST202",
        message:
          "Could not find the function public.agent_memory_match in the schema cache",
      });
    }
    return json(
      200,
      payload.p_workspace_id === "workspace-a"
        ? [{ memory_id: MEMORY_A_ID, similarity: 0.93 }]
        : [],
    );
  }
  if (rpc === "agent_memory_writeback_tx") {
    const payload = JSON.parse(rawBody);
    if (payload.p_workspace_id === "rpc-outdated") {
      return json(404, {
        code: "PGRST202",
        message:
          "Could not find the function public.agent_memory_writeback_tx(p_workspace_id, p_embedding) in the schema cache; p_embedding does not exist",
      });
    }
    if (payload.p_workspace_id === "rpc-absent") {
      return json(404, {
        code: "PGRST202",
        message:
          "Could not find the function public.agent_memory_writeback_tx in the schema cache",
      });
    }
    const key = `${payload.p_workspace_id}:${payload.p_idempotency_key}`;
    const existing = writebackByKey.get(key);
    if (existing) {
      if (existing.content_hash !== payload.p_content_hash) {
        return json(400, {
          code: "P0001",
          message: "Idempotency key was already used with different content",
        });
      }
      return json(200, { ...existing, replayed: true });
    }
    memorySequence++;
    const row = {
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(memorySequence).padStart(12, "0")}`,
      thought_id: null,
      workspace_id: payload.p_workspace_id,
      project_id: payload.p_memory.project_id,
      channel_id: payload.p_memory.channel_id,
      visibility: payload.p_memory.visibility,
      memory_type: payload.p_memory.type,
      summary: payload.p_memory.summary,
      content: payload.p_memory.content,
      lifecycle_status: "active",
      provenance_status: payload.p_provenance.status,
      confidence: 0.5,
      created_by: payload.p_created_by,
      runtime_name: payload.p_request_context.runtime_name,
      can_use_as_instruction: false,
      can_use_as_evidence: true,
      requires_user_confirmation: true,
      review_status: "pending",
      last_confirmed_at: null,
      stale_after: null,
      idempotency_key: payload.p_idempotency_key,
      content_hash: payload.p_content_hash,
      metadata: {},
      created_at: "2026-07-14T00:00:00.000Z",
    };
    writebackByKey.set(key, row);
    agentMemories.push(row);
    return json(200, { ...row, replayed: false });
  }
  if (rpc === "agent_memory_review_tx") {
    const payload = JSON.parse(rawBody);
    if (payload.p_workspace_id === "rpc-outdated-review") {
      return json(404, {
        code: "PGRST202",
        message:
          "Could not find the function public.agent_memory_review_tx(p_embedding) in the schema cache; p_embedding does not exist",
      });
    }
    if (payload.p_workspace_id === "rpc-absent") {
      return json(404, {
        code: "PGRST202",
        message:
          "Could not find the function public.agent_memory_review_tx in the schema cache",
      });
    }
    const memory = agentMemories.find((row) =>
      row.id === payload.p_memory_id &&
      row.workspace_id === payload.p_workspace_id
    );
    if (!memory) {
      return json(400, {
        code: "P0001",
        message: "Memory not found in workspace",
      });
    }
    if (payload.p_actor_kind !== "agent") {
      return json(400, {
        code: "P0001",
        message: "MCP review actor_kind must be agent",
      });
    }
    if (payload.p_action === "confirm") {
      if (memory.review_status === "confirmed") {
        return json(400, {
          code: "P0001",
          message: "Invalid transition: memory is already confirmed",
        });
      }
      Object.assign(memory, {
        review_status: "confirmed",
        provenance_status: "user_confirmed",
        can_use_as_instruction: true,
        requires_user_confirmation: false,
      });
    }
    if (payload.p_action === "edit") {
      if (payload.p_content && !Array.isArray(payload.p_embedding)) {
        return json(400, {
          code: "22023",
          message: "embedding required when editing content",
        });
      }
      Object.assign(memory, {
        content: payload.p_content ?? memory.content,
        summary: payload.p_summary ?? memory.summary,
        embedding: payload.p_content ? payload.p_embedding : memory.embedding,
        review_status: "pending",
        provenance_status: "generated",
        can_use_as_instruction: false,
        can_use_as_evidence: true,
        requires_user_confirmation: true,
      });
    }
    return json(200, memory);
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

  if (
    url.pathname.startsWith("/rest/v1/agent_memor") &&
    request.url.includes("schema-absent")
  ) {
    const table = url.pathname.split("/").at(-1);
    return json(404, {
      code: "PGRST205",
      message: `Could not find the table public.${table} in the schema cache`,
    });
  }

  if (url.pathname === "/rest/v1/agent_memories") {
    if (request.method === "GET") {
      let rows = [...agentMemories];
      for (
        const key of [
          "workspace_id",
          "idempotency_key",
          "id",
          "review_status",
          "thought_id",
        ]
      ) {
        const expected = eqFilter(url, key);
        if (expected !== undefined) {
          rows = rows.filter((row) => String(row[key] ?? "") === expected);
        }
      }
      for (const key of ["id", "thought_id"]) {
        const values = url.searchParams.get(key);
        if (!values?.startsWith("in.(")) continue;
        const allowed = new Set(
          values.slice(4, -1).split(",").map(decodeURIComponent),
        );
        rows = rows.filter((row) => allowed.has(row[key]));
      }
      const order = url.searchParams.get("order") ?? "";
      if (order.includes("created_at.asc")) {
        rows.sort((a, b) =>
          a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
        );
      } else {
        rows.sort((a, b) =>
          Number(b.confidence) - Number(a.confidence) ||
          b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id)
        );
      }
      const range = request.headers.get("range")?.split("-").map(Number);
      if (range?.length === 2 && range.every(Number.isFinite)) {
        rows = rows.slice(range[0], range[1] + 1);
      }
      const limit = Number(url.searchParams.get("limit"));
      if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit);
      return postgrestRows(request, rows);
    }
    if (request.method === "POST") {
      const payload = JSON.parse(rawBody);
      const input = Array.isArray(payload) ? payload[0] : payload;
      if (
        agentMemories.some((row) =>
          row.workspace_id === input.workspace_id &&
          row.idempotency_key === input.idempotency_key
        )
      ) {
        return json(409, {
          code: "23505",
          message: "duplicate key value violates unique constraint",
        });
      }
      memorySequence++;
      const row = {
        lifecycle_status: "active",
        created_at: `2026-07-14T00:00:${
          String(memorySequence).padStart(2, "0")
        }.000Z`,
        ...input,
        id: `aaaaaaaa-aaaa-4aaa-8aaa-${
          String(memorySequence).padStart(12, "0")
        }`,
      };
      agentMemories.push(row);
      return postgrestRows(request, [row], 201);
    }
    if (request.method === "PATCH") {
      const payload = JSON.parse(rawBody);
      const id = eqFilter(url, "id");
      const workspace = eqFilter(url, "workspace_id");
      const rows = agentMemories.filter((row) =>
        (!id || row.id === id) && (!workspace || row.workspace_id === workspace)
      );
      rows.forEach((row) => Object.assign(row, payload));
      return postgrestRows(request, rows);
    }
  }

  if (url.pathname === "/rest/v1/agent_memory_recall_traces") {
    if (request.method === "POST") {
      const payload = JSON.parse(rawBody);
      if (payload.workspace_id === "trace-write-fail") {
        return json(500, {
          code: "XX000",
          message: "private trace storage detail",
        });
      }
      traceSequence++;
      const row = {
        ...payload,
        id: `bbbbbbbb-bbbb-4bbb-8bbb-${
          String(traceSequence).padStart(12, "0")
        }`,
        request_id: `cccccccc-cccc-4ccc-8ccc-${
          String(traceSequence).padStart(12, "0")
        }`,
        created_at: "2026-07-14T00:00:00.000Z",
      };
      recallTraces.push(row);
      return postgrestRows(request, [row], 201);
    }
    if (request.method === "GET") {
      let rows = [...recallTraces];
      const requestId = eqFilter(url, "request_id");
      if (requestId) rows = rows.filter((row) => row.request_id === requestId);
      return postgrestRows(request, rows);
    }
  }

  if (url.pathname === "/rest/v1/agent_memory_recall_items") {
    if (request.method === "POST") {
      const payload = JSON.parse(rawBody);
      for (const item of Array.isArray(payload) ? payload : [payload]) {
        recallItems.push({
          ...item,
          id: `dddddddd-dddd-4ddd-8ddd-${
            String(recallItems.length + 1).padStart(12, "0")
          }`,
        });
      }
      return json(201, []);
    }
    if (request.method === "GET") {
      let rows = [...recallItems];
      const traceId = eqFilter(url, "trace_id");
      if (traceId) rows = rows.filter((row) => row.trace_id === traceId);
      return postgrestRows(request, rows);
    }
    if (request.method === "PATCH") {
      const payload = JSON.parse(rawBody);
      const traceId = eqFilter(url, "trace_id");
      const memoryId = eqFilter(url, "memory_id");
      const rows = recallItems.filter((row) =>
        (!traceId || row.trace_id === traceId) &&
        (!memoryId || row.memory_id === memoryId)
      );
      rows.forEach((row) => Object.assign(row, payload));
      return postgrestRows(request, rows);
    }
  }

  if (url.pathname === "/rest/v1/agent_memory_audit_events") {
    if (request.method === "POST") {
      if (failNextAudit) {
        failNextAudit = false;
        return json(500, {
          code: "XX000",
          message: "private audit storage detail",
        });
      }
      const payload = JSON.parse(rawBody);
      memoryAuditEvents.push(...(Array.isArray(payload) ? payload : [payload]));
      return json(201, []);
    }
  }

  if (
    [
      "/rest/v1/agent_memory_source_refs",
      "/rest/v1/agent_memory_review_actions",
      "/rest/v1/agent_memory_relations",
    ].includes(url.pathname) && request.method === "POST"
  ) {
    return json(201, []);
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
      const select = url.searchParams.get("select") ?? "";
      if (
        idFilter.includes(BASE_SCHEMA_ID) && select.includes("quality_score")
      ) {
        return json(400, {
          code: "42703",
          message: "column thoughts.quality_score does not exist",
        });
      }
      const ids = [
        "semantic-visible",
        "text-visible",
        "text-deleted",
        "text-deleted-string",
        "text-metadata-source",
        BASE_SCHEMA_ID,
        HYBRID_RPC_ID,
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
      const requestedId = idFilter.slice(3);
      const select = url.searchParams.get("select") ?? "";
      if (requestedId === BASE_SCHEMA_ID && select.includes("quality_score")) {
        return json(400, {
          code: "PGRST204",
          message:
            "Could not find the 'quality_score' column in the schema cache",
        });
      }
      if (requestedId === BASE_SCHEMA_ID) {
        return json(200, {
          id: BASE_SCHEMA_ID,
          content: "base schema thought",
          metadata: { topics: ["base"] },
          created_at: "2026-07-14T00:00:00.000Z",
        });
      }
      if (requestedId === DELETED_STRING_ID) {
        return json(200, {
          id: DELETED_STRING_ID,
          content: "deleted string row",
          metadata: { deleted: "true" },
          created_at: "2026-07-01T00:00:00.000Z",
          updated_at: "2026-07-10T12:00:00.000Z",
        });
      }
      return json(200, {
        id: requestedId,
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
  "memory_recall",
  "memory_writeback",
  "memory_usage_report",
  "memory_review_queue",
  "memory_review",
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
for (
  const [label, key] of [
    ["shorter", ACCESS_KEY.slice(0, -1)],
    ["longer", `${ACCESS_KEY}x`],
  ] as const
) {
  assert(
    (await mcp("initialize", {}, {
      "content-type": "application/json",
      "x-brain-key": key,
    })).response.status === 401,
    `x-brain-key ${label} key -> 401`,
  );
  assert(
    (await mcp("initialize", {}, {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    })).response.status === 401,
    `Authorization Bearer ${label} key -> 401`,
  );
}
const tools = await mcp("tools/list");
assert(tools.response.status === 200, "tools/list -> 200");
assert(
  JSON.stringify(
    tools.body?.result.tools.map((tool: { name: string }) => tool.name).sort(),
  ) === JSON.stringify(expectedTools),
  "tools/list contains exactly the fifteen v2 tools",
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
    toolResult(hybrid.body!).source === "hybrid_rrf_fallback" &&
    toolResult(hybrid.body!).results[0]?.id === "text-visible",
  "hybrid fallback applies the lexical-priority 2:1 ranking",
);
const semanticCall = requests.find((entry) =>
  entry.url.includes("/rest/v1/rpc/match_thoughts")
);
assert(
  semanticCall && JSON.parse(semanticCall.body).match_threshold === 0.77,
  "hybrid fallback semantic leg honors the caller threshold",
);
const hybridRpc = await mcp("tools/call", {
  name: "search_thoughts",
  arguments: {
    query: "hybrid-rpc",
    mode: "hybrid",
    threshold: 0.83,
    semantic_weight: 0.75,
    text_weight: 3,
  },
});
assert(
  hybridRpc.body?.result?.isError !== true &&
    toolResult(hybridRpc.body!).source === "hybrid_rpc",
  "installed hybrid RPC path succeeds",
);
assert(
  requests.some((entry) =>
    entry.url.includes("/rpc/hybrid_search_thoughts") &&
    JSON.parse(entry.body).p_query === "hybrid-rpc" &&
    JSON.parse(entry.body).p_semantic_threshold === 0.83 &&
    JSON.parse(entry.body).p_semantic_weight === 0.75 &&
    JSON.parse(entry.body).p_text_weight === 3
  ),
  "hybrid RPC receives threshold and both configurable weights",
);
const legacyHybrid = await mcp("tools/call", {
  name: "search_thoughts",
  arguments: { query: "hybrid-legacy", mode: "hybrid", threshold: 0.64 },
});
const legacyHybridCalls = requests.filter((entry) =>
  entry.url.includes("/rpc/hybrid_search_thoughts") &&
  JSON.parse(entry.body).p_query === "hybrid-legacy"
);
assert(
  legacyHybrid.body?.result?.isError !== true &&
    legacyHybridCalls.length === 2 &&
    Object.hasOwn(
      JSON.parse(legacyHybridCalls[0].body),
      "p_semantic_weight",
    ) &&
    !Object.hasOwn(
      JSON.parse(legacyHybridCalls[1].body),
      "p_semantic_weight",
    ) &&
    JSON.parse(legacyHybridCalls[1].body).p_semantic_threshold === 0.64,
  "hybrid RPC retries the legacy 8-parameter signature without weights",
);

const invertedHybrid = await mcp("tools/call", {
  name: "search_thoughts",
  arguments: {
    query: "hybrid-inverted",
    mode: "hybrid",
    limit: 1,
    semantic_weight: 2,
    text_weight: 1,
  },
});
assert(
  invertedHybrid.body?.result?.isError !== true &&
    toolResult(invertedHybrid.body!).results[0]?.id === "semantic-visible",
  "hybrid fallback uses caller-supplied semantic/text weights",
);

for (
  const [name, value] of [["semantic_weight", 0], ["text_weight", -1]] as const
) {
  const invalidWeight = await mcp("tools/call", {
    name: "search_thoughts",
    arguments: { query: "hybrid", mode: "hybrid", [name]: value },
  });
  assert(
    invalidWeight.body?.result?.isError === true &&
      invalidWeight.body.result.content[0].text.includes(
        `Invalid ${name}: expected a finite number > 0`,
      ),
    `search_thoughts rejects invalid ${name}`,
  );
}

const baseSearch = await mcp("tools/call", {
  name: "search",
  arguments: { query: "base-schema" },
});
assert(
  baseSearch.body?.result?.isError !== true &&
    toolResult(baseSearch.body!).results[0]?.id === BASE_SCHEMA_ID,
  "ChatGPT search degrades to semantic-only on the base OB1 schema",
);
const baseFetch = await mcp("tools/call", {
  name: "fetch",
  arguments: { id: BASE_SCHEMA_ID },
});
assert(
  baseFetch.body?.result?.isError !== true &&
    toolResult(baseFetch.body!).text === "base schema thought",
  "ChatGPT fetch retries a base-column select when enrichment columns are absent",
);

const retryEmbedding = await mcp("tools/call", {
  name: "search_thoughts",
  arguments: { query: "retry-embedding", mode: "semantic" },
});
assert(
  retryEmbedding.body?.result?.isError !== true &&
    embeddingAttempts.get("retry-embedding") === 3,
  "embedding requests retry twice on 429 then succeed",
);
const badEmbedding = await mcp("tools/call", {
  name: "search_thoughts",
  arguments: { query: "bad-embedding", mode: "semantic" },
});
const badEmbeddingText = badEmbedding.body?.result?.content?.[0]?.text ?? "";
assert(
  badEmbedding.body?.result?.isError === true &&
    /Internal failure \(reference [0-9a-f]{8}\)/.test(badEmbeddingText) &&
    !badEmbeddingText.includes("1536"),
  "invalid embeddings return a generic correlated client error",
);
assert(
  requests.some((entry) =>
    entry.url.includes("openrouter.invalid/embeddings") && entry.hasSignal
  ) && requests.some((entry) =>
    entry.url.includes("postgrest.invalid/rest/v1") && entry.hasSignal
  ),
  "OpenRouter and PostgREST requests carry timeout signals",
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
const beforeDeletedStringUpdate = requests.length;
const deletedStringUpdate = await mcp("tools/call", {
  name: "update_thought",
  arguments: {
    id: DELETED_STRING_ID,
    metadata_patch: { topic: "must-not-write" },
  },
});
assert(
  deletedStringUpdate.body?.result?.isError === true &&
    deletedStringUpdate.body.result.content[0].text.includes(
      "is logically deleted",
    ),
  'update_thought refuses metadata.deleted="true"',
);
assert(
  !requests.slice(beforeDeletedStringUpdate).some((entry) =>
    entry.method === "PATCH"
  ),
  'metadata.deleted="true" refusal emits no PATCH',
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

console.log("\n[3] Agent Memory governance and sidecar contracts");
const memoryRecall = await mcp("tools/call", {
  name: "memory_recall",
  arguments: { workspace_id: "workspace-a" },
});
const memoryRecallResult = toolResult(memoryRecall.body!);
assert(
  memoryRecall.body?.result?.isError !== true &&
    memoryRecallResult.memories.map((row: { id: string }) => row.id).join(
        ",",
      ) ===
      MEMORY_A_ID,
  "memory_recall enforces workspace isolation and excludes pending review",
);
assert(
  typeof memoryRecallResult.request_id === "string" &&
    recallTraces.some((trace) =>
      trace.request_id === memoryRecallResult.request_id
    ),
  "memory_recall persists and returns a recall request_id",
);
assert(
  recallItems.some((item) =>
    item.memory_id === MEMORY_A_ID &&
    recallTraces.some((trace) => trace.id === item.trace_id)
  ),
  "memory_recall persists returned recall items",
);
const beforeSemanticRecall = requests.length;
const semanticMemoryRecall = await mcp("tools/call", {
  name: "memory_recall",
  arguments: { workspace_id: "workspace-a", query: "Workspace A decision" },
});
const semanticMemoryRecallResult = toolResult(semanticMemoryRecall.body!);
const semanticMatchRequest = requests.slice(beforeSemanticRecall).find((
  entry,
) => entry.url.includes("/rpc/agent_memory_match"));
assert(
  semanticMatchRequest &&
    JSON.parse(semanticMatchRequest.body).p_workspace_id === "workspace-a" &&
    Array.isArray(JSON.parse(semanticMatchRequest.body).p_query_embedding),
  "memory_recall query calls agent_memory_match with the exact workspace and embedding",
);
assert(
  semanticMemoryRecall.body?.result?.isError !== true &&
    semanticMemoryRecallResult.memories.map((row: { id: string }) => row.id)
        .join(",") === MEMORY_A_ID &&
    requests.slice(beforeSemanticRecall).some((entry) =>
      entry.url.includes("/agent_memories?") &&
      entry.url.includes(`id=in.%28${MEMORY_A_ID}`)
    ),
  "memory_recall joins semantic memory_id results to workspace-scoped memories",
);
const missingSemanticRecall = await mcp("tools/call", {
  name: "memory_recall",
  arguments: {
    workspace_id: "match-rpc-absent",
    query: "fail closed semantic recall",
  },
});
assert(
  missingSemanticRecall.body?.result?.isError === true &&
    missingSemanticRecall.body.result.content[0].text.includes(
      "not installed/outdated",
    ),
  "memory_recall query fails closed when agent_memory_match is absent",
);
const failedTraceRecall = await mcp("tools/call", {
  name: "memory_recall",
  arguments: { workspace_id: "trace-write-fail" },
});
assert(
  failedTraceRecall.body?.result?.isError === true &&
    failedTraceRecall.body.result.content[0].text.includes(
      "Internal failure",
    ) &&
    !failedTraceRecall.body.result.content[0].text.includes(
      "private trace storage detail",
    ),
  "memory_recall fails closed with a generic error when trace persistence fails",
);

const writebackArguments = {
  workspace_id: "workspace-a",
  idempotency_key: "writeback-idempotency-test",
  memory: {
    type: "lesson",
    summary: "Idempotent lesson",
    content: "A compact reusable operational lesson.",
  },
  provenance: { status: "generated" },
};
const beforeWriteback = requests.length;
const writebackOne = await mcp("tools/call", {
  name: "memory_writeback",
  arguments: writebackArguments,
});
const writebackTwo = await mcp("tools/call", {
  name: "memory_writeback",
  arguments: writebackArguments,
});
const writebackOneResult = toolResult(writebackOne.body!);
const writebackTwoResult = toolResult(writebackTwo.body!);
assert(
  writebackOneResult.memory.id === writebackTwoResult.memory.id &&
    writebackOneResult.idempotent_replay === false &&
    writebackTwoResult.idempotent_replay === true,
  "memory_writeback replays identical workspace-scoped idempotency keys",
);
const writtenMemory = agentMemories.find((row) =>
  row.id === writebackOneResult.memory.id
);
assert(
  writtenMemory?.can_use_as_instruction === false &&
    writtenMemory?.can_use_as_evidence === true &&
    writtenMemory?.requires_user_confirmation === true &&
    writtenMemory?.review_status === "pending",
  "memory_writeback always starts evidence-only and pending review",
);
const writebackRequests = requests.slice(beforeWriteback).filter((entry) =>
  entry.url.includes("agent_memory_writeback_tx")
);
const firstWritebackPayload = JSON.parse(writebackRequests[0].body);
assert(
  writebackRequests.length === 2 &&
    /^[0-9a-f]{64}$/.test(firstWritebackPayload.p_content_hash) &&
    firstWritebackPayload.p_memory.content ===
      writebackArguments.memory.content &&
    Array.isArray(firstWritebackPayload.p_source_refs) &&
    Array.isArray(firstWritebackPayload.p_artifacts) &&
    Array.isArray(firstWritebackPayload.p_embedding) &&
    firstWritebackPayload.p_embedding.length === 1536,
  "memory_writeback sends a non-null content embedding and the full pinned RPC contract",
);
assert(
  !requests.slice(beforeWriteback).some((entry) =>
    entry.url.includes("/rpc/upsert_thought") || entry.method === "PATCH" ||
    entry.url.includes("/rest/v1/agent_memory_source_refs")
  ),
  "memory_writeback performs no legacy multi-write sequence",
);
const writebackConflict = await mcp("tools/call", {
  name: "memory_writeback",
  arguments: {
    ...writebackArguments,
    memory: {
      ...writebackArguments.memory,
      content: "Changed content under a reused idempotency key.",
    },
  },
});
assert(
  writebackConflict.body?.result?.isError === true &&
    writebackConflict.body.result.content[0].text.includes(
      "already used with different content",
    ),
  "memory_writeback rejects changed content under a reused key",
);
const beforeFailedEmbeddingWriteback = requests.length;
const failedEmbeddingWriteback = await mcp("tools/call", {
  name: "memory_writeback",
  arguments: {
    ...writebackArguments,
    idempotency_key: "failed-embedding-key",
    memory: { ...writebackArguments.memory, content: "bad-embedding" },
  },
});
assert(
  failedEmbeddingWriteback.body?.result?.isError === true &&
    failedEmbeddingWriteback.body.result.content[0].text.includes(
      "embedding generation failed — memory was not written",
    ) &&
    !requests.slice(beforeFailedEmbeddingWriteback).some((entry) =>
      entry.url.includes("/rpc/agent_memory_writeback_tx")
    ),
  "memory_writeback embedding failure performs no memory write",
);
const outdatedWriteback = await mcp("tools/call", {
  name: "memory_writeback",
  arguments: {
    ...writebackArguments,
    workspace_id: "rpc-outdated",
    idempotency_key: "rpc-outdated-key",
  },
});
assert(
  outdatedWriteback.body?.result?.isError === true &&
    outdatedWriteback.body.result.content[0].text.includes(
      "Agent Memory schema outdated — re-apply schemas/agent-memory",
    ),
  "memory_writeback rejects the legacy RPC signature without p_embedding",
);
const writebackRpcAbsent = await mcp("tools/call", {
  name: "memory_writeback",
  arguments: {
    ...writebackArguments,
    workspace_id: "rpc-absent",
    idempotency_key: "rpc-absent-key",
  },
});
assert(
  writebackRpcAbsent.body?.result?.isError === true &&
    writebackRpcAbsent.body.result.content[0].text.includes(
      "Agent Memory transactional RPCs not installed — apply schemas/agent-memory",
    ),
  "memory_writeback fails closed when its transactional RPC is absent",
);

const usageOutsideTrace = await mcp("tools/call", {
  name: "memory_usage_report",
  arguments: {
    request_id: memoryRecallResult.request_id,
    used_memory_ids: [MEMORY_OUTSIDE_TRACE_ID],
  },
});
assert(
  usageOutsideTrace.body?.result?.isError === true &&
    usageOutsideTrace.body.result.content[0].text.includes(
      "was not returned by this recall",
    ),
  "memory_usage_report rejects memory IDs outside the trace before updates",
);
failNextAudit = true;
const usageAuditFailure = await mcp("tools/call", {
  name: "memory_usage_report",
  arguments: {
    request_id: memoryRecallResult.request_id,
    used_memory_ids: [MEMORY_A_ID],
  },
});
assert(
  usageAuditFailure.body?.result?.isError === true &&
    usageAuditFailure.body.result.content[0].text.includes(
      "Internal failure",
    ) &&
    !usageAuditFailure.body.result.content[0].text.includes(
      "private audit storage detail",
    ),
  "memory_usage_report never reports success when its audit write fails",
);

const reviewWithoutActor = await mcp("tools/call", {
  name: "memory_review",
  arguments: {
    memory_id: MEMORY_PENDING_ID,
    workspace_id: "workspace-a",
    action: "approve",
  },
});
assert(
  reviewWithoutActor.body?.result?.isError === true,
  "memory_review requires actor_id at the MCP schema boundary",
);

const beforeReview = requests.length;
const approvedMemory = await mcp("tools/call", {
  name: "memory_review",
  arguments: {
    memory_id: MEMORY_PENDING_ID,
    workspace_id: "workspace-a",
    action: "approve",
    actor_id: "reviewer-1",
  },
});
assert(
  approvedMemory.body?.result?.isError === true &&
    approvedMemory.body.result.content[0].text.includes(
      "promotion requires an authenticated human reviewer",
    ) &&
    approvedMemory.body.result.content[0].text.includes(
      "Agent Memory REST reviewer interface",
    ),
  "memory_review refuses MCP promotion with human-reviewer guidance",
);
assert(
  !requests.slice(beforeReview).some((entry) =>
    entry.url.includes("/rpc/agent_memory_review_tx")
  ),
  "memory_review promotion gate runs before every review RPC",
);
const beforeEditReview = requests.length;
const editedMemory = await mcp("tools/call", {
  name: "memory_review",
  arguments: {
    memory_id: MEMORY_PENDING_ID,
    workspace_id: "workspace-a",
    action: "edit",
    actor_id: "agent-editor",
    content: "Edited evidence that must return to pending review.",
  },
});
const editReviewPayload = JSON.parse(
  requests.slice(beforeEditReview).find((entry) =>
    entry.url.includes("/rpc/agent_memory_review_tx")
  )!.body,
);
assert(
  editedMemory.body?.result?.isError !== true &&
    toolResult(editedMemory.body!).demoted_to_pending === true &&
    agentMemories.find((row) => row.id === MEMORY_PENDING_ID)?.review_status ===
      "pending" &&
    editReviewPayload.p_actor_kind === "agent" &&
    Array.isArray(editReviewPayload.p_embedding) &&
    editReviewPayload.p_embedding.length === 1536 &&
    agentMemories.find((row) => row.id === MEMORY_PENDING_ID)?.embedding
        ?.length === 1536,
  "memory_review content edit transmits embedding and signals demotion",
);
assert(
  requests.slice(beforeEditReview).filter((entry) =>
        entry.url.includes("/rpc/agent_memory_review_tx")
      ).length === 1 &&
    !requests.slice(beforeEditReview).some((entry) =>
      entry.method === "PATCH" ||
      entry.url.includes("agent_memory_review_actions") ||
      entry.url.includes("agent_memory_relations")
    ),
  "memory_review edit uses one transactional RPC and no legacy writes",
);
const beforeFailedEditEmbedding = requests.length;
const failedEditEmbedding = await mcp("tools/call", {
  name: "memory_review",
  arguments: {
    memory_id: MEMORY_PENDING_ID,
    workspace_id: "workspace-a",
    action: "edit",
    actor_id: "agent-editor",
    content: "bad-embedding",
  },
});
assert(
  failedEditEmbedding.body?.result?.isError === true &&
    failedEditEmbedding.body.result.content[0].text.includes(
      "embedding generation failed — memory was not edited",
    ) &&
    !requests.slice(beforeFailedEditEmbedding).some((entry) =>
      entry.url.includes("/rpc/agent_memory_review_tx")
    ),
  "memory_review embedding failure performs no review RPC",
);
const outdatedReview = await mcp("tools/call", {
  name: "memory_review",
  arguments: {
    memory_id: MEMORY_PENDING_ID,
    workspace_id: "rpc-outdated-review",
    action: "edit",
    actor_id: "agent-editor",
    content: "Content edit against outdated review RPC.",
  },
});
assert(
  outdatedReview.body?.result?.isError === true &&
    outdatedReview.body.result.content[0].text.includes(
      "Agent Memory schema outdated — re-apply schemas/agent-memory",
    ),
  "memory_review rejects the legacy RPC signature without p_embedding",
);
const reviewRpcAbsent = await mcp("tools/call", {
  name: "memory_review",
  arguments: {
    memory_id: MEMORY_PENDING_ID,
    workspace_id: "rpc-absent",
    action: "reject",
    actor_id: "reviewer-3",
    notes: "Reject through an allowed non-promoting MCP action.",
  },
});
assert(
  reviewRpcAbsent.body?.result?.isError === true &&
    reviewRpcAbsent.body.result.content[0].text.includes(
      "Agent Memory transactional RPCs not installed — apply schemas/agent-memory",
    ),
  "memory_review fails closed when its transactional RPC is absent",
);

const schemaAbsent = await mcp("tools/call", {
  name: "memory_review_queue",
  arguments: { workspace_id: "schema-absent" },
});
assert(
  schemaAbsent.body?.result?.isError === true &&
    schemaAbsent.body.result.content[0].text.includes(
      "Agent Memory schema not installed — see schemas/agent-memory",
    ),
  "missing Agent Memory tables return the explicit installation error",
);

console.log("\n[4] Atomic mutation RPCs and signaled compatibility fallbacks");
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
    JSON.parse(JSON.parse(atomicCaptureRpc.body).p_embedding).length === 1536,
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
    JSON.parse(JSON.parse(entry.body).embedding).length === 1536
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
assert(
  deleted.body?.result?.isError === true &&
    deleted.body.result.content[0].text.includes(
      "soft_delete_thought RPC not installed — apply schemas/hybrid-recall before using delete_thought",
    ),
  "delete_thought fails closed with installation guidance when RPC is absent",
);
const fallbackDeleteRequests = requests.slice(beforeFallbackDelete);
assert(
  fallbackDeleteRequests.length === 1 &&
    fallbackDeleteRequests[0]?.url.includes("/rpc/soft_delete_thought"),
  "delete_thought makes no read or fallback write when RPC is absent",
);
assert(
  !fallbackDeleteRequests.some((entry) =>
    entry.method === "PATCH" || entry.method === "DELETE"
  ),
  "delete_thought absent-RPC path emits no mutation",
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
