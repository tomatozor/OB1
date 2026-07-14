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
const DEFAULT_SEMANTIC_WEIGHT = 1.0;
const DEFAULT_TEXT_WEIGHT = 2.0;
const AGENT_MEMORY_RUNTIME = "open-brain-mcp-v2";
const AGENT_MEMORY_SCHEMA_ERROR =
  "Agent Memory schema not installed — see schemas/agent-memory";
const AGENT_MEMORY_TRANSACTIONAL_RPC_ERROR =
  "Agent Memory transactional RPCs not installed — apply schemas/agent-memory";
const AGENT_MEMORY_WRITEBACK_SCHEMA_OUTDATED_ERROR =
  "Agent Memory schema outdated — re-apply schemas/agent-memory";
const AGENT_MEMORY_MATCH_RPC_ERROR =
  "Agent Memory semantic recall RPC not installed/outdated — re-apply schemas/agent-memory";
const DELETE_RPC_ERROR =
  "soft_delete_thought RPC not installed — apply schemas/hybrid-recall before using delete_thought";
const EMBEDDING_DIMENSIONS = 1536;
const OPENROUTER_TIMEOUT_MS = 15_000;
const POSTGREST_TIMEOUT_MS = 10_000;

const postgrestFetch: typeof fetch = (input, init = {}) =>
  fetch(input, {
    ...init,
    signal: AbortSignal.timeout(POSTGREST_TIMEOUT_MS),
  });

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  global: { fetch: postgrestFetch },
});

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
  semanticWeight?: number;
  textWeight?: number;
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
    throw actionable(
      `Invalid ${name}: expected a date parseable by Date.parse, received ${
        JSON.stringify(value)
      }`,
    );
  }
  return new Date(timestamp).toISOString();
}

export function validateRrfWeight(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw actionable(
      `Invalid ${name}: expected a finite number > 0, received ${
        String(value)
      }`,
    );
  }
  return value;
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

class ActionableToolError extends Error {}

function actionable(message: string): ActionableToolError {
  return new ActionableToolError(message);
}

function internalToolError(tool: string, error: unknown) {
  if (error instanceof ActionableToolError) {
    return toolError(`${tool} error: ${error.message}`);
  }
  const correlationId = crypto.randomUUID().slice(0, 8);
  console.error(`[${correlationId}] ${tool} internal failure`, error);
  return toolError(
    `${tool} error: Internal failure (reference ${correlationId})`,
  );
}

class EmbeddingRequestError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

export function validateEmbedding(value: unknown): number[] {
  if (
    !Array.isArray(value) || value.length !== EMBEDDING_DIMENSIONS ||
    !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  ) {
    throw new Error(
      `Invalid embedding response: expected ${EMBEDDING_DIMENSIONS} finite numbers`,
    );
  }
  return value as number[];
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError");
}

function retryDelay(attempt: number): Promise<void> {
  const delay = 20 * (attempt + 1) + Math.floor(Math.random() * 30);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function getEmbedding(text: string): Promise<number[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
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
        signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new EmbeddingRequestError(
          `OpenRouter embeddings returned HTTP ${response.status}`,
          response.status === 429 || response.status >= 500,
        );
      }
      const body = await response.json();
      return validateEmbedding(body?.data?.[0]?.embedding);
    } catch (error) {
      const retryable = isTimeoutError(error) ||
        (error instanceof EmbeddingRequestError && error.retryable);
      if (!retryable || attempt === 2) throw error;
      await retryDelay(attempt);
    }
  }
  throw new Error("Embedding retry loop exhausted");
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
    signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `OpenRouter metadata extraction returned HTTP ${response.status}`,
    );
  }
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
    return actionable(AGENT_MEMORY_SCHEMA_ERROR);
  }
  return new Error(`${operation} failed: ${errorText(error)}`);
}

function isMissingTransactionalAgentMemoryRpc(
  error: unknown,
  rpcName: string,
): boolean {
  return isMissingDatabaseObjectError(error, rpcName);
}

function agentMemoryTransactionalRpcError(
  error: unknown,
  rpcName: string,
): Error {
  if (isMissingTransactionalAgentMemoryRpc(error, rpcName)) {
    return actionable(AGENT_MEMORY_TRANSACTIONAL_RPC_ERROR);
  }
  const detail = errorText(error);
  if (
    /idempot|different content|transition|workspace|not found|related memory/i
      .test(detail)
  ) {
    return actionable(detail);
  }
  return new Error(`${rpcName} failed: ${detail}`);
}

function isOutdatedAgentMemoryWritebackSignature(error: unknown): boolean {
  const detail = errorText(error).toLowerCase();
  return detail.includes("agent_memory_writeback_tx") &&
    detail.includes("p_embedding") &&
    (detail.includes("does not exist") ||
      detail.includes("could not find") ||
      detail.includes("schema cache"));
}

export function isMissingEnhancedThoughtsError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const code = (error as JsonObject).code;
    if (code === "42703" || code === "PGRST202" || code === "PGRST204") {
      return true;
    }
  }
  const text = errorText(error).toLowerCase();
  return (text.includes("search_thoughts_text") ||
    [
      "updated_at",
      "type",
      "source_type",
      "importance",
      "quality_score",
      "sensitivity_tier",
    ].some((column) => text.includes(column))) &&
    (text.includes("does not exist") || text.includes("schema cache") ||
      text.includes("could not find"));
}

export function isHybridThresholdSignatureError(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  return text.includes("hybrid_search_thoughts") &&
    text.includes("p_semantic_threshold") &&
    (text.includes("does not exist") || text.includes("could not find") ||
      text.includes("schema cache"));
}

export function isHybridWeightSignatureError(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  return text.includes("hybrid_search_thoughts") &&
    (text.includes("p_semantic_weight") || text.includes("p_text_weight")) &&
    (text.includes("does not exist") || text.includes("could not find") ||
      text.includes("schema cache"));
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${
      Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(value[key])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value ?? null);
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
  semanticWeight = DEFAULT_SEMANTIC_WEIGHT,
  textWeight = DEFAULT_TEXT_WEIGHT,
): ThoughtRecord[] {
  const validatedSemanticWeight = validateRrfWeight(
    "semantic_weight",
    semanticWeight,
  );
  const validatedTextWeight = validateRrfWeight("text_weight", textWeight);
  const fused = new Map<string, { row: ThoughtRecord; score: number }>();
  for (
    const [rows, weight] of [
      [semanticRows, validatedSemanticWeight],
      [textRows, validatedTextWeight],
    ] as const
  ) {
    rows.forEach((row, index) => {
      const current = fused.get(row.id);
      const contribution = weight / (k + index + 1);
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
    rows: fuseRrf(
      semanticRows,
      textRows,
      RRF_K,
      input.semanticWeight ?? DEFAULT_SEMANTIC_WEIGHT,
      input.textWeight ?? DEFAULT_TEXT_WEIGHT,
    ).slice(
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
    const enriched = await supabase
      .from("thoughts")
      .select(
        "id, content, metadata, created_at, updated_at, type, source_type, importance, quality_score, sensitivity_tier",
      )
      .in("id", batch);
    if (!enriched.error) {
      details.push(...((enriched.data ?? []) as ThoughtRecord[]));
      continue;
    }
    if (!isMissingEnhancedThoughtsError(enriched.error)) {
      throw new Error(`thought hydration failed: ${errorText(enriched.error)}`);
    }
    const base = await supabase
      .from("thoughts")
      .select("id, content, metadata, created_at")
      .in("id", batch);
    if (base.error) {
      throw new Error(
        `base thought hydration failed: ${errorText(base.error)}`,
      );
    }
    details.push(...((base.data ?? []) as ThoughtRecord[]));
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
    if (error) {
      if (isMissingEnhancedThoughtsError(error)) return [];
      throw new Error(`search_thoughts_text failed: ${errorText(error)}`);
    }
    const rows = (data ?? []) as ThoughtRecord[];
    if (!rows.length) break;
    const parsedTotal = Number(rows[0].total_count);
    if (Number.isFinite(parsedTotal)) totalCount = parsedTotal;
    matches.push(...rows.filter((row) => matchesSearchFilters(row, filters)));
    rpcOffset += rows.length;
  }

  return matches;
}

async function callHybridSearchRpc(
  input: HybridSearchInput,
  threshold: number,
): Promise<{ data: unknown; error: unknown }> {
  const basePayload = {
    p_query: input.query,
    p_query_embedding: input.queryEmbedding,
    p_limit: input.limit,
    p_offset: input.offset,
    p_filter: input.filter,
    p_include_restricted: input.includeRestricted,
    p_rrf_k: RRF_K,
  };
  const thresholdPayload = {
    ...basePayload,
    p_semantic_threshold: threshold,
  };
  const weightedResult = await supabase.rpc("hybrid_search_thoughts", {
    ...thresholdPayload,
    p_semantic_weight: input.semanticWeight ?? DEFAULT_SEMANTIC_WEIGHT,
    p_text_weight: input.textWeight ?? DEFAULT_TEXT_WEIGHT,
  });
  if (
    !weightedResult.error ||
    !isHybridWeightSignatureError(weightedResult.error)
  ) {
    return weightedResult;
  }

  const thresholdResult = await supabase.rpc(
    "hybrid_search_thoughts",
    thresholdPayload,
  );
  if (
    !thresholdResult.error ||
    !isHybridThresholdSignatureError(thresholdResult.error)
  ) {
    return thresholdResult;
  }
  return await supabase.rpc("hybrid_search_thoughts", basePayload);
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
  semanticWeight: number;
  textWeight: number;
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
          semanticWeight: params.semanticWeight,
          textWeight: params.textWeight,
        },
        {
          primary: async (input) =>
            await callHybridSearchRpc(input, params.threshold),
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

async function fetchThoughtForChatGpt(
  id: string,
): Promise<{ data: ThoughtRecord | null; error: unknown }> {
  const enriched = await supabase
    .from("thoughts")
    .select(
      "id, content, metadata, created_at, updated_at, type, source_type, importance, quality_score, sensitivity_tier",
    )
    .eq("id", id)
    .or("metadata->>deleted.is.null,metadata->>deleted.neq.true")
    .or("sensitivity_tier.is.null,sensitivity_tier.neq.restricted")
    .single();
  if (!enriched.error) {
    return { data: enriched.data as ThoughtRecord, error: null };
  }
  if (!isMissingEnhancedThoughtsError(enriched.error)) {
    return { data: null, error: enriched.error };
  }
  const base = await supabase
    .from("thoughts")
    .select("id, content, metadata, created_at")
    .eq("id", id)
    .or("metadata->>deleted.is.null,metadata->>deleted.neq.true")
    .single();
  return {
    data: (base.data as ThoughtRecord | null) ?? null,
    error: base.error,
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
        "Recall strictly scoped Agent Memory records. A non-empty query uses workspace-bound agent_memory_match semantic candidates; otherwise results use confidence/freshness/id deterministic ordering. Every response is traced.",
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
        const similarityByMemory = new Map<string, number>();
        let memoryIds: string[] | null = null;

        if (query) {
          const semanticText = [
            query,
            task_type ? `Task type: ${task_type}` : "",
            ...Object.entries(entities ?? {}).flatMap(([kind, values]) =>
              values.map((value) => `${kind}: ${value}`)
            ),
          ].filter(Boolean).join("\n");
          const embedding = await getEmbedding(semanticText);
          const { data, error } = await supabase.rpc("agent_memory_match", {
            p_workspace_id: workspace_id,
            p_query_embedding: embedding,
            p_limit: Math.min(2_500, Math.max(maxResults * 8, 50)),
            p_threshold: 0.25,
          });
          if (error) {
            if (isMissingDatabaseObjectError(error, "agent_memory_match")) {
              throw actionable(AGENT_MEMORY_MATCH_RPC_ERROR);
            }
            throw new Error(
              `agent_memory_match failed: ${errorText(error)}`,
            );
          }
          for (const row of (data ?? []) as Array<JsonObject>) {
            if (typeof row.memory_id === "string") {
              similarityByMemory.set(
                row.memory_id,
                Number(row.similarity ?? 0),
              );
            }
          }
          memoryIds = [...similarityByMemory.keys()];
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
        if (memoryIds) {
          memoryQuery = memoryIds.length
            ? memoryQuery.in("id", memoryIds)
            : memoryQuery.eq(
              "id",
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
              const similarity = (similarityByMemory.get(right.id) ?? 0) -
                (similarityByMemory.get(left.id) ?? 0);
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
              similarity: query ? similarityByMemory.get(memory.id) ?? 0 : null,
              ranking_score: query
                ? similarityByMemory.get(memory.id) ?? 0
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
        return internalToolError("memory_recall", error);
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
        "Embed and atomically write one evidence-only pending Agent Memory record with workspace-scoped idempotency and an audit event.",
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
        const unsafe = [memory.summary, memory.content].flatMap((text) =>
          unsafeAgentMemoryReasons(text)
        );
        if (unsafe.length) {
          return toolError(
            `memory_writeback error: Unsafe write-back blocked: ${
              [...new Set(unsafe)].join(", ")
            }`,
          );
        }
        const normalizedMemory = {
          type: memory.type,
          summary: memory.summary,
          content: memory.content,
          visibility,
          project_id: memory.project_id ?? null,
          channel_id: memory.channel_id ?? null,
        };
        const normalizedProvenance = { status: provenance.status };
        const artifacts: JsonObject[] = [];
        let embedding: number[];
        try {
          embedding = await getEmbedding(memory.content);
        } catch (error) {
          throw actionable(
            `embedding generation failed — memory was not written: ${
              errorText(error)
            }`,
          );
        }
        const contentHash = await sha256Hex(canonicalJson({
          memory: normalizedMemory,
          provenance: normalizedProvenance,
          source_refs: sourceRefs,
          artifacts,
          created_by,
        }));
        const result = await supabase.rpc("agent_memory_writeback_tx", {
          p_workspace_id: workspace_id,
          p_idempotency_key: idempotency_key,
          p_content_hash: contentHash,
          p_memory: normalizedMemory,
          p_provenance: normalizedProvenance,
          p_source_refs: sourceRefs,
          p_artifacts: artifacts,
          p_created_by: created_by,
          p_request_context: {
            runtime_name: AGENT_MEMORY_RUNTIME,
            schema_version: "openbrain.agent_memory.mcp_writeback.v1",
          },
          p_embedding: embedding,
        });
        if (result.error) {
          if (isOutdatedAgentMemoryWritebackSignature(result.error)) {
            throw actionable(AGENT_MEMORY_WRITEBACK_SCHEMA_OUTDATED_ERROR);
          }
          throw agentMemoryTransactionalRpcError(
            result.error,
            "agent_memory_writeback_tx",
          );
        }
        const response = asMetadata(result.data);
        const memoryResult = isRecord(response.memory)
          ? response.memory
          : response;
        if (typeof memoryResult.id !== "string") {
          throw new Error("agent_memory_writeback_tx returned no memory");
        }
        return toolJson({
          memory: agentMemoryResponse(memoryResult as AgentMemoryRecord),
          idempotent_replay: response.replayed === true ||
            memoryResult.replayed === true,
        });
      } catch (error) {
        return internalToolError("memory_writeback", error);
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
        return internalToolError("memory_usage_report", error);
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
        return internalToolError("memory_review_queue", error);
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
        "Apply a non-promoting logical review transition as an agent. Promotion requires the authenticated REST reviewer interface; no action physically deletes a row.",
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
          ["approve", "confirm", "merge", "supersede"].includes(action)
        ) {
          return toolError(
            "memory_review error: promotion requires an authenticated human reviewer — use the Agent Memory REST reviewer interface. MCP actions are limited to reject, dispute, mark_stale, evidence_only, restrict_scope, and edit (demotes to pending).",
          );
        }
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

        if (related_memory_id === memory_id) {
          return toolError(
            "memory_review error: A memory cannot be related to itself",
          );
        }
        if (content) {
          const unsafe = unsafeAgentMemoryReasons(content);
          if (unsafe.length) {
            return toolError(
              `memory_review error: Unsafe review edit blocked: ${
                unsafe.join(", ")
              }`,
            );
          }
        }
        const result = await supabase.rpc("agent_memory_review_tx", {
          p_memory_id: memory_id,
          p_workspace_id: workspace_id,
          p_action: action,
          p_actor_id: actor_id,
          p_notes: notes ?? null,
          p_related_memory_id: related_memory_id ?? null,
          p_content: content ?? null,
          p_summary: summary ?? null,
          p_visibility: visibility ?? null,
          p_actor_kind: "agent",
        });
        if (result.error) {
          throw agentMemoryTransactionalRpcError(
            result.error,
            "agent_memory_review_tx",
          );
        }
        const response = asMetadata(result.data);
        const memoryResult = isRecord(response.memory)
          ? response.memory
          : response;
        if (typeof memoryResult.id !== "string") {
          throw new Error("agent_memory_review_tx returned no memory");
        }
        return toolJson({
          memory: agentMemoryResponse(memoryResult as AgentMemoryRecord),
          demoted_to_pending: action === "edit",
        });
      } catch (error) {
        return internalToolError("memory_review", error);
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
          semanticWeight: DEFAULT_SEMANTIC_WEIGHT,
          textWeight: DEFAULT_TEXT_WEIGHT,
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
        return internalToolError("Search", error);
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
        const { data, error } = await fetchThoughtForChatGpt(id);
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
        return internalToolError("Fetch", error);
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
        semantic_weight: z.number().default(DEFAULT_SEMANTIC_WEIGHT).optional(),
        text_weight: z.number().default(DEFAULT_TEXT_WEIGHT).optional(),
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
      semantic_weight = DEFAULT_SEMANTIC_WEIGHT,
      text_weight = DEFAULT_TEXT_WEIGHT,
    }) => {
      try {
        const normalizedStartDate = parseDateInput("start_date", start_date);
        const normalizedEndDate = parseDateInput("end_date", end_date);
        const normalizedSemanticWeight = validateRrfWeight(
          "semantic_weight",
          semantic_weight,
        );
        const normalizedTextWeight = validateRrfWeight(
          "text_weight",
          text_weight,
        );
        return toolJson(
          await runSearch({
            query,
            mode,
            limit,
            offset,
            threshold,
            semanticWeight: normalizedSemanticWeight,
            textWeight: normalizedTextWeight,
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
        return internalToolError("search_thoughts", error);
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
        return internalToolError("recall_context", error);
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
        return internalToolError("list_thoughts", error);
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
          throw new Error(`brain_stats_aggregate failed: ${errorText(error)}`);
        }
        return toolJson({
          since_days,
          include_restricted,
          aggregate: data,
        });
      } catch (error) {
        return internalToolError("thought_stats", error);
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
          throw new Error(`connection lookup failed: ${errorText(error)}`);
        }
        const rows = await excludeDeletedConnections(
          (data ?? []) as JsonObject[],
        );
        return toolJson({
          thought_id,
          results: rows.slice(0, limit),
        });
      } catch (error) {
        return internalToolError("related_thoughts", error);
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
            throw new Error("capture_thought_atomic returned no id");
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
          throw new Error(
            `capture_thought_atomic failed: ${errorText(atomicResult.error)}`,
          );
        }

        const { data, error } = await supabase.rpc("upsert_thought", {
          p_content: content,
          p_payload: payload,
        });
        if (error) {
          throw new Error(`upsert_thought failed: ${errorText(error)}`);
        }
        const thoughtId = (data as JsonObject | null)?.id;
        if (typeof thoughtId !== "string") {
          throw new Error("upsert_thought returned no id");
        }
        const embeddingResult = await supabase
          .from("thoughts")
          .update({ embedding: embeddingValue })
          .eq("id", thoughtId);
        if (embeddingResult.error) {
          throw new Error(
            `embedding update failed: ${errorText(embeddingResult.error)}`,
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
        return internalToolError("capture_thought", error);
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
        if (isDeleted(existing as ThoughtRecord)) {
          return toolError(
            `update_thought error: thought ${id} is logically deleted`,
          );
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
        if (error) {
          throw new Error(`thought update failed: ${errorText(error)}`);
        }
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
        return internalToolError("update_thought", error);
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
          isMissingDatabaseObjectError(
            atomicResult.error,
            "soft_delete_thought",
          )
        ) {
          return toolError(`delete_thought error: ${DELETE_RPC_ERROR}`);
        }
        throw new Error(
          `soft_delete_thought failed: ${errorText(atomicResult.error)}`,
        );
      } catch (error) {
        return internalToolError("delete_thought", error);
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

export async function timingSafeEqualStrings(
  a: string,
  b: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const [aDigest, bDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const aBytes = new Uint8Array(aDigest);
  const bBytes = new Uint8Array(bDigest);
  let difference = 0;
  for (let index = 0; index < 32; index++) {
    difference |= aBytes[index] ^ bBytes[index];
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
  const [headerMatches, bearerMatches] = hasConfiguredKey
    ? await Promise.all([
      timingSafeEqualStrings(headerKey, MCP_ACCESS_KEY),
      timingSafeEqualStrings(bearerKey, MCP_ACCESS_KEY),
    ])
    : [false, false];
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
