\set ON_ERROR_STOP on

DO $grants$
DECLARE
  v_signature TEXT;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.agent_memory_writeback_tx(text,text,text,jsonb,jsonb,jsonb,jsonb,text,jsonb,vector)',
    'public.agent_memory_writeback_batch_tx(text,jsonb,text,jsonb)',
    'public.agent_memory_match(text,vector,integer,double precision)',
    'public.agent_memory_review_tx(uuid,text,text,text,text,uuid,text,text,text,text)'
  ] LOOP
    IF NOT has_function_privilege('service_role', v_signature, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role lacks EXECUTE on %', v_signature;
    END IF;
    IF has_function_privilege('authenticated', v_signature, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated unexpectedly has EXECUTE on %', v_signature;
    END IF;
  END LOOP;
  IF to_regprocedure(
    'public.agent_memory_writeback_tx(text,text,text,jsonb,jsonb,jsonb,jsonb,text,jsonb)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'legacy writeback_tx overload still exists';
  END IF;
  IF to_regprocedure(
    'public.agent_memory_review_tx(uuid,text,text,text,text,uuid,text,text,text)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'legacy review_tx overload still exists';
  END IF;
  RAISE NOTICE 'PASS governance RPC grants are service_role-only and old overloads are absent';
END
$grants$;

DO $writeback$
DECLARE
  v_embedding vector(1536) := (
    '[' || array_to_string(array_fill('0.01'::TEXT, ARRAY[1536]), ',') || ']'
  )::vector(1536);
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
    '{"runtime_name":"local-test","task_id":"W6-A","actor_label":"sql-harness"}'::jsonb,
    v_embedding
  );

  v_memory_id := (v_created->>'id')::UUID;
  IF (v_created->>'replayed')::BOOLEAN THEN
    RAISE EXCEPTION 'first writeback was marked replayed';
  END IF;
  IF (v_created->>'can_use_as_instruction')::BOOLEAN
    OR NOT (v_created->>'can_use_as_evidence')::BOOLEAN
    OR NOT (v_created->>'requires_user_confirmation')::BOOLEAN
    OR v_created->>'review_status' <> 'pending'
    OR v_created->>'provenance_status' <> 'observed'
    OR v_created->>'embedding' IS NULL THEN
    RAISE EXCEPTION 'writeback did not enforce pending semantic evidence defaults: %', v_created;
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
    '{"provenance_status":"generated"}'::jsonb,
    p_embedding => v_embedding
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
      'rpc-workspace',
      'rpc-write:1',
      repeat('2', 64),
      '{"memory_type":"decision","summary":"Conflict","content":"Conflict."}'::jsonb,
      '{"provenance_status":"generated"}'::jsonb,
      p_embedding => v_embedding
    );
    RAISE EXCEPTION 'expected idempotency hash conflict' USING ERRCODE = 'ZX001';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;

  BEGIN
    PERFORM public.agent_memory_writeback_tx(
      'rpc-workspace',
      'rpc-write:rollback',
      repeat('3', 64),
      '{"memory_type":"lesson","summary":"Must roll back","content":"Must roll back."}'::jsonb,
      '{"provenance_status":"generated"}'::jsonb,
      '[{"uri":"repo://missing-kind"}]'::jsonb,
      p_embedding => v_embedding
    );
    RAISE EXCEPTION 'expected invalid source ref to abort writeback' USING ERRCODE = 'ZX002';
  EXCEPTION
    WHEN not_null_violation THEN NULL;
  END;
  IF EXISTS (
    SELECT 1 FROM public.agent_memories
    WHERE workspace_id = 'rpc-workspace' AND idempotency_key = 'rpc-write:rollback'
  ) THEN
    RAISE EXCEPTION 'failed writeback left a partial memory';
  END IF;

  RAISE NOTICE 'PASS writeback embedding, replay, children, audit, and rollback';
END
$writeback$;

DO $batch$
DECLARE
  v_embedding JSONB := to_jsonb(array_fill(0.02::DOUBLE PRECISION, ARRAY[1536]));
  v_items JSONB;
  v_result JSONB;
  v_memories_before BIGINT;
  v_refs_before BIGINT;
  v_artifacts_before BIGINT;
  v_audits_before BIGINT;
BEGIN
  SELECT count(*) INTO v_memories_before FROM public.agent_memories;
  SELECT count(*) INTO v_refs_before FROM public.agent_memory_source_refs;
  SELECT count(*) INTO v_artifacts_before FROM public.agent_memory_artifacts;
  SELECT count(*) INTO v_audits_before FROM public.agent_memory_audit_events;

  v_items := jsonb_build_array(
    jsonb_build_object(
      'idempotency_key', 'rpc-batch-fail:1',
      'content_hash', repeat('a', 64),
      'memory', jsonb_build_object('memory_type', 'lesson', 'summary', 'Batch one', 'content', 'One'),
      'provenance', jsonb_build_object('provenance_status', 'generated'),
      'embedding', v_embedding
    ),
    jsonb_build_object(
      'idempotency_key', 'rpc-batch-fail:2',
      'content_hash', repeat('b', 64),
      'memory', jsonb_build_object('memory_type', 'lesson', 'summary', 'Batch two', 'content', 'Two'),
      'provenance', jsonb_build_object('provenance_status', 'generated'),
      'source_refs', jsonb_build_array(jsonb_build_object('uri', 'repo://missing-kind')),
      'embedding', v_embedding
    ),
    jsonb_build_object(
      'idempotency_key', 'rpc-batch-fail:3',
      'content_hash', repeat('c', 64),
      'memory', jsonb_build_object('memory_type', 'lesson', 'summary', 'Batch three', 'content', 'Three'),
      'provenance', jsonb_build_object('provenance_status', 'generated'),
      'embedding', v_embedding
    )
  );

  BEGIN
    PERFORM public.agent_memory_writeback_batch_tx('rpc-batch-workspace', v_items);
    RAISE EXCEPTION 'expected second batch item failure' USING ERRCODE = 'ZX003';
  EXCEPTION
    WHEN not_null_violation THEN NULL;
  END;

  IF (SELECT count(*) FROM public.agent_memories) <> v_memories_before
    OR (SELECT count(*) FROM public.agent_memory_source_refs) <> v_refs_before
    OR (SELECT count(*) FROM public.agent_memory_artifacts) <> v_artifacts_before
    OR (SELECT count(*) FROM public.agent_memory_audit_events) <> v_audits_before THEN
    RAISE EXCEPTION 'failed three-item batch persisted partial rows';
  END IF;

  v_items := jsonb_build_array(
    jsonb_build_object(
      'idempotency_key', 'rpc-batch-missing:1',
      'content_hash', repeat('d', 64),
      'memory', jsonb_build_object('memory_type', 'lesson', 'summary', 'Embedded', 'content', 'Embedded'),
      'provenance', jsonb_build_object('provenance_status', 'generated'),
      'embedding', v_embedding
    ),
    jsonb_build_object(
      'idempotency_key', 'rpc-batch-missing:2',
      'content_hash', repeat('e', 64),
      'memory', jsonb_build_object('memory_type', 'lesson', 'summary', 'Missing', 'content', 'Missing'),
      'provenance', jsonb_build_object('provenance_status', 'generated')
    )
  );

  BEGIN
    PERFORM public.agent_memory_writeback_batch_tx('rpc-batch-workspace', v_items);
    RAISE EXCEPTION 'expected missing batch embedding failure' USING ERRCODE = 'ZX004';
  EXCEPTION
    WHEN invalid_parameter_value THEN
      IF SQLERRM NOT LIKE 'embedding required — batch item 2%' THEN
        RAISE;
      END IF;
  END;

  IF (SELECT count(*) FROM public.agent_memories) <> v_memories_before
    OR (SELECT count(*) FROM public.agent_memory_source_refs) <> v_refs_before
    OR (SELECT count(*) FROM public.agent_memory_artifacts) <> v_artifacts_before
    OR (SELECT count(*) FROM public.agent_memory_audit_events) <> v_audits_before THEN
    RAISE EXCEPTION 'missing-embedding batch persisted partial rows';
  END IF;

  v_result := public.agent_memory_writeback_batch_tx(
    'rpc-workspace',
    jsonb_build_array(
      jsonb_build_object(
        'idempotency_key', 'rpc-write:1',
        'content_hash', repeat('1', 64),
        'memory', jsonb_build_object('memory_type', 'lesson', 'summary', 'Replay', 'content', 'Replay'),
        'provenance', jsonb_build_object('provenance_status', 'generated')
      ),
      jsonb_build_object(
        'idempotency_key', 'rpc-batch-success:1',
        'content_hash', repeat('9', 64),
        'memory', jsonb_build_object('memory_type', 'lesson', 'summary', 'Batch success', 'content', 'Embedded batch item'),
        'provenance', jsonb_build_object('provenance_status', 'generated'),
        'embedding', v_embedding
      )
    )
  );
  IF (v_result->>'count')::INT <> 2
    OR NOT (v_result->'items'->0->>'replayed')::BOOLEAN
    OR (v_result->'items'->1->>'replayed')::BOOLEAN THEN
    RAISE EXCEPTION 'batch replay did not use the existing embedding: %', v_result;
  END IF;

  RAISE NOTICE 'PASS batch rollback and replay-with-existing-embedding semantics';
END
$batch$;

DO $review$
DECLARE
  v_embedding vector(1536) := (
    '[' || array_to_string(array_fill('0.03'::TEXT, ARRAY[1536]), ',') || ']'
  )::vector(1536);
  v_memory_id UUID;
  v_related_id UUID;
  v_scope_id UUID;
  v_result JSONB;
  v_count INT;
BEGIN
  SELECT id INTO v_memory_id
  FROM public.agent_memories
  WHERE workspace_id = 'rpc-workspace' AND idempotency_key = 'rpc-write:1';

  BEGIN
    PERFORM public.agent_memory_review_tx(
      v_memory_id,
      'other-workspace',
      'confirm',
      'reviewer-1',
      p_actor_kind => 'human'
    );
    RAISE EXCEPTION 'expected workspace-bounded lookup failure' USING ERRCODE = 'ZX005';
  EXCEPTION
    WHEN no_data_found THEN
      IF SQLERRM <> 'not found in workspace' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.agent_memory_review_tx(
      v_memory_id,
      'rpc-workspace',
      'confirm',
      'reviewer-agent'
    );
    RAISE EXCEPTION 'expected agent confirm rejection' USING ERRCODE = 'ZX006';
  EXCEPTION
    WHEN invalid_parameter_value THEN
      IF SQLERRM <> 'action confirm requires actor_kind human' THEN RAISE; END IF;
  END;

  v_result := public.agent_memory_review_tx(
    v_memory_id,
    'rpc-workspace',
    'approve',
    'reviewer-human',
    'Human-confirmed in the SQL harness.',
    p_actor_kind => 'human'
  );
  IF v_result->>'action' <> 'confirm'
    OR v_result->'memory'->>'review_status' <> 'confirmed'
    OR v_result->'memory'->>'provenance_status' <> 'user_confirmed'
    OR NOT (v_result->'memory'->>'can_use_as_instruction')::BOOLEAN THEN
    RAISE EXCEPTION 'human approve did not apply confirm transition: %', v_result;
  END IF;

  v_result := public.agent_memory_review_tx(
    v_memory_id,
    'rpc-workspace',
    'edit',
    'reviewer-human',
    p_summary => 'Human edit keeps confirmation',
    p_actor_kind => 'human'
  );
  IF v_result->'memory'->>'review_status' <> 'confirmed'
    OR NOT (v_result->'memory'->>'can_use_as_instruction')::BOOLEAN
    OR (v_result->'memory'->>'requires_user_confirmation')::BOOLEAN THEN
    RAISE EXCEPTION 'human edit did not preserve confirmed instruction state: %', v_result;
  END IF;

  v_result := public.agent_memory_review_tx(
    v_memory_id,
    'rpc-workspace',
    'edit',
    'editor-agent',
    p_content => 'Agent-edited content requires a fresh human review.'
  );
  IF v_result->'memory'->>'review_status' <> 'pending'
    OR (v_result->'memory'->>'can_use_as_instruction')::BOOLEAN
    OR NOT (v_result->'memory'->>'can_use_as_evidence')::BOOLEAN
    OR NOT (v_result->'memory'->>'requires_user_confirmation')::BOOLEAN THEN
    RAISE EXCEPTION 'agent edit did not reset confirmed memory to pending evidence: %', v_result;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.agent_memory_audit_events
    WHERE memory_id = v_memory_id
      AND event_type = 'memory_edited'
      AND actor_kind = 'agent'
      AND payload->>'instruction_grade_reset' = 'true'
  ) THEN
    RAISE EXCEPTION 'agent edit downgrade was not audited';
  END IF;

  v_scope_id := (
    public.agent_memory_writeback_tx(
      'rpc-workspace',
      'rpc-scope:1',
      repeat('5', 64),
      '{"project_id":"rpc-project","visibility":"project","memory_type":"constraint","summary":"Scoped","content":"Keep project scope."}'::jsonb,
      '{"provenance_status":"observed"}'::jsonb,
      p_embedding => v_embedding
    )->>'id'
  )::UUID;
  v_result := public.agent_memory_review_tx(
    v_scope_id,
    'rpc-workspace',
    'restrict_scope',
    'scope-agent',
    p_visibility => 'project'
  );
  IF v_result->'memory'->>'visibility' <> 'project' THEN
    RAISE EXCEPTION 'equal restrict_scope changed visibility: %', v_result;
  END IF;
  BEGIN
    PERFORM public.agent_memory_review_tx(
      v_scope_id,
      'rpc-workspace',
      'restrict_scope',
      'scope-agent',
      p_visibility => 'workspace'
    );
    RAISE EXCEPTION 'expected scope widening rejection' USING ERRCODE = 'ZX007';
  EXCEPTION
    WHEN invalid_parameter_value THEN
      IF SQLERRM <> 'restrict_scope may not widen the existing visibility' THEN RAISE; END IF;
  END;

  v_related_id := (
    public.agent_memory_writeback_tx(
      'rpc-workspace',
      'rpc-related:1',
      repeat('4', 64),
      '{"memory_type":"decision","summary":"Related memory","content":"Canonical replacement."}'::jsonb,
      '{"provenance_status":"observed"}'::jsonb,
      p_embedding => v_embedding
    )->>'id'
  )::UUID;
  v_result := public.agent_memory_review_tx(
    v_memory_id,
    'rpc-workspace',
    'merge',
    'reviewer-human',
    'Merged into the canonical replacement.',
    v_related_id,
    p_actor_kind => 'human'
  );
  IF v_result->'memory'->>'review_status' <> 'merged'
    OR v_result->'memory'->>'lifecycle_status' <> 'superseded' THEN
    RAISE EXCEPTION 'human merge transition failed: %', v_result;
  END IF;
  SELECT count(*) INTO v_count
  FROM public.agent_memory_relations
  WHERE from_memory_id = v_memory_id
    AND to_memory_id = v_related_id
    AND relation = 'merged_into';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'merge relation was not written';
  END IF;

  RAISE NOTICE 'PASS reviewer authority, edit downgrade, equal scope, widening rejection, and merge';
END
$review$;

DO $fault_seed$
DECLARE
  v_embedding vector(1536) := (
    '[' || array_to_string(array_fill('0.04'::TEXT, ARRAY[1536]), ',') || ']'
  )::vector(1536);
BEGIN
  PERFORM public.agent_memory_writeback_tx(
    'rpc-fault-workspace',
    'rpc-confirm-fault:1',
    repeat('6', 64),
    '{"memory_type":"decision","summary":"Confirm fault target","content":"Every review write must roll back."}'::jsonb,
    '{"provenance_status":"observed"}'::jsonb,
    p_embedding => v_embedding
  );
END
$fault_seed$;

CREATE OR REPLACE FUNCTION public.agent_memory_test_fail_confirm_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fault_trigger$
BEGIN
  RAISE EXCEPTION 'injected memory_confirmed audit failure';
END;
$fault_trigger$;

CREATE TRIGGER trg_agent_memory_test_fail_confirm_audit
BEFORE INSERT ON public.agent_memory_audit_events
FOR EACH ROW
WHEN (NEW.event_type = 'memory_confirmed')
EXECUTE FUNCTION public.agent_memory_test_fail_confirm_audit();

DO $fault_injection$
DECLARE
  v_memory_id UUID;
  v_memory_before JSONB;
  v_memory_after JSONB;
  v_reviews_before BIGINT;
  v_relations_before BIGINT;
  v_audits_before BIGINT;
BEGIN
  SELECT id, to_jsonb(memory_row)
  INTO v_memory_id, v_memory_before
  FROM public.agent_memories AS memory_row
  WHERE workspace_id = 'rpc-fault-workspace'
    AND idempotency_key = 'rpc-confirm-fault:1';
  SELECT count(*) INTO v_reviews_before FROM public.agent_memory_review_actions;
  SELECT count(*) INTO v_relations_before FROM public.agent_memory_relations;
  SELECT count(*) INTO v_audits_before FROM public.agent_memory_audit_events;

  BEGIN
    PERFORM public.agent_memory_review_tx(
      v_memory_id,
      'rpc-fault-workspace',
      'confirm',
      'fault-reviewer',
      p_actor_kind => 'human'
    );
    RAISE EXCEPTION 'confirm unexpectedly bypassed audit fault' USING ERRCODE = 'ZX008';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'injected memory_confirmed audit failure' THEN
        RAISE;
      END IF;
  END;

  SELECT to_jsonb(memory_row)
  INTO v_memory_after
  FROM public.agent_memories AS memory_row
  WHERE id = v_memory_id;
  IF v_memory_after IS DISTINCT FROM v_memory_before
    OR (SELECT count(*) FROM public.agent_memory_review_actions) <> v_reviews_before
    OR (SELECT count(*) FROM public.agent_memory_relations) <> v_relations_before
    OR (SELECT count(*) FROM public.agent_memory_audit_events) <> v_audits_before THEN
    RAISE EXCEPTION 'audit fault failed to roll back memory, review, relation, or audit state';
  END IF;

  RAISE NOTICE 'PASS real audit trigger fault rolls back memory, review actions, relations, and audit';
END
$fault_injection$;

DROP TRIGGER trg_agent_memory_test_fail_confirm_audit
  ON public.agent_memory_audit_events;
DROP FUNCTION public.agent_memory_test_fail_confirm_audit();
