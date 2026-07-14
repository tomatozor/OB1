\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION pg_temp.unit_vector(p_position INT)
RETURNS vector(1536)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT array_agg(
    CASE WHEN dimension = p_position THEN 1.0::REAL ELSE 0.0::REAL END
    ORDER BY dimension
  )::vector(1536)
  FROM generate_series(1, 1536) AS dimension;
$$;

INSERT INTO public.thoughts (
  content, embedding, metadata, created_at, updated_at,
  type, sensitivity_tier, importance, quality_score, source_type, enriched
)
VALUES
  ('Alpha launch plan', pg_temp.unit_vector(1), '{"source":"manual"}', now() - interval '1 day', now(), 'idea', 'standard', 5, 90, 'manual', true),
  ('Project roadmap and milestones', pg_temp.unit_vector(2), '{"source":"manual"}', now() - interval '3 days', now(), 'task', 'standard', 4, 80, 'manual', true),
  ('Alpha notebook without vector', NULL, '{"source":"web-clip"}', now() - interval '5 days', now(), 'reference', 'standard', 3, 70, NULL, false),
  ('Restricted alpha strategy', pg_temp.unit_vector(3), '{"source":"private"}', now() - interval '2 days', now(), 'idea', 'restricted', 5, 95, 'private', true),
  ('Deleted alpha draft', pg_temp.unit_vector(4), '{"source":"manual","deleted":true}', now() - interval '4 days', now(), 'task', 'standard', 2, 40, 'manual', false),
  ('Old alpha archive', pg_temp.unit_vector(5), '{"source":"archive"}', now() - interval '400 days', now(), 'idea', 'standard', 2, 60, 'archive', true),
  ('Beta decision record', pg_temp.unit_vector(6), '{"source":"meeting"}', now() - interval '10 days', now(), 'decision', 'standard', 5, 85, NULL, true),
  ('Alpha implementation reference', pg_temp.unit_vector(7), '{"source":"manual"}', now() - interval '2 days', now(), 'reference', 'standard', 2, 75, 'manual', true);

DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.hybrid_search_thoughts('alpha', pg_temp.unit_vector(1), 20, 0, '{}'::jsonb, false, 60);

  IF v_count <> 6 THEN
    RAISE EXCEPTION 'hybrid default expected 6 visible rows, got %', v_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.hybrid_search_thoughts('alpha', pg_temp.unit_vector(1), 20, 0, '{}'::jsonb, false, 60) result
    WHERE result.content IN ('Restricted alpha strategy', 'Deleted alpha draft')
  ) THEN
    RAISE EXCEPTION 'hybrid default leaked restricted or deleted content';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.hybrid_search_thoughts('alpha', pg_temp.unit_vector(1), 20, 0, '{}'::jsonb, false, 60) result
    WHERE result.semantic_rank IS NOT NULL AND result.text_rank IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.hybrid_search_thoughts('alpha', pg_temp.unit_vector(1), 20, 0, '{}'::jsonb, false, 60) result
    WHERE result.semantic_rank IS NOT NULL AND result.text_rank IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.hybrid_search_thoughts('alpha', pg_temp.unit_vector(1), 20, 0, '{}'::jsonb, false, 60) result
    WHERE result.semantic_rank IS NULL AND result.text_rank IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'hybrid result did not prove fused, semantic-only, and text-only paths';
  END IF;

  RAISE NOTICE 'PASS hybrid fusion excludes restricted/deleted and exposes both rank paths (% rows)', v_count;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.hybrid_search_thoughts(
      'alpha', pg_temp.unit_vector(1), 20, 0, '{"type":"idea"}'::jsonb, false, 60
    ) result WHERE result.type IS DISTINCT FROM 'idea'
  ) THEN
    RAISE EXCEPTION 'type filter returned a non-idea';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.hybrid_search_thoughts(
      'alpha', pg_temp.unit_vector(1), 20, 0, '{"source_type":"manual"}'::jsonb, false, 60
    ) result
    JOIN public.thoughts source ON source.id = result.id
    WHERE source.source_type IS DISTINCT FROM 'manual'
  ) THEN
    RAISE EXCEPTION 'source_type filter returned a non-manual row';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.hybrid_search_thoughts(
      'alpha', pg_temp.unit_vector(1), 20, 0, '{"min_importance":5}'::jsonb, false, 60
    ) result WHERE result.importance < 5 OR result.importance IS NULL
  ) THEN
    RAISE EXCEPTION 'min_importance filter returned an invalid row';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.hybrid_search_thoughts(
      'alpha',
      pg_temp.unit_vector(1),
      20,
      0,
      jsonb_build_object(
        'start_date', now() - interval '30 days',
        'end_date', now() + interval '1 day'
      ),
      false,
      60
    ) result
    WHERE result.created_at < now() - interval '30 days'
       OR result.created_at > now() + interval '1 day'
  ) THEN
    RAISE EXCEPTION 'date filter returned an out-of-range row';
  END IF;

  IF (SELECT count(*) FROM public.hybrid_search_thoughts(
    'alpha', pg_temp.unit_vector(1), 20, 0, '{"type":"idea"}'::jsonb, false, 60
  )) = 0 THEN
    RAISE EXCEPTION 'type filter test was vacuous';
  END IF;

  RAISE NOTICE 'PASS type, source_type, min_importance, and date filters';
END;
$$;

CREATE TEMP TABLE capture_results (
  attempt INT PRIMARY KEY,
  result JSONB NOT NULL
);

INSERT INTO capture_results VALUES
  (1, public.capture_thought_atomic(
    '  Atomic   synthetic capture  ',
    '{"metadata":{"source":"test-suite","author_session_id":"synthetic-session"}}'::jsonb,
    NULL
  ));

INSERT INTO capture_results VALUES
  (2, public.capture_thought_atomic(
    'atomic synthetic capture',
    '{"metadata":{"source":"test-suite","stage":"deduped"}}'::jsonb,
    pg_temp.unit_vector(8)
  ));

DO $$
DECLARE
  v_first JSONB;
  v_second JSONB;
  v_id UUID;
  v_count INT;
BEGIN
  SELECT result INTO v_first FROM capture_results WHERE attempt = 1;
  SELECT result INTO v_second FROM capture_results WHERE attempt = 2;
  v_id := (v_second->>'id')::UUID;

  IF (v_first->>'deduped')::BOOLEAN OR NOT (v_second->>'deduped')::BOOLEAN THEN
    RAISE EXCEPTION 'capture dedup flags are incorrect: first=%, second=%', v_first, v_second;
  END IF;

  IF v_first->>'id' <> v_second->>'id' OR NOT (v_second->>'has_embedding')::BOOLEAN THEN
    RAISE EXCEPTION 'capture did not preserve id and atomically attach embedding: first=%, second=%', v_first, v_second;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.thoughts t
  WHERE t.content_fingerprint = encode(sha256(convert_to('atomic synthetic capture', 'UTF8')), 'hex');

  IF v_count <> 1 OR NOT EXISTS (
    SELECT 1 FROM public.thoughts t WHERE t.id = v_id AND t.embedding IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'capture created duplicates or omitted embedding';
  END IF;

  RAISE NOTICE 'PASS atomic capture dedupes and attaches embedding (id=%)', v_id;
END;
$$;

CREATE TEMP TABLE backfill_results (
  stage TEXT PRIMARY KEY,
  result JSONB NOT NULL
);

INSERT INTO backfill_results VALUES ('dry', public.backfill_source_type(500, true));

DO $$
DECLARE
  v_result JSONB;
BEGIN
  SELECT result INTO v_result FROM backfill_results WHERE stage = 'dry';

  IF (v_result->>'eligible')::INT <> 3
     OR (v_result #>> '{by_source,web-clip}')::INT <> 1
     OR (v_result #>> '{by_source,meeting}')::INT <> 1
     OR (v_result #>> '{by_source,test-suite}')::INT <> 1 THEN
    RAISE EXCEPTION 'unexpected dry-run source counts: %', v_result;
  END IF;

  IF (SELECT count(*) FROM public.thoughts WHERE source_type IS NULL) <> 3 THEN
    RAISE EXCEPTION 'dry-run mutated source_type';
  END IF;

  RAISE NOTICE 'PASS source backfill dry-run is read-only and grouped (%)', v_result;
END;
$$;

INSERT INTO backfill_results VALUES ('batch-1', public.backfill_source_type(1, false));
INSERT INTO backfill_results VALUES ('batch-2', public.backfill_source_type(500, false));

DO $$
DECLARE
  v_first JSONB;
  v_second JSONB;
BEGIN
  SELECT result INTO v_first FROM backfill_results WHERE stage = 'batch-1';
  SELECT result INTO v_second FROM backfill_results WHERE stage = 'batch-2';

  IF (v_first->>'updated')::INT <> 1 OR (v_first->>'remaining')::INT <> 2
     OR (v_second->>'updated')::INT <> 2 OR (v_second->>'remaining')::INT <> 0 THEN
    RAISE EXCEPTION 'unexpected backfill batches: first=%, second=%', v_first, v_second;
  END IF;

  RAISE NOTICE 'PASS source backfill applies bounded batches (%, %)', v_first, v_second;
END;
$$;

CREATE TEMP TABLE logical_delete_target AS
SELECT id FROM public.thoughts WHERE content = 'Project roadmap and milestones';

SELECT public.soft_delete_thought(id, 'test-suite') FROM logical_delete_target;

DO $$
DECLARE
  v_id UUID;
BEGIN
  SELECT id INTO v_id FROM logical_delete_target;

  IF NOT EXISTS (
    SELECT 1 FROM public.thoughts t
    WHERE t.id = v_id AND lower(t.metadata->>'deleted') = 'true'
  ) THEN
    RAISE EXCEPTION 'soft delete did not set metadata markers';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.hybrid_search_thoughts('', pg_temp.unit_vector(2), 20, 0, '{}'::jsonb, false, 60)
    WHERE id = v_id
  ) THEN
    RAISE EXCEPTION 'soft-deleted row remained searchable';
  END IF;
END;
$$;

SELECT public.restore_thought(id, 'test-suite') FROM logical_delete_target;

DO $$
DECLARE
  v_id UUID;
BEGIN
  SELECT id INTO v_id FROM logical_delete_target;

  IF EXISTS (
    SELECT 1 FROM public.thoughts t
    WHERE t.id = v_id AND t.metadata ?| ARRAY['deleted', 'deleted_at', 'deleted_by']
  ) THEN
    RAISE EXCEPTION 'restore did not remove logical deletion markers';
  END IF;

  IF (SELECT count(*) FROM public.thought_audit WHERE thought_id = v_id AND action IN ('delete', 'restore')) <> 2 THEN
    RAISE EXCEPTION 'delete/restore audit rows are missing';
  END IF;

  RAISE NOTICE 'PASS soft delete, search exclusion, restore, and append-only audit';
END;
$$;

DO $$
DECLARE
  v_stats JSONB;
BEGIN
  v_stats := public.thought_stats_exact();

  IF (v_stats->>'total')::INT <> 9
     OR (v_stats->>'missing_embeddings')::INT <> 1
     OR (v_stats->>'deleted')::INT <> 1
     OR v_stats->'by_type' IS NULL
     OR v_stats->'by_source_type' IS NULL
     OR v_stats->'by_sensitivity_tier' IS NULL
     OR v_stats->>'min_created_at' IS NULL
     OR v_stats->>'max_created_at' IS NULL THEN
    RAISE EXCEPTION 'exact stats are inconsistent: %', v_stats;
  END IF;

  RAISE NOTICE 'PASS exact unpaginated stats (%)', v_stats;
END;
$$;
