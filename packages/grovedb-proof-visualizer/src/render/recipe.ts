// Build a "hash recipe" for any node in the reconstructed Merk binary tree.
//
// Mirrors the per-variant logic in `merk/src/proofs/tree.rs::Tree::hash` of
// the pinned grovedb revision. For the panel UI: every step is rendered with
// its inputs (as hex chunks) and its blake3 output, so the user can trace the
// computation byte-for-byte.

import type {
  ElementView,
  FeatureTypeView,
  MerkBinaryNode,
  MerkBinaryTree,
} from "../types.js";
import {
  combineHash,
  Hash32,
  hex,
  hexToBytes,
  i64BE,
  kvHashFromValueHash,
  NULL_HASH,
  nodeHash,
  nodeHashWithCount,
  nodeHashWithCountAndSum,
  nodeHashWithSum,
  u64BE,
  valueHash,
  varint,
} from "./hashing.js";

export interface Recipe {
  /** Final hash this node contributes upward (its node_hash, or just `hash` for opaque). */
  finalHash: Hash32;
  /** Step-by-step derivation. Empty for opaque `Hash(h)` nodes. */
  steps: RecipeStep[];
  /** One-liner describing what this node is. */
  summary: string;
  /** Optional callouts (e.g. "this is a self-verifying subtree summary"). */
  notes: string[];
}

export interface RecipeStep {
  /** Short name: "value_hash" / "kv_hash" / "node_hash" / "combine_hash" / etc. */
  name: string;
  /** Human-readable formula, e.g. "blake3(varint(key.len) || key || value_hash)". */
  formula: string;
  /** Inputs concatenated to form the blake3 input, in order. */
  inputs: RecipeInput[];
  /** Resulting 32-byte hash. */
  output: Hash32;
}

export interface RecipeInput {
  label: string;
  bytes: Uint8Array;
  /** Optional gloss explaining what this byte chunk represents. */
  note?: string;
}

/**
 * Which aggregate gets folded into a node's hash:
 *   - `none`: plain `node_hash(kv, left, right)`
 *   - `count`: `node_hash_with_count(kv, left, right, count)` — ProvableCountTree
 *   - `sum`: `node_hash_with_sum(kv, left, right, sum)` — ProvableSumTree
 *   - `countSum`: `node_hash_with_count_and_sum(kv, left, right, count, sum)` —
 *     ProvableCountProvableSumTree
 */
type Aggregate =
  | { kind: "none" }
  | { kind: "count"; count: bigint }
  | { kind: "sum"; sum: bigint }
  | { kind: "countSum"; count: bigint; sum: bigint };

/**
 * Walk the tree post-order and compute every node's `node_hash`. This is the
 * same recursion the Merk verifier does — we mirror it so the panel can show
 * each child's contribution as the result of its own (cached) computation.
 */
export function computeAllNodeHashes(tree: MerkBinaryTree): Hash32[] {
  const hashes: Hash32[] = new Array(tree.nodes.length);
  function visit(id: number) {
    const node = tree.nodes[id];
    if (node.left != null) visit(node.left);
    if (node.right != null) visit(node.right);
    const left = node.left != null ? hashes[node.left] : NULL_HASH;
    const right = node.right != null ? hashes[node.right] : NULL_HASH;
    hashes[id] = recipeFor(node, left, right).finalHash;
  }
  visit(tree.root);
  return hashes;
}

/**
 * Build the recipe for a single node, given the (already-computed) hashes of
 * its left and right children. Caller passes `NULL_HASH` for missing children.
 */
export function recipeFor(node: MerkBinaryNode, left: Hash32, right: Hash32): Recipe {
  const v = node.view;
  switch (v.kind) {
    case "hash":
      return opaqueHash(v.hash);

    // Compressed subtree roots — self-contained, no children needed.
    case "hash_with_count":
      return hashWithAggregateRecipe(
        v.kv_hash,
        v.left_child_hash,
        v.right_child_hash,
        { kind: "count", count: BigInt(v.count) },
        "HashWithCount",
      );
    case "hash_with_sum":
      return hashWithAggregateRecipe(
        v.kv_hash,
        v.left_child_hash,
        v.right_child_hash,
        { kind: "sum", sum: BigInt(v.sum) },
        "HashWithSum",
      );
    case "hash_with_count_and_sum":
      return hashWithAggregateRecipe(
        v.kv_hash,
        v.left_child_hash,
        v.right_child_hash,
        { kind: "countSum", count: BigInt(v.count), sum: BigInt(v.sum) },
        "HashWithCountAndSum",
      );

    // Internal "only kv_hash" variants (no key/value revealed).
    case "kv_hash":
      return kvHashGivenRecipe(v.kv_hash, left, right, { kind: "none" });
    case "kv_hash_count":
      return kvHashGivenRecipe(v.kv_hash, left, right, {
        kind: "count",
        count: BigInt(v.count),
      });
    case "kv_hash_sum":
      return kvHashGivenRecipe(v.kv_hash, left, right, {
        kind: "sum",
        sum: BigInt(v.sum),
      });
    case "kv_hash_count_sum":
      return kvHashGivenRecipe(v.kv_hash, left, right, {
        kind: "countSum",
        count: BigInt(v.count),
        sum: BigInt(v.sum),
      });

    // KV (full key + value bytes available — compute value_hash from value).
    case "kv":
      return kvFromValueRecipe(
        asciiOrHexToBytes(v.key.hex),
        elementValueBytes(v.value),
        left,
        right,
        { kind: "none" },
      );
    case "kv_count":
      return kvFromValueRecipe(
        asciiOrHexToBytes(v.key.hex),
        elementValueBytes(v.value),
        left,
        right,
        { kind: "count", count: BigInt(v.count) },
      );
    case "kv_sum":
      return kvFromValueRecipe(
        asciiOrHexToBytes(v.key.hex),
        elementValueBytes(v.value),
        left,
        right,
        { kind: "sum", sum: BigInt(v.sum) },
      );
    case "kv_count_sum":
      return kvFromValueRecipe(
        asciiOrHexToBytes(v.key.hex),
        elementValueBytes(v.value),
        left,
        right,
        { kind: "countSum", count: BigInt(v.count), sum: BigInt(v.sum) },
      );

    // KVValueHash family — value_hash is given (potentially a combined hash).
    case "kv_value_hash":
      return kvValueHashRecipe(
        asciiOrHexToBytes(v.key.hex),
        v.value,
        v.value_hash,
        left,
        right,
        { kind: "none" },
      );
    case "kv_value_hash_feature_type":
    case "kv_value_hash_feature_type_with_child_hash": {
      const childHashHex =
        v.kind === "kv_value_hash_feature_type_with_child_hash" ? v.child_hash : null;
      return kvValueHashFeatureRecipe(
        asciiOrHexToBytes(v.key.hex),
        v.value,
        v.value_hash,
        v.feature_type,
        childHashHex,
        left,
        right,
      );
    }

    // KVRef variants — combined_value_hash from node_value_hash + referenced_value_hash.
    case "kv_ref_value_hash":
      return kvRefValueHashRecipe(
        asciiOrHexToBytes(v.key.hex),
        elementValueBytes(v.value),
        v.value_hash,
        left,
        right,
        { kind: "none" },
      );
    case "kv_ref_value_hash_count":
      return kvRefValueHashRecipe(
        asciiOrHexToBytes(v.key.hex),
        elementValueBytes(v.value),
        v.value_hash,
        left,
        right,
        { kind: "count", count: BigInt(v.count) },
      );
    case "kv_ref_value_hash_sum":
      return kvRefValueHashRecipe(
        asciiOrHexToBytes(v.key.hex),
        elementValueBytes(v.value),
        v.value_hash,
        left,
        right,
        { kind: "sum", sum: BigInt(v.sum) },
      );
    case "kv_ref_value_hash_count_sum":
      return kvRefValueHashRecipe(
        asciiOrHexToBytes(v.key.hex),
        elementValueBytes(v.value),
        v.value_hash,
        left,
        right,
        { kind: "countSum", count: BigInt(v.count), sum: BigInt(v.sum) },
      );

    // KVDigest — boundary keys (key + value_hash, no value bytes).
    case "kv_digest":
      return kvDigestRecipe(asciiOrHexToBytes(v.key.hex), v.value_hash, left, right, {
        kind: "none",
      });
    case "kv_digest_count":
      return kvDigestRecipe(asciiOrHexToBytes(v.key.hex), v.value_hash, left, right, {
        kind: "count",
        count: BigInt(v.count),
      });
    case "kv_digest_sum":
      return kvDigestRecipe(asciiOrHexToBytes(v.key.hex), v.value_hash, left, right, {
        kind: "sum",
        sum: BigInt(v.sum),
      });
    case "kv_digest_count_sum":
      return kvDigestRecipe(asciiOrHexToBytes(v.key.hex), v.value_hash, left, right, {
        kind: "countSum",
        count: BigInt(v.count),
        sum: BigInt(v.sum),
      });
  }
}

// ---------- per-variant recipe builders ----------

function opaqueHash(h: string): Recipe {
  const bytes = hexToBytes(h);
  return {
    finalHash: bytes,
    steps: [],
    summary: "Opaque sibling — only the subtree's node_hash is revealed",
    notes: [
      "This node's contents (key, value) are not in the proof. Its parent uses this hash directly when computing its own node_hash.",
    ],
  };
}

function hashWithAggregateRecipe(
  kvHashHex: string,
  leftHashHex: string,
  rightHashHex: string,
  aggregate: Aggregate,
  variantName: string,
): Recipe {
  const kvHash = hexToBytes(kvHashHex);
  const leftHash = hexToBytes(leftHashHex);
  const rightHash = hexToBytes(rightHashHex);
  const step = nodeHashStep(kvHash, leftHash, rightHash, aggregate, {
    leftNote: "subtree root's left child",
    rightNote: "subtree root's right child",
    kvNote: "stored kv_hash for the subtree's root",
  });
  return {
    finalHash: step.output,
    summary: `Compressed in-range subtree summary (${variantName}${aggregateLabel(aggregate)})`,
    notes: [
      "AggregateCount / AggregateSum / combined collapses an entire fully-inside subtree into one node by committing its (kv_hash, left, right" +
        aggregateNoteTail(aggregate) +
        "). The verifier recomputes the matching node_hash variant from these fields — a forged aggregate diverges the result.",
    ],
    steps: [step],
  };
}

function kvHashGivenRecipe(
  kvHashHex: string,
  left: Hash32,
  right: Hash32,
  aggregate: Aggregate,
): Recipe {
  const kvHash = hexToBytes(kvHashHex);
  const step = nodeHashStep(kvHash, left, right, aggregate);
  return {
    finalHash: step.output,
    summary: `Internal node — only its kv_hash is revealed${aggregateLabel(aggregate)}`,
    notes: [],
    steps: [step],
  };
}

function kvFromValueRecipe(
  key: Uint8Array,
  value: Uint8Array,
  left: Hash32,
  right: Hash32,
  aggregate: Aggregate,
): Recipe {
  const vh = valueHash(value);
  const kvh = kvHashFromValueHash(key, vh);
  const nh = nodeHashStep(kvh, left, right, aggregate);
  return {
    finalHash: nh.output,
    summary: `KV node — full key + value in proof${aggregateLabel(aggregate)}`,
    notes: [],
    steps: [
      {
        name: "value_hash",
        formula: "blake3(varint(value.len) || value)",
        inputs: [
          { label: "varint(value.len)", bytes: varint(value.length), note: `len=${value.length}` },
          { label: "value", bytes: value },
        ],
        output: vh,
      },
      kvHashStep(key, vh, kvh),
      nh,
    ],
  };
}

function kvValueHashRecipe(
  key: Uint8Array,
  value: ElementView,
  valueHashHex: string,
  left: Hash32,
  right: Hash32,
  aggregate: Aggregate,
): Recipe {
  const vh = hexToBytes(valueHashHex);
  const kvh = kvHashFromValueHash(key, vh);
  const nh = nodeHashStep(kvh, left, right, aggregate);
  return {
    finalHash: nh.output,
    summary: `Queried node — key, value (${value.kind}) and its value_hash${aggregateLabel(aggregate)}`,
    notes: [
      "The proof gives value_hash directly; for Tree-valued elements it is `combine_hash(H(value), child_hash)` so we don't recompute it from the value bytes.",
    ],
    steps: [kvHashStep(key, vh, kvh), nh],
  };
}

function kvValueHashFeatureRecipe(
  key: Uint8Array,
  value: ElementView,
  valueHashHex: string,
  ft: FeatureTypeView,
  childHashHex: string | null,
  left: Hash32,
  right: Hash32,
): Recipe {
  const vh = hexToBytes(valueHashHex);
  const kvh = kvHashFromValueHash(key, vh);
  const aggregate = featureAggregate(ft);
  const nh = nodeHashStep(kvh, left, right, aggregate);
  const notes: string[] = [];
  if (childHashHex) {
    notes.push(
      "child_hash is GroveDB-level metadata (the merk root of the omitted lower layer). It does NOT participate in this Merk node hash; it appears here so the verifier can check the embedded subtree without expanding it.",
    );
  }
  return {
    finalHash: nh.output,
    summary: `Queried node — key, value (${value.kind}), value_hash, feature_type=${ft.kind}${
      childHashHex ? ", + child_hash" : ""
    }${aggregateLabel(aggregate)}`,
    notes,
    steps: [kvHashStep(key, vh, kvh), nh],
  };
}

function kvRefValueHashRecipe(
  key: Uint8Array,
  referencedValue: Uint8Array,
  nodeValueHashHex: string,
  left: Hash32,
  right: Hash32,
  aggregate: Aggregate,
): Recipe {
  const nodeValueHash = hexToBytes(nodeValueHashHex);
  const refValueHash = valueHash(referencedValue);
  const combined = combineHash(nodeValueHash, refValueHash);
  const kvh = kvHashFromValueHash(key, combined);
  const nh = nodeHashStep(kvh, left, right, aggregate);
  return {
    finalHash: nh.output,
    summary: `Reference — combines node_value_hash with referenced_value_hash${aggregateLabel(aggregate)}`,
    notes: [],
    steps: [
      {
        name: "referenced_value_hash",
        formula: "blake3(varint(value.len) || referenced_value)",
        inputs: [
          {
            label: "varint(value.len)",
            bytes: varint(referencedValue.length),
            note: `len=${referencedValue.length}`,
          },
          { label: "referenced_value", bytes: referencedValue },
        ],
        output: refValueHash,
      },
      {
        name: "combined_value_hash",
        formula: "blake3(node_value_hash || referenced_value_hash)",
        inputs: [
          { label: "node_value_hash", bytes: nodeValueHash },
          { label: "referenced_value_hash", bytes: refValueHash },
        ],
        output: combined,
      },
      kvHashStep(key, combined, kvh),
      nh,
    ],
  };
}

function kvDigestRecipe(
  key: Uint8Array,
  valueHashHex: string,
  left: Hash32,
  right: Hash32,
  aggregate: Aggregate,
): Recipe {
  const vh = hexToBytes(valueHashHex);
  const kvh = kvHashFromValueHash(key, vh);
  const nh = nodeHashStep(kvh, left, right, aggregate);
  return {
    finalHash: nh.output,
    summary: `KVDigest — boundary key + value_hash (no value bytes)${aggregateLabel(aggregate)}`,
    notes: [],
    steps: [kvHashStep(key, vh, kvh), nh],
  };
}

// ---------- shared helpers ----------

function kvHashStep(key: Uint8Array, valueHash: Hash32, output: Hash32): RecipeStep {
  return {
    name: "kv_hash",
    formula: "blake3(varint(key.len) || key || value_hash)",
    inputs: [
      { label: "varint(key.len)", bytes: varint(key.length), note: `len=${key.length}` },
      { label: "key", bytes: key },
      { label: "value_hash", bytes: valueHash },
    ],
    output,
  };
}

/**
 * Build the final node_hash step using whichever Merk hash variant the
 * aggregate calls for. One function for the four flavors keeps the per-variant
 * builders short and ensures the panel renders the same way everywhere.
 */
function nodeHashStep(
  kvHash: Hash32,
  left: Hash32,
  right: Hash32,
  aggregate: Aggregate,
  notes: { kvNote?: string; leftNote?: string; rightNote?: string } = {},
): RecipeStep {
  const baseInputs: RecipeInput[] = [
    { label: "kv_hash", bytes: kvHash, note: notes.kvNote },
    {
      label: "left_child_hash",
      bytes: left,
      note: notes.leftNote ?? (isNullHash(left) ? "(NULL — no left child)" : undefined),
    },
    {
      label: "right_child_hash",
      bytes: right,
      note: notes.rightNote ?? (isNullHash(right) ? "(NULL — no right child)" : undefined),
    },
  ];
  switch (aggregate.kind) {
    case "none":
      return {
        name: "node_hash",
        formula: "blake3(kv_hash || left_child_hash || right_child_hash)",
        inputs: baseInputs,
        output: nodeHash(kvHash, left, right),
      };
    case "count":
      return {
        name: "node_hash_with_count",
        formula: "blake3(kv_hash || left || right || count_be8)",
        inputs: [
          ...baseInputs,
          { label: "count (u64 BE)", bytes: u64BE(aggregate.count), note: `${aggregate.count}` },
        ],
        output: nodeHashWithCount(kvHash, left, right, aggregate.count),
      };
    case "sum":
      return {
        name: "node_hash_with_sum",
        formula: "blake3(kv_hash || left || right || sum_be8)",
        inputs: [
          ...baseInputs,
          { label: "sum (i64 BE)", bytes: i64BE(aggregate.sum), note: `${aggregate.sum}` },
        ],
        output: nodeHashWithSum(kvHash, left, right, aggregate.sum),
      };
    case "countSum":
      return {
        name: "node_hash_with_count_and_sum",
        formula: "blake3(kv_hash || left || right || count_be8 || sum_be8)",
        inputs: [
          ...baseInputs,
          { label: "count (u64 BE)", bytes: u64BE(aggregate.count), note: `${aggregate.count}` },
          { label: "sum (i64 BE)", bytes: i64BE(aggregate.sum), note: `${aggregate.sum}` },
        ],
        output: nodeHashWithCountAndSum(
          kvHash,
          left,
          right,
          aggregate.count,
          aggregate.sum,
        ),
      };
  }
}

function aggregateLabel(a: Aggregate): string {
  switch (a.kind) {
    case "none":
      return "";
    case "count":
      return ` (count=${a.count})`;
    case "sum":
      return ` (sum=${a.sum})`;
    case "countSum":
      return ` (count=${a.count}, sum=${a.sum})`;
  }
}

function aggregateNoteTail(a: Aggregate): string {
  switch (a.kind) {
    case "none":
      return "";
    case "count":
      return ", count";
    case "sum":
      return ", sum";
    case "countSum":
      return ", count, sum";
  }
}

function isNullHash(h: Hash32): boolean {
  for (const b of h) if (b !== 0) return false;
  return true;
}

function featureAggregate(ft: FeatureTypeView): Aggregate {
  switch (ft.kind) {
    case "provable_counted_merk_node":
      return { kind: "count", count: BigInt(ft.count) };
    case "provable_counted_summed_merk_node":
      // Provable count+sum tree (legacy variant) hashes count only, sum tracked but not hashed.
      return { kind: "count", count: BigInt(ft.count) };
    case "provable_summed_merk_node":
      return { kind: "sum", sum: BigInt(ft.sum) };
    case "provable_counted_and_provable_summed_merk_node":
      return { kind: "countSum", count: BigInt(ft.count), sum: BigInt(ft.sum) };
    default:
      return { kind: "none" };
  }
}

/**
 * Recover the key bytes from a `DisplayKey.hex` field. The IR always carries
 * the full hex, so this is just a hex decode — the ASCII `display` form is
 * just for showing labels.
 */
function asciiOrHexToBytes(keyHex: string): Uint8Array {
  return hexToBytes(keyHex);
}

/**
 * Best-effort recovery of the value bytes from an `ElementView`. We only need
 * this for variants where the proof carries the full value AND we need to
 * recompute its hash (KV, KVCount, KVSum, KVCountSum).
 *
 * For Tree-flavoured elements the IR doesn't carry the full bincode bytes;
 * those paths use a pre-computed value_hash from the proof and never call
 * this. For Item we have the raw hex.
 */
function elementValueBytes(e: ElementView): Uint8Array {
  switch (e.kind) {
    case "item":
      return hexToBytes(e.value);
    case "item_with_sum_item":
      return hexToBytes(e.value);
    default:
      // Caller shouldn't reach this for non-Item variants — return empty so
      // we still produce a (possibly-wrong) hash rather than throwing.
      return new Uint8Array(0);
  }
}

export { hex };
