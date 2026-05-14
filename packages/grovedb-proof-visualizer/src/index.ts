// Public entry point.

import { buildDescentOverlay } from "./render/descent.js";
import { renderLayer, type RenderedLayer } from "./render/layer.js";
import {
  resolveProofView,
  sniffFormat,
  type InputAdapters,
  type ProofInput,
} from "./load.js";
import type { ProofView } from "./types.js";

export type { ProofView } from "./types.js";
export type { ProofInput, InputAdapters } from "./load.js";
export { sniffFormat };

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

  const rendered: RenderedLayer[] = [];
  for (const layer of view.layers) {
    const r = renderLayer(layer, view.layers.length);
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
