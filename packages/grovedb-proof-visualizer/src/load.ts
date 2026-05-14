// Input dispatch: figure out which parser to call based on the input shape.
//
// In phase 2 we only support the `json` path (the WASM binding for `bytes` and
// the text-parser come online in phase 3 / phase 4). Returning a hard error
// for the others keeps the call sites stable.

import type { ProofView } from "./types.js";

export type ProofInput =
  | { format: "json"; data: ProofView | string }
  | { format: "bytes"; data: string | Uint8Array }
  | { format: "text"; data: string };

export interface InputAdapters {
  /** Decode bincode-encoded proof bytes (hex string or Uint8Array). */
  parseBytes?: (input: string | Uint8Array) => ProofView | Promise<ProofView>;
  /** Decode the `GroveDBProof::Display` text dump. */
  parseText?: (input: string) => ProofView | Promise<ProofView>;
}

export async function resolveProofView(
  input: ProofInput,
  adapters: InputAdapters = {},
): Promise<ProofView> {
  switch (input.format) {
    case "json":
      return typeof input.data === "string" ? JSON.parse(input.data) : input.data;
    case "bytes":
      if (!adapters.parseBytes) {
        throw new Error(
          "bytes input requires the WASM adapter — install @dashpay/grovedb-proof-visualizer-wasm and pass it as `parseBytes`",
        );
      }
      return adapters.parseBytes(input.data);
    case "text":
      if (!adapters.parseText) {
        throw new Error(
          "text input requires the WASM adapter — install @dashpay/grovedb-proof-visualizer-wasm and pass it as `parseText`",
        );
      }
      return adapters.parseText(input.data);
  }
}

/** Best-effort sniff of an input string to pick a format. */
export function sniffFormat(input: string): "json" | "text" | "bytes" {
  const s = input.trimStart();
  if (s.startsWith("{")) return "json";
  if (s.startsWith("GroveDBProof")) return "text";
  return "bytes";
}
