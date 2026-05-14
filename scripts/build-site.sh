#!/usr/bin/env bash
# Build the public playground site into ./site-build/ — the artifact uploaded
# to GitHub Pages by .github/workflows/pages.yml.
#
# Output structure (everything served as static files):
#
#   site-build/
#     index.html              # the playground
#     app.js, app.css         # playground logic + styles
#     dist/                   # @dashpay/grovedb-proof-visualizer build output
#       index.js, wasm.js, style.css, …
#     wasm/                   # wasm-bindgen output
#       grovedb_proof_view_wasm_bg.wasm, …
#     examples/               # bundled fixtures the playground can load
#       query1_count.{json,txt,hex}
#
# Run locally to preview: ./scripts/build-site.sh && python3 -m http.server --directory site-build 8080

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT="$ROOT/site-build"

echo "→ cleaning $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"

echo "→ regenerating example fixtures"
cargo run -q -p grovedb-proof-view --example synth_fixture > "$ROOT/examples/fixtures/query1_count.json"
cargo run -q -p grovedb-proof-view --example synth_hex > "$ROOT/examples/fixtures/query1_count.hex"

echo "→ building wasm"
"$ROOT/scripts/build-wasm.sh"

echo "→ building TypeScript package"
cd "$ROOT/packages/grovedb-proof-visualizer"
if command -v yarn >/dev/null 2>&1; then
  yarn install --frozen-lockfile
  yarn build
else
  npm ci
  npm run build
fi

echo "→ staging site-build/"
cp -r "$ROOT/site/." "$OUT/"
mkdir -p "$OUT/dist" "$OUT/wasm" "$OUT/examples"
cp -r "$ROOT/packages/grovedb-proof-visualizer/dist/." "$OUT/dist/"
cp -r "$ROOT/packages/grovedb-proof-visualizer/wasm/." "$OUT/wasm/"
cp "$ROOT/examples/fixtures/query1_count.json" "$OUT/examples/query1_count.json"
cp "$ROOT/examples/fixtures/query1_count.hex" "$OUT/examples/query1_count.hex"
cp "$ROOT/packages/grovedb-proof-visualizer/demo/query1_count.txt" "$OUT/examples/query1_count.txt"

echo
echo "✓ site built into $OUT"
echo "  preview locally: python3 -m http.server --directory $OUT 8080"
