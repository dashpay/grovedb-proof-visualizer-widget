// Render one LayerView as a `<details>` block with an SVG inside.

import type { LayerView } from "../types.js";
import { keyLabel } from "./format.js";
import { layoutMerkTree, type MerkLayout } from "./merk-tree.js";

export interface RenderedLayer {
  /** The DOM element to insert. */
  element: HTMLElement;
  /** Layer id (mirrors `LayerView.layer_id`). */
  layerId: number;
  /** Per-node anchor positions in the SVG, useful for cross-layer overlays. */
  anchors: Map<number, { x: number; y: number }>;
  /** SVG element so the parent overlay can compute absolute positions. */
  svgElement: SVGSVGElement;
}

export function renderLayer(layer: LayerView, totalLayers: number): RenderedLayer {
  const wrapper = document.createElement("details");
  wrapper.className = "gpv-layer";
  wrapper.open = true;
  wrapper.dataset.layerId = String(layer.layer_id);

  const summary = document.createElement("summary");
  summary.className = "gpv-layer-summary";
  summary.innerHTML = renderSummaryHtml(layer, totalLayers);
  wrapper.appendChild(summary);

  const body = document.createElement("div");
  body.className = "gpv-layer-body";
  wrapper.appendChild(body);

  let layout: MerkLayout | null = null;
  let svgElement: SVGSVGElement;

  if (layer.binary_tree) {
    layout = layoutMerkTree(layer.binary_tree);
    svgElement = makeSvg(layout.width, layout.height, layout.svg);
    body.appendChild(svgElement);
  } else if (layer.opaque_summary) {
    const blob = document.createElement("div");
    blob.className = "gpv-opaque";
    blob.textContent = `${layer.opaque_summary.backing} proof, ${layer.opaque_summary.byte_length} bytes`;
    body.appendChild(blob);
    svgElement = makeSvg(0, 0, "");
  } else {
    svgElement = makeSvg(0, 0, "");
  }

  // Descent footer: chips listing each lower layer keyed by parent-key.
  if (layer.descents.length > 0) {
    const desc = document.createElement("div");
    desc.className = "gpv-descent-list";
    desc.innerHTML = layer.descents
      .map(
        (d) =>
          `<span class="gpv-descent-chip" data-to-layer="${d.to_layer_id}">↓ <code>${escapeHtml(keyLabel(d.from_key))}</code> → Layer ${d.to_layer_id}</span>`,
      )
      .join("");
    body.appendChild(desc);
  }

  return {
    element: wrapper,
    layerId: layer.layer_id,
    anchors: layout?.anchors ?? new Map(),
    svgElement,
  };
}

function renderSummaryHtml(layer: LayerView, totalLayers: number): string {
  const descended =
    layer.descended_via != null
      ? `via <code>${escapeHtml(keyLabel(layer.descended_via))}</code>`
      : "(root layer)";
  const backing = layer.backing === "merk" ? "Merk" : layer.backing;
  const stats = layer.binary_tree
    ? `${layer.binary_tree.nodes.length} nodes${layer.descents.length ? `, ${layer.descents.length} descents` : ""}`
    : layer.opaque_summary
    ? `${layer.opaque_summary.byte_length} bytes (opaque)`
    : "(empty)";
  return `
    <span class="gpv-layer-id">Layer ${layer.layer_id} / ${totalLayers - 1}</span>
    <span class="gpv-layer-meta">${backing} — ${stats}</span>
    <span class="gpv-layer-descended">${descended}</span>
  `;
}

function makeSvg(w: number, h: number, inner: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("class", "gpv-svg");
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  // innerHTML is the simplest path for static SVG markup.
  svg.innerHTML = inner;
  return svg;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
