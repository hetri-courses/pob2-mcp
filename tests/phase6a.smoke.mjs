/**
 * Phase 6A smoke: suggest_node_swaps on the real Monk lvl 13 fixture.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { LuaBridge } from "../build/luaBridge.js";
import { decodeBuildCode } from "../build/codec.js";
import { suggestNodeSwaps } from "../build/theorycraft.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildCode = readFileSync(path.join(here, "fixtures", "sample-build.code.txt"), "utf8").trim();
const xml = decodeBuildCode(buildCode);

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const bridge = new LuaBridge({ forkPath, timeoutMs: 60_000 });
await bridge.start();
await bridge.send({ action: "load_build_xml", params: { xml, name: "Monk lvl 13" } });

// Capture baseline first, so we can confirm non-persistence after
const baseline = await bridge.send({
  action: "get_stats",
  params: { fields: ["TotalDPS", "Life", "TotalEHP"] },
});
console.log(`Baseline (for non-persistence check): ${JSON.stringify(baseline.stats)}`);

console.log("\n=== suggest_node_swaps (target=TotalDPS, depth=2) ===");
const dpsSwaps = await suggestNodeSwaps(bridge, forkPath, {
  targetMetric: "TotalDPS",
  maxDepth: 2,
  maxCandidates: 30,
  limit: 8,
});
console.log(`  baseline TotalDPS=${dpsSwaps.baseline}`);
console.log(`  considered: ${JSON.stringify(dpsSwaps.considered)}`);
console.log(`  elapsed: ${dpsSwaps.elapsedMs}ms`);
console.log(`\n  Top proposals:`);
for (const [i, p] of dpsSwaps.proposals.entries()) {
  const sign = p.delta > 0 ? "+" : "";
  console.log(
    `  ${i + 1}. drop ${p.drop.id} '${p.drop.name}' (${p.drop.type})`
  );
  console.log(
    `     add  ${p.add.id} '${p.add.name}' (${p.add.type}) → DPS ${dpsSwaps.baseline} → ${p.afterValue} (${sign}${p.delta}${p.pct != null ? ", " + p.pct + "%" : ""})`
  );
  if (p.add.stats[0]) console.log(`     stat: ${p.add.stats[0]}`);
}

console.log("\n=== suggest_node_swaps (target=TotalEHP) ===");
const ehpSwaps = await suggestNodeSwaps(bridge, forkPath, {
  targetMetric: "TotalEHP",
  maxDepth: 2,
  limit: 5,
});
console.log(`  baseline TotalEHP=${ehpSwaps.baseline}`);
console.log(`  Top proposals:`);
for (const p of ehpSwaps.proposals) {
  const sign = p.delta > 0 ? "+" : "";
  console.log(
    `  - drop '${p.drop.name}' → add '${p.add.name}' (${p.add.type})  ${sign}${p.delta} EHP (${p.pct}%)`
  );
}

console.log("\n=== Non-persistence check ===");
const after = await bridge.send({
  action: "get_stats",
  params: { fields: ["TotalDPS", "Life", "TotalEHP"] },
});
const persisted =
  after.stats.TotalDPS === baseline.stats.TotalDPS &&
  after.stats.Life === baseline.stats.Life &&
  after.stats.TotalEHP === baseline.stats.TotalEHP;
console.log(
  `  Build state unchanged after ${dpsSwaps.considered.pairsTested + ehpSwaps.considered.pairsTested}+ calc_with calls? ${persisted ? "✓" : "✗"}`
);

await bridge.stop();
console.log("\n=== Phase 6A smoke complete ===");
