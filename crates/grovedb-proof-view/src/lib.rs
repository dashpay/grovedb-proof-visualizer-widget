//! Render-friendly intermediate representation for GroveDB proofs.
//!
//! Three input formats, one output:
//!
//! ```text
//! raw bytes ─┐
//! Display ───┼──> ProofView (IR / JSON)
//! ProofView ─┘
//! ```
//!
//! - [`bytes::parse_bytes`] decodes bincode-encoded `GroveDBProof` blobs.
//! - [`text::parse_text`] (feature `text-parser`) parses the human-readable
//!   `GroveDBProof::Display` string.
//! - [`schema::proof_view_schema`] (feature `schema`) returns a JSON Schema
//!   describing the `ProofView` for ts-codegen / validation.

pub mod bytes;
pub mod element;
pub mod error;
pub mod ir;

#[cfg(feature = "text-parser")]
pub mod text;

#[cfg(feature = "schema")]
pub mod schema;

pub use bytes::{parse_bytes, parse_proof};
pub use error::ParseError;
pub use ir::*;

#[cfg(feature = "text-parser")]
pub use text::parse_text;
