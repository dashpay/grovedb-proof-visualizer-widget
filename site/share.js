// Shareable link encode/decode.
//
// We pack (format, data) into the URL fragment as `#f=<format>&d=<base64url>`.
// The fragment never reaches GitHub Pages servers, so the proof stays
// client-side. Pipeline: text/hex → bytes → gzip (CompressionStream) →
// base64url. For 40 KB proofs the resulting URL is ~30–55 KB, comfortably
// inside Chrome/Firefox/Safari URL limits.
//
// For `format=bytes`, we hex-decode first so we compress the raw 40 KB proof
// rather than its 80 KB hex form — material URL savings.

export async function encodeShareUrl(format, input) {
  const trimmed = input.trim();
  let raw;
  if (format === "bytes") {
    raw = hexToBytes(trimmed);
  } else {
    raw = new TextEncoder().encode(trimmed);
  }
  const compressed = await gzip(raw);
  const b64 = base64UrlEncode(compressed);
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = `f=${encodeURIComponent(format)}&d=${b64}`;
  return url.toString();
}

export async function decodeShareFragment(fragment) {
  const params = parseFragment(fragment);
  const format = params.f;
  const data = params.d;
  if (!format || !data) return null;
  if (!["json", "text", "bytes"].includes(format)) return null;
  const compressed = base64UrlDecode(data);
  const raw = await gunzip(compressed);
  let str;
  if (format === "bytes") {
    str = bytesToHex(raw);
  } else {
    str = new TextDecoder().decode(raw);
  }
  return { format, input: str };
}

function parseFragment(frag) {
  const s = frag.startsWith("#") ? frag.slice(1) : frag;
  const params = {};
  for (const part of s.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    params[decodeURIComponent(part.slice(0, eq))] = part.slice(eq + 1);
  }
  return params;
}

// ---- gzip via the platform's CompressionStream / DecompressionStream ----

async function gzip(bytes) {
  if (typeof CompressionStream === "undefined") {
    // No gzip available — return as-is and rely on base64. Old browsers only.
    return bytes;
  }
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const ab = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(ab);
}

async function gunzip(bytes) {
  // Try gzip first; if the input isn't actually gzipped (legacy share links
  // from a no-CompressionStream browser), assume raw bytes.
  if (typeof DecompressionStream === "undefined") return bytes;
  try {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const ab = await new Response(ds.readable).arrayBuffer();
    return new Uint8Array(ab);
  } catch {
    return bytes;
  }
}

// ---- base64url ----

function base64UrlEncode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s) {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- hex helpers ----

function hexToBytes(hex) {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (s.length % 2 !== 0) throw new Error(`hex input has odd length`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
