use thiserror::Error;

#[derive(Debug, Error)]
pub enum ParseError {
    #[error("bincode decode failed: {0}")]
    Bincode(#[from] bincode::error::DecodeError),

    #[error("merk-proof op decode failed: {0}")]
    MerkDecode(String),

    #[error("binary-tree reconstruction failed: {0}")]
    TreeReconstruct(String),

    #[error("hex decode failed: {0}")]
    Hex(#[from] hex::FromHexError),

    #[error("display-text parse failed at byte {offset}: {message}")]
    Text { offset: usize, message: String },

    #[error("json deserialization failed: {0}")]
    Json(#[from] serde_json::Error),
}
