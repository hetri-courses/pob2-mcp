/**
 * Convert GGG's official passive-tree export (grindinggear/poe2-skilltree-export)
 * into the PoB-style tree.json our Node-side tools expect.
 *
 * Why: when a new PoE2 patch drops, GGG publishes the authoritative tree
 * export on GitHub immediately, but PoB's TreeData/<version>/tree.json can
 * lag hours-to-days. Our STATIC tree tools (search_tree_nodes, get_tree_node,
 * find_path_to_node, resolve_tree_nodes, treeSvg, list_classes) read tree.json
 * directly — they don't need PoB's calc engine. So this converter lets us do
 * full tree-level theorycraft on a new tree the moment GGG publishes it.
 *
 * NOTE: this does NOT make the calc engine understand the new patch. DPS/EHP
 * numbers still come from PoB's Lua formulas, which lag. This is tree
 * structure only — pathing, node stats, ascendancy layout, visualization.
 *
 * Schema differences handled:
 *   GGG node               →  PoB node
 *   ----------------------    ----------------------
 *   out[] + in[] (skillIds) →  connections: [{id}]
 *   ascendancyId "Monk1"    →  ascendancyName "Martial Artist" (via classes)
 *   x, y (precomputed)      →  kept (treeSvg prefers these over orbit math)
 *   keyed by skill number   →  keyed by skill number (same)
 *
 * GGG omits PoB's `constants` (orbitRadii, orbitAnglesByOrbit, skillsPerOrbit).
 * Those are PoE2 engine constants that don't change between patches, so we
 * copy them from an existing PoB tree (default 0_4). treeSvg prefers the
 * per-node x/y anyway, so this is belt-and-suspenders.
 *
 * Usage:
 *   node tools/ggg-to-pob-tree.mjs <ggg-data.json> <out-tree.json> [constants-source-tree.json]
 *
 * Example:
 *   node tools/ggg-to-pob-tree.mjs /tmp/0.5tree/data.json \
 *     pob2-fork/src/TreeData/0_5/tree.json \
 *     pob2-fork/src/TreeData/0_4/tree.json
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const [, , gggPath, outPath, constantsSrc] = process.argv;
if (!gggPath || !outPath) {
  console.error("Usage: node tools/ggg-to-pob-tree.mjs <ggg-data.json> <out-tree.json> [constants-source-tree.json]");
  process.exit(1);
}

const ggg = JSON.parse(readFileSync(gggPath, "utf8"));

// Build ascendancyId → display name map from the classes block.
// e.g. "Monk1" → "Martial Artist"
const ascIdToName = new Map();
for (const cls of ggg.classes ?? []) {
  for (const asc of cls.ascendancies ?? []) {
    if (asc.id && asc.name) ascIdToName.set(asc.id, asc.name);
  }
}

// Convert nodes. GGG keys by skill number string; keep that key.
const nodes = {};
let nodeCount = 0;
let edgeCount = 0;
for (const [key, n] of Object.entries(ggg.nodes ?? {})) {
  // union of out + in gives all neighbours (PoB stores undirected `connections`)
  const neighbourIds = new Set();
  for (const o of n.out ?? []) neighbourIds.add(Number(o));
  for (const i of n.in ?? []) neighbourIds.add(Number(i));
  const connections = [...neighbourIds].map((id) => ({ id }));
  edgeCount += connections.length;

  const out = {
    name: n.name,
    icon: n.icon,
    stats: n.stats ?? [],
    group: n.group,
    orbit: n.orbit,
    orbitIndex: n.orbitIndex,
    // GGG precomputes absolute coords — keep them; treeSvg prefers these.
    x: n.x,
    y: n.y,
    connections,
  };
  if (n.isNotable) out.isNotable = true;
  if (n.isKeystone) out.isKeystone = true;
  if (n.isMastery) out.isMastery = true;
  if (n.isJewelSocket) out.isJewelSocket = true;
  if (n.isAscendancyStart) out.isAscendancyStart = true;
  if (n.ascendancyId) {
    out.ascendancyName = ascIdToName.get(n.ascendancyId) ?? n.ascendancyId;
  }
  if (n.classStartIndex != null) out.classStartIndex = n.classStartIndex;
  if (n.flavourText) out.flavourText = n.flavourText;
  if (n.reminderText) out.reminderText = n.reminderText;
  if (n.skill != null) out.skill = n.skill;

  nodes[key] = out;
  nodeCount++;
}

// Convert groups. GGG: {x, y, orbits, nodes:[strings]} → PoB: nodes as numbers.
const groups = {};
for (const [gid, grp] of Object.entries(ggg.groups ?? {})) {
  groups[gid] = {
    x: grp.x,
    y: grp.y,
    orbits: grp.orbits ?? [],
    nodes: (grp.nodes ?? []).map(Number),
  };
}

// Convert classes. Our classes.ts wants:
//   { name, integerId, base_str, base_dex, base_int,
//     ascendancies: [{ id: <displayName>, internalId: <gggId>, name }] }
// GGG omits integerId; assign from PoB's known mapping where possible,
// else a stable index. Only emit playable classes (those with ascendancies).
const POB_INTEGER_IDS = {
  Witch: 1, Ranger: 2, IntClass: 3, Warrior: 6, Sorceress: 7,
  Huntress: 8, Mercenary: 9, Monk: 10, Druid: 11,
};
let fallbackId = 100;
const classes = [];
for (const cls of ggg.classes ?? []) {
  if (!cls.ascendancies || cls.ascendancies.length === 0) continue; // skip legacy/unreleased
  classes.push({
    name: cls.name,
    integerId: POB_INTEGER_IDS[cls.name] ?? fallbackId++,
    base_str: cls.base_str ?? 0,
    base_dex: cls.base_dex ?? 0,
    base_int: cls.base_int ?? 0,
    ascendancies: cls.ascendancies.map((a) => ({
      id: a.name,         // PoB uses display name as `id`
      internalId: a.id,   // GGG's "Monk1" etc — trailing int = ascendClassId
      name: a.name,
    })),
  });
}

// Reuse engine constants from an existing PoB tree (orbit geometry is stable).
let constants = {};
if (constantsSrc) {
  try {
    const src = JSON.parse(readFileSync(constantsSrc, "utf8"));
    constants = src.constants ?? {};
  } catch (e) {
    console.warn(`Could not read constants from ${constantsSrc}: ${e.message}`);
  }
}

const outTree = {
  tree: ggg.tree ?? "Default",
  classes,
  groups,
  nodes,
  constants,
  jewelSlots: ggg.jewelSlots ?? [],
  min_x: ggg.min_x,
  max_x: ggg.max_x,
  min_y: ggg.min_y,
  max_y: ggg.max_y,
  // marker so it's obvious this was synthesized, not shipped by PoB
  _synthesizedFrom: "grindinggear/poe2-skilltree-export",
};

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(outTree), "utf8");

console.log(`Converted GGG export → ${outPath}`);
console.log(`  nodes:   ${nodeCount}`);
console.log(`  edges:   ${edgeCount} (directed; ~${Math.round(edgeCount / 2)} undirected)`);
console.log(`  groups:  ${Object.keys(groups).length}`);
console.log(`  classes: ${classes.length} playable`);
for (const c of classes) {
  console.log(`    ${c.name} (id=${c.integerId}): ${c.ascendancies.map((a) => a.name).join(", ")}`);
}
console.log(`  constants: ${Object.keys(constants).length ? "copied" : "MISSING (pass constants-source)"}`);
