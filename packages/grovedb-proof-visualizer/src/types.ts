// Render-friendly intermediate representation, mirroring
// `crates/grovedb-proof-view/src/ir.rs`. Keep in sync with that file.
//
// JSON Schema for runtime validation lives at `proof-view.schema.json`.

export interface ProofView {
  version: number;
  root_layer_id: number;
  layers: LayerView[];
}

export interface LayerView {
  layer_id: number;
  backing: BackingType;
  descended_via: DisplayKey | null;
  ops: MerkOp[];
  binary_tree: MerkBinaryTree | null;
  opaque_summary: OpaqueSummary | null;
  descents: DescentEdge[];
}

export type BackingType =
  | "merk"
  | "mmr"
  | "bulk_append_tree"
  | "dense_tree"
  | "commitment_tree";

export type MerkOp =
  | { op: "push"; node: MerkNodeView }
  | { op: "push_inverted"; node: MerkNodeView }
  | { op: "parent" }
  | { op: "child" }
  | { op: "parent_inverted" }
  | { op: "child_inverted" };

export interface MerkBinaryTree {
  root: number;
  nodes: MerkBinaryNode[];
}

export interface MerkBinaryNode {
  id: number;
  view: MerkNodeView;
  left: number | null;
  right: number | null;
  on_path: boolean;
}

export type MerkNodeView =
  | { kind: "hash"; hash: string }
  | { kind: "kv_hash"; kv_hash: string }
  | { kind: "kv_digest"; key: DisplayKey; value_hash: string }
  | { kind: "kv"; key: DisplayKey; value: ElementView }
  | {
      kind: "kv_value_hash";
      key: DisplayKey;
      value: ElementView;
      value_hash: string;
    }
  | {
      kind: "kv_value_hash_feature_type";
      key: DisplayKey;
      value: ElementView;
      value_hash: string;
      feature_type: FeatureTypeView;
    }
  | {
      kind: "kv_ref_value_hash";
      key: DisplayKey;
      value: ElementView;
      value_hash: string;
    }
  | { kind: "kv_count"; key: DisplayKey; value: ElementView; count: number }
  | { kind: "kv_hash_count"; kv_hash: string; count: number }
  | {
      kind: "kv_ref_value_hash_count";
      key: DisplayKey;
      value: ElementView;
      value_hash: string;
      count: number;
    }
  | { kind: "kv_digest_count"; key: DisplayKey; value_hash: string; count: number }
  | {
      kind: "kv_value_hash_feature_type_with_child_hash";
      key: DisplayKey;
      value: ElementView;
      value_hash: string;
      feature_type: FeatureTypeView;
      child_hash: string;
    }
  | {
      kind: "hash_with_count";
      kv_hash: string;
      left_child_hash: string;
      right_child_hash: string;
      count: number;
    };

export type FeatureTypeView =
  | { kind: "basic_merk_node" }
  | { kind: "summed_merk_node"; sum: number }
  | { kind: "big_summed_merk_node"; sum: string }
  | { kind: "counted_merk_node"; count: number }
  | { kind: "counted_summed_merk_node"; count: number; sum: number }
  | { kind: "provable_counted_merk_node"; count: number }
  | { kind: "provable_counted_summed_merk_node"; count: number; sum: number };

export type ElementView =
  | { kind: "tree"; merk_root: string | null; flags: string | null }
  | {
      kind: "sum_tree";
      merk_root: string | null;
      sum: number;
      flags: string | null;
    }
  | {
      kind: "big_sum_tree";
      merk_root: string | null;
      sum: string;
      flags: string | null;
    }
  | {
      kind: "count_tree";
      merk_root: string | null;
      count: number;
      flags: string | null;
    }
  | {
      kind: "count_sum_tree";
      merk_root: string | null;
      count: number;
      sum: number;
      flags: string | null;
    }
  | {
      kind: "provable_count_tree";
      merk_root: string | null;
      count: number;
      flags: string | null;
    }
  | {
      kind: "provable_count_sum_tree";
      merk_root: string | null;
      count: number;
      sum: number;
      flags: string | null;
    }
  | { kind: "item"; value: string; flags: string | null }
  | { kind: "item_with_sum_item"; value: string; sum: number; flags: string | null }
  | { kind: "sum_item"; sum: number; flags: string | null }
  | {
      kind: "reference";
      reference: ReferenceView;
      max_hop: number | null;
      flags: string | null;
    }
  | {
      kind: "commitment_tree";
      total_count: number;
      chunk_power: number;
      flags: string | null;
    }
  | { kind: "mmr_tree"; mmr_size: number; flags: string | null }
  | {
      kind: "bulk_append_tree";
      total_count: number;
      chunk_power: number;
      flags: string | null;
    }
  | {
      kind: "dense_append_only_fixed_size_tree";
      count: number;
      height: number;
      flags: string | null;
    }
  | { kind: "non_counted"; inner: ElementView }
  | { kind: "not_summed"; inner: ElementView }
  | { kind: "unknown"; raw_hex: string; error: string };

export type ReferenceView =
  | { kind: "absolute"; path: DisplayKey[] }
  | { kind: "upstream_root_height"; n_keep: number; path_append: DisplayKey[] }
  | {
      kind: "upstream_root_height_with_parent_path_addition";
      n_keep: number;
      path_append: DisplayKey[];
    }
  | {
      kind: "upstream_from_element_height";
      n_remove: number;
      path_append: DisplayKey[];
    }
  | { kind: "cousin"; swap_parent: DisplayKey }
  | { kind: "removed_cousin"; swap_parent: DisplayKey[] }
  | { kind: "sibling"; sibling_key: DisplayKey };

export interface DescentEdge {
  from_key: DisplayKey;
  to_layer_id: number;
  from_node_id: number | null;
}

export interface OpaqueSummary {
  backing: BackingType;
  byte_length: number;
  raw_hex_truncated: string;
}

export interface DisplayKey {
  display: string;
  hex: string;
  is_ascii: boolean;
}
