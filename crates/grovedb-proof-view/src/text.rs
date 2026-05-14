//! Parse the human-readable `GroveDBProof::Display` string into a [`ProofView`].
//!
//! Hand-rolled recursive-descent because the grammar mixes:
//!   - structural braces / parens with bracket-balanced element values
//!   - keys that may be ASCII identifiers OR `0x…` hex
//!   - element variants whose argument lists are themselves comma-and-bracket
//!     soup (e.g. `CountTree(636f6c6f72, 1000, flags: [0, 0, 0])`)
//!
//! Output mirrors [`crate::bytes::parse_bytes`] exactly so the renderer is
//! input-agnostic. Tested by round-tripping: build a proof programmatically →
//! `format!("{}", proof)` → `parse_text` → compare to `parse_bytes` IR.

use std::collections::BTreeMap;

use crate::error::ParseError;
use crate::ir::*;

/// Parse a `GroveDBProof::Display` text dump into a `ProofView`.
pub fn parse_text(input: &str) -> Result<ProofView, ParseError> {
    let mut parser = Parser::new(input);
    parser.skip_whitespace();
    let version = if parser.consume_keyword("GroveDBProofV1") {
        1u8
    } else if parser.consume_keyword("GroveDBProofV0") {
        0u8
    } else {
        return Err(parser.err("expected `GroveDBProofV0` or `GroveDBProofV1`"));
    };
    parser.skip_whitespace();
    parser.expect_char('{')?;
    let mut builder = LayerBuilder::default();
    let root_layer_id = builder.parse_layer(&mut parser, None)?;
    parser.skip_whitespace();
    parser.expect_char('}')?;
    Ok(ProofView {
        version,
        root_layer_id,
        layers: builder.layers,
    })
}

#[derive(Default)]
struct LayerBuilder {
    layers: Vec<LayerView>,
}

impl LayerBuilder {
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

    fn parse_layer(
        &mut self,
        parser: &mut Parser,
        descended_via: Option<DisplayKey>,
    ) -> Result<usize, ParseError> {
        let layer_id = self.reserve();
        parser.skip_whitespace();
        parser.expect_keyword("LayerProof")?;
        parser.skip_whitespace();
        parser.expect_char('{')?;
        parser.skip_whitespace();

        // V1 uses `proof:` and ProofBytes; V0 uses `merk_proof:` and a raw
        // op stream. We accept either label here so a single parser handles
        // mixed proofs (BTreeMap iteration order means children inherit
        // their parent's version).
        let backing;
        let ops;
        let binary_tree;
        let opaque_summary;
        if parser.consume_keyword("proof") {
            parser.skip_whitespace();
            parser.expect_char(':')?;
            parser.skip_whitespace();
            // ProofBytes wrapper
            if parser.consume_keyword("Merk") {
                parser.skip_whitespace();
                parser.expect_char('(')?;
                let parsed_ops = parse_ops_until_paren(parser)?;
                let (op_views, tree) = build_ops_and_tree(&parsed_ops)?;
                ops = op_views;
                binary_tree = tree;
                backing = BackingType::Merk;
                opaque_summary = None;
            } else if parser.consume_keyword("MMR") {
                let summary = parse_opaque_call(parser, BackingType::Mmr)?;
                ops = Vec::new();
                binary_tree = None;
                backing = BackingType::Mmr;
                opaque_summary = Some(summary);
            } else if parser.consume_keyword("BulkAppendTree") {
                let summary = parse_opaque_call(parser, BackingType::BulkAppendTree)?;
                ops = Vec::new();
                binary_tree = None;
                backing = BackingType::BulkAppendTree;
                opaque_summary = Some(summary);
            } else if parser.consume_keyword("DenseTree") {
                let summary = parse_opaque_call(parser, BackingType::DenseTree)?;
                ops = Vec::new();
                binary_tree = None;
                backing = BackingType::DenseTree;
                opaque_summary = Some(summary);
            } else if parser.consume_keyword("CommitmentTree") {
                let summary = parse_opaque_call(parser, BackingType::CommitmentTree)?;
                ops = Vec::new();
                binary_tree = None;
                backing = BackingType::CommitmentTree;
                opaque_summary = Some(summary);
            } else {
                return Err(
                    parser.err("expected one of Merk/MMR/BulkAppendTree/DenseTree/CommitmentTree")
                );
            }
        } else if parser.consume_keyword("merk_proof") {
            parser.skip_whitespace();
            parser.expect_char(':')?;
            parser.skip_whitespace();
            // V0 has no enclosing wrapper; the ops stream starts directly.
            let parsed_ops = parse_ops_inline(parser)?;
            let (op_views, tree) = build_ops_and_tree(&parsed_ops)?;
            ops = op_views;
            binary_tree = tree;
            backing = BackingType::Merk;
            opaque_summary = None;
        } else {
            return Err(parser.err("expected `proof:` or `merk_proof:`"));
        }

        // Optional `lower_layers: { … }` block
        let mut descents = Vec::new();
        parser.skip_whitespace();
        if parser.consume_keyword("lower_layers") {
            parser.skip_whitespace();
            parser.expect_char(':')?;
            parser.skip_whitespace();
            parser.expect_char('{')?;
            // Children appear in BTreeMap iteration order — i.e. lex-sorted by
            // raw key bytes. We preserve the source order rather than
            // re-sorting so a round-trip is byte-stable.
            let mut child_pairs: BTreeMap<Vec<u8>, usize> = BTreeMap::new();
            loop {
                parser.skip_whitespace();
                if parser.peek() == Some('}') {
                    parser.expect_char('}')?;
                    break;
                }
                let key_bytes = parse_key_bytes(parser)?;
                parser.skip_whitespace();
                parser.expect_keyword("=>")?;
                parser.skip_whitespace();
                parser.expect_char('{')?;
                let display_key = DisplayKey::from_bytes(&key_bytes);
                let child_id = self.parse_layer(parser, Some(display_key.clone()))?;
                parser.skip_whitespace();
                parser.expect_char('}')?;
                child_pairs.insert(key_bytes.clone(), child_id);
                descents.push(DescentEdge {
                    from_key: display_key,
                    to_layer_id: child_id,
                    from_node_id: None, // wired up post-hoc below
                });
            }
        }

        parser.skip_whitespace();
        parser.expect_char('}')?;

        // Wire from_node_id by scanning the binary tree for keys matching
        // each descent — same logic the bytes parser uses.
        if let Some(bt) = &binary_tree {
            for d in descents.iter_mut() {
                d.from_node_id = find_node_with_key(bt, &d.from_key.hex);
            }
        }

        self.commit(LayerView {
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
}

/// Build IR ops + reconstruct the binary tree from a list of parsed ops.
fn build_ops_and_tree(
    ops: &[ParsedOp],
) -> Result<(Vec<MerkOp>, Option<MerkBinaryTree>), ParseError> {
    let op_views: Vec<MerkOp> = ops.iter().map(parsed_op_to_view).collect();
    let tree = reconstruct_binary_tree(ops).ok();
    Ok((op_views, tree))
}

fn parsed_op_to_view(op: &ParsedOp) -> MerkOp {
    match op {
        ParsedOp::Push(n) => MerkOp::Push { node: n.clone() },
        ParsedOp::PushInverted(n) => MerkOp::PushInverted { node: n.clone() },
        ParsedOp::Parent => MerkOp::Parent,
        ParsedOp::Child => MerkOp::Child,
        ParsedOp::ParentInverted => MerkOp::ParentInverted,
        ParsedOp::ChildInverted => MerkOp::ChildInverted,
    }
}

fn reconstruct_binary_tree(ops: &[ParsedOp]) -> Result<MerkBinaryTree, ParseError> {
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
            ParsedOp::Push(n) | ParsedOp::PushInverted(n) => {
                let id = nodes.len();
                nodes.push(MerkBinaryNode {
                    id,
                    view: n.clone(),
                    left: None,
                    right: None,
                    on_path: false,
                });
                stack.push(id);
            }
            ParsedOp::Parent => {
                let parent = pop(&mut stack)?;
                let child = pop(&mut stack)?;
                attach(&mut nodes, parent, child, Side::Left);
                stack.push(parent);
            }
            ParsedOp::Child => {
                let child = pop(&mut stack)?;
                let parent = pop(&mut stack)?;
                attach(&mut nodes, parent, child, Side::Right);
                stack.push(parent);
            }
            ParsedOp::ParentInverted => {
                let parent = pop(&mut stack)?;
                let child = pop(&mut stack)?;
                attach(&mut nodes, parent, child, Side::Right);
                stack.push(parent);
            }
            ParsedOp::ChildInverted => {
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

fn find_node_with_key(tree: &MerkBinaryTree, key_hex: &str) -> Option<usize> {
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
            | MerkNodeView::KvValueHashFeatureTypeWithChildHash { key: k, .. } => k.hex == key_hex,
            _ => false,
        };
        if matches {
            return Some(n.id);
        }
    }
    None
}

#[derive(Debug, Clone)]
enum ParsedOp {
    Push(MerkNodeView),
    PushInverted(MerkNodeView),
    Parent,
    Child,
    ParentInverted,
    ChildInverted,
}

/// Parse a `Merk(...)` body — a list of newline-separated `<idx>: <op>` lines —
/// up to and including the matching `)`.
fn parse_ops_until_paren(parser: &mut Parser) -> Result<Vec<ParsedOp>, ParseError> {
    let mut ops = Vec::new();
    loop {
        parser.skip_whitespace();
        if parser.peek() == Some(')') {
            parser.expect_char(')')?;
            break;
        }
        // op-line index, then `:`, then the op
        parser.skip_digits();
        parser.skip_whitespace();
        parser.expect_char(':')?;
        parser.skip_whitespace();
        ops.push(parse_op(parser)?);
    }
    Ok(ops)
}

/// V0 variant: `merk_proof:` is followed by inline ops with no enclosing wrapper.
fn parse_ops_inline(parser: &mut Parser) -> Result<Vec<ParsedOp>, ParseError> {
    let mut ops = Vec::new();
    loop {
        parser.skip_whitespace();
        // Stop at `}` (end of LayerProof) or `lower_layers` keyword
        if parser.peek() == Some('}') {
            break;
        }
        if parser.starts_with_keyword("lower_layers") {
            break;
        }
        // Peek to see if we have a "<digits>: " line; otherwise assume done.
        if !parser.peek_is_digit() {
            break;
        }
        parser.skip_digits();
        parser.skip_whitespace();
        parser.expect_char(':')?;
        parser.skip_whitespace();
        ops.push(parse_op(parser)?);
    }
    Ok(ops)
}

fn parse_op(parser: &mut Parser) -> Result<ParsedOp, ParseError> {
    if parser.consume_keyword("PushInverted") {
        parser.skip_whitespace();
        parser.expect_char('(')?;
        let node = parse_node(parser)?;
        parser.skip_whitespace();
        parser.expect_char(')')?;
        return Ok(ParsedOp::PushInverted(node));
    }
    if parser.consume_keyword("Push") {
        parser.skip_whitespace();
        parser.expect_char('(')?;
        let node = parse_node(parser)?;
        parser.skip_whitespace();
        parser.expect_char(')')?;
        return Ok(ParsedOp::Push(node));
    }
    if parser.consume_keyword("ParentInverted") {
        return Ok(ParsedOp::ParentInverted);
    }
    if parser.consume_keyword("ChildInverted") {
        return Ok(ParsedOp::ChildInverted);
    }
    if parser.consume_keyword("Parent") {
        return Ok(ParsedOp::Parent);
    }
    if parser.consume_keyword("Child") {
        return Ok(ParsedOp::Child);
    }
    Err(parser.err("expected an Op (Push/PushInverted/Parent/Child/…)"))
}

fn parse_node(parser: &mut Parser) -> Result<MerkNodeView, ParseError> {
    // Order matters: longer keywords first so e.g. `KVValueHashFeatureTypeWithChildHash`
    // doesn't get short-circuited by `KVValueHashFeatureType`.
    if parser.consume_keyword("KVValueHashFeatureTypeWithChildHash") {
        parser.skip_whitespace();
        parser.expect_char('(')?;
        let key = DisplayKey::from_bytes(&parse_key_bytes(parser)?);
        comma(parser)?;
        let value = parse_element(parser)?;
        comma(parser)?;
        let value_hash = parse_hash(parser)?;
        comma(parser)?;
        let feature_type = parse_feature_type(parser)?;
        comma(parser)?;
        let child_hash = parse_hash(parser)?;
        parser.skip_whitespace();
        parser.expect_char(')')?;
        return Ok(MerkNodeView::KvValueHashFeatureTypeWithChildHash {
            key,
            value,
            value_hash,
            feature_type,
            child_hash,
        });
    }
    if parser.consume_keyword("KVValueHashFeatureType") {
        parser.skip_whitespace();
        parser.expect_char('(')?;
        let key = DisplayKey::from_bytes(&parse_key_bytes(parser)?);
        comma(parser)?;
        let value = parse_element(parser)?;
        comma(parser)?;
        let value_hash = parse_hash(parser)?;
        comma(parser)?;
        let feature_type = parse_feature_type(parser)?;
        parser.skip_whitespace();
        parser.expect_char(')')?;
        return Ok(MerkNodeView::KvValueHashFeatureType {
            key,
            value,
            value_hash,
            feature_type,
        });
    }
    if parser.consume_keyword("KVValueHash") {
        parser.skip_whitespace();
        parser.expect_char('(')?;
        let key = DisplayKey::from_bytes(&parse_key_bytes(parser)?);
        comma(parser)?;
        let value = parse_element(parser)?;
        comma(parser)?;
        let value_hash = parse_hash(parser)?;
        parser.skip_whitespace();
        parser.expect_char(')')?;
        return Ok(MerkNodeView::KvValueHash {
            key,
            value,
            value_hash,
        });
    }
    if parser.consume_keyword("KVRefValueHashCount") {
        parser.skip_whitespace();
        parser.expect_char('(')?;
        let key = DisplayKey::from_bytes(&parse_key_bytes(parser)?);
        comma(parser)?;
        let value = parse_element(parser)?;
        comma(parser)?;
        let value_hash = parse_hash(parser)?;
        comma(parser)?;
        let count = parse_u64(parser)?;
        parser.skip_whitespace();
        parser.expect_char(')')?;
        return Ok(MerkNodeView::KvRefValueHashCount {
            key,
            value,
            value_hash,
            count,
        });
    }
    if parser.consume_keyword("KVRefValueHash") {
        parser.skip_whitespace();
        parser.expect_char('(')?;
        let key = DisplayKey::from_bytes(&parse_key_bytes(parser)?);
        comma(parser)?;
        let value = parse_element(parser)?;
        comma(parser)?;
        let value_hash = parse_hash(parser)?;
        parser.skip_whitespace();
        parser.expect_char(')')?;
        return Ok(MerkNodeView::KvRefValueHash {
            key,
            value,
            value_hash,
        });
    }
    if parser.consume_keyword("KVDigestCount") {
        parser.skip_whitespace();
        parser.expect_char('(')?;
        let key = DisplayKey::from_bytes(&parse_key_bytes(parser)?);
        comma(parser)?;
        let value_hash = parse_hash(parser)?;
        comma(parser)?;
        let count = parse_u64(parser)?;
        parser.skip_whitespace();
        parser.expect_char(')')?;
        return Ok(MerkNodeView::KvDigestCount {
            key,
            value_hash,
            count,
        });
    }
    if parser.consume_keyword("KVDigest") {
        parser.skip_whitespace();
        parser.expect_char('(')?;
        let key = DisplayKey::from_bytes(&parse_key_bytes(parser)?);
        comma(parser)?;
        let value_hash = parse_hash(parser)?;
        parser.skip_whitespace();
        parser.expect_char(')')?;
        return Ok(MerkNodeView::KvDigest { key, value_hash });
    }
    if parser.consume_keyword("KVCount") {
        parser.skip_whitespace();
        parser.expect_char('(')?;
        let key = DisplayKey::from_bytes(&parse_key_bytes(parser)?);
        comma(parser)?;
        let value = parse_element(parser)?;
        comma(parser)?;
        let count = parse_u64(parser)?;
        parser.skip_whitespace();
        parser.expect_char(')')?;
        return Ok(MerkNodeView::KvCount { key, value, count });
    }
    if parser.consume_keyword("KVHashCount") {
        parser.skip_whitespace();
        parser.expect_char('(')?;
        let kv_hash = parse_hash(parser)?;
        comma(parser)?;
        let count = parse_u64(parser)?;
        parser.skip_whitespace();
        parser.expect_char(')')?;
        return Ok(MerkNodeView::KvHashCount { kv_hash, count });
    }
    if parser.consume_keyword("KVHash") {
        parser.skip_whitespace();
        parser.expect_char('(')?;
        let kv_hash = parse_hash(parser)?;
        parser.skip_whitespace();
        parser.expect_char(')')?;
        return Ok(MerkNodeView::KvHash { kv_hash });
    }
    if parser.consume_keyword("KV") {
        parser.skip_whitespace();
        parser.expect_char('(')?;
        let key = DisplayKey::from_bytes(&parse_key_bytes(parser)?);
        comma(parser)?;
        let value = parse_element(parser)?;
        parser.skip_whitespace();
        parser.expect_char(')')?;
        return Ok(MerkNodeView::Kv { key, value });
    }
    if parser.consume_keyword("HashWithCount") {
        parser.skip_whitespace();
        parser.expect_char('(')?;
        let kv_hash = parse_hash(parser)?;
        comma(parser)?;
        let l = parse_hash(parser)?;
        comma(parser)?;
        let r = parse_hash(parser)?;
        comma(parser)?;
        let count = parse_u64(parser)?;
        parser.skip_whitespace();
        parser.expect_char(')')?;
        return Ok(MerkNodeView::HashWithCount {
            kv_hash,
            left_child_hash: l,
            right_child_hash: r,
            count,
        });
    }
    if parser.consume_keyword("Hash") {
        parser.skip_whitespace();
        parser.expect_char('(')?;
        let h = parse_hash(parser)?;
        parser.skip_whitespace();
        parser.expect_char(')')?;
        return Ok(MerkNodeView::Hash { hash: h });
    }
    Err(parser.err("expected a Node variant"))
}

fn parse_hash(parser: &mut Parser) -> Result<Hex32, ParseError> {
    parser.skip_whitespace();
    parser.expect_keyword("HASH")?;
    parser.expect_char('[')?;
    let start = parser.pos;
    while let Some(c) = parser.peek() {
        if c.is_ascii_hexdigit() {
            parser.pos += 1;
        } else {
            break;
        }
    }
    let hex = parser.input[start..parser.pos].to_string();
    parser.expect_char(']')?;
    Ok(hex)
}

fn parse_u64(parser: &mut Parser) -> Result<u64, ParseError> {
    parser.skip_whitespace();
    let start = parser.pos;
    while let Some(c) = parser.peek() {
        if c.is_ascii_digit() {
            parser.pos += 1;
        } else {
            break;
        }
    }
    if start == parser.pos {
        return Err(parser.err("expected an integer"));
    }
    let s = &parser.input[start..parser.pos];
    s.parse::<u64>()
        .map_err(|e| parser.err(&format!("invalid integer `{}`: {}", s, e)))
}

fn parse_i64(parser: &mut Parser) -> Result<i64, ParseError> {
    parser.skip_whitespace();
    let start = parser.pos;
    if parser.peek() == Some('-') {
        parser.pos += 1;
    }
    while let Some(c) = parser.peek() {
        if c.is_ascii_digit() {
            parser.pos += 1;
        } else {
            break;
        }
    }
    if start == parser.pos {
        return Err(parser.err("expected a signed integer"));
    }
    let s = &parser.input[start..parser.pos];
    s.parse::<i64>()
        .map_err(|e| parser.err(&format!("invalid integer `{}`: {}", s, e)))
}

fn parse_feature_type(parser: &mut Parser) -> Result<FeatureTypeView, ParseError> {
    parser.skip_whitespace();
    if parser.consume_keyword("BasicMerkNode") {
        Ok(FeatureTypeView::BasicMerkNode)
    } else if parser.consume_keyword("SummedMerkNode") {
        parser.expect_char('(')?;
        let s = parse_i64(parser)?;
        parser.expect_char(')')?;
        Ok(FeatureTypeView::SummedMerkNode { sum: s })
    } else if parser.consume_keyword("BigSummedMerkNode") {
        parser.expect_char('(')?;
        let s = read_until(parser, ')')?.trim().to_string();
        parser.expect_char(')')?;
        Ok(FeatureTypeView::BigSummedMerkNode { sum: s })
    } else if parser.consume_keyword("CountedSummedMerkNode") {
        parser.expect_char('(')?;
        let c = parse_u64(parser)?;
        comma(parser)?;
        let s = parse_i64(parser)?;
        parser.expect_char(')')?;
        Ok(FeatureTypeView::CountedSummedMerkNode { count: c, sum: s })
    } else if parser.consume_keyword("CountedMerkNode") {
        parser.expect_char('(')?;
        let c = parse_u64(parser)?;
        parser.expect_char(')')?;
        Ok(FeatureTypeView::CountedMerkNode { count: c })
    } else if parser.consume_keyword("ProvableCountedSummedMerkNode") {
        parser.expect_char('(')?;
        let c = parse_u64(parser)?;
        comma(parser)?;
        let s = parse_i64(parser)?;
        parser.expect_char(')')?;
        Ok(FeatureTypeView::ProvableCountedSummedMerkNode { count: c, sum: s })
    } else if parser.consume_keyword("ProvableCountedMerkNode") {
        parser.expect_char('(')?;
        let c = parse_u64(parser)?;
        parser.expect_char(')')?;
        Ok(FeatureTypeView::ProvableCountedMerkNode { count: c })
    } else {
        Err(parser.err("expected a TreeFeatureType"))
    }
}

/// Parse an `Element::Display` form. Brackets are balanced via depth counting
/// so flag arrays like `flags: [0, 0, 0]` and nested elements both work.
fn parse_element(parser: &mut Parser) -> Result<ElementView, ParseError> {
    parser.skip_whitespace();
    // Try the longest tags first.
    if parser.consume_keyword("ProvableCountSumTree") {
        let (root, args) = read_paren_args(parser)?;
        let count = parse_count_arg(&args, 0, parser)?;
        let sum = parse_sum_arg(&args, 1, parser)?;
        let flags = extract_flags(&args);
        return Ok(ElementView::ProvableCountSumTree {
            merk_root: root,
            count,
            sum,
            flags,
        });
    }
    if parser.consume_keyword("ProvableCountTree") {
        let (root, args) = read_paren_args(parser)?;
        let count = parse_count_arg(&args, 0, parser)?;
        let flags = extract_flags(&args);
        return Ok(ElementView::ProvableCountTree {
            merk_root: root,
            count,
            flags,
        });
    }
    if parser.consume_keyword("CountSumTree") {
        let (root, args) = read_paren_args(parser)?;
        let count = parse_count_arg(&args, 0, parser)?;
        let sum = parse_sum_arg(&args, 1, parser)?;
        let flags = extract_flags(&args);
        return Ok(ElementView::CountSumTree {
            merk_root: root,
            count,
            sum,
            flags,
        });
    }
    if parser.consume_keyword("CountTree") {
        let (root, args) = read_paren_args(parser)?;
        let count = parse_count_arg(&args, 0, parser)?;
        let flags = extract_flags(&args);
        return Ok(ElementView::CountTree {
            merk_root: root,
            count,
            flags,
        });
    }
    if parser.consume_keyword("BigSumTree") {
        let (root, args) = read_paren_args(parser)?;
        let sum = first_non_flag_arg(&args, 0)
            .ok_or_else(|| parser.err("BigSumTree missing sum"))?
            .trim()
            .to_string();
        let flags = extract_flags(&args);
        return Ok(ElementView::BigSumTree {
            merk_root: root,
            sum,
            flags,
        });
    }
    if parser.consume_keyword("SumTree") {
        let (root, args) = read_paren_args(parser)?;
        let sum = parse_sum_arg(&args, 0, parser)?;
        let flags = extract_flags(&args);
        return Ok(ElementView::SumTree {
            merk_root: root,
            sum,
            flags,
        });
    }
    if parser.consume_keyword("Tree") {
        let (root, args) = read_paren_args(parser)?;
        let flags = extract_flags(&args);
        return Ok(ElementView::Tree {
            merk_root: root,
            flags,
        });
    }
    if parser.consume_keyword("ItemWithSumItem") {
        // Element::Display writes `ItemWithSumItem(<value> , <sum>, flags: ...)`
        // — note the space-then-comma quirk in the upstream format string.
        // We tolerate both with-space and without-space variants.
        let body = read_paren_body(parser)?;
        let pieces = split_top_level_commas(&body);
        let value = pieces
            .first()
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        let sum_str = pieces
            .get(1)
            .ok_or_else(|| parser.err("ItemWithSumItem missing sum"))?;
        let sum: i64 = sum_str
            .trim()
            .parse()
            .map_err(|e| parser.err(&format!("invalid sum: {e}")))?;
        let flags = extract_flags(&pieces);
        return Ok(ElementView::ItemWithSumItem {
            value: ascii_or_hex_to_hex(&value),
            sum,
            flags,
        });
    }
    if parser.consume_keyword("Item") {
        let body = read_paren_body(parser)?;
        let pieces = split_top_level_commas(&body);
        let value = pieces
            .first()
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        let flags = extract_flags(&pieces);
        return Ok(ElementView::Item {
            value: ascii_or_hex_to_hex(&value),
            flags,
        });
    }
    if parser.consume_keyword("SumItem") {
        let body = read_paren_body(parser)?;
        let pieces = split_top_level_commas(&body);
        let sum_str = pieces
            .first()
            .ok_or_else(|| parser.err("SumItem missing sum"))?;
        let sum: i64 = sum_str
            .trim()
            .parse()
            .map_err(|e| parser.err(&format!("invalid sum: {e}")))?;
        let flags = extract_flags(&pieces);
        return Ok(ElementView::SumItem { sum, flags });
    }
    if parser.consume_keyword("CommitmentTree") {
        let body = read_paren_body(parser)?;
        let pieces = split_top_level_commas(&body);
        let total_count = parse_named_u64(&pieces, "count")?;
        let chunk_power = parse_named_u8(&pieces, "chunk_power")?;
        let flags = extract_flags(&pieces);
        return Ok(ElementView::CommitmentTree {
            total_count,
            chunk_power,
            flags,
        });
    }
    if parser.consume_keyword("MmrTree") {
        let body = read_paren_body(parser)?;
        let pieces = split_top_level_commas(&body);
        let mmr_size = parse_named_u64(&pieces, "mmr_size")?;
        let flags = extract_flags(&pieces);
        return Ok(ElementView::MmrTree { mmr_size, flags });
    }
    if parser.consume_keyword("BulkAppendTree") {
        let body = read_paren_body(parser)?;
        let pieces = split_top_level_commas(&body);
        let total_count = parse_named_u64(&pieces, "total_count")?;
        let chunk_power = parse_named_u8(&pieces, "chunk_power")?;
        let flags = extract_flags(&pieces);
        return Ok(ElementView::BulkAppendTree {
            total_count,
            chunk_power,
            flags,
        });
    }
    if parser.consume_keyword("DenseAppendOnlyFixedSizeTree") {
        let body = read_paren_body(parser)?;
        let pieces = split_top_level_commas(&body);
        let count = parse_named_u64(&pieces, "count")? as u16;
        let height = parse_named_u8(&pieces, "height")?;
        let flags = extract_flags(&pieces);
        return Ok(ElementView::DenseAppendOnlyFixedSizeTree {
            count,
            height,
            flags,
        });
    }
    if parser.consume_keyword("NonCounted") {
        parser.expect_char('(')?;
        let inner = parse_element(parser)?;
        parser.skip_whitespace();
        parser.expect_char(')')?;
        return Ok(ElementView::NonCounted {
            inner: Box::new(inner),
        });
    }
    if parser.consume_keyword("NotSummed") {
        parser.expect_char('(')?;
        let inner = parse_element(parser)?;
        parser.skip_whitespace();
        parser.expect_char(')')?;
        return Ok(ElementView::NotSummed {
            inner: Box::new(inner),
        });
    }
    if parser.consume_keyword("Reference") {
        // We don't try to round-trip Reference paths through the text format;
        // surface as Unknown so the structure stays intact.
        let body = read_paren_body(parser)?;
        return Ok(ElementView::Unknown {
            raw_hex: format!("Reference({body})"),
            error: "Reference text-parse not implemented".into(),
        });
    }
    Err(parser.err("expected an Element variant"))
}

/// Read a parenthesized arg list, treating the FIRST arg as a tree root key
/// (hex or `None`) and returning the rest as a Vec<String> of trimmed args.
///
/// Returns `(root_key_hex, rest_args)`.
fn read_paren_args(parser: &mut Parser) -> Result<(Option<HexBytes>, Vec<String>), ParseError> {
    parser.expect_char('(')?;
    let body = read_balanced_until(parser, ')')?;
    parser.expect_char(')')?;
    let pieces = split_top_level_commas(&body);
    let mut iter = pieces.into_iter();
    let first = iter.next().unwrap_or_default();
    let trimmed = first.trim();
    let root = if trimmed == "None" || trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    };
    Ok((root, iter.collect()))
}

fn read_paren_body(parser: &mut Parser) -> Result<String, ParseError> {
    parser.expect_char('(')?;
    let body = read_balanced_until(parser, ')')?;
    parser.expect_char(')')?;
    Ok(body)
}

fn read_until(parser: &mut Parser, stop: char) -> Result<String, ParseError> {
    let start = parser.pos;
    while let Some(c) = parser.peek() {
        if c == stop {
            break;
        }
        parser.pos += 1;
    }
    Ok(parser.input[start..parser.pos].to_string())
}

/// Read until the matching closing-bracket, respecting `()`/`[]`/`{}` nesting.
fn read_balanced_until(parser: &mut Parser, stop: char) -> Result<String, ParseError> {
    let start = parser.pos;
    let mut depth_paren = 0i32;
    let mut depth_brack = 0i32;
    let mut depth_brace = 0i32;
    while let Some(c) = parser.peek() {
        if c == stop && depth_paren == 0 && depth_brack == 0 && depth_brace == 0 {
            break;
        }
        match c {
            '(' => depth_paren += 1,
            ')' => depth_paren -= 1,
            '[' => depth_brack += 1,
            ']' => depth_brack -= 1,
            '{' => depth_brace += 1,
            '}' => depth_brace -= 1,
            _ => {}
        }
        parser.pos += 1;
    }
    Ok(parser.input[start..parser.pos].to_string())
}

/// Split a string by top-level commas (ignores commas inside `()` / `[]` / `{}`).
fn split_top_level_commas(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut depth_paren = 0i32;
    let mut depth_brack = 0i32;
    let mut depth_brace = 0i32;
    for ch in s.chars() {
        if ch == ',' && depth_paren == 0 && depth_brack == 0 && depth_brace == 0 {
            out.push(std::mem::take(&mut buf));
            continue;
        }
        match ch {
            '(' => depth_paren += 1,
            ')' => depth_paren -= 1,
            '[' => depth_brack += 1,
            ']' => depth_brack -= 1,
            '{' => depth_brace += 1,
            '}' => depth_brace -= 1,
            _ => {}
        }
        buf.push(ch);
    }
    if !buf.is_empty() {
        out.push(buf);
    }
    out
}

fn extract_flags(args: &[String]) -> Option<HexBytes> {
    for a in args {
        let trimmed = a.trim();
        if let Some(rest) = trimmed.strip_prefix("flags:") {
            return Some(parse_flag_array(rest.trim()));
        }
    }
    None
}

fn parse_flag_array(s: &str) -> HexBytes {
    // s should be `[<num>, <num>, ...]`. We tolerate spaces.
    let s = s.trim();
    let inner = s.trim_start_matches('[').trim_end_matches(']').trim();
    if inner.is_empty() {
        return String::new();
    }
    let mut bytes = Vec::new();
    for piece in inner.split(',') {
        let n: u8 = piece.trim().parse().unwrap_or(0);
        bytes.push(n);
    }
    hex::encode(bytes)
}

fn first_non_flag_arg(args: &[String], idx: usize) -> Option<String> {
    args.iter()
        .filter(|a| !a.trim().starts_with("flags:"))
        .nth(idx)
        .cloned()
}

fn parse_count_arg(args: &[String], idx: usize, parser: &Parser) -> Result<u64, ParseError> {
    let arg = first_non_flag_arg(args, idx).ok_or_else(|| parser.err("missing count"))?;
    arg.trim()
        .parse::<u64>()
        .map_err(|e| parser.err(&format!("invalid count `{}`: {}", arg.trim(), e)))
}

fn parse_sum_arg(args: &[String], idx: usize, parser: &Parser) -> Result<i64, ParseError> {
    let arg = first_non_flag_arg(args, idx).ok_or_else(|| parser.err("missing sum"))?;
    arg.trim()
        .parse::<i64>()
        .map_err(|e| parser.err(&format!("invalid sum `{}`: {}", arg.trim(), e)))
}

fn parse_named_u64(args: &[String], name: &str) -> Result<u64, ParseError> {
    let prefix = format!("{}:", name);
    for a in args {
        let t = a.trim();
        if let Some(rest) = t.strip_prefix(&prefix) {
            return rest.trim().parse::<u64>().map_err(|e| ParseError::Text {
                offset: 0,
                message: format!("invalid {name}: {e}"),
            });
        }
    }
    Err(ParseError::Text {
        offset: 0,
        message: format!("missing field `{name}`"),
    })
}

fn parse_named_u8(args: &[String], name: &str) -> Result<u8, ParseError> {
    parse_named_u64(args, name).map(|v| v as u8)
}

/// Read a key in `Display` form: either `0x<hex>` or an identifier like
/// `widget`, `brand_050`, `@`. Returns the raw key bytes.
fn parse_key_bytes(parser: &mut Parser) -> Result<Vec<u8>, ParseError> {
    parser.skip_whitespace();
    if parser.starts_with("0x") {
        parser.pos += 2;
        let start = parser.pos;
        while let Some(c) = parser.peek() {
            if c.is_ascii_hexdigit() {
                parser.pos += 1;
            } else {
                break;
            }
        }
        let hex_str = &parser.input[start..parser.pos];
        return hex::decode(hex_str).map_err(ParseError::Hex);
    }
    // ASCII identifier — `hex_to_ascii` allows: A-Za-z0-9_-/\[]@
    let start = parser.pos;
    while let Some(c) = parser.peek() {
        if c.is_ascii_alphanumeric()
            || c == '_'
            || c == '-'
            || c == '/'
            || c == '\\'
            || c == '['
            || c == ']'
            || c == '@'
        {
            parser.pos += 1;
        } else {
            break;
        }
    }
    if start == parser.pos {
        return Err(parser.err("expected a key"));
    }
    Ok(parser.input.as_bytes()[start..parser.pos].to_vec())
}

/// Convert `hex_to_ascii` output (which can be ASCII text or `0x<hex>`) back
/// to hex.
fn ascii_or_hex_to_hex(s: &str) -> HexBytes {
    let s = s.trim();
    if let Some(rest) = s.strip_prefix("0x") {
        rest.to_string()
    } else {
        hex::encode(s.as_bytes())
    }
}

fn parse_opaque_call(
    parser: &mut Parser,
    backing: BackingType,
) -> Result<OpaqueSummary, ParseError> {
    parser.skip_whitespace();
    parser.expect_char('(')?;
    let body = read_balanced_until(parser, ')')?;
    parser.expect_char(')')?;
    Ok(OpaqueSummary {
        backing,
        byte_length: body.len() / 2,
        raw_hex_truncated: body.trim().chars().take(80).collect(),
    })
}

fn comma(parser: &mut Parser) -> Result<(), ParseError> {
    parser.skip_whitespace();
    parser.expect_char(',')?;
    parser.skip_whitespace();
    Ok(())
}

struct Parser<'a> {
    input: &'a str,
    pos: usize,
}

impl<'a> Parser<'a> {
    fn new(input: &'a str) -> Self {
        Parser { input, pos: 0 }
    }

    fn peek(&self) -> Option<char> {
        self.input[self.pos..].chars().next()
    }

    fn peek_is_digit(&self) -> bool {
        matches!(self.peek(), Some(c) if c.is_ascii_digit())
    }

    fn skip_whitespace(&mut self) {
        while let Some(c) = self.peek() {
            if c.is_whitespace() {
                self.pos += c.len_utf8();
            } else {
                break;
            }
        }
    }

    fn skip_digits(&mut self) {
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn starts_with(&self, s: &str) -> bool {
        self.input[self.pos..].starts_with(s)
    }

    fn starts_with_keyword(&self, kw: &str) -> bool {
        if !self.starts_with(kw) {
            return false;
        }
        // boundary: next char is not an identifier continuation
        let next = self.input[self.pos + kw.len()..].chars().next();
        match next {
            None => true,
            Some(c) => !c.is_ascii_alphanumeric() && c != '_',
        }
    }

    fn consume_keyword(&mut self, kw: &str) -> bool {
        if self.starts_with_keyword(kw) {
            self.pos += kw.len();
            true
        } else {
            false
        }
    }

    fn expect_keyword(&mut self, kw: &str) -> Result<(), ParseError> {
        if self.consume_keyword(kw) {
            Ok(())
        } else {
            Err(self.err(&format!("expected `{kw}`")))
        }
    }

    fn expect_char(&mut self, ch: char) -> Result<(), ParseError> {
        if self.peek() == Some(ch) {
            self.pos += ch.len_utf8();
            Ok(())
        } else {
            Err(self.err(&format!(
                "expected `{ch}`, found `{}`",
                self.peek()
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "EOF".into())
            )))
        }
    }

    fn err(&self, msg: &str) -> ParseError {
        ParseError::Text {
            offset: self.pos,
            message: msg.to_string(),
        }
    }
}
