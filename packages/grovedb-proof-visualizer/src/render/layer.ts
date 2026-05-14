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

  // Expand-to-fullscreen button. Lives in the summary so its always visible.
  // Clicking it must not toggle the <details>, so we stopPropagation.
  const expandBtn = document.createElement("button");
  expandBtn.type = "button";
  expandBtn.className = "gpv-expand-btn";
  expandBtn.title = "Fullscreen this layer (Esc to exit)";
  expandBtn.setAttribute("aria-label", "Fullscreen this layer");
  expandBtn.innerHTML = expandIconSvg();
  expandBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleFullscreen(wrapper);
  });
  summary.appendChild(expandBtn);

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

/** Outward-pointing corner arrows. */
function expandIconSvg(): string {
  return `<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
    <path d="M2 6V2h4v1.5H3.5V6H2zm12-4v4h-1.5V3.5H10V2h4zM2 10h1.5v2.5H6V14H2v-4zm12 0v4h-4v-1.5h2.5V10H14z"/>
  </svg>`;
}

/** Inward-pointing corner arrows. */
function collapseIconSvg(): string {
  return `<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
    <path d="M5.5 2v2.5H3V6h4V2H5.5zm5 0v4h4V4.5H12V2h-1.5zM3 10v1.5h2.5V14H7v-4H3zm9.5 0V10H10v4h1.5v-2.5H14V10h-1.5z"/>
  </svg>`;
}

/**
 * Toggle fullscreen on a layer. The layer becomes position:fixed and fills
 * the viewport; other layers are hidden via a class on the host root so the
 * descent overlay also disappears (it would otherwise project onto thin air).
 *
 * SVG inside fullscreen renders at natural pixel size with body overflow:auto
 * — that's the whole point of the expand: the default `max-width: 100%` on
 * the SVG was scaling 19-node trees down so far the labels became unreadable.
 */
function toggleFullscreen(wrapper: HTMLElement) {
  const isFullscreen = wrapper.classList.toggle("gpv-layer--fullscreen");
  const root = wrapper.closest(".gpv-root") as HTMLElement | null;
  if (root) root.classList.toggle("gpv-has-fullscreen", isFullscreen);

  // swap the icon
  const btn = wrapper.querySelector(".gpv-expand-btn");
  if (btn) {
    btn.innerHTML = isFullscreen ? collapseIconSvg() : expandIconSvg();
    (btn as HTMLElement).title = isFullscreen
      ? "Exit fullscreen (Esc)"
      : "Fullscreen this layer (Esc to exit)";
  }

  if (isFullscreen) {
    // ensure the layer is open even if the user collapsed it before expanding
    (wrapper as HTMLDetailsElement).open = true;
    installEscHandler();
  } else {
    uninstallEscHandlerIfNoneOpen();
  }
}

let escHandler: ((e: KeyboardEvent) => void) | null = null;

function installEscHandler() {
  if (escHandler) return;
  escHandler = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    const open = document.querySelector(".gpv-layer--fullscreen") as HTMLElement | null;
    if (open) {
      e.preventDefault();
      toggleFullscreen(open);
    }
  };
  document.addEventListener("keydown", escHandler);
}

function uninstallEscHandlerIfNoneOpen() {
  if (document.querySelector(".gpv-layer--fullscreen")) return;
  if (escHandler) {
    document.removeEventListener("keydown", escHandler);
    escHandler = null;
  }
}
