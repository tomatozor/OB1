#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/deploy.sh [--project-ref REF] [--with-agent-memory] [--dry-run]

Builds the canonical Edge artifact, type-checks it, runs the complete server
suite, and deploys open-brain-mcp. --with-agent-memory also deploys the canonical
integration from integrations/agent-memory-api. --dry-run stops before Supabase.
EOF
}

die() {
  printf 'deploy: %s\n' "$*" >&2
  exit 1
}

project_ref=""
with_agent_memory=false
dry_run=false

while (($# > 0)); do
  case "$1" in
    --project-ref)
      (($# >= 2)) || die "--project-ref requires a value"
      [[ -n "$2" && "$2" != -* ]] || die "invalid --project-ref value"
      project_ref="$2"
      shift 2
      ;;
    --with-agent-memory)
      with_agent_memory=true
      shift
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
server_root="$(cd "$script_dir/.." && pwd)"
repository_root="$(cd "$server_root/.." && pwd)"
deploy_workdir="$repository_root/.edge-build/server-deploy"
mcp_artifact="$deploy_workdir/supabase/functions/open-brain-mcp"
agent_memory_artifact="$deploy_workdir/supabase/functions/agent-memory-api"

for command_name in node deno bash; do
  command -v "$command_name" >/dev/null 2>&1 || die "$command_name is required"
done

printf '[1/3] Building canonical open-brain-mcp artifact\n'
node "$repository_root/scripts/build-edge-deploy.mjs" --out "$mcp_artifact"

printf '[2/3] Type-checking generated Edge artifact\n'
deno check --no-lock --config "$mcp_artifact/deno.json" "$mcp_artifact/index.ts"

if [[ "$with_agent_memory" == true ]]; then
  source_agent_memory="$repository_root/integrations/agent-memory-api"
  [[ -f "$source_agent_memory/index.ts" ]] || die "agent-memory-api index.ts is missing"
  [[ -f "$source_agent_memory/deno.json" ]] || die "agent-memory-api deno.json is missing"
  mkdir -p "$agent_memory_artifact"
  find "$agent_memory_artifact" -mindepth 1 -maxdepth 1 -type f -delete
  cp "$source_agent_memory/index.ts" "$agent_memory_artifact/index.ts"
  cp "$source_agent_memory/deno.json" "$agent_memory_artifact/deno.json"
  if [[ -f "$source_agent_memory/deno.lock" ]]; then
    cp "$source_agent_memory/deno.lock" "$agent_memory_artifact/deno.lock"
  fi
  printf '[2/3] Type-checking agent-memory-api artifact\n'
  deno check --no-lock --config "$agent_memory_artifact/deno.json" \
    "$agent_memory_artifact/index.ts"
fi

printf '[3/3] Running complete server suite\n'
bash "$server_root/tests/run-all.sh"

if [[ "$dry_run" == true ]]; then
  printf 'Dry run complete: deployment skipped.\n'
  exit 0
fi

command -v supabase >/dev/null 2>&1 || die "supabase CLI is required for deployment"

if [[ -z "$project_ref" ]]; then
  linked_project="$repository_root/supabase/.temp/linked-project.json"
  [[ -f "$linked_project" ]] || die \
    "no project ref: pass --project-ref REF or link the repository with Supabase"
  project_ref="$(node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (typeof value.ref !== "string" || value.ref.length === 0) process.exit(1);
    process.stdout.write(value.ref);
  ' "$linked_project")" || die "linked Supabase project ref is invalid"
fi

[[ "$project_ref" =~ ^[a-z0-9]+$ ]] || die "project ref must be lowercase alphanumeric"

functions=(open-brain-mcp)
if [[ "$with_agent_memory" == true ]]; then
  functions+=(agent-memory-api)
fi

printf 'Deploying verified function artifact(s) to the selected Supabase project\n'
SUPABASE_TELEMETRY_DISABLED=1 supabase functions deploy "${functions[@]}" \
  --use-api \
  --no-verify-jwt \
  --project-ref "$project_ref" \
  --workdir "$deploy_workdir"

printf 'Deployment complete.\n'
