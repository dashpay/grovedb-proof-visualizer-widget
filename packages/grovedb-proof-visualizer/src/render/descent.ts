// Cross-layer descent overlay.
//
// After all layers are mounted, we draw a single absolute-positioned SVG that
// spans the entire widget and connects each layer's descent source-node to the
// next layer's container. The overlay is recomputed on `<details>` toggle and
// on resize via a ResizeObserver.

import type { ProofView } from "../types.js";
import type { RenderedLayer } from "./layer.js";

export interface DescentOverlay {
  element: SVGSVGElement;
  recompute: () => void;
}

export function buildDescentOverlay(
  view: ProofView,
  rendered: RenderedLayer[],
  rootElement: HTMLElement,
): DescentOverlay {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("gpv-overlay");

  const layerById = new Map<number, RenderedLayer>();
  for (const r of rendered) layerById.set(r.layerId, r);

  const recompute = () => {
    const root = rootElement.getBoundingClientRect();
    svg.setAttribute("width", String(root.width));
    svg.setAttribute("height", String(root.height));
    svg.setAttribute("viewBox", `0 0 ${root.width} ${root.height}`);
    const paths: string[] = [];

    for (const layer of view.layers) {
      const fromRender = layerById.get(layer.layer_id);
      if (!fromRender) continue;
      for (const descent of layer.descents) {
        const toRender = layerById.get(descent.to_layer_id);
        if (!toRender) continue;

        // Source point: anchor of from_node (if known) within fromRender's SVG.
        const fromBox = fromRender.svgElement.getBoundingClientRect();
        const fromAnchor =
          descent.from_node_id != null
            ? fromRender.anchors.get(descent.from_node_id)
            : undefined;
        const sx = fromAnchor
          ? fromBox.left - root.left + fromAnchor.x
          : fromBox.left - root.left + fromBox.width / 2;
        const sy = fromAnchor
          ? fromBox.top - root.top + fromAnchor.y
          : fromBox.top - root.top + fromBox.height;

        // Target point: top-center of the destination layer's <details>.
        const toBox = toRender.element.getBoundingClientRect();
        const tx = toBox.left - root.left + toBox.width / 2;
        const ty = toBox.top - root.top;

        const cy = (sy + ty) / 2;
        paths.push(
          `<path d="M ${sx} ${sy} C ${sx} ${cy}, ${tx} ${cy}, ${tx} ${ty}" class="gpv-descent" fill="none" />`,
        );
        // Label half-way down.
        const mx = (sx + tx) / 2;
        const my = cy;
        paths.push(
          `<text x="${mx}" y="${my}" class="gpv-descent-label" text-anchor="middle">${escapeXml(descent.from_key.display)}</text>`,
        );
      }
    }
    svg.innerHTML = paths.join("");
  };

  return { element: svg, recompute };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
