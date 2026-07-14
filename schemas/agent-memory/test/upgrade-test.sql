\set ON_ERROR_STOP on

DO $upgrade$
DECLARE
  v_table TEXT;
  v_nullable TEXT;
  v_index_definition TEXT;
  v_memory_id UUID;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'agent_memories',
    'agent_memory_source_refs',
    'agent_memory_artifacts',
    'agent_memory_relations',
    'agent_memory_review_actions',
    'agent_memory_recall_traces',
    'agent_memory_recall_items',
    'agent_memory_audit_events'
  ] LOOP
    IF has_table_privilege('service_role', 'public.' || v_table, 'DELETE') THEN
      RAISE EXCEPTION 'service_role retained DELETE on %', v_table;
    END IF;
  END LOOP;

  SELECT is_nullable INTO v_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'agent_memories'
    AND column_name = 'idempotency_key';
  IF v_nullable <> 'NO' THEN
    RAISE EXCEPTION 'idempotency_key is still nullable';
  END IF;
  SELECT is_nullable INTO v_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'agent_memories'
    AND column_name = 'content_hash';
  IF v_nullable <> 'NO' THEN
    RAISE EXCEPTION 'content_hash is still nullable';
  END IF;

  IF to_regclass('public.idx_agent_memories_idempotency_key') IS NOT NULL THEN
    RAISE EXCEPTION 'legacy global idempotency index still exists';
  END IF;
  SELECT indexdef INTO v_index_definition
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname = 'idx_agent_memories_workspace_idempotency_key';
  IF v_index_definition IS NULL
    OR v_index_definition NOT LIKE '%UNIQUE INDEX%'
    OR v_index_definition NOT LIKE '%(workspace_id, idempotency_key)%' THEN
    RAISE EXCEPTION 'workspace idempotency index is missing or malformed: %', v_index_definition;
  END IF;

  SELECT id INTO v_memory_id
  FROM public.agent_memories
  WHERE summary = 'Legacy nullable row';
  IF v_memory_id IS NULL THEN
    RAISE EXCEPTION 'legacy nullable memory was not preserved';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.agent_memories
    WHERE id = v_memory_id
      AND idempotency_key = 'legacy:' || id::TEXT
      AND content_hash = 'legacy:' || id::TEXT
      AND visibility = 'workspace'
      AND content = 'Legacy content must survive.'
  ) THEN
    RAISE EXCEPTION 'legacy nullable memory backfill or content preservation failed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.agent_memory_source_refs
    WHERE memory_id = v_memory_id AND uri = 'repo://legacy-source'
  ) THEN
    RAISE EXCEPTION 'legacy child row was not preserved';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.agent_memories
    WHERE summary = 'Legacy populated row'
      AND idempotency_key = 'legacy-existing-key'
      AND content_hash = repeat('f', 64)
  ) THEN
    RAISE EXCEPTION 'populated legacy keys were changed';
  END IF;

  RAISE NOTICE 'PASS origin/main upgrade revokes DELETE on 8 tables';
  RAISE NOTICE 'PASS origin/main upgrade enforces NOT NULL and workspace idempotency';
  RAISE NOTICE 'PASS origin/main upgrade preserves legacy parent and child data';
END
$upgrade$;
