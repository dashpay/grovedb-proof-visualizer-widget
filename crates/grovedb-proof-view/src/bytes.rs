//! Decode raw GroveDB proof bytes (bincode-encoded `GroveDBProof`) into a [`ProofView`].

use bincode::config::standard;
use grovedb::operations::proof::{
    GroveDBProof, LayerProof as GLayerProof, MerkOnlyLayerProof, ProofBytes,
};
use grovedb_merk::proofs::{Decoder as MerkDecoder, Node, Op};
use grovedb_query::proofs::TreeFeatureType;

use crate::element::decode_element_view;
use crate::error::ParseError;
use crate::ir::*;

/// Decode bincode-encoded proof bytes into a [`ProofView`].
pub fn parse_bytes(proof_bytes: &[u8]) -> Result<ProofView, ParseError> {
    let config = standard().with_big_endian().with_no_limit();
    let (proof, _): (GroveDBProof, _) =
        bincode::decode_from_slice(proof_bytes, config).map_err(ParseError::Bincode)?;
    parse_proof(&proof)
}

/// Decode an already-parsed `GroveDBProof` into a [`ProofView`].
pub fn parse_proof(proof: &GroveDBProof) -> Result<ProofView, ParseError> {
    let mut builder = Builder::default();
    let (version, root_layer_id) = match proof {
        GroveDBProof::V0(v0) => {
            let root_id = build_v0_layer(&mut builder, &v0.root_layer, None)?;
            (0u8, root_id)
        }
        GroveDBProof::V1(v1) => {
            let root_id = build_v1_layer(&mut builder, &v1.root_layer, None)?;
            (1u8, root_id)
        }
    };
    Ok(ProofView { version, root_layer_id, layers: builder.layers })
}

#[derive(Default)]
struct Builder {
    layers: Vec<LayerView>,
}

impl Builder {
    /// Reserve a layer slot, returning its id. The slot is filled in via
    /// `commit` once the layer is fully built. We reserve before recursion
    /// so children get strictly higher ids than their parent (the root is
    /// always layer 0).
    fn reserve(&mut self) -> usize {
        let id = self.layers.len();
        self.layers.push(LayerView {
            layer_id: id,
            backing: BackingType::Merk,
            descended_via: None,
            ops: Vec::new(),
            binary_tree: None,
            opaque_summary: None,
            descents: Vec::new(),
        });
        id
    }

    fn commit(&mut self, layer: LayerView) {
        let id = layer.layer_id;
        self.layers[id] = layer;
    }
}

fn build_v0_layer(
    builder: &mut Builder,
    layer: &MerkOnlyLayerProof,
    descended_via: Option<DisplayKey>,
) -> Result<usize, ParseError> {
    let layer_id = builder.reserve();
    let (ops, binary_tree) = decode_merk_ops(&layer.merk_proof)?;
    let mut descents = Vec::new();
    for (key, child) in &layer.lower_layers {
        let display_key = DisplayKey::from_bytes(key);
        let from_node_id = binary_tree
            .as_ref()
            .and_then(|bt| find_node_with_key(bt, key));
        let to_layer_id = build_v0_layer(builder, child, Some(display_key.clone()))?;
        descents.push(DescentEdge { from_key: display_key, to_layer_id, from_node_id });
    }
    builder.commit(LayerView {
        layer_id,
        backing: BackingType::Merk,
        descended_via,
        ops,
        binary_tree,
        opaque_summary: None,
        descents,
    });
    Ok(layer_id)
}

fn build_v1_layer(
    builder: &mut Builder,
    layer: &GLayerProof,
    descended_via: Option<DisplayKey>,
) -> Result<usize, ParseError> {
    let layer_id = builder.reserve();
    let (backing, ops, binary_tree, opaque_summary) = match &layer.merk_proof {
        ProofBytes::Merk(bytes) => {
            let (ops, tree) = decode_merk_ops(bytes)?;
            (BackingType::Merk, ops, tree, None)
        }
        ProofBytes::MMR(bytes) => (
            BackingType::Mmr,
            vec![],
            None,
            Some(opaque(BackingType::Mmr, bytes)),
        ),
        ProofBytes::BulkAppendTree(bytes) => (
            BackingType::BulkAppendTree,
            vec![],
            None,
            Some(opaque(BackingType::BulkAppendTree, bytes)),
        ),
        ProofBytes::DenseTree(bytes) => (
            BackingType::DenseTree,
            vec![],
            None,
            Some(opaque(BackingType::DenseTree, bytes)),
        ),
        ProofBytes::CommitmentTree(bytes) => (
            BackingType::CommitmentTree,
            vec![],
            None,
            Some(opaque(BackingType::CommitmentTree, bytes)),
        ),
    };
    let mut descents = Vec::new();
    for (key, child) in &layer.lower_layers {
        let display_key = DisplayKey::from_bytes(key);
        let from_node_id = binary_tree
            .as_ref()
            .and_then(|bt| find_node_with_key(bt, key));
        let to_layer_id = build_v1_layer(builder, child, Some(display_key.clone()))?;
        descents.push(DescentEdge { from_key: display_key, to_layer_id, from_node_id });
    }
    builder.commit(LayerView {
        layer_id,
        backing,
        descended_via,
        ops,
        binary_tree,
        opaque_summary,
        descents,
    });
    Ok(layer_id)
}

fn opaque(backing: BackingType, bytes: &[u8]) -> OpaqueSummary {
    let truncated = if bytes.len() <= 64 {
        hex::encode(bytes)
    } else {
        format!("{}…", hex::encode(&bytes[..64]))
    };
    OpaqueSummary { backing, byte_length: bytes.len(), raw_hex_truncated: truncated }
}

/// Decode a merk-proof byte buffer into:
/// 1. the flat op list (preserved for callers who want the raw stream)
/// 2. the reconstructed binary tree (`None` if reconstruction fails — the op
///    list is still surfaced so the renderer can show *something*).
pub(crate) fn decode_merk_ops(
    bytes: &[u8],
) -> Result<(Vec<MerkOp>, Option<MerkBinaryTree>), ParseError> {
    let mut ops = Vec::new();
    let mut decoded: Vec<Op> = Vec::new();
    for op in MerkDecoder::new(bytes) {
        let op = op.map_err(|e| ParseError::MerkDecode(e.to_string()))?;
        ops.push(merk_op_to_view(&op)?);
        decoded.push(op);
    }
    let binary_tree = reconstruct_binary_tree(&decoded).ok();
    Ok((ops, binary_tree))
}

fn merk_op_to_view(op: &Op) -> Result<MerkOp, ParseError> {
    Ok(match op {
        Op::Push(node) => MerkOp::Push { node: merk_node_to_view(node)? },
        Op::PushInverted(node) => MerkOp::PushInverted { node: merk_node_to_view(node)? },
        Op::Parent => MerkOp::Parent,
        Op::Child => MerkOp::Child,
        Op::ParentInverted => MerkOp::ParentInverted,
        Op::ChildInverted => MerkOp::ChildInverted,
    })
}

pub(crate) fn merk_node_to_view(node: &Node) -> Result<MerkNodeView, ParseError> {
    Ok(match node {
        Node::Hash(h) => MerkNodeView::Hash { hash: hex::encode(h) },
        Node::KVHash(h) => MerkNodeView::KvHash { kv_hash: hex::encode(h) },
        Node::KVDigest(k, vh) => MerkNodeView::KvDigest {
            key: DisplayKey::from_bytes(k),
            value_hash: hex::encode(vh),
        },
        Node::KV(k, v) => MerkNodeView::Kv {
            key: DisplayKey::from_bytes(k),
            value: decode_element_view(v),
        },
        Node::KVValueHash(k, v, vh) => MerkNodeView::KvValueHash {
            key: DisplayKey::from_bytes(k),
            value: decode_element_view(v),
            value_hash: hex::encode(vh),
        },
        Node::KVValueHashFeatureType(k, v, vh, ft) => MerkNodeView::KvValueHashFeatureType {
            key: DisplayKey::from_bytes(k),
            value: decode_element_view(v),
            value_hash: hex::encode(vh),
            feature_type: feature_to_view(ft),
        },
        Node::KVRefValueHash(k, v, vh) => MerkNodeView::KvRefValueHash {
            key: DisplayKey::from_bytes(k),
            value: decode_element_view(v),
            value_hash: hex::encode(vh),
        },
        Node::KVCount(k, v, c) => MerkNodeView::KvCount {
            key: DisplayKey::from_bytes(k),
            value: decode_element_view(v),
            count: *c,
        },
        Node::KVHashCount(h, c) => MerkNodeView::KvHashCount { kv_hash: hex::encode(h), count: *c },
        Node::KVRefValueHashCount(k, v, vh, c) => MerkNodeView::KvRefValueHashCount {
            key: DisplayKey::from_bytes(k),
            value: decode_element_view(v),
            value_hash: hex::encode(vh),
            count: *c,
        },
        Node::KVDigestCount(k, vh, c) => MerkNodeView::KvDigestCount {
            key: DisplayKey::from_bytes(k),
            value_hash: hex::encode(vh),
            count: *c,
        },
        Node::KVValueHashFeatureTypeWithChildHash(k, v, vh, ft, ch) => {
            MerkNodeView::KvValueHashFeatureTypeWithChildHash {
                key: DisplayKey::from_bytes(k),
                value: decode_element_view(v),
                value_hash: hex::encode(vh),
                feature_type: feature_to_view(ft),
                child_hash: hex::encode(ch),
            }
        }
        Node::HashWithCount(kv, l, r, c) => MerkNodeView::HashWithCount {
            kv_hash: hex::encode(kv),
            left_child_hash: hex::encode(l),
            right_child_hash: hex::encode(r),
            count: *c,
        },
    })
}

fn feature_to_view(ft: &TreeFeatureType) -> FeatureTypeView {
    match ft {
        TreeFeatureType::BasicMerkNode => FeatureTypeView::BasicMerkNode,
        TreeFeatureType::SummedMerkNode(s) => FeatureTypeView::SummedMerkNode { sum: *s },
        TreeFeatureType::BigSummedMerkNode(s) => {
            FeatureTypeView::BigSummedMerkNode { sum: s.to_string() }
        }
        TreeFeatureType::CountedMerkNode(c) => FeatureTypeView::CountedMerkNode { count: *c },
        TreeFeatureType::CountedSummedMerkNode(c, s) => {
            FeatureTypeView::CountedSummedMerkNode { count: *c, sum: *s }
        }
        TreeFeatureType::ProvableCountedMerkNode(c) => {
            FeatureTypeView::ProvableCountedMerkNode { count: *c }
        }
        TreeFeatureType::ProvableCountedSummedMerkNode(c, s) => {
            FeatureTypeView::ProvableCountedSummedMerkNode { count: *c, sum: *s }
        }
    }
}

/// Reconstruct the binary tree from an op stream.
///
/// Mirrors `grovedb_merk::proofs::tree::execute` semantics — but operates on
/// our IR and skips cost accounting / AVL balance checks (cosmetic only).
fn reconstruct_binary_tree(ops: &[Op]) -> Result<MerkBinaryTree, ParseError> {
    enum Side {
        Left,
        Right,
    }
    let mut nodes: Vec<MerkBinaryNode> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();

    fn pop(stack: &mut Vec<usize>) -> Result<usize, ParseError> {
        stack
            .pop()
            .ok_or_else(|| ParseError::TreeReconstruct("stack underflow".into()))
    }
    fn attach(nodes: &mut [MerkBinaryNode], parent: usize, child: usize, side: Side) {
        match side {
            Side::Left => nodes[parent].left = Some(child),
            Side::Right => nodes[parent].right = Some(child),
        }
        nodes[parent].on_path = true;
    }

    for op in ops {
        match op {
            Op::Push(node) | Op::PushInverted(node) => {
                let view = merk_node_to_view(node)?;
                let id = nodes.len();
                nodes.push(MerkBinaryNode {
                    id,
                    view,
                    left: None,
                    right: None,
                    on_path: false,
                });
                stack.push(id);
            }
            Op::Parent => {
                // pop top as parent, next as child; child becomes left.
                let parent = pop(&mut stack)?;
                let child = pop(&mut stack)?;
                attach(&mut nodes, parent, child, Side::Left);
                stack.push(parent);
            }
            Op::Child => {
                // pop top as child, next as parent; child becomes right.
                let child = pop(&mut stack)?;
                let parent = pop(&mut stack)?;
                attach(&mut nodes, parent, child, Side::Right);
                stack.push(parent);
            }
            Op::ParentInverted => {
                // pop top as parent, next as child; child becomes right.
                let parent = pop(&mut stack)?;
                let child = pop(&mut stack)?;
                attach(&mut nodes, parent, child, Side::Right);
                stack.push(parent);
            }
            Op::ChildInverted => {
                // pop top as child, next as parent; child becomes left.
                let child = pop(&mut stack)?;
                let parent = pop(&mut stack)?;
                attach(&mut nodes, parent, child, Side::Left);
                stack.push(parent);
            }
        }
    }

    if stack.len() != 1 {
        return Err(ParseError::TreeReconstruct(format!(
            "stack ended with {} entries, expected 1",
            stack.len()
        )));
    }
    let root = stack.pop().expect("len==1");
    Ok(MerkBinaryTree { root, nodes })
}

/// Find a node in the binary tree whose `MerkNodeView` exposes the given key.
fn find_node_with_key(tree: &MerkBinaryTree, key: &[u8]) -> Option<usize> {
    let key_hex = hex::encode(key);
    for n in &tree.nodes {
        let matches = match &n.view {
            MerkNodeView::Kv { key: k, .. }
            | MerkNodeView::KvValueHash { key: k, .. }
            | MerkNodeView::KvValueHashFeatureType { key: k, .. }
            | MerkNodeView::KvRefValueHash { key: k, .. }
            | MerkNodeView::KvCount { key: k, .. }
            | MerkNodeView::KvRefValueHashCount { key: k, .. }
            | MerkNodeView::KvDigest { key: k, .. }
            | MerkNodeView::KvDigestCount { key: k, .. }
            | MerkNodeView::KvValueHashFeatureTypeWithChildHash { key: k, .. } => {
                k.hex == key_hex
            }
            _ => false,
        };
        if matches {
            return Some(n.id);
        }
    }
    None
}
