// Merk hash primitives, faithful TS port of
// `merk/src/tree/hash.rs` from the pinned grovedb revision.
//
// All primitives accept Uint8Array inputs and return 32-byte Uint8Array
// outputs, matching the grovedb wire format. The varint encoding mirrors
// the integer-encoding crate's unsigned LEB128.

import { blake3 } from "@noble/hashes/blake3";

export type Hash32 = Uint8Array;

export const HASH_LENGTH = 32;
export const NULL_HASH: Hash32 = new Uint8Array(HASH_LENGTH);

/** Concatenate Uint8Arrays. */
export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Unsigned LEB128 (matches Rust's `integer_encoding::VarInt::encode_var` for
 * usize). For typical key/value lengths (< 2^32) the precision of `number` is
 * fine.
 */
export function varint(n: number): Uint8Array {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
  return Uint8Array.from(out);
}

/** Big-endian 8-byte encoding of a u64 (for `node_hash_with_count`). */
export function u64BE(n: bigint | number): Uint8Array {
  const v = typeof n === "bigint" ? n : BigInt(n);
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, v, false);
  return out;
}

/** `value_hash(value) = blake3(varint(value.len) || value)` */
export function valueHash(value: Uint8Array): Hash32 {
  return blake3(concat(varint(value.length), value));
}

/** `kv_hash(key, value) = blake3(varint(key.len) || key || value_hash(value))` */
export function kvHashFromValue(key: Uint8Array, value: Uint8Array): Hash32 {
  return kvHashFromValueHash(key, valueHash(value));
}

/** `kv_digest_to_kv_hash(key, value_hash) = blake3(varint(key.len) || key || value_hash)` */
export function kvHashFromValueHash(key: Uint8Array, valueHash: Hash32): Hash32 {
  return blake3(concat(varint(key.length), key, valueHash));
}

/** `node_hash(kv_hash, left, right) = blake3(kv_hash || left || right)` */
export function nodeHash(kvHash: Hash32, left: Hash32, right: Hash32): Hash32 {
  return blake3(concat(kvHash, left, right));
}

/** `node_hash_with_count(kv_hash, left, right, count) = blake3(kv_hash || left || right || u64_be(count))` */
export function nodeHashWithCount(
  kvHash: Hash32,
  left: Hash32,
  right: Hash32,
  count: bigint | number,
): Hash32 {
  return blake3(concat(kvHash, left, right, u64BE(count)));
}

/** `combine_hash(a, b) = blake3(a || b)` */
export function combineHash(a: Hash32, b: Hash32): Hash32 {
  return blake3(concat(a, b));
}

export function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function hexToBytes(hexStr: string): Uint8Array {
  const s = hexStr.startsWith("0x") ? hexStr.slice(2) : hexStr;
  if (s.length % 2 !== 0) throw new Error(`hex length odd: ${s.length}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.substr(i * 2, 2), 16);
  }
  return out;
}
