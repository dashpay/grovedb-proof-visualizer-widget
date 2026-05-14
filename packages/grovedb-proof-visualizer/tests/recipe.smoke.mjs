// Smoke test: the recipe blake3 chain matches the Merk verifier.
//
// Strategy: pick a deterministic Element + Node combination, build the Rust
// ground truth via `cargo run -p grovedb-proof-view --example synth_fixture`,
// then compare the computed node_hash for matching nodes.
//
// For now this just exercises every recipe builder against the Query 1
// synthetic fixture and asserts (a) no crashes and (b) every produced
// node_hash is 32 bytes. The visual verification on real proofs is the
// real proof-of-correctness; this catches regressions in the IR-to-recipe
// wiring.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  HERE,
  "..",
  "..",
  "..",
  "examples",
  "fixtures",
  "query1_count.json",
);

const view = JSON.parse(readFileSync(FIXTURE, "utf-8"));
const { computeAllNodeHashes, recipeFor } = await import("../dist/index.js");

let passed = 0;
let failed = 0;

for (const layer of view.layers) {
  if (!layer.binary_tree) continue;
  const hashes = computeAllNodeHashes(layer.binary_tree);
  if (hashes.length !== layer.binary_tree.nodes.length) {
    console.error(
      `layer ${layer.layer_id}: expected ${layer.binary_tree.nodes.length} hashes, got ${hashes.length}`,
    );
    failed++;
    continue;
  }
  for (const node of layer.binary_tree.nodes) {
    const h = hashes[node.id];
    if (h.length !== 32) {
      console.error(
        `layer ${layer.layer_id} node ${node.id} (${node.view.kind}): hash length ${h.length} ≠ 32`,
      );
      failed++;
    } else {
      passed++;
    }
    // Smoke-test: recipe produces same finalHash as computeAllNodeHashes.
    const left =
      node.left != null
        ? hashes[node.left]
        : new Uint8Array(32);
    const right =
      node.right != null
        ? hashes[node.right]
        : new Uint8Array(32);
    const recipe = recipeFor(node, left, right);
    const a = Buffer.from(recipe.finalHash).toString("hex");
    const b = Buffer.from(h).toString("hex");
    if (a !== b) {
      console.error(
        `layer ${layer.layer_id} node ${node.id}: recipe hash ${a} != batch hash ${b}`,
      );
      failed++;
    }
  }
}

console.log(`recipe.smoke: ${passed} hashes, ${failed} failures`);
process.exit(failed > 0 ? 1 : 0);
