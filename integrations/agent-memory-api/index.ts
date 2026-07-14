import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { Hono } from "npm:hono@4.9.2";
import { createClient } from "npm:@supabase/supabase-js@2.47.10";
import { z } from "npm:zod@4.1.13";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? "";
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY") ?? "";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const MAX_REQUEST_BYTES = 64 * 1024;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-brain-key",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
};

const runtimeSchema = z.object({
  name: z.string().trim().min(1).max(128).default("unknown"),
  version: z.string().trim().max(128).nullable().optional(),
});

const channelSchema = z.object({
  kind: z.string().trim().max(64).nullable().optional(),
  id: z.string().trim().max(256).nullable().optional(),
  thread_id: z.string().trim().max(256).nullable().optional(),
});

const recallSchemaVersion = z.union([
  z.literal("openbrain.agent_memory.recall.v1"),
  z.literal("openbrain.openclaw.recall.v1"),
]);

const writebackSchemaVersion = z.union([
  z.literal("openbrain.agent_memory.writeback.v1"),
  z.literal("openbrain.openclaw.writeback.v1"),
]);

const recallSchema = z.object({
  schema_version: recallSchemaVersion,
  workspace_id: z.string().trim().min(1).max(256),
  project_id: z.string().trim().max(256).nullable().optional(),
  task_id: z.string().trim().max(256).nullable().optional(),
  flow_id: z.string().trim().max(256).nullable().optional(),
  task_type: z.string().trim().max(128).nullable().optional(),
  channel: channelSchema.default({}),
  runtime: runtimeSchema.default({ name: "unknown" }),
  model_intent: z.object({
    provider: z.string().trim().max(128).nullable().optional(),
    model: z.string().trim().max(256).nullable().optional(),
  }).default({}),
  query: z.string().trim().min(1).max(8000),
  entities: z.record(z.string().max(128), z.array(z.string().max(256)).max(100)).default({}),
  scope: z.object({
    visibility: z.enum(["personal", "channel", "project", "workspace", "organization"]).nullable().optional(),
    project_only: z.boolean().default(true),
    include_unconfirmed: z.boolean().default(false),
    include_stale: z.boolean().default(false),
  }).default({ project_only: true, include_unconfirmed: false, include_stale: false }),
  limits: z.object({
    max_items: z.number().int().min(1).max(50).default(10),
    max_tokens: z.number().int().min(256).max(20000).default(4000),
    recency_days: z.number().int().positive().nullable().optional(),
  }).default({ max_items: 10, max_tokens: 4000 }),
  sensitivity: z.record(z.string(), z.boolean()).default({}),
});

const memoryPayloadSchema = z.object({
  decisions: z.array(z.string().trim().min(1).max(15000)).max(50).default([]),
  outputs: z.array(z.string().trim().min(1).max(15000)).max(50).default([]),
  lessons: z.array(z.string().trim().min(1).max(15000)).max(50).default([]),
  constraints: z.array(z.string().trim().min(1).max(15000)).max(50).default([]),
  unresolved_questions: z.array(z.string().trim().min(1).max(15000)).max(50).default([]),
  next_steps: z.array(z.string().trim().min(1).max(15000)).max(50).default([]),
  failures: z.array(z.string().trim().min(1).max(15000)).max(50).default([]),
  artifacts: z.array(z.object({
    kind: z.string().trim().min(1).max(128),
    uri: z.string().trim().min(1).max(2048),
    description: z.string().trim().max(2000).nullable().optional(),
  })).max(50).default([]),
  entities: z.record(z.string().max(128), z.array(z.string().max(256)).max(100)).default({}),
});

const writebackSchema = z.object({
  schema_version: writebackSchemaVersion,
  workspace_id: z.string().trim().min(1).max(256),
  project_id: z.string().trim().max(256).nullable().optional(),
  task_id: z.string().trim().max(256).nullable().optional(),
  flow_id: z.string().trim().max(256).nullable().optional(),
  step_id: z.string().trim().max(256).nullable().optional(),
  idempotency_key: z.string().trim().min(1).max(256),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  channel: channelSchema.default({}),
  runtime: runtimeSchema.default({ name: "unknown" }),
  models_used: z.array(z.object({
    provider: z.string().trim().min(1).max(128),
    model: z.string().trim().min(1).max(256),
    role: z.string().trim().min(1).max(128),
  })).max(20).default([]),
  source_refs: z.array(z.object({
    kind: z.string().trim().min(1).max(128),
    uri: z.string().trim().max(2048).nullable().optional(),
    title: z.string().trim().max(500).nullable().optional(),
    timestamp: z.string().datetime({ offset: true }).nullable().optional(),
  })).max(50).default([]),
  memory_payload: memoryPayloadSchema,
  provenance: z.object({
    default_status: z.enum(["observed", "inferred", "generated"]).default("generated"),
    confidence: z.number().min(0).max(1).default(0.5),
    requires_review: z.literal(true).default(true),
  }).default({ default_status: "generated", confidence: 0.5, requires_review: true }),
  retention: z.object({
    ttl_days: z.number().int().positive().nullable().optional(),
    stale_after_days: z.number().int().positive().nullable().optional(),
  }).default({}),
  visibility: z.object({
    workspace: z.string().nullable().optional(),
    project: z.string().nullable().optional(),
    channel: z.string().nullable().optional(),
  }).default({}),
});

const usageSchema = z.object({
  used_memory_ids: z.array(z.string().uuid()).max(100).default([]),
  ignored: z.array(z.object({
    memory_id: z.string().uuid(),
    reason: z.string().trim().max(1000).optional(),
  })).max(100).default([]),
});

const reviewSchemaBase = z.object({
  action: z.enum(["confirm", "edit", "evidence_only", "restrict_scope", "mark_stale", "merge", "reject", "dispute", "supersede"]),
  actor_id: z.string().trim().max(256).nullable().optional(),
  actor_label: z.string().trim().max(256).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  content: z.string().trim().min(1).max(15000).optional(),
  summary: z.string().trim().min(1).max(500).optional(),
  visibility: z.enum(["personal", "channel", "project", "workspace", "organization"]).optional(),
  related_memory_id: z.string().uuid().optional(),
});

const reviewSchema = reviewSchemaBase.superRefine((value: z.infer<typeof reviewSchemaBase>, ctx: z.RefinementCtx) => {
  if (!value.actor_id && !value.actor_label) ctx.addIssue({ code: "custom", message: "actor_id or actor_label is required", path: ["actor_id"] });
  if (["mark_stale", "merge", "reject", "dispute", "supersede"].includes(value.action) && !value.notes) ctx.addIssue({ code: "custom", message: "notes are required for lifecycle changes", path: ["notes"] });
  if (["merge", "supersede"].includes(value.action) && !value.related_memory_id) ctx.addIssue({ code: "custom", message: "related_memory_id is required", path: ["related_memory_id"] });
  if (value.action === "restrict_scope" && !value.visibility) ctx.addIssue({ code: "custom", message: "visibility is required", path: ["visibility"] });
  if (value.action === "edit" && !value.content && !value.summary) ctx.addIssue({ code: "custom", message: "content or summary is required", path: ["content"] });
});

type AgentMemory = {
  id: string;
  thought_id: string | null;
  workspace_id: string;
  project_id: string | null;
  channel_id: string | null;
  visibility: string;
  memory_type: string;
  summary: string;
  content: string;
  lifecycle_status: string;
  provenance_status: string;
  confidence: number;
  created_by: string;
  runtime_name: string | null;
  runtime_version: string | null;
  provider: string | null;
  model: string | null;
  task_id: string | null;
  flow_id: string | null;
  can_use_as_instruction: boolean;
  can_use_as_evidence: boolean;
  requires_user_confirmation: boolean;
  review_status: string;
  last_confirmed_at: string | null;
  stale_after: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
  similarity?: number;
};

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractThoughtId(value: unknown): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!isRecord(candidate)) return null;
  const rawId = candidate.id ?? candidate.thought_id;
  if (typeof rawId !== "string") return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawId) ? rawId : null;
}

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });
  if (!r.ok) throw new Error(`OpenRouter embeddings failed: ${r.status} ${await r.text()}`);
  const d = await r.json();
  return d.data[0].embedding;
}

function timingSafeEqualStrings(provided: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const providedBytes = encoder.encode(provided);
  const expectedBytes = encoder.encode(expected);
  let difference = providedBytes.byteLength ^ expectedBytes.byteLength;
  for (let index = 0; index < expectedBytes.byteLength; index++) difference |= (providedBytes[index] ?? 0) ^ expectedBytes[index];
  return difference === 0;
}

function auth(c: { req: { header: (name: string) => string | undefined } }): boolean {
  const headerKey = c.req.header("x-brain-key")?.trim();
  const bearerKey = c.req.header("authorization")?.match(/^Bearer\s+([^\s]+)\s*$/i)?.[1];
  const provided = headerKey || bearerKey;
  return Boolean(provided && MCP_ACCESS_KEY && timingSafeEqualStrings(provided, MCP_ACCESS_KEY.trim()));
}

function unsafeReasons(text: string): string[] {
  const reasons: string[] = [];
  if (/-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/.test(text)) reasons.push("private_key");
  if (/(?:sk-[A-Za-z0-9_-]{20,}|sk-or-v1-[A-Za-z0-9_-]{20,})/.test(text)) reasons.push("api_key");
  if (/(?:password|passwd|secret|token)\s*[:=]\s*\S{12,}/i.test(text)) reasons.push("credential_like_string");
  if ((text.match(/```/g) || []).length >= 4 || text.split("\n").filter((l) => l.length > 120).length > 20) reasons.push("large_code_block");
  if (text.length > 15000 || text.split("\n").filter((l) => /^(user|assistant|system|agent|human):/i.test(l.trim())).length > 8) reasons.push("raw_transcript_like");
  return reasons;
}

function staleAfter(days?: number | null): string | null {
  if (!days) return null;
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function memoryRows(payload: z.infer<typeof writebackSchema>) {
  const p = payload.memory_payload;
  const rows: { memory_type: string; content: string }[] = [];
  for (const content of p.decisions) rows.push({ memory_type: "decision", content });
  for (const content of p.outputs) rows.push({ memory_type: "output", content });
  for (const content of p.lessons) rows.push({ memory_type: "lesson", content });
  for (const content of p.constraints) rows.push({ memory_type: "constraint", content });
  for (const content of p.unresolved_questions) rows.push({ memory_type: "open_question", content });
  for (const content of p.next_steps) rows.push({ memory_type: "work_log", content: `Next step: ${content}` });
  for (const content of p.failures) rows.push({ memory_type: "failure", content });
  for (const artifact of p.artifacts) {
    rows.push({
      memory_type: "artifact_reference",
      content: `${artifact.kind}: ${artifact.description || artifact.uri}\n${artifact.uri}`,
    });
  }
  return rows;
}

function scopeMatches(memory: AgentMemory, req: z.infer<typeof recallSchema>): boolean {
  if (memory.workspace_id !== req.workspace_id) return false;
  if (req.scope.project_only && req.project_id && memory.project_id !== req.project_id) return false;
  if (["superseded", "rejected", "disputed"].includes(memory.lifecycle_status)) return false;
  if (!req.scope.include_stale && memory.lifecycle_status === "stale") return false;
  if (!req.scope.include_unconfirmed && memory.requires_user_confirmation && memory.review_status === "pending") return false;
  if (memory.visibility === "personal" && req.scope.visibility !== "personal") return false;
  if (!memory.can_use_as_instruction && !memory.can_use_as_evidence) return false;
  return true;
}

function rankMemory(memory: AgentMemory, similarity = 0): number {
  const provenance = memory.provenance_status === "user_confirmed" ? 0.3
    : memory.provenance_status === "imported" ? 0.22
    : memory.provenance_status === "observed" ? 0.15
    : memory.provenance_status === "generated" ? 0.05
    : 0;
  const policy = memory.can_use_as_instruction ? 0.2 : memory.can_use_as_evidence ? 0.08 : -0.2;
  const review = memory.review_status === "confirmed" ? 0.15
    : memory.review_status === "evidence_only" ? 0.05
    : memory.review_status === "pending" ? -0.08
    : -0.25;
  return similarity + provenance + policy + review + Number(memory.confidence || 0) * 0.15;
}

function responseMemory(memory: AgentMemory) {
  return {
    memory_id: memory.id,
    summary: memory.summary,
    content: memory.content,
    source: {
      kind: "agent_memory",
      uri: null,
      title: memory.summary,
      timestamp: memory.created_at,
    },
    provenance: {
      status: memory.provenance_status,
      confidence: Number(memory.confidence),
      created_by: memory.created_by,
      model: memory.model,
      runtime: memory.runtime_name,
    },
    scope: {
      workspace_id: memory.workspace_id,
      project_id: memory.project_id,
      channel_id: memory.channel_id,
      visibility: memory.visibility,
    },
    use_policy: {
      can_use_as_instruction: memory.can_use_as_instruction,
      can_use_as_evidence: memory.can_use_as_evidence,
      requires_user_confirmation: memory.requires_user_confirmation,
    },
    freshness: {
      created_at: memory.created_at,
      last_confirmed_at: memory.last_confirmed_at,
      stale_after: memory.stale_after,
    },
    related_artifacts: [],
  };
}

function recallResponseSchema(reqSchemaVersion: string) {
  return reqSchemaVersion === "openbrain.openclaw.recall.v1"
    ? "openbrain.openclaw.recall_response.v1"
    : "openbrain.agent_memory.recall_response.v1";
}

function writebackResponseSchema(reqSchemaVersion: string) {
  return reqSchemaVersion === "openbrain.openclaw.writeback.v1"
    ? "openbrain.openclaw.writeback_response.v1"
    : "openbrain.agent_memory.writeback_response.v1";
}

async function audit(event_type: string, payload: Record<string, unknown>) {
  const { error } = await supabase.from("agent_memory_audit_events").insert({
    event_type,
    workspace_id: payload.workspace_id ?? null,
    project_id: payload.project_id ?? null,
    memory_id: payload.memory_id ?? null,
    trace_id: payload.trace_id ?? null,
    actor_kind: payload.actor_kind ?? "system",
    actor_label: payload.actor_label ?? null,
    runtime_name: payload.runtime_name ?? null,
    task_id: payload.task_id ?? null,
    payload,
  });
  if (error) throw new Error(`Agent Memory audit insert failed: ${error.message}`);
}

const app = new Hono();

app.options("*", (c) => c.text("ok", 200, corsHeaders));

app.use("*", async (c, next) => {
  if (!MCP_ACCESS_KEY) return c.json({ error: "Service misconfigured: auth key not set" }, 503, corsHeaders);
  if (!auth(c)) return c.json({ error: "Invalid or missing access key" }, 401, corsHeaders);
  await next();
});

app.use("*", async (c, next) => {
  if (!["POST", "PATCH"].includes(c.req.method)) return next();
  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) return c.json({ error: `Request body exceeds ${MAX_REQUEST_BYTES} bytes` }, 413, corsHeaders);
  const body = await c.req.raw.clone().arrayBuffer();
  if (body.byteLength > MAX_REQUEST_BYTES) return c.json({ error: `Request body exceeds ${MAX_REQUEST_BYTES} bytes` }, 413, corsHeaders);
  await next();
});

app.onError((error, c) => {
  console.error("agent-memory-api request failed", error);
  return c.json({ error: "Internal server error" }, 500, corsHeaders);
});

app.get("/health", (c) => c.json({ ok: true, service: "agent-memory-api", version: "0.1.0" }, 200, corsHeaders));

app.post("/recall", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Request body must be valid JSON" }, 400, corsHeaders); }
  const parsed = recallSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid recall payload", details: parsed.error.flatten() }, 400, corsHeaders);
  const req = parsed.data;

  const embedding = await getEmbedding(req.query);
  const { data: matches, error: matchError } = await supabase.rpc("match_thoughts", {
    query_embedding: embedding,
    match_threshold: 0.25,
    match_count: Math.max(req.limits.max_items * 4, 20),
  });
  if (matchError) return c.json({ error: matchError.message }, 500, corsHeaders);

  const similarityByThought = new Map<string, number>();
  for (const item of matches || []) similarityByThought.set(item.id, item.similarity);
  const thoughtIds = Array.from(similarityByThought.keys());

  // Live OB1 exposes match_thoughts(query_embedding, match_threshold, match_count).
  let rawMemories: unknown[] = [];
  if (thoughtIds.length > 0) {
    const { data, error: memoryError } = await supabase.from("agent_memories").select("*").eq("workspace_id", req.workspace_id).in("thought_id", thoughtIds).order("created_at", { ascending: false }).limit(100);
    if (memoryError) return c.json({ error: memoryError.message }, 500, corsHeaders);
    rawMemories = data || [];
  }

  const ranked = ((rawMemories || []) as AgentMemory[])
    .filter((m) => scopeMatches(m, req))
    .map((m) => {
      const similarity = similarityByThought.get(m.thought_id || "") || 0;
      return { ...m, similarity, ranking_score: rankMemory(m, similarity) };
    })
    .sort((a, b) => b.ranking_score - a.ranking_score)
    .slice(0, req.limits.max_items);

  const { data: trace, error: traceError } = await supabase.from("agent_memory_recall_traces").insert({
    workspace_id: req.workspace_id,
    project_id: req.project_id ?? null,
    runtime_name: req.runtime.name,
    runtime_version: req.runtime.version ?? null,
    task_id: req.task_id ?? null,
    flow_id: req.flow_id ?? null,
    channel_kind: req.channel.kind ?? null,
    channel_id: req.channel.id ?? null,
    query: req.query,
    schema_version: req.schema_version,
    request_payload: req,
    response_policy: { max_items: req.limits.max_items, include_unconfirmed: req.scope.include_unconfirmed },
  }).select("*").single();
  if (traceError) return c.json({ error: traceError.message }, 500, corsHeaders);

  if (ranked.length > 0) {
    const { error: itemInsertError } = await supabase.from("agent_memory_recall_items").insert(ranked.map((memory, index) => ({
      trace_id: trace.id,
      memory_id: memory.id,
      rank: index + 1,
      similarity: memory.similarity,
      ranking_score: memory.ranking_score,
      use_policy_snapshot: {
        can_use_as_instruction: memory.can_use_as_instruction,
        can_use_as_evidence: memory.can_use_as_evidence,
        requires_user_confirmation: memory.requires_user_confirmation,
      },
    })));
    if (itemInsertError) return c.json({ error: itemInsertError.message }, 500, corsHeaders);
  }

  await audit("recall_requested", {
    workspace_id: req.workspace_id,
    project_id: req.project_id,
    trace_id: trace.id,
    runtime_name: req.runtime.name,
    task_id: req.task_id,
    returned_count: ranked.length,
  });
  for (const memory of ranked) await audit("memory_returned", {
    workspace_id: req.workspace_id,
    project_id: req.project_id,
    trace_id: trace.id,
    memory_id: memory.id,
    runtime_name: req.runtime.name,
    task_id: req.task_id,
    can_use_as_instruction: memory.can_use_as_instruction,
    can_use_as_evidence: memory.can_use_as_evidence,
  });

  return c.json({
    schema_version: recallResponseSchema(req.schema_version),
    request_id: trace.request_id,
    memories: ranked.map(responseMemory),
  }, 200, corsHeaders);
});

app.post("/writeback", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Request body must be valid JSON" }, 400, corsHeaders); }
  const parsed = writebackSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid write-back payload", details: parsed.error.flatten() }, 400, corsHeaders);
  const req = parsed.data;
  const rows = memoryRows(req);
  if (rows.length === 0) return c.json({ error: "memory_payload produced no memory rows" }, 400, corsHeaders);

  const requestContentHash = await sha256Hex(JSON.stringify(rows));
  if (req.content_hash && req.content_hash.toLowerCase() !== requestContentHash) return c.json({ error: "content_hash does not match the canonical memory rows" }, 409, corsHeaders);

  const unsafe = rows.flatMap((row) => unsafeReasons(row.content).map((reason) => ({ reason, memory_type: row.memory_type })));
  if (unsafe.length > 0) {
    await audit("memory_rejected", {
      workspace_id: req.workspace_id,
      project_id: req.project_id,
      runtime_name: req.runtime.name,
      task_id: req.task_id,
      actor_kind: "system",
      reason: "unsafe_writeback",
      unsafe,
    });
    return c.json({ error: "Unsafe write-back blocked", unsafe }, 422, corsHeaders);
  }

  const created = [];
  const provider = req.models_used[0]?.provider ?? null;
  const model = req.models_used[0]?.model ?? null;

  for (const [index, row] of rows.entries()) {
    const rowContentHash = await sha256Hex(`${row.memory_type}:${row.content}`);
    const idempotency_key = `${req.idempotency_key}:${index}`;

    const { data: existing, error: existingError } = await supabase
      .from("agent_memories")
      .select("*")
      .eq("workspace_id", req.workspace_id)
      .eq("idempotency_key", idempotency_key)
      .maybeSingle();
    if (existingError) return c.json({ error: existingError.message }, 500, corsHeaders);
    if (existing) {
      const existingRequestHash = isRecord(existing.metadata) ? existing.metadata.request_content_hash : null;
      const existingWritebackHash = isRecord(existing.metadata) ? existing.metadata.writeback_content_hash ?? existing.content_hash : existing.content_hash;
      if (existingWritebackHash !== rowContentHash || existingRequestHash !== requestContentHash) return c.json({ error: "Idempotency key was already used with different content" }, 409, corsHeaders);
      created.push(existing);
      continue;
    }

    const embedding = await getEmbedding(row.content);
    const { data: upsertResult, error: upsertError } = await supabase.rpc("upsert_thought", {
      p_content: row.content,
      p_payload: {
        metadata: {
          source: "agent_memory",
          source_type: "agent_memory",
          type: row.memory_type,
          topics: req.memory_payload.entities.topics || [],
          people: req.memory_payload.entities.people || [],
          agent_memory: {
            runtime: req.runtime.name,
            task_id: req.task_id,
            flow_id: req.flow_id,
            provenance_status: req.provenance.default_status,
          },
        },
      },
    });
    if (upsertError) return c.json({ error: upsertError.message }, 500, corsHeaders);

    const thoughtId = extractThoughtId(upsertResult);
    if (!thoughtId) return c.json({ error: "upsert_thought returned no UUID thought id" }, 500, corsHeaders);
    const { error: embeddingError } = await supabase.from("thoughts").update({ embedding }).eq("id", thoughtId);
    if (embeddingError) return c.json({ error: embeddingError.message }, 500, corsHeaders);

    const { data: memory, error: memoryError } = await supabase.from("agent_memories").insert({
      thought_id: thoughtId,
      workspace_id: req.workspace_id,
      project_id: req.project_id ?? null,
      channel_kind: req.channel.kind ?? null,
      channel_id: req.channel.id ?? null,
      channel_thread_id: req.channel.thread_id ?? null,
      visibility: req.project_id ? "project" : "personal",
      memory_type: row.memory_type,
      summary: row.content.replace(/\s+/g, " ").slice(0, 140),
      content: row.content,
      provenance_status: req.provenance.default_status,
      confidence: req.provenance.confidence,
      created_by: "agent",
      runtime_name: req.runtime.name,
      runtime_version: req.runtime.version ?? null,
      provider,
      model,
      task_id: req.task_id ?? null,
      flow_id: req.flow_id ?? null,
      can_use_as_instruction: false,
      can_use_as_evidence: true,
      requires_user_confirmation: true,
      review_status: "pending",
      last_confirmed_at: null,
      stale_after: staleAfter(req.retention.stale_after_days),
      idempotency_key,
      content_hash: rowContentHash,
      metadata: {
        source_refs: req.source_refs,
        models_used: req.models_used,
        retention: req.retention,
        writeback_schema_version: req.schema_version,
        request_content_hash: requestContentHash,
        writeback_content_hash: rowContentHash,
      },
    }).select("*").single();
    if (memoryError) {
      if (memoryError.code === "23505") {
        const { data: concurrent } = await supabase.from("agent_memories").select("*").eq("workspace_id", req.workspace_id).eq("idempotency_key", idempotency_key).maybeSingle();
        const concurrentRequestHash = isRecord(concurrent?.metadata) ? concurrent.metadata.request_content_hash : null;
        const concurrentWritebackHash = isRecord(concurrent?.metadata) ? concurrent.metadata.writeback_content_hash ?? concurrent?.content_hash : concurrent?.content_hash;
        if (concurrentWritebackHash === rowContentHash && concurrentRequestHash === requestContentHash) { created.push(concurrent); continue; }
        return c.json({ error: "Idempotency key was concurrently used with different content" }, 409, corsHeaders);
      }
      return c.json({ error: memoryError.message }, 500, corsHeaders);
    }

    if (req.source_refs.length > 0) {
      const { error: sourceError } = await supabase.from("agent_memory_source_refs").insert(req.source_refs.map((source: z.infer<typeof writebackSchema>["source_refs"][number]) => ({
        memory_id: memory.id,
        source_kind: source.kind,
        uri: source.uri ?? null,
        title: source.title ?? null,
        source_timestamp: source.timestamp ?? null,
      })));
      if (sourceError) return c.json({ error: sourceError.message }, 500, corsHeaders);
    }

    if (row.memory_type === "artifact_reference") {
      for (const artifact of req.memory_payload.artifacts) {
        const { error: artifactError } = await supabase.from("agent_memory_artifacts").insert({
          memory_id: memory.id,
          artifact_kind: artifact.kind,
          uri: artifact.uri,
          description: artifact.description ?? null,
        });
        if (artifactError) return c.json({ error: artifactError.message }, 500, corsHeaders);
      }
    }

    await audit("memory_written", {
      workspace_id: req.workspace_id,
      project_id: req.project_id,
      memory_id: memory.id,
      runtime_name: req.runtime.name,
      task_id: req.task_id,
      actor_kind: "agent",
      provenance_status: req.provenance.default_status,
      review_status: "pending",
    });
    created.push(memory);
  }

  return c.json({ schema_version: writebackResponseSchema(req.schema_version), memories: created.map(responseMemory) }, 200, corsHeaders);
});

app.post("/recall/:request_id/usage", async (c) => {
  const request_id = c.req.param("request_id");
  if (!z.string().uuid().safeParse(request_id).success) return c.json({ error: "Invalid request_id" }, 400, corsHeaders);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Request body must be valid JSON" }, 400, corsHeaders); }
  const parsed = usageSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid usage payload", details: parsed.error.flatten() }, 400, corsHeaders);

  const { data: trace, error } = await supabase.from("agent_memory_recall_traces").select("*").eq("request_id", request_id).single();
  if (error) return c.json({ error: error.message }, 404, corsHeaders);

  for (const memory_id of parsed.data.used_memory_ids) {
    const { data: item, error: itemError } = await supabase.from("agent_memory_recall_items").update({ used: true }).eq("trace_id", trace.id).eq("memory_id", memory_id).select("id").maybeSingle();
    if (itemError) return c.json({ error: itemError.message }, 500, corsHeaders);
    if (!item) return c.json({ error: `Memory ${memory_id} was not returned by this recall` }, 400, corsHeaders);
    await audit("memory_used", { workspace_id: trace.workspace_id, project_id: trace.project_id, trace_id: trace.id, memory_id, runtime_name: trace.runtime_name, task_id: trace.task_id });
  }
  for (const ignored of parsed.data.ignored) {
    const { data: item, error: itemError } = await supabase.from("agent_memory_recall_items").update({ used: false, ignored_reason: ignored.reason ?? null }).eq("trace_id", trace.id).eq("memory_id", ignored.memory_id).select("id").maybeSingle();
    if (itemError) return c.json({ error: itemError.message }, 500, corsHeaders);
    if (!item) return c.json({ error: `Memory ${ignored.memory_id} was not returned by this recall` }, 400, corsHeaders);
    await audit("memory_ignored", { workspace_id: trace.workspace_id, project_id: trace.project_id, trace_id: trace.id, memory_id: ignored.memory_id, reason: ignored.reason });
  }

  return c.json({ ok: true }, 200, corsHeaders);
});

app.get("/memories/review", async (c) => {
  const workspace_id = c.req.query("workspace_id");
  if (!workspace_id) return c.json({ error: "workspace_id is required" }, 400, corsHeaders);
  const project_id = c.req.query("project_id");
  let q = supabase.from("agent_memories").select("*").eq("workspace_id", workspace_id).eq("review_status", "pending").order("created_at", { ascending: false }).limit(100);
  if (project_id) q = q.eq("project_id", project_id);
  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({ memories: (data || []).map(responseMemory) }, 200, corsHeaders);
});

app.get("/memories", async (c) => {
  const workspace_id = c.req.query("workspace_id");
  if (!workspace_id) return c.json({ error: "workspace_id is required" }, 400, corsHeaders);

  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "50", 10), 1), 200);
  let q = supabase
    .from("agent_memories")
    .select("*")
    .eq("workspace_id", workspace_id)
    .order("created_at", { ascending: false })
    .limit(limit);

  const project_id = c.req.query("project_id");
  const review_status = c.req.query("review_status");
  const lifecycle_status = c.req.query("lifecycle_status");
  const runtime_name = c.req.query("runtime_name");
  const memory_type = c.req.query("memory_type");
  const task_id_prefix = c.req.query("task_id_prefix");

  if (project_id) q = q.eq("project_id", project_id);
  if (review_status) q = q.eq("review_status", review_status);
  if (lifecycle_status) q = q.eq("lifecycle_status", lifecycle_status);
  if (runtime_name) q = q.eq("runtime_name", runtime_name);
  if (memory_type) q = q.eq("memory_type", memory_type);
  if (task_id_prefix) q = q.like("task_id", `${task_id_prefix}%`);

  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({ memories: (data || []).map(responseMemory), count: data?.length || 0 }, 200, corsHeaders);
});

app.get("/memories/:id", async (c) => {
  const id = c.req.param("id");
  if (!z.string().uuid().safeParse(id).success) return c.json({ error: "Invalid memory id" }, 400, corsHeaders);
  const { data, error } = await supabase.from("agent_memories").select("*, agent_memory_source_refs(*), agent_memory_artifacts(*)").eq("id", id).single();
  if (error) return c.json({ error: error.message }, 404, corsHeaders);
  return c.json({ memory: data }, 200, corsHeaders);
});

app.patch("/memories/:id/review", async (c) => {
  const id = c.req.param("id");
  if (!z.string().uuid().safeParse(id).success) return c.json({ error: "Invalid memory id" }, 400, corsHeaders);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Request body must be valid JSON" }, 400, corsHeaders); }
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid review payload", details: parsed.error.flatten() }, 400, corsHeaders);
  const req = parsed.data;

  const { data: before, error: beforeError } = await supabase.from("agent_memories").select("*").eq("id", id).single();
  if (beforeError) return c.json({ error: beforeError.message }, 404, corsHeaders);
  if (req.related_memory_id === id) return c.json({ error: "A memory cannot be related to itself" }, 400, corsHeaders);
  if (req.related_memory_id) {
    const { data: related, error: relatedError } = await supabase.from("agent_memories").select("id").eq("id", req.related_memory_id).eq("workspace_id", before.workspace_id).maybeSingle();
    if (relatedError) return c.json({ error: relatedError.message }, 500, corsHeaders);
    if (!related) return c.json({ error: "Related memory must exist in the same workspace" }, 400, corsHeaders);
  }

  const updates: Record<string, unknown> = {};
  if (req.action === "confirm") {
    updates.review_status = "confirmed";
    updates.provenance_status = "user_confirmed";
    updates.can_use_as_instruction = true;
    updates.requires_user_confirmation = false;
    updates.last_confirmed_at = new Date().toISOString();
  } else if (req.action === "evidence_only") {
    updates.review_status = "evidence_only";
    updates.can_use_as_instruction = false;
    updates.can_use_as_evidence = true;
    updates.requires_user_confirmation = false;
  } else if (req.action === "reject") {
    updates.review_status = "rejected";
    updates.lifecycle_status = "rejected";
    updates.can_use_as_instruction = false;
    updates.can_use_as_evidence = false;
  } else if (req.action === "mark_stale") {
    updates.review_status = "stale";
    updates.lifecycle_status = "stale";
    updates.can_use_as_instruction = false;
  } else if (req.action === "dispute") {
    updates.lifecycle_status = "disputed";
    updates.provenance_status = "disputed";
    updates.can_use_as_instruction = false;
    updates.can_use_as_evidence = false;
    updates.requires_user_confirmation = true;
  } else if (req.action === "restrict_scope") {
    updates.review_status = "restricted";
    updates.visibility = req.visibility;
  } else if (req.action === "edit") {
    if (req.content) {
      const unsafe = unsafeReasons(req.content);
      if (unsafe.length > 0) return c.json({ error: "Unsafe review edit blocked", unsafe }, 422, corsHeaders);
      const embedding = await getEmbedding(req.content);
      const { data: upsertResult, error: upsertError } = await supabase.rpc("upsert_thought", { p_content: req.content, p_payload: { metadata: { source: "agent_memory_review", agent_memory_id: id } } });
      if (upsertError) return c.json({ error: upsertError.message }, 500, corsHeaders);
      const thoughtId = extractThoughtId(upsertResult);
      if (!thoughtId) return c.json({ error: "upsert_thought returned no UUID thought id" }, 500, corsHeaders);
      const { error: embeddingError } = await supabase.from("thoughts").update({ embedding }).eq("id", thoughtId);
      if (embeddingError) return c.json({ error: embeddingError.message }, 500, corsHeaders);
      updates.content = req.content;
      updates.content_hash = await sha256Hex(`${before.memory_type}:${req.content}`);
      updates.thought_id = thoughtId;
    }
    if (req.summary) updates.summary = req.summary;
  } else if (req.action === "merge") {
    Object.assign(updates, { review_status: "merged", lifecycle_status: "superseded", can_use_as_instruction: false, can_use_as_evidence: false, requires_user_confirmation: false });
  } else if (req.action === "supersede") {
    Object.assign(updates, { review_status: "stale", lifecycle_status: "superseded", can_use_as_instruction: false, can_use_as_evidence: false, requires_user_confirmation: false });
  }

  const { data: after, error: updateError } = await supabase.from("agent_memories").update(updates).eq("id", id).select("*").single();
  if (updateError) return c.json({ error: updateError.message }, 500, corsHeaders);

  const { error: reviewActionError } = await supabase.from("agent_memory_review_actions").insert({
    memory_id: id,
    action: req.action,
    actor_id: req.actor_id ?? null,
    actor_label: req.actor_label ?? null,
    notes: req.notes ?? null,
    before,
    after,
  });
  if (reviewActionError) return c.json({ error: reviewActionError.message }, 500, corsHeaders);

  if (req.related_memory_id && ["merge", "supersede"].includes(req.action)) {
    const { error: relationError } = await supabase.from("agent_memory_relations").insert({
      from_memory_id: id,
      to_memory_id: req.related_memory_id,
      relation: req.action === "merge" ? "merged_into" : "superseded_by",
      confidence: 1,
    });
    if (relationError) return c.json({ error: relationError.message }, 500, corsHeaders);
  }

  const eventMap: Record<string, string> = {
    confirm: "memory_confirmed",
    edit: "memory_edited",
    reject: "memory_rejected",
    supersede: "memory_superseded",
    dispute: "memory_disputed",
  };
  await audit(eventMap[req.action] || "memory_edited", {
    workspace_id: before.workspace_id,
    project_id: before.project_id,
    memory_id: id,
    actor_kind: "user",
    actor_label: req.actor_label ?? req.actor_id,
    action: req.action,
    notes: req.notes,
    related_memory_id: req.related_memory_id,
  });

  return c.json({ memory: after }, 200, corsHeaders);
});

app.get("/recall-traces/:request_id", async (c) => {
  const request_id = c.req.param("request_id");
  if (!z.string().uuid().safeParse(request_id).success) return c.json({ error: "Invalid request_id" }, 400, corsHeaders);
  const { data: trace, error } = await supabase.from("agent_memory_recall_traces").select("*").eq("request_id", request_id).single();
  if (error) return c.json({ error: error.message }, 404, corsHeaders);
  const { data: items, error: itemError } = await supabase.from("agent_memory_recall_items").select("*, agent_memories(*)").eq("trace_id", trace.id).order("rank");
  if (itemError) return c.json({ error: itemError.message }, 500, corsHeaders);
  return c.json({ trace, items }, 200, corsHeaders);
});

export function handler(req: Request): Response | Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/agent-memory-api") {
    url.pathname = "/";
  } else if (url.pathname.startsWith("/agent-memory-api/")) {
    url.pathname = url.pathname.slice("/agent-memory-api".length);
  }
  return app.fetch(new Request(url, req));
}

if (import.meta.main) Deno.serve(handler);
