// Display helpers used by every renderer module.

import type {
  DisplayKey,
  ElementView,
  FeatureTypeView,
  MerkNodeView,
} from "../types.js";

/** Truncate a hex string to a `HASH[abcd…]`-style label. */
export function shortHash(hex: string, prefix = 4): string {
  if (hex.length <= prefix * 2) return `HASH[${hex}]`;
  return `HASH[${hex.slice(0, prefix * 2)}…]`;
}

/** Render a key for display. */
export function keyLabel(k: DisplayKey): string {
  return k.display;
}

/** A short one-line summary of an `ElementView`, suitable for inline labels. */
export function elementShort(e: ElementView): string {
  switch (e.kind) {
    case "tree":
      return e.merk_root != null ? `Tree(${shortBytes(e.merk_root)})` : "Tree(∅)";
    case "sum_tree":
      return `SumTree(${e.merk_root ? shortBytes(e.merk_root) : "∅"}, sum=${e.sum})`;
    case "big_sum_tree":
      return `BigSumTree(${e.merk_root ? shortBytes(e.merk_root) : "∅"}, sum=${e.sum})`;
    case "count_tree":
      return `CountTree count=${e.count.toLocaleString()}`;
    case "count_sum_tree":
      return `CountSumTree count=${e.count.toLocaleString()} sum=${e.sum}`;
    case "provable_count_tree":
      return `ProvableCountTree count=${e.count.toLocaleString()}`;
    case "provable_count_sum_tree":
      return `ProvableCountSumTree count=${e.count.toLocaleString()} sum=${e.sum}`;
    case "item":
      return `Item(${shortBytes(e.value, 8)})`;
    case "item_with_sum_item":
      return `Item(${shortBytes(e.value, 8)}) +Sum(${e.sum})`;
    case "sum_item":
      return `SumItem(${e.sum})`;
    case "reference":
      return `Ref(${e.reference.kind})`;
    case "commitment_tree":
      return `CommitmentTree(${e.total_count})`;
    case "mmr_tree":
      return `MmrTree(size=${e.mmr_size})`;
    case "bulk_append_tree":
      return `BulkAppendTree(${e.total_count})`;
    case "dense_append_only_fixed_size_tree":
      return `DenseTree(count=${e.count}, h=${e.height})`;
    case "non_counted":
      return `NonCounted(${elementShort(e.inner)})`;
    case "not_summed":
      return `NotSummed(${elementShort(e.inner)})`;
    case "unknown":
      return `Unknown(${shortBytes(e.raw_hex, 4)})`;
  }
}

/** A multiline-friendly version with a label per field. */
export function elementFields(e: ElementView): Array<[string, string]> {
  const fields: Array<[string, string]> = [["kind", e.kind]];
  switch (e.kind) {
    case "tree":
      if (e.merk_root) fields.push(["merk_root", e.merk_root]);
      break;
    case "sum_tree":
    case "big_sum_tree":
      if (e.merk_root) fields.push(["merk_root", e.merk_root]);
      fields.push(["sum", String(e.sum)]);
      break;
    case "count_tree":
    case "provable_count_tree":
      if (e.merk_root) fields.push(["merk_root", e.merk_root]);
      fields.push(["count", String(e.count)]);
      break;
    case "count_sum_tree":
    case "provable_count_sum_tree":
      if (e.merk_root) fields.push(["merk_root", e.merk_root]);
      fields.push(["count", String(e.count)], ["sum", String(e.sum)]);
      break;
    case "item":
      fields.push(["value", e.value]);
      break;
    case "non_counted":
    case "not_summed":
      fields.push(["inner", elementShort(e.inner)]);
      break;
    default:
      break;
  }
  if ("flags" in e && e.flags) fields.push(["flags", e.flags]);
  return fields;
}

export function featureTypeShort(ft: FeatureTypeView): string {
  switch (ft.kind) {
    case "basic_merk_node":
      return "Basic";
    case "summed_merk_node":
      return `Sum(${ft.sum})`;
    case "big_summed_merk_node":
      return `BigSum(${ft.sum})`;
    case "counted_merk_node":
      return `Count(${ft.count})`;
    case "counted_summed_merk_node":
      return `Count(${ft.count})+Sum(${ft.sum})`;
    case "provable_counted_merk_node":
      return `ProvCount(${ft.count})`;
    case "provable_counted_summed_merk_node":
      return `ProvCount(${ft.count})+Sum(${ft.sum})`;
  }
}

/** Pull a human-readable label from any merk-node view. */
export function nodeBriefLabel(view: MerkNodeView): { primary: string; secondary?: string } {
  switch (view.kind) {
    case "hash":
      return { primary: shortHash(view.hash) };
    case "kv_hash":
      return { primary: `KVHash[${shortBytes(view.kv_hash)}]` };
    case "kv_digest":
      return { primary: keyLabel(view.key), secondary: shortHash(view.value_hash) };
    case "kv":
      return { primary: keyLabel(view.key), secondary: elementShort(view.value) };
    case "kv_value_hash":
      return { primary: keyLabel(view.key), secondary: elementShort(view.value) };
    case "kv_value_hash_feature_type":
      return {
        primary: keyLabel(view.key),
        secondary: `${elementShort(view.value)} ${featureTypeShort(view.feature_type)}`,
      };
    case "kv_ref_value_hash":
      return { primary: keyLabel(view.key), secondary: elementShort(view.value) };
    case "kv_count":
      return { primary: keyLabel(view.key), secondary: `${elementShort(view.value)} +${view.count}` };
    case "kv_hash_count":
      return { primary: `KVHash[${shortBytes(view.kv_hash)}]`, secondary: `count=${view.count}` };
    case "kv_ref_value_hash_count":
      return {
        primary: keyLabel(view.key),
        secondary: `${elementShort(view.value)} count=${view.count}`,
      };
    case "kv_digest_count":
      return { primary: keyLabel(view.key), secondary: `count=${view.count}` };
    case "kv_value_hash_feature_type_with_child_hash":
      return {
        primary: keyLabel(view.key),
        secondary: `${elementShort(view.value)} ${featureTypeShort(view.feature_type)}`,
      };
    case "hash_with_count":
      return {
        primary: `KVHash[${shortBytes(view.kv_hash)}]`,
        secondary: `count=${view.count}`,
      };
  }
}

export function shortBytes(hex: string, prefix = 4): string {
  if (hex.length <= prefix * 2) return hex;
  return `${hex.slice(0, prefix * 2)}…`;
}

/**
 * Classify a node for styling:
 *   - `target`: the queried/leaf payload (KvValueHashFeatureTypeWithChildHash,
 *     KvValueHash with a non-Tree value, or a leaf KvCount)
 *   - `descend`: a key on the descent path (KvValueHash with a Tree value)
 *   - `internal`: an internal kv-hash (no value revealed)
 *   - `opaque`: just a hash, no key
 */
export function classifyNode(view: MerkNodeView): "target" | "descend" | "internal" | "opaque" {
  switch (view.kind) {
    case "hash":
      return "opaque";
    case "kv_hash":
    case "kv_hash_count":
    case "hash_with_count":
      return "internal";
    case "kv_value_hash":
    case "kv":
    case "kv_value_hash_feature_type":
    case "kv_ref_value_hash":
      return isTreeValued(view) ? "descend" : "target";
    case "kv_value_hash_feature_type_with_child_hash":
    case "kv_count":
    case "kv_ref_value_hash_count":
    case "kv_digest":
    case "kv_digest_count":
      return "target";
  }
}

function isTreeValued(view: MerkNodeView): boolean {
  if (
    view.kind !== "kv" &&
    view.kind !== "kv_value_hash" &&
    view.kind !== "kv_value_hash_feature_type" &&
    view.kind !== "kv_ref_value_hash"
  ) {
    return false;
  }
  const e = view.value;
  return (
    e.kind === "tree" ||
    e.kind === "sum_tree" ||
    e.kind === "big_sum_tree" ||
    e.kind === "count_tree" ||
    e.kind === "count_sum_tree" ||
    e.kind === "provable_count_tree" ||
    e.kind === "provable_count_sum_tree"
  );
}
