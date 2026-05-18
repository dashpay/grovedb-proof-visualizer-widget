// Per-node / per-layer / global key interpretation.
//
// Keys in GroveDB are arbitrary bytes; the auto formatter falls back to
// `0x<hex>` when bytes aren't printable ASCII. For numeric index keys (u64
// document counts, i64 sortable encodings, etc.) the reader wants the
// decoded number, not the hex. This module owns:
//
//   - the available format kinds
//   - the format() function that turns raw key bytes into a display string
//   - the override-resolution map (global → layer → node)
//   - the scope enum (this node / this layer / whole proof)

export type KeyFormat =
  | { kind: "auto" }
  | { kind: "hex" }
  | { kind: "utf8" }
  | { kind: "ascii" }
  | { kind: "u8" }
  | { kind: "u16"; endian: "be" | "le" }
  | { kind: "u32"; endian: "be" | "le" }
  | { kind: "u64"; endian: "be" | "le" }
  | { kind: "i8" }
  | { kind: "i16"; endian: "be" | "le" }
  | { kind: "i32"; endian: "be" | "le" }
  | { kind: "i64"; endian: "be" | "le" }
  /** i64 BE with the sign bit flipped — the standard sortable encoding for
   *  signed-int index keys. Bytes sort the same as the underlying i64. */
  | { kind: "i64_ordered" };

export type KeyFormatScope = "node" | "layer" | "all";

/** Whether two `KeyFormat`s are equivalent. Used for highlighting the active option. */
export function keyFormatEquals(a: KeyFormat, b: KeyFormat): boolean {
  if (a.kind !== b.kind) return false;
  if ("endian" in a && "endian" in b) return a.endian === b.endian;
  return true;
}

/** Stable identifier used in serializing / lookup. */
export function keyFormatId(f: KeyFormat): string {
  if ("endian" in f) return `${f.kind}_${f.endian}`;
  return f.kind;
}

/** Human-readable label for menus / chips. */
export function keyFormatLabel(f: KeyFormat): string {
  switch (f.kind) {
    case "auto":
      return "Auto (ASCII or hex)";
    case "hex":
      return "Hex";
    case "utf8":
      return "UTF-8 string";
    case "ascii":
      return "ASCII string";
    case "u8":
      return "u8";
    case "i8":
      return "i8";
    case "u16":
    case "u32":
    case "u64":
    case "i16":
    case "i32":
    case "i64":
      return `${f.kind} (${f.endian.toUpperCase()})`;
    case "i64_ordered":
      return "i64 ordered (BE, sign-flipped)";
  }
}

/** The full menu, grouped. */
export const KEY_FORMAT_GROUPS: Array<{ heading: string; formats: KeyFormat[] }> = [
  {
    heading: "Strings",
    formats: [{ kind: "auto" }, { kind: "hex" }, { kind: "ascii" }, { kind: "utf8" }],
  },
  {
    heading: "Unsigned",
    formats: [
      { kind: "u8" },
      { kind: "u16", endian: "be" },
      { kind: "u16", endian: "le" },
      { kind: "u32", endian: "be" },
      { kind: "u32", endian: "le" },
      { kind: "u64", endian: "be" },
      { kind: "u64", endian: "le" },
    ],
  },
  {
    heading: "Signed",
    formats: [
      { kind: "i8" },
      { kind: "i16", endian: "be" },
      { kind: "i16", endian: "le" },
      { kind: "i32", endian: "be" },
      { kind: "i32", endian: "le" },
      { kind: "i64", endian: "be" },
      { kind: "i64", endian: "le" },
      { kind: "i64_ordered" },
    ],
  },
];

/** Format raw key bytes per the requested format. Returns `null` when the
 *  byte length is wrong for a fixed-size integer format — callers can fall
 *  back to hex with a note. */
export function formatKey(bytes: Uint8Array, format: KeyFormat): string | null {
  switch (format.kind) {
    case "auto":
      return formatAuto(bytes);
    case "hex":
      return "0x" + bytesToHex(bytes);
    case "utf8":
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return null;
      }
    case "ascii": {
      for (const b of bytes) {
        if (b < 0x20 || b > 0x7e) return null;
      }
      return new TextDecoder("ascii").decode(bytes);
    }
    case "u8":
      if (bytes.length !== 1) return null;
      return String(bytes[0]);
    case "i8":
      if (bytes.length !== 1) return null;
      return String((bytes[0] << 24) >> 24);
    case "u16":
      if (bytes.length !== 2) return null;
      return String(
        new DataView(bytes.buffer, bytes.byteOffset, 2).getUint16(0, format.endian === "le"),
      );
    case "i16":
      if (bytes.length !== 2) return null;
      return String(
        new DataView(bytes.buffer, bytes.byteOffset, 2).getInt16(0, format.endian === "le"),
      );
    case "u32":
      if (bytes.length !== 4) return null;
      return String(
        new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, format.endian === "le"),
      );
    case "i32":
      if (bytes.length !== 4) return null;
      return String(
        new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, format.endian === "le"),
      );
    case "u64":
      if (bytes.length !== 8) return null;
      return new DataView(bytes.buffer, bytes.byteOffset, 8)
        .getBigUint64(0, format.endian === "le")
        .toString();
    case "i64":
      if (bytes.length !== 8) return null;
      return new DataView(bytes.buffer, bytes.byteOffset, 8)
        .getBigInt64(0, format.endian === "le")
        .toString();
    case "i64_ordered":
      if (bytes.length !== 8) return null;
      return decodeI64Ordered(bytes).toString();
  }
}

/** Wraps `formatKey` with a graceful fallback: shows `hex (needs N bytes)`
 *  when the chosen format doesn't fit the key length, instead of nothing. */
export function formatKeyDisplay(
  bytes: Uint8Array,
  format: KeyFormat,
): { display: string; ok: boolean } {
  const out = formatKey(bytes, format);
  if (out != null) return { display: out, ok: true };
  const fallback = bytes.length === 0 ? "0x" : "0x" + bytesToHex(bytes);
  return {
    display: `${fallback} (can't read as ${keyFormatLabel(format)})`,
    ok: false,
  };
}

// ---- override registry ----

export class KeyOverrides {
  private global: KeyFormat = { kind: "auto" };
  private byLayer = new Map<number, KeyFormat>();
  private byNode = new Map<string, KeyFormat>();

  resolve(layerId: number, nodeId: number): KeyFormat {
    const nk = this.byNode.get(nodeKey(layerId, nodeId));
    if (nk) return nk;
    return this.byLayer.get(layerId) ?? this.global;
  }

  resolveLayer(layerId: number): KeyFormat {
    return this.byLayer.get(layerId) ?? this.global;
  }

  set(scope: KeyFormatScope, layerId: number, nodeId: number, format: KeyFormat) {
    switch (scope) {
      case "node":
        // setting back to auto clears the override so a layer/global default
        // takes over instead of pinning "auto" on this node forever
        if (format.kind === "auto") this.byNode.delete(nodeKey(layerId, nodeId));
        else this.byNode.set(nodeKey(layerId, nodeId), format);
        break;
      case "layer":
        if (format.kind === "auto") this.byLayer.delete(layerId);
        else this.byLayer.set(layerId, format);
        // clear any per-node overrides for this layer so the layer choice
        // actually shows — they'd silently win otherwise
        for (const k of Array.from(this.byNode.keys())) {
          if (k.startsWith(`${layerId}:`)) this.byNode.delete(k);
        }
        break;
      case "all":
        this.global = format;
        this.byLayer.clear();
        this.byNode.clear();
        break;
    }
  }
}

function nodeKey(layerId: number, nodeId: number): string {
  return `${layerId}:${nodeId}`;
}

// ---- helpers ----

function formatAuto(bytes: Uint8Array): string {
  // Same rule as grovedb's `hex_to_ascii`: printable subset → string, else hex.
  const allowed =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-/\\[]@";
  let s = "";
  for (const b of bytes) {
    const c = String.fromCharCode(b);
    if (!allowed.includes(c)) return "0x" + bytesToHex(bytes);
    s += c;
  }
  return s;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function decodeI64Ordered(bytes: Uint8Array): bigint {
  // Sortable signed-int encoding: store i64 as (i64 ^ MIN_i64) in big-endian
  // so the sign bit gets flipped — bytewise unsigned compare matches signed
  // i64 compare. To decode: read u64 BE, XOR with 0x8000000000000000, then
  // interpret as i64.
  const u = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, false);
  const xored = u ^ 0x8000000000000000n;
  // Convert u64 → i64 by checking the new MSB
  return xored >= 0x8000000000000000n ? xored - 0x10000000000000000n : xored;
}

export function hexToBytesLocal(hex: string): Uint8Array {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.substr(i * 2, 2), 16);
  }
  return out;
}
