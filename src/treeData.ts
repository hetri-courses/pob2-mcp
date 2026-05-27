/**
 * Tree-data loader: reads PoB2's TreeData/<version>/tree.json directly.
 *
 * No Lua bridge needed for tree lookups — the data is static JSON shipped
 * with PoB2. We load it once on first access and cache in memory. ~1.8MB JSON
 * for the 0_4 tree (4701 nodes), parses in ~50ms.
 *
 * Exposes search-by-name and lookup-by-id so an LLM can answer "what is
 * Hollow Palm?" or "find all evasion nodes" without ever touching the calc
 * engine.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

/** Public node shape — normalized from PoB's raw JSON. */
export interface TreeNode {
  id: number;
  name: string;
  stats: string[];
  type: TreeNodeType;
  ascendancyName?: string;
  classStartIndex?: number;
  reminderText?: string[];
  flavourText?: string;
  /** Node IDs this node is directly connected to (undirected edges). */
  connections: number[];
}

export type TreeNodeType =
  | "keystone"
  | "notable"
  | "normal"
  | "ascendancy-notable"
  | "ascendancy-normal"
  | "jewel-socket"
  | "class-start"
  | "mastery";

interface RawNode {
  name?: string;
  stats?: string[];
  isKeystone?: boolean;
  isNotable?: boolean;
  isMastery?: boolean;
  isJewelSocket?: boolean;
  ascendancyName?: string;
  classStartIndex?: number;
  reminderText?: string[];
  flavourText?: string;
  connections?: Array<{ id: number; orbit?: number }>;
}

interface RawTree {
  nodes: Record<string, RawNode>;
}

interface CachedTree {
  raw: RawTree;
  byId: Map<number, TreeNode>;
  /** Pre-lowercased name → ids (multiple nodes may share a name). */
  byNameLower: Map<string, number[]>;
  /** All nodes as a flat array — handy for full scans. */
  all: TreeNode[];
}

const CACHE = new Map<string, CachedTree>();

/**
 * Load and cache a tree-data version. `version` is the directory name under
 * TreeData/ (e.g. "0_4"). `forkPath` is the absolute path to PoB2's `src/`.
 */
export function loadTree(forkPath: string, version = "0_4"): CachedTree {
  const cacheKey = `${forkPath}::${version}`;
  const hit = CACHE.get(cacheKey);
  if (hit) return hit;

  const treeJsonPath = path.join(forkPath, "TreeData", version, "tree.json");
  const raw = JSON.parse(readFileSync(treeJsonPath, "utf8")) as RawTree;

  const byId = new Map<number, TreeNode>();
  const byNameLower = new Map<string, number[]>();
  const all: TreeNode[] = [];

  // Two-pass build: first pass creates nodes with their directly-listed
  // outgoing connections; second pass computes the symmetric closure so
  // BFS works in either direction. (tree.json stores edges one-way: an
  // edge between A and B appears in only one of A.connections or
  // B.connections, never both.)
  for (const [idStr, n] of Object.entries(raw.nodes)) {
    const id = parseInt(idStr, 10);
    if (!Number.isFinite(id)) continue;
    if (!n.name) continue;

    const node: TreeNode = {
      id,
      name: n.name,
      stats: n.stats ?? [],
      type: classify(n),
      connections: Array.isArray(n.connections)
        ? n.connections.map((c) => c.id).filter((x) => Number.isFinite(x))
        : [],
      ...(n.ascendancyName ? { ascendancyName: n.ascendancyName } : {}),
      ...(n.classStartIndex !== undefined ? { classStartIndex: n.classStartIndex } : {}),
      ...(n.reminderText ? { reminderText: n.reminderText } : {}),
      ...(n.flavourText ? { flavourText: n.flavourText } : {}),
    };

    byId.set(id, node);
    const key = n.name.toLowerCase();
    const arr = byNameLower.get(key);
    if (arr) arr.push(id);
    else byNameLower.set(key, [id]);
    all.push(node);
  }

  // Symmetric closure: if A.connections contains B, ensure B.connections contains A.
  for (const node of all) {
    for (const otherId of node.connections) {
      const other = byId.get(otherId);
      if (other && !other.connections.includes(node.id)) {
        other.connections.push(node.id);
      }
    }
  }

  const cached: CachedTree = { raw, byId, byNameLower, all };
  CACHE.set(cacheKey, cached);
  return cached;
}

function classify(n: RawNode): TreeNodeType {
  if (n.isJewelSocket) return "jewel-socket";
  if (n.isMastery) return "mastery";
  if (n.classStartIndex !== undefined) return "class-start";
  if (n.ascendancyName) {
    return n.isNotable ? "ascendancy-notable" : "ascendancy-normal";
  }
  if (n.isKeystone) return "keystone";
  if (n.isNotable) return "notable";
  return "normal";
}

// ----- Lookup + search ------------------------------------------------------

/** O(1) lookup by node ID. */
export function getNode(forkPath: string, id: number, version = "0_4"): TreeNode | null {
  return loadTree(forkPath, version).byId.get(id) ?? null;
}

export interface SearchOptions {
  /** Default 20. */
  limit?: number;
  /** Restrict to node types. */
  types?: TreeNodeType[];
  /** Restrict to a specific ascendancy (case-insensitive). */
  ascendancy?: string;
  /** Also match against stat strings (slower but more useful). */
  matchStats?: boolean;
}

export interface SearchResult extends TreeNode {
  /** Why this matched: name | stats. */
  matchedOn: "name-exact" | "name-prefix" | "name-contains" | "stats";
  /** Naive rank score (higher = better). */
  score: number;
}

/**
 * Search for nodes by name (and optionally stats). Returns ranked results:
 * name-exact > name-prefix > name-contains > stats-substring.
 */
export function searchNodes(
  forkPath: string,
  query: string,
  options: SearchOptions = {},
  version = "0_4"
): SearchResult[] {
  const { limit = 20, types, ascendancy, matchStats = false } = options;
  const tree = loadTree(forkPath, version);
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const results: SearchResult[] = [];
  const ascLower = ascendancy?.toLowerCase();

  for (const node of tree.all) {
    if (types && !types.includes(node.type)) continue;
    if (ascLower && node.ascendancyName?.toLowerCase() !== ascLower) continue;

    const nameLower = node.name.toLowerCase();
    let matched: SearchResult["matchedOn"] | null = null;
    let score = 0;

    if (nameLower === q) {
      matched = "name-exact";
      score = 1000;
    } else if (nameLower.startsWith(q)) {
      matched = "name-prefix";
      score = 500 - (nameLower.length - q.length);
    } else if (nameLower.includes(q)) {
      matched = "name-contains";
      score = 250 - nameLower.indexOf(q);
    } else if (matchStats && node.stats.some((s) => s.toLowerCase().includes(q))) {
      matched = "stats";
      score = 100;
    }

    if (matched) {
      // Prefer keystones + notables — they're the named "important" nodes
      if (node.type === "keystone") score += 50;
      else if (node.type === "notable" || node.type === "ascendancy-notable") score += 25;
      results.push({ ...node, matchedOn: matched, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Resolve a mix of node IDs to their names/types. Useful for translating
 * a get_tree response into a human-readable summary.
 */
export function resolveNodes(
  forkPath: string,
  ids: readonly number[],
  version = "0_4"
): TreeNode[] {
  const tree = loadTree(forkPath, version);
  const out: TreeNode[] = [];
  for (const id of ids) {
    const n = tree.byId.get(id);
    if (n) out.push(n);
  }
  return out;
}

/**
 * Find the cheapest path from the current allocation to a target node.
 *
 * BFS over the tree treating each allocated node as a free starting point.
 * Returns the sequence of UNALLOCATED nodes that need to be allocated in
 * order to reach the target (including the target itself), plus the total
 * point cost (== path.length).
 *
 * Returns null if the target is unreachable, already allocated, or doesn't
 * exist in the tree. Excludes ascendancy + jewel-socket nodes from path
 * traversal unless they're already allocated — same routing rules PoB uses.
 */
export function findPathToNode(
  forkPath: string,
  allocated: ReadonlyArray<number>,
  targetId: number,
  options: { version?: string; maxHops?: number } = {}
): {
  path: TreeNode[];
  cost: number;
  /** Whether the target was already allocated (path = [], cost = 0). */
  alreadyAllocated: boolean;
} | null {
  const { version = "0_4", maxHops = 30 } = options;
  const tree = loadTree(forkPath, version);
  const target = tree.byId.get(targetId);
  if (!target) return null;
  const allocSet = new Set<number>(allocated);
  if (allocSet.has(targetId)) {
    return { path: [], cost: 0, alreadyAllocated: true };
  }

  // BFS with parent-pointer reconstruction
  const parent = new Map<number, number>(); // node → parent in BFS
  const visited = new Set<number>(allocSet);
  let frontier: number[] = [...allocSet];

  // Excluded types we won't path through
  const excludeFromPath = (id: number): boolean => {
    const n = tree.byId.get(id);
    if (!n) return true;
    // Allow traversal through already-allocated regardless; for unallocated,
    // skip ascendancy + jewel-sockets + class-starts.
    if (allocSet.has(id)) return false;
    return n.type === "ascendancy-normal" ||
      n.type === "ascendancy-notable" ||
      n.type === "class-start" ||
      n.type === "jewel-socket";
  };

  for (let depth = 0; depth < maxHops && frontier.length; depth++) {
    const next: number[] = [];
    for (const id of frontier) {
      const node = tree.byId.get(id);
      if (!node) continue;
      for (const conn of node.connections) {
        if (visited.has(conn)) continue;
        if (excludeFromPath(conn) && conn !== targetId) continue;
        visited.add(conn);
        parent.set(conn, id);
        if (conn === targetId) {
          // Reconstruct path: walk from target back to an allocated source
          const path: TreeNode[] = [];
          let cur: number | undefined = targetId;
          while (cur !== undefined && !allocSet.has(cur)) {
            const n = tree.byId.get(cur);
            if (!n) break;
            path.push(n);
            cur = parent.get(cur);
          }
          path.reverse();
          return { path, cost: path.length, alreadyAllocated: false };
        }
        next.push(conn);
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * BFS from a set of allocated nodes to find unallocated neighbors within
 * `maxDepth` hops. Treats `allocated` as the "free" path layer — neighbors
 * of allocated nodes that aren't themselves allocated are candidates.
 *
 * `maxDepth=1` returns only immediate neighbors of the current tree.
 * `maxDepth=2` includes one-step-removed nodes (you'd need to also allocate
 * an intermediate to actually reach them — not handled here, just listed).
 */
export function findCandidateNeighbors(
  forkPath: string,
  allocated: ReadonlyArray<number>,
  maxDepth = 1,
  options: { excludeTypes?: TreeNodeType[]; version?: string } = {}
): TreeNode[] {
  const { excludeTypes = ["jewel-socket", "class-start"], version = "0_4" } = options;
  const tree = loadTree(forkPath, version);
  const allocatedSet = new Set<number>(allocated);
  const seen = new Set<number>(allocatedSet);
  const candidates = new Set<number>();

  // BFS: frontier starts at allocated nodes
  let frontier: number[] = [...allocatedSet];
  for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
    const next: number[] = [];
    for (const id of frontier) {
      const node = tree.byId.get(id);
      if (!node) continue;
      for (const conn of node.connections) {
        if (seen.has(conn)) continue;
        seen.add(conn);
        next.push(conn);
        if (!allocatedSet.has(conn)) candidates.add(conn);
      }
    }
    frontier = next;
  }

  const excludeSet = new Set<TreeNodeType>(excludeTypes);
  const out: TreeNode[] = [];
  for (const id of candidates) {
    const node = tree.byId.get(id);
    if (!node) continue;
    if (excludeSet.has(node.type)) continue;
    // Skip ascendancy nodes by default — they need their own routing logic
    if (node.type === "ascendancy-normal" || node.type === "ascendancy-notable") continue;
    out.push(node);
  }
  return out;
}
