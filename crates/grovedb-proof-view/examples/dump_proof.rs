//! Decode a hex-encoded proof from stdin (or first arg) and print the `ProofView` JSON.
//!
//! Usage:
//!   cargo run -p grovedb-proof-view --example dump_proof -- <hex>
//!   echo <hex> | cargo run -p grovedb-proof-view --example dump_proof

use std::io::Read;

use grovedb_proof_view::parse_bytes;

fn main() {
    let hex_input: String = match std::env::args().nth(1) {
        Some(arg) => arg,
        None => {
            let mut buf = String::new();
            std::io::stdin()
                .read_to_string(&mut buf)
                .expect("read stdin");
            buf
        }
    };
    let hex_input = hex_input.trim();
    let bytes = hex::decode(hex_input).expect("input is hex-encoded");
    let view = parse_bytes(&bytes).expect("decode proof");
    let json = serde_json::to_string_pretty(&view).expect("serialize JSON");
    println!("{json}");
}
