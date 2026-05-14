// Right-side slide-in panel: shows the hash recipe for one Merk-tree node.
//
// Single panel instance per host root. Mounted at the host root so it overlays
// fullscreen layers correctly. Click another node to swap content; click X /
// outside / press Esc to close.

import type { LayerView, MerkBinaryNode } from "../types.js";
import { hex } from "./hashing.js";
import type { Recipe, RecipeInput, RecipeStep } from "./recipe.js";

export interface DetailPanel {
  show: (ctx: PanelContext) => void;
  hide: () => void;
  isOpen: () => boolean;
}

export interface PanelContext {
  layer: LayerView;
  node: MerkBinaryNode;
  recipe: Recipe;
  /** Where this node's computed hash appears in the parent's recipe, if any. */
  parentMatch?: { parentNodeId: number; side: "left" | "right" };
}

export function createDetailPanel(host: HTMLElement): DetailPanel {
  const panel = document.createElement("aside");
  panel.className = "gpv-detail-panel";
  panel.setAttribute("role", "complementary");
  panel.setAttribute("aria-label", "Node hash details");
  panel.hidden = true;
  host.appendChild(panel);

  let open = false;

  const hide = () => {
    if (!open) return;
    open = false;
    panel.classList.remove("gpv-detail-panel--open");
    host.classList.remove("gpv-has-detail");
    // delay hidden=true until after the slide-out animation
    setTimeout(() => {
      if (!open) panel.hidden = true;
    }, 220);
  };

  const show = (ctx: PanelContext) => {
    panel.hidden = false;
    panel.innerHTML = renderPanel(ctx);
    // wire close button
    panel
      .querySelector(".gpv-detail-close")
      ?.addEventListener("click", hide);
    // wire copy buttons
    panel.querySelectorAll<HTMLElement>("[data-copy]").forEach((el) => {
      el.addEventListener("click", () => {
        const text = el.dataset.copy ?? "";
        navigator.clipboard?.writeText(text).catch(() => {});
        el.classList.add("gpv-copied");
        setTimeout(() => el.classList.remove("gpv-copied"), 800);
      });
    });
    // force a reflow so the open animation runs even on first show
    void panel.offsetWidth;
    panel.classList.add("gpv-detail-panel--open");
    host.classList.add("gpv-has-detail");
    open = true;
  };

  // Esc closes
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) hide();
  });

  return { show, hide, isOpen: () => open };
}

function renderPanel(ctx: PanelContext): string {
  const { layer, node, recipe, parentMatch } = ctx;
  const nodeKindLabel = node.view.kind;
  const keyLabel = "key" in node.view ? `<code>${escapeHtml(node.view.key.display)}</code>` : "—";

  const parentMatchHtml = parentMatch
    ? `<div class="gpv-detail-section">
         <div class="gpv-detail-section-title">Where this hash is referenced</div>
         <div class="gpv-detail-callout">
           Used as the <b>${parentMatch.side}_child_hash</b> input to node
           <code>#${parentMatch.parentNodeId}</code> in this same layer.
         </div>
       </div>`
    : "";

  const stepsHtml =
    recipe.steps.length > 0
      ? recipe.steps.map(renderStep).join("")
      : `<div class="gpv-detail-callout">
           This node carries only an opaque hash; no derivation steps to show.
         </div>`;

  const notesHtml = recipe.notes.length
    ? recipe.notes.map((n) => `<div class="gpv-detail-note">${escapeHtml(n)}</div>`).join("")
    : "";

  return `
    <header class="gpv-detail-header">
      <div>
        <div class="gpv-detail-eyebrow">Layer ${layer.layer_id} · node #${node.id}</div>
        <div class="gpv-detail-title">${escapeHtml(nodeKindLabel)} · ${keyLabel}</div>
        <div class="gpv-detail-summary">${escapeHtml(recipe.summary)}</div>
      </div>
      <button class="gpv-detail-close" aria-label="Close" title="Close (Esc)">×</button>
    </header>

    ${notesHtml}

    <div class="gpv-detail-section">
      <div class="gpv-detail-section-title">Final hash</div>
      ${renderHashRow("node_hash" + (recipe.steps.length ? "" : " (opaque)"), recipe.finalHash)}
    </div>

    ${parentMatchHtml}

    ${
      recipe.steps.length
        ? `<div class="gpv-detail-section">
            <div class="gpv-detail-section-title">Computation</div>
            ${stepsHtml}
          </div>`
        : ""
    }
  `;
}

function renderStep(step: RecipeStep, idx: number): string {
  const inputBytesTotal = step.inputs.reduce((s, i) => s + i.bytes.length, 0);
  return `
    <div class="gpv-detail-step">
      <div class="gpv-detail-step-head">
        <span class="gpv-detail-step-name">${idx + 1}. ${escapeHtml(step.name)}</span>
        <span class="gpv-detail-step-bytes">${inputBytesTotal} B in</span>
      </div>
      <div class="gpv-detail-formula"><code>${escapeHtml(step.formula)}</code></div>
      <div class="gpv-detail-inputs">
        ${step.inputs.map(renderInput).join("")}
      </div>
      <div class="gpv-detail-arrow">↓ blake3</div>
      ${renderHashRow("output", step.output)}
    </div>
  `;
}

function renderInput(input: RecipeInput): string {
  const bytesHex = hex(input.bytes);
  return `
    <div class="gpv-detail-input">
      <div class="gpv-detail-input-head">
        <span class="gpv-detail-input-label">${escapeHtml(input.label)}</span>
        <span class="gpv-detail-input-meta">${input.bytes.length} B${
          input.note ? ` · ${escapeHtml(input.note)}` : ""
        }</span>
        <button class="gpv-copy" data-copy="${escapeAttr(bytesHex)}" title="copy hex">copy</button>
      </div>
      <div class="gpv-detail-bytes" title="${escapeAttr(bytesHex)}">${escapeHtml(bytesHex || "(empty)")}</div>
    </div>
  `;
}

function renderHashRow(label: string, h: Uint8Array): string {
  const hexStr = hex(h);
  return `
    <div class="gpv-detail-hash">
      <span class="gpv-detail-hash-label">${escapeHtml(label)}</span>
      <button class="gpv-copy" data-copy="${escapeAttr(hexStr)}" title="copy hex">copy</button>
      <code class="gpv-detail-hash-value">${escapeHtml(hexStr)}</code>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
