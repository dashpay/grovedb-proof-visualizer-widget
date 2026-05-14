//! Round-trip: build a `GroveDBProofV1` programmatically, bincode-encode it,
//! then run `parse_bytes` and verify the resulting `ProofView`.

use std::collections::BTreeMap;

use bincode::config::standard;
use grovedb::operations::proof::{
    GroveDBProof, GroveDBProofV1, LayerProof as GLayerProof, ProofBytes,
};
use grovedb_proof_view::{parse_bytes, BackingType, ElementView, MerkNodeView, MerkOp};
use grovedb_query::proofs::{encode_into, Node, Op, TreeFeatureType};

/// Encode an op stream using grovedb's canonical encoder.
fn encode_ops(ops: &[Op]) -> Vec<u8> {
    let mut buf = Vec::new();
    encode_into(ops.iter(), &mut buf);
    buf
}

/// Build the bincode bytes for a `GroveDBProof::V1` with the given root layer.
fn encode_proof(root: GLayerProof) -> Vec<u8> {
    let proof = GroveDBProof::V1(GroveDBProofV1 { root_layer: root });
    let cfg = standard().with_big_endian().with_no_limit();
    bincode::encode_to_vec(&proof, cfg).expect("encode proof")
}

#[test]
fn smallest_possible_proof_round_trips() {
    // A 1-node merk proof: just push a KVValueHash whose value is a Tree element
    // that the grovedb v3.1-dev `Element` decoder will accept.
    //
    // Element::Tree(None, None) bincode encoding:
    //   - tag byte for Tree variant
    //   - None for merk_root (1 byte: 0)
    //   - None for flags (1 byte: 0)
    let cfg = standard().with_big_endian().with_no_limit();
    let elem_bytes =
        bincode::encode_to_vec(grovedb::Element::Tree(None, None), cfg).expect("encode element");
    let key = b"k".to_vec();
    let value_hash = [42u8; 32];

    let ops = vec![Op::Push(Node::KVValueHash(
        key.clone(),
        elem_bytes.clone(),
        value_hash,
    ))];
    let merk_proof_bytes = encode_ops(&ops);

    let layer = GLayerProof {
        merk_proof: ProofBytes::Merk(merk_proof_bytes),
        lower_layers: BTreeMap::new(),
    };
    let proof_bytes = encode_proof(layer);

    let view = parse_bytes(&proof_bytes).expect("parse_bytes");
    assert_eq!(view.version, 1);
    assert_eq!(view.root_layer_id, 0);
    assert_eq!(view.layers.len(), 1);

    let root = &view.layers[0];
    assert_eq!(root.backing, BackingType::Merk);
    assert!(root.descended_via.is_none());
    assert_eq!(root.descents.len(), 0);
    assert_eq!(root.ops.len(), 1);
    let bt = root.binary_tree.as_ref().expect("binary tree");
    assert_eq!(bt.nodes.len(), 1);
    let node0 = &bt.nodes[0];
    match &node0.view {
        MerkNodeView::KvValueHash {
            key: k,
            value,
            value_hash: vh,
        } => {
            assert_eq!(k.display, "k");
            assert!(matches!(value, ElementView::Tree { .. }));
            assert_eq!(vh, &hex::encode(value_hash));
        }
        other => panic!("unexpected node view: {other:?}"),
    }
}

#[test]
fn binary_tree_attaches_left_via_parent_op() {
    // child Push, parent Push, Parent op -> parent has child as left child
    let elem_bytes = {
        let cfg = standard().with_big_endian().with_no_limit();
        bincode::encode_to_vec(grovedb::Element::Tree(None, None), cfg).unwrap()
    };
    let ops = vec![
        Op::Push(Node::KVValueHash(
            b"a".to_vec(),
            elem_bytes.clone(),
            [1u8; 32],
        )),
        Op::Push(Node::KVValueHash(
            b"b".to_vec(),
            elem_bytes.clone(),
            [2u8; 32],
        )),
        Op::Parent,
    ];
    let merk_proof_bytes = encode_ops(&ops);
    let layer = GLayerProof {
        merk_proof: ProofBytes::Merk(merk_proof_bytes),
        lower_layers: BTreeMap::new(),
    };
    let proof_bytes = encode_proof(layer);

    let view = parse_bytes(&proof_bytes).expect("parse_bytes");
    let bt = view.layers[0].binary_tree.as_ref().expect("tree");
    assert_eq!(bt.nodes.len(), 2);
    // After Parent: top of stack is `b` with left = `a`.
    let root = &bt.nodes[bt.root];
    match &root.view {
        MerkNodeView::KvValueHash { key, .. } => assert_eq!(key.display, "b"),
        _ => panic!(),
    }
    assert_eq!(root.left, Some(0));
    assert_eq!(root.right, None);
    assert!(root.on_path);
}

#[test]
fn lower_layers_recorded_with_descent_edges() {
    let elem_bytes = {
        let cfg = standard().with_big_endian().with_no_limit();
        bincode::encode_to_vec(grovedb::Element::Tree(None, None), cfg).unwrap()
    };

    // Root layer has key "a" -> Tree, with a lower_layer keyed "a"
    let root_ops = vec![Op::Push(Node::KVValueHash(
        b"a".to_vec(),
        elem_bytes.clone(),
        [1u8; 32],
    ))];
    let child_ops = vec![Op::Push(Node::KVValueHash(
        b"x".to_vec(),
        elem_bytes.clone(),
        [9u8; 32],
    ))];
    let mut lower = BTreeMap::new();
    lower.insert(
        b"a".to_vec(),
        GLayerProof {
            merk_proof: ProofBytes::Merk(encode_ops(&child_ops)),
            lower_layers: BTreeMap::new(),
        },
    );
    let root = GLayerProof {
        merk_proof: ProofBytes::Merk(encode_ops(&root_ops)),
        lower_layers: lower,
    };
    let proof_bytes = encode_proof(root);

    let view = parse_bytes(&proof_bytes).expect("parse_bytes");
    assert_eq!(view.layers.len(), 2);
    let root = &view.layers[0];
    assert_eq!(root.descents.len(), 1);
    let descent = &root.descents[0];
    assert_eq!(descent.from_key.display, "a");
    assert_eq!(descent.to_layer_id, 1);
    assert_eq!(descent.from_node_id, Some(0));

    let child = &view.layers[1];
    assert_eq!(child.layer_id, 1);
    assert_eq!(child.descended_via.as_ref().unwrap().display, "a");
    assert_eq!(child.descents.len(), 0);
}

#[test]
fn count_tree_value_decodes_count_field() {
    // Build an Element::CountTree and check the IR exposes count.
    let elem = grovedb::Element::CountTree(None, 100_000, None);
    let cfg = standard().with_big_endian().with_no_limit();
    let elem_bytes = bincode::encode_to_vec(&elem, cfg).unwrap();
    let ops = vec![Op::Push(Node::KVValueHashFeatureTypeWithChildHash(
        b"\x00".to_vec(),
        elem_bytes,
        [7u8; 32],
        TreeFeatureType::BasicMerkNode,
        [8u8; 32],
    ))];
    let layer = GLayerProof {
        merk_proof: ProofBytes::Merk(encode_ops(&ops)),
        lower_layers: BTreeMap::new(),
    };
    let proof_bytes = encode_proof(layer);
    let view = parse_bytes(&proof_bytes).unwrap();
    let bt = view.layers[0].binary_tree.as_ref().unwrap();
    match &bt.nodes[0].view {
        MerkNodeView::KvValueHashFeatureTypeWithChildHash { value, .. } => match value {
            ElementView::CountTree { count, .. } => assert_eq!(*count, 100_000),
            other => panic!("expected CountTree, got {other:?}"),
        },
        other => panic!("unexpected node view {other:?}"),
    }
}

#[test]
fn schema_round_trips_through_serde() {
    // Make sure the schema generation runs and produces non-empty JSON.
    use grovedb_proof_view::schema::proof_view_schema;
    let schema = proof_view_schema();
    assert!(schema.is_object());
    let txt = serde_json::to_string(&schema).unwrap();
    assert!(txt.contains("ProofView"));
}

#[test]
fn merk_op_view_preserves_op_kinds() {
    // A 4-op proof exercising Push, Parent, Push, Child.
    let elem_bytes = {
        let cfg = standard().with_big_endian().with_no_limit();
        bincode::encode_to_vec(grovedb::Element::Tree(None, None), cfg).unwrap()
    };
    let ops = vec![
        Op::Push(Node::Hash([1u8; 32])),
        Op::Push(Node::KVValueHash(
            b"m".to_vec(),
            elem_bytes.clone(),
            [2u8; 32],
        )),
        Op::Parent,
        Op::Push(Node::Hash([3u8; 32])),
        Op::Child,
    ];
    let layer = GLayerProof {
        merk_proof: ProofBytes::Merk(encode_ops(&ops)),
        lower_layers: BTreeMap::new(),
    };
    let proof_bytes = encode_proof(layer);
    let view = parse_bytes(&proof_bytes).unwrap();
    let ops_view = &view.layers[0].ops;
    assert_eq!(ops_view.len(), 5);
    assert!(matches!(ops_view[0], MerkOp::Push { .. }));
    assert!(matches!(ops_view[2], MerkOp::Parent));
    assert!(matches!(ops_view[4], MerkOp::Child));
    let bt = view.layers[0].binary_tree.as_ref().unwrap();
    let root = &bt.nodes[bt.root];
    assert_eq!(bt.root, 1);
    assert_eq!(root.left, Some(0));
    assert_eq!(root.right, Some(2));
}
