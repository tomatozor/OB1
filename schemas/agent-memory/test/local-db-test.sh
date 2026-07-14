#!/usr/bin/env bash
set -euo pipefail

CONTAINER="ob-thanos-am-pg"
PORT="55433"
IMAGE="pgvector/pgvector:pg16"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA="$(cd "$SCRIPT_DIR/.." && pwd)/schema.sql"
ORIGIN_MAIN_SCHEMA="$SCRIPT_DIR/origin-main-schema.sql"
RPC_TEST="$SCRIPT_DIR/transactional-rpc-test.sql"
UPGRADE_TEST="$SCRIPT_DIR/upgrade-test.sql"
started=0

cleanup() {
  if [[ "$started" == "1" ]]; then
    docker rm -f "$CONTAINER" >/dev/null
    echo "PASS cleanup: removed $CONTAINER"
  fi
}
trap cleanup EXIT

if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "ERROR: container $CONTAINER already exists; refusing to remove an unowned container" >&2
  exit 1
fi

docker run --rm -d \
  --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=postgres \
  -p "127.0.0.1:$PORT:5432" \
  "$IMAGE" >/dev/null
started=1
echo "PASS docker start: $CONTAINER on port $PORT"

ready=0
for attempt in $(seq 1 30); do
  if docker exec "$CONTAINER" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != "1" ]]; then
  echo "ERROR: PostgreSQL did not become ready" >&2
  exit 1
fi
echo "PASS postgres ready"

docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.thoughts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  embedding vector(1536),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL
echo "PASS minimal live-compatible thoughts table"

docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$SCHEMA" >/dev/null
echo "PASS schema apply 1"
docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$SCHEMA" >/dev/null
echo "PASS schema apply 2 (idempotent)"

table_count="$(docker exec "$CONTAINER" psql -Atq -U postgres -d postgres -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'agent_memor%';")"
if [[ "$table_count" != "8" ]]; then
  echo "ERROR: expected 8 Agent Memory tables, found $table_count" >&2
  exit 1
fi
echo "PASS table count: $table_count"

docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<'SQL'
WITH synthetic_thought AS (
  INSERT INTO public.thoughts (content, metadata)
  VALUES ('Synthetic Agent Memory SQL test.', '{"source":"local-db-test"}'::jsonb)
  RETURNING id
)
INSERT INTO public.agent_memories (
  thought_id,
  workspace_id,
  project_id,
  visibility,
  memory_type,
  summary,
  content,
  provenance_status,
  lifecycle_status,
  review_status,
  idempotency_key,
  content_hash
)
SELECT
  id,
  'local-smoke',
  'agent-memory-schema-test',
  'project',
  'lesson',
  'Synthetic memory',
  'Synthetic Agent Memory SQL test.',
  'generated',
  'active',
  'pending',
  'sql-smoke:0',
  repeat('a', 64)
FROM synthetic_thought;
SQL
echo "PASS synthetic memory insert"

docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
  "UPDATE public.agent_memories SET lifecycle_status = 'stale' WHERE workspace_id = 'local-smoke' AND idempotency_key = 'sql-smoke:0';" >/dev/null
lifecycle_audit_count="$(docker exec "$CONTAINER" psql -Atq -U postgres -d postgres -c \
  "SELECT count(*) FROM public.agent_memory_audit_events WHERE workspace_id = 'local-smoke' AND payload->>'source' = 'lifecycle_trigger' AND payload->>'lifecycle_status' = 'stale';")"
if [[ "$lifecycle_audit_count" != "1" ]]; then
  echo "ERROR: expected one atomic lifecycle audit, found $lifecycle_audit_count" >&2
  exit 1
fi
echo "PASS logical lifecycle change audited atomically"

expect_invalid() {
  local label="$1"
  local statement="$2"
  local output
  local status

  set +e
  output="$(docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c "$statement" 2>&1)"
  status=$?
  set -e

  if [[ "$status" == "0" ]]; then
    echo "ERROR: invalid $label value was accepted" >&2
    exit 1
  fi
  echo "PASS $label constraint: rejected invalid value"
  echo "$output" | tail -n 2
}

memory_insert_prefix="INSERT INTO public.agent_memories (workspace_id, visibility, memory_type, summary, content, provenance_status, lifecycle_status, review_status, idempotency_key, content_hash) VALUES"
expect_invalid "visibility" "$memory_insert_prefix ('local-smoke', 'invalid', 'lesson', 'bad', 'bad', 'generated', 'active', 'pending', 'invalid-visibility:0', repeat('b', 64));"
expect_invalid "provenance_status" "$memory_insert_prefix ('local-smoke', 'project', 'lesson', 'bad', 'bad', 'invalid', 'active', 'pending', 'invalid-provenance:0', repeat('c', 64));"
expect_invalid "lifecycle_status" "$memory_insert_prefix ('local-smoke', 'project', 'lesson', 'bad', 'bad', 'generated', 'invalid', 'pending', 'invalid-lifecycle:0', repeat('d', 64));"
expect_invalid "review action" "INSERT INTO public.agent_memory_review_actions (memory_id, action) SELECT id, 'invalid' FROM public.agent_memories LIMIT 1;"

index_count="$(docker exec "$CONTAINER" psql -Atq -U postgres -d postgres -c \
  "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('idx_agent_memories_workspace_created', 'idx_agent_memories_thought', 'idx_agent_memories_review', 'idx_agent_memories_lifecycle');")"
if [[ "$index_count" != "4" ]]; then
  echo "ERROR: expected 4 required indexes, found $index_count" >&2
  exit 1
fi
echo "PASS required index count: $index_count"

docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$RPC_TEST"
echo "PASS transactional governance RPC assertions"

docker exec "$CONTAINER" createdb -U postgres agent_memory_upgrade
docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d agent_memory_upgrade >/dev/null <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE public.thoughts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  embedding vector(1536),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL
echo "PASS upgrade database minimal thoughts table"

docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d agent_memory_upgrade < "$ORIGIN_MAIN_SCHEMA" >/dev/null
echo "PASS installed exact origin/main Agent Memory schema"

docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d agent_memory_upgrade >/dev/null <<'SQL'
DO $pre_upgrade$
BEGIN
  IF to_regclass('public.idx_agent_memories_idempotency_key') IS NULL THEN
    RAISE EXCEPTION 'origin/main global idempotency index is missing';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.agent_memories', 'DELETE') THEN
    RAISE EXCEPTION 'origin/main reproduction does not grant DELETE';
  END IF;
END
$pre_upgrade$;

WITH legacy_nullable AS (
  INSERT INTO public.agent_memories (
    workspace_id, visibility, memory_type, summary, content,
    provenance_status, lifecycle_status, review_status,
    idempotency_key, content_hash
  ) VALUES (
    'legacy-workspace', 'organization', 'lesson', 'Legacy nullable row',
    'Legacy content must survive.', 'generated', 'active', 'pending', NULL, NULL
  )
  RETURNING id
)
INSERT INTO public.agent_memory_source_refs (memory_id, source_kind, uri)
SELECT id, 'runbook', 'repo://legacy-source' FROM legacy_nullable;

INSERT INTO public.agent_memories (
  workspace_id, visibility, memory_type, summary, content,
  provenance_status, lifecycle_status, review_status,
  idempotency_key, content_hash
) VALUES (
  'legacy-workspace', 'project', 'decision', 'Legacy populated row',
  'Existing keys must survive.', 'observed', 'active', 'pending',
  'legacy-existing-key', repeat('f', 64)
);
SQL
echo "PASS seeded origin/main rows, including NULL migration inputs"

docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d agent_memory_upgrade < "$SCHEMA" >/dev/null
echo "PASS upgraded origin/main schema to current schema"
docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d agent_memory_upgrade < "$SCHEMA" >/dev/null
echo "PASS upgraded schema reapply (idempotent)"
docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d agent_memory_upgrade < "$UPGRADE_TEST"
echo "PASS origin/main upgrade assertions"

echo "PASS Agent Memory SQL local test"
