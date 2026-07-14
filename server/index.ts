import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

const OPENROUTER_BASE = Deno.env.get("OPENROUTER_BASE_URL") ||
  "https://openrouter.ai/api/v1";
const RRF_K = 60;
const AGENT_MEMORY_RUNTIME = "open-brain-mcp-v2";
const AGENT_MEMORY_SCHEMA_ERROR =
  "Agent Memory schema not installed — see schemas/agent-memory";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

type JsonObject = Record<string, unknown>;

type ThoughtRecord = {
  id: string;
  content: string;
  metadata: JsonObject | null;
  created_at: string;
  updated_at?: string | null;
  type?: string | null;
  source_type?: string | null;
  importance?: number | null;
  quality_score?: number | string | null;
  sensitivity_tier?: string | null;
  similarity?: number | null;
  score?: number | null;
  rrf_score?: number | null;
  rank?: number | null;
  total_count?: number | string | null;
};

type AgentMemoryVisibility = "workspace" | "project" | "channel" | "personal";

type AgentMemoryRecord = {
  id: string;
  thought_id: string | null;
  workspace_id: string;
  project_id: string | null;
  channel_id: string | null;
  visibility: AgentMemoryVisibility;
  memory_type: string;
  summary: string;
  content: string;
  lifecycle_status: string;
  provenance_status: string;
  confidence: number | string;
  created_by: string;
  runtime_name: string | null;
  can_use_as_instruction: boolean;
  can_use_as_evidence: boolean;
  requires_user_confirmation: boolean;
  review_status: string;
  last_confirmed_at: string | null;
  stale_after: string | null;
  idempotency_key: string;
  content_hash: string;
  metadata: JsonObject | null;
  created_at: string;
  updated_at?: string | null;
};

type AgentMemorySourceRef = {
  kind: string;
  uri?: string;
  title?: string;
  timestamp?: string;
};

type SearchFilters = {
  type?: string;
  source_type?: string;
  min_importance?: number;
  start_date?: string;
  end_date?: string;
  include_restricted: boolean;
};

type HybridSearchInput = {
  query: string;
  queryEmbedding: number[];
  limit: number;
  offset: number;
  filter: JsonObject;
  includeRestricted: boolean;
};

type HybridSearchDependencies = {
  primary: (
    input: HybridSearchInput,
  ) => Promise<{ data: unknown; error: unknown }>;
  semantic: () => Promise<ThoughtRecord[]>;
  text: () => Promise<ThoughtRecord[]>;
};

const CITATION_BASE_URL = Deno.env.get("OPEN_BRAIN_CITATION_BASE_URL") ||
  "https://openbrain.local/thoughts";

function thoughtTitle(content: string, createdAt?: string): string {
  const firstLine = content.replace(/\s+/g, " ").trim().slice(0, 80);
  const datePrefix = createdAt
    ? new Date(createdAt).toLocaleDateString()
    : "Open Brain";
  return firstLine ? `${datePrefix} - ${firstLine}` : `${datePrefix} thought`;
}

function thoughtUrl(id: string): string {
  return `${CITATION_BASE_URL.replace(/\/$/, "")}/${id}`;
}

function asMetadata(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function metadataExcerpt(metadata: unknown): JsonObject {
  const source = asMetadata(metadata);
  const excerpt: JsonObject = {};
  for (const key of ["topics", "people", "action_items"]) {
    if (Array.isArray(source[key])) excerpt[key] = source[key];
  }
  return excerpt;
}

function isDeleted(row: Pick<ThoughtRecord, "metadata">): boolean {
  const deleted = asMetadata(row.metadata).deleted;
  return deleted === true || deleted === "true";
}

function rowType(row: ThoughtRecord): string | null {
  const metadataType = asMetadata(row.metadata).type;
  return row.type ?? (typeof metadataType === "string" ? metadataType : null);
}

function rowSourceType(row: ThoughtRecord): string | null {
  const metadataSourceType = asMetadata(row.metadata).source;
  return row.source_type ??
    (typeof metadataSourceType === "string" ? metadataSourceType : null);
}

function parseDateInput(name: string, value?: string): string | undefined {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(
      `Invalid ${name}: expected a date parseable by Date.parse, received ${
        JSON.stringify(value)
      }`,
    );
  }
  return new Date(timestamp).toISOString();
}

function rowImportance(row: ThoughtRecord): number {
  const metadataImportance = asMetadata(row.metadata).importance;
  const value = row.importance ?? metadataImportance;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function matchesSearchFilters(
  row: ThoughtRecord,
  filters: SearchFilters,
): boolean {
  if (isDeleted(row)) return false;
  if (
    !filters.include_restricted &&
    row.sensitivity_tier === "restricted"
  ) return false;
  if (filters.type && rowType(row) !== filters.type) return false;
  if (filters.source_type && rowSourceType(row) !== filters.source_type) {
    return false;
  }
  if (
    filters.min_importance !== undefined &&
    rowImportance(row) < filters.min_importance
  ) return false;
  if (filters.start_date && row.created_at < filters.start_date) return false;
  if (filters.end_date && row.created_at > filters.end_date) return false;
  return true;
}

function searchScore(row: ThoughtRecord): number {
  for (const value of [row.score, row.rrf_score, row.rank, row.similarity]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function serializeSearchRow(row: ThoughtRecord): JsonObject {
  const result: JsonObject = {
    id: row.id,
    score: searchScore(row),
    date: row.created_at,
    type: rowType(row),
    metadata: metadataExcerpt(row.metadata),
    content: row.content,
  };
  if (typeof row.similarity === "number") {
    result.similarity = row.similarity;
  }
  return result;
}

function toolJson(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

async function getEmbedding(text: string): Promise<number[]> {
  const response = await fetch(`${OPENROUTER_BASE}/embeddings`, {
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
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(
      `OpenRouter embeddings failed: ${response.status} ${message}`,
    );
  }
  const body = await response.json();
  return body.data[0].embedding;
}

async function extractMetadata(text: string): Promise<JsonObject> {
  const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  const body = await response.json();
  try {
    return JSON.parse(body.choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

function errorText(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const parts = ["code", "message", "details", "hint"]
      .map((key) => (error as JsonObject)[key])
      .filter((value): value is string => typeof value === "string");
    if (parts.length) return parts.join(" ");
  }
  return String(error);
}

export function isMissingHybridRpcError(error: unknown): boolean {
  if (
    error &&
    typeof error === "object" &&
    (error as JsonObject).code === "PGRST202"
  ) return true;
  const text = errorText(error).toLowerCase();
  return text.includes("hybrid_search_thoughts") &&
    (text.includes("does not exist") ||
      text.includes("could not find the function") ||
      text.includes("schema cache"));
}

export function isMissingDatabaseObjectError(
  error: unknown,
  objectName: string,
): boolean {
  if (error && typeof error === "object") {
    const code = (error as JsonObject).code;
    if (code === "PGRST202" || code === "PGRST205") return true;
  }
  const text = errorText(error).toLowerCase();
  const normalizedName = objectName.toLowerCase();
  return text.includes(normalizedName) &&
    (text.includes("does not exist") ||
      text.includes("could not find the function") ||
      text.includes("could not find the table") ||
      text.includes("schema cache"));
}

function agentMemoryDatabaseError(
  error: unknown,
  objectName: string,
  operation: string,
): Error {
  if (isMissingDatabaseObjectError(error, objectName)) {
    return new Error(AGENT_MEMORY_SCHEMA_ERROR);
  }
  return new Error(`${operation} failed: ${errorText(error)}`);
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractThoughtId(value: unknown): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!isRecord(candidate)) return null;
  const id = candidate.id ?? candidate.thought_id;
  return typeof id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(id)
    ? id
    : null;
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

function unsafeAgentMemoryReasons(text: string): string[] {
  const reasons: string[] = [];
  if (/-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/.test(text)) {
    reasons.push("private_key");
  }
  if (/(?:sk-[A-Za-z0-9_-]{20,}|sk-or-v1-[A-Za-z0-9_-]{20,})/.test(text)) {
    reasons.push("api_key");
  }
  if (/(?:password|passwd|secret|token)\s*[:=]\s*\S{12,}/i.test(text)) {
    reasons.push("credential_like_string");
  }
  if (
    (text.match(/```/g) || []).length >= 4 ||
    text.split("\n").filter((line) => line.length > 120).length > 20
  ) {
    reasons.push("large_code_block");
  }
  if (
    text.length > 15_000 ||
    text.split("\n").filter((line) =>
        /^(user|assistant|system|agent|human):/i.test(line.trim())
      ).length > 8
  ) {
    reasons.push("raw_transcript_like");
  }
  return reasons;
}

function agentMemoryResponse(memory: AgentMemoryRecord): JsonObject {
  return {
    id: memory.id,
    memory_type: memory.memory_type,
    summary: memory.summary,
    content: memory.content,
    provenance_status: memory.provenance_status,
    can_use_as_instruction: memory.can_use_as_instruction,
    can_use_as_evidence: memory.can_use_as_evidence,
    confidence: Number(memory.confidence),
  };
}

function agentMemoryFreshness(memory: AgentMemoryRecord): number {
  const created = Date.parse(memory.created_at);
  const confirmed = memory.last_confirmed_at
    ? Date.parse(memory.last_confirmed_at)
    : Number.NEGATIVE_INFINITY;
  return Math.max(created, confirmed);
}

function agentMemoryScopeMatches(
  memory: AgentMemoryRecord,
  context: {
    workspace_id: string;
    project_id?: string;
    channel_id?: string;
    restrict_scope?: AgentMemoryVisibility;
  },
): boolean {
  if (memory.workspace_id !== context.workspace_id) return false;
  if (
    ["superseded", "rejected", "disputed", "stale"].includes(
      memory.lifecycle_status,
    )
  ) {
    return false;
  }
  if (
    memory.requires_user_confirmation && memory.review_status === "pending"
  ) return false;
  if (context.restrict_scope && memory.visibility !== context.restrict_scope) {
    return false;
  }
  if (!memory.can_use_as_instruction && !memory.can_use_as_evidence) {
    return false;
  }
  if (memory.visibility === "workspace") return true;
  if (memory.visibility === "project") {
    return Boolean(
      context.project_id && memory.project_id === context.project_id,
    );
  }
  if (memory.visibility === "channel") {
    return Boolean(
      context.channel_id && memory.channel_id === context.channel_id &&
        (!memory.project_id || memory.project_id === context.project_id),
    );
  }
  return memory.runtime_name === AGENT_MEMORY_RUNTIME &&
    (!memory.project_id || memory.project_id === context.project_id) &&
    (!memory.channel_id || memory.channel_id === context.channel_id);
}

function agentMemoryTokenCost(memory: AgentMemoryRecord): number {
  return Math.ceil((memory.summary.length + memory.content.length) / 4);
}

const agentMemoryVisibilityRank: Record<AgentMemoryVisibility, number> = {
  workspace: 0,
  project: 1,
  channel: 2,
  personal: 3,
};

function canRestrictAgentMemory(
  memory: AgentMemoryRecord,
  requested: AgentMemoryVisibility,
): boolean {
  if (
    agentMemoryVisibilityRank[requested] <
      agentMemoryVisibilityRank[memory.visibility]
  ) return false;
  if (requested === "project" && !memory.project_id) return false;
  if (requested === "channel" && !memory.channel_id) return false;
  return true;
}

async function auditAgentMemory(
  event_type: string,
  payload: JsonObject,
): Promise<void> {
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
  if (error) {
    throw agentMemoryDatabaseError(
      error,
      "agent_memory_audit_events",
      "Agent Memory audit insert",
    );
  }
}

export function fuseRrf(
  semanticRows: ThoughtRecord[],
  textRows: ThoughtRecord[],
  k = RRF_K,
): ThoughtRecord[] {
  const fused = new Map<string, { row: ThoughtRecord; score: number }>();
  for (const rows of [semanticRows, textRows]) {
    rows.forEach((row, index) => {
      const current = fused.get(row.id);
      const contribution = 1 / (k + index + 1);
      if (current) {
        current.score += contribution;
        current.row = { ...current.row, ...row };
      } else {
        fused.set(row.id, { row: { ...row }, score: contribution });
      }
    });
  }
  return [...fused.values()]
    .map(({ row, score }) => ({ ...row, score }))
    .sort((a, b) =>
      searchScore(b) - searchScore(a) || a.id.localeCompare(b.id)
    );
}

export async function retrieveHybrid(
  input: HybridSearchInput,
  dependencies: HybridSearchDependencies,
): Promise<{ rows: ThoughtRecord[]; source: "rpc" | "fallback" }> {
  const primary = await dependencies.primary(input);
  if (!primary.error) {
    return {
      rows: (primary.data ?? []) as ThoughtRecord[],
      source: "rpc",
    };
  }
  if (!isMissingHybridRpcError(primary.error)) {
    throw new Error(
      `hybrid_search_thoughts failed: ${errorText(primary.error)}`,
    );
  }

  const [semanticRows, textRows] = await Promise.all([
    dependencies.semantic(),
    dependencies.text(),
  ]);
  return {
    rows: fuseRrf(semanticRows, textRows, RRF_K).slice(
      input.offset,
      input.offset + input.limit,
    ),
    source: "fallback",
  };
}

async function hydrateRows(rows: ThoughtRecord[]): Promise<ThoughtRecord[]> {
  const ids = [...new Set(rows.map((row) => row.id).filter(Boolean))];
  if (!ids.length) return [];

  const details: ThoughtRecord[] = [];
  for (let index = 0; index < ids.length; index += 100) {
    const batch = ids.slice(index, index + 100);
    const { data, error } = await supabase
      .from("thoughts")
      .select(
        "id, content, metadata, created_at, updated_at, type, source_type, importance, quality_score, sensitivity_tier",
      )
      .in("id", batch);
    if (error) throw new Error(`thought hydration failed: ${error.message}`);
    details.push(...((data ?? []) as ThoughtRecord[]));
  }

  const byId = new Map(details.map((row) => [row.id, row]));
  return rows
    .filter((row) => byId.has(row.id))
    .map((row) => ({
      ...row,
      ...byId.get(row.id),
      similarity: row.similarity,
    }));
}

async function semanticCandidates(
  embedding: number[],
  threshold: number,
  needed: number,
  filters: SearchFilters,
): Promise<ThoughtRecord[]> {
  const filteredSearch = Boolean(
    filters.type ||
      filters.source_type ||
      filters.min_importance !== undefined ||
      filters.start_date ||
      filters.end_date ||
      !filters.include_restricted,
  );
  const matchCount = Math.min(
    1000,
    Math.max(needed + 1, filteredSearch ? (needed + 1) * 4 : needed + 20, 50),
  );
  const { data, error } = await supabase.rpc("match_thoughts", {
    query_embedding: embedding,
    match_threshold: threshold,
    match_count: matchCount,
  });
  if (error) throw new Error(`match_thoughts failed: ${error.message}`);
  const hydrated = await hydrateRows((data ?? []) as ThoughtRecord[]);
  return hydrated.filter((row) => matchesSearchFilters(row, filters));
}

async function textCandidates(
  query: string,
  needed: number,
  filters: SearchFilters,
): Promise<ThoughtRecord[]> {
  const matches: ThoughtRecord[] = [];
  let rpcOffset = 0;
  let totalCount = Number.POSITIVE_INFINITY;

  while (
    matches.length < needed && rpcOffset < totalCount && rpcOffset < 2500
  ) {
    const { data, error } = await supabase.rpc("search_thoughts_text", {
      p_query: query,
      p_limit: 100,
      p_filter: {},
      p_offset: rpcOffset,
    });
    if (error) throw new Error(`search_thoughts_text failed: ${error.message}`);
    const rows = (data ?? []) as ThoughtRecord[];
    if (!rows.length) break;
    const parsedTotal = Number(rows[0].total_count);
    if (Number.isFinite(parsedTotal)) totalCount = parsedTotal;
    matches.push(...rows.filter((row) => matchesSearchFilters(row, filters)));
    rpcOffset += rows.length;
  }

  return matches;
}

async function excludeDeletedConnections(
  rows: JsonObject[],
): Promise<JsonObject[]> {
  const ids = rows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string");
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from("thoughts")
    .select("id, metadata")
    .in("id", ids);
  if (error) throw new Error(`connection filtering failed: ${error.message}`);
  const visible = new Set(
    ((data ?? []) as Array<{ id: string; metadata: JsonObject | null }>)
      .filter((row) => !isDeleted(row))
      .map((row) => row.id),
  );
  return rows.filter((row) =>
    typeof row.id === "string" && visible.has(row.id)
  );
}

async function excludeSupersededThoughts(
  rows: ThoughtRecord[],
): Promise<ThoughtRecord[]> {
  const ids = [...new Set(rows.map((row) => row.id).filter(Boolean))];
  if (!ids.length) return [];

  const { data, error } = await supabase
    .from("thought_edges")
    .select("to_thought_id")
    .eq("relation", "supersedes")
    .is("valid_until", null)
    .in("to_thought_id", ids);
  if (error) {
    if (isMissingDatabaseObjectError(error, "thought_edges")) return rows;
    throw new Error(`supersedes filtering failed: ${error.message}`);
  }

  const superseded = new Set(
    ((data ?? []) as Array<{ to_thought_id?: string | null }>)
      .map((edge) => edge.to_thought_id)
      .filter((id): id is string => typeof id === "string"),
  );
  return superseded.size ? rows.filter((row) => !superseded.has(row.id)) : rows;
}

function searchFilterPayload(filters: SearchFilters): JsonObject {
  const payload: JsonObject = {};
  if (filters.type) payload.type = filters.type;
  if (filters.source_type) payload.source_type = filters.source_type;
  if (filters.min_importance !== undefined) {
    payload.min_importance = filters.min_importance;
  }
  if (filters.start_date) payload.start_date = filters.start_date;
  if (filters.end_date) payload.end_date = filters.end_date;
  return payload;
}

async function runSearch(params: {
  query: string;
  mode: "hybrid" | "semantic" | "text";
  limit: number;
  offset: number;
  threshold: number;
  filters: SearchFilters;
}): Promise<JsonObject> {
  const pageSize = params.limit + 1;
  const needed = params.offset + pageSize;
  let rows: ThoughtRecord[];
  let source: string = params.mode;

  if (params.mode === "text") {
    rows = (await textCandidates(params.query, needed, params.filters)).slice(
      params.offset,
      params.offset + pageSize,
    );
  } else {
    const embedding = await getEmbedding(params.query);
    if (params.mode === "semantic") {
      rows = (
        await semanticCandidates(
          embedding,
          params.threshold,
          needed,
          params.filters,
        )
      ).slice(params.offset, params.offset + pageSize);
    } else {
      const candidateCount = Math.min(
        1000,
        Math.max((needed + 1) * 4, 100),
      );
      const hybrid = await retrieveHybrid(
        {
          query: params.query,
          queryEmbedding: embedding,
          limit: pageSize,
          offset: params.offset,
          filter: searchFilterPayload(params.filters),
          includeRestricted: params.filters.include_restricted,
        },
        {
          primary: async (input) =>
            await supabase.rpc("hybrid_search_thoughts", {
              p_query: input.query,
              p_query_embedding: input.queryEmbedding,
              p_limit: input.limit,
              p_offset: input.offset,
              p_filter: input.filter,
              p_include_restricted: input.includeRestricted,
              p_rrf_k: RRF_K,
            }),
          semantic: async () =>
            await semanticCandidates(
              embedding,
              params.threshold,
              candidateCount,
              params.filters,
            ),
          text: async () =>
            await textCandidates(params.query, candidateCount, params.filters),
        },
      );
      rows = await hydrateRows(hybrid.rows);
      source = hybrid.source === "rpc" ? "hybrid_rpc" : "hybrid_rrf_fallback";
    }
  }

  rows = rows.filter((row) => matchesSearchFilters(row, params.filters));
  const page = rows.slice(0, params.limit);
  return {
    mode: params.mode,
    source,
    results: page.map(serializeSearchRow),
    pagination: {
      offset: params.offset,
      limit: params.limit,
      returned: page.length,
      has_more: rows.length > params.limit,
    },
  };
}

function registerAgentMemoryTools(server: McpServer): void {
  const visibilitySchema = z.enum([
    "workspace",
    "project",
    "channel",
    "personal",
  ]);
  const memoryTypeSchema = z.enum([
    "decision",
    "output",
    "lesson",
    "constraint",
    "open_question",
    "failure",
    "artifact_reference",
    "work_log",
  ]);
  const sourceRefSchema = z.object({
    kind: z.string().trim().min(1).max(128),
    uri: z.string().trim().max(2048).optional(),
    title: z.string().trim().max(500).optional(),
    timestamp: z.string().datetime({ offset: true }).optional(),
  });

  server.registerTool(
    "memory_recall",
    {
      title: "Recall Governed Agent Memory",
      description:
        "Recall strictly scoped Agent Memory records. A non-empty query uses match_thoughts semantic candidates; otherwise results use confidence/freshness/id deterministic ordering. Every response is traced.",
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        workspace_id: z.string().trim().min(1).max(256),
        query: z.string().trim().min(1).max(8_000).optional(),
        project_id: z.string().trim().min(1).max(256).optional(),
        channel_id: z.string().trim().min(1).max(256).optional(),
        task_type: z.string().trim().min(1).max(128).optional(),
        entities: z.record(
          z.string().max(128),
          z.array(z.string().max(256)).max(100),
        ).optional(),
        limits: z.object({
          max_results: z.number().int().min(1).max(50).default(10).optional(),
          recency_days: z.number().int().min(1).max(3650).optional(),
          max_tokens: z.number().int().min(256).max(20_000).default(4_000)
            .optional(),
        }).optional(),
        restrict_scope: visibilitySchema.optional(),
      },
    },
    async ({
      workspace_id,
      query,
      project_id,
      channel_id,
      task_type,
      entities,
      limits,
      restrict_scope,
    }) => {
      try {
        const maxResults = limits?.max_results ?? 10;
        const maxTokens = limits?.max_tokens ?? 4_000;
        const similarityByThought = new Map<string, number>();
        let thoughtIds: string[] | null = null;

        if (query) {
          const semanticText = [
            query,
            task_type ? `Task type: ${task_type}` : "",
            ...Object.entries(entities ?? {}).flatMap(([kind, values]) =>
              values.map((value) => `${kind}: ${value}`)
            ),
          ].filter(Boolean).join("\n");
          const embedding = await getEmbedding(semanticText);
          const { data, error } = await supabase.rpc("match_thoughts", {
            query_embedding: embedding,
            match_threshold: 0.25,
            match_count: Math.max(maxResults * 8, 50),
          });
          if (error) {
            throw new Error(`match_thoughts failed: ${error.message}`);
          }
          for (const row of (data ?? []) as Array<JsonObject>) {
            if (typeof row.id === "string") {
              similarityByThought.set(row.id, Number(row.similarity ?? 0));
            }
          }
          thoughtIds = [...similarityByThought.keys()];
        }

        let memoryQuery = supabase
          .from("agent_memories")
          .select("*")
          .eq("workspace_id", workspace_id)
          .order("confidence", { ascending: false })
          .order("last_confirmed_at", {
            ascending: false,
            nullsFirst: false,
          })
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .limit(1_000);
        if (thoughtIds) {
          memoryQuery = thoughtIds.length
            ? memoryQuery.in("thought_id", thoughtIds)
            : memoryQuery.eq(
              "thought_id",
              "00000000-0000-4000-8000-000000000000",
            );
        }
        const { data: rawMemories, error: memoryError } = await memoryQuery;
        if (memoryError) {
          throw agentMemoryDatabaseError(
            memoryError,
            "agent_memories",
            "Agent Memory recall",
          );
        }

        const recencyCutoff = limits?.recency_days
          ? Date.now() - limits.recency_days * 86_400_000
          : Number.NEGATIVE_INFINITY;
        const ranked = ((rawMemories ?? []) as AgentMemoryRecord[])
          .filter((memory) =>
            agentMemoryScopeMatches(memory, {
              workspace_id,
              project_id,
              channel_id,
              restrict_scope,
            })
          )
          .filter((memory) => agentMemoryFreshness(memory) >= recencyCutoff)
          .sort((left, right) => {
            if (query) {
              const similarity =
                (similarityByThought.get(right.thought_id ?? "") ?? 0) -
                (similarityByThought.get(left.thought_id ?? "") ?? 0);
              if (similarity) return similarity;
            }
            return Number(right.confidence) - Number(left.confidence) ||
              agentMemoryFreshness(right) - agentMemoryFreshness(left) ||
              left.id.localeCompare(right.id);
          });

        const selected: AgentMemoryRecord[] = [];
        let selectedTokens = 0;
        for (const memory of ranked) {
          if (selected.length >= maxResults) break;
          const cost = agentMemoryTokenCost(memory);
          if (selectedTokens + cost > maxTokens) break;
          selected.push(memory);
          selectedTokens += cost;
        }

        const requestPayload = {
          workspace_id,
          query: query ?? null,
          project_id: project_id ?? null,
          channel_id: channel_id ?? null,
          task_type: task_type ?? null,
          entities: entities ?? {},
          limits: {
            max_results: maxResults,
            recency_days: limits?.recency_days ?? null,
            max_tokens: maxTokens,
          },
          restrict_scope: restrict_scope ?? null,
        };
        const { data: trace, error: traceError } = await supabase
          .from("agent_memory_recall_traces")
          .insert({
            workspace_id,
            project_id: project_id ?? null,
            runtime_name: AGENT_MEMORY_RUNTIME,
            channel_id: channel_id ?? null,
            query: query ?? "",
            schema_version: "openbrain.agent_memory.mcp_recall.v1",
            request_payload: requestPayload,
            response_policy: {
              ranking: query
                ? "semantic_then_confidence_freshness_id"
                : "confidence_freshness_id",
              max_results: maxResults,
              max_tokens: maxTokens,
              recency_days: limits?.recency_days ?? null,
              token_estimate: "ceil((summary_chars + content_chars) / 4)",
            },
          })
          .select("*")
          .single();
        if (traceError || !trace) {
          throw agentMemoryDatabaseError(
            traceError,
            "agent_memory_recall_traces",
            "Agent Memory recall trace insert",
          );
        }

        if (selected.length) {
          const { error } = await supabase
            .from("agent_memory_recall_items")
            .insert(selected.map((memory, index) => ({
              trace_id: trace.id,
              memory_id: memory.id,
              rank: index + 1,
              similarity: query
                ? similarityByThought.get(memory.thought_id ?? "") ?? 0
                : null,
              ranking_score: query
                ? similarityByThought.get(memory.thought_id ?? "") ?? 0
                : Number(memory.confidence),
              use_policy_snapshot: {
                can_use_as_instruction: memory.can_use_as_instruction,
                can_use_as_evidence: memory.can_use_as_evidence,
                requires_user_confirmation: memory.requires_user_confirmation,
              },
            })));
          if (error) {
            throw agentMemoryDatabaseError(
              error,
              "agent_memory_recall_items",
              "Agent Memory recall item insert",
            );
          }
        }

        await auditAgentMemory("recall_requested", {
          workspace_id,
          project_id: project_id ?? null,
          trace_id: trace.id,
          runtime_name: AGENT_MEMORY_RUNTIME,
          returned_count: selected.length,
        });
        for (const memory of selected) {
          await auditAgentMemory("memory_returned", {
            workspace_id,
            project_id: project_id ?? null,
            trace_id: trace.id,
            memory_id: memory.id,
            runtime_name: AGENT_MEMORY_RUNTIME,
            can_use_as_instruction: memory.can_use_as_instruction,
            can_use_as_evidence: memory.can_use_as_evidence,
          });
        }

        return toolJson({
          request_id: trace.request_id,
          memories: selected.map(agentMemoryResponse),
        });
      } catch (error) {
        return toolError(`memory_recall error: ${(error as Error).message}`);
      }
    },
  );

  const writebackInput = z.object({
    workspace_id: z.string().trim().min(1).max(256),
    idempotency_key: z.string().trim().min(1).max(256),
    memory: z.object({
      type: memoryTypeSchema,
      summary: z.string().trim().min(1).max(500),
      content: z.string().trim().min(1).max(15_000),
      visibility: visibilitySchema.optional(),
      project_id: z.string().trim().min(1).max(256).optional(),
      channel_id: z.string().trim().min(1).max(256).optional(),
    }),
    provenance: z.object({
      status: z.enum(["observed", "inferred", "generated"]),
      source_refs: z.array(sourceRefSchema).max(50).optional(),
    }),
    created_by: z.enum(["user", "agent", "system", "import"]).default("agent")
      .optional(),
  }).superRefine((value, context) => {
    if (value.memory.visibility === "project" && !value.memory.project_id) {
      context.addIssue({
        code: "custom",
        message: "project visibility requires memory.project_id",
        path: ["memory", "visibility"],
      });
    }
    if (value.memory.visibility === "channel" && !value.memory.channel_id) {
      context.addIssue({
        code: "custom",
        message: "channel visibility requires memory.channel_id",
        path: ["memory", "visibility"],
      });
    }
  });

  server.registerTool(
    "memory_writeback",
    {
      title: "Write Governed Agent Memory",
      description:
        "Write one evidence-only pending Agent Memory record with workspace-scoped idempotency and an audit event.",
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: writebackInput.shape,
    },
    async ({
      workspace_id,
      idempotency_key,
      memory,
      provenance,
      created_by = "agent",
    }) => {
      try {
        if (memory.visibility === "project" && !memory.project_id) {
          return toolError(
            "memory_writeback error: project visibility requires memory.project_id",
          );
        }
        if (memory.visibility === "channel" && !memory.channel_id) {
          return toolError(
            "memory_writeback error: channel visibility requires memory.channel_id",
          );
        }
        const visibility = memory.visibility ??
          (memory.channel_id
            ? "channel"
            : memory.project_id
            ? "project"
            : "workspace");
        const sourceRefs =
          (provenance.source_refs ?? []) as AgentMemorySourceRef[];
        const canonicalContent = JSON.stringify({
          memory_type: memory.type,
          summary: memory.summary,
          content: memory.content,
          visibility,
          project_id: memory.project_id ?? null,
          channel_id: memory.channel_id ?? null,
          provenance_status: provenance.status,
          source_refs: sourceRefs,
          created_by,
        });
        const writebackHash = await sha256Hex(canonicalContent);
        const existingResult = await supabase
          .from("agent_memories")
          .select("*")
          .eq("workspace_id", workspace_id)
          .eq("idempotency_key", idempotency_key)
          .maybeSingle();
        if (existingResult.error) {
          throw agentMemoryDatabaseError(
            existingResult.error,
            "agent_memories",
            "Agent Memory idempotency lookup",
          );
        }
        if (existingResult.data) {
          const existing = existingResult.data as AgentMemoryRecord;
          const metadata = asMetadata(existing.metadata);
          const priorHash = metadata.writeback_content_hash ??
            existing.content_hash;
          if (priorHash !== writebackHash) {
            return toolError(
              "memory_writeback error: Idempotency key was already used with different content",
            );
          }
          return toolJson({
            memory: agentMemoryResponse(existing),
            idempotent_replay: true,
          });
        }

        const unsafe = [memory.summary, memory.content].flatMap((text) =>
          unsafeAgentMemoryReasons(text)
        );
        if (unsafe.length) {
          await auditAgentMemory("memory_rejected", {
            workspace_id,
            project_id: memory.project_id ?? null,
            actor_kind: "system",
            reason: "unsafe_writeback",
            unsafe: [...new Set(unsafe)],
          });
          return toolError(
            `memory_writeback error: Unsafe write-back blocked: ${
              [...new Set(unsafe)].join(", ")
            }`,
          );
        }

        const embedding = await getEmbedding(memory.content);
        const { data: thoughtResult, error: thoughtError } = await supabase.rpc(
          "upsert_thought",
          {
            p_content: memory.content,
            p_payload: {
              metadata: {
                source: "agent_memory",
                source_type: "agent_memory",
                type: memory.type,
                agent_memory: {
                  runtime: AGENT_MEMORY_RUNTIME,
                  provenance_status: provenance.status,
                },
              },
            },
          },
        );
        if (thoughtError) {
          throw new Error(`upsert_thought failed: ${thoughtError.message}`);
        }
        const thoughtId = extractThoughtId(thoughtResult);
        if (!thoughtId) {
          throw new Error("upsert_thought returned no UUID thought id");
        }
        const embeddingResult = await supabase
          .from("thoughts")
          .update({ embedding: `[${embedding.join(",")}]` })
          .eq("id", thoughtId);
        if (embeddingResult.error) {
          throw new Error(
            `Agent Memory thought embedding update failed: ${embeddingResult.error.message}`,
          );
        }

        const insertPayload = {
          thought_id: thoughtId,
          workspace_id,
          project_id: memory.project_id ?? null,
          channel_id: memory.channel_id ?? null,
          visibility,
          memory_type: memory.type,
          summary: memory.summary,
          content: memory.content,
          provenance_status: provenance.status,
          confidence: 0.5,
          created_by,
          runtime_name: AGENT_MEMORY_RUNTIME,
          can_use_as_instruction: false,
          can_use_as_evidence: true,
          requires_user_confirmation: true,
          review_status: "pending",
          last_confirmed_at: null,
          idempotency_key,
          content_hash: writebackHash,
          metadata: {
            source_refs: sourceRefs,
            writeback_schema_version: "openbrain.agent_memory.mcp_writeback.v1",
            writeback_content_hash: writebackHash,
          },
        };
        const inserted = await supabase.from("agent_memories")
          .insert(insertPayload)
          .select("*")
          .single();
        if (inserted.error || !inserted.data) {
          if ((inserted.error as JsonObject | null)?.code === "23505") {
            const concurrent = await supabase.from("agent_memories")
              .select("*")
              .eq("workspace_id", workspace_id)
              .eq("idempotency_key", idempotency_key)
              .maybeSingle();
            if (concurrent.error) {
              throw agentMemoryDatabaseError(
                concurrent.error,
                "agent_memories",
                "Agent Memory concurrent idempotency lookup",
              );
            }
            if (concurrent.data) {
              const concurrentMemory = concurrent.data as AgentMemoryRecord;
              const priorHash = asMetadata(concurrentMemory.metadata)
                .writeback_content_hash ?? concurrentMemory.content_hash;
              if (priorHash === writebackHash) {
                return toolJson({
                  memory: agentMemoryResponse(concurrentMemory),
                  idempotent_replay: true,
                });
              }
            }
            return toolError(
              "memory_writeback error: Idempotency key was concurrently used with different content",
            );
          }
          throw agentMemoryDatabaseError(
            inserted.error,
            "agent_memories",
            "Agent Memory insert",
          );
        }
        const created = inserted.data as AgentMemoryRecord;

        if (sourceRefs.length) {
          const { error } = await supabase.from("agent_memory_source_refs")
            .insert(sourceRefs.map((source) => ({
              memory_id: created.id,
              source_kind: source.kind,
              uri: source.uri ?? null,
              title: source.title ?? null,
              source_timestamp: source.timestamp ?? null,
            })));
          if (error) {
            throw agentMemoryDatabaseError(
              error,
              "agent_memory_source_refs",
              "Agent Memory source reference insert",
            );
          }
        }

        await auditAgentMemory("memory_written", {
          workspace_id,
          project_id: memory.project_id ?? null,
          memory_id: created.id,
          runtime_name: AGENT_MEMORY_RUNTIME,
          actor_kind: created_by,
          provenance_status: provenance.status,
          review_status: "pending",
        });
        return toolJson({
          memory: agentMemoryResponse(created),
          idempotent_replay: false,
        });
      } catch (error) {
        return toolError(`memory_writeback error: ${(error as Error).message}`);
      }
    },
  );

  server.registerTool(
    "memory_usage_report",
    {
      title: "Report Agent Memory Usage",
      description:
        "Mark only memories returned by a recall trace as used or ignored.",
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        request_id: z.string().uuid(),
        used_memory_ids: z.array(z.string().uuid()).max(100),
        ignored: z.array(z.object({
          memory_id: z.string().uuid(),
          reason: z.string().trim().max(1_000).optional(),
        })).max(100).optional(),
      },
    },
    async ({ request_id, used_memory_ids, ignored = [] }) => {
      try {
        const traceResult = await supabase
          .from("agent_memory_recall_traces")
          .select("*")
          .eq("request_id", request_id)
          .maybeSingle();
        if (traceResult.error) {
          throw agentMemoryDatabaseError(
            traceResult.error,
            "agent_memory_recall_traces",
            "Agent Memory recall trace lookup",
          );
        }
        if (!traceResult.data) {
          return toolError(
            `memory_usage_report error: Recall trace ${request_id} not found`,
          );
        }
        const trace = traceResult.data as JsonObject;
        const itemResult = await supabase
          .from("agent_memory_recall_items")
          .select("id, memory_id")
          .eq("trace_id", trace.id as string);
        if (itemResult.error) {
          throw agentMemoryDatabaseError(
            itemResult.error,
            "agent_memory_recall_items",
            "Agent Memory recall item lookup",
          );
        }
        const inTrace = new Set(
          ((itemResult.data ?? []) as Array<JsonObject>)
            .map((item) => item.memory_id)
            .filter((id): id is string => typeof id === "string"),
        );
        const reportedIds = [
          ...used_memory_ids,
          ...ignored.map((item) => item.memory_id),
        ];
        const unknown = reportedIds.find((id) => !inTrace.has(id));
        if (unknown) {
          return toolError(
            `memory_usage_report error: Memory ${unknown} was not returned by this recall`,
          );
        }
        const overlap = used_memory_ids.find((id) =>
          ignored.some((item) => item.memory_id === id)
        );
        if (overlap) {
          return toolError(
            `memory_usage_report error: Memory ${overlap} cannot be both used and ignored`,
          );
        }

        for (const memoryId of used_memory_ids) {
          const { error } = await supabase.from("agent_memory_recall_items")
            .update({ used: true, ignored_reason: null })
            .eq("trace_id", trace.id as string)
            .eq("memory_id", memoryId);
          if (error) {
            throw agentMemoryDatabaseError(
              error,
              "agent_memory_recall_items",
              "Agent Memory usage update",
            );
          }
          await auditAgentMemory("memory_used", {
            workspace_id: trace.workspace_id,
            project_id: trace.project_id ?? null,
            trace_id: trace.id,
            memory_id: memoryId,
            runtime_name: trace.runtime_name,
          });
        }
        for (const item of ignored) {
          const { error } = await supabase.from("agent_memory_recall_items")
            .update({
              used: false,
              ignored_reason: item.reason ?? null,
            })
            .eq("trace_id", trace.id as string)
            .eq("memory_id", item.memory_id);
          if (error) {
            throw agentMemoryDatabaseError(
              error,
              "agent_memory_recall_items",
              "Agent Memory ignored update",
            );
          }
          await auditAgentMemory("memory_ignored", {
            workspace_id: trace.workspace_id,
            project_id: trace.project_id ?? null,
            trace_id: trace.id,
            memory_id: item.memory_id,
            reason: item.reason ?? null,
          });
        }
        return toolJson({ ok: true });
      } catch (error) {
        return toolError(
          `memory_usage_report error: ${(error as Error).message}`,
        );
      }
    },
  );

  server.registerTool(
    "memory_review_queue",
    {
      title: "List Pending Agent Memories",
      description:
        "List pending memories in one workspace, oldest first, with offset pagination.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        workspace_id: z.string().trim().min(1).max(256),
        limit: z.number().int().min(1).max(100).default(20).optional(),
        offset: z.number().int().min(0).default(0).optional(),
      },
    },
    async ({ workspace_id, limit = 20, offset = 0 }) => {
      try {
        const { data, error } = await supabase.from("agent_memories")
          .select("*")
          .eq("workspace_id", workspace_id)
          .eq("review_status", "pending")
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(offset, offset + limit);
        if (error) {
          throw agentMemoryDatabaseError(
            error,
            "agent_memories",
            "Agent Memory review queue",
          );
        }
        const rows = (data ?? []) as AgentMemoryRecord[];
        const page = rows.slice(0, limit);
        const hasMore = rows.length > limit;
        return toolJson({
          memories: page.map(agentMemoryResponse),
          has_more: hasMore,
          pagination: {
            offset,
            limit,
            returned: page.length,
            has_more: hasMore,
          },
        });
      } catch (error) {
        return toolError(
          `memory_review_queue error: ${(error as Error).message}`,
        );
      }
    },
  );

  const reviewActionSchema = z.enum([
    "approve",
    "confirm",
    "edit",
    "evidence_only",
    "restrict_scope",
    "mark_stale",
    "merge",
    "reject",
    "dispute",
    "supersede",
  ]);
  server.registerTool(
    "memory_review",
    {
      title: "Review Agent Memory",
      description:
        "Apply a logical review transition with an explicit actor. approve is stored as the REST contract's confirm action; no action physically deletes a row.",
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      inputSchema: {
        memory_id: z.string().uuid(),
        workspace_id: z.string().trim().min(1).max(256),
        action: reviewActionSchema,
        actor_id: z.string().trim().min(1).max(256),
        notes: z.string().trim().min(1).max(4_000).optional(),
        related_memory_id: z.string().uuid().optional(),
        content: z.string().trim().min(1).max(15_000).optional(),
        summary: z.string().trim().min(1).max(500).optional(),
        visibility: visibilitySchema.optional(),
      },
    },
    async ({
      memory_id,
      workspace_id,
      action,
      actor_id,
      notes,
      related_memory_id,
      content,
      summary,
      visibility,
    }) => {
      try {
        if (
          ["mark_stale", "merge", "reject", "dispute", "supersede"].includes(
            action,
          ) && !notes
        ) {
          return toolError(
            `memory_review error: notes are required for ${action}`,
          );
        }
        if (["merge", "supersede"].includes(action) && !related_memory_id) {
          return toolError(
            `memory_review error: related_memory_id is required for ${action}`,
          );
        }
        if (action === "restrict_scope" && !visibility) {
          return toolError(
            "memory_review error: visibility is required for restrict_scope",
          );
        }
        if (action === "edit" && !content && !summary) {
          return toolError(
            "memory_review error: content or summary is required for edit",
          );
        }

        const beforeResult = await supabase.from("agent_memories")
          .select("*")
          .eq("id", memory_id)
          .eq("workspace_id", workspace_id)
          .maybeSingle();
        if (beforeResult.error) {
          throw agentMemoryDatabaseError(
            beforeResult.error,
            "agent_memories",
            "Agent Memory review lookup",
          );
        }
        if (!beforeResult.data) {
          return toolError("memory_review error: Memory not found");
        }
        const before = beforeResult.data as AgentMemoryRecord;
        if (related_memory_id === memory_id) {
          return toolError(
            "memory_review error: A memory cannot be related to itself",
          );
        }
        if (related_memory_id) {
          const relatedResult = await supabase.from("agent_memories")
            .select("id")
            .eq("id", related_memory_id)
            .eq("workspace_id", workspace_id)
            .maybeSingle();
          if (relatedResult.error) {
            throw agentMemoryDatabaseError(
              relatedResult.error,
              "agent_memories",
              "Related Agent Memory lookup",
            );
          }
          if (!relatedResult.data) {
            return toolError(
              "memory_review error: Related memory must exist in the same workspace",
            );
          }
        }

        const normalizedAction = action === "approve" ? "confirm" : action;
        const updates: JsonObject = {};
        if (normalizedAction === "confirm") {
          Object.assign(updates, {
            review_status: "confirmed",
            provenance_status: "user_confirmed",
            can_use_as_instruction: true,
            requires_user_confirmation: false,
            last_confirmed_at: new Date().toISOString(),
          });
        } else if (normalizedAction === "evidence_only") {
          Object.assign(updates, {
            review_status: "evidence_only",
            can_use_as_instruction: false,
            can_use_as_evidence: true,
            requires_user_confirmation: false,
          });
        } else if (normalizedAction === "reject") {
          Object.assign(updates, {
            review_status: "rejected",
            lifecycle_status: "rejected",
            can_use_as_instruction: false,
            can_use_as_evidence: false,
          });
        } else if (normalizedAction === "mark_stale") {
          Object.assign(updates, {
            review_status: "stale",
            lifecycle_status: "stale",
            can_use_as_instruction: false,
          });
        } else if (normalizedAction === "dispute") {
          Object.assign(updates, {
            lifecycle_status: "disputed",
            provenance_status: "disputed",
            can_use_as_instruction: false,
            can_use_as_evidence: false,
            requires_user_confirmation: true,
          });
        } else if (normalizedAction === "restrict_scope") {
          if (!canRestrictAgentMemory(before, visibility!)) {
            return toolError(
              "memory_review error: restrict_scope may only reduce the existing visibility",
            );
          }
          Object.assign(updates, {
            review_status: "restricted",
            visibility,
          });
        } else if (normalizedAction === "edit") {
          if (content) {
            const unsafe = unsafeAgentMemoryReasons(content);
            if (unsafe.length) {
              return toolError(
                `memory_review error: Unsafe review edit blocked: ${
                  unsafe.join(", ")
                }`,
              );
            }
            const embedding = await getEmbedding(content);
            const thoughtResult = await supabase.rpc("upsert_thought", {
              p_content: content,
              p_payload: {
                metadata: {
                  source: "agent_memory_review",
                  agent_memory_id: memory_id,
                },
              },
            });
            if (thoughtResult.error) {
              throw new Error(
                `upsert_thought failed: ${thoughtResult.error.message}`,
              );
            }
            const thoughtId = extractThoughtId(thoughtResult.data);
            if (!thoughtId) {
              throw new Error("upsert_thought returned no UUID thought id");
            }
            const embeddingResult = await supabase.from("thoughts")
              .update({ embedding: `[${embedding.join(",")}]` })
              .eq("id", thoughtId);
            if (embeddingResult.error) {
              throw new Error(
                `Agent Memory review embedding update failed: ${embeddingResult.error.message}`,
              );
            }
            updates.content = content;
            updates.content_hash = await sha256Hex(
              `${before.memory_type}:${content}`,
            );
            updates.thought_id = thoughtId;
          }
          if (summary) updates.summary = summary;
        } else if (normalizedAction === "merge") {
          Object.assign(updates, {
            review_status: "merged",
            lifecycle_status: "superseded",
            can_use_as_instruction: false,
            can_use_as_evidence: false,
            requires_user_confirmation: false,
          });
        } else if (normalizedAction === "supersede") {
          Object.assign(updates, {
            review_status: "stale",
            lifecycle_status: "superseded",
            can_use_as_instruction: false,
            can_use_as_evidence: false,
            requires_user_confirmation: false,
          });
        }

        const updatedResult = await supabase.from("agent_memories")
          .update(updates)
          .eq("id", memory_id)
          .eq("workspace_id", workspace_id)
          .select("*")
          .single();
        if (updatedResult.error || !updatedResult.data) {
          throw agentMemoryDatabaseError(
            updatedResult.error,
            "agent_memories",
            "Agent Memory review update",
          );
        }
        const after = updatedResult.data as AgentMemoryRecord;
        const reviewActionResult = await supabase
          .from("agent_memory_review_actions")
          .insert({
            memory_id,
            action: normalizedAction,
            actor_id,
            notes: notes ?? null,
            before,
            after,
          });
        if (reviewActionResult.error) {
          throw agentMemoryDatabaseError(
            reviewActionResult.error,
            "agent_memory_review_actions",
            "Agent Memory review action insert",
          );
        }

        if (
          related_memory_id && ["merge", "supersede"].includes(normalizedAction)
        ) {
          const relationResult = await supabase
            .from("agent_memory_relations")
            .insert({
              from_memory_id: memory_id,
              to_memory_id: related_memory_id,
              relation: normalizedAction === "merge"
                ? "merged_into"
                : "superseded_by",
              confidence: 1,
            });
          if (relationResult.error) {
            throw agentMemoryDatabaseError(
              relationResult.error,
              "agent_memory_relations",
              "Agent Memory relation insert",
            );
          }
        }

        const eventMap: Record<string, string> = {
          confirm: "memory_confirmed",
          edit: "memory_edited",
          reject: "memory_rejected",
          supersede: "memory_superseded",
          dispute: "memory_disputed",
        };
        await auditAgentMemory(eventMap[normalizedAction] ?? "memory_edited", {
          workspace_id,
          project_id: before.project_id,
          memory_id,
          actor_kind: "user",
          actor_label: actor_id,
          action: normalizedAction,
          notes: notes ?? null,
          related_memory_id: related_memory_id ?? null,
        });
        return toolJson({ memory: agentMemoryResponse(after) });
      } catch (error) {
        return toolError(`memory_review error: ${(error as Error).message}`);
      }
    },
  );
}

function buildServer(): McpServer {
  const server = new McpServer({
    name: "open-brain",
    version: "2.0.0",
  });

  registerAgentMemoryTools(server);

  server.registerTool(
    "search",
    {
      title: "Search Open Brain",
      description:
        "Search Open Brain memories. This read-only compatibility tool preserves the ChatGPT search/fetch contract.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        query: z.string().min(1).describe("The search query to run"),
      },
    },
    async ({ query }) => {
      try {
        const result = await runSearch({
          query,
          mode: "hybrid",
          limit: 10,
          offset: 0,
          threshold: 0.5,
          filters: { include_restricted: false },
        });
        const rows = result.results as JsonObject[];
        return toolJson({
          results: rows.map((row) => ({
            id: row.id,
            title: thoughtTitle(
              String(row.content ?? ""),
              String(row.date ?? ""),
            ),
            url: thoughtUrl(String(row.id)),
          })),
        });
      } catch (error) {
        return toolError(`Search error: ${(error as Error).message}`);
      }
    },
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch Open Brain Thought",
      description:
        "Fetch one visible Open Brain thought by ID, including metadata and best-effort connections.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        id: z.string().uuid().describe("Thought UUID returned by search"),
      },
    },
    async ({ id }) => {
      try {
        const { data, error } = await supabase
          .from("thoughts")
          .select(
            "id, content, metadata, created_at, updated_at, type, source_type, importance, quality_score, sensitivity_tier",
          )
          .eq("id", id)
          .or("metadata->>deleted.is.null,metadata->>deleted.neq.true")
          .or("sensitivity_tier.is.null,sensitivity_tier.neq.restricted")
          .single();
        if (error || !data) {
          return toolError(`Fetch error: thought ${id} not found`);
        }

        let connections: JsonObject[] = [];
        const connectionResult = await supabase.rpc("get_thought_connections", {
          p_thought_id: id,
          p_limit: 20,
          p_exclude_restricted: true,
        });
        if (!connectionResult.error) {
          try {
            connections = await excludeDeletedConnections(
              (connectionResult.data ?? []) as JsonObject[],
            );
          } catch {
            connections = [];
          }
        }

        const thought = data as ThoughtRecord;
        return toolJson({
          id: thought.id,
          title: thoughtTitle(thought.content, thought.created_at),
          text: thought.content,
          url: thoughtUrl(thought.id),
          metadata: {
            ...asMetadata(thought.metadata),
            type: rowType(thought),
            source_type: rowSourceType(thought),
            importance: rowImportance(thought),
            quality_score: thought.quality_score,
            sensitivity_tier: thought.sensitivity_tier,
            created_at: thought.created_at,
            updated_at: thought.updated_at,
          },
          connections,
        });
      } catch (error) {
        return toolError(`Fetch error: ${(error as Error).message}`);
      }
    },
  );

  server.registerTool(
    "search_thoughts",
    {
      title: "Search Thoughts v2",
      description:
        "Filtered, paginated hybrid, semantic, or full-text retrieval. Hybrid mode tries the database RPC first and falls back to deterministic server-side RRF.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        query: z.string().min(1),
        mode: z.enum(["hybrid", "semantic", "text"]).default("hybrid")
          .optional(),
        limit: z.number().int().min(1).max(50).default(10).optional(),
        offset: z.number().int().min(0).default(0).optional(),
        type: z.string().min(1).optional(),
        source_type: z.string().min(1).optional(),
        min_importance: z.number().int().min(0).max(5).optional(),
        start_date: z.string().min(1).optional(),
        end_date: z.string().min(1).optional(),
        include_restricted: z.boolean().default(false).optional(),
        threshold: z.number().min(0).max(1).default(0.5).optional(),
      },
    },
    async ({
      query,
      mode = "hybrid",
      limit = 10,
      offset = 0,
      type,
      source_type,
      min_importance,
      start_date,
      end_date,
      include_restricted = false,
      threshold = 0.5,
    }) => {
      try {
        const normalizedStartDate = parseDateInput("start_date", start_date);
        const normalizedEndDate = parseDateInput("end_date", end_date);
        return toolJson(
          await runSearch({
            query,
            mode,
            limit,
            offset,
            threshold,
            filters: {
              type,
              source_type,
              min_importance,
              start_date: normalizedStartDate,
              end_date: normalizedEndDate,
              include_restricted,
            },
          }),
        );
      } catch (error) {
        return toolError(`search_thoughts error: ${(error as Error).message}`);
      }
    },
  );

  server.registerTool(
    "recall_context",
    {
      title: "Recall Context",
      description:
        "Deterministically recall recent important context without embeddings or model calls.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        scope_topics: z.array(z.string().min(1)).optional(),
        scope_people: z.array(z.string().min(1)).optional(),
        days: z.number().int().min(0).max(3650).default(30).optional(),
        limit: z.number().int().min(1).max(50).default(12).optional(),
        min_importance: z.number().int().min(0).max(5).default(0).optional(),
        include_restricted: z.boolean().default(false).optional(),
      },
    },
    async ({
      scope_topics,
      scope_people,
      days = 30,
      limit = 12,
      min_importance = 0,
      include_restricted = false,
    }) => {
      try {
        let query = supabase
          .from("thoughts")
          .select("id, content, type, importance, created_at, metadata")
          .or("metadata->>deleted.is.null,metadata->>deleted.neq.true")
          .gte("importance", min_importance)
          .order("importance", { ascending: false, nullsFirst: false })
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .limit(Math.min(limit * 2, 100));
        if (!include_restricted) {
          query = query.or(
            "sensitivity_tier.is.null,sensitivity_tier.neq.restricted",
          );
        }
        if (days > 0) {
          query = query.gte(
            "created_at",
            new Date(Date.now() - days * 86_400_000).toISOString(),
          );
        }
        if (scope_topics?.length) {
          query = query.contains("metadata", { topics: scope_topics });
        }
        if (scope_people?.length) {
          query = query.contains("metadata", { people: scope_people });
        }

        const { data, error } = await query;
        if (error) throw new Error(error.message);
        const visibleRows = await excludeSupersededThoughts(
          (data ?? []) as ThoughtRecord[],
        );
        const results = visibleRows.slice(0, limit).map((row) => ({
          id: row.id,
          date: row.created_at,
          type: rowType(row),
          importance: rowImportance(row),
          summary: row.content.slice(0, 240),
        }));
        return toolJson({ results });
      } catch (error) {
        return toolError(`recall_context error: ${(error as Error).message}`);
      }
    },
  );

  server.registerTool(
    "list_thoughts",
    {
      title: "List Thoughts",
      description: "List visible thoughts with filters and offset pagination.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(10).optional(),
        offset: z.number().int().min(0).default(0).optional(),
        type: z.string().min(1).optional(),
        source_type: z.string().min(1).optional(),
        min_importance: z.number().int().min(0).max(5).optional(),
        topic: z.string().min(1).optional(),
        person: z.string().min(1).optional(),
        days: z.number().int().min(0).max(3650).optional(),
        include_restricted: z.boolean().default(false).optional(),
      },
    },
    async ({
      limit = 10,
      offset = 0,
      type,
      source_type,
      min_importance,
      topic,
      person,
      days,
      include_restricted = false,
    }) => {
      try {
        let query = supabase
          .from("thoughts")
          .select(
            "id, content, metadata, created_at, updated_at, type, source_type, importance, quality_score, sensitivity_tier",
          )
          .or("metadata->>deleted.is.null,metadata->>deleted.neq.true")
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(offset, offset + limit);
        if (!include_restricted) {
          query = query.or(
            "sensitivity_tier.is.null,sensitivity_tier.neq.restricted",
          );
        }
        if (type) query = query.eq("type", type);
        if (source_type) query = query.eq("source_type", source_type);
        if (min_importance !== undefined) {
          query = query.gte("importance", min_importance);
        }
        if (topic) query = query.contains("metadata", { topics: [topic] });
        if (person) query = query.contains("metadata", { people: [person] });
        if (days && days > 0) {
          query = query.gte(
            "created_at",
            new Date(Date.now() - days * 86_400_000).toISOString(),
          );
        }

        const { data, error } = await query;
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as ThoughtRecord[];
        const page = rows.slice(0, limit);
        return toolJson({
          results: page.map((row) => ({
            id: row.id,
            date: row.created_at,
            type: rowType(row),
            source_type: rowSourceType(row),
            importance: rowImportance(row),
            metadata: metadataExcerpt(row.metadata),
            content: row.content,
          })),
          pagination: {
            offset,
            limit,
            returned: page.length,
            has_more: rows.length > limit,
          },
        });
      } catch (error) {
        return toolError(`list_thoughts error: ${(error as Error).message}`);
      }
    },
  );

  server.registerTool(
    "thought_stats",
    {
      title: "Thought Statistics v2",
      description:
        "Return exact server-side aggregates without downloading thought rows.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        since_days: z.number().int().min(0).max(3650).default(3650).optional(),
        include_restricted: z.boolean().default(false).optional(),
      },
    },
    async ({ since_days = 3650, include_restricted = false }) => {
      try {
        const { data, error } = await supabase.rpc("brain_stats_aggregate", {
          p_since_days: since_days,
          p_exclude_restricted: !include_restricted,
        });
        if (error) {
          return toolError(
            `thought_stats error: brain_stats_aggregate failed: ${error.message}`,
          );
        }
        return toolJson({
          since_days,
          include_restricted,
          aggregate: data,
        });
      } catch (error) {
        return toolError(
          `thought_stats error: brain_stats_aggregate failed: ${
            (error as Error).message
          }`,
        );
      }
    },
  );

  server.registerTool(
    "related_thoughts",
    {
      title: "Related Thoughts",
      description: "Find visible connections for a thought.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        thought_id: z.string().uuid(),
        limit: z.number().int().min(1).max(50).default(10).optional(),
      },
    },
    async ({ thought_id, limit = 10 }) => {
      try {
        const source = await supabase
          .from("thoughts")
          .select("id")
          .eq("id", thought_id)
          .or("metadata->>deleted.is.null,metadata->>deleted.neq.true")
          .or("sensitivity_tier.is.null,sensitivity_tier.neq.restricted")
          .maybeSingle();
        if (source.error || !source.data) {
          return toolError(
            `related_thoughts error: thought ${thought_id} not found`,
          );
        }
        const { data, error } = await supabase.rpc("get_thought_connections", {
          p_thought_id: thought_id,
          p_limit: Math.min(limit * 2, 50),
          p_exclude_restricted: true,
        });
        if (error) {
          return toolError(`related_thoughts error: ${error.message}`);
        }
        const rows = await excludeDeletedConnections(
          (data ?? []) as JsonObject[],
        );
        return toolJson({
          thought_id,
          results: rows.slice(0, limit),
        });
      } catch (error) {
        return toolError(`related_thoughts error: ${(error as Error).message}`);
      }
    },
  );

  server.registerTool(
    "capture_thought",
    {
      title: "Capture Thought",
      description: "Save a thought, extract metadata, and attach an embedding.",
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      inputSchema: {
        content: z.string().min(1).max(50_000),
      },
    },
    async ({ content }) => {
      try {
        const [embedding, metadata] = await Promise.all([
          getEmbedding(content),
          extractMetadata(content),
        ]);
        const payload = { metadata: { ...metadata, source: "mcp" } };
        const embeddingValue = `[${embedding.join(",")}]`;
        const atomicResult = await supabase.rpc("capture_thought_atomic", {
          p_content: content,
          p_payload: payload,
          p_embedding: embeddingValue,
        });
        if (!atomicResult.error) {
          const result = asMetadata(atomicResult.data);
          const thoughtId = result.id;
          if (typeof thoughtId !== "string") {
            return toolError(
              "Failed to capture: capture_thought_atomic returned no id",
            );
          }
          return toolJson({
            ...result,
            id: thoughtId,
            captured: true,
            metadata,
            atomic: true,
            via: "capture_thought_atomic",
          });
        }
        if (
          !isMissingDatabaseObjectError(
            atomicResult.error,
            "capture_thought_atomic",
          )
        ) {
          return toolError(
            `Failed to capture atomically: ${atomicResult.error.message}`,
          );
        }

        const { data, error } = await supabase.rpc("upsert_thought", {
          p_content: content,
          p_payload: payload,
        });
        if (error) return toolError(`Failed to capture: ${error.message}`);
        const thoughtId = (data as JsonObject | null)?.id;
        if (typeof thoughtId !== "string") {
          return toolError("Failed to capture: upsert_thought returned no id");
        }
        const embeddingResult = await supabase
          .from("thoughts")
          .update({ embedding: embeddingValue })
          .eq("id", thoughtId);
        if (embeddingResult.error) {
          return toolError(
            `Failed to save embedding: ${embeddingResult.error.message}`,
          );
        }
        return toolJson({
          id: thoughtId,
          captured: true,
          metadata,
          atomic: false,
          via: "fallback_non_atomic",
        });
      } catch (error) {
        return toolError(`capture_thought error: ${(error as Error).message}`);
      }
    },
  );

  server.registerTool(
    "update_thought",
    {
      title: "Update Thought",
      description:
        "Safely update content and/or shallow-merge metadata, with optional optimistic concurrency.",
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      inputSchema: {
        id: z.string().uuid(),
        content: z.string().min(1).max(50_000).optional(),
        metadata_patch: z.record(z.string(), z.unknown()).optional(),
        if_unchanged_since: z.string().datetime({ offset: true }).optional(),
      },
    },
    async ({ id, content, metadata_patch, if_unchanged_since }) => {
      try {
        if (
          metadata_patch &&
          ["deleted", "deleted_at", "deleted_by"].some((key) =>
            Object.hasOwn(metadata_patch, key)
          )
        ) {
          return toolError(
            "update_thought error: deletion metadata is managed by delete_thought",
          );
        }

        const { data: existing, error: fetchError } = await supabase
          .from("thoughts")
          .select("id, content, metadata, created_at, updated_at")
          .eq("id", id)
          .not("metadata", "cs", '{"deleted":true}')
          .single();
        if (fetchError || !existing) {
          return toolError(`update_thought error: thought ${id} not found`);
        }

        if (if_unchanged_since) {
          const storedTime = new Date(
            existing.updated_at ?? existing.created_at,
          ).getTime();
          if (storedTime > new Date(if_unchanged_since).getTime()) {
            return toolError(
              `STALE_READ: thought ${id} changed at ${
                existing.updated_at ?? existing.created_at
              }`,
            );
          }
        }

        const updates: JsonObject = {};
        const contentChanged = content !== undefined &&
          content !== existing.content;
        if (contentChanged) {
          const embedding = await getEmbedding(content);
          updates.content = content;
          updates.embedding = `[${embedding.join(",")}]`;
        }
        if (metadata_patch && Object.keys(metadata_patch).length) {
          updates.metadata = {
            ...asMetadata(existing.metadata),
            ...metadata_patch,
          };
        }
        if (!Object.keys(updates).length) {
          return toolJson({
            id,
            changed: false,
            updated_at: existing.updated_at,
          });
        }

        let updateQuery = supabase
          .from("thoughts")
          .update(updates)
          .eq("id", id)
          .not("metadata", "cs", '{"deleted":true}');
        if (if_unchanged_since) {
          updateQuery = updateQuery.or(
            `updated_at.is.null,updated_at.lte.${if_unchanged_since}`,
          );
        }
        const { data, error } = await updateQuery
          .select("id, content, metadata, created_at, updated_at")
          .maybeSingle();
        if (error) return toolError(`update_thought error: ${error.message}`);
        if (!data) {
          return toolError(
            `STALE_READ: thought ${id} changed before the update could be applied`,
          );
        }
        return toolJson({
          id: data.id,
          changed: true,
          content_reembedded: contentChanged,
          metadata: data.metadata,
          created_at: data.created_at,
          updated_at: data.updated_at,
        });
      } catch (error) {
        return toolError(`update_thought error: ${(error as Error).message}`);
      }
    },
  );

  server.registerTool(
    "delete_thought",
    {
      title: "Logically Delete Thought",
      description:
        "Logically delete one thought. Requires confirm=true; never hard-deletes rows.",
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        id: z.string().uuid(),
        confirm: z.boolean().default(false).optional(),
      },
    },
    async ({ id, confirm = false }) => {
      if (confirm !== true) {
        return toolError(
          "delete_thought refused: confirm=true is required; no changes were made",
        );
      }
      try {
        const atomicResult = await supabase.rpc("soft_delete_thought", {
          p_id: id,
          p_actor: "mcp",
          p_confirm: true,
        });
        if (!atomicResult.error) {
          return toolJson({
            ...asMetadata(atomicResult.data),
            id,
            deleted: true,
            atomic: true,
            via: "soft_delete_thought",
          });
        }
        if (
          !isMissingDatabaseObjectError(
            atomicResult.error,
            "soft_delete_thought",
          )
        ) {
          return toolError(
            `delete_thought error: ${atomicResult.error.message}`,
          );
        }

        const { data: existing, error: fetchError } = await supabase
          .from("thoughts")
          .select("id, content, metadata, created_at, updated_at")
          .eq("id", id)
          .single();
        if (fetchError || !existing) {
          return toolError(`delete_thought error: thought ${id} not found`);
        }
        const priorMetadata = asMetadata(existing.metadata);
        if (isDeleted({ metadata: priorMetadata })) {
          return toolJson({
            id,
            deleted: true,
            already_deleted: true,
            atomic: false,
            via: "fallback_non_atomic",
          });
        }

        const deletedAt = new Date().toISOString();
        const metadata = {
          ...priorMetadata,
          deleted: true,
          deleted_at: deletedAt,
          deleted_by: "mcp",
        };
        let deleteQuery = supabase
          .from("thoughts")
          .update({ metadata })
          .eq("id", id)
          .not("metadata", "cs", '{"deleted":true}');
        deleteQuery = existing.updated_at
          ? deleteQuery.eq("updated_at", existing.updated_at)
          : deleteQuery.is("updated_at", null);
        const { data, error } = await deleteQuery
          .select("id, updated_at")
          .maybeSingle();
        if (error) return toolError(`delete_thought error: ${error.message}`);
        if (!data) {
          return toolError(
            `STALE_READ: thought ${id} changed before logical deletion could be applied`,
          );
        }

        try {
          const auditResult = await supabase.from("thought_audit").insert({
            thought_id: id,
            action: "delete",
            diff: {
              previous_content: existing.content,
              previous_metadata: priorMetadata,
              deleted_at: deletedAt,
              deleted_by: "mcp",
            },
          });
          if (auditResult.error) {
            console.warn("delete_thought audit unavailable");
          }
        } catch {
          console.warn("delete_thought audit unavailable");
        }

        return toolJson({
          id,
          deleted: true,
          deleted_at: deletedAt,
          deleted_by: "mcp",
          atomic: false,
          via: "fallback_non_atomic",
        });
      } catch (error) {
        return toolError(`delete_thought error: ${(error as Error).message}`);
      }
    },
  );

  return server;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-brain-key, accept, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};

export function timingSafeEqualStrings(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const subtle = (crypto as unknown as {
    subtle?: {
      timingSafeEqual?: (
        left: ArrayBufferView,
        right: ArrayBufferView,
      ) => boolean;
    };
  }).subtle;
  if (
    aBytes.length === bBytes.length &&
    typeof subtle?.timingSafeEqual === "function"
  ) {
    return subtle.timingSafeEqual(aBytes, bBytes);
  }

  let difference = aBytes.length ^ bBytes.length;
  const length = Math.max(aBytes.length, bBytes.length);
  for (let index = 0; index < length; index++) {
    difference |= (aBytes[index] ?? 0) ^ (bBytes[index] ?? 0);
  }
  return difference === 0;
}

export const app = new Hono();

app.options("*", (context) => context.text("ok", 200, corsHeaders));

app.all("*", async (context) => {
  const headerKey = context.req.header("x-brain-key") ?? "";
  const authorization = context.req.header("authorization") ?? "";
  const bearerKey = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  const hasConfiguredKey = typeof MCP_ACCESS_KEY === "string" &&
    MCP_ACCESS_KEY.length > 0;
  const headerMatches = hasConfiguredKey &&
    timingSafeEqualStrings(headerKey, MCP_ACCESS_KEY);
  const bearerMatches = hasConfiguredKey &&
    timingSafeEqualStrings(bearerKey, MCP_ACCESS_KEY);
  if (!hasConfiguredKey || (!headerMatches && !bearerMatches)) {
    return context.json(
      { error: "Invalid or missing access key" },
      401,
      corsHeaders,
    );
  }

  if (!context.req.header("accept")?.includes("text/event-stream")) {
    const headers = new Headers(context.req.raw.headers);
    headers.set("Accept", "application/json, text/event-stream");
    const patched = new Request(context.req.raw.url, {
      method: context.req.raw.method,
      headers,
      body: context.req.raw.body,
      // @ts-ignore -- duplex is required for streaming request bodies in Deno.
      duplex: "half",
    });
    Object.defineProperty(context.req, "raw", {
      value: patched,
      writable: true,
    });
  }

  const server = buildServer();
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  const response = await transport.handleRequest(context);
  if (!response) {
    return context.json(
      { error: "No response from MCP transport" },
      500,
      corsHeaders,
    );
  }
  response.headers.delete("mcp-session-id");
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value);
  }
  return response;
});

// PORT est ignoré par l'Edge Runtime Supabase mais permet aux tests locaux
// de démarrer le serveur sur un port éphémère.
if (import.meta.main) {
  Deno.serve({ port: Number(Deno.env.get("PORT") ?? "8000") }, app.fetch);
}
