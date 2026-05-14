//! Render-friendly intermediate representation for a GroveDB proof.
//!
//! Every input parser (bytes, Display text, JSON) produces a [`ProofView`].
//! The renderer never sees raw bytes — only this AST.
//!
//! Layers are stored flat, indexed by `layer_id`. Cross-layer descents are
//! references via `DescentEdge::to_layer_id`. Layer `0` is always the root.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// A parsed GroveDB proof in render-friendly form.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProofView {
    /// Proof format version: `0` (legacy `GroveDBProofV0`) or `1` (current `GroveDBProofV1`).
    pub version: u8,
    /// Index of the root layer in `layers` (always `0` from the bytes parser, but
    /// surfaced explicitly so consumers don't need to special-case).
    pub root_layer_id: usize,
    /// All layers, indexed by `LayerView::layer_id`. Order is insertion order
    /// (root first, then children in `BTreeMap` key order — i.e. lexicographic
    /// by parent-key).
    pub layers: Vec<LayerView>,
}

/// One layer of the proof: a single Merk-tree's proof, plus pointers into deeper layers.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct LayerView {
    /// Sequential id assigned during construction.
    pub layer_id: usize,
    /// Which backing-store flavor produced this proof.
    pub backing: BackingType,
    /// The path segment (parent-key) that descended into this layer, or `None` for the root.
    pub descended_via: Option<DisplayKey>,
    /// Decoded merk-proof op stream (only meaningful for `Merk` backing).
    pub ops: Vec<MerkOp>,
    /// Reconstructed binary tree of merk-tree nodes — what the renderer draws.
    /// `None` when the backing is non-Merk (we render those as opaque blobs for now).
    pub binary_tree: Option<MerkBinaryTree>,
    /// For non-Merk backings: a short opaque-blob description.
    pub opaque_summary: Option<OpaqueSummary>,
    /// Edges from this layer's nodes into deeper layers, keyed by the parent-key
    /// of the descent. Order matches sorted-key order in the source `BTreeMap`.
    pub descents: Vec<DescentEdge>,
}

/// Which backing store produced this layer's proof.
///
/// Mirrors `grovedb::operations::proof::ProofBytes` variants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BackingType {
    Merk,
    Mmr,
    BulkAppendTree,
    DenseTree,
    CommitmentTree,
}

/// A single op in a merk-tree proof's op stream (post-order traversal driving a stack).
///
/// JSON shape (serde tag is `op`, not `kind`, to avoid collision with the
/// nested `MerkNodeView`'s tag):
///
/// ```json
/// { "op": "push", "node": { "kind": "kv_value_hash", ... } }
/// { "op": "parent" }
/// ```
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum MerkOp {
    Push { node: MerkNodeView },
    PushInverted { node: MerkNodeView },
    Parent,
    Child,
    ParentInverted,
    ChildInverted,
}

/// Reconstructed binary tree (the result of executing the op stream). Renderer draws this.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MerkBinaryTree {
    /// Index of the root node within `nodes`.
    pub root: usize,
    /// All nodes present in the proof. Index = node id.
    pub nodes: Vec<MerkBinaryNode>,
}

/// One node in the reconstructed binary tree.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MerkBinaryNode {
    /// Stable id (also this node's index in `MerkBinaryTree::nodes`).
    pub id: usize,
    /// What information the proof reveals about this node.
    pub view: MerkNodeView,
    /// Optional left child id.
    pub left: Option<usize>,
    /// Optional right child id.
    pub right: Option<usize>,
    /// True if this node ever appeared as the parent in a `Parent`/`Child`/etc op
    /// (i.e. it's an internal node on the queried path's frame).
    pub on_path: bool,
}

/// What a `Push` op revealed about a single merk-tree node.
///
/// Mirrors `grovedb_query::proofs::Node` variants.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MerkNodeView {
    /// Just the subtree's node hash. Opaque sibling.
    Hash { hash: Hex32 },
    /// Just the kv-hash. Internal node on the path whose value isn't revealed.
    KvHash { kv_hash: Hex32 },
    /// Key + value-hash, no value. Boundary key proof.
    KvDigest { key: DisplayKey, value_hash: Hex32 },
    /// Key + value (value-hash implicit as `H(value)`).
    Kv {
        key: DisplayKey,
        value: ElementView,
    },
    /// Key + value + value-hash. The standard "queried node" form.
    KvValueHash {
        key: DisplayKey,
        value: ElementView,
        value_hash: Hex32,
    },
    /// Like `KvValueHash` but with an extra feature-type tag (sum/count flavor).
    KvValueHashFeatureType {
        key: DisplayKey,
        value: ElementView,
        value_hash: Hex32,
        feature_type: FeatureTypeView,
    },
    /// Reference key + referenced value bytes + reference-element hash.
    KvRefValueHash {
        key: DisplayKey,
        value: ElementView,
        value_hash: Hex32,
    },
    /// Counted variants (ProvableCountTree boundary nodes etc.)
    KvCount {
        key: DisplayKey,
        value: ElementView,
        count: u64,
    },
    KvHashCount {
        kv_hash: Hex32,
        count: u64,
    },
    KvRefValueHashCount {
        key: DisplayKey,
        value: ElementView,
        value_hash: Hex32,
        count: u64,
    },
    KvDigestCount {
        key: DisplayKey,
        value_hash: Hex32,
        count: u64,
    },
    /// `KvValueHashFeatureType` plus the child-hash, used when an in-result tree
    /// element has no lower-layer proof. The `child_hash` lets the verifier check
    /// `combine_hash(H(value), child_hash) == value_hash` directly.
    KvValueHashFeatureTypeWithChildHash {
        key: DisplayKey,
        value: ElementView,
        value_hash: Hex32,
        feature_type: FeatureTypeView,
        child_hash: Hex32,
    },
    /// Compressed in-range subtree (AggregateCountOnRange).
    HashWithCount {
        kv_hash: Hex32,
        left_child_hash: Hex32,
        right_child_hash: Hex32,
        count: u64,
    },
}

/// Mirrors `grovedb_query::proofs::TreeFeatureType`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FeatureTypeView {
    BasicMerkNode,
    SummedMerkNode { sum: i64 },
    BigSummedMerkNode { sum: String /* i128 as decimal */ },
    CountedMerkNode { count: u64 },
    CountedSummedMerkNode { count: u64, sum: i64 },
    ProvableCountedMerkNode { count: u64 },
    ProvableCountedSummedMerkNode { count: u64, sum: i64 },
}

/// Decoded `Element` value attached to a node, in render-friendly form.
///
/// Mirrors `grovedb_element::Element`. We collapse `Option<ElementFlags>` into
/// a top-level `flags` field on each variant for ergonomics.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ElementView {
    /// A subtree's merk-root pointer. The renderer draws a dotted edge to
    /// the layer whose merk-root matches `merk_root` (when known).
    Tree {
        /// Optional merk-root hash of the child subtree.
        merk_root: Option<HexBytes>,
        flags: Option<HexBytes>,
    },
    /// `Tree` variant for sum trees.
    SumTree {
        merk_root: Option<HexBytes>,
        sum: i64,
        flags: Option<HexBytes>,
    },
    BigSumTree {
        merk_root: Option<HexBytes>,
        sum: String,
        flags: Option<HexBytes>,
    },
    CountTree {
        merk_root: Option<HexBytes>,
        count: u64,
        flags: Option<HexBytes>,
    },
    CountSumTree {
        merk_root: Option<HexBytes>,
        count: u64,
        sum: i64,
        flags: Option<HexBytes>,
    },
    ProvableCountTree {
        merk_root: Option<HexBytes>,
        count: u64,
        flags: Option<HexBytes>,
    },
    ProvableCountSumTree {
        merk_root: Option<HexBytes>,
        count: u64,
        sum: i64,
        flags: Option<HexBytes>,
    },
    Item {
        value: HexBytes,
        flags: Option<HexBytes>,
    },
    ItemWithSumItem {
        value: HexBytes,
        sum: i64,
        flags: Option<HexBytes>,
    },
    SumItem {
        sum: i64,
        flags: Option<HexBytes>,
    },
    Reference {
        reference: ReferenceView,
        max_hop: Option<u8>,
        flags: Option<HexBytes>,
    },
    CommitmentTree {
        total_count: u64,
        chunk_power: u8,
        flags: Option<HexBytes>,
    },
    MmrTree {
        mmr_size: u64,
        flags: Option<HexBytes>,
    },
    BulkAppendTree {
        total_count: u64,
        chunk_power: u8,
        flags: Option<HexBytes>,
    },
    DenseAppendOnlyFixedSizeTree {
        count: u16,
        height: u8,
        flags: Option<HexBytes>,
    },
    /// `NonCounted(Box<Element>)` — wraps another element. Renderer styles with
    /// a dashed border to flag the contributes-zero-to-parent-count property.
    NonCounted { inner: Box<ElementView> },
    /// `NotSummed(Box<Element>)` — wraps a sum-bearing tree variant. Renderer
    /// styles with a dashed border to flag the contributes-zero-to-parent-sum
    /// property.
    NotSummed { inner: Box<ElementView> },
    /// Element bytes that we couldn't decode. Surfaced rather than dropped.
    Unknown { raw_hex: String, error: String },
}

/// Reference-path payload, render-friendly.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReferenceView {
    Absolute { path: Vec<DisplayKey> },
    UpstreamRootHeight { n_keep: u8, path_append: Vec<DisplayKey> },
    UpstreamRootHeightWithParentPathAddition { n_keep: u8, path_append: Vec<DisplayKey> },
    UpstreamFromElementHeight { n_remove: u8, path_append: Vec<DisplayKey> },
    Cousin { swap_parent: DisplayKey },
    RemovedCousin { swap_parent: Vec<DisplayKey> },
    Sibling { sibling_key: DisplayKey },
}

/// Edge to a deeper layer.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DescentEdge {
    /// The parent-key in this layer that points down.
    pub from_key: DisplayKey,
    /// The destination layer's id.
    pub to_layer_id: usize,
    /// If a node in this layer's `binary_tree` exposed a `Tree(merk_root, ...)` value
    /// matching the destination layer's merk-root, this is the source node's id.
    /// (Useful for the renderer to anchor the cross-layer arrow.)
    pub from_node_id: Option<usize>,
}

/// For non-Merk backings: a short summary instead of a full node breakdown.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct OpaqueSummary {
    pub backing: BackingType,
    pub byte_length: usize,
    pub raw_hex_truncated: String,
}

/// A 32-byte hash, hex-encoded.
pub type Hex32 = String;

/// Arbitrary bytes, hex-encoded.
pub type HexBytes = String;

/// A merk-tree key in the form most useful for rendering: ASCII when printable,
/// hex otherwise. The full hex is always kept on the side for hover/inspection.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DisplayKey {
    /// Pretty form: ASCII when the bytes are printable, otherwise `0x…` hex.
    pub display: String,
    /// Full hex encoding (no `0x` prefix), always available.
    pub hex: String,
    /// True iff `display` is the ASCII form (i.e. all bytes were printable).
    pub is_ascii: bool,
}

impl DisplayKey {
    pub fn from_bytes(key: &[u8]) -> Self {
        let display = grovedb::operations::proof::util::hex_to_ascii(key);
        let is_ascii = !display.starts_with("0x");
        DisplayKey {
            display,
            hex: hex::encode(key),
            is_ascii,
        }
    }
}
