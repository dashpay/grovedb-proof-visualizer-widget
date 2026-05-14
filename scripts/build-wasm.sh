#!/usr/bin/env bash
# Build the WASM bytes-parser into packages/grovedb-proof-visualizer/wasm/
#
# Requires wasm-pack:
#   curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
#
# Output is git-ignored; run this before `yarn build` if you want the bytes
# input adapter (the JSON IR adapter works without it).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

cd "$ROOT/crates/grovedb-proof-view-wasm"
wasm-pack build --target web \
  --out-dir "$ROOT/packages/grovedb-proof-visualizer/wasm" \
  --release

echo
echo "✓ wasm built into packages/grovedb-proof-visualizer/wasm/"
echo "  next: cd packages/grovedb-proof-visualizer && yarn build"
