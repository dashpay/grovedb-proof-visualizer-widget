//! Parse the human-readable `GroveDBProof::Display` string into a [`ProofView`].
//!
//! Stub — implemented in phase 4. Returns an `Unsupported` error for now.

use crate::error::ParseError;
use crate::ir::ProofView;

pub fn parse_text(_input: &str) -> Result<ProofView, ParseError> {
    Err(ParseError::Text {
        offset: 0,
        message: "text parser not yet implemented (phase 4)".into(),
    })
}
