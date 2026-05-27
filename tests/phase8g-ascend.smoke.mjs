/**
 * Phase 8G.7: figure out how to actually activate an ascendancy.
 *
 * Theory: PoB stores ascendClassId only after at least one node from that
 * ascendancy's subtree is allocated. Test by:
 *   1. set class with ascendClassId=2 (Invoker) — observe what sticks
 *   2. find an Invoker ascendancy start node from tree.json
 *   3. allocate it, observe what changes
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { LuaBridge } from "../build/luaBridge.js";

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const raw = JSON.parse(readFileSync(path.join(forkPath, "TreeData", "0_4", "tree.json"), "utf8"));

// Find Invoker nodes
const invokerNodes = [];
for (const [idStr, n] of Object.entries(raw.nodes)) {
  if (n.ascendancyName === "Invoker") {
    invokerNodes.push({
      id: Number(idStr),
      name: n.name,
      type: n.isKeystone ? "keystone" : n.isNotable ? "notable" : n.isAscendancyStart ? "ASC_START" : "normal",
      isAscendancyStart: !!n.isAscendancyStart,
    });
  }
}
console.log(`Found ${invokerNodes.length} Invoker ascendancy nodes`);
const starts = invokerNodes.filter((n) => n.isAscendancyStart);
console.log("Ascendancy start nodes:", starts);
const normals = invokerNodes.filter((n) => n.type === "normal" && !n.isAscendancyStart);
console.log(`Sample first 5 normal Invoker nodes:`, normals.slice(0, 5));

// Probe with bridge
const b = new LuaBridge({ forkPath, timeoutMs: 30_000 });
await b.start();

await b.send({ action: "new_build" });

console.log("\n=== Attempt 1: just set class without ascendancy ===");
const r1 = await b.send({
  action: "update_tree_delta",
  params: { className: "Monk" },
});
console.log("  tree:", JSON.stringify(r1.tree).slice(0, 200));

console.log("\n=== Attempt 2: set class + ascendClassId=2 (Invoker) ===");
const r2 = await b.send({
  action: "update_tree_delta",
  params: { className: "Monk", ascendClassId: 2 },
});
console.log("  tree:", JSON.stringify(r2.tree).slice(0, 200));

if (starts.length > 0) {
  console.log("\n=== Attempt 3: allocate the Invoker ascendancy start node ===");
  const r3 = await b.send({
    action: "update_tree_delta",
    params: { className: "Monk", ascendClassId: 2, addNodes: [starts[0].id] },
  });
  console.log("  tree:", JSON.stringify(r3.tree).slice(0, 300));
}

// Also try: allocate any Invoker node
if (normals.length > 0) {
  console.log("\n=== Attempt 4: allocate a normal Invoker node directly ===");
  await b.send({ action: "new_build" });
  await b.send({ action: "update_tree_delta", params: { className: "Monk" } });
  const r4 = await b.send({
    action: "update_tree_delta",
    params: { ascendClassId: 2, addNodes: [normals[0].id] },
  });
  console.log("  tree:", JSON.stringify(r4.tree).slice(0, 300));

  // Verify Invoker is "set" by exporting XML
  const exp = await b.send({ action: "export_build_xml" });
  const ascMatch = /ascendClassName="([^"]*)"/.exec(exp.xml || "");
  console.log(`  XML ascendClassName="${ascMatch?.[1]}"`);
}

await b.stop();
