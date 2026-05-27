/**
 * Phase 4A smoke test (no Lua bridge needed — pure Node-side static data).
 */
import { loadTree, getNode, searchNodes, resolveNodes } from "../build/treeData.js";

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";

console.log("=== Load tree data ===");
const t0 = Date.now();
const tree = loadTree(forkPath, "0_4");
console.log(`Loaded in ${Date.now() - t0}ms`);
console.log(`Total nodes: ${tree.all.length}`);
console.log(`By type:`);
const counts = tree.all.reduce((acc, n) => {
  acc[n.type] = (acc[n.type] ?? 0) + 1;
  return acc;
}, {});
for (const [type, n] of Object.entries(counts)) console.log(`  ${type}: ${n}`);

console.log("\n=== Search: 'hollow palm' ===");
let hits = searchNodes(forkPath, "hollow palm");
for (const h of hits.slice(0, 5)) {
  console.log(`  [${h.matchedOn} score=${h.score}] id=${h.id} ${h.name} (${h.type})`);
  for (const s of h.stats.slice(0, 2)) console.log(`    └─ ${s}`);
}

console.log("\n=== Search: 'tempest bell' ===");
hits = searchNodes(forkPath, "tempest bell");
for (const h of hits.slice(0, 5)) {
  console.log(`  [${h.matchedOn}] id=${h.id} ${h.name} (${h.type})${h.ascendancyName ? " [" + h.ascendancyName + "]" : ""}`);
  for (const s of h.stats.slice(0, 2)) console.log(`    └─ ${s}`);
}

console.log("\n=== Search 'lightning' restricted to keystones ===");
hits = searchNodes(forkPath, "lightning", { types: ["keystone"], limit: 5 });
for (const h of hits) {
  console.log(`  id=${h.id} ${h.name}`);
  for (const s of h.stats.slice(0, 2)) console.log(`    └─ ${s}`);
}

console.log("\n=== Search 'zealot' ===");
hits = searchNodes(forkPath, "zealot");
for (const h of hits.slice(0, 3)) {
  console.log(`  [${h.matchedOn}] id=${h.id} ${h.name} (${h.type})`);
  for (const s of h.stats) console.log(`    └─ ${s}`);
}

console.log("\n=== Lookup the Monk lvl 13 fixture's allocated nodes ===");
// From earlier get_tree result: [7576, 10364, 12925, 14725, 27910, 32545, 33866, ...]
const allocated = [7576, 10364, 12925, 14725, 27910, 32545, 33866, 34233, 36479, 36931, 38676, 42857, 44683, 49220, 53938, 56045, 61196];
const resolved = resolveNodes(forkPath, allocated);
for (const n of resolved) {
  const stat = n.stats[0] ? ` — ${n.stats[0]}` : "";
  console.log(`  id=${n.id} (${n.type}) "${n.name}"${stat}`);
}

console.log("\n=== Search by stat: 'attack speed' (matchStats=true) ===");
hits = searchNodes(forkPath, "attack speed", { matchStats: true, types: ["notable"], limit: 5 });
for (const h of hits) {
  console.log(`  [${h.matchedOn}] id=${h.id} ${h.name}`);
  for (const s of h.stats.slice(0, 2)) console.log(`    └─ ${s}`);
}

console.log("\n=== Done. Cache test: re-load should be instant ===");
const t1 = Date.now();
loadTree(forkPath, "0_4");
console.log(`Re-load: ${Date.now() - t1}ms (cached)`);
