// Layout one merk binary tree as an SVG <g>.
//
// Strategy: top-down tree layout. X = inorder rank, Y = depth from root.
// The result is a self-contained SVG group + a registry of node anchors so
// the cross-layer overlay knows where each node-id lives in the parent layer.

import type { MerkBinaryTree, MerkNodeView } from "../types.js";
import { classifyNode, nodeBriefLabel } from "./format.js";

export interface MerkLayout {
  /** SVG markup for the tree (a single `<g>` placed at 0,0). */
  svg: string;
  /** Width/height of the bounding box, in px. */
  width: number;
  height: number;
  /** node_id -> {x, y} center, relative to the SVG group. */
  anchors: Map<number, { x: number; y: number }>;
}

const NODE_W = 220;
const NODE_H = 64;
const COL_GAP = 24;
const ROW_GAP = 56;
const PAD = 16;

interface Placement {
  id: number;
  x: number; // column index
  y: number; // depth
  view: MerkNodeView;
  on_path: boolean;
  left: number | null;
  right: number | null;
}

export function layoutMerkTree(tree: MerkBinaryTree): MerkLayout {
  const placements = new Map<number, Placement>();
  let nextX = 0;

  // Inorder walk -> assign x, depth -> y.
  const walk = (id: number, depth: number) => {
    const node = tree.nodes[id];
    if (node.left != null) walk(node.left, depth + 1);
    placements.set(id, {
      id,
      x: nextX++,
      y: depth,
      view: node.view,
      on_path: node.on_path,
      left: node.left,
      right: node.right,
    });
    if (node.right != null) walk(node.right, depth + 1);
  };
  walk(tree.root, 0);

  const cols = nextX;
  const rows = Math.max(...[...placements.values()].map((p) => p.y)) + 1;
  const width = PAD * 2 + cols * NODE_W + (cols - 1) * COL_GAP;
  const height = PAD * 2 + rows * NODE_H + (rows - 1) * ROW_GAP;

  const xOf = (col: number) => PAD + col * (NODE_W + COL_GAP);
  const yOf = (row: number) => PAD + row * (NODE_H + ROW_GAP);

  const anchors = new Map<number, { x: number; y: number }>();
  for (const p of placements.values()) {
    anchors.set(p.id, { x: xOf(p.x) + NODE_W / 2, y: yOf(p.y) + NODE_H / 2 });
  }

  // 1. edges first (so node rects layer over them)
  const edgeSvg: string[] = [];
  for (const p of placements.values()) {
    for (const childId of [p.left, p.right]) {
      if (childId == null) continue;
      const a = anchors.get(p.id)!;
      const b = anchors.get(childId)!;
      // Curve down from parent's bottom to child's top. Cubic bezier.
      const x1 = a.x;
      const y1 = a.y + NODE_H / 2;
      const x2 = b.x;
      const y2 = b.y - NODE_H / 2;
      const cy = (y1 + y2) / 2;
      edgeSvg.push(
        `<path d="M ${x1} ${y1} C ${x1} ${cy}, ${x2} ${cy}, ${x2} ${y2}" class="gpv-edge" fill="none"/>`,
      );
    }
  }

  // 2. node rects + labels
  const nodeSvg: string[] = [];
  for (const p of placements.values()) {
    const cls = classifyNode(p.view);
    const { primary, secondary } = nodeBriefLabel(p.view);
    const x = xOf(p.x);
    const y = yOf(p.y);
    const titleAttr = describeForTooltip(p.view).replace(/"/g, "&quot;");
    nodeSvg.push(`
      <g class="gpv-node gpv-node--${cls}" data-node-id="${p.id}">
        <title>${titleAttr}</title>
        <rect x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="6" />
        <text class="gpv-node-primary" x="${x + NODE_W / 2}" y="${y + 22}" text-anchor="middle">${escapeXml(primary)}</text>
        ${
          secondary
            ? `<text class="gpv-node-secondary" x="${x + NODE_W / 2}" y="${y + 44}" text-anchor="middle">${escapeXml(secondary)}</text>`
            : ""
        }
      </g>`);
  }

  const svg = `<g class="gpv-merk-tree">${edgeSvg.join("")}${nodeSvg.join("")}</g>`;

  return { svg, width, height, anchors };
}

function describeForTooltip(view: MerkNodeView): string {
  switch (view.kind) {
    case "hash":
      return `Hash: ${view.hash}`;
    case "kv_hash":
      return `KVHash: ${view.kv_hash}`;
    case "kv_digest":
      return `KVDigest key=${view.key.display}\nvalue_hash=${view.value_hash}`;
    case "kv":
      return `KV key=${view.key.display}\n${describeElement(view.value)}`;
    case "kv_value_hash":
      return `KVValueHash key=${view.key.display}\n${describeElement(view.value)}\nvalue_hash=${view.value_hash}`;
    case "kv_value_hash_feature_type":
      return `KVValueHashFeatureType key=${view.key.display}\n${describeElement(view.value)}\nvalue_hash=${view.value_hash}\nfeature=${view.feature_type.kind}`;
    case "kv_value_hash_feature_type_with_child_hash":
      return `KVValueHashFeatureTypeWithChildHash key=${view.key.display}\n${describeElement(view.value)}\nvalue_hash=${view.value_hash}\nfeature=${view.feature_type.kind}\nchild_hash=${view.child_hash}`;
    case "kv_ref_value_hash":
      return `KVRefValueHash key=${view.key.display}\nvalue_hash=${view.value_hash}`;
    case "kv_count":
      return `KVCount key=${view.key.display}\ncount=${view.count}`;
    case "kv_hash_count":
      return `KVHashCount kv_hash=${view.kv_hash}\ncount=${view.count}`;
    case "kv_ref_value_hash_count":
      return `KVRefValueHashCount key=${view.key.display}\ncount=${view.count}\nvalue_hash=${view.value_hash}`;
    case "kv_digest_count":
      return `KVDigestCount key=${view.key.display}\ncount=${view.count}\nvalue_hash=${view.value_hash}`;
    case "hash_with_count":
      return `HashWithCount kv_hash=${view.kv_hash}\nleft=${view.left_child_hash}\nright=${view.right_child_hash}\ncount=${view.count}`;
  }
}

function describeElement(e: import("../types.js").ElementView): string {
  // Pretty-print all the fields; one per line.
  const lines: string[] = [`element=${e.kind}`];
  for (const [k, v] of Object.entries(e)) {
    if (k === "kind") continue;
    if (v == null) continue;
    if (typeof v === "object") continue;
    lines.push(`${k}=${v}`);
  }
  return lines.join("\n");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
