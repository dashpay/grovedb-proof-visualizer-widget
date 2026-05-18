// Public entry point.

import { buildDescentOverlay } from "./render/descent.js";
import { createDetailPanel, type PanelContext } from "./render/detail-panel.js";
import { NULL_HASH } from "./render/hashing.js";
import {
  refreshLayerKeyLabels,
  renderLayer,
  type RenderedLayer,
} from "./render/layer.js";
import {
  formatKeyDisplay,
  hexToBytesLocal,
  KeyOverrides,
} from "./render/key-format.js";
import { openKeyFormatMenu } from "./render/key-format-menu.js";
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

  // Owned by this mount: keeps track of every per-node / per-layer / global
  // key-format override the user has applied. Each `renderLayer` looks
  // through `resolveKeyDisplay` so the SVG and detail panel always reflect
  // the latest choice.
  const overrides = new KeyOverrides();

  /** Look up the display string for a node's key, applying any overrides.
   *  Returns undefined when the format equals `auto` so the renderer can
   *  fall back to the IR's pre-computed `key.display`. */
  const resolveKeyDisplayFor =
    (layer: LayerView) =>
    (nodeId: number): string | undefined => {
      const tree = layer.binary_tree;
      if (!tree) return undefined;
      const node = tree.nodes[nodeId];
      if (!node) return undefined;
      const view = node.view;
      const keyHex = "key" in view ? view.key.hex : null;
      if (!keyHex) return undefined;
      const format = overrides.resolve(layer.layer_id, nodeId);
      if (format.kind === "auto") return undefined; // keep IR-supplied display
      return formatKeyDisplay(hexToBytesLocal(keyHex), format).display;
    };

  let currentPanelContext: PanelContext | null = null;
  const detail = createDetailPanel(host, {
    onKeyFormatPick: (ctx, format, scope) => {
      overrides.set(scope, ctx.layer.layer_id, ctx.node.id, format);
      refreshAllKeyLabels();
      // re-show the panel so its own key display updates too
      detail.show(buildPanelContext(ctx.layer, ctx.node));
    },
    getKeyFormat: (ctx) => overrides.resolve(ctx.layer.layer_id, ctx.node.id),
    getKeyBytes: (ctx) =>
      "key" in ctx.node.view ? hexToBytesLocal(ctx.node.view.key.hex) : null,
  });

  const buildPanelContext = (layer: LayerView, node: MerkBinaryNode): PanelContext => {
    const hashes = layerNodeHashes.get(layer.layer_id) ?? [];
    const left = node.left != null ? hashes[node.left] : NULL_HASH;
    const right = node.right != null ? hashes[node.right] : NULL_HASH;
    const recipe = recipeFor(node, left, right);
    const parentMatch = findParentMatch(layer, node, hashes);
    const ctx: PanelContext = { layer, node, recipe, parentMatch };
    currentPanelContext = ctx;
    return ctx;
  };

  const onNodeClick = (layer: LayerView, node: MerkBinaryNode) => {
    detail.show(buildPanelContext(layer, node));
  };

  const onNodeContextMenu = (
    layer: LayerView,
    node: MerkBinaryNode,
    event: MouseEvent,
  ) => {
    const hasKey = "key" in node.view;
    openKeyFormatMenu({
      x: event.clientX,
      y: event.clientY,
      currentFormat: overrides.resolve(layer.layer_id, node.id),
      hasKey,
      onPick: (format, scope) => {
        overrides.set(scope, layer.layer_id, node.id, format);
        refreshAllKeyLabels();
        if (currentPanelContext && currentPanelContext.layer === layer && currentPanelContext.node === node) {
          detail.show(buildPanelContext(layer, node));
        }
      },
    });
  };

  const rendered: RenderedLayer[] = [];
  for (const layer of view.layers) {
    const r = renderLayer(layer, view.layers.length, {
      onNodeClick,
      onNodeContextMenu,
      resolveKeyDisplay: resolveKeyDisplayFor(layer),
    });
    if (options.collapsed) (r.element as HTMLDetailsElement).open = false;
    layersWrap.appendChild(r.element);
    rendered.push(r);
  }

  const refreshAllKeyLabels = () => {
    for (const r of rendered) {
      const layer = view.layers[r.layerId];
      refreshLayerKeyLabels(r, layer, resolveKeyDisplayFor(layer));
    }
  };

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
