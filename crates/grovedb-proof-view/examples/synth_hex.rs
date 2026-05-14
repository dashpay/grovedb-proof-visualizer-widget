//! Same synthetic 5-layer proof as `synth_fixture`, but emits the
//! bincode-encoded hex string instead of `ProofView` JSON. Used to seed the
//! TS demo's bytes-input round-trip.
//!
//! Usage:
//!   cargo run -p grovedb-proof-view --example synth_hex > examples/fixtures/query1_count.hex

use std::collections::BTreeMap;

use bincode::config::standard;
use grovedb::operations::proof::{
    GroveDBProof, GroveDBProofV1, LayerProof, ProofBytes,
};
use grovedb_query::proofs::{encode_into, Node, Op, TreeFeatureType};

fn enc_elem(elem: &grovedb::Element) -> Vec<u8> {
    let cfg = standard().with_big_endian().with_no_limit();
    bincode::encode_to_vec(elem, cfg).unwrap()
}

fn enc_ops(ops: &[Op]) -> Vec<u8> {
    let mut buf = Vec::new();
    encode_into(ops.iter(), &mut buf);
    buf
}

fn h(seed: u8) -> [u8; 32] {
    let mut a = [0u8; 32];
    for (i, b) in a.iter_mut().enumerate() {
        *b = seed.wrapping_add(i as u8);
    }
    a
}

fn main() {
    let count_tree = grovedb::Element::CountTree(None, 100_000, None);
    let l5_ops = vec![
        Op::Push(Node::KVValueHashFeatureTypeWithChildHash(
            b"\x00".to_vec(),
            enc_elem(&count_tree),
            h(0x85),
            TreeFeatureType::BasicMerkNode,
            h(0x0e),
        )),
        Op::Push(Node::KVHash(h(0xa2))),
        Op::Parent,
        Op::Push(Node::Hash(h(0x6c))),
        Op::Child,
    ];
    let widget_tree = grovedb::Element::Tree(Some(b"widget".to_vec()), None);
    let l4_ops = vec![Op::Push(Node::KVValueHash(
        b"widget".to_vec(),
        enc_elem(&widget_tree),
        h(0x6c),
    ))];
    let documents_tree = grovedb::Element::Tree(Some(b"\x01".to_vec()), None);
    let l3_ops = vec![
        Op::Push(Node::Hash(h(0x49))),
        Op::Push(Node::KVValueHash(
            b"\x01".to_vec(),
            enc_elem(&documents_tree),
            h(0x5d),
        )),
        Op::Parent,
    ];
    let contract_id = vec![0x4e, 0xd2, 0x26, 0x24];
    let contract_tree = grovedb::Element::Tree(Some(contract_id.clone()), None);
    let l2_ops = vec![Op::Push(Node::KVValueHash(
        contract_id.clone(),
        enc_elem(&contract_tree),
        h(0x5b),
    ))];
    let at_tree = grovedb::Element::Tree(Some(b"@".to_vec()), None);
    let l1_ops = vec![
        Op::Push(Node::Hash(h(0xbd))),
        Op::Push(Node::KVValueHash(b"@".to_vec(), enc_elem(&at_tree), h(0x4a))),
        Op::Parent,
        Op::Push(Node::Hash(h(0x19))),
        Op::Child,
    ];

    let mut layer4_lower = BTreeMap::new();
    layer4_lower.insert(
        b"widget".to_vec(),
        LayerProof {
            merk_proof: ProofBytes::Merk(enc_ops(&l5_ops)),
            lower_layers: BTreeMap::new(),
        },
    );
    let mut layer3_lower = BTreeMap::new();
    layer3_lower.insert(
        b"\x01".to_vec(),
        LayerProof {
            merk_proof: ProofBytes::Merk(enc_ops(&l4_ops)),
            lower_layers: layer4_lower,
        },
    );
    let mut layer2_lower = BTreeMap::new();
    layer2_lower.insert(
        contract_id.clone(),
        LayerProof {
            merk_proof: ProofBytes::Merk(enc_ops(&l3_ops)),
            lower_layers: layer3_lower,
        },
    );
    let mut layer1_lower = BTreeMap::new();
    layer1_lower.insert(
        b"@".to_vec(),
        LayerProof {
            merk_proof: ProofBytes::Merk(enc_ops(&l2_ops)),
            lower_layers: layer2_lower,
        },
    );

    let root_layer = LayerProof {
        merk_proof: ProofBytes::Merk(enc_ops(&l1_ops)),
        lower_layers: layer1_lower,
    };

    let proof = GroveDBProof::V1(GroveDBProofV1 { root_layer });
    let cfg = standard().with_big_endian().with_no_limit();
    let proof_bytes = bincode::encode_to_vec(&proof, cfg).unwrap();
    println!("{}", hex::encode(&proof_bytes));
}
