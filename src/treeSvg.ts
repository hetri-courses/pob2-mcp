/**
 * Tree SVG renderer for HTML build guides.
 *
 * Reads raw tree.json (PoB2's TreeData/<version>/tree.json) and emits a
 * compact inline SVG showing the passive tree, with allocated nodes
 * highlighted.
 *
 * Coords: group.{x,y} + orbitRadii[orbit] * {cos(angle), sin(angle)}, where
 * angle = constants.orbitAnglesByOrbit[orbit][orbitIndex]. PoE2 uses y-down,
 * same as SVG, so no flip needed.
 *
 * Size budget: target ≤200KB inline. The 0_4 tree has 4701 nodes; rendering
 * only the main (non-ascendancy) tree drops that to ~1300 nodes plus their
 * edges → ~70KB. Coords are rounded to integers, classes are single-letter.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_TREE_VERSION } from "./treeData.js";

interface RawGroup {
  x: number;
  y: number;
  orbits?: number[];
  nodes?: number[];
}

interface RawNodeFull {
  name?: string;
  group?: number;
  orbit?: number;
  orbitIndex?: number;
  /** Absolute coords if the source precomputed them (GGG export does). */
  x?: number;
  y?: number;
  isKeystone?: boolean;
  isNotable?: boolean;
  isMastery?: boolean;
  isJewelSocket?: boolean;
  isAttribute?: boolean;
  ascendancyName?: string;
  classStartIndex?: number;
  connections?: Array<{ id: number; orbit?: number }>;
  skill?: number;
  icon?: string;
  stats?: string[];
}

interface RawTreeFull {
  nodes: Record<string, RawNodeFull>;
  groups: Record<string, RawGroup>;
  constants: {
    orbitRadii: number[];
    skillsPerOrbit: number[];
    orbitAnglesByOrbit: number[][];
  };
  min_x: number;
  max_x: number;
  min_y: number;
  max_y: number;
}

/** Cached raw-tree loader (re-uses the same parse cost as treeData.ts but keeps geometry). */
const RAW_CACHE = new Map<string, RawTreeFull>();
export function loadRawTree(forkPath: string, version = DEFAULT_TREE_VERSION): RawTreeFull {
  const key = `${forkPath}::${version}`;
  const hit = RAW_CACHE.get(key);
  if (hit) return hit;
  const treeJsonPath = path.join(forkPath, "TreeData", version, "tree.json");
  const raw = JSON.parse(readFileSync(treeJsonPath, "utf8")) as RawTreeFull;
  RAW_CACHE.set(key, raw);
  return raw;
}

/** Compute the SVG (x, y) for a node. Returns null if positioning data missing. */
export function nodeCoords(raw: RawTreeFull, node: RawNodeFull): { x: number; y: number } | null {
  // Prefer precomputed absolute coords (GGG export ships these). Avoids any
  // drift in orbit-geometry constants between patches.
  if (typeof node.x === "number" && typeof node.y === "number") {
    return { x: node.x, y: node.y };
  }
  if (node.group == null || node.orbit == null) return null;
  const group = raw.groups[String(node.group)];
  if (!group || group.x == null || group.y == null) return null;
  const radius = raw.constants.orbitRadii[node.orbit] ?? 0;
  const angles = raw.constants.orbitAnglesByOrbit[node.orbit] ?? [];
  // Some orbits have a single angle pair (0 and 2π); orbitIndex can be 0 then.
  const idx = node.orbitIndex ?? 0;
  const angle = angles[idx] ?? 0;
  // PoE2 angle 0 is "up" (north). cos→x, sin→y, but anglular convention: angle measured CW from up
  // so x = radius * sin(angle), y = -radius * cos(angle).
  // (Verified by spot-checking against PoB1 tree renderer code.)
  const x = group.x + radius * Math.sin(angle);
  const y = group.y - radius * Math.cos(angle);
  return { x, y };
}

export interface RenderTreeSvgOptions {
  /** Set of allocated node IDs (rendered highlighted). */
  allocated: Set<number>;
  /** Active ascendancy class name — if set, that ascendancy's nodes are drawn. */
  ascendancyName?: string;
  /** Class start index — if set, the matching class-start node is highlighted. */
  classStartIndex?: number;
  /** SVG width attribute (HTML pixels). Default 800. */
  width?: number;
  /** Optional CSS-color overrides. */
  colors?: {
    background?: string;
    edge?: string;
    edgeAlloc?: string;
    normal?: string;
    normalAlloc?: string;
    notable?: string;
    notableAlloc?: string;
    keystone?: string;
    keystoneAlloc?: string;
    text?: string;
  };
}

const DEFAULT_COLORS = {
  background: "transparent",
  edge: "#3a3a3a",
  edgeAlloc: "#d4b06a",
  normal: "#525252",
  normalAlloc: "#e6c87a",
  notable: "#8a7a4f",
  notableAlloc: "#f0d080",
  keystone: "#b85050",
  keystoneAlloc: "#ffaa44",
  text: "#dcdcdc",
};

/**
 * Render the passive tree as inline SVG.
 *
 * The tree only includes the main (non-ascendancy) nodes plus the player's
 * chosen ascendancy subtree (if `ascendancyName` is provided). All other
 * ascendancies are skipped to keep the SVG small.
 *
 * Node sizing (in tree-units, before viewbox scaling):
 *   keystone  → r=50 (very prominent)
 *   notable   → r=32
 *   normal    → r=18
 *   jewel     → r=24 (square)
 *   mastery   → skipped (visual clutter, doesn't add allocation info)
 */
export function renderTreeSvg(raw: RawTreeFull, options: RenderTreeSvgOptions): string {
  const colors = { ...DEFAULT_COLORS, ...(options.colors ?? {}) };
  const allocated = options.allocated;
  const ascendancyName = options.ascendancyName;
  const width = options.width ?? 800;

  // Decide which nodes to render: all non-ascendancy + the player's ascendancy.
  const includedNodes = new Map<number, RawNodeFull>();
  const includedCoords = new Map<number, { x: number; y: number }>();
  for (const [idStr, node] of Object.entries(raw.nodes)) {
    if (node.isMastery) continue;
    if (node.ascendancyName && node.ascendancyName !== ascendancyName) continue;
    const xy = nodeCoords(raw, node);
    if (!xy) continue;
    const id = Number(idStr);
    includedNodes.set(id, node);
    includedCoords.set(id, xy);
  }

  // Edges: render both directions deduped. Skip if either endpoint not in our set.
  // PoB stores edges one-way only; we still need to walk both forward and
  // backward by tracking visited (min,max) pairs.
  const edgePairs = new Set<string>();
  const edges: Array<{ a: number; b: number; alloc: boolean }> = [];
  for (const [idStr, node] of includedNodes.entries()) {
    if (!node.connections) continue;
    const aId = idStr;
    for (const c of node.connections) {
      const bId = c.id;
      if (!includedNodes.has(bId)) continue;
      const key = aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
      if (edgePairs.has(key)) continue;
      edgePairs.add(key);
      const allocBoth = allocated.has(aId as unknown as number) && allocated.has(bId);
      edges.push({ a: aId as unknown as number, b: bId, alloc: allocBoth });
    }
  }

  // Tighter viewbox: bound to actually-rendered nodes (ascendancies are off-tree).
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const { x, y } of includedCoords.values()) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (minX === Infinity) {
    // Empty tree, render placeholder
    return `<svg width="${width}" height="200" viewBox="0 0 ${width} 200"><text x="50%" y="50%" fill="${colors.text}" text-anchor="middle">no tree</text></svg>`;
  }
  const pad = 200; // tree-units of padding around the rendered area
  minX -= pad; maxX += pad; minY -= pad; maxY += pad;
  const w = Math.round(maxX - minX);
  const h = Math.round(maxY - minY);
  const height = Math.round(width * (h / w));

  // Sizes are in tree-coords (so viewBox scales them).
  const R = { keystone: 90, notable: 55, normal: 32, jewel: 50, classStart: 110 };

  // Use CSS classes (single-letter) to cut per-element attribute overhead.
  // ~25-30 byte savings per element × ~5000 elements ≈ 130KB.
  const style = `
    .e{stroke:${colors.edge};stroke-width:6;fill:none;stroke-linecap:round}
    .ea{stroke:${colors.edgeAlloc};stroke-width:10;fill:none;stroke-linecap:round}
    .n{fill:${colors.normal}}
    .na{fill:${colors.normalAlloc}}
    .nt{fill:${colors.notable};stroke:#000;stroke-width:4}
    .nta{fill:${colors.notableAlloc};stroke:#000;stroke-width:4}
    .k{fill:${colors.keystone};stroke:#000;stroke-width:4}
    .ka{fill:${colors.keystoneAlloc};stroke:#000;stroke-width:4}
    .j{fill:#404060;stroke:#a0a0c0;stroke-width:4}
    .ja{fill:${colors.normalAlloc};stroke:#a0a0c0;stroke-width:4}
    .cs{fill:#404040;stroke:#aa6633;stroke-width:6}
    .csa{fill:#cc8844;stroke:#aa6633;stroke-width:6}`;

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="${Math.round(minX)} ${Math.round(minY)} ${w} ${h}" ` +
      `style="background:${colors.background};display:block;max-width:100%;height:auto" ` +
      `role="img" aria-label="Passive skill tree">`,
  );
  out.push(`<style>${style}</style>`);

  // Edges first (so nodes overlay them).
  // Two combined <path>s (one per state) collapse ~2-3KB of element framing
  // overhead per 100 edges → ~150KB savings on the full tree.
  const edgePathNormal: string[] = [];
  const edgePathAlloc: string[] = [];
  for (const e of edges) {
    const a = includedCoords.get(e.a)!;
    const b = includedCoords.get(e.b)!;
    const seg = `M${Math.round(a.x)} ${Math.round(a.y)}L${Math.round(b.x)} ${Math.round(b.y)}`;
    (e.alloc ? edgePathAlloc : edgePathNormal).push(seg);
  }
  if (edgePathNormal.length) out.push(`<path class="e" d="${edgePathNormal.join("")}"/>`);
  if (edgePathAlloc.length) out.push(`<path class="ea" d="${edgePathAlloc.join("")}"/>`);

  // Nodes
  out.push(`<g>`);
  for (const [id, node] of includedNodes.entries()) {
    const { x, y } = includedCoords.get(id)!;
    const alloc = allocated.has(id);
    const cx = Math.round(x);
    const cy = Math.round(y);
    let cls = alloc ? "na" : "n";
    let r = R.normal;

    if (node.isKeystone) {
      r = R.keystone;
      cls = alloc ? "ka" : "k";
    } else if (node.isNotable) {
      r = R.notable;
      cls = alloc ? "nta" : "nt";
    } else if (node.isJewelSocket) {
      r = R.jewel;
      cls = alloc ? "ja" : "j";
    } else if (node.classStartIndex != null) {
      r = R.classStart;
      const isCurrentClass = options.classStartIndex === node.classStartIndex;
      cls = isCurrentClass ? "csa" : "cs";
    }

    if (node.isJewelSocket) {
      const half = r;
      out.push(
        `<rect x="${cx - half}" y="${cy - half}" width="${half * 2}" height="${half * 2}" class="${cls}" transform="rotate(45 ${cx} ${cy})"/>`,
      );
    } else {
      out.push(`<circle cx="${cx}" cy="${cy}" r="${r}" class="${cls}"/>`);
    }
  }
  out.push(`</g>`);

  out.push(`</svg>`);
  return out.join("");
}
