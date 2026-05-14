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
  kvHashFromValueHash,
  NULL_HASH,
  nodeHash,
  nodeHashWithCount,
  varint,
  valueHash,
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
    case "hash_with_count":
      return hashWithCountRecipe(v.kv_hash, v.left_child_hash, v.right_child_hash, v.count);
    case "kv_hash":
      return kvHashRecipe(v.kv_hash, left, right);
    case "kv":
      return kvRecipe(asciiOrHexToBytes(v.key.hex), elementValueBytes(v.value), left, right);
    case "kv_value_hash":
      return kvValueHashRecipe(
        asciiOrHexToBytes(v.key.hex),
        v.value,
        v.value_hash,
        left,
        right,
      );
    case "kv_value_hash_feature_type":
    case "kv_value_hash_feature_type_with_child_hash": {
      const childHash = v.kind === "kv_value_hash_feature_type_with_child_hash"
        ? hexToBytes(v.child_hash)
        : null;
      return kvValueHashFeatureRecipe(
        asciiOrHexToBytes(v.key.hex),
        v.value,
        v.value_hash,
        v.feature_type,
        childHash,
        left,
        right,
      );
    }
    case "kv_ref_value_hash":
      return kvRefValueHashRecipe(
        asciiOrHexToBytes(v.key.hex),
        elementValueBytes(v.value),
        v.value_hash,
        left,
        right,
        false,
        0n,
      );
    case "kv_ref_value_hash_count":
      return kvRefValueHashRecipe(
        asciiOrHexToBytes(v.key.hex),
        elementValueBytes(v.value),
        v.value_hash,
        left,
        right,
        true,
        BigInt(v.count),
      );
    case "kv_count":
      return kvCountRecipe(
        asciiOrHexToBytes(v.key.hex),
        elementValueBytes(v.value),
        BigInt(v.count),
        left,
        right,
      );
    case "kv_hash_count":
      return kvHashCountRecipe(v.kv_hash, BigInt(v.count), left, right);
    case "kv_digest":
      return kvDigestRecipe(asciiOrHexToBytes(v.key.hex), v.value_hash, left, right);
    case "kv_digest_count":
      return kvDigestCountRecipe(
        asciiOrHexToBytes(v.key.hex),
        v.value_hash,
        BigInt(v.count),
        left,
        right,
      );
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

function hashWithCountRecipe(
  kvHashHex: string,
  leftHashHex: string,
  rightHashHex: string,
  count: number,
): Recipe {
  const kvHash = hexToBytes(kvHashHex);
  const leftHash = hexToBytes(leftHashHex);
  const rightHash = hexToBytes(rightHashHex);
  const out = nodeHashWithCount(kvHash, leftHash, rightHash, BigInt(count));
  return {
    finalHash: out,
    summary: `Compressed in-range subtree (count=${count})`,
    notes: [
      "AggregateCountOnRange collapses an entire fully-inside subtree into one node by committing its (kv_hash, left, right, count). The verifier recomputes node_hash_with_count from those four fields — a forged count would change the result.",
    ],
    steps: [
      {
        name: "node_hash",
        formula: "blake3(kv_hash || left_child_hash || right_child_hash || count_be8)",
        inputs: [
          { label: "kv_hash", bytes: kvHash, note: "stored kv_hash for the subtree's root" },
          { label: "left_child_hash", bytes: leftHash, note: "subtree root's left child" },
          { label: "right_child_hash", bytes: rightHash, note: "subtree root's right child" },
          { label: "count (u64 BE)", bytes: u64BeBytes(count), note: `${count}` },
        ],
        output: out,
      },
    ],
  };
}

function kvHashRecipe(kvHashHex: string, left: Hash32, right: Hash32): Recipe {
  const kvHash = hexToBytes(kvHashHex);
  const out = nodeHash(kvHash, left, right);
  return {
    finalHash: out,
    summary: "Internal node — only its kv_hash is revealed",
    notes: [],
    steps: [nodeHashStep(kvHash, left, right, out)],
  };
}

function kvRecipe(key: Uint8Array, value: Uint8Array, left: Hash32, right: Hash32): Recipe {
  const vh = valueHash(value);
  const kvh = kvHashFromValueHash(key, vh);
  const out = nodeHash(kvh, left, right);
  return {
    finalHash: out,
    summary: "KV node — full key + value in proof",
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
      nodeHashStep(kvh, left, right, out),
    ],
  };
}

function kvValueHashRecipe(
  key: Uint8Array,
  value: ElementView,
  valueHashHex: string,
  left: Hash32,
  right: Hash32,
): Recipe {
  const vh = hexToBytes(valueHashHex);
  const kvh = kvHashFromValueHash(key, vh);
  const out = nodeHash(kvh, left, right);
  return {
    finalHash: out,
    summary: `Queried node — key, value (${value.kind}) and its value_hash`,
    notes: [
      "The proof gives value_hash directly; for Tree-valued elements it is `combine_hash(H(value), child_hash)` so we don't recompute it from the value bytes.",
    ],
    steps: [kvHashStep(key, vh, kvh), nodeHashStep(kvh, left, right, out)],
  };
}

function kvValueHashFeatureRecipe(
  key: Uint8Array,
  value: ElementView,
  valueHashHex: string,
  ft: FeatureTypeView,
  childHash: Hash32 | null,
  left: Hash32,
  right: Hash32,
): Recipe {
  const vh = hexToBytes(valueHashHex);
  const kvh = kvHashFromValueHash(key, vh);
  // feature_type may make this a "_with_count" node hash
  let out: Hash32;
  let nodeStep: RecipeStep;
  const count = featureCount(ft);
  if (count != null) {
    out = nodeHashWithCount(kvh, left, right, count);
    nodeStep = {
      name: "node_hash_with_count",
      formula: "blake3(kv_hash || left || right || count_be8)",
      inputs: [
        { label: "kv_hash", bytes: kvh },
        { label: "left", bytes: left },
        { label: "right", bytes: right },
        { label: "count (u64 BE)", bytes: u64BeBytes(count), note: `feature_type ${ft.kind}` },
      ],
      output: out,
    };
  } else {
    out = nodeHash(kvh, left, right);
    nodeStep = nodeHashStep(kvh, left, right, out);
  }
  const notes: string[] = [];
  if (childHash) {
    notes.push(
      "child_hash is GroveDB-level metadata (the merk root of the omitted lower layer). It does NOT participate in this Merk node hash; it appears here so the verifier can check the embedded subtree without expanding it.",
    );
  }
  return {
    finalHash: out,
    summary: `Queried node — key, value (${value.kind}), value_hash, feature_type=${ft.kind}${childHash ? ", + child_hash" : ""}`,
    notes,
    steps: [kvHashStep(key, vh, kvh), nodeStep],
  };
}

function kvRefValueHashRecipe(
  key: Uint8Array,
  referencedValue: Uint8Array,
  nodeValueHashHex: string,
  left: Hash32,
  right: Hash32,
  withCount: boolean,
  count: bigint,
): Recipe {
  const nodeValueHash = hexToBytes(nodeValueHashHex);
  const refValueHash = valueHash(referencedValue);
  const combined = combineHash(nodeValueHash, refValueHash);
  const kvh = kvHashFromValueHash(key, combined);
  const out = withCount
    ? nodeHashWithCount(kvh, left, right, count)
    : nodeHash(kvh, left, right);
  return {
    finalHash: out,
    summary: withCount
      ? `Reference (counted) — combines node_value_hash with referenced_value_hash`
      : `Reference — combines node_value_hash with referenced_value_hash`,
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
      withCount
        ? {
            name: "node_hash_with_count",
            formula: "blake3(kv_hash || left || right || count_be8)",
            inputs: [
              { label: "kv_hash", bytes: kvh },
              { label: "left", bytes: left },
              { label: "right", bytes: right },
              { label: "count (u64 BE)", bytes: u64BeBytes(count), note: `${count}` },
            ],
            output: out,
          }
        : nodeHashStep(kvh, left, right, out),
    ],
  };
}

function kvCountRecipe(
  key: Uint8Array,
  value: Uint8Array,
  count: bigint,
  left: Hash32,
  right: Hash32,
): Recipe {
  const vh = valueHash(value);
  const kvh = kvHashFromValueHash(key, vh);
  const out = nodeHashWithCount(kvh, left, right, count);
  return {
    finalHash: out,
    summary: `KVCount — full key + value in a ProvableCountTree (count=${count})`,
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
      {
        name: "node_hash_with_count",
        formula: "blake3(kv_hash || left || right || count_be8)",
        inputs: [
          { label: "kv_hash", bytes: kvh },
          { label: "left", bytes: left },
          { label: "right", bytes: right },
          { label: "count (u64 BE)", bytes: u64BeBytes(count), note: `${count}` },
        ],
        output: out,
      },
    ],
  };
}

function kvHashCountRecipe(
  kvHashHex: string,
  count: bigint,
  left: Hash32,
  right: Hash32,
): Recipe {
  const kvh = hexToBytes(kvHashHex);
  const out = nodeHashWithCount(kvh, left, right, count);
  return {
    finalHash: out,
    summary: `KVHashCount — internal ProvableCountTree node (count=${count})`,
    notes: [],
    steps: [
      {
        name: "node_hash_with_count",
        formula: "blake3(kv_hash || left || right || count_be8)",
        inputs: [
          { label: "kv_hash", bytes: kvh },
          { label: "left", bytes: left },
          { label: "right", bytes: right },
          { label: "count (u64 BE)", bytes: u64BeBytes(count), note: `${count}` },
        ],
        output: out,
      },
    ],
  };
}

function kvDigestRecipe(
  key: Uint8Array,
  valueHashHex: string,
  left: Hash32,
  right: Hash32,
): Recipe {
  const vh = hexToBytes(valueHashHex);
  const kvh = kvHashFromValueHash(key, vh);
  const out = nodeHash(kvh, left, right);
  return {
    finalHash: out,
    summary: "KVDigest — boundary key + value_hash (no value bytes)",
    notes: [],
    steps: [kvHashStep(key, vh, kvh), nodeHashStep(kvh, left, right, out)],
  };
}

function kvDigestCountRecipe(
  key: Uint8Array,
  valueHashHex: string,
  count: bigint,
  left: Hash32,
  right: Hash32,
): Recipe {
  const vh = hexToBytes(valueHashHex);
  const kvh = kvHashFromValueHash(key, vh);
  const out = nodeHashWithCount(kvh, left, right, count);
  return {
    finalHash: out,
    summary: `KVDigestCount — boundary key + value_hash + aggregate count=${count}`,
    notes: [],
    steps: [
      kvHashStep(key, vh, kvh),
      {
        name: "node_hash_with_count",
        formula: "blake3(kv_hash || left || right || count_be8)",
        inputs: [
          { label: "kv_hash", bytes: kvh },
          { label: "left", bytes: left },
          { label: "right", bytes: right },
          { label: "count (u64 BE)", bytes: u64BeBytes(count), note: `${count}` },
        ],
        output: out,
      },
    ],
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

function nodeHashStep(kvHash: Hash32, left: Hash32, right: Hash32, output: Hash32): RecipeStep {
  return {
    name: "node_hash",
    formula: "blake3(kv_hash || left_child_hash || right_child_hash)",
    inputs: [
      { label: "kv_hash", bytes: kvHash },
      { label: "left_child_hash", bytes: left, note: isNullHash(left) ? "(NULL — no left child)" : undefined },
      { label: "right_child_hash", bytes: right, note: isNullHash(right) ? "(NULL — no right child)" : undefined },
    ],
    output,
  };
}

function isNullHash(h: Hash32): boolean {
  for (const b of h) if (b !== 0) return false;
  return true;
}

function featureCount(ft: FeatureTypeView): bigint | null {
  switch (ft.kind) {
    case "provable_counted_merk_node":
    case "provable_counted_summed_merk_node":
      return BigInt(ft.count);
    default:
      return null;
  }
}

function u64BeBytes(n: number | bigint): Uint8Array {
  const v = typeof n === "bigint" ? n : BigInt(n);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, false);
  return out;
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
 * this for `KV(key, value)` and `KVCount(key, value, count)` — the variants
 * where the proof carries the full value AND we need to recompute its hash.
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
