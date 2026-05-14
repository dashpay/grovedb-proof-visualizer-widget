# grovedb-proof-visualizer

A reusable widget for rendering [GroveDB](https://github.com/dashpay/grovedb) proofs in browsers and in [mdBook](https://github.com/rust-lang/mdBook), the way [mermaid](https://mermaid.js.org) renders flowcharts.

GroveDB proofs are recursive `LayerProof` trees: each layer carries a Merk-tree proof (an op stream of `Push`/`Parent`/`Child` over `Hash` / `KVHash` / `KVValueHash` / `KVValueHashFeatureTypeWithChildHash` / etc.) plus a `lower_layers: BTreeMap<Key, LayerProof>` for descent into nested subtrees. The result is hard to read as raw text. This widget renders them as the layered diagram you actually want.

## Inputs

Three input formats, one rendered widget:

| Format         | How it gets there                                     |
|----------------|--------------------------------------------------------|
| **Raw bytes**  | hex/base64 string → WASM bincode decoder → IR          |
| **Display text** (`GroveDBProofV1 { ... }`) | recursive-descent parser → IR             |
| **Proof IR JSON** | direct deserialization, validated against schema    |

## Crates / packages

| Path                                  | What it does                                                                  |
|---------------------------------------|-------------------------------------------------------------------------------|
| `crates/grovedb-proof-view`           | Rust core: IR (`ProofView`), bytes parser, text parser, JSON Schema export.    |
| `crates/grovedb-proof-view-wasm`      | `wasm-bindgen` wrapper exposing all three input parsers to JS.                |
| `crates/mdbook-grovedb-proof`         | mdBook preprocessor: ` ```grovedb-proof ` fenced blocks → embedded widget HTML. |
| `packages/grovedb-proof-visualizer`   | TypeScript renderer + `<grovedb-proof>` Web Component + React wrapper.        |

## Development

```bash
# Rust core + tests
cargo test --workspace

# Build WASM
cd crates/grovedb-proof-view-wasm && wasm-pack build --target web

# TS renderer
cd packages/grovedb-proof-visualizer && yarn install && yarn build
```
