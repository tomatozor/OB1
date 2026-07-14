#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA_FILE="$(cd "${SCRIPT_DIR}/.." && pwd)/schema.sql"
TEST_FILE="${SCRIPT_DIR}/test.sql"
DATABASE_URL="${DATABASE_URL:-postgresql://postgres:test@127.0.0.1:55432/postgres}"

echo "==> Creating minimal live-compatible schema"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$roles$;

CREATE TABLE IF NOT EXISTS public.thoughts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  embedding vector(1536),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  content_fingerprint TEXT,
  type TEXT,
  sensitivity_tier TEXT,
  importance SMALLINT,
  quality_score NUMERIC,
  source_type TEXT,
  enriched BOOLEAN
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_thoughts_fingerprint
  ON public.thoughts (content_fingerprint)
  WHERE content_fingerprint IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_thoughts_embedding_ivfflat
  ON public.thoughts USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_thoughts_content_tsvector
  ON public.thoughts USING gin (to_tsvector('simple', coalesce(content, '')));

CREATE INDEX IF NOT EXISTS idx_thoughts_type ON public.thoughts (type);
CREATE INDEX IF NOT EXISTS idx_thoughts_source_type ON public.thoughts (source_type);
CREATE INDEX IF NOT EXISTS idx_thoughts_importance ON public.thoughts (importance);

CREATE OR REPLACE FUNCTION public.upsert_thought(
  p_content TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_fingerprint TEXT;
  v_id UUID;
BEGIN
  -- Formule identique au upsert_thought LIVE (SHA-256 hex du contenu normalisé)
  v_fingerprint := encode(sha256(convert_to(
    lower(trim(regexp_replace(p_content, '\s+', ' ', 'g'))),
    'UTF8'
  )), 'hex');

  INSERT INTO public.thoughts (content, content_fingerprint, metadata)
  VALUES (p_content, v_fingerprint, coalesce(p_payload->'metadata', '{}'::jsonb))
  ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL
  DO UPDATE SET
    updated_at = now(),
    metadata = public.thoughts.metadata || coalesce(EXCLUDED.metadata, '{}'::jsonb)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint);
END;
$$;

-- Minimal reproduction of the superseded install state. The current migration
-- must replace the seven-argument RPC and extend this audit table atomically.
CREATE TABLE public.thought_audit (
  id BIGSERIAL PRIMARY KEY,
  thought_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('capture', 'update', 'delete')),
  diff JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION public.hybrid_search_thoughts(
  p_query TEXT,
  p_query_embedding vector(1536),
  p_limit INT,
  p_offset INT,
  p_filter JSONB,
  p_include_restricted BOOLEAN,
  p_rrf_k INT
)
RETURNS SETOF UUID
LANGUAGE sql
STABLE
AS $$ SELECT NULL::UUID WHERE false $$;
SQL

echo "==> Seeded upgrade state: legacy 7-argument hybrid RPC and audit table"

echo "==> Applying schema.sql (pass 1)"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -f "${SCHEMA_FILE}"

echo "==> Applying schema.sql (pass 2: idempotence)"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -f "${SCHEMA_FILE}"

echo "==> Running synthetic integration assertions"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -f "${TEST_FILE}"

echo "==> ALL HYBRID RECALL TESTS PASSED"
