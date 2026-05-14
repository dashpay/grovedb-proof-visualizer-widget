//! `wasm-bindgen` wrapper. Phase 3.

#![allow(unused)]

use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

/// Decode hex-encoded proof bytes into a `ProofView` JSON object.
#[wasm_bindgen(js_name = parseBytes)]
pub fn parse_bytes_hex(hex_input: &str) -> Result<JsValue, JsValue> {
    let trimmed = hex_input.trim().trim_start_matches("0x");
    let bytes = hex::decode(trimmed).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let view = grovedb_proof_view::parse_bytes(&bytes)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    serde_wasm_bindgen::to_value(&view).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Decode raw proof bytes (Uint8Array on the JS side) into a `ProofView` JSON object.
#[wasm_bindgen(js_name = parseBytesRaw)]
pub fn parse_bytes_raw(bytes: &[u8]) -> Result<JsValue, JsValue> {
    let view = grovedb_proof_view::parse_bytes(bytes)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    serde_wasm_bindgen::to_value(&view).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Parse a `GroveDBProof::Display` text dump into a `ProofView` JSON object.
#[wasm_bindgen(js_name = parseText)]
pub fn parse_text(text: &str) -> Result<JsValue, JsValue> {
    let view = grovedb_proof_view::parse_text(text)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    serde_wasm_bindgen::to_value(&view).map_err(|e| JsValue::from_str(&e.to_string()))
}
