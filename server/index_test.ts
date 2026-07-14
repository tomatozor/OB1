Deno.env.set("SUPABASE_URL", "http://127.0.0.1:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("OPENROUTER_API_KEY", "test-openrouter-key");
Deno.env.set("MCP_ACCESS_KEY", "test-mcp-key");

const {
  fuseRrf,
  isMissingDatabaseObjectError,
  isMissingEnhancedThoughtsError,
  isMissingHybridRpcError,
  isHybridThresholdSignatureError,
  isHybridWeightSignatureError,
  retrieveHybrid,
  timingSafeEqualStrings,
  validateEmbedding,
  validateRrfWeight,
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

Deno.test("RRF uses lexical-priority 2:1 defaults and supports inverted weights", () => {
  const rows = fuseRrf(
    [thought("a"), thought("b")],
    [thought("b"), thought("c")],
  );
  assert(
    rows.map((row) => row.id).join(",") === "b,c,a",
    "unexpected RRF order",
  );
  assert(
    Math.abs((rows[0].score ?? 0) - (1 / 62 + 2 / 61)) < 1e-12,
    "unexpected RRF score",
  );

  const semanticFirst = fuseRrf(
    [thought("semantic"), thought("lexical")],
    [thought("lexical"), thought("semantic")],
    60,
    1,
    0.1,
  );
  assert(
    semanticFirst[0].id === "semantic",
    "inverted weights did not promote the semantic-first result",
  );
});

Deno.test("RRF weights must be finite and strictly positive", () => {
  assert(
    validateRrfWeight("semantic_weight", 1.5) === 1.5,
    "valid weight changed",
  );
  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    let rejected = false;
    try {
      validateRrfWeight("semantic_weight", invalid);
    } catch (error) {
      rejected = String(error).includes(
        "Invalid semantic_weight: expected a finite number > 0",
      );
    }
    assert(rejected, `invalid weight was accepted: ${String(invalid)}`);
  }
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

Deno.test("auth comparison hashes values and handles different lengths", async () => {
  assert(
    await timingSafeEqualStrings("test-mcp-key", "test-mcp-key"),
    "equal keys did not match",
  );
  assert(
    !(await timingSafeEqualStrings("test-mcp-ke", "test-mcp-key")),
    "shorter key matched",
  );
  assert(
    !(await timingSafeEqualStrings("test-mcp-keyx", "test-mcp-key")),
    "longer key matched",
  );
});

Deno.test("embedding validation requires exactly 1536 finite numbers", () => {
  const valid = Array(1536).fill(0.25);
  assert(validateEmbedding(valid) === valid, "valid embedding was copied");
  for (const invalid of [valid.slice(1), [...valid.slice(0, -1), Infinity]]) {
    let rejected = false;
    try {
      validateEmbedding(invalid);
    } catch {
      rejected = true;
    }
    assert(rejected, "invalid embedding was accepted");
  }
});

Deno.test("base-schema and threshold-signature errors are narrowly classified", () => {
  assert(
    isMissingEnhancedThoughtsError({
      code: "42703",
      message: "column thoughts.quality_score does not exist",
    }),
    "undefined enhanced column was not detected",
  );
  assert(
    isMissingEnhancedThoughtsError({
      code: "PGRST204",
      message: "Could not find quality_score in the schema cache",
    }),
    "PostgREST missing enhanced column was not detected",
  );
  assert(
    isHybridWeightSignatureError({
      code: "42883",
      message:
        "function hybrid_search_thoughts(p_query, p_semantic_weight, p_text_weight) does not exist",
    }),
    "weight signature mismatch was not detected",
  );
  assert(
    !isHybridWeightSignatureError({
      code: "PGRST202",
      message: "Could not find hybrid_search_thoughts(p_query)",
    }),
    "missing hybrid RPC was misclassified as a weight mismatch",
  );
  assert(
    isHybridThresholdSignatureError({
      code: "PGRST202",
      message:
        "Could not find hybrid_search_thoughts(p_query, p_semantic_threshold)",
    }),
    "threshold signature mismatch was not detected",
  );
  assert(
    !isHybridThresholdSignatureError({
      code: "PGRST202",
      message: "Could not find hybrid_search_thoughts(p_query)",
    }),
    "missing hybrid RPC was misclassified as a threshold mismatch",
  );
});
