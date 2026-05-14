// WASM adapter — wraps the wasm-bindgen-built `grovedb-proof-view-wasm` crate.
//
// The bytes parser pulls in grovedb's full bincode + Element + Merk decoder,
// so it ships as a separately-loaded ~180 KB wasm module rather than living in
// the core JS bundle. Call `loadWasmAdapters(wasmUrl?)` once, then pass the
// returned object as `adapters` to `renderProof()` or `setAdapters()`.

import type { InputAdapters } from "./load.js";
import type { ProofView } from "./types.js";

let adaptersPromise: Promise<InputAdapters> | null = null;

/**
 * Load the WASM module and return `InputAdapters` wired to it.
 *
 * @param wasmUrl Optional override for the `.wasm` file URL. Defaults to the
 *   sibling `wasm/grovedb_proof_view_wasm_bg.wasm` next to this module.
 */
export function loadWasmAdapters(wasmUrl?: string | URL): Promise<InputAdapters> {
  if (adaptersPromise) return adaptersPromise;
  adaptersPromise = (async () => {
    // Dynamic import keeps the wasm-bindgen JS glue out of the core bundle.
    const mod = await import("../wasm/grovedb_proof_view_wasm.js");
    const url =
      wasmUrl ?? new URL("../wasm/grovedb_proof_view_wasm_bg.wasm", import.meta.url);
    await mod.default(url);
    return {
      parseBytes: (input: string | Uint8Array): ProofView => {
        const result =
          typeof input === "string" ? mod.parseBytes(input) : mod.parseBytesRaw(input);
        return result as ProofView;
      },
      parseText: (input: string): ProofView => mod.parseText(input) as ProofView,
    };
  })();
  return adaptersPromise;
}

/** Reset the cached promise — useful for tests. */
export function _resetWasmAdaptersForTests(): void {
  adaptersPromise = null;
}
