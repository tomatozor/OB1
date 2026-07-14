\set ON_ERROR_STOP on

DO $semantic_match$
DECLARE
  v_embedding vector(1536) := (
    '[' || array_to_string(array_fill('0.05'::TEXT, ARRAY[1536]), ',') || ']'
  )::vector(1536);
  v_created JSONB;
  v_memory_id UUID;
  v_similarity DOUBLE PRECISION;
  v_memories_before BIGINT;
  v_refs_before BIGINT;
  v_audits_before BIGINT;
BEGIN
  v_created := public.agent_memory_writeback_tx(
    'semantic-workspace-a',
    'semantic-match:1',
    repeat('7', 64),
    '{"memory_type":"lesson","summary":"Semantic recall target","content":"A writeback embedding must be recallable."}'::jsonb,
    '{"provenance_status":"observed"}'::jsonb,
    p_embedding => v_embedding
  );
  v_memory_id := (v_created->>'id')::UUID;

  IF NOT EXISTS (
    SELECT 1
    FROM public.agent_memories
    WHERE id = v_memory_id
      AND workspace_id = 'semantic-workspace-a'
      AND embedding IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'semantic writeback did not persist its embedding';
  END IF;

  SELECT similarity
  INTO v_similarity
  FROM public.agent_memory_match(
    'semantic-workspace-a',
    v_embedding,
    20,
    0.99
  )
  WHERE memory_id = v_memory_id;
  IF v_similarity IS NULL OR abs(v_similarity - 1.0) > 0.000000001 THEN
    RAISE EXCEPTION 'same-vector match did not return similarity approximately 1: %', v_similarity;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.agent_memory_match('semantic-workspace-b', v_embedding)
    WHERE memory_id = v_memory_id
  ) THEN
    RAISE EXCEPTION 'semantic match leaked a memory across workspaces';
  END IF;

  SELECT count(*) INTO v_memories_before FROM public.agent_memories;
  SELECT count(*) INTO v_refs_before FROM public.agent_memory_source_refs;
  SELECT count(*) INTO v_audits_before FROM public.agent_memory_audit_events;

  BEGIN
    PERFORM public.agent_memory_writeback_tx(
      'semantic-workspace-a',
      'semantic-match:null',
      repeat('8', 64),
      '{"memory_type":"lesson","summary":"Missing embedding","content":"This write must fail before persistence."}'::jsonb,
      '{"provenance_status":"generated"}'::jsonb,
      '[{"source_kind":"test","uri":"repo://semantic-match-test.sql"}]'::jsonb,
      p_embedding => NULL
    );
    RAISE EXCEPTION 'NULL embedding writeback unexpectedly succeeded' USING ERRCODE = 'ZX009';
  EXCEPTION
    WHEN invalid_parameter_value THEN
      IF SQLERRM <> 'embedding required — a writeback must be semantically recallable' THEN
        RAISE;
      END IF;
  END;

  IF (SELECT count(*) FROM public.agent_memories) <> v_memories_before
    OR (SELECT count(*) FROM public.agent_memory_source_refs) <> v_refs_before
    OR (SELECT count(*) FROM public.agent_memory_audit_events) <> v_audits_before THEN
    RAISE EXCEPTION 'NULL embedding rejection persisted memory, source ref, or audit rows';
  END IF;

  RAISE NOTICE 'PASS semantic writeback is recallable at similarity 1';
  RAISE NOTICE 'PASS semantic match is workspace-strict';
  RAISE NOTICE 'PASS NULL embedding rejects before memory, source-ref, or audit writes';
END
$semantic_match$;
