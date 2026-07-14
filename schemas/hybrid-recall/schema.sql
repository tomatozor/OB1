-- ============================================================
-- Hybrid Recall for Open Brain
--
-- Data-additive, idempotent SQL for hybrid RRF retrieval, atomic capture,
-- source backfill, logical deletion, append-only audit, and exact stats.
-- Existing thoughts columns and the canonical upsert_thought RPC are not
-- removed or replaced; superseded Hybrid Recall overloads are replaced below.
-- ============================================================

BEGIN;

SET search_path TO public, extensions;

-- ============================================================
-- 1. SEARCH INDEXES
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_thoughts_content_trgm
  ON public.thoughts
  USING gin (content gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_thoughts_created_at_desc
  ON public.thoughts (created_at DESC);

COMMENT ON INDEX public.idx_thoughts_content_trgm IS
  'Trigram GIN index for fast content ILIKE and fuzzy text lookup.';

COMMENT ON INDEX public.idx_thoughts_created_at_desc IS
  'Descending creation-time index for recent-thought filters and ordering.';

-- Optional production tuning (NOT enabled by default):
-- Building HNSW can be CPU-, memory-, I/O-, and lock-intensive on a large
-- thoughts table. Schedule and measure the build before enabling it.
-- CREATE INDEX CONCURRENTLY idx_thoughts_embedding_hnsw
--   ON public.thoughts USING hnsw (embedding vector_cosine_ops);

-- ============================================================
-- 2. APPEND-ONLY AUDIT
--
-- No foreign key by design: audit records must outlive their thought.
-- The ADD COLUMN guards let this helper coexist with older installations
-- of schemas/thought-audit without changing their existing columns.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.thought_audit (
  id          BIGSERIAL PRIMARY KEY,
  thought_id  UUID        NOT NULL,
  action      TEXT        NOT NULL
    CHECK (action IN ('capture', 'update', 'delete', 'restore')),
  actor       TEXT,
  session_id  TEXT,
  diff        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.thought_audit
  ADD COLUMN IF NOT EXISTS actor TEXT;

ALTER TABLE public.thought_audit
  ADD COLUMN IF NOT EXISTS session_id TEXT;

-- Upgrade : les installations antérieures (schemas/thought-audit) portent un
-- CHECK sans le verbe 'restore'. On élargit la contrainte historique, sinon
-- les restaurations seraient journalisées en 'update' dégradé.
DO $widen_audit_action_check$
DECLARE
  v_conname TEXT;
BEGIN
  FOR v_conname IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.thought_audit'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%action%'
      AND pg_get_constraintdef(oid) NOT LIKE '%restore%'
  LOOP
    EXECUTE format('ALTER TABLE public.thought_audit DROP CONSTRAINT %I', v_conname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.thought_audit'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%action%'
  ) THEN
    ALTER TABLE public.thought_audit
      ADD CONSTRAINT thought_audit_action_widened_check
      CHECK (action IN ('capture', 'update', 'delete', 'restore'));
  END IF;
END
$widen_audit_action_check$;

CREATE INDEX IF NOT EXISTS idx_thought_audit_thought_created
  ON public.thought_audit (thought_id, created_at DESC);

COMMENT ON TABLE public.thought_audit IS
  'Append-only logical mutation history. No foreign key so history survives removal of a source thought.';

ALTER TABLE public.thought_audit ENABLE ROW LEVEL SECURITY;

REVOKE UPDATE, DELETE ON TABLE public.thought_audit FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE public.thought_audit TO service_role;

DO $grant_audit_sequence$
BEGIN
  IF to_regclass('public.thought_audit_id_seq') IS NOT NULL THEN
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.thought_audit_id_seq TO service_role';
  END IF;
END
$grant_audit_sequence$;

CREATE OR REPLACE FUNCTION public.log_thought_audit(
  p_thought_id UUID,
  p_action TEXT,
  p_actor TEXT,
  p_diff JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_diff JSONB := coalesce(p_diff, '{}'::jsonb);
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('capture', 'update', 'delete', 'restore') THEN
    RAISE EXCEPTION 'invalid thought audit action: %', p_action
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    INSERT INTO public.thought_audit (thought_id, action, actor, session_id, diff)
    VALUES (
      p_thought_id,
      p_action,
      nullif(btrim(p_actor), ''),
      nullif(v_diff->>'session_id', ''),
      v_diff
    );
  EXCEPTION
    WHEN check_violation THEN
      -- Compatibility with the earlier schemas/thought-audit action check,
      -- which predates the restore verb. Preserve the logical verb in diff.
      IF p_action <> 'restore' THEN
        RAISE;
      END IF;

      INSERT INTO public.thought_audit (thought_id, action, actor, session_id, diff)
      VALUES (
        p_thought_id,
        'update',
        nullif(btrim(p_actor), ''),
        nullif(v_diff->>'session_id', ''),
        v_diff || jsonb_build_object('logical_action', 'restore')
      );
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.log_thought_audit(UUID, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.log_thought_audit(UUID, TEXT, TEXT, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.log_thought_audit(UUID, TEXT, TEXT, JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.audit_thought_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_action TEXT;
  v_actor TEXT;
  v_diff JSONB := '{}'::jsonb;
  v_metadata_keys TEXT[] := ARRAY[]::TEXT[];
  v_was_deleted BOOLEAN;
  v_is_deleted BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'capture';
    IF nullif(btrim(NEW.metadata->>'author_session_id'), '') IS NOT NULL THEN
      v_diff := jsonb_build_object(
        'session_id',
        nullif(btrim(NEW.metadata->>'author_session_id'), '')
      );
    END IF;
    v_actor := coalesce(
      nullif(current_setting('ob1.audit_actor', true), ''),
      nullif(btrim(NEW.metadata->>'source'), ''),
      'database-trigger'
    );
  ELSE
    v_was_deleted := lower(coalesce(OLD.metadata->>'deleted', 'false')) = 'true';
    v_is_deleted := lower(coalesce(NEW.metadata->>'deleted', 'false')) = 'true';

    IF NOT v_was_deleted AND v_is_deleted THEN
      v_action := 'delete';
    ELSIF v_was_deleted AND NOT v_is_deleted THEN
      v_action := 'restore';
    ELSE
      v_action := 'update';
    END IF;

    IF OLD.content IS DISTINCT FROM NEW.content THEN
      v_diff := v_diff || jsonb_build_object('content_changed', true);
    END IF;

    SELECT coalesce(array_agg(changed.key ORDER BY changed.key), ARRAY[]::TEXT[])
    INTO v_metadata_keys
    FROM (
      SELECT key
      FROM jsonb_object_keys(
        coalesce(OLD.metadata, '{}'::jsonb) || coalesce(NEW.metadata, '{}'::jsonb)
      ) AS keys(key)
      WHERE OLD.metadata->key IS DISTINCT FROM NEW.metadata->key
    ) AS changed;

    IF cardinality(v_metadata_keys) > 0 THEN
      v_diff := v_diff || jsonb_build_object('metadata_keys_changed', v_metadata_keys);
    END IF;

    IF OLD.embedding IS DISTINCT FROM NEW.embedding THEN
      v_diff := v_diff || jsonb_build_object('embedding_set', NEW.embedding IS NOT NULL);
    END IF;

    v_actor := coalesce(
      nullif(current_setting('ob1.audit_actor', true), ''),
      CASE
        WHEN v_action = 'delete' THEN nullif(btrim(NEW.metadata->>'deleted_by'), '')
        ELSE NULL
      END,
      nullif(btrim(NEW.metadata->>'source'), ''),
      'database-trigger'
    );
  END IF;

  PERFORM public.log_thought_audit(NEW.id, v_action, v_actor, v_diff);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_thought_mutation() FROM PUBLIC;

CREATE OR REPLACE TRIGGER trg_thoughts_audit_mutation
AFTER INSERT OR UPDATE ON public.thoughts
FOR EACH ROW
EXECUTE FUNCTION public.audit_thought_mutation();

-- ============================================================
-- 3. HYBRID RRF SEARCH
--
-- Reciprocal Rank Fusion deliberately combines ranks, not raw cosine and
-- ts_rank values, so neither retrieval system's score scale dominates. The
-- lexical-priority 2:1 default is baseline-derived from 21 real cases measured
-- on 2026-07-14 and must be revalidated out of sample.
-- Candidate pools are bounded at 5,000 rows per retrieval path.
-- ============================================================

-- Replacing the seven-argument overload avoids leaving a stale legacy RPC.
DROP FUNCTION IF EXISTS public.hybrid_search_thoughts(
  TEXT, vector(1536), INT, INT, JSONB, BOOLEAN, INT
);

-- Replacing the eight-argument overload is part of the same global migration
-- transaction, so callers never observe a committed signature gap.
DROP FUNCTION IF EXISTS public.hybrid_search_thoughts(
  TEXT, vector(1536), INT, INT, JSONB, BOOLEAN, INT, DOUBLE PRECISION
);

CREATE OR REPLACE FUNCTION public.hybrid_search_thoughts(
  p_query TEXT,
  p_query_embedding vector(1536),
  p_limit INT DEFAULT 10,
  p_offset INT DEFAULT 0,
  p_filter JSONB DEFAULT '{}'::jsonb,
  p_include_restricted BOOLEAN DEFAULT false,
  p_rrf_k INT DEFAULT 60,
  p_semantic_threshold DOUBLE PRECISION DEFAULT NULL,
  p_semantic_weight DOUBLE PRECISION DEFAULT 1.0,
  p_text_weight DOUBLE PRECISION DEFAULT 2.0
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ,
  type TEXT,
  importance SMALLINT,
  rrf_score DOUBLE PRECISION,
  semantic_rank INT,
  text_rank INT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
SET statement_timeout = '25s'
AS $$
BEGIN
  IF p_semantic_weight IS NULL OR
     NOT (p_semantic_weight > 0.0 AND p_semantic_weight < 'Infinity'::DOUBLE PRECISION) THEN
    RAISE EXCEPTION 'p_semantic_weight must be finite and > 0'
      USING ERRCODE = '22023';
  END IF;

  IF p_text_weight IS NULL OR
     NOT (p_text_weight > 0.0 AND p_text_weight < 'Infinity'::DOUBLE PRECISION) THEN
    RAISE EXCEPTION 'p_text_weight must be finite and > 0'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH parameters AS (
    SELECT
      greatest(1, least(coalesce(p_limit, 10), 100)) AS result_limit,
      greatest(0, coalesce(p_offset, 0)) AS result_offset,
      greatest(1, coalesce(p_rrf_k, 60)) AS rrf_k,
      p_semantic_weight AS semantic_weight,
      p_text_weight AS text_weight,
      least(
        5000,
        greatest(
          50,
          (greatest(0, coalesce(p_offset, 0))
            + greatest(1, least(coalesce(p_limit, 10), 100))) * 5
        )
      ) AS candidate_limit,
      coalesce(p_filter, '{}'::jsonb) AS filter_value,
      websearch_to_tsquery('simple', btrim(coalesce(p_query, ''))) AS text_query
  ),
  semantic_candidates AS (
    SELECT
      candidate.id,
      row_number() OVER (
        ORDER BY candidate.distance, candidate.created_at DESC, candidate.id
      )::INT AS semantic_rank
    FROM (
      SELECT
        t.id,
        t.created_at,
        t.embedding <=> p_query_embedding AS distance
      FROM public.thoughts t
      CROSS JOIN parameters p
      WHERE p_query_embedding IS NOT NULL
        AND t.embedding IS NOT NULL
        AND (
          p_semantic_threshold IS NULL
          OR 1.0 - (t.embedding <=> p_query_embedding) >= p_semantic_threshold
        )
        AND (p_include_restricted OR t.sensitivity_tier IS DISTINCT FROM 'restricted')
        AND lower(coalesce(t.metadata->>'deleted', 'false')) <> 'true'
        AND (NOT (p.filter_value ? 'type') OR t.type = p.filter_value->>'type')
        AND (NOT (p.filter_value ? 'source_type') OR t.source_type = p.filter_value->>'source_type')
        AND (
          nullif(p.filter_value->>'min_importance', '') IS NULL
          OR t.importance >= (p.filter_value->>'min_importance')::SMALLINT
        )
        AND (
          nullif(p.filter_value->>'start_date', '') IS NULL
          OR t.created_at >= (p.filter_value->>'start_date')::TIMESTAMPTZ
        )
        AND (
          nullif(p.filter_value->>'end_date', '') IS NULL
          OR t.created_at <= (p.filter_value->>'end_date')::TIMESTAMPTZ
        )
      ORDER BY t.embedding <=> p_query_embedding, t.created_at DESC, t.id
      LIMIT (SELECT candidate_limit FROM parameters)
    ) AS candidate
  ),
  text_candidates AS (
    SELECT
      candidate.id,
      row_number() OVER (
        ORDER BY candidate.fts_rank DESC, candidate.created_at DESC, candidate.id
      )::INT AS text_rank
    FROM (
      SELECT
        t.id,
        t.created_at,
        ts_rank(to_tsvector('simple', coalesce(t.content, '')), p.text_query) AS fts_rank
      FROM public.thoughts t
      CROSS JOIN parameters p
      WHERE btrim(coalesce(p_query, '')) <> ''
        AND to_tsvector('simple', coalesce(t.content, '')) @@ p.text_query
        AND (p_include_restricted OR t.sensitivity_tier IS DISTINCT FROM 'restricted')
        AND lower(coalesce(t.metadata->>'deleted', 'false')) <> 'true'
        AND (NOT (p.filter_value ? 'type') OR t.type = p.filter_value->>'type')
        AND (NOT (p.filter_value ? 'source_type') OR t.source_type = p.filter_value->>'source_type')
        AND (
          nullif(p.filter_value->>'min_importance', '') IS NULL
          OR t.importance >= (p.filter_value->>'min_importance')::SMALLINT
        )
        AND (
          nullif(p.filter_value->>'start_date', '') IS NULL
          OR t.created_at >= (p.filter_value->>'start_date')::TIMESTAMPTZ
        )
        AND (
          nullif(p.filter_value->>'end_date', '') IS NULL
          OR t.created_at <= (p.filter_value->>'end_date')::TIMESTAMPTZ
        )
      ORDER BY fts_rank DESC, t.created_at DESC, t.id
      LIMIT (SELECT candidate_limit FROM parameters)
    ) AS candidate
  ),
  fused AS (
    SELECT semantic_candidates.id FROM semantic_candidates
    UNION
    SELECT text_candidates.id FROM text_candidates
  ),
  scored AS (
    SELECT
      t.id,
      t.content,
      t.metadata,
      t.created_at,
      t.type,
      t.importance,
      (
        CASE
          WHEN semantic.semantic_rank IS NULL THEN 0.0
          ELSE p.semantic_weight / (p.rrf_k + semantic.semantic_rank)
        END
        + CASE
          WHEN lexical.text_rank IS NULL THEN 0.0
          ELSE p.text_weight / (p.rrf_k + lexical.text_rank)
        END
      )::DOUBLE PRECISION AS rrf_score,
      semantic.semantic_rank,
      lexical.text_rank
    FROM fused
    JOIN public.thoughts t USING (id)
    LEFT JOIN semantic_candidates semantic USING (id)
    LEFT JOIN text_candidates lexical USING (id)
    CROSS JOIN parameters p
  )
  SELECT
    scored.id,
    scored.content,
    scored.metadata,
    scored.created_at,
    scored.type,
    scored.importance,
    scored.rrf_score,
    scored.semantic_rank,
    scored.text_rank
  FROM scored
  ORDER BY scored.rrf_score DESC, scored.created_at DESC, scored.id
  OFFSET (SELECT result_offset FROM parameters)
  LIMIT (SELECT result_limit FROM parameters);
END;
$$;

REVOKE ALL ON FUNCTION public.hybrid_search_thoughts(TEXT, vector(1536), INT, INT, JSONB, BOOLEAN, INT, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hybrid_search_thoughts(TEXT, vector(1536), INT, INT, JSONB, BOOLEAN, INT, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION)
  TO authenticated, service_role;

-- ============================================================
-- 4. ATOMIC CAPTURE
--
-- PostgreSQL functions execute inside the caller's transaction. The advisory
-- transaction lock serializes equal fingerprints, then the canonical upsert
-- performs the insert/merge and the optional embedding update completes before
-- the function can return.
-- ============================================================

CREATE OR REPLACE FUNCTION public.capture_thought_atomic(
  p_content TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb,
  p_embedding vector(1536) DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_fingerprint TEXT;
  v_upsert_result JSONB;
  v_id UUID;
  v_deduped BOOLEAN;
  v_has_embedding BOOLEAN;
BEGIN
  IF p_content IS NULL OR btrim(p_content) = '' THEN
    RAISE EXCEPTION 'content required'
      USING ERRCODE = '22023';
  END IF;

  -- Réplique EXACTEMENT la formule de fingerprint du upsert_thought live
  -- (SHA-256 hex du contenu normalisé), sinon la détection de dédup ne matche jamais.
  v_fingerprint := encode(sha256(convert_to(
    lower(trim(regexp_replace(coalesce(p_content, ''), '\s+', ' ', 'g'))),
    'UTF8'
  )), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(v_fingerprint, 0));

  SELECT EXISTS (
    SELECT 1
    FROM public.thoughts t
    WHERE t.content_fingerprint = v_fingerprint
  )
  INTO v_deduped;

  v_upsert_result := public.upsert_thought(p_content, coalesce(p_payload, '{}'::jsonb));
  v_id := nullif(v_upsert_result->>'id', '')::UUID;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'upsert_thought did not return an id';
  END IF;

  IF p_embedding IS NOT NULL THEN
    UPDATE public.thoughts AS t
    SET embedding = p_embedding,
        updated_at = now()
    WHERE t.id = v_id;
  END IF;

  SELECT t.embedding IS NOT NULL
  INTO v_has_embedding
  FROM public.thoughts t
  WHERE t.id = v_id;

  RETURN jsonb_build_object(
    'id', v_id,
    'deduped', v_deduped,
    'has_embedding', coalesce(v_has_embedding, false)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.capture_thought_atomic(TEXT, JSONB, vector(1536)) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.capture_thought_atomic(TEXT, JSONB, vector(1536)) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.capture_thought_atomic(TEXT, JSONB, vector(1536))
  TO service_role;

-- ============================================================
-- 5. SOURCE TYPE BACKFILL
-- ============================================================

CREATE OR REPLACE FUNCTION public.backfill_source_type(
  p_batch INT DEFAULT 500,
  p_dry_run BOOLEAN DEFAULT true
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_by_source JSONB;
  v_eligible BIGINT;
  v_updated BIGINT := 0;
  v_remaining BIGINT;
BEGIN
  IF p_batch IS NULL OR p_batch < 1 THEN
    RAISE EXCEPTION 'p_batch must be at least 1'
      USING ERRCODE = '22023';
  END IF;

  IF coalesce(p_dry_run, true) THEN
    SELECT
      coalesce(jsonb_object_agg(summary.source_name, summary.source_count), '{}'::jsonb),
      coalesce(sum(summary.source_count), 0)
    INTO v_by_source, v_eligible
    FROM (
      SELECT
        btrim(t.metadata->>'source') AS source_name,
        count(*) AS source_count
      FROM public.thoughts t
      WHERE t.source_type IS NULL
        AND nullif(btrim(t.metadata->>'source'), '') IS NOT NULL
      GROUP BY btrim(t.metadata->>'source')
      ORDER BY btrim(t.metadata->>'source')
    ) AS summary;

    RETURN jsonb_build_object(
      'dry_run', true,
      'eligible', v_eligible,
      'by_source', v_by_source
    );
  END IF;

  WITH batch AS (
    SELECT
      t.id,
      btrim(t.metadata->>'source') AS source_name
    FROM public.thoughts t
    WHERE t.source_type IS NULL
      AND nullif(btrim(t.metadata->>'source'), '') IS NOT NULL
    ORDER BY t.id
    LIMIT p_batch
    FOR UPDATE SKIP LOCKED
  ),
  updated_rows AS (
    UPDATE public.thoughts AS target
    SET source_type = batch.source_name,
        updated_at = now()
    FROM batch
    WHERE target.id = batch.id
      AND target.source_type IS NULL
    RETURNING target.id
  )
  SELECT count(*) INTO v_updated FROM updated_rows;

  SELECT count(*)
  INTO v_remaining
  FROM public.thoughts t
  WHERE t.source_type IS NULL
    AND nullif(btrim(t.metadata->>'source'), '') IS NOT NULL;

  RETURN jsonb_build_object('updated', v_updated, 'remaining', v_remaining);
END;
$$;

REVOKE ALL ON FUNCTION public.backfill_source_type(INT, BOOLEAN) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.backfill_source_type(INT, BOOLEAN) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_source_type(INT, BOOLEAN)
  TO service_role;

-- ============================================================
-- 6. LOGICAL DELETE AND RESTORE
-- ============================================================

DROP FUNCTION IF EXISTS public.soft_delete_thought(UUID, TEXT);
DROP FUNCTION IF EXISTS public.restore_thought(UUID, TEXT);

CREATE OR REPLACE FUNCTION public.soft_delete_thought(
  p_id UUID,
  p_actor TEXT DEFAULT 'mcp',
  p_confirm BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_before JSONB;
  v_after JSONB;
  v_found BOOLEAN;
  v_changed BOOLEAN := false;
  v_previous_actor TEXT;
BEGIN
  IF p_confirm IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'confirm required'
      USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(t.metadata, '{}'::jsonb)
  INTO v_before
  FROM public.thoughts t
  WHERE t.id = p_id
  FOR UPDATE;

  v_found := FOUND;
  IF NOT v_found THEN
    RETURN jsonb_build_object('id', p_id, 'found', false, 'deleted', false);
  END IF;

  IF lower(coalesce(v_before->>'deleted', 'false')) <> 'true' THEN
    v_previous_actor := current_setting('ob1.audit_actor', true);
    PERFORM set_config(
      'ob1.audit_actor',
      coalesce(nullif(btrim(p_actor), ''), 'mcp'),
      true
    );

    UPDATE public.thoughts AS t
    SET metadata = v_before || jsonb_build_object(
          'deleted', true,
          'deleted_at', now(),
          'deleted_by', coalesce(nullif(btrim(p_actor), ''), 'mcp')
        ),
        updated_at = now()
    WHERE t.id = p_id
    RETURNING t.metadata INTO v_after;

    PERFORM set_config('ob1.audit_actor', coalesce(v_previous_actor, ''), true);
    v_changed := true;
  ELSE
    v_after := v_before;
  END IF;

  RETURN jsonb_build_object(
    'id', p_id,
    'found', true,
    'deleted', true,
    'changed', v_changed
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.restore_thought(
  p_id UUID,
  p_actor TEXT DEFAULT 'mcp',
  p_confirm BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_before JSONB;
  v_after JSONB;
  v_found BOOLEAN;
  v_changed BOOLEAN := false;
  v_previous_actor TEXT;
BEGIN
  IF p_confirm IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'confirm required'
      USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(t.metadata, '{}'::jsonb)
  INTO v_before
  FROM public.thoughts t
  WHERE t.id = p_id
  FOR UPDATE;

  v_found := FOUND;
  IF NOT v_found THEN
    RETURN jsonb_build_object('id', p_id, 'found', false, 'deleted', false);
  END IF;

  IF lower(coalesce(v_before->>'deleted', 'false')) = 'true' THEN
    v_after := v_before - 'deleted' - 'deleted_at' - 'deleted_by';

    v_previous_actor := current_setting('ob1.audit_actor', true);
    PERFORM set_config(
      'ob1.audit_actor',
      coalesce(nullif(btrim(p_actor), ''), 'mcp'),
      true
    );

    UPDATE public.thoughts AS t
    SET metadata = v_after,
        updated_at = now()
    WHERE t.id = p_id;

    PERFORM set_config('ob1.audit_actor', coalesce(v_previous_actor, ''), true);
    v_changed := true;
  ELSE
    v_after := v_before;
  END IF;

  RETURN jsonb_build_object(
    'id', p_id,
    'found', true,
    'deleted', false,
    'changed', v_changed
  );
END;
$$;

REVOKE ALL ON FUNCTION public.soft_delete_thought(UUID, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.restore_thought(UUID, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.soft_delete_thought(UUID, TEXT, BOOLEAN) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.restore_thought(UUID, TEXT, BOOLEAN) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.soft_delete_thought(UUID, TEXT, BOOLEAN)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.restore_thought(UUID, TEXT, BOOLEAN)
  TO service_role;

-- ============================================================
-- 7. EXACT, UNPAGINATED STATISTICS
-- ============================================================

CREATE OR REPLACE FUNCTION public.thought_stats_exact()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH totals AS (
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE embedding IS NULL) AS missing_embeddings,
      count(*) FILTER (
        WHERE lower(coalesce(metadata->>'deleted', 'false')) = 'true'
      ) AS deleted,
      min(created_at) AS min_created_at,
      max(created_at) AS max_created_at
    FROM public.thoughts
  ),
  by_type AS (
    SELECT coalesce(jsonb_object_agg(label, amount ORDER BY label), '{}'::jsonb) AS value
    FROM (
      SELECT coalesce(type, '(unset)') AS label, count(*) AS amount
      FROM public.thoughts
      GROUP BY coalesce(type, '(unset)')
    ) grouped
  ),
  by_source AS (
    SELECT coalesce(jsonb_object_agg(label, amount ORDER BY label), '{}'::jsonb) AS value
    FROM (
      SELECT coalesce(source_type, '(unset)') AS label, count(*) AS amount
      FROM public.thoughts
      GROUP BY coalesce(source_type, '(unset)')
    ) grouped
  ),
  by_sensitivity AS (
    SELECT coalesce(jsonb_object_agg(label, amount ORDER BY label), '{}'::jsonb) AS value
    FROM (
      SELECT coalesce(sensitivity_tier, '(unset)') AS label, count(*) AS amount
      FROM public.thoughts
      GROUP BY coalesce(sensitivity_tier, '(unset)')
    ) grouped
  )
  SELECT jsonb_build_object(
    'total', totals.total,
    'by_type', by_type.value,
    'by_source_type', by_source.value,
    'by_sensitivity_tier', by_sensitivity.value,
    'missing_embeddings', totals.missing_embeddings,
    'deleted', totals.deleted,
    'min_created_at', totals.min_created_at,
    'max_created_at', totals.max_created_at
  )
  FROM totals
  CROSS JOIN by_type
  CROSS JOIN by_source
  CROSS JOIN by_sensitivity;
$$;

REVOKE ALL ON FUNCTION public.thought_stats_exact() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.thought_stats_exact()
  TO authenticated, service_role;

-- Supabase normally provides anon. Keep the migration portable for PostgreSQL
-- test instances where that role has not been created.
DO $revoke_sensitive_rpc_anon$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION public.soft_delete_thought(UUID, TEXT, BOOLEAN) FROM anon;
    REVOKE EXECUTE ON FUNCTION public.restore_thought(UUID, TEXT, BOOLEAN) FROM anon;
    REVOKE EXECUTE ON FUNCTION public.backfill_source_type(INT, BOOLEAN) FROM anon;
    REVOKE EXECUTE ON FUNCTION public.capture_thought_atomic(TEXT, JSONB, vector(1536)) FROM anon;
    REVOKE EXECUTE ON FUNCTION public.log_thought_audit(UUID, TEXT, TEXT, JSONB) FROM anon;
  END IF;
END
$revoke_sensitive_rpc_anon$;

COMMIT;
