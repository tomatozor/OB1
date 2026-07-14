Deno.env.set("SUPABASE_URL", "http://127.0.0.1:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("OPENROUTER_API_KEY", "test-openrouter-key");
Deno.env.set("MCP_ACCESS_KEY", "test-mcp-key");
Deno.env.delete("MCP_CLIENT_KEYS");
Deno.env.delete("MCP_ALLOWED_ORIGINS");

const {
  authenticateRequest,
  corsHeadersForOrigin,
  fuseRrf,
  isMissingDatabaseObjectError,
  isMissingEnhancedThoughtsError,
  isMissingHybridRpcError,
  isHybridRecencySignatureError,
  isHybridThresholdSignatureError,
  isHybridWeightSignatureError,
  parseAllowedOrigins,
  parseAuthConfig,
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

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

Deno.test("RRF recency half-life promotes recent rows and is disabled by default", () => {
  const old = {
    ...thought("old"),
    created_at: new Date(Date.now() - 90 * 86_400_000).toISOString(),
  };
  const recent = {
    ...thought("recent"),
    created_at: new Date(Date.now() - 86_400_000).toISOString(),
  };
  const semantic = [old, recent];
  const text = [old, recent];

  assert(
    fuseRrf(semantic, text)[0].id === "old",
    "disabled recency changed the prior RRF order",
  );
  assert(
    fuseRrf(semantic, text, 60, 1, 2, 7)[0].id === "recent",
    "7-day half-life did not promote the recent row",
  );

  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    let rejected = false;
    try {
      validateRrfWeight("recency_half_life_days", invalid);
    } catch (error) {
      rejected = String(error).includes(
        "Invalid recency_half_life_days: expected a finite number > 0",
      );
    }
    assert(rejected, `invalid recency half-life was accepted: ${invalid}`);
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

Deno.test("multi-client auth resolves two clients and prefers the registry", async () => {
  const clientAKey = "fixture-client-a-key";
  const clientBKey = "fixture-client-b-key";
  const config = parseAuthConfig(
    JSON.stringify([
      { client_id: "client-a", key_sha256: await sha256Hex(clientAKey) },
      { client_id: "client-b", key_sha256: await sha256Hex(clientBKey) },
    ]),
    "fixture-legacy-key",
  );
  assert(config.mode === "multi-client", "registry did not take precedence");

  const clientA = await authenticateRequest(
    new Headers({ "x-brain-key": clientAKey }),
    config,
  );
  const clientB = await authenticateRequest(
    new Headers({ authorization: `Bearer ${clientBKey}` }),
    config,
  );
  const legacy = await authenticateRequest(
    new Headers({ "x-brain-key": "fixture-legacy-key" }),
    config,
  );
  assert(
    clientA.authenticated && clientA.clientId === "client-a",
    "client A was not resolved",
  );
  assert(
    clientB.authenticated && clientB.clientId === "client-b",
    "client B was not resolved",
  );
  assert(!legacy.authenticated, "registry failure fell back to the legacy key");

  const sameClientTwice = await authenticateRequest(
    new Headers({
      "x-brain-key": clientAKey,
      authorization: `Bearer ${clientAKey}`,
    }),
    config,
  );
  const conflictingClients = await authenticateRequest(
    new Headers({
      "x-brain-key": clientAKey,
      authorization: `Bearer ${clientBKey}`,
    }),
    config,
  );
  const oneKnownOneUnknown = await authenticateRequest(
    new Headers({
      "x-brain-key": clientAKey,
      authorization: "Bearer fixture-unknown-key",
    }),
    config,
  );
  assert(
    sameClientTwice.authenticated && sameClientTwice.clientId === "client-a",
    "matching dual credentials did not resolve to their client",
  );
  assert(
    !conflictingClients.authenticated,
    "credentials for different clients were accepted together",
  );
  assert(
    !oneKnownOneUnknown.authenticated,
    "a known credential masked an unknown second credential",
  );
});

Deno.test("multi-client registry rejects malformed, empty, and duplicate entries", async () => {
  const digestA = await sha256Hex("fixture-registry-key-a");
  const digestB = await sha256Hex("fixture-registry-key-b");
  const invalidRegistries = [
    "",
    "{}",
    "[]",
    JSON.stringify([{ client_id: "", key_sha256: digestA }]),
    JSON.stringify([{ client_id: "client-a", key_sha256: "not-a-digest" }]),
    JSON.stringify([{
      client_id: "client-a",
      key_sha256: digestA,
      scope: "invented",
    }]),
    JSON.stringify([
      { client_id: "client-a", key_sha256: digestA },
      { client_id: "client-a", key_sha256: digestB },
    ]),
    JSON.stringify([
      { client_id: "client-a", key_sha256: digestA },
      { client_id: "client-b", key_sha256: digestA.toUpperCase() },
    ]),
  ];
  for (const raw of invalidRegistries) {
    let message = "";
    try {
      parseAuthConfig(raw, "fixture-legacy-key");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(
      message === "Invalid MCP_CLIENT_KEYS configuration",
      "invalid registry did not fail closed with a generic error",
    );
    assert(
      !message.includes(digestA) && !message.includes("fixture-legacy-key"),
      "configuration error leaked credential material",
    );
  }
});

Deno.test("legacy-only authentication remains unchanged", async () => {
  const legacyKey = "fixture-legacy-only-key";
  const config = parseAuthConfig(undefined, legacyKey);
  assert(config.mode === "legacy", "legacy mode was not selected");
  assert(
    (await authenticateRequest(
      new Headers({ "x-brain-key": legacyKey }),
      config,
    )).authenticated,
    "legacy x-brain-key was rejected",
  );
  assert(
    (await authenticateRequest(
      new Headers({ authorization: `Bearer ${legacyKey}` }),
      config,
    )).authenticated,
    "legacy bearer key was rejected",
  );
  assert(
    !(await authenticateRequest(
      new Headers({ "x-brain-key": `${legacyKey}-unknown` }),
      config,
    )).authenticated,
    "unknown legacy key was accepted",
  );
  assert(
    !(await authenticateRequest(new Headers(), parseAuthConfig(undefined, "")))
      .authenticated,
    "empty legacy configuration did not fail closed",
  );
});

Deno.test("configured CORS is exact and absent configuration keeps wildcard", () => {
  const wildcard = corsHeadersForOrigin(
    undefined,
    parseAllowedOrigins(undefined),
  );
  assert(
    wildcard["Access-Control-Allow-Origin"] === "*" && !wildcard.Vary,
    "absent CORS configuration did not preserve wildcard behavior",
  );

  const allowedOrigins = parseAllowedOrigins(
    "https://client-a.example, https://client-b.example",
  );
  const allowed = corsHeadersForOrigin(
    "https://client-a.example",
    allowedOrigins,
  );
  const denied = corsHeadersForOrigin(
    "https://CLIENT-a.example",
    allowedOrigins,
  );
  const missing = corsHeadersForOrigin(undefined, allowedOrigins);
  assert(
    allowed["Access-Control-Allow-Origin"] === "https://client-a.example" &&
      allowed.Vary === "Origin",
    "allowed exact origin was not echoed",
  );
  assert(
    !denied["Access-Control-Allow-Origin"] && denied.Vary === "Origin",
    "denied origin received an allow-origin header",
  );
  assert(
    !missing["Access-Control-Allow-Origin"] && missing.Vary === "Origin",
    "missing origin received an allow-origin header",
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
    isHybridRecencySignatureError({
      code: "PGRST202",
      message:
        "Could not find hybrid_search_thoughts(p_query, p_recency_half_life_days) in the schema cache",
    }),
    "recency signature mismatch was not detected",
  );
  assert(
    !isHybridRecencySignatureError({
      code: "PGRST202",
      message: "Could not find hybrid_search_thoughts(p_query)",
    }),
    "missing hybrid RPC was misclassified as a recency mismatch",
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
