Deno.env.set("SUPABASE_URL", "http://127.0.0.1:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("OPENROUTER_API_KEY", "test-openrouter-key");
Deno.env.set("MCP_ACCESS_KEY", "test-mcp-key");

const {
  fuseRrf,
  isMissingDatabaseObjectError,
  isMissingHybridRpcError,
  retrieveHybrid,
} = await import("./index.ts");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function thought(id: string) {
  return {
    id,
    content: `thought ${id}`,
    metadata: {},
    created_at: "2026-07-14T00:00:00.000Z",
  };
}

Deno.test("RRF merges both rankings with k=60 and deterministic ties", () => {
  const rows = fuseRrf(
    [thought("a"), thought("b")],
    [thought("b"), thought("c")],
  );
  assert(
    rows.map((row) => row.id).join(",") === "b,a,c",
    "unexpected RRF order",
  );
  assert(
    Math.abs((rows[0].score ?? 0) - (1 / 61 + 1 / 62)) < 1e-12,
    "unexpected RRF score",
  );
});

Deno.test("hybrid retrieval calls RPC first then falls back only when absent", async () => {
  const events: string[] = [];
  const result = await retrieveHybrid(
    {
      query: "launch",
      queryEmbedding: [0.1, 0.2],
      limit: 2,
      offset: 0,
      filter: {},
      includeRestricted: false,
    },
    {
      primary: () => {
        events.push("primary");
        return Promise.resolve({
          data: null,
          error: {
            code: "PGRST202",
            message:
              "Could not find the function public.hybrid_search_thoughts in the schema cache",
          },
        });
      },
      semantic: () => {
        events.push("semantic");
        return Promise.resolve([thought("semantic"), thought("shared")]);
      },
      text: () => {
        events.push("text");
        return Promise.resolve([thought("shared"), thought("text")]);
      },
    },
  );

  assert(events[0] === "primary", "hybrid RPC was not attempted first");
  assert(
    events.includes("semantic") && events.includes("text"),
    "fallback branches did not run",
  );
  assert(result.source === "fallback", "fallback source was not reported");
  assert(
    result.rows[0].id === "shared",
    "RRF did not promote the shared result",
  );
});

Deno.test("hybrid retrieval does not mask non-missing RPC failures", async () => {
  let fallbackCalled = false;
  let rejected = false;
  try {
    await retrieveHybrid(
      {
        query: "launch",
        queryEmbedding: [0.1],
        limit: 10,
        offset: 0,
        filter: {},
        includeRestricted: false,
      },
      {
        primary: () =>
          Promise.resolve({
            data: null,
            error: { code: "42501", message: "permission denied" },
          }),
        semantic: () => {
          fallbackCalled = true;
          return Promise.resolve([]);
        },
        text: () => {
          fallbackCalled = true;
          return Promise.resolve([]);
        },
      },
    );
  } catch (error) {
    rejected = String(error).includes("permission denied");
  }
  assert(rejected, "non-missing error was not surfaced");
  assert(!fallbackCalled, "fallback masked a non-missing RPC error");
  assert(
    !isMissingHybridRpcError({ code: "42501", message: "permission denied" }),
    "permission failure was misclassified",
  );
});

Deno.test("missing database object detection accepts PostgREST and SQL absence only", () => {
  assert(
    isMissingDatabaseObjectError(
      {
        code: "PGRST202",
        message:
          "Could not find the function public.capture_thought_atomic in the schema cache",
      },
      "capture_thought_atomic",
    ),
    "PGRST202 function absence was not detected",
  );
  assert(
    isMissingDatabaseObjectError(
      {
        code: "42883",
        message:
          "function public.soft_delete_thought(uuid, text, boolean) does not exist",
      },
      "soft_delete_thought",
    ),
    "SQL function absence was not detected",
  );
  assert(
    isMissingDatabaseObjectError(
      {
        code: "PGRST205",
        message:
          "Could not find the table public.thought_edges in the schema cache",
      },
      "thought_edges",
    ),
    "PGRST205 table absence was not detected",
  );
  assert(
    !isMissingDatabaseObjectError(
      { code: "42501", message: "permission denied for thought_edges" },
      "thought_edges",
    ),
    "permission error was misclassified as an absent object",
  );
});
