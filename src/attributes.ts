/**
 * Attribute-requirement logic, shared by the tree allocator (buildGen) and the
 * build-guide pipeline (build-ma-guide).
 *
 * Why this exists
 * ---------------
 * A build's gems and gear impose attribute requirements (reqStr / reqDex /
 * reqInt). If the character doesn't meet a requirement, that gem or item is
 * unusable — so attributes are hard dependencies, not flavour. PoE2 supplies
 * attributes through the passive tree and gear:
 *   - typed nodes:   "+N to Strength" / "Dexterity" / "Intelligence"
 *   - generic nodes: "+N to any Attribute"  (you CHOOSE Str/Dex/Int per node)
 *   - all nodes:     "+N to all Attributes"
 *   - notable riders: a notable's stat block may also grant "+N to <attr>"
 *
 * Two tree nodes change the requirement math:
 *   - Adaptive Capability (53108): "Attribute Requirements of Gems can be
 *     satisfied by your highest Attribute". A Dex/Int Monk can then run 100-Str
 *     supports (Brutality, the lineage supports) WITHOUT speccing Strength —
 *     its high Int covers the gem's Str requirement. Applies to GEMS ONLY.
 *   - "% reduced Attribute Requirements" nodes (minor, ~4% each).
 *
 * Gear requirements are NOT covered by Adaptive Capability — only gems.
 *
 * Requirements are a MAX, not a sum: meeting the single highest reqStr across
 * everything equipped satisfies every individual reqStr.
 */

import { loadTree, type TreeNode } from "./treeData.js";
import { DEFAULT_TREE_VERSION } from "./treeData.js";
import { getGem } from "./gemData.js";

/** Notable "Adaptive Capability" — gem attribute reqs met by highest attribute. */
export const ADAPTIVE_CAPABILITY_NODE = 53108;

export interface AttrTriple {
  str: number;
  dex: number;
  int: number;
}

/** Flat attribute grant of a single node (any = assignable "+N to any Attribute"). */
export interface AttribGrant extends AttrTriple {
  any: number;
}

// Matches "+8 to Strength", "+5 to all Attributes", "+5 to any Attribute",
// "+5 to Strength and Dexterity", etc., anywhere in a stat line.
const ATTR_RE =
  /\+(\d+)\s+to\s+(Strength and Dexterity|Strength and Intelligence|Dexterity and Intelligence|all Attributes|any Attribute|Strength|Dexterity|Intelligence)/gi;

/** Parse the Str/Dex/Int/any-attribute a node grants from its stat lines. */
export function nodeAttribGrant(stats: readonly string[] | undefined): AttribGrant {
  const g: AttribGrant = { str: 0, dex: 0, int: 0, any: 0 };
  for (const line of stats ?? []) {
    for (const m of line.matchAll(ATTR_RE)) {
      const n = Number(m[1]);
      switch (m[2].toLowerCase()) {
        case "strength": g.str += n; break;
        case "dexterity": g.dex += n; break;
        case "intelligence": g.int += n; break;
        case "all attributes": g.str += n; g.dex += n; g.int += n; break;
        case "any attribute": g.any += n; break;
        case "strength and dexterity": g.str += n; g.dex += n; break;
        case "strength and intelligence": g.str += n; g.int += n; break;
        case "dexterity and intelligence": g.dex += n; g.int += n; break;
      }
    }
  }
  return g;
}

export interface AttribCatalog {
  /** Node ids granting ONLY "+N to any Attribute" (the assignable ones). */
  generic: number[];
  /** Pure typed nodes (named exactly "Strength"/"Dexterity"/"Intelligence"). */
  typedStr: number[];
  typedDex: number[];
  typedInt: number[];
  /** "+N to all Attributes" nodes. */
  allAttr: number[];
  /** Adaptive Capability node id if present in this tree, else null. */
  adaptiveCapabilityId: number | null;
  /** "% reduced Attribute Requirements" node ids. */
  reducerIds: number[];
}

const CATALOG_CACHE = new Map<string, AttribCatalog>();

/** Classify every attribute-relevant node in a tree version (cached). */
export function buildAttribCatalog(forkPath: string, version = DEFAULT_TREE_VERSION): AttribCatalog {
  const key = `${forkPath}::${version}`;
  const hit = CATALOG_CACHE.get(key);
  if (hit) return hit;

  const tree = loadTree(forkPath, version);
  const cat: AttribCatalog = {
    generic: [], typedStr: [], typedDex: [], typedInt: [],
    allAttr: [], adaptiveCapabilityId: null, reducerIds: [],
  };

  // Pure attribute nodes have a single stat line matching exactly one of these.
  // Notables with an attribute rider (e.g. "10% increased Attack Speed | +5 to
  // Dexterity") are deliberately excluded — they're picked for their main stat,
  // not as attribute filler.
  const PURE_ANY = /^\+\d+ to any Attribute$/i;
  const PURE_STR = /^\+\d+ to Strength$/i;
  const PURE_DEX = /^\+\d+ to Dexterity$/i;
  const PURE_INT = /^\+\d+ to Intelligence$/i;
  const PURE_ALL = /^\+\d+ to all Attributes$/i;

  for (const node of tree.all) {
    if (node.id === ADAPTIVE_CAPABILITY_NODE) cat.adaptiveCapabilityId = node.id;
    const stats = node.stats ?? [];
    if (stats.join(" ").toLowerCase().includes("reduced attribute requirements")) {
      cat.reducerIds.push(node.id);
    }
    if (stats.length !== 1) continue;
    const s = stats[0];
    if (PURE_ANY.test(s)) cat.generic.push(node.id);
    else if (PURE_STR.test(s)) cat.typedStr.push(node.id);
    else if (PURE_DEX.test(s)) cat.typedDex.push(node.id);
    else if (PURE_INT.test(s)) cat.typedInt.push(node.id);
    else if (PURE_ALL.test(s)) cat.allAttr.push(node.id);
  }

  CATALOG_CACHE.set(key, cat);
  return cat;
}

/**
 * The attribute FLOOR a set of gems imposes: the max reqStr / reqDex / reqInt
 * across the gems (requirements are a max, not a sum). Unknown gems are skipped.
 */
export function gemAttribFloor(forkPath: string, gemNames: readonly string[]): AttrTriple {
  const floor: AttrTriple = { str: 0, dex: 0, int: 0 };
  for (const name of gemNames) {
    const gem = getGem(forkPath, name);
    if (!gem) continue;
    floor.str = Math.max(floor.str, gem.reqStr ?? 0);
    floor.dex = Math.max(floor.dex, gem.reqDex ?? 0);
    floor.int = Math.max(floor.int, gem.reqInt ?? 0);
  }
  return floor;
}

export type AttrKey = "str" | "dex" | "int";

/** The single largest requirement across all three attributes. */
export function maxReq(t: AttrTriple): number {
  return Math.max(t.str, t.dex, t.int);
}

export interface GemAttribPlan {
  /** Raw gem floor (max reqStr/Dex/Int across the gem set). */
  gemFloor: AttrTriple;
  /** Whether Adaptive Capability is in play (gem reqs met by highest attribute). */
  adaptiveCapability: boolean;
  /**
   * Effective binding requirement on each attribute FROM GEMS:
   *  - without Adaptive Capability: equals gemFloor (each attr must be met).
   *  - with Adaptive Capability: gem reqs collapse onto the single highest
   *    attribute, so only `highestAttrFloor` matters and per-attr gem reqs are 0.
   */
  perAttr: AttrTriple;
  /** With Adaptive Capability, the value your HIGHEST attribute must reach. */
  highestAttrFloor: number;
  /** Human-readable explanation for guides. */
  note: string;
}

/**
 * Resolve what a gem set actually demands, accounting for Adaptive Capability.
 * `hasAdaptiveCapability` should reflect whether node 53108 is allocated.
 */
export function planGemAttributes(
  forkPath: string,
  gemNames: readonly string[],
  hasAdaptiveCapability: boolean
): GemAttribPlan {
  const gemFloor = gemAttribFloor(forkPath, gemNames);
  const hi = maxReq(gemFloor);
  if (hasAdaptiveCapability) {
    return {
      gemFloor,
      adaptiveCapability: true,
      perAttr: { str: 0, dex: 0, int: 0 },
      highestAttrFloor: hi,
      note:
        hi > 0
          ? `Gem requirements (up to ${hi}) are met by your highest attribute via Adaptive Capability — no dedicated Str/Dex/Int needed for gems.`
          : "No gem attribute requirements.",
    };
  }
  return {
    gemFloor,
    adaptiveCapability: false,
    perAttr: { ...gemFloor },
    highestAttrFloor: hi,
    note:
      hi > 0
        ? `Without Adaptive Capability you must hit each gem requirement directly: Str ${gemFloor.str}, Dex ${gemFloor.dex}, Int ${gemFloor.int}.`
        : "No gem attribute requirements.",
  };
}

/** Sum the typed/all attribute grants from a set of allocated node ids (ignores generic "any"). */
export function fixedAttribsFromNodes(
  forkPath: string,
  nodeIds: Iterable<number>,
  version = DEFAULT_TREE_VERSION
): AttribGrant {
  const tree = loadTree(forkPath, version);
  const total: AttribGrant = { str: 0, dex: 0, int: 0, any: 0 };
  for (const id of nodeIds) {
    const node: TreeNode | undefined = tree.byId.get(id);
    if (!node) continue;
    const g = nodeAttribGrant(node.stats);
    total.str += g.str; total.dex += g.dex; total.int += g.int; total.any += g.any;
  }
  return total;
}
