Deno.env.set("MCP_ACCESS_KEY", "local-smoke-access-key");
Deno.env.set("REVIEWER_ACCESS_KEY", "local-smoke-reviewer-key");
Deno.env.set("OPENROUTER_API_KEY", "local-smoke-openrouter-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "local-smoke-service-role-key");
Deno.env.set("SUPABASE_URL", "http://127.0.0.1:54321");

const {
  configureAgentMemoryTestDependencies,
  EmbeddingUpstreamError,
  handler,
} = await import(
  "../index.ts"
);
const accessKey = Deno.env.get("MCP_ACCESS_KEY");
const reviewerKey = Deno.env.get("REVIEWER_ACCESS_KEY");
const endpoint = "http://agent-memory-api.local";

function queryEmbedding() {
  return [1, ...Array(1535).fill(0)];
}

function embeddingWithSimilarity(similarity = 0.8) {
  return [
    similarity,
    Math.sqrt(Math.max(0, 1 - similarity ** 2)),
    ...Array(1534).fill(0),
  ];
}

function cosineSimilarity(left, right) {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

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
    const fault = this.store.queryFaults.get(`${this.operation}:${this.table}`);
    if (fault) return { data: null, error: structuredClone(fault) };
    if (["insert", "update"].includes(this.operation)) {
      this.store.directWrites.push({
        operation: this.operation,
        table: this.table,
      });
    }
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
    this.rpcCalls = [];
    this.directWrites = [];
    this.missingRpcs = new Set();
    this.rpcFaults = new Map();
    this.queryFaults = new Map();
    this.failReviewActionInsert = false;
    this.failBatchItemIndex = null;
    this.tables = {
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
    this.rpcCalls.push({ name, args: structuredClone(args) });
    if (this.missingRpcs.has(name)) {
      return {
        data: null,
        error: {
          code: "PGRST202",
          message: `Could not find the function public.${name}`,
        },
      };
    }
    const injected = this.rpcFaults.get(name);
    if (injected) return { data: null, error: structuredClone(injected) };
    if (name === "agent_memory_match") {
      const matches = this.tables.agent_memories
        .filter((memory) =>
          memory.workspace_id === args.p_workspace_id &&
          !["rejected", "superseded"].includes(memory.lifecycle_status) &&
          Array.isArray(memory.embedding)
        )
        .map((memory) => ({
          memory_id: memory.id,
          similarity: cosineSimilarity(
            args.p_query_embedding,
            memory.embedding,
          ),
        }))
        .filter((match) => match.similarity >= args.p_threshold)
        .sort((left, right) => right.similarity - left.similarity)
        .slice(0, args.p_limit);
      return { data: matches, error: null };
    }
    if (name === "agent_memory_writeback_batch_tx") {
      const tablesBefore = structuredClone(this.tables);
      const sequenceBefore = this.sequence;
      const rollback = (error) => {
        this.tables = tablesBefore;
        this.sequence = sequenceBefore;
        return { data: null, error };
      };
      if (!Array.isArray(args.p_items)) {
        return rollback({ code: "22023", message: "p_items must be an array" });
      }

      const results = [];
      for (const [index, item] of args.p_items.entries()) {
        if (this.failBatchItemIndex === index) {
          return rollback({
            code: "XX000",
            message: `injected batch item failure at index ${index}`,
          });
        }
        if (
          !Array.isArray(item.embedding) || item.embedding.length !== 1536 ||
          item.embedding.some((value) =>
            typeof value !== "number" || !Number.isFinite(value)
          )
        ) {
          return rollback({ code: "22023", message: "invalid item embedding" });
        }
        const existing = this.tables.agent_memories.find((memory) =>
          memory.workspace_id === args.p_workspace_id &&
          memory.idempotency_key === item.idempotency_key
        );
        if (existing) {
          if (existing.content_hash !== item.content_hash) {
            return rollback({
              code: "23505",
              message:
                "idempotency key already used with different content hash",
            });
          }
          results.push({ memory: structuredClone(existing), replayed: true });
          continue;
        }

        const now = new Date().toISOString();
        const memory = {
          id: this.uuid(),
          thought_id: null,
          workspace_id: args.p_workspace_id,
          lifecycle_status: "active",
          provenance_status: item.provenance.default_status,
          confidence: item.provenance.confidence,
          created_by: args.p_created_by || "agent",
          can_use_as_instruction: false,
          can_use_as_evidence: true,
          requires_user_confirmation: true,
          review_status: "pending",
          last_confirmed_at: null,
          idempotency_key: item.idempotency_key,
          content_hash: item.content_hash,
          created_at: now,
          ...structuredClone(item.memory),
          embedding: structuredClone(item.embedding),
        };
        delete memory.thought_payload;
        const sourceRefs = (item.source_refs || []).map((source) => ({
          id: this.uuid(),
          memory_id: memory.id,
          source_kind: source.kind,
          uri: source.uri ?? null,
          title: source.title ?? null,
          source_timestamp: source.timestamp ?? null,
        }));
        const artifacts = (item.artifacts || []).map((artifact) => ({
          id: this.uuid(),
          memory_id: memory.id,
          artifact_kind: artifact.kind,
          uri: artifact.uri,
          description: artifact.description ?? null,
        }));
        this.tables.agent_memories.push(memory);
        this.tables.agent_memory_source_refs.push(...sourceRefs);
        this.tables.agent_memory_artifacts.push(...artifacts);
        this.tables.agent_memory_audit_events.push({
          id: this.uuid(),
          event_type: "memory_written",
          workspace_id: args.p_workspace_id,
          memory_id: memory.id,
        });
        results.push({ memory: structuredClone(memory), replayed: false });
      }
      return { data: { memories: results }, error: null };
    }
    if (name === "agent_memory_review_tx") {
      if (
        ["confirm", "approve", "merge", "supersede"].includes(
          args.p_action,
        ) && args.p_actor_kind !== "human"
      ) {
        return {
          data: null,
          error: {
            code: "P0001",
            message: `${args.p_action} requires human actor`,
          },
        };
      }
      if (args.p_action === "approve") {
        args = { ...args, p_action: "confirm" };
      }
      const memory = this.tables.agent_memories.find((candidate) =>
        candidate.id === args.p_memory_id &&
        candidate.workspace_id === args.p_workspace_id
      );
      if (!memory) {
        return {
          data: null,
          error: { code: "P0001", message: "Memory not found in workspace" },
        };
      }
      const related = args.p_related_memory_id
        ? this.tables.agent_memories.find((candidate) =>
          candidate.id === args.p_related_memory_id &&
          candidate.workspace_id === args.p_workspace_id
        )
        : null;
      if (args.p_related_memory_id && !related) {
        return {
          data: null,
          error: {
            code: "P0001",
            message: "Related memory must exist in the same workspace",
          },
        };
      }

      const before = structuredClone(memory);
      const after = structuredClone(memory);
      if (["confirm", "approve"].includes(args.p_action)) {
        Object.assign(after, {
          review_status: "confirmed",
          provenance_status: "user_confirmed",
          can_use_as_instruction: true,
          requires_user_confirmation: false,
          last_confirmed_at: new Date().toISOString(),
        });
      } else if (args.p_action === "evidence_only") {
        Object.assign(after, {
          review_status: "evidence_only",
          can_use_as_instruction: false,
          can_use_as_evidence: true,
          requires_user_confirmation: false,
        });
      } else if (args.p_action === "reject") {
        Object.assign(after, {
          review_status: "rejected",
          lifecycle_status: "rejected",
          can_use_as_instruction: false,
          can_use_as_evidence: false,
        });
      } else if (args.p_action === "mark_stale") {
        Object.assign(after, {
          review_status: "stale",
          lifecycle_status: "stale",
          can_use_as_instruction: false,
        });
      } else if (args.p_action === "dispute") {
        Object.assign(after, {
          lifecycle_status: "disputed",
          provenance_status: "disputed",
          can_use_as_instruction: false,
          can_use_as_evidence: false,
          requires_user_confirmation: true,
        });
      } else if (args.p_action === "restrict_scope") {
        const rank = { workspace: 0, project: 1, channel: 2, personal: 3 };
        const invalid = rank[args.p_visibility] < rank[after.visibility] ||
          (args.p_visibility === "project" && !after.project_id) ||
          (args.p_visibility === "channel" && !after.channel_id);
        if (invalid) {
          return {
            data: null,
            error: {
              code: "P0001",
              message: "restrict_scope may only reduce the existing visibility",
            },
          };
        }
        Object.assign(after, {
          review_status: "restricted",
          visibility: args.p_visibility,
        });
      } else if (args.p_action === "edit") {
        if (args.p_content && !args.p_embedding) {
          return {
            data: null,
            error: {
              code: "22023",
              message: "embedding required when editing content",
            },
          };
        }
        if (args.p_content) after.content = args.p_content;
        if (args.p_content) after.embedding = structuredClone(args.p_embedding);
        if (args.p_summary) after.summary = args.p_summary;
        if (args.p_actor_kind === "agent") {
          Object.assign(after, {
            review_status: "pending",
            can_use_as_instruction: false,
            can_use_as_evidence: true,
            requires_user_confirmation: true,
          });
        }
      } else if (args.p_action === "merge") {
        Object.assign(after, {
          review_status: "merged",
          lifecycle_status: "superseded",
          can_use_as_instruction: false,
          can_use_as_evidence: false,
          requires_user_confirmation: false,
        });
      } else if (args.p_action === "supersede") {
        Object.assign(after, {
          review_status: "stale",
          lifecycle_status: "superseded",
          can_use_as_instruction: false,
          can_use_as_evidence: false,
          requires_user_confirmation: false,
        });
      }

      if (this.failReviewActionInsert) {
        return {
          data: null,
          error: {
            code: "XX000",
            message:
              "sensitive review action insert failure: audit partition missing",
          },
        };
      }
      Object.assign(memory, after);
      this.tables.agent_memory_review_actions.push({
        id: this.uuid(),
        memory_id: memory.id,
        action: args.p_action,
        actor_id: args.p_actor_id,
        actor_kind: args.p_actor_kind,
        notes: args.p_notes,
        before,
        after: structuredClone(after),
      });
      if (
        args.p_related_memory_id &&
        ["merge", "supersede"].includes(args.p_action)
      ) {
        this.tables.agent_memory_relations.push({
          id: this.uuid(),
          from_memory_id: memory.id,
          to_memory_id: args.p_related_memory_id,
          relation: args.p_action === "merge" ? "merged_into" : "superseded_by",
        });
      }
      this.tables.agent_memory_audit_events.push({
        id: this.uuid(),
        event_type: ["confirm", "approve"].includes(args.p_action)
          ? "memory_confirmed"
          : "memory_edited",
        workspace_id: memory.workspace_id,
        memory_id: memory.id,
      });
      return { data: { memory: structuredClone(after) }, error: null };
    }
    return { data: null, error: { message: `Unsupported mock RPC ${name}` } };
  }
}

const store = new MemoryStore();
configureAgentMemoryTestDependencies({
  supabase: store,
  getEmbedding: async () => queryEmbedding(),
});

function seedMemory(overrides = {}) {
  const now = new Date().toISOString();
  const memory = {
    id: store.uuid(),
    thought_id: null,
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
    embedding: embeddingWithSimilarity(overrides.metadata?.similarity ?? 0.8),
    idempotency_key: `seed:${store.sequence}`,
    content_hash: "a".repeat(64),
    ...overrides,
  };
  store.tables.agent_memories.push(memory);
  return memory;
}

async function api(path, options = {}) {
  const headers = {
    ...(options.auth === false ? {} : { "x-brain-key": accessKey }),
    ...(options.headers || {}),
  };
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
await expectStatus("short agent key rejected", 401, "/health", {
  headers: { "x-brain-key": accessKey.slice(0, -1) },
});
await expectStatus("long agent key rejected", 401, "/health", {
  headers: { "x-brain-key": `${accessKey}x` },
});
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

let invalidEmbeddingAttempts = 0;
configureAgentMemoryTestDependencies({
  getEmbedding: async () => {
    invalidEmbeddingAttempts += 1;
    return [0.1, 0.2];
  },
});
const shortEmbedding = await expectStatus(
  "short embedding fails closed",
  500,
  "/recall",
  {
    method: "POST",
    body: recallPayload("invalid-embedding-length"),
  },
);
assert(
  "short embedding error is generic",
  shortEmbedding.error === "Internal server error" &&
    /^[a-f0-9]{10}$/.test(shortEmbedding.correlation_id) &&
    invalidEmbeddingAttempts === 1,
);
configureAgentMemoryTestDependencies({
  getEmbedding: async () => {
    const embedding = Array(1536).fill(0.1);
    embedding[1535] = Number.POSITIVE_INFINITY;
    return embedding;
  },
});
await expectStatus("non-finite embedding fails closed", 500, "/recall", {
  method: "POST",
  body: recallPayload("invalid-embedding-number"),
});
const invalidEmbeddingRpcCount = store.rpcCalls.length;
const invalidEmbeddingMemoryCount = store.tables.agent_memories.length;
const invalidWriteback = await expectStatus(
  "invalid writeback embedding fails before RPC",
  500,
  "/writeback",
  {
    method: "POST",
    body: writebackPayload("invalid-writeback-embedding", {
      memory_payload: { lessons: ["First.", "Second.", "Third."] },
    }),
  },
);
assert(
  "invalid writeback embedding is generic and persists nothing",
  invalidWriteback.error === "Internal server error" &&
    store.rpcCalls.length === invalidEmbeddingRpcCount &&
    store.tables.agent_memories.length === invalidEmbeddingMemoryCount,
);
configureAgentMemoryTestDependencies({
  getEmbedding: async () => queryEmbedding(),
});

let transientEmbeddingAttempts = 0;
configureAgentMemoryTestDependencies({
  getEmbedding: async () => {
    transientEmbeddingAttempts += 1;
    if (transientEmbeddingAttempts < 3) {
      throw new EmbeddingUpstreamError("synthetic transient failure", true);
    }
    return queryEmbedding();
  },
});
const retriedWriteback = await expectStatus(
  "transient embedding retries then writes",
  200,
  "/writeback",
  {
    method: "POST",
    body: writebackPayload("embedding-retry"),
  },
);
const retryBatchCall = store.rpcCalls.at(-1);
assert(
  "embedding retries stop at third attempt and transmit 1536 values",
  transientEmbeddingAttempts === 3 &&
    retriedWriteback.memories.length === 1 &&
    retryBatchCall.name === "agent_memory_writeback_batch_tx" &&
    retryBatchCall.args.p_items[0].embedding.length === 1536,
);
configureAgentMemoryTestDependencies({
  getEmbedding: async () => queryEmbedding(),
});

store.missingRpcs.add("agent_memory_match");
const missingMatchRpc = await expectStatus(
  "agent_memory_match missing fails closed",
  503,
  "/recall",
  { method: "POST", body: recallPayload("missing-match-rpc") },
);
assert(
  "missing match RPC upgrade error is explicit",
  missingMatchRpc.error ===
    "agent_memory_match RPC not installed — re-apply schemas/agent-memory (upgrade)",
);
store.missingRpcs.delete("agent_memory_match");

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

const batchMemoryCountBefore = store.tables.agent_memories.length;
const batchRpcCountBefore = store.rpcCalls.length;
store.failBatchItemIndex = 1;
const failedBatch = await expectStatus(
  "three-item batch injected failure",
  500,
  "/writeback",
  {
    method: "POST",
    body: writebackPayload("batch-rollback", {
      memory_payload: { lessons: ["Batch one.", "Batch two.", "Batch three."] },
    }),
  },
);
store.failBatchItemIndex = null;
assert(
  "three-item batch is all-or-nothing through one RPC",
  failedBatch.error === "Internal server error" &&
    store.tables.agent_memories.length === batchMemoryCountBefore &&
    store.rpcCalls.slice(batchRpcCountBefore).filter((call) =>
        call.name === "agent_memory_writeback_batch_tx"
      ).length === 1,
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
const crossWorkspaceRecall = await expectStatus(
  "written embedding recall stays workspace scoped",
  200,
  "/recall",
  {
    method: "POST",
    body: recallPayload("symmetric-default-other", {
      scope: {
        include_unconfirmed: true,
        include_stale: false,
        project_only: true,
      },
    }),
  },
);
assert(
  "writeback embedding is matched only in its workspace",
  !crossWorkspaceRecall.memories.some((memory) =>
    memory.memory_id === defaultMemory.memory_id
  ),
);

const replayPayload = writebackPayload("writeback-replay", {
  idempotency_key: "writeback:fixed-replay",
  memory_payload: { lessons: ["Stable replay content."] },
});
const firstWriteback = await expectStatus(
  "writeback first commit",
  200,
  "/writeback",
  {
    method: "POST",
    body: replayPayload,
  },
);
assert(
  "writeback first commit is not replayed",
  firstWriteback.replayed === false &&
    firstWriteback.memories[0].replayed === false,
);
const replayedWriteback = await expectStatus(
  "writeback same key and hash replays",
  200,
  "/writeback",
  {
    method: "POST",
    body: replayPayload,
  },
);
assert(
  "writeback replay is explicit and returns the same memory",
  replayedWriteback.replayed === true &&
    replayedWriteback.memories[0].replayed === true &&
    replayedWriteback.memories[0].memory_id ===
      firstWriteback.memories[0].memory_id,
);
await expectStatus(
  "writeback same key with different hash conflicts",
  409,
  "/writeback",
  {
    method: "POST",
    body: {
      ...replayPayload,
      memory_payload: { lessons: ["Changed content under the same key."] },
    },
  },
);

store.missingRpcs.add("agent_memory_writeback_batch_tx");
const missingRpc = await expectStatus(
  "transactional RPC missing fails closed",
  503,
  "/writeback",
  {
    method: "POST",
    body: writebackPayload("missing-rpc", {
      idempotency_key: "writeback:missing-rpc",
    }),
  },
);
assert(
  "transactional RPC upgrade error is explicit",
  missingRpc.error ===
    "agent_memory_writeback_batch_tx RPC not installed — re-apply schemas/agent-memory (upgrade)",
);
store.missingRpcs.delete("agent_memory_writeback_batch_tx");

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

const reviewerCandidate = seedMemory({
  workspace_id: "reviewer-authority",
  review_status: "pending",
  provenance_status: "generated",
  can_use_as_instruction: false,
  requires_user_confirmation: true,
});
const reviewerRpcCountBefore = store.rpcCalls.length;
const missingReviewer = await expectStatus(
  "confirm without reviewer key",
  403,
  `/memories/${reviewerCandidate.id}/review`,
  {
    method: "PATCH",
    body: {
      workspace_id: "reviewer-authority",
      action: "confirm",
      actor_label: "local smoke",
    },
  },
);
assert(
  "confirm without reviewer key is rejected before RPC",
  missingReviewer.error === "Review action requires reviewer key" &&
    store.rpcCalls.length === reviewerRpcCountBefore,
);
configureAgentMemoryTestDependencies({ reviewerAccessKey: "" });
const reviewerNotConfigured = await expectStatus(
  "confirm when reviewer key is not configured",
  403,
  `/memories/${reviewerCandidate.id}/review`,
  {
    method: "PATCH",
    headers: { "x-reviewer-key": reviewerKey },
    body: {
      workspace_id: "reviewer-authority",
      action: "confirm",
      actor_label: "local smoke",
    },
  },
);
assert(
  "unconfigured reviewer key error is explicit",
  reviewerNotConfigured.error === "reviewer key not configured",
);
configureAgentMemoryTestDependencies({ reviewerAccessKey: reviewerKey });
await expectStatus(
  "short reviewer key rejected",
  403,
  `/memories/${reviewerCandidate.id}/review`,
  {
    method: "PATCH",
    headers: { "x-reviewer-key": reviewerKey.slice(0, -1) },
    body: {
      workspace_id: "reviewer-authority",
      action: "confirm",
      actor_label: "local smoke",
    },
  },
);
await expectStatus(
  "long reviewer key rejected",
  403,
  `/memories/${reviewerCandidate.id}/review`,
  {
    method: "PATCH",
    headers: { "x-reviewer-key": `${reviewerKey}x` },
    body: {
      workspace_id: "reviewer-authority",
      action: "confirm",
      actor_label: "local smoke",
    },
  },
);
const reviewedByHuman = await expectStatus(
  "confirm with reviewer key",
  200,
  `/memories/${reviewerCandidate.id}/review`,
  {
    method: "PATCH",
    headers: { "x-reviewer-key": reviewerKey },
    body: {
      workspace_id: "reviewer-authority",
      action: "confirm",
      actor_label: "local smoke",
    },
  },
);
assert(
  "valid reviewer key transmits human authority",
  reviewedByHuman.memory.can_use_as_instruction === true &&
    store.rpcCalls.at(-1).args.p_actor_kind === "human",
);
const editedByAgent = await expectStatus(
  "agent edit demotes confirmed memory",
  200,
  `/memories/${reviewerCandidate.id}/review`,
  {
    method: "PATCH",
    body: {
      workspace_id: "reviewer-authority",
      action: "edit",
      actor_label: "local smoke agent",
      content: "Edited agent evidence requiring renewed review.",
    },
  },
);
assert(
  "agent content edit transmits embedding and signals demotion",
  editedByAgent.memory.review_status === "pending" &&
    editedByAgent.memory.can_use_as_instruction === false &&
    editedByAgent.memory.requires_user_confirmation === true &&
    store.rpcCalls.at(-1).args.p_actor_kind === "agent" &&
    store.rpcCalls.at(-1).args.p_embedding.length === 1536 &&
    editedByAgent.memory.embedding.length === 1536,
);

const failedEditCandidate = seedMemory({
  workspace_id: "review-embedding-failure",
  content: "Content must remain unchanged after embedding failure.",
});
const failedEditRpcCallsBefore = store.rpcCalls.length;
configureAgentMemoryTestDependencies({
  getEmbedding: async () => {
    throw new Error("synthetic review embedding failure");
  },
});
const failedEdit = await expectStatus(
  "review content embedding failure aborts before RPC",
  500,
  `/memories/${failedEditCandidate.id}/review`,
  {
    method: "PATCH",
    body: {
      workspace_id: "review-embedding-failure",
      action: "edit",
      actor_label: "local smoke agent",
      content: "This edit must never be written.",
    },
  },
);
configureAgentMemoryTestDependencies({
  getEmbedding: async () => queryEmbedding(),
});
assert(
  "review embedding failure is generic and performs no write",
  failedEdit.error === "Internal server error" &&
    /^[a-f0-9]{10}$/.test(failedEdit.correlation_id) &&
    store.rpcCalls.length === failedEditRpcCallsBefore &&
    failedEditCandidate.content ===
      "Content must remain unchanged after embedding failure.",
);

const missingReviewRpcCandidate = seedMemory({
  workspace_id: "missing-review-rpc",
  review_status: "pending",
  provenance_status: "generated",
  can_use_as_instruction: false,
  requires_user_confirmation: true,
});
store.missingRpcs.add("agent_memory_review_tx");
const missingReviewRpc = await expectStatus(
  "review transactional RPC missing fails closed",
  503,
  `/memories/${missingReviewRpcCandidate.id}/review`,
  {
    method: "PATCH",
    headers: { "x-reviewer-key": reviewerKey },
    body: {
      workspace_id: "missing-review-rpc",
      action: "confirm",
      actor_label: "local smoke",
    },
  },
);
store.missingRpcs.delete("agent_memory_review_tx");
assert(
  "review missing RPC returns upgrade error without promotion",
  missingReviewRpc.error ===
      "agent_memory_review_tx RPC not installed — re-apply schemas/agent-memory (upgrade)" &&
    missingReviewRpcCandidate.review_status === "pending" &&
    missingReviewRpcCandidate.can_use_as_instruction === false,
);

const outdatedReviewCandidate = seedMemory({
  workspace_id: "outdated-review-rpc",
  content: "Pre-embedding review signature content.",
});
store.rpcFaults.set("agent_memory_review_tx", {
  code: "42883",
  message:
    "function public.agent_memory_review_tx(p_embedding => vector) does not exist",
});
const outdatedReviewRpc = await expectStatus(
  "review RPC without p_embedding signature requires schema upgrade",
  503,
  `/memories/${outdatedReviewCandidate.id}/review`,
  {
    method: "PATCH",
    body: {
      workspace_id: "outdated-review-rpc",
      action: "edit",
      actor_label: "local smoke agent",
      content: "Re-embedded edit requires the upgraded RPC.",
    },
  },
);
store.rpcFaults.delete("agent_memory_review_tx");
assert(
  "review old signature returns explicit upgrade error without mutation",
  outdatedReviewRpc.error ===
      "agent_memory_review_tx RPC not installed — re-apply schemas/agent-memory (upgrade)" &&
    outdatedReviewCandidate.content ===
      "Pre-embedding review signature content.",
);

const promotionCandidate = seedMemory({
  workspace_id: "review-fault",
  review_status: "pending",
  provenance_status: "generated",
  can_use_as_instruction: false,
  requires_user_confirmation: true,
  summary: "promotion candidate",
  content: "promotion candidate",
});
const reviewRpcCallsBefore = store.rpcCalls.length;
const directWritesBefore = store.directWrites.length;
const reviewActionsBefore = store.tables.agent_memory_review_actions.length;
store.failReviewActionInsert = true;
const failedReview = await expectStatus(
  "review action insert fault fails transaction",
  500,
  `/memories/${promotionCandidate.id}/review`,
  {
    method: "PATCH",
    headers: { "x-reviewer-key": reviewerKey },
    body: {
      workspace_id: "review-fault",
      action: "confirm",
      actor_label: "local smoke",
    },
  },
);
store.failReviewActionInsert = false;
assert(
  "review fault returns generic 500 with short correlation id",
  failedReview.error === "Internal server error" &&
    /^[a-f0-9]{10}$/.test(failedReview.correlation_id) &&
    !JSON.stringify(failedReview).includes("audit partition missing"),
);
assert(
  "review fault leaves memory evidence-only and pending",
  promotionCandidate.review_status === "pending" &&
    promotionCandidate.provenance_status === "generated" &&
    promotionCandidate.can_use_as_instruction === false &&
    promotionCandidate.requires_user_confirmation === true,
);
assert(
  "review route emits one transactional RPC and no separate write",
  store.rpcCalls.slice(reviewRpcCallsBefore).filter((call) =>
        call.name === "agent_memory_review_tx"
      ).length === 1 &&
    store.directWrites.length === directWritesBefore &&
    store.tables.agent_memory_review_actions.length === reviewActionsBefore,
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

store.queryFaults.set("insert:agent_memory_recall_traces", {
  code: "XX000",
  message: "sensitive trace storage detail",
});
const traceWriteFailure = await expectStatus(
  "recall trace failure fails closed",
  500,
  "/recall",
  {
    method: "POST",
    body: recallPayload("trace-fault"),
  },
);
assert(
  "recall trace failure is generic",
  traceWriteFailure.error === "Internal server error" &&
    /^[a-f0-9]{10}$/.test(traceWriteFailure.correlation_id) &&
    !JSON.stringify(traceWriteFailure).includes(
      "sensitive trace storage detail",
    ),
);
store.queryFaults.delete("insert:agent_memory_recall_traces");

seedMemory({
  workspace_id: "item-fault",
  summary: "item fault candidate",
  content: "item fault candidate",
});
store.queryFaults.set("insert:agent_memory_recall_items", {
  code: "XX000",
  message: "sensitive recall item storage detail",
});
const itemWriteFailure = await expectStatus(
  "recall item failure fails closed",
  500,
  "/recall",
  {
    method: "POST",
    body: recallPayload("item-fault"),
  },
);
assert(
  "recall item failure is generic",
  itemWriteFailure.error === "Internal server error" &&
    /^[a-f0-9]{10}$/.test(itemWriteFailure.correlation_id) &&
    !JSON.stringify(itemWriteFailure).includes(
      "sensitive recall item storage detail",
    ),
);
store.queryFaults.delete("insert:agent_memory_recall_items");

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

console.log("PASS local Agent Memory smoke: all checks");
