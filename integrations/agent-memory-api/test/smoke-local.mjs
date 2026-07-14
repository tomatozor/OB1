Deno.env.set("MCP_ACCESS_KEY", "local-smoke-access-key");
Deno.env.set("OPENROUTER_API_KEY", "local-smoke-openrouter-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "local-smoke-service-role-key");
Deno.env.set("SUPABASE_URL", "http://127.0.0.1:54321");

const { configureAgentMemoryTestDependencies, handler } = await import(
  "../index.ts"
);
const accessKey = Deno.env.get("MCP_ACCESS_KEY");
const endpoint = "http://agent-memory-api.local";

class MemoryQuery {
  constructor(store, table) {
    this.store = store;
    this.table = table;
    this.operation = "select";
    this.filters = [];
    this.cardinality = "many";
    this.limitCount = null;
    this.orderBy = null;
  }

  select(columns = "*") {
    this.columns = columns;
    return this;
  }

  insert(values) {
    this.operation = "insert";
    this.values = Array.isArray(values) ? values : [values];
    return this;
  }

  update(values) {
    this.operation = "update";
    this.values = values;
    return this;
  }

  eq(column, value) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  in(column, values) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  like(column, pattern) {
    const prefix = pattern.endsWith("%") ? pattern.slice(0, -1) : pattern;
    this.filters.push((row) => String(row[column] || "").startsWith(prefix));
    return this;
  }

  order(column, options = {}) {
    this.orderBy = { column, ascending: options.ascending !== false };
    return this;
  }

  limit(count) {
    this.limitCount = count;
    return this;
  }

  single() {
    this.cardinality = "single";
    return this;
  }

  maybeSingle() {
    this.cardinality = "maybeSingle";
    return this;
  }

  then(resolve, reject) {
    return Promise.resolve(this.execute()).then(resolve, reject);
  }

  execute() {
    const table = this.store.tables[this.table] ||= [];
    let rows;
    if (this.operation === "insert") {
      rows = this.values.map((value) => {
        const row = structuredClone(value);
        row.id ||= this.store.uuid();
        if (this.table === "agent_memory_recall_traces") {
          row.request_id ||= this.store.uuid();
        }
        table.push(row);
        return row;
      });
    } else {
      rows = table.filter((row) => this.filters.every((filter) => filter(row)));
      if (this.operation === "update") {
        for (const row of rows) {
          Object.assign(row, structuredClone(this.values));
        }
      }
    }

    if (this.orderBy) {
      const { column, ascending } = this.orderBy;
      rows = [...rows].sort((left, right) => {
        const comparison = String(left[column] ?? "").localeCompare(
          String(right[column] ?? ""),
        );
        return ascending ? comparison : -comparison;
      });
    }
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);

    rows = rows.map((row) => {
      const result = structuredClone(row);
      if (
        this.table === "agent_memories" &&
        this.columns?.includes("agent_memory_source_refs")
      ) {
        result.agent_memory_source_refs = this.store.tables
          .agent_memory_source_refs.filter((item) => item.memory_id === row.id);
        result.agent_memory_artifacts = this.store.tables.agent_memory_artifacts
          .filter((item) => item.memory_id === row.id);
      }
      if (
        this.table === "agent_memory_recall_items" &&
        this.columns?.includes("agent_memories")
      ) {
        result.agent_memories = structuredClone(
          this.store.tables.agent_memories.find((memory) =>
            memory.id === row.memory_id
          ) || null,
        );
      }
      return result;
    });

    if (this.cardinality === "single") {
      return rows.length === 1
        ? { data: rows[0], error: null }
        : { data: null, error: { message: `Expected one ${this.table} row` } };
    }
    if (this.cardinality === "maybeSingle") {
      return rows.length <= 1 ? { data: rows[0] || null, error: null } : {
        data: null,
        error: { message: `Expected at most one ${this.table} row` },
      };
    }
    return { data: rows, error: null };
  }
}

class MemoryStore {
  constructor() {
    this.sequence = 1;
    this.tables = {
      thoughts: [],
      agent_memories: [],
      agent_memory_source_refs: [],
      agent_memory_artifacts: [],
      agent_memory_relations: [],
      agent_memory_review_actions: [],
      agent_memory_recall_traces: [],
      agent_memory_recall_items: [],
      agent_memory_audit_events: [],
    };
  }

  uuid() {
    return `00000000-0000-4000-8000-${
      String(this.sequence++).padStart(12, "0")
    }`;
  }

  from(table) {
    return new MemoryQuery(this, table);
  }

  async rpc(name, args) {
    if (name === "match_thoughts") {
      const matches = this.tables.agent_memories
        .filter((memory) => memory.thought_id)
        .map((memory) => ({
          id: memory.thought_id,
          similarity: memory.metadata?.similarity ?? 0.8,
        }))
        .slice(0, args.match_count);
      return { data: matches, error: null };
    }
    if (name === "upsert_thought") {
      const thought = {
        id: this.uuid(),
        content: args.p_content,
        embedding: null,
      };
      this.tables.thoughts.push(thought);
      return { data: thought, error: null };
    }
    return { data: null, error: { message: `Unsupported mock RPC ${name}` } };
  }
}

const store = new MemoryStore();
configureAgentMemoryTestDependencies({
  supabase: store,
  getEmbedding: async () => [0.1, 0.2, 0.3],
});

function seedMemory(overrides = {}) {
  const now = new Date().toISOString();
  const memory = {
    id: store.uuid(),
    thought_id: store.uuid(),
    workspace_id: "scope-a",
    project_id: null,
    channel_kind: null,
    channel_id: null,
    channel_thread_id: null,
    visibility: "workspace",
    memory_type: "lesson",
    summary: "Synthetic scoped memory",
    content: "Synthetic scoped memory content.",
    lifecycle_status: "active",
    provenance_status: "user_confirmed",
    confidence: 0.9,
    created_by: "agent",
    runtime_name: "runtime-alpha",
    runtime_version: "1",
    provider: "mock",
    model: "mock",
    task_id: null,
    flow_id: null,
    can_use_as_instruction: true,
    can_use_as_evidence: true,
    requires_user_confirmation: false,
    review_status: "confirmed",
    last_confirmed_at: null,
    stale_after: null,
    created_at: now,
    metadata: { similarity: 0.8 },
    idempotency_key: `seed:${store.sequence}`,
    content_hash: "a".repeat(64),
    ...overrides,
  };
  store.tables.agent_memories.push(memory);
  return memory;
}

async function api(path, options = {}) {
  const headers = options.auth === false ? {} : { "x-brain-key": accessKey };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await handler(
    new Request(`${endpoint}${path}`, {
      method: options.method || "GET",
      headers,
      body: options.rawBody ??
        (options.body === undefined ? undefined : JSON.stringify(options.body)),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function expectStatus(name, expected, path, options = {}) {
  const result = await api(path, options);
  if (result.status !== expected) {
    throw new Error(
      `${name}: expected ${expected}, got ${result.status}: ${
        JSON.stringify(result.body)
      }`,
    );
  }
  console.log(`PASS ${name}: ${result.status}`);
  return result.body;
}

function assert(name, condition) {
  if (!condition) throw new Error(`${name}: assertion failed`);
  console.log(`PASS ${name}`);
}

function recallPayload(workspaceId, overrides = {}) {
  return {
    schema_version: "openbrain.agent_memory.recall.v1",
    workspace_id: workspaceId,
    project_id: null,
    channel: {},
    runtime: { name: "runtime-alpha", version: "1" },
    query: "synthetic scoped memory",
    scope: {
      include_unconfirmed: false,
      include_stale: false,
      project_only: true,
    },
    limits: { max_items: 50, max_tokens: 4000 },
    ...overrides,
  };
}

function writebackPayload(workspaceId, overrides = {}) {
  return {
    schema_version: "openbrain.agent_memory.writeback.v1",
    workspace_id: workspaceId,
    idempotency_key: `writeback:${workspaceId}:${store.sequence}`,
    runtime: { name: "writer-runtime", version: "1" },
    memory_payload: { lessons: ["Synthetic local smoke memory."] },
    ...overrides,
  };
}

await expectStatus("missing header auth", 401, "/health", { auth: false });
await expectStatus(
  "query-only auth rejected",
  401,
  `/health?key=${accessKey}`,
  { auth: false },
);
await expectStatus("x-brain-key health", 200, "/health");
const bearer = await handler(
  new Request(`${endpoint}/health`, {
    headers: { Authorization: `Bearer ${accessKey}` },
  }),
);
assert("bearer health: 200", bearer.status === 200);
await expectStatus("writeback requires idempotency_key", 400, "/writeback", {
  method: "POST",
  body: {
    schema_version: "openbrain.agent_memory.writeback.v1",
    workspace_id: "local-smoke",
    memory_payload: { lessons: ["Synthetic local smoke memory."] },
  },
});
await expectStatus("oversized payload rejected", 413, "/writeback", {
  method: "POST",
  body: writebackPayload("local-smoke", {
    memory_payload: { lessons: ["x".repeat(70_000)] },
  }),
});
await expectStatus("malformed JSON rejected", 400, "/writeback", {
  method: "POST",
  rawBody: "{",
  body: {},
});
await expectStatus(
  "writeback rejects removed organization visibility",
  400,
  "/writeback",
  {
    method: "POST",
    body: writebackPayload("local-smoke", { visibility: "organization" }),
  },
);
await expectStatus(
  "project visibility requires project_id",
  400,
  "/writeback",
  {
    method: "POST",
    body: writebackPayload("local-smoke", { visibility: "project" }),
  },
);

const workspaceA = seedMemory({
  summary: "workspace-a",
  content: "workspace-a",
  metadata: { similarity: 0.91 },
});
const projectX = seedMemory({
  summary: "project-x",
  content: "project-x",
  visibility: "project",
  project_id: "project-x",
  metadata: { similarity: 0.90 },
});
const projectY = seedMemory({
  summary: "project-y",
  content: "project-y",
  visibility: "project",
  project_id: "project-y",
  metadata: { similarity: 0.99 },
});
const channelX = seedMemory({
  summary: "channel-x",
  content: "channel-x",
  visibility: "channel",
  project_id: "project-x",
  channel_id: "channel-x",
  metadata: { similarity: 0.89 },
});
const channelY = seedMemory({
  summary: "channel-y",
  content: "channel-y",
  visibility: "channel",
  project_id: "project-x",
  channel_id: "channel-y",
  metadata: { similarity: 0.98 },
});
const personalOwn = seedMemory({
  summary: "personal-own",
  content: "personal-own",
  visibility: "personal",
  project_id: "project-x",
  channel_id: "channel-x",
  runtime_name: "runtime-alpha",
  metadata: { similarity: 0.88 },
});
const personalOther = seedMemory({
  summary: "personal-other",
  content: "personal-other",
  visibility: "personal",
  project_id: "project-x",
  channel_id: "channel-x",
  runtime_name: "runtime-beta",
  metadata: { similarity: 0.97 },
});
const workspaceB = seedMemory({
  workspace_id: "scope-b",
  summary: "workspace-b",
  content: "workspace-b",
  metadata: { similarity: 1 },
});

const scopedRecall = await expectStatus("scoped recall", 200, "/recall", {
  method: "POST",
  body: recallPayload("scope-a", {
    project_id: "project-x",
    channel: { kind: "mock", id: "channel-x" },
  }),
});
const scopedIds = new Set(
  scopedRecall.memories.map((memory) => memory.memory_id),
);
assert(
  "workspace A never returns workspace B",
  scopedIds.has(workspaceA.id) && !scopedIds.has(workspaceB.id),
);
assert(
  "project X excludes project Y",
  scopedIds.has(projectX.id) && !scopedIds.has(projectY.id),
);
assert(
  "channel X excludes channel Y",
  scopedIds.has(channelX.id) && !scopedIds.has(channelY.id),
);
assert(
  "personal requires the same runtime",
  scopedIds.has(personalOwn.id) && !scopedIds.has(personalOther.id),
);
assert(
  "legacy project_only does not hide workspace visibility",
  scopedIds.has(workspaceA.id),
);

const defaultWriteback = await expectStatus(
  "default writeback",
  200,
  "/writeback",
  {
    method: "POST",
    body: writebackPayload("symmetric-default"),
  },
);
const defaultMemory = defaultWriteback.memories[0];
assert(
  "writeback without project defaults to workspace visibility",
  defaultMemory.scope.visibility === "workspace",
);
const defaultRecall = await expectStatus(
  "default recall sees default writeback",
  200,
  "/recall",
  {
    method: "POST",
    body: recallPayload("symmetric-default", {
      runtime: { name: "different-runtime", version: "1" },
      scope: {
        include_unconfirmed: true,
        include_stale: false,
        project_only: true,
      },
    }),
  },
);
assert(
  "writeback and recall defaults are symmetric",
  defaultRecall.memories.some((memory) =>
    memory.memory_id === defaultMemory.memory_id
  ),
);

const crossMemoryId = workspaceB.id;
await expectStatus(
  "memory by-id requires workspace_id",
  400,
  `/memories/${crossMemoryId}`,
);
await expectStatus(
  "memory by-id cross-workspace is opaque",
  404,
  `/memories/${crossMemoryId}?workspace_id=scope-a`,
);
await expectStatus(
  "memory by-id same workspace",
  200,
  `/memories/${crossMemoryId}?workspace_id=scope-b`,
);
await expectStatus(
  "review requires workspace_id",
  400,
  `/memories/${crossMemoryId}/review`,
  {
    method: "PATCH",
    body: { action: "evidence_only", actor_label: "local smoke" },
  },
);
await expectStatus(
  "review cross-workspace is opaque",
  404,
  `/memories/${crossMemoryId}/review`,
  {
    method: "PATCH",
    body: {
      workspace_id: "scope-a",
      action: "evidence_only",
      actor_label: "local smoke",
    },
  },
);

await expectStatus(
  "recall trace requires workspace_id",
  400,
  `/recall-traces/${scopedRecall.request_id}`,
);
await expectStatus(
  "recall trace cross-workspace is opaque",
  404,
  `/recall-traces/${scopedRecall.request_id}?workspace_id=scope-b`,
);
await expectStatus(
  "recall trace same workspace",
  200,
  `/recall-traces/${scopedRecall.request_id}?workspace_id=scope-a`,
);

const restrictable = seedMemory({
  visibility: "workspace",
  project_id: "project-x",
  summary: "restrictable",
  content: "restrictable",
});
await expectStatus(
  "restrict_scope reduces workspace to project",
  200,
  `/memories/${restrictable.id}/review`,
  {
    method: "PATCH",
    body: {
      workspace_id: "scope-a",
      action: "restrict_scope",
      visibility: "project",
      actor_label: "local smoke",
    },
  },
);
await expectStatus(
  "restrict_scope refuses scope expansion",
  400,
  `/memories/${restrictable.id}/review`,
  {
    method: "PATCH",
    body: {
      workspace_id: "scope-a",
      action: "restrict_scope",
      visibility: "workspace",
      actor_label: "local smoke",
    },
  },
);
assert(
  "failed restrict_scope leaves project visibility intact",
  restrictable.visibility === "project",
);

const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
const recent = seedMemory({
  workspace_id: "recency",
  summary: "recent",
  content: "recent",
  created_at: recentDate,
});
const old = seedMemory({
  workspace_id: "recency",
  summary: "old",
  content: "old",
  created_at: oldDate,
});
const reconfirmed = seedMemory({
  workspace_id: "recency",
  summary: "reconfirmed",
  content: "reconfirmed",
  created_at: oldDate,
  last_confirmed_at: recentDate,
});
const recencyRecall = await expectStatus(
  "recency_days recall",
  200,
  "/recall",
  {
    method: "POST",
    body: recallPayload("recency", {
      limits: { max_items: 50, max_tokens: 4000, recency_days: 7 },
    }),
  },
);
const recencyIds = new Set(
  recencyRecall.memories.map((memory) => memory.memory_id),
);
assert(
  "recency_days excludes old unconfirmed freshness",
  recencyIds.has(recent.id) && !recencyIds.has(old.id),
);
assert("recency_days honors last_confirmed_at", recencyIds.has(reconfirmed.id));

const budgetFirst = seedMemory({
  workspace_id: "budget",
  summary: "first",
  content: "a".repeat(700),
  metadata: { similarity: 0.95 },
});
const budgetSecond = seedMemory({
  workspace_id: "budget",
  summary: "second",
  content: "b".repeat(700),
  metadata: { similarity: 0.90 },
});
const budgetRecall = await expectStatus("max_tokens recall", 200, "/recall", {
  method: "POST",
  body: recallPayload("budget", { limits: { max_items: 50, max_tokens: 256 } }),
});
assert(
  "max_tokens keeps only the ranked prefix",
  budgetRecall.memories.length === 1 &&
    budgetRecall.memories[0].memory_id === budgetFirst.id &&
    budgetRecall.memories[0].memory_id !== budgetSecond.id,
);

const artifactCountBefore = store.tables.agent_memory_artifacts.length;
const artifactWriteback = await expectStatus(
  "artifact writeback",
  200,
  "/writeback",
  {
    method: "POST",
    body: writebackPayload("artifacts", {
      visibility: "workspace",
      memory_payload: {
        artifacts: [
          {
            kind: "report",
            uri: "repo://reports/one.md",
            description: "First report",
          },
          {
            kind: "diagram",
            uri: "repo://diagrams/two.svg",
            description: "Second diagram",
          },
        ],
      },
    }),
  },
);
const artifactMemories = artifactWriteback.memories.map((memory) =>
  memory.memory_id
);
const insertedArtifacts = store.tables.agent_memory_artifacts.slice(
  artifactCountBefore,
);
assert(
  "artifacts persist one row per reference",
  artifactMemories.length === 2 && insertedArtifacts.length === 2,
);
assert(
  "artifacts map one-to-one to their own memory",
  artifactMemories.every((memoryId) =>
    insertedArtifacts.filter((artifact) => artifact.memory_id === memoryId)
      .length === 1
  ),
);
assert(
  "artifact URIs stay attached to their own memory",
  new Set(insertedArtifacts.map((artifact) => artifact.uri)).size === 2 &&
    insertedArtifacts.every((artifact) =>
      artifactWriteback.memories.some((memory) =>
        memory.memory_id === artifact.memory_id &&
        memory.content.includes(artifact.uri)
      )
    ),
);

console.log("PASS local Agent Memory smoke: 39 checks");
