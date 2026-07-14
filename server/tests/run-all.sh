#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
deno check index.ts
deno test --allow-env --allow-net index_test.ts
node test-stateless.mjs
