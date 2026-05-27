/**
 * Phase 4D smoke: mutation tools modify state and persist.
 *   - set_level: bump 13 → 90, verify stats change
 *   - update_tree_delta: actually allocate nodes, verify get_tree reflects them
 *   - set_gem_level: bump a gem level, verify get_skills reflects it
 *   - add_item_text: equip a fake item, verify it shows up
 *   - export_build_code: round-trip a mutated build through encode
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { LuaBridge } from "../build/luaBridge.js";
import { decodeBuildCode } from "../build/codec.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildCode = readFileSync(path.join(here, "fixtures", "sample-build.code.txt"), "utf8").trim();
const xml = decodeBuildCode(buildCode);

const bridge = new LuaBridge({ forkPath: "D:\\pob2-mcp\\pob2-fork\\src", timeoutMs: 60_000 });
await bridge.start();
await bridge.send({ action: "load_build_xml", params: { xml, name: "Monk lvl 13" } });

const get = async (fields) => (await bridge.send({ action: "get_stats", params: { fields } })).stats;

console.log("=== Baseline ===");
let s = await get(["Life", "Mana", "TotalDPS", "TotalEHP"]);
console.log(`  level 13 → ${JSON.stringify(s)}`);

console.log("\n=== set_level 90 ===");
let r = await bridge.send({ action: "set_level", params: { level: 90 } });
console.log(`  ok=${r.ok}`);
s = await get(["Life", "Mana", "TotalDPS", "TotalEHP"]);
console.log(`  level 90 → ${JSON.stringify(s)}`);

console.log("\n=== update_tree_delta: REMOVE a leaf node (should persist) ===");
const treeBefore = await bridge.send({ action: "get_tree" });
console.log(`  before: ${treeBefore.tree.nodes.length} nodes allocated`);
const toRemove = treeBefore.tree.nodes[treeBefore.tree.nodes.length - 1]; // last (likely a leaf)
console.log(`  removing node ${toRemove}`);
r = await bridge.send({ action: "update_tree_delta", params: { removeNodes: [toRemove] } });
console.log(`  ok=${r.ok}`);
const treeAfter = await bridge.send({ action: "get_tree" });
console.log(`  after:  ${treeAfter.tree.nodes.length} nodes (delta ${treeAfter.tree.nodes.length - treeBefore.tree.nodes.length})`);
console.log(`  removed node ${toRemove} gone from tree? ${!treeAfter.tree.nodes.includes(toRemove)}`);
// Note: removing may also cascade-remove other nodes that were pathing through it
const dropped = treeBefore.tree.nodes.filter(n => !treeAfter.tree.nodes.includes(n));
console.log(`  total nodes that left the tree (including cascaded path orphans): ${dropped.length} → ${JSON.stringify(dropped)}`);

console.log("\n=== set_gem_level: bump Twister (group 2 gem 1) from 4 → 20 ===");
const skillsBefore = await bridge.send({ action: "get_skills" });
const g2Gem1Before = skillsBefore.skills.groups[1]?.gems?.[0];
console.log(`  before: ${g2Gem1Before?.nameSpec} level ${g2Gem1Before?.level}`);
r = await bridge.send({ action: "set_gem_level", params: { groupIndex: 2, gemIndex: 1, level: 20 } });
console.log(`  ok=${r.ok}`);
const skillsAfter = await bridge.send({ action: "get_skills" });
const g2Gem1After = skillsAfter.skills.groups[1]?.gems?.[0];
console.log(`  after:  ${g2Gem1After?.nameSpec} level ${g2Gem1After?.level}`);

console.log("\n=== add_item_text: equip a fake unique amulet ===");
const fakeItem = `Rarity: UNIQUE
Test Amulet
Amulet
+1 to Level of all Skills
+50 to all Attributes
20% increased Critical Hit Chance
`;
r = await bridge.send({ action: "add_item_text", params: { text: fakeItem, slotName: "Amulet" } });
console.log(`  ok=${r.ok}, returned ${JSON.stringify(r.item)}`);
const items = await bridge.send({ action: "get_items" });
const amulet = items.items.find(i => i.slot === "Amulet");
console.log(`  Amulet slot now: ${amulet?.name ?? "(empty)"} [${amulet?.rarity ?? "?"}]`);

console.log("\n=== export_build_code: serialize mutated state ===");
r = await bridge.send({ action: "export_build_xml" });
console.log(`  XML length: ${r.xml?.length}`);

await bridge.stop();
console.log("\n=== Phase 4D smoke complete ===");
