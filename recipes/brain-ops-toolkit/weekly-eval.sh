#!/usr/bin/env bash
# Cron-safe weekly retrieval regression check. Does not write Open Brain.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GOLDEN_PATH="${GOLDEN_PATH:-$HOME/.local/state/openbrain/golden-real.jsonl}"
EVAL_OUT_DIR="${EVAL_OUT_DIR:-$HOME/.local/state/openbrain/evals}"
ENV_FILE="${ENV_FILE:-}"
mkdir -p "$EVAL_OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$EVAL_OUT_DIR/retrieval-eval-$STAMP.json"
ARGS=(--golden "$GOLDEN_PATH" --modes semantic,hybrid --k 10 --out "$OUT")
if [[ -n "$ENV_FILE" ]]; then ARGS+=(--env-file "$ENV_FILE"); fi
node "$ROOT/recipes/retrieval-eval-harness/run-eval.mjs" "${ARGS[@]}"

PREVIOUS="$(find "$EVAL_OUT_DIR" -maxdepth 1 -type f -name 'retrieval-eval-*.json' ! -path "$OUT" -print 2>/dev/null | sort | tail -n 1 || true)"
if [[ -z "$PREVIOUS" ]]; then echo "OK: premier rapport hebdomadaire: $OUT"; exit 0; fi
set +e
node - "$PREVIOUS" "$OUT" <<'NODE'
const fs = require("node:fs");
const [previous, current] = process.argv.slice(2).map((p) => JSON.parse(fs.readFileSync(p, "utf8")));
let regression = false;
for (const mode of ["semantic", "hybrid"]) {
  const before = previous.modes?.[mode]?.metrics, after = current.modes?.[mode]?.metrics;
  if (!before || !after) { console.log(`ALERTE: métriques ${mode} absentes`); regression = true; continue; }
  for (const metric of ["hit_at_k", "mrr"]) {
    const baseline = before[metric], value = after[metric];
    const decline = baseline === 0 ? (value < 0 ? Infinity : 0) : (baseline - value) / baseline;
    if (decline > 0.10) { console.log(`ALERTE: ${mode} ${metric} régresse de ${(decline * 100).toFixed(1)}% (> 10%)`); regression = true; }
  }
}
process.exitCode = regression ? 2 : 0;
NODE
status=$?
set -e
if [[ $status -ne 0 ]]; then exit "$status"; fi
echo "OK: aucune régression hit@10/MRR supérieure à 10%: $OUT"
