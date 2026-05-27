/**
 * Phase 4E smoke: synthesized theorycraft tools.
 *   - find_dead_nodes: identify allocated passives that don't pull weight
 *   - simulate_level_up: stat sheets at 30 / 60 / 90
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { LuaBridge } from "../build/luaBridge.js";
import { decodeBuildCode } from "../build/codec.js";
import { findDeadNodes, simulateLevelUp } from "../build/theorycraft.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildCode = readFileSync(path.join(here, "fixtures", "sample-build.code.txt"), "utf8").trim();
const xml = decodeBuildCode(buildCode);

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const bridge = new LuaBridge({ forkPath, timeoutMs: 60_000 });
await bridge.start();
await bridge.send({ action: "load_build_xml", params: { xml, name: "Monk lvl 13" } });

console.log("=== find_dead_nodes (Monk lvl 13, 17 nodes) ===");
const t0 = Date.now();
const dead = await findDeadNodes(bridge, forkPath);
console.log(`  analyzed ${dead.reportedNodes} nodes in ${dead.elapsedMs}ms`);
console.log(`  baseline: ${JSON.stringify(dead.baseline)}`);
console.log(`\n  Top 'dead weight' candidates (least painful to remove):`);
for (const c of dead.candidates.slice(0, 8)) {
  const stats = Object.entries(c.deltas).map(([k, v]) => `${k}:${v > 0 ? "+" : ""}${v}`).join(", ");
  const tag = c.node.type === "notable" ? "★" : c.node.type === "keystone" ? "◆" : "·";
  console.log(`  ${tag} score=${c.score.toFixed(2).padStart(8)}  id=${c.node.id.toString().padEnd(6)} "${c.node.name}"`);
  console.log(`      Δ ${stats}`);
}

console.log(`\n  Most-load-bearing (worst score = removing hurts most):`);
for (const c of dead.candidates.slice(-4).reverse()) {
  console.log(`  · score=${c.score.toFixed(2).padStart(8)}  id=${c.node.id.toString().padEnd(6)} "${c.node.name}"`);
}

console.log("\n=== simulate_level_up (30 / 60 / 90) ===");
const sim = await simulateLevelUp(bridge, [30, 60, 90]);
console.log(`  original level ${sim.original.level}: ${JSON.stringify(sim.original.stats)}`);
for (const s of sim.samples) {
  console.log(`  level ${s.level}: ${JSON.stringify(s.stats)}`);
}

// Verify restore: a follow-up get_stats should match the original
const back = await bridge.send({ action: "get_stats", params: { fields: ["Life", "Mana"] } });
console.log(`  after restore: Life=${back.stats.Life} (expected ${sim.original.stats.Life})  Mana=${back.stats.Mana}`);

await bridge.stop();
console.log("\n=== Phase 4E smoke complete ===");
