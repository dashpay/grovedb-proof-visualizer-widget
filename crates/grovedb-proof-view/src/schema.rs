//! JSON Schema for the [`ProofView`] IR — for TS codegen and runtime validation.

use crate::ir::ProofView;

/// Returns a JSON Schema (Draft-07) describing the `ProofView` IR.
pub fn proof_view_schema() -> serde_json::Value {
    let schema = schemars::schema_for!(ProofView);
    serde_json::to_value(schema).expect("schema serialization is infallible")
}
