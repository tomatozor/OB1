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

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const RRF_K = 60;
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
  return asMetadata(row.metadata).deleted === true;
}

function rowType(row: ThoughtRecord): string | null {
  const metadataType = asMetadata(row.metadata).type;
  return row.type ?? (typeof metadataType === "string" ? metadataType : null);
}

function rowSourceType(row: ThoughtRecord): string | null {
  const metadataSourceType = asMetadata(row.metadata).source_type;
  return row.source_type ??
    (typeof metadataSourceType === "string" ? metadataSourceType : null);
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
  const needed = params.offset + params.limit + 1;
  let rows: ThoughtRecord[];
  let source: string = params.mode;

  if (params.mode === "text") {
    rows = (await textCandidates(params.query, needed, params.filters)).slice(
      params.offset,
      params.offset + params.limit,
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
      ).slice(params.offset, params.offset + params.limit);
    } else {
      const candidateCount = Math.min(
        1000,
        Math.max((needed + 1) * 4, 100),
      );
      const hybrid = await retrieveHybrid(
        {
          query: params.query,
          queryEmbedding: embedding,
          limit: params.limit,
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
              0.3,
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
  return {
    mode: params.mode,
    source,
    results: rows.map(serializeSearchRow),
    pagination: {
      offset: params.offset,
      limit: params.limit,
      returned: rows.length,
    },
  };
}

function buildServer(): McpServer {
  const server = new McpServer({
    name: "open-brain",
    version: "2.0.0",
  });

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
              start_date,
              end_date,
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
          .limit(limit);
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
        const results = ((data ?? []) as ThoughtRecord[]).map((row) => ({
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
        const { data, error } = await supabase.rpc("upsert_thought", {
          p_content: content,
          p_payload: { metadata: { ...metadata, source: "mcp" } },
        });
        if (error) return toolError(`Failed to capture: ${error.message}`);
        const thoughtId = (data as JsonObject | null)?.id;
        if (typeof thoughtId !== "string") {
          return toolError("Failed to capture: upsert_thought returned no id");
        }
        const embeddingResult = await supabase
          .from("thoughts")
          .update({ embedding: `[${embedding.join(",")}]` })
          .eq("id", thoughtId);
        if (embeddingResult.error) {
          return toolError(
            `Failed to save embedding: ${embeddingResult.error.message}`,
          );
        }
        return toolJson({ id: thoughtId, captured: true, metadata });
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
        const { data: existing, error: fetchError } = await supabase
          .from("thoughts")
          .select("id, content, metadata, created_at, updated_at")
          .eq("id", id)
          .single();
        if (fetchError || !existing) {
          return toolError(`delete_thought error: thought ${id} not found`);
        }
        const priorMetadata = asMetadata(existing.metadata);
        if (priorMetadata.deleted === true) {
          return toolJson({ id, deleted: true, already_deleted: true });
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

const app = new Hono();

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
