-- OB1 Agent Memory
-- Runtime-neutral sidecar schema for governed agent recall/write-back.
--
-- This migration intentionally keeps public.thoughts as the durable content
-- table. Agent memory metadata, provenance, review, trace, and audit state
-- live in sidecar tables so existing OB1 capture/search behavior keeps working.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'thoughts'
  ) THEN
    RAISE EXCEPTION
      'agent-memory requires public.thoughts. Run docs/01-getting-started.md first.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.agent_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thought_id UUID REFERENCES public.thoughts(id) ON DELETE SET NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT,
  channel_kind TEXT,
  channel_id TEXT,
  channel_thread_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'workspace' CHECK (
    visibility IN ('personal', 'channel', 'project', 'workspace')
  ),
  memory_type TEXT NOT NULL CHECK (
    memory_type IN (
      'decision',
      'output',
      'lesson',
      'constraint',
      'open_question',
      'failure',
      'artifact_reference',
      'work_log'
    )
  ),
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (
    lifecycle_status IN ('active', 'stale', 'superseded', 'disputed', 'rejected')
  ),
  provenance_status TEXT NOT NULL DEFAULT 'generated' CHECK (
    provenance_status IN (
      'observed',
      'inferred',
      'user_confirmed',
      'imported',
      'generated',
      'superseded',
      'disputed'
    )
  ),
  confidence NUMERIC(3,2) NOT NULL DEFAULT 0.50 CHECK (confidence >= 0 AND confidence <= 1),
  created_by TEXT NOT NULL DEFAULT 'agent' CHECK (created_by IN ('user', 'agent', 'system', 'import')),
  runtime_name TEXT,
  runtime_version TEXT,
  provider TEXT,
  model TEXT,
  task_id TEXT,
  flow_id TEXT,
  can_use_as_instruction BOOLEAN NOT NULL DEFAULT false,
  can_use_as_evidence BOOLEAN NOT NULL DEFAULT true,
  requires_user_confirmation BOOLEAN NOT NULL DEFAULT true,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    review_status IN (
      'pending',
      'confirmed',
      'evidence_only',
      'restricted',
      'rejected',
      'stale',
      'merged'
    )
  ),
  last_confirmed_at TIMESTAMPTZ,
  stale_after TIMESTAMPTZ,
  idempotency_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    can_use_as_instruction = false
    OR provenance_status IN ('user_confirmed', 'imported')
  )
);

-- Additive semantic-recall storage. Existing rows remain valid evidence, but
-- every accepted transactional writeback below must supply an embedding.
ALTER TABLE public.agent_memories
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Keep repeat applications aligned with the runtime-neutral four-level scope
-- model, including databases created by an earlier version of this schema.
UPDATE public.agent_memories
  SET idempotency_key = 'legacy:' || id::TEXT
  WHERE idempotency_key IS NULL;
UPDATE public.agent_memories
  SET content_hash = 'legacy:' || id::TEXT
  WHERE content_hash IS NULL;
ALTER TABLE public.agent_memories
  ALTER COLUMN idempotency_key SET NOT NULL,
  ALTER COLUMN content_hash SET NOT NULL;

ALTER TABLE public.agent_memories
  ALTER COLUMN visibility SET DEFAULT 'workspace';
UPDATE public.agent_memories
  SET visibility = 'workspace'
  WHERE visibility = 'organization';
ALTER TABLE public.agent_memories
  DROP CONSTRAINT IF EXISTS agent_memories_visibility_check;
ALTER TABLE public.agent_memories
  ADD CONSTRAINT agent_memories_visibility_check CHECK (
    visibility IN ('personal', 'channel', 'project', 'workspace')
  );

-- origin/main used this name for a global partial unique index. Drop that
-- superseded definition before creating the workspace-scoped replacement.
DROP INDEX IF EXISTS public.idx_agent_memories_idempotency_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_memories_workspace_idempotency_key
  ON public.agent_memories (workspace_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_agent_memories_scope
  ON public.agent_memories (workspace_id, project_id, visibility);

CREATE INDEX IF NOT EXISTS idx_agent_memories_workspace_created
  ON public.agent_memories (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_memories_thought
  ON public.agent_memories (thought_id)
  WHERE thought_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_memories_review
  ON public.agent_memories (review_status, lifecycle_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_memories_lifecycle
  ON public.agent_memories (lifecycle_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_memories_runtime_task
  ON public.agent_memories (runtime_name, task_id, flow_id);

CREATE INDEX IF NOT EXISTS idx_agent_memories_content_hash
  ON public.agent_memories (workspace_id, content_hash)
  WHERE content_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.agent_memory_source_refs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL REFERENCES public.agent_memories(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  uri TEXT,
  title TEXT,
  source_timestamp TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_source_refs_memory
  ON public.agent_memory_source_refs (memory_id);

CREATE TABLE IF NOT EXISTS public.agent_memory_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL REFERENCES public.agent_memories(id) ON DELETE CASCADE,
  artifact_kind TEXT NOT NULL,
  uri TEXT NOT NULL,
  description TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_artifacts_memory
  ON public.agent_memory_artifacts (memory_id);

CREATE TABLE IF NOT EXISTS public.agent_memory_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_memory_id UUID NOT NULL REFERENCES public.agent_memories(id) ON DELETE CASCADE,
  to_memory_id UUID NOT NULL REFERENCES public.agent_memories(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (
    relation IN ('related_to', 'supersedes', 'superseded_by', 'conflicts_with', 'merged_into')
  ),
  confidence NUMERIC(3,2) DEFAULT 0.50 CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_memory_id, to_memory_id, relation),
  CHECK (from_memory_id <> to_memory_id)
);

CREATE TABLE IF NOT EXISTS public.agent_memory_review_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL REFERENCES public.agent_memories(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (
    action IN (
      'confirm',
      'edit',
      'evidence_only',
      'restrict_scope',
      'mark_stale',
      'merge',
      'reject',
      'dispute',
      'supersede'
    )
  ),
  actor_id TEXT,
  actor_label TEXT,
  notes TEXT,
  before JSONB,
  after JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_review_actions_memory
  ON public.agent_memory_review_actions (memory_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.agent_memory_recall_traces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  project_id TEXT,
  runtime_name TEXT,
  runtime_version TEXT,
  task_id TEXT,
  flow_id TEXT,
  channel_kind TEXT,
  channel_id TEXT,
  query TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (request_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_recall_traces_scope
  ON public.agent_memory_recall_traces (workspace_id, project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.agent_memory_recall_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id UUID NOT NULL REFERENCES public.agent_memory_recall_traces(id) ON DELETE CASCADE,
  memory_id UUID NOT NULL REFERENCES public.agent_memories(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  similarity NUMERIC(5,4),
  ranking_score NUMERIC(7,4),
  returned BOOLEAN NOT NULL DEFAULT true,
  used BOOLEAN,
  ignored_reason TEXT,
  use_policy_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (trace_id, memory_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_recall_items_trace
  ON public.agent_memory_recall_items (trace_id, rank);

CREATE TABLE IF NOT EXISTS public.agent_memory_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'recall_requested',
      'memory_returned',
      'memory_used',
      'memory_ignored',
      'memory_written',
      'memory_confirmed',
      'memory_edited',
      'memory_rejected',
      'memory_superseded',
      'memory_disputed'
    )
  ),
  workspace_id TEXT,
  project_id TEXT,
  memory_id UUID REFERENCES public.agent_memories(id) ON DELETE SET NULL,
  trace_id UUID REFERENCES public.agent_memory_recall_traces(id) ON DELETE SET NULL,
  actor_kind TEXT NOT NULL DEFAULT 'system' CHECK (actor_kind IN ('user', 'agent', 'system', 'import')),
  actor_label TEXT,
  runtime_name TEXT,
  task_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_audit_scope
  ON public.agent_memory_audit_events (workspace_id, project_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.agent_memory_audit_lifecycle_change()
RETURNS TRIGGER AS $$
DECLARE
  lifecycle_event TEXT;
BEGIN
  IF current_setting('ob1.agent_memory_skip_lifecycle_audit', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.lifecycle_status IS DISTINCT FROM OLD.lifecycle_status
    AND NEW.lifecycle_status IN ('stale', 'superseded', 'disputed', 'rejected') THEN
    lifecycle_event := CASE NEW.lifecycle_status
      WHEN 'superseded' THEN 'memory_superseded'
      WHEN 'disputed' THEN 'memory_disputed'
      WHEN 'rejected' THEN 'memory_rejected'
      ELSE 'memory_edited'
    END;
    INSERT INTO public.agent_memory_audit_events (
      event_type,
      workspace_id,
      project_id,
      memory_id,
      actor_kind,
      payload
    ) VALUES (
      lifecycle_event,
      NEW.workspace_id,
      NEW.project_id,
      NEW.id,
      'system',
      jsonb_build_object(
        'source', 'lifecycle_trigger',
        'previous_lifecycle_status', OLD.lifecycle_status,
        'lifecycle_status', NEW.lifecycle_status
      )
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.agent_memories_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_agent_memories_updated_at'
      AND tgrelid = 'public.agent_memories'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_agent_memories_updated_at
      BEFORE UPDATE ON public.agent_memories
      FOR EACH ROW EXECUTE FUNCTION public.agent_memories_set_updated_at();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_agent_memory_audit_lifecycle_change'
      AND tgrelid = 'public.agent_memories'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_agent_memory_audit_lifecycle_change
      AFTER UPDATE OF lifecycle_status ON public.agent_memories
      FOR EACH ROW EXECUTE FUNCTION public.agent_memory_audit_lifecycle_change();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.agent_memory_hash_text(p_content TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  RETURN encode(sha256(convert_to(lower(trim(regexp_replace(coalesce(p_content, ''), '\s+', ' ', 'g'))), 'UTF8')), 'hex');
END;
$$;

-- PostgreSQL identifies functions by argument types, so changing a signature
-- creates an overload unless the prior signature is removed explicitly. Keep
-- the upgrade atomic by dropping the pre-embedding overload in this transaction.
DROP FUNCTION IF EXISTS public.agent_memory_writeback_tx(
  TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, JSONB, TEXT, JSONB
);

CREATE OR REPLACE FUNCTION public.agent_memory_writeback_tx(
  p_workspace_id TEXT,
  p_idempotency_key TEXT,
  p_content_hash TEXT,
  p_memory JSONB,
  p_provenance JSONB,
  p_source_refs JSONB DEFAULT '[]'::jsonb,
  p_artifacts JSONB DEFAULT '[]'::jsonb,
  p_created_by TEXT DEFAULT NULL,
  p_request_context JSONB DEFAULT '{}'::jsonb,
  p_embedding vector(1536) DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $agent_memory_writeback_tx$
DECLARE
  v_workspace_id TEXT := nullif(btrim(p_workspace_id), '');
  v_idempotency_key TEXT := nullif(btrim(p_idempotency_key), '');
  v_content_hash TEXT := nullif(btrim(p_content_hash), '');
  v_memory_input JSONB := coalesce(p_memory, '{}'::jsonb);
  v_provenance_input JSONB := coalesce(p_provenance, '{}'::jsonb);
  v_request_context JSONB := coalesce(p_request_context, '{}'::jsonb);
  v_visibility TEXT;
  v_memory_type TEXT;
  v_provenance_status TEXT;
  v_created_by TEXT := coalesce(nullif(btrim(p_created_by), ''), 'agent');
  v_existing public.agent_memories%ROWTYPE;
  v_memory public.agent_memories%ROWTYPE;
BEGIN
  IF p_embedding IS NULL THEN
    RAISE EXCEPTION 'embedding required — a writeback must be semantically recallable'
      USING ERRCODE = '22023';
  END IF;
  IF v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'workspace_id is required' USING ERRCODE = '22023';
  END IF;
  IF v_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'idempotency_key is required' USING ERRCODE = '22023';
  END IF;
  IF v_content_hash IS NULL THEN
    RAISE EXCEPTION 'content_hash is required' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_memory_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'memory must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_provenance_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'provenance must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_request_context) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'request_context must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(coalesce(p_source_refs, '[]'::jsonb)) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'source_refs must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(coalesce(p_artifacts, '[]'::jsonb)) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'artifacts must be a JSON array' USING ERRCODE = '22023';
  END IF;

  v_visibility := coalesce(nullif(btrim(v_memory_input->>'visibility'), ''), 'workspace');
  IF v_visibility NOT IN ('personal', 'channel', 'project', 'workspace') THEN
    RAISE EXCEPTION 'invalid visibility: %', v_visibility USING ERRCODE = '22023';
  END IF;
  IF v_visibility = 'project'
    AND nullif(btrim(coalesce(v_memory_input->>'project_id', v_request_context->>'project_id')), '') IS NULL THEN
    RAISE EXCEPTION 'project visibility requires project_id' USING ERRCODE = '22023';
  END IF;
  IF v_visibility = 'channel'
    AND nullif(btrim(coalesce(v_memory_input->>'channel_id', v_request_context->>'channel_id')), '') IS NULL THEN
    RAISE EXCEPTION 'channel visibility requires channel_id' USING ERRCODE = '22023';
  END IF;

  v_memory_type := nullif(btrim(v_memory_input->>'memory_type'), '');
  IF v_memory_type IS NULL OR v_memory_type NOT IN (
    'decision', 'output', 'lesson', 'constraint', 'open_question',
    'failure', 'artifact_reference', 'work_log'
  ) THEN
    RAISE EXCEPTION 'invalid memory_type: %', coalesce(v_memory_type, '<null>')
      USING ERRCODE = '22023';
  END IF;
  IF nullif(btrim(v_memory_input->>'summary'), '') IS NULL THEN
    RAISE EXCEPTION 'memory summary is required' USING ERRCODE = '22023';
  END IF;
  IF nullif(btrim(v_memory_input->>'content'), '') IS NULL THEN
    RAISE EXCEPTION 'memory content is required' USING ERRCODE = '22023';
  END IF;

  v_provenance_status := coalesce(
    nullif(btrim(v_provenance_input->>'provenance_status'), ''),
    nullif(btrim(v_provenance_input->>'default_status'), ''),
    'generated'
  );
  IF v_provenance_status NOT IN ('observed', 'inferred', 'generated') THEN
    RAISE EXCEPTION 'invalid writeback provenance_status: %', v_provenance_status
      USING ERRCODE = '22023';
  END IF;
  IF v_created_by NOT IN ('user', 'agent', 'system', 'import') THEN
    RAISE EXCEPTION 'invalid created_by: %', v_created_by USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_workspace_id || E'\x1f' || v_idempotency_key, 0)
  );

  SELECT *
  INTO v_existing
  FROM public.agent_memories
  WHERE workspace_id = v_workspace_id
    AND idempotency_key = v_idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.content_hash = v_content_hash THEN
      IF v_existing.embedding IS NULL THEN
        UPDATE public.agent_memories
        SET embedding = p_embedding
        WHERE id = v_existing.id
          AND workspace_id = v_workspace_id
        RETURNING * INTO v_existing;
      END IF;
      RETURN to_jsonb(v_existing) || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'idempotency key already used with different content hash'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.agent_memories (
    thought_id,
    workspace_id,
    project_id,
    channel_kind,
    channel_id,
    channel_thread_id,
    visibility,
    memory_type,
    summary,
    content,
    lifecycle_status,
    provenance_status,
    confidence,
    created_by,
    runtime_name,
    runtime_version,
    provider,
    model,
    task_id,
    flow_id,
    can_use_as_instruction,
    can_use_as_evidence,
    requires_user_confirmation,
    review_status,
    stale_after,
    idempotency_key,
    content_hash,
    embedding,
    metadata
  ) VALUES (
    nullif(v_memory_input->>'thought_id', '')::UUID,
    v_workspace_id,
    nullif(btrim(coalesce(v_memory_input->>'project_id', v_request_context->>'project_id')), ''),
    nullif(btrim(coalesce(v_memory_input->>'channel_kind', v_request_context->>'channel_kind')), ''),
    nullif(btrim(coalesce(v_memory_input->>'channel_id', v_request_context->>'channel_id')), ''),
    nullif(btrim(coalesce(v_memory_input->>'channel_thread_id', v_request_context->>'channel_thread_id')), ''),
    v_visibility,
    v_memory_type,
    btrim(v_memory_input->>'summary'),
    btrim(v_memory_input->>'content'),
    'active',
    v_provenance_status,
    coalesce(nullif(v_provenance_input->>'confidence', '')::NUMERIC, 0.50),
    v_created_by,
    nullif(btrim(coalesce(v_memory_input->>'runtime_name', v_request_context->>'runtime_name')), ''),
    nullif(btrim(coalesce(v_memory_input->>'runtime_version', v_request_context->>'runtime_version')), ''),
    nullif(btrim(coalesce(v_memory_input->>'provider', v_request_context->>'provider')), ''),
    nullif(btrim(coalesce(v_memory_input->>'model', v_request_context->>'model')), ''),
    nullif(btrim(coalesce(v_memory_input->>'task_id', v_request_context->>'task_id')), ''),
    nullif(btrim(coalesce(v_memory_input->>'flow_id', v_request_context->>'flow_id')), ''),
    false,
    true,
    true,
    'pending',
    nullif(v_memory_input->>'stale_after', '')::TIMESTAMPTZ,
    v_idempotency_key,
    v_content_hash,
    p_embedding,
    coalesce(v_memory_input->'metadata', '{}'::jsonb)
      || jsonb_build_object(
        'provenance', v_provenance_input,
        'request_context', v_request_context
      )
  )
  RETURNING * INTO v_memory;

  INSERT INTO public.agent_memory_source_refs (
    memory_id, source_kind, uri, title, source_timestamp, metadata
  )
  SELECT
    v_memory.id,
    coalesce(nullif(btrim(item->>'source_kind'), ''), nullif(btrim(item->>'kind'), '')),
    nullif(btrim(item->>'uri'), ''),
    nullif(btrim(item->>'title'), ''),
    nullif(coalesce(item->>'source_timestamp', item->>'timestamp'), '')::TIMESTAMPTZ,
    coalesce(item->'metadata', '{}'::jsonb)
  FROM jsonb_array_elements(coalesce(p_source_refs, '[]'::jsonb)) AS source(item);

  INSERT INTO public.agent_memory_artifacts (
    memory_id, artifact_kind, uri, description, metadata
  )
  SELECT
    v_memory.id,
    coalesce(nullif(btrim(item->>'artifact_kind'), ''), nullif(btrim(item->>'kind'), '')),
    nullif(btrim(item->>'uri'), ''),
    nullif(btrim(item->>'description'), ''),
    coalesce(item->'metadata', '{}'::jsonb)
  FROM jsonb_array_elements(coalesce(p_artifacts, '[]'::jsonb)) AS artifact(item);

  INSERT INTO public.agent_memory_audit_events (
    event_type,
    workspace_id,
    project_id,
    memory_id,
    actor_kind,
    actor_label,
    runtime_name,
    task_id,
    payload
  ) VALUES (
    'memory_written',
    v_memory.workspace_id,
    v_memory.project_id,
    v_memory.id,
    v_created_by,
    nullif(btrim(v_request_context->>'actor_label'), ''),
    v_memory.runtime_name,
    v_memory.task_id,
    jsonb_build_object(
      'idempotency_key', v_idempotency_key,
      'content_hash', v_content_hash,
      'provenance_status', v_provenance_status,
      'review_status', 'pending'
    )
  );

  RETURN to_jsonb(v_memory) || jsonb_build_object('replayed', false);
END;
$agent_memory_writeback_tx$;

CREATE OR REPLACE FUNCTION public.agent_memory_match(
  p_workspace_id TEXT,
  p_query_embedding vector(1536),
  p_limit INT DEFAULT 20,
  p_threshold DOUBLE PRECISION DEFAULT NULL
)
RETURNS TABLE(memory_id UUID, similarity DOUBLE PRECISION)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $agent_memory_match$
DECLARE
  v_workspace_id TEXT := nullif(btrim(p_workspace_id), '');
  v_limit INT := coalesce(p_limit, 20);
BEGIN
  IF v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'workspace_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_query_embedding IS NULL THEN
    RAISE EXCEPTION 'query_embedding is required' USING ERRCODE = '22023';
  END IF;
  IF v_limit < 1 THEN
    RAISE EXCEPTION 'limit must be greater than zero' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT
    candidate.id,
    (1 - (candidate.embedding <=> p_query_embedding))::DOUBLE PRECISION
  FROM public.agent_memories AS candidate
  WHERE candidate.workspace_id = v_workspace_id
    AND candidate.embedding IS NOT NULL
    AND candidate.lifecycle_status NOT IN ('rejected', 'superseded')
    AND (
      p_threshold IS NULL
      OR (1 - (candidate.embedding <=> p_query_embedding)) >= p_threshold
    )
  ORDER BY candidate.embedding <=> p_query_embedding, candidate.id
  LIMIT least(v_limit, 5000);
END;
$agent_memory_match$;

CREATE OR REPLACE FUNCTION public.agent_memory_writeback_batch_tx(
  p_workspace_id TEXT,
  p_items JSONB,
  p_created_by TEXT DEFAULT NULL,
  p_request_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $agent_memory_writeback_batch_tx$
DECLARE
  v_workspace_id TEXT := nullif(btrim(p_workspace_id), '');
  v_request_context JSONB := coalesce(p_request_context, '{}'::jsonb);
  v_item JSONB;
  v_item_number INT := 0;
  v_idempotency_key TEXT;
  v_content_hash TEXT;
  v_embedding vector(1536);
  v_existing public.agent_memories%ROWTYPE;
  v_result JSONB;
  v_results JSONB := '[]'::jsonb;
BEGIN
  IF v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'workspace_id is required' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'items must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_request_context) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'request_context must be a JSON object' USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    v_item_number := v_item_number + 1;
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'batch item % must be a JSON object', v_item_number
        USING ERRCODE = '22023';
    END IF;

    v_idempotency_key := nullif(btrim(v_item->>'idempotency_key'), '');
    v_content_hash := nullif(btrim(v_item->>'content_hash'), '');
    IF v_idempotency_key IS NULL THEN
      RAISE EXCEPTION 'batch item % idempotency_key is required', v_item_number
        USING ERRCODE = '22023';
    END IF;
    IF v_content_hash IS NULL THEN
      RAISE EXCEPTION 'batch item % content_hash is required', v_item_number
        USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(
      hashtextextended(v_workspace_id || E'\x1f' || v_idempotency_key, 0)
    );
    SELECT *
    INTO v_existing
    FROM public.agent_memories
    WHERE workspace_id = v_workspace_id
      AND idempotency_key = v_idempotency_key
    FOR UPDATE;

    IF FOUND THEN
      IF v_existing.content_hash <> v_content_hash THEN
        RAISE EXCEPTION 'idempotency key already used with different content hash'
          USING ERRCODE = '23505';
      END IF;
      IF v_existing.embedding IS NULL THEN
        RAISE EXCEPTION
          'embedding required — batch replay item % has no existing semantic embedding',
          v_item_number USING ERRCODE = '22023';
      END IF;
      -- A replay is governed by the already persisted embedding, even when the
      -- caller omitted or supplied a malformed embedding in this batch item.
      v_embedding := v_existing.embedding;
    ELSE
      IF jsonb_typeof(v_item->'embedding') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'embedding required — batch item % must contain 1536 numbers',
          v_item_number USING ERRCODE = '22023';
      END IF;
      IF jsonb_array_length(v_item->'embedding') <> 1536 THEN
        RAISE EXCEPTION 'embedding required — batch item % must contain 1536 numbers',
          v_item_number USING ERRCODE = '22023';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_item->'embedding') AS dimension(value)
        WHERE jsonb_typeof(dimension.value) IS DISTINCT FROM 'number'
      ) THEN
        RAISE EXCEPTION 'embedding required — batch item % must contain 1536 numbers',
          v_item_number USING ERRCODE = '22023';
      END IF;
      BEGIN
        v_embedding := (v_item->'embedding')::TEXT::vector(1536);
      EXCEPTION
        WHEN OTHERS THEN
          RAISE EXCEPTION 'embedding required — batch item % must contain 1536 numbers',
            v_item_number USING ERRCODE = '22023';
      END;
    END IF;

    v_result := public.agent_memory_writeback_tx(
      v_workspace_id,
      v_idempotency_key,
      v_content_hash,
      v_item->'memory',
      v_item->'provenance',
      coalesce(v_item->'source_refs', '[]'::jsonb),
      coalesce(v_item->'artifacts', '[]'::jsonb),
      p_created_by,
      v_request_context,
      v_embedding
    );
    v_results := v_results || jsonb_build_array(v_result);
  END LOOP;

  RETURN jsonb_build_object('count', v_item_number, 'items', v_results);
END;
$agent_memory_writeback_batch_tx$;

-- Remove the pre-authority overload transactionally before installing the
-- actor-kind signature, avoiding ambiguous default-argument resolution.
DROP FUNCTION IF EXISTS public.agent_memory_review_tx(
  UUID, TEXT, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT
);

CREATE OR REPLACE FUNCTION public.agent_memory_review_tx(
  p_memory_id UUID,
  p_workspace_id TEXT,
  p_action TEXT,
  p_actor_id TEXT,
  p_notes TEXT DEFAULT NULL,
  p_related_memory_id UUID DEFAULT NULL,
  p_content TEXT DEFAULT NULL,
  p_summary TEXT DEFAULT NULL,
  p_visibility TEXT DEFAULT NULL,
  p_actor_kind TEXT DEFAULT 'agent'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $agent_memory_review_tx$
DECLARE
  v_workspace_id TEXT := nullif(btrim(p_workspace_id), '');
  v_action TEXT := lower(nullif(btrim(p_action), ''));
  v_actor_id TEXT := nullif(btrim(p_actor_id), '');
  v_actor_kind TEXT := lower(nullif(btrim(p_actor_kind), ''));
  v_visibility TEXT := lower(nullif(btrim(p_visibility), ''));
  v_before JSONB;
  v_memory public.agent_memories%ROWTYPE;
  v_after public.agent_memories%ROWTYPE;
  v_related_id UUID;
  v_current_scope_rank INT;
  v_new_scope_rank INT;
  v_event_type TEXT;
BEGIN
  IF v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'workspace_id is required' USING ERRCODE = '22023';
  END IF;
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'actor_id is required' USING ERRCODE = '22023';
  END IF;
  IF v_actor_kind IS NULL OR v_actor_kind NOT IN ('agent', 'human') THEN
    RAISE EXCEPTION 'actor_kind must be agent or human' USING ERRCODE = '22023';
  END IF;
  IF v_action = 'approve' THEN
    v_action := 'confirm';
  END IF;
  IF v_action IS NULL OR v_action NOT IN (
    'confirm', 'evidence_only', 'edit', 'restrict_scope', 'mark_stale',
    'merge', 'supersede', 'reject', 'dispute'
  ) THEN
    RAISE EXCEPTION 'invalid review action: %', coalesce(v_action, '<null>')
      USING ERRCODE = '22023';
  END IF;
  IF v_action IN ('confirm', 'merge', 'supersede') AND v_actor_kind <> 'human' THEN
    RAISE EXCEPTION 'action % requires actor_kind human', v_action
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO v_memory
  FROM public.agent_memories
  WHERE id = p_memory_id
    AND workspace_id = v_workspace_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found in workspace' USING ERRCODE = 'P0002';
  END IF;
  v_before := to_jsonb(v_memory);

  IF v_memory.lifecycle_status <> 'active' THEN
    RAISE EXCEPTION 'invalid transition: action % requires active memory, found %',
      v_action, v_memory.lifecycle_status USING ERRCODE = '22023';
  END IF;

  IF v_action = 'confirm' AND v_memory.review_status NOT IN ('pending', 'evidence_only', 'restricted') THEN
    RAISE EXCEPTION 'invalid transition: cannot confirm review_status %', v_memory.review_status
      USING ERRCODE = '22023';
  END IF;
  IF v_action = 'evidence_only' AND v_memory.review_status NOT IN ('pending', 'confirmed', 'restricted') THEN
    RAISE EXCEPTION 'invalid transition: cannot mark review_status % evidence-only', v_memory.review_status
      USING ERRCODE = '22023';
  END IF;
  IF v_action = 'edit'
    AND nullif(btrim(p_content), '') IS NULL
    AND nullif(btrim(p_summary), '') IS NULL THEN
    RAISE EXCEPTION 'edit requires content or summary' USING ERRCODE = '22023';
  END IF;

  IF v_action = 'restrict_scope' THEN
    IF v_visibility IS NULL OR v_visibility NOT IN ('personal', 'channel', 'project', 'workspace') THEN
      RAISE EXCEPTION 'restrict_scope requires a valid visibility' USING ERRCODE = '22023';
    END IF;
    v_current_scope_rank := CASE v_memory.visibility
      WHEN 'workspace' THEN 4 WHEN 'project' THEN 3 WHEN 'channel' THEN 2 WHEN 'personal' THEN 1
    END;
    v_new_scope_rank := CASE v_visibility
      WHEN 'workspace' THEN 4 WHEN 'project' THEN 3 WHEN 'channel' THEN 2 WHEN 'personal' THEN 1
    END;
    IF v_new_scope_rank > v_current_scope_rank THEN
      RAISE EXCEPTION 'restrict_scope may not widen the existing visibility'
        USING ERRCODE = '22023';
    END IF;
    IF v_visibility = 'project' AND v_memory.project_id IS NULL THEN
      RAISE EXCEPTION 'project visibility requires project_id' USING ERRCODE = '22023';
    END IF;
    IF v_visibility = 'channel' AND v_memory.channel_id IS NULL THEN
      RAISE EXCEPTION 'channel visibility requires channel_id' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_action IN ('merge', 'supersede') THEN
    IF p_related_memory_id IS NULL OR p_related_memory_id = p_memory_id THEN
      RAISE EXCEPTION '% requires a different related_memory_id', v_action
        USING ERRCODE = '22023';
    END IF;
    SELECT id
    INTO v_related_id
    FROM public.agent_memories
    WHERE id = p_related_memory_id
      AND workspace_id = v_workspace_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'related memory not found in workspace' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  PERFORM set_config('ob1.agent_memory_skip_lifecycle_audit', 'on', true);

  UPDATE public.agent_memories
  SET review_status = CASE v_action
        WHEN 'confirm' THEN 'confirmed'
        WHEN 'evidence_only' THEN 'evidence_only'
        WHEN 'edit' THEN CASE
          WHEN v_actor_kind = 'agent'
            AND (v_memory.review_status = 'confirmed' OR v_memory.can_use_as_instruction)
            THEN 'pending'
          ELSE review_status
        END
        WHEN 'restrict_scope' THEN 'restricted'
        WHEN 'mark_stale' THEN 'stale'
        WHEN 'merge' THEN 'merged'
        WHEN 'supersede' THEN 'stale'
        WHEN 'reject' THEN 'rejected'
        ELSE review_status
      END,
      lifecycle_status = CASE v_action
        WHEN 'mark_stale' THEN 'stale'
        WHEN 'merge' THEN 'superseded'
        WHEN 'supersede' THEN 'superseded'
        WHEN 'reject' THEN 'rejected'
        WHEN 'dispute' THEN 'disputed'
        ELSE lifecycle_status
      END,
      provenance_status = CASE v_action
        WHEN 'confirm' THEN 'user_confirmed'
        WHEN 'dispute' THEN 'disputed'
        ELSE provenance_status
      END,
      can_use_as_instruction = CASE
        WHEN v_action = 'confirm' THEN true
        WHEN v_action = 'edit'
          AND v_actor_kind = 'agent'
          AND (v_memory.review_status = 'confirmed' OR v_memory.can_use_as_instruction)
          THEN false
        WHEN v_action IN ('evidence_only', 'mark_stale', 'merge', 'supersede', 'reject', 'dispute') THEN false
        ELSE can_use_as_instruction
      END,
      can_use_as_evidence = CASE
        WHEN v_action IN ('merge', 'supersede', 'reject', 'dispute') THEN false
        WHEN v_action = 'evidence_only' THEN true
        ELSE can_use_as_evidence
      END,
      requires_user_confirmation = CASE
        WHEN v_action IN ('confirm', 'evidence_only', 'merge', 'supersede') THEN false
        WHEN v_action = 'edit'
          AND v_actor_kind = 'agent'
          AND (v_memory.review_status = 'confirmed' OR v_memory.can_use_as_instruction)
          THEN true
        WHEN v_action = 'dispute' THEN true
        ELSE requires_user_confirmation
      END,
      last_confirmed_at = CASE WHEN v_action = 'confirm' THEN now() ELSE last_confirmed_at END,
      content = CASE WHEN v_action = 'edit' AND nullif(btrim(p_content), '') IS NOT NULL
        THEN btrim(p_content) ELSE content END,
      summary = CASE WHEN v_action = 'edit' AND nullif(btrim(p_summary), '') IS NOT NULL
        THEN btrim(p_summary) ELSE summary END,
      content_hash = CASE WHEN v_action = 'edit' AND nullif(btrim(p_content), '') IS NOT NULL
        THEN public.agent_memory_hash_text(memory_type || ':' || btrim(p_content)) ELSE content_hash END,
      visibility = CASE WHEN v_action = 'restrict_scope' THEN v_visibility ELSE visibility END
  WHERE id = p_memory_id
    AND workspace_id = v_workspace_id
  RETURNING * INTO v_after;

  PERFORM set_config('ob1.agent_memory_skip_lifecycle_audit', 'off', true);

  INSERT INTO public.agent_memory_review_actions (
    memory_id, action, actor_id, notes, before, after
  ) VALUES (
    p_memory_id, v_action, v_actor_id, p_notes, v_before, to_jsonb(v_after)
  );

  IF v_action IN ('merge', 'supersede') THEN
    INSERT INTO public.agent_memory_relations (
      from_memory_id, to_memory_id, relation, confidence
    ) VALUES (
      p_memory_id,
      v_related_id,
      CASE WHEN v_action = 'merge' THEN 'merged_into' ELSE 'superseded_by' END,
      1
    );
  END IF;

  v_event_type := CASE v_action
    WHEN 'confirm' THEN 'memory_confirmed'
    WHEN 'reject' THEN 'memory_rejected'
    WHEN 'merge' THEN 'memory_superseded'
    WHEN 'supersede' THEN 'memory_superseded'
    WHEN 'dispute' THEN 'memory_disputed'
    ELSE 'memory_edited'
  END;

  INSERT INTO public.agent_memory_audit_events (
    event_type,
    workspace_id,
    project_id,
    memory_id,
    actor_kind,
    actor_label,
    runtime_name,
    task_id,
    payload
  ) VALUES (
    v_event_type,
    v_after.workspace_id,
    v_after.project_id,
    v_after.id,
    CASE WHEN v_actor_kind = 'human' THEN 'user' ELSE 'agent' END,
    v_actor_id,
    v_after.runtime_name,
    v_after.task_id,
    jsonb_build_object(
      'action', v_action,
      'actor_kind', v_actor_kind,
      'instruction_grade_reset',
        v_action = 'edit'
        AND v_actor_kind = 'agent'
        AND (v_memory.review_status = 'confirmed' OR v_memory.can_use_as_instruction),
      'notes', p_notes,
      'related_memory_id', p_related_memory_id,
      'before_review_status', v_memory.review_status,
      'after_review_status', v_after.review_status,
      'before_lifecycle_status', v_memory.lifecycle_status,
      'after_lifecycle_status', v_after.lifecycle_status
    )
  );

  RETURN jsonb_build_object('memory', to_jsonb(v_after), 'action', v_action);
END;
$agent_memory_review_tx$;

ALTER TABLE public.agent_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_source_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_review_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_recall_traces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_recall_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_audit_events ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  table_name TEXT;
  policy_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'agent_memories',
    'agent_memory_source_refs',
    'agent_memory_artifacts',
    'agent_memory_relations',
    'agent_memory_review_actions',
    'agent_memory_recall_traces',
    'agent_memory_recall_items',
    'agent_memory_audit_events'
  ] LOOP
    policy_name := table_name || '_service_role_all';
    IF NOT EXISTS (
      SELECT 1
      FROM pg_policies AS existing_policy
      WHERE existing_policy.schemaname = 'public'
        AND existing_policy.tablename = table_name
        AND existing_policy.policyname = policy_name
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
        policy_name,
        table_name
      );
    END IF;
  END LOOP;
END $$;

-- The public API exposes lifecycle updates, never physical row deletion.
-- Accordingly, the service role receives no DELETE grant on these tables.
REVOKE DELETE ON TABLE public.agent_memories FROM service_role;
REVOKE DELETE ON TABLE public.agent_memory_source_refs FROM service_role;
REVOKE DELETE ON TABLE public.agent_memory_artifacts FROM service_role;
REVOKE DELETE ON TABLE public.agent_memory_relations FROM service_role;
REVOKE DELETE ON TABLE public.agent_memory_review_actions FROM service_role;
REVOKE DELETE ON TABLE public.agent_memory_recall_traces FROM service_role;
REVOKE DELETE ON TABLE public.agent_memory_recall_items FROM service_role;
REVOKE DELETE ON TABLE public.agent_memory_audit_events FROM service_role;

GRANT SELECT, INSERT, UPDATE ON TABLE public.agent_memories TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.agent_memory_source_refs TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.agent_memory_artifacts TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.agent_memory_relations TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.agent_memory_review_actions TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.agent_memory_recall_traces TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.agent_memory_recall_items TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.agent_memory_audit_events TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_memory_hash_text(TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.agent_memory_writeback_tx(
  TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, JSONB, TEXT, JSONB, vector
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agent_memory_writeback_tx(
  TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, JSONB, TEXT, JSONB, vector
) FROM authenticated;
REVOKE ALL ON FUNCTION public.agent_memory_writeback_batch_tx(
  TEXT, JSONB, TEXT, JSONB
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agent_memory_writeback_batch_tx(
  TEXT, JSONB, TEXT, JSONB
) FROM authenticated;
REVOKE ALL ON FUNCTION public.agent_memory_match(
  TEXT, vector, INT, DOUBLE PRECISION
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agent_memory_match(
  TEXT, vector, INT, DOUBLE PRECISION
) FROM authenticated;
REVOKE ALL ON FUNCTION public.agent_memory_review_tx(
  UUID, TEXT, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agent_memory_review_tx(
  UUID, TEXT, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.agent_memory_writeback_tx(
  TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, JSONB, TEXT, JSONB, vector
) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_memory_writeback_batch_tx(
  TEXT, JSONB, TEXT, JSONB
) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_memory_match(
  TEXT, vector, INT, DOUBLE PRECISION
) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_memory_review_tx(
  UUID, TEXT, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT
) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
