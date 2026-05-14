//! Round-trip: build a `GroveDBProofV1` programmatically, format it via
//! grovedb's `Display` impl, then parse with `parse_text` and assert the IR
//! matches what `parse_bytes` would give for the same proof.

use std::collections::BTreeMap;

use bincode::config::standard;
use grovedb::operations::proof::{
    GroveDBProof, GroveDBProofV0, GroveDBProofV1, LayerProof as GLayerProof, MerkOnlyLayerProof,
    ProofBytes,
};
use grovedb_proof_view::{parse_bytes, parse_text, BackingType, ElementView, MerkNodeView};
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

fn encode_v1(root: GLayerProof) -> Vec<u8> {
    let proof = GroveDBProof::V1(GroveDBProofV1 { root_layer: root });
    let cfg = standard().with_big_endian().with_no_limit();
    bincode::encode_to_vec(&proof, cfg).unwrap()
}

#[test]
fn parse_text_handles_one_node_proof() {
    let elem = grovedb::Element::Tree(None, None);
    let layer = GLayerProof {
        merk_proof: ProofBytes::Merk(enc_ops(&[Op::Push(Node::KVValueHash(
            b"k".to_vec(),
            enc_elem(&elem),
            h(0x42),
        ))])),
        lower_layers: BTreeMap::new(),
    };
    let bytes = encode_v1(layer);
    let v_bytes = parse_bytes(&bytes).unwrap();
    let proof: GroveDBProof =
        bincode::decode_from_slice(&bytes, standard().with_big_endian().with_no_limit())
            .unwrap()
            .0;
    let text = format!("{}", proof);
    let v_text = parse_text(&text).unwrap();

    assert_eq!(v_bytes.version, v_text.version);
    assert_eq!(v_bytes.layers.len(), v_text.layers.len());
    assert_eq!(v_bytes.layers[0].backing, BackingType::Merk);
    assert_eq!(v_text.layers[0].backing, BackingType::Merk);
    assert_eq!(v_bytes.layers[0].ops.len(), v_text.layers[0].ops.len());
    let bt_text = v_text.layers[0].binary_tree.as_ref().unwrap();
    assert_eq!(bt_text.nodes.len(), 1);
    let bt_bytes = v_bytes.layers[0].binary_tree.as_ref().unwrap();
    assert_eq!(bt_bytes.nodes.len(), 1);
}

#[test]
fn parse_text_handles_count_tree_with_feature_type() {
    let elem = grovedb::Element::CountTree(None, 100_000, None);
    let ops = vec![Op::Push(Node::KVValueHashFeatureTypeWithChildHash(
        b"\x00".to_vec(),
        enc_elem(&elem),
        h(0x85),
        TreeFeatureType::BasicMerkNode,
        h(0x0e),
    ))];
    let layer = GLayerProof {
        merk_proof: ProofBytes::Merk(enc_ops(&ops)),
        lower_layers: BTreeMap::new(),
    };
    let bytes = encode_v1(layer);
    let proof: GroveDBProof =
        bincode::decode_from_slice(&bytes, standard().with_big_endian().with_no_limit())
            .unwrap()
            .0;
    let text = format!("{}", proof);
    let v = parse_text(&text).unwrap();
    let bt = v.layers[0].binary_tree.as_ref().unwrap();
    match &bt.nodes[0].view {
        MerkNodeView::KvValueHashFeatureTypeWithChildHash {
            value,
            value_hash,
            child_hash,
            ..
        } => {
            assert_eq!(value_hash, &hex::encode(h(0x85)));
            assert_eq!(child_hash, &hex::encode(h(0x0e)));
            match value {
                ElementView::CountTree { count, .. } => assert_eq!(*count, 100_000),
                other => panic!("expected CountTree, got {other:?}"),
            }
        }
        other => panic!("unexpected node view: {other:?}"),
    }
}

#[test]
fn parse_text_handles_descents_and_lower_layers() {
    let elem = grovedb::Element::Tree(Some(b"@".to_vec()), None);
    let l1_ops = vec![
        Op::Push(Node::Hash(h(0xbd))),
        Op::Push(Node::KVValueHash(b"@".to_vec(), enc_elem(&elem), h(0x4a))),
        Op::Parent,
        Op::Push(Node::Hash(h(0x19))),
        Op::Child,
    ];
    let l2_ops = vec![Op::Push(Node::KVValueHash(
        b"deep".to_vec(),
        enc_elem(&grovedb::Element::Tree(None, None)),
        h(0x99),
    ))];
    let mut lower = BTreeMap::new();
    lower.insert(
        b"@".to_vec(),
        GLayerProof {
            merk_proof: ProofBytes::Merk(enc_ops(&l2_ops)),
            lower_layers: BTreeMap::new(),
        },
    );
    let root = GLayerProof {
        merk_proof: ProofBytes::Merk(enc_ops(&l1_ops)),
        lower_layers: lower,
    };
    let bytes = encode_v1(root);
    let v_bytes = parse_bytes(&bytes).unwrap();
    let proof: GroveDBProof =
        bincode::decode_from_slice(&bytes, standard().with_big_endian().with_no_limit())
            .unwrap()
            .0;
    let text = format!("{}", proof);
    let v_text = parse_text(&text).unwrap();
    assert_eq!(v_bytes.layers.len(), v_text.layers.len());
    assert_eq!(v_text.layers[0].descents.len(), 1);
    assert_eq!(v_text.layers[0].descents[0].from_key.display, "@");
    assert_eq!(v_text.layers[0].descents[0].to_layer_id, 1);
    assert_eq!(
        v_text.layers[1].descended_via.as_ref().unwrap().display,
        "@"
    );
}

#[test]
fn parse_text_handles_v0_proofs() {
    let elem = grovedb::Element::Tree(None, None);
    let ops = vec![Op::Push(Node::KVValueHash(
        b"k".to_vec(),
        enc_elem(&elem),
        h(0x42),
    ))];
    let layer = MerkOnlyLayerProof {
        merk_proof: enc_ops(&ops),
        lower_layers: BTreeMap::new(),
    };
    let proof = GroveDBProof::V0(GroveDBProofV0 {
        root_layer: layer,
        prove_options: grovedb::operations::proof::ProveOptions {
            decrease_limit_on_empty_sub_query_result: true,
        },
    });
    let cfg = standard().with_big_endian().with_no_limit();
    let bytes = bincode::encode_to_vec(&proof, cfg).unwrap();
    let v_bytes = parse_bytes(&bytes).unwrap();
    let text = format!("{}", proof);
    let v_text = parse_text(&text).unwrap();
    assert_eq!(v_text.version, 0);
    assert_eq!(v_bytes.version, 0);
    assert_eq!(v_text.layers.len(), v_bytes.layers.len());
}

#[test]
fn parse_text_handles_kvhash_and_hash_nodes() {
    let elem = grovedb::Element::Tree(None, None);
    let ops = vec![
        Op::Push(Node::Hash(h(0xab))),
        Op::Push(Node::KVValueHash(b"x".to_vec(), enc_elem(&elem), h(0xcd))),
        Op::Parent,
        Op::Push(Node::KVHash(h(0xef))),
        Op::Child,
    ];
    let layer = GLayerProof {
        merk_proof: ProofBytes::Merk(enc_ops(&ops)),
        lower_layers: BTreeMap::new(),
    };
    let bytes = encode_v1(layer);
    let proof: GroveDBProof =
        bincode::decode_from_slice(&bytes, standard().with_big_endian().with_no_limit())
            .unwrap()
            .0;
    let text = format!("{}", proof);
    let v = parse_text(&text).unwrap();
    let bt = v.layers[0].binary_tree.as_ref().unwrap();
    assert_eq!(bt.nodes.len(), 3);
}

#[test]
fn parse_text_handles_provable_count_tree_features() {
    let elem = grovedb::Element::ProvableCountTree(None, 42, None);
    let ops = vec![Op::Push(Node::KVValueHashFeatureType(
        b"k".to_vec(),
        enc_elem(&elem),
        h(0xaa),
        TreeFeatureType::ProvableCountedMerkNode(42),
    ))];
    let layer = GLayerProof {
        merk_proof: ProofBytes::Merk(enc_ops(&ops)),
        lower_layers: BTreeMap::new(),
    };
    let bytes = encode_v1(layer);
    let proof: GroveDBProof =
        bincode::decode_from_slice(&bytes, standard().with_big_endian().with_no_limit())
            .unwrap()
            .0;
    let text = format!("{}", proof);
    let v = parse_text(&text).unwrap();
    let bt = v.layers[0].binary_tree.as_ref().unwrap();
    match &bt.nodes[0].view {
        MerkNodeView::KvValueHashFeatureType {
            value,
            feature_type,
            ..
        } => {
            match value {
                ElementView::ProvableCountTree { count, .. } => assert_eq!(*count, 42),
                other => panic!("unexpected value {other:?}"),
            }
            match feature_type {
                grovedb_proof_view::FeatureTypeView::ProvableCountedMerkNode { count } => {
                    assert_eq!(*count, 42);
                }
                other => panic!("unexpected feature {other:?}"),
            }
        }
        other => panic!("unexpected node view {other:?}"),
    }
}

#[test]
fn parse_text_handles_kvcount_and_kvhashcount() {
    let elem = grovedb::Element::Item(b"hello".to_vec(), None);
    let ops = vec![
        Op::Push(Node::KVCount(b"k".to_vec(), enc_elem(&elem), 7)),
        Op::Push(Node::KVHashCount(h(0x11), 3)),
        Op::Parent,
    ];
    let layer = GLayerProof {
        merk_proof: ProofBytes::Merk(enc_ops(&ops)),
        lower_layers: BTreeMap::new(),
    };
    let bytes = encode_v1(layer);
    let proof: GroveDBProof =
        bincode::decode_from_slice(&bytes, standard().with_big_endian().with_no_limit())
            .unwrap()
            .0;
    let text = format!("{}", proof);
    let v = parse_text(&text).unwrap();
    let bt = v.layers[0].binary_tree.as_ref().unwrap();
    assert_eq!(bt.nodes.len(), 2);
}

#[test]
fn parse_text_handles_book_query1_verbatim() {
    // Verbatim from packages/.../book/src/drive/count-index-examples.md Query 1.
    // This is the canonical end-to-end fixture: real ASCII keys, hex keys with
    // 0x prefix, multi-layer descent, KVValueHashFeatureTypeWithChildHash with
    // a CountTree(..., 100000) value.
    let text = r#"GroveDBProofV1 {
  LayerProof {
    proof: Merk(
      0: Push(Hash(HASH[bd291f29893fb6f6d6201087746ca1f23a178dd08e1346cb6c127e91ae3623b3]))
      1: Push(KVValueHash(@, Tree(4ed22624752972af97fb71abf4067b23e6d296a61a02f35b2098819fde39d289), HASH[4a5a28cb1b40226aa35b2f0d502767df13268bdf4678627dbfde26a557acdf73]))
      2: Parent
      3: Push(Hash(HASH[19c924989e473a90d0848277d0b1498ccc8db3dc870cbc130e773f3d79ea5b71]))
      4: Child)
    lower_layers: {
      @ => {
        LayerProof {
          proof: Merk(
            0: Push(KVValueHash(0x4ed22624752972af97fb71abf4067b23e6d296a61a02f35b2098819fde39d289, Tree(01), HASH[5b90e1e952b7eef903cc9db2d9098e334a37f7e08cade52c6b2ea3bf4b56b645])))
          lower_layers: {
            0x4ed22624752972af97fb71abf4067b23e6d296a61a02f35b2098819fde39d289 => {
              LayerProof {
                proof: Merk(
                  0: Push(Hash(HASH[49e7191075272395ed72cf03e973987ede6e4945e08574fe77d725f4ce7ecdf8]))
                  1: Push(KVValueHash(0x01, Tree(776964676574), HASH[5d9a0fad8a3f32560f8e8950c1e84a7feabaab21b79bc72fec4482442844e2ef]))
                  2: Parent)
                lower_layers: {
                  0x01 => {
                    LayerProof {
                      proof: Merk(
                        0: Push(KVValueHash(widget, Tree(6272616e64), HASH[6c505f53f2ebf3de030cc2aca463d4b429aeb320a9fadb8ae68bb7903a22bb68])))
                      lower_layers: {
                        widget => {
                          LayerProof {
                            proof: Merk(
                              0: Push(KVValueHashFeatureTypeWithChildHash(0x00, CountTree(0000000000010000fffffffffffeffff00000000000000000000000000000000, 100000), HASH[85843d8e6353dd6caf52f659c454b4a1352f510daa965df594b27319abf1d8a1], BasicMerkNode, HASH[0e6a5047f0600cafc385ed52b516c1fbbaf4994aa50dfcbd1e824b4ad9f55fa1]))
                              1: Push(KVHash(HASH[a29ee8f206a253362b6da4fcacf8643ee8e5925cd979fcd449e5906f0f9f8be3]))
                              2: Parent
                              3: Push(Hash(HASH[6c36729e93b1a316cbf60fe282eb630c0ed6e45db088e365110302b6c9caba86]))
                              4: Child)
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}"#;
    let v = parse_text(text).expect("parse book query 1 verbatim");
    assert_eq!(v.version, 1);
    assert_eq!(v.layers.len(), 5);

    // Layer 0 (root): two siblings around the descended-into `@` key, in a
    // 3-node merk tree (Hash, KVValueHash, Hash).
    let l0 = &v.layers[0];
    assert_eq!(l0.descents.len(), 1);
    assert_eq!(l0.descents[0].from_key.display, "@");
    assert_eq!(l0.descents[0].to_layer_id, 1);
    let l0_bt = l0.binary_tree.as_ref().unwrap();
    assert_eq!(l0_bt.nodes.len(), 3);

    // Layer 4 (deepest): the CountTree leaf.
    let l4 = &v.layers[4];
    assert_eq!(l4.descended_via.as_ref().unwrap().display, "widget");
    assert_eq!(l4.descents.len(), 0);
    let l4_bt = l4.binary_tree.as_ref().unwrap();
    let target = l4_bt
        .nodes
        .iter()
        .find_map(|n| match &n.view {
            MerkNodeView::KvValueHashFeatureTypeWithChildHash { value, .. } => Some(value),
            _ => None,
        })
        .expect("should have target node");
    match target {
        ElementView::CountTree { count, .. } => assert_eq!(*count, 100_000),
        other => panic!("expected CountTree, got {other:?}"),
    }
}

#[test]
fn parse_text_handles_hash_with_count_named_fields() {
    // Regression: Node::HashWithCount uses named-field Display syntax
    // (kv_hash=HASH[…], left=HASH[…], right=HASH[…], count=N) — a different
    // shape from every other Node variant. Earlier parser only handled the
    // positional form and bailed out on real AggregateCountOnRange proofs.
    //
    // Verbatim slice of the bench's `byColor` `color == 'color_00000500'`
    // proof (Layer 6 of count-index-examples.md Query 3).
    let text = r#"GroveDBProofV1 {
  LayerProof {
    proof: Merk(
      0: Push(HashWithCount(kv_hash=HASH[4f8d29f51f626326fa5a3d4aa210a07eddf53121888aa5788625ae774be9bc37], left=HASH[ec92140543f4bd56112e8eaf4cb9796b1986d56b0bf721d81fc7d6a699d16a50], right=HASH[1eb29f80ffaac4878420ecfc9337e6181c9e6fc30608fc5475cf0b808f51a31d], count=255))
      1: Push(KVDigestCount(color_00000255, HASH[2ed4d50b30e917eceacb3356eb88057e490f9d98ebf6123d25535ff502d2da2b], 511))
      2: Parent
      3: Push(HashWithCount(kv_hash=HASH[3b75b6239307e1a00f8596386421e623e365d4adc8451dae07cc3bcf589efc44], left=HASH[0000000000000000000000000000000000000000000000000000000000000000], right=HASH[0000000000000000000000000000000000000000000000000000000000000000], count=1))
      4: Child)
  }
}"#;
    let v = parse_text(text).expect("parse HashWithCount with named fields");
    assert_eq!(v.layers.len(), 1);
    let bt = v.layers[0].binary_tree.as_ref().unwrap();
    assert_eq!(bt.nodes.len(), 3);
    let mut hwc_count = 0;
    let mut total_count_on_hwc = 0u64;
    for node in &bt.nodes {
        if let MerkNodeView::HashWithCount { count, .. } = &node.view {
            hwc_count += 1;
            total_count_on_hwc += count;
        }
    }
    assert_eq!(hwc_count, 2);
    // 255 + 1 = 256: confirms both counts decoded out of the named-field syntax.
    assert_eq!(total_count_on_hwc, 256);
}

#[test]
fn parse_text_handles_book_query3_verbatim() {
    // The exact `color == 'color_00000500'` proof a user reported as failing
    // — 7 layers, includes Hash / KVHash / KVValueHash / HashWithCount /
    // KVDigestCount, NonCounted-wrapped ProvableCountTree, all in one go.
    let text = include_str!("fixtures/query3_color_eq.txt");
    let v = parse_text(text).expect("parse book Query 3");
    assert_eq!(v.version, 1);
    // Descent: root → @ → contract_id → 0x01 → widget → brand → brand_050 → color = 8 layers
    assert_eq!(v.layers.len(), 8);
    // Deepest layer: contains the boundary KVDigestCount entries that
    // straddle color_00000500.
    let deepest = v.layers.last().unwrap();
    let bt = deepest.binary_tree.as_ref().unwrap();
    let target_count = bt
        .nodes
        .iter()
        .filter_map(|n| match &n.view {
            MerkNodeView::KvDigestCount { key, count, .. } if key.display == "color_00000500" => {
                Some(*count)
            }
            _ => None,
        })
        .next()
        .expect("color_00000500 boundary present");
    // The boundary itself proves a CountTree with count=1 (verifies the
    // single-doc result for the byColor terminator).
    assert_eq!(target_count, 1);
}

#[test]
fn parse_text_handles_hex_keys() {
    let elem = grovedb::Element::Tree(None, None);
    let key = vec![0xff, 0x00, 0xab];
    let ops = vec![Op::Push(Node::KVValueHash(
        key.clone(),
        enc_elem(&elem),
        h(0x99),
    ))];
    let layer = GLayerProof {
        merk_proof: ProofBytes::Merk(enc_ops(&ops)),
        lower_layers: BTreeMap::new(),
    };
    let bytes = encode_v1(layer);
    let proof: GroveDBProof =
        bincode::decode_from_slice(&bytes, standard().with_big_endian().with_no_limit())
            .unwrap()
            .0;
    let text = format!("{}", proof);
    let v = parse_text(&text).unwrap();
    let bt = v.layers[0].binary_tree.as_ref().unwrap();
    match &bt.nodes[0].view {
        MerkNodeView::KvValueHash { key: k, .. } => {
            assert_eq!(k.hex, "ff00ab");
            assert!(!k.is_ascii);
        }
        _ => panic!(),
    }
}
