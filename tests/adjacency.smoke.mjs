/**
 * Phase 6A pre-flight: verify tree adjacency + neighbor finding.
 * No Lua bridge needed — pure static-data test.
 */
import { loadTree, findCandidateNeighbors, resolveNodes } from "../build/treeData.js";

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const tree = loadTree(forkPath, "0_4");

// Use the Monk lvl 13 fixture's allocated nodes
const allocated = [7576, 10364, 12925, 14725, 27910, 32545, 33866, 34233, 36479, 36931, 38676, 42857, 44683, 49220, 53938, 56045, 61196];
console.log(`Allocated: ${allocated.length} nodes`);

console.log("\n=== Spot-check: connections of node 36931 'Concussive Attack' ===");
const n = tree.byId.get(36931);
console.log(`  ${n.name} connects to: ${n.connections.join(", ")}`);
for (const c of n.connections) {
  const cn = tree.byId.get(c);
  console.log(`    └─ ${c}: ${cn?.name ?? "(unknown)"} (${cn?.type})`);
}

console.log("\n=== findCandidateNeighbors (maxDepth=1) — adjacent to current tree ===");
const direct = findCandidateNeighbors(forkPath, allocated, 1);
console.log(`  ${direct.length} candidates 1 hop from current allocation`);
// Show first 10 by type
const byType = {};
for (const c of direct) byType[c.type] = (byType[c.type] ?? 0) + 1;
console.log(`  by type:`, byType);
console.log(`  notable samples:`);
for (const c of direct.filter(c => c.type === "notable").slice(0, 5)) {
  const stat = c.stats[0] ?? "(no stat)";
  console.log(`    ★ ${c.id} ${c.name} — ${stat}`);
}
console.log(`  normal samples:`);
for (const c of direct.filter(c => c.type === "normal").slice(0, 5)) {
  const stat = c.stats[0] ?? "(no stat)";
  console.log(`    · ${c.id} ${c.name} — ${stat}`);
}

console.log("\n=== findCandidateNeighbors (maxDepth=2) — wider reach ===");
const d2 = findCandidateNeighbors(forkPath, allocated, 2);
console.log(`  ${d2.length} candidates within 2 hops (vs ${direct.length} at depth 1)`);

console.log("\n=== Sanity: no allocated node is in the candidate set ===");
const allocSet = new Set(allocated);
const leak = direct.find(c => allocSet.has(c.id));
console.log(`  leak? ${leak ? "✗ " + leak.id : "✓ none"}`);
