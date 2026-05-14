//! Print the JSON Schema for `ProofView` to stdout. Use this to drive
//! TypeScript type generation in `packages/grovedb-proof-visualizer`.
//!
//! Usage:
//!   cargo run -p grovedb-proof-view --example dump_schema > packages/grovedb-proof-visualizer/proof-view.schema.json

use grovedb_proof_view::schema::proof_view_schema;

fn main() {
    let schema = proof_view_schema();
    println!("{}", serde_json::to_string_pretty(&schema).unwrap());
}
