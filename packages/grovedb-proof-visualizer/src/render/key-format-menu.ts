// Right-click context menu for picking a key-interpretation format and
// applying it to a chosen scope. Mounted at document.body so it isn't clipped
// by ancestor `overflow: hidden`.
//
// One instance is created lazily on first use; subsequent right-clicks reuse
// it. Closes on Escape, on click outside, and on scroll.

import {
  KEY_FORMAT_GROUPS,
  KeyFormat,
  KeyFormatScope,
  keyFormatEquals,
  keyFormatId,
  keyFormatLabel,
} from "./key-format.js";

export interface KeyFormatMenuRequest {
  /** Where to anchor the menu (clientX/clientY from the contextmenu event). */
  x: number;
  y: number;
  /** Currently-applied format for this node, used to highlight the active option. */
  currentFormat: KeyFormat;
  /** Whether the clicked node has a key at all — disables the "this node" scope when not. */
  hasKey: boolean;
  /** Called when the user picks a (format, scope) combination. */
  onPick: (format: KeyFormat, scope: KeyFormatScope) => void;
}

let menuEl: HTMLDivElement | null = null;
let dismiss: (() => void) | null = null;

export function openKeyFormatMenu(req: KeyFormatMenuRequest) {
  if (!menuEl) {
    menuEl = document.createElement("div");
    menuEl.className = "gpv-keyfmt-menu";
    document.body.appendChild(menuEl);
  }

  const el = menuEl;
  el.innerHTML = renderMenu(req);
  el.style.display = "block";
  el.style.left = `${req.x}px`;
  el.style.top = `${req.y}px`;

  // After it's measurable, clamp to viewport.
  requestAnimationFrame(() => {
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth) el.style.left = `${window.innerWidth - r.width - 8}px`;
    if (r.bottom > window.innerHeight) el.style.top = `${window.innerHeight - r.height - 8}px`;
  });

  let pickedScope: KeyFormatScope = req.hasKey ? "node" : "layer";
  let pickedFormat: KeyFormat = req.currentFormat;

  const refreshFormatHighlight = () => {
    el.querySelectorAll<HTMLElement>(".gpv-keyfmt-option").forEach((opt) => {
      const id = opt.dataset.fmtId;
      opt.classList.toggle("gpv-keyfmt-active", id === keyFormatId(pickedFormat));
    });
  };
  const refreshScopeHighlight = () => {
    el.querySelectorAll<HTMLElement>(".gpv-keyfmt-scope").forEach((s) => {
      s.classList.toggle("gpv-keyfmt-scope-active", s.dataset.scope === pickedScope);
    });
  };
  refreshFormatHighlight();
  refreshScopeHighlight();

  // Pick a format — applies immediately at the current scope.
  el.querySelectorAll<HTMLElement>(".gpv-keyfmt-option").forEach((opt) => {
    opt.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = opt.dataset.fmtId!;
      const fmt = findFormat(id);
      if (fmt) {
        pickedFormat = fmt;
        req.onPick(fmt, pickedScope);
        dismiss?.();
      }
    });
  });

  // Change scope — doesn't apply yet, just changes which scope future picks use.
  el.querySelectorAll<HTMLElement>(".gpv-keyfmt-scope").forEach((s) => {
    s.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const v = s.dataset.scope as KeyFormatScope;
      if (v === "node" && !req.hasKey) return;
      pickedScope = v;
      refreshScopeHighlight();
    });
  });

  // Dismiss handlers.
  const onDocClick = (e: MouseEvent) => {
    if (!el.contains(e.target as Node)) dismiss?.();
  };
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") dismiss?.();
  };
  const onScroll = () => dismiss?.();
  dismiss = () => {
    el.style.display = "none";
    document.removeEventListener("mousedown", onDocClick, true);
    document.removeEventListener("keydown", onKeydown);
    document.removeEventListener("scroll", onScroll, true);
    dismiss = null;
  };
  // Defer attaching the doc handler so this very click doesn't dismiss us.
  setTimeout(() => {
    document.addEventListener("mousedown", onDocClick, true);
    document.addEventListener("keydown", onKeydown);
    document.addEventListener("scroll", onScroll, true);
  }, 0);
}

function findFormat(id: string): KeyFormat | null {
  for (const group of KEY_FORMAT_GROUPS) {
    for (const f of group.formats) {
      if (keyFormatId(f) === id) return f;
    }
  }
  return null;
}

function renderMenu(req: KeyFormatMenuRequest): string {
  const groupHtml = KEY_FORMAT_GROUPS.map(
    (g) =>
      `<div class="gpv-keyfmt-group">
         <div class="gpv-keyfmt-heading">${escapeHtml(g.heading)}</div>
         ${g.formats
           .map((f) => {
             const active = keyFormatEquals(f, req.currentFormat) ? " gpv-keyfmt-active" : "";
             return `<button type="button" class="gpv-keyfmt-option${active}" data-fmt-id="${keyFormatId(
               f,
             )}">${escapeHtml(keyFormatLabel(f))}</button>`;
           })
           .join("")}
       </div>`,
  ).join("");
  const nodeDisabled = req.hasKey ? "" : "disabled";
  return `
    <div class="gpv-keyfmt-title">Interpret key as…</div>
    ${groupHtml}
    <div class="gpv-keyfmt-scoperow">
      <span class="gpv-keyfmt-scopelabel">Apply to:</span>
      <button type="button" class="gpv-keyfmt-scope" data-scope="node" ${nodeDisabled}>This node</button>
      <button type="button" class="gpv-keyfmt-scope" data-scope="layer">This layer</button>
      <button type="button" class="gpv-keyfmt-scope" data-scope="all">Whole proof</button>
    </div>
    <div class="gpv-keyfmt-hint">Picking a format applies immediately at the selected scope.</div>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
