// Public entry point.

import { buildDescentOverlay } from "./render/descent.js";
import { createDetailPanel } from "./render/detail-panel.js";
import { NULL_HASH } from "./render/hashing.js";
import { renderLayer, type RenderedLayer } from "./render/layer.js";
import { computeAllNodeHashes, recipeFor } from "./render/recipe.js";
import {
  resolveProofView,
  sniffFormat,
  type InputAdapters,
  type ProofInput,
} from "./load.js";
import type { LayerView, MerkBinaryNode, ProofView } from "./types.js";

export type { ProofView } from "./types.js";
export type { ProofInput, InputAdapters } from "./load.js";
export { sniffFormat };

// Re-export hashing primitives + recipe builders so callers can verify a
// proof's hash chain or render the same node detail in their own UI.
export {
  combineHash,
  hex,
  hexToBytes,
  kvHashFromValue,
  kvHashFromValueHash,
  NULL_HASH,
  nodeHash,
  nodeHashWithCount,
  valueHash,
  varint,
} from "./render/hashing.js";
export type { Hash32 } from "./render/hashing.js";
export { computeAllNodeHashes, recipeFor } from "./render/recipe.js";
export type { Recipe, RecipeStep, RecipeInput } from "./render/recipe.js";

export interface RenderOptions {
  /** Optional theme override (`"navy" | "light" | "auto"`). Defaults to `"auto"`. */
  theme?: "navy" | "light" | "auto";
  /** Bytes / text adapters. Required for those input formats. */
  adapters?: InputAdapters;
  /** When true, layers start collapsed. */
  collapsed?: boolean;
}

/**
 * Render a proof into a host element.
 *
 * @returns a handle exposing `update(view)` and `destroy()`.
 */
export async function renderProof(
  host: HTMLElement,
  input: ProofInput,
  options: RenderOptions = {},
) {
  const view = await resolveProofView(input, options.adapters);
  return mountView(host, view, options);
}

/** Lower-level entry point — render an already-resolved `ProofView`. */
export function renderProofView(
  host: HTMLElement,
  view: ProofView,
  options: RenderOptions = {},
) {
  return mountView(host, view, options);
}

function mountView(
  host: HTMLElement,
  view: ProofView,
  options: RenderOptions,
) {
  host.classList.add("gpv-root");
  if (options.theme && options.theme !== "auto") {
    host.dataset.gpvTheme = options.theme;
  }
  host.innerHTML = "";

  const layersWrap = document.createElement("div");
  layersWrap.className = "gpv-layers";
  host.appendChild(layersWrap);

  // Pre-compute every node's hash for every Merk-layer so the detail panel
  // can show the full recipe instantly (and so we can locate where each
  // node's hash gets reused as a parent's left/right input).
  const layerNodeHashes = new Map<number, Uint8Array[]>();
  for (const layer of view.layers) {
    if (layer.binary_tree) {
      layerNodeHashes.set(layer.layer_id, computeAllNodeHashes(layer.binary_tree));
    }
  }

  const detail = createDetailPanel(host);

  const onNodeClick = (layer: LayerView, node: MerkBinaryNode) => {
    const hashes = layerNodeHashes.get(layer.layer_id) ?? [];
    const left = node.left != null ? hashes[node.left] : NULL_HASH;
    const right = node.right != null ? hashes[node.right] : NULL_HASH;
    const recipe = recipeFor(node, left, right);
    const parentMatch = findParentMatch(layer, node, hashes);
    detail.show({ layer, node, recipe, parentMatch });
  };

  const rendered: RenderedLayer[] = [];
  for (const layer of view.layers) {
    const r = renderLayer(layer, view.layers.length, { onNodeClick });
    if (options.collapsed) (r.element as HTMLDetailsElement).open = false;
    layersWrap.appendChild(r.element);
    rendered.push(r);
  }

  const overlay = buildDescentOverlay(view, rendered, host);
  host.appendChild(overlay.element);

  // recompute on each <details> toggle and on host resize.
  const onToggle = () => {
    // browsers don't bubble the `toggle` event, so we attach per-details.
    overlay.recompute();
  };
  for (const r of rendered) {
    (r.element as HTMLDetailsElement).addEventListener("toggle", onToggle);
  }
  const ro = new ResizeObserver(() => overlay.recompute());
  ro.observe(host);
  // first paint
  requestAnimationFrame(() => overlay.recompute());

  return {
    update: (next: ProofView) => mountView(host, next, options),
    destroy: () => {
      ro.disconnect();
      host.innerHTML = "";
      host.classList.remove("gpv-root");
    },
  };
}

/**
 * If the clicked node's computed hash appears as a child of another node in
 * the same layer, return where. Useful so the panel can say "this hash is the
 * left input to node #N".
 */
function findParentMatch(
  layer: LayerView,
  node: MerkBinaryNode,
  hashes: Uint8Array[],
): { parentNodeId: number; side: "left" | "right" } | undefined {
  if (!layer.binary_tree) return undefined;
  for (const candidate of layer.binary_tree.nodes) {
    if (candidate.left === node.id) return { parentNodeId: candidate.id, side: "left" };
    if (candidate.right === node.id) return { parentNodeId: candidate.id, side: "right" };
  }
  // Mark the unused param explicit so future maintainers see we considered it.
  void hashes;
  return undefined;
}
