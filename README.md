# grovedb-proof-visualizer

A reusable widget for rendering [GroveDB](https://github.com/dashpay/grovedb) proofs in browsers and in [mdBook](https://github.com/rust-lang/mdBook), the way [mermaid](https://mermaid.js.org) renders flowcharts.

## 🌐 Live playground

**[dashpay.github.io/grovedb-proof-visualizer-widget](https://dashpay.github.io/grovedb-proof-visualizer-widget/)** — paste a proof (any of the three formats), see it rendered. Bytes / text parsing happens entirely in WebAssembly in your browser; nothing leaves the page.

GroveDB proofs are recursive `LayerProof` trees: each layer carries a Merk-tree proof (an op stream of `Push`/`Parent`/`Child` over `Hash` / `KVHash` / `KVValueHash` / `KVValueHashFeatureTypeWithChildHash` / etc.) plus a `lower_layers: BTreeMap<Key, LayerProof>` for descent into nested subtrees. The result is hard to read as raw text. This widget renders them as the layered diagram you actually want.

## Inputs

Three input formats, one rendered widget:

| Format         | How it gets there                                     |
|----------------|--------------------------------------------------------|
| **Raw bytes**  | hex/base64 string → WASM bincode decoder → IR          |
| **Display text** (`GroveDBProofV1 { ... }`) | recursive-descent parser → IR             |
| **Proof IR JSON** | direct deserialization                              |

## Crates / packages

| Path                                  | What it does                                                                  |
|---------------------------------------|-------------------------------------------------------------------------------|
| `crates/grovedb-proof-view`           | Rust core: IR (`ProofView`), bytes parser, Display-text parser (WIP), JSON Schema export. |
| `crates/grovedb-proof-view-wasm`      | `wasm-bindgen` wrapper exposing all three input parsers to JS.                |
| `crates/mdbook-grovedb-proof`         | mdBook preprocessor: ` ```grovedb-proof ` fenced blocks → embedded widget HTML (deferred). |
| `packages/grovedb-proof-visualizer`   | TypeScript renderer + `<grovedb-proof>` Web Component.                        |

## Quick start

```bash
# 1. Run the Rust tests
cargo test --workspace

# 2. Build the WASM bytes-parser (optional — only needed for `format: "bytes"`)
./scripts/build-wasm.sh

# 3. Build the TS renderer
cd packages/grovedb-proof-visualizer
yarn install && yarn build

# 4. Demo
python3 -m http.server --directory . 8080
# open http://localhost:8080/demo/
```

## Build the playground locally

```bash
./scripts/build-site.sh
python3 -m http.server --directory site-build 8080
# open http://localhost:8080/
```

The same script runs in CI ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)) on every push to `master`, deploying the result to GitHub Pages.

## Using it on a web page

```html
<link rel="stylesheet" href="node_modules/@dashpay/grovedb-proof-visualizer/dist/style.css" />
<grovedb-proof format="json" src="my-proof.json"></grovedb-proof>
<script type="module">
  import "@dashpay/grovedb-proof-visualizer/component";
</script>
```

For raw-bytes input, register the WASM adapter once at startup:

```js
import { setAdapters } from "@dashpay/grovedb-proof-visualizer/component";
import { loadWasmAdapters } from "@dashpay/grovedb-proof-visualizer/wasm";

setAdapters(await loadWasmAdapters());
```

## IR / JSON Schema

The intermediate representation is documented in
[`crates/grovedb-proof-view/src/ir.rs`](crates/grovedb-proof-view/src/ir.rs)
and exported as a JSON Schema at
[`packages/grovedb-proof-visualizer/proof-view.schema.json`](packages/grovedb-proof-visualizer/proof-view.schema.json).

To regenerate the schema:

```bash
cargo run -p grovedb-proof-view --example dump_schema \
  > packages/grovedb-proof-visualizer/proof-view.schema.json
```

To dump a sample IR JSON for any hex-encoded GroveDB proof:

```bash
cargo run -p grovedb-proof-view --example dump_proof -- <hex>
```

## Pin

GroveDB is pinned to `a917d92d2477672eed73c4c08e53e93449a6a094` (matches
[dash-platform v3.1-dev's `Cargo.lock`](https://github.com/dashpay/platform/blob/v3.1-dev/Cargo.lock)).
Bump in `Cargo.toml` `[workspace.dependencies]` to upgrade.
