\set ON_ERROR_STOP on

DO $grants$
DECLARE
  v_signature TEXT;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.agent_memory_writeback_tx(text,text,text,jsonb,jsonb,jsonb,jsonb,text,jsonb)',
    'public.agent_memory_review_tx(uuid,text,text,text,text,uuid,text,text,text)'
  ] LOOP
    IF NOT has_function_privilege('service_role', v_signature, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role lacks EXECUTE on %', v_signature;
    END IF;
    IF has_function_privilege('authenticated', v_signature, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated unexpectedly has EXECUTE on %', v_signature;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS governance RPC grants are service_role-only';
END
$grants$;

DO $writeback$
DECLARE
  v_created JSONB;
  v_replayed JSONB;
  v_memory_id UUID;
  v_count INT;
BEGIN
  v_created := public.agent_memory_writeback_tx(
    'rpc-workspace',
    'rpc-write:1',
    repeat('1', 64),
    '{
      "project_id":"rpc-project",
      "visibility":"project",
      "memory_type":"decision",
      "summary":"Transactional writeback",
      "content":"Keep governed writes atomic.",
      "metadata":{"source":"transactional-rpc-test"}
    }'::jsonb,
    '{"provenance_status":"observed","confidence":0.9}'::jsonb,
    '[
      {"kind":"runbook","uri":"repo://runbook","title":"Runbook"},
      {"source_kind":"issue","uri":"linear://NAT-833","metadata":{"verified":true}}
    ]'::jsonb,
    '[
      {"kind":"document","uri":"repo://decision.md","description":"Decision"},
      {"artifact_kind":"test","uri":"repo://transactional-rpc-test.sql"}
    ]'::jsonb,
    'agent',
    '{"runtime_name":"local-test","task_id":"W4-B","actor_label":"sql-harness"}'::jsonb
  );

  v_memory_id := (v_created->>'id')::UUID;
  IF (v_created->>'replayed')::BOOLEAN THEN
    RAISE EXCEPTION 'first writeback was marked replayed';
  END IF;
  IF (v_created->>'can_use_as_instruction')::BOOLEAN
    OR NOT (v_created->>'can_use_as_evidence')::BOOLEAN
    OR NOT (v_created->>'requires_user_confirmation')::BOOLEAN
    OR v_created->>'review_status' <> 'pending'
    OR v_created->>'provenance_status' <> 'observed' THEN
    RAISE EXCEPTION 'writeback did not enforce evidence-only pending defaults: %', v_created;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.agent_memory_source_refs WHERE memory_id = v_memory_id;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'expected 2 source refs, got %', v_count;
  END IF;
  SELECT count(*) INTO v_count
  FROM public.agent_memory_artifacts WHERE memory_id = v_memory_id;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'expected 2 artifacts, got %', v_count;
  END IF;
  SELECT count(*) INTO v_count
  FROM public.agent_memory_audit_events
  WHERE memory_id = v_memory_id AND event_type = 'memory_written';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'expected 1 write audit, got %', v_count;
  END IF;

  v_replayed := public.agent_memory_writeback_tx(
    'rpc-workspace',
    'rpc-write:1',
    repeat('1', 64),
    '{"memory_type":"lesson","summary":"Ignored replay payload","content":"Ignored."}'::jsonb,
    '{"provenance_status":"generated"}'::jsonb
  );
  IF NOT (v_replayed->>'replayed')::BOOLEAN OR (v_replayed->>'id')::UUID <> v_memory_id THEN
    RAISE EXCEPTION 'same-hash replay did not return the existing memory: %', v_replayed;
  END IF;
  SELECT count(*) INTO v_count
  FROM public.agent_memory_source_refs WHERE memory_id = v_memory_id;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'replay duplicated source refs';
  END IF;

  BEGIN
    PERFORM public.agent_memory_writeback_tx(
      'rpc-workspace', 'rpc-write:1', repeat('2', 64),
      '{"memory_type":"decision","summary":"Conflict","content":"Conflict."}'::jsonb,
      '{"provenance_status":"generated"}'::jsonb
    );
    RAISE EXCEPTION 'expected idempotency hash conflict';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;

  BEGIN
    PERFORM public.agent_memory_writeback_tx(
      'rpc-workspace', 'rpc-write:rollback', repeat('3', 64),
      '{"memory_type":"lesson","summary":"Must roll back","content":"Must roll back."}'::jsonb,
      '{"provenance_status":"generated"}'::jsonb,
      '[{"uri":"repo://missing-kind"}]'::jsonb
    );
    RAISE EXCEPTION 'expected invalid source ref to abort writeback';
  EXCEPTION
    WHEN not_null_violation THEN NULL;
  END;
  IF EXISTS (
    SELECT 1 FROM public.agent_memories
    WHERE workspace_id = 'rpc-workspace' AND idempotency_key = 'rpc-write:rollback'
  ) THEN
    RAISE EXCEPTION 'failed writeback left a partial memory';
  END IF;

  RAISE NOTICE 'PASS writeback lock/replay, 1:1 children, audit, and rollback';
END
$writeback$;

DO $review$
DECLARE
  v_memory_id UUID;
  v_related_id UUID;
  v_result JSONB;
  v_count INT;
BEGIN
  SELECT id INTO v_memory_id
  FROM public.agent_memories
  WHERE workspace_id = 'rpc-workspace' AND idempotency_key = 'rpc-write:1';

  BEGIN
    PERFORM public.agent_memory_review_tx(
      v_memory_id, 'other-workspace', 'confirm', 'reviewer-1'
    );
    RAISE EXCEPTION 'expected workspace-bounded lookup failure';
  EXCEPTION
    WHEN no_data_found THEN
      IF SQLERRM <> 'not found in workspace' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.agent_memory_review_tx(
      v_memory_id, 'rpc-workspace', 'confirm', '   '
    );
    RAISE EXCEPTION 'expected blank actor rejection';
  EXCEPTION
    WHEN invalid_parameter_value THEN NULL;
  END;

  v_result := public.agent_memory_review_tx(
    v_memory_id,
    'rpc-workspace',
    'approve',
    'reviewer-1',
    'Human-confirmed in the SQL harness.'
  );
  IF v_result->>'action' <> 'confirm'
    OR v_result->'memory'->>'review_status' <> 'confirmed'
    OR v_result->'memory'->>'provenance_status' <> 'user_confirmed'
    OR NOT (v_result->'memory'->>'can_use_as_instruction')::BOOLEAN THEN
    RAISE EXCEPTION 'approve alias did not apply confirm transition: %', v_result;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.agent_memory_review_actions
  WHERE memory_id = v_memory_id AND action = 'confirm' AND actor_id = 'reviewer-1';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'expected 1 normalized review action, got %', v_count;
  END IF;
  SELECT count(*) INTO v_count
  FROM public.agent_memory_audit_events
  WHERE memory_id = v_memory_id AND event_type = 'memory_confirmed';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'expected 1 confirm audit, got %', v_count;
  END IF;

  BEGIN
    PERFORM public.agent_memory_review_tx(
      v_memory_id, 'rpc-workspace', 'confirm', 'reviewer-1'
    );
    RAISE EXCEPTION 'expected invalid repeated confirm transition';
  EXCEPTION
    WHEN invalid_parameter_value THEN NULL;
  END;

  v_related_id := (
    public.agent_memory_writeback_tx(
      'rpc-workspace', 'rpc-related:1', repeat('4', 64),
      '{"memory_type":"decision","summary":"Related memory","content":"Canonical replacement."}'::jsonb,
      '{"provenance_status":"observed"}'::jsonb
    )->>'id'
  )::UUID;
  v_result := public.agent_memory_review_tx(
    v_memory_id,
    'rpc-workspace',
    'merge',
    'reviewer-1',
    'Merged into the canonical replacement.',
    v_related_id
  );
  IF v_result->'memory'->>'review_status' <> 'merged'
    OR v_result->'memory'->>'lifecycle_status' <> 'superseded' THEN
    RAISE EXCEPTION 'merge transition failed: %', v_result;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.agent_memory_relations
    WHERE from_memory_id = v_memory_id
      AND to_memory_id = v_related_id
      AND relation = 'merged_into'
  ) THEN
    RAISE EXCEPTION 'merge relation was not written';
  END IF;
  SELECT count(*) INTO v_count
  FROM public.agent_memory_audit_events
  WHERE memory_id = v_memory_id AND event_type = 'memory_superseded';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'expected 1 merge audit, got %', v_count;
  END IF;

  RAISE NOTICE 'PASS review workspace lock, validation, transitions, relation, and audit';
END
$review$;
