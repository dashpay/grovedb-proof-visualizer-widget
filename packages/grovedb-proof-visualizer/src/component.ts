// Web Component wrapper: <grovedb-proof>.
//
// Usage:
//   <grovedb-proof src="proof.json"></grovedb-proof>
//   <grovedb-proof format="json">{ "version": 1, "root_layer_id": 0, ... }</grovedb-proof>
//   <grovedb-proof format="text">GroveDBProofV1 { ... }</grovedb-proof>

import { renderProof, sniffFormat } from "./index.js";
import type { InputAdapters, ProofInput } from "./load.js";

let globalAdapters: InputAdapters = {};

/**
 * Provide global input adapters (used when `format` is `bytes` or `text`).
 * Must be called before any `<grovedb-proof>` mounts.
 */
export function setAdapters(adapters: InputAdapters) {
  globalAdapters = { ...globalAdapters, ...adapters };
}

class GroveDBProofElement extends HTMLElement {
  static get observedAttributes() {
    return ["src", "format", "theme", "collapsed"];
  }

  private renderedToken = 0;

  connectedCallback() {
    void this.refresh();
  }

  attributeChangedCallback() {
    if (this.isConnected) void this.refresh();
  }

  private async refresh() {
    const token = ++this.renderedToken;
    const src = this.getAttribute("src");
    const formatAttr = this.getAttribute("format") as
      | "json"
      | "text"
      | "bytes"
      | null;

    let raw: string;
    if (src) {
      const res = await fetch(src);
      if (!res.ok) {
        this.textContent = `failed to load ${src}: ${res.status}`;
        return;
      }
      raw = await res.text();
    } else {
      raw = this.textContent ?? "";
    }
    if (token !== this.renderedToken) return; // stale

    const format = formatAttr ?? sniffFormat(raw);
    const input: ProofInput =
      format === "json"
        ? { format: "json", data: raw }
        : format === "text"
        ? { format: "text", data: raw }
        : { format: "bytes", data: raw };

    try {
      this.innerHTML = "";
      const mount = document.createElement("div");
      this.appendChild(mount);
      await renderProof(mount, input, {
        theme: (this.getAttribute("theme") as "navy" | "light" | "auto") ?? "auto",
        adapters: globalAdapters,
        collapsed: this.hasAttribute("collapsed"),
      });
    } catch (e) {
      this.innerHTML = "";
      const err = document.createElement("pre");
      err.className = "gpv-error";
      err.textContent = String(e);
      this.appendChild(err);
    }
  }
}

if (!customElements.get("grovedb-proof")) {
  customElements.define("grovedb-proof", GroveDBProofElement);
}

export { GroveDBProofElement };
