// Playground: paste a proof, pick a format (or auto-detect), render.

import { renderProof, renderProofView, sniffFormat } from "./dist/index.js";

const $ = (id) => document.getElementById(id);

const inputEl = $("input");
const formatSel = $("format");
const exampleSel = $("example");
const renderBtn = $("render");
const clearBtn = $("clear");
const statusEl = $("status");
const root = $("root");

let wasmAdapters = null;
const loadWasm = async () => {
  if (wasmAdapters) return wasmAdapters;
  setStatus("loading WebAssembly module (~240 KB)…");
  const { loadWasmAdapters } = await import("./dist/wasm.js");
  wasmAdapters = await loadWasmAdapters();
  return wasmAdapters;
};

const placeholder = () => {
  root.innerHTML = `<div class="placeholder">No proof loaded yet. Paste one on the left and click <b>Render</b>, or load an example.</div>`;
};
placeholder();

const setStatus = (msg, kind = "") => {
  statusEl.textContent = msg;
  statusEl.className = `status ${kind}`.trim();
};

const detectedLabel = (raw) => {
  const f = sniffFormat(raw);
  return f === "json" ? "JSON IR" : f === "text" ? "Display text" : "raw hex bytes";
};

const renderInput = async () => {
  const raw = inputEl.value.trim();
  if (!raw) {
    setStatus("input is empty", "error");
    placeholder();
    return;
  }
  const formatChoice = formatSel.value;
  const format = formatChoice === "auto" ? sniffFormat(raw) : formatChoice;

  renderBtn.disabled = true;
  renderBtn.textContent = "rendering…";
  try {
    if (format === "json") {
      // We can render JSON without loading WASM at all.
      const view = JSON.parse(raw);
      renderProofView(root, view);
      setStatus(`rendered ${view.layers.length} layers from JSON IR`, "success");
    } else {
      const adapters = await loadWasm();
      await renderProof(root, { format, data: raw }, { adapters });
      setStatus(`rendered from ${detectedLabel(raw)}`, "success");
    }
  } catch (e) {
    setStatus(String(e), "error");
    placeholder();
  } finally {
    renderBtn.disabled = false;
    renderBtn.textContent = "Render →";
  }
};

renderBtn.addEventListener("click", renderInput);
inputEl.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    renderInput();
  }
});

clearBtn.addEventListener("click", () => {
  inputEl.value = "";
  exampleSel.value = "";
  formatSel.value = "auto";
  setStatus("");
  placeholder();
  inputEl.focus();
});

exampleSel.addEventListener("change", async () => {
  const path = exampleSel.value;
  if (!path) return;
  setStatus(`fetching ${path}…`);
  try {
    const res = await fetch(path);
    if (!res.ok) {
      setStatus(`failed to fetch ${path}: ${res.status}`, "error");
      return;
    }
    inputEl.value = (await res.text()).trim();
    // Pick the right format from the file extension.
    const ext = path.split(".").pop();
    formatSel.value = ext === "json" ? "json" : ext === "txt" ? "text" : ext === "hex" ? "bytes" : "auto";
    setStatus(`loaded ${path}; click Render`);
  } catch (e) {
    setStatus(String(e), "error");
  }
});

// keyboard hint
setStatus("tip: ⌘/Ctrl+Enter renders the current input.");
