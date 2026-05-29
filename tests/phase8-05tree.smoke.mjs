/**
 * 0.5 tree readiness smoke: verify our STATIC tree tools work on the
 * GGG-derived 0_5 tree.json (no calc engine involved).
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadTree, searchNodes, findPathToNode } from "../build/treeData.js";
import { loadClasses, findAscendancy } from "../build/classes.js";
import { loadRawTree, renderTreeSvg } from "../build/treeSvg.js";

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";

console.log("=== loadTree('0_5') ===");
const tree = loadTree(forkPath, "0_5");
console.log(`  ${tree.all.length} nodes loaded`);

// 1. Find Martial Artist nodes (the headline new ascendancy).
//    Ascendancy notables are typed "ascendancy-notable".
console.log("\n=== Martial Artist ascendancy nodes ===");
const maNodes = tree.all.filter((n) => n.ascendancyName === "Martial Artist");
console.log(`  ${maNodes.length} nodes`);
for (const n of maNodes.filter((n) => n.type === "ascendancy-notable")) {
  console.log(`  [${n.type}] ${n.name}:`);
  for (const s of (n.stats ?? []).slice(0, 3)) console.log(`      ${s}`);
}

// 2. Spirit Walker (Huntress new ascendancy)
console.log("\n=== Spirit Walker notables ===");
const swNodes = tree.all.filter((n) => n.ascendancyName === "Spirit Walker" && n.type === "ascendancy-notable");
for (const n of swNodes) console.log(`  ${n.name}: ${(n.stats ?? [])[0] ?? ""}`);

// 3. Class enumeration
console.log("\n=== list_classes('0_5') ===");
const classes = loadClasses(forkPath, "0_5");
for (const c of classes) {
  console.log(`  ${c.name}: ${c.ascendancies.map((a) => a.name).filter(Boolean).join(", ")}`);
}
const ma = findAscendancy(forkPath, "Monk", "Martial Artist", "0_5");
console.log(`  findAscendancy(Monk, Martial Artist) → ${ma ? `internalId=${ma.internalId}, ascendClassId=${ma.ascendClassId}` : "NOT FOUND ✗"}`);

// 4. search_tree_nodes for a new keyword
console.log("\n=== search 'Runic Ward' nodes (matchStats) ===");
const runic = searchNodes(forkPath, "Runic Ward", { limit: 8, matchStats: true }, "0_5");
console.log(`  ${runic.length} matches`);
for (const n of runic.slice(0, 6)) console.log(`  [${n.type}] ${n.name}`);

// 5. find_path_to_node — path from a Monk start toward a Martial Artist notable
console.log("\n=== find_path_to_node (Monk → first Martial Artist notable) ===");
const maNotable = maNodes.find((n) => n.type === "ascendancy-notable");
if (maNotable) {
  // Monk class start node id — search for SIX/class-start. Use a known Monk-area node.
  const monkStart = tree.all.find((n) => (n.classStartIndex != null));
  if (monkStart) {
    const pathRes = findPathToNode(forkPath, [monkStart.id], maNotable.id, { version: "0_5", maxHops: 60 });
    console.log(`  target '${maNotable.name}': ${pathRes ? `${pathRes.cost} hops` : "unreachable (ascendancy nodes are isolated subgraph — expected)"}`);
  }
}

// 6. Render SVG for a hypothetical Martial Artist allocation
console.log("\n=== renderTreeSvg on 0_5 ===");
const raw = loadRawTree(forkPath, "0_5");
const sampleAlloc = new Set(maNodes.slice(0, 5).map((n) => n.id));
const svg = renderTreeSvg(raw, { allocated: sampleAlloc, ascendancyName: "Martial Artist", width: 1000 });
console.log(`  SVG: ${(svg.length / 1024).toFixed(0)}KB, starts: ${svg.slice(0, 60)}...`);
const allocCircles = (svg.match(/class="(na|nta|ka)"/g) ?? []).length;
console.log(`  highlighted nodes in SVG: ${allocCircles} (allocated ${sampleAlloc.size})`);

console.log("\n=== 0.5 static-tree smoke complete ===");
