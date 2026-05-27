/**
 * Phase 8G smoke: synthesize a Monk build from scratch.
 *
 * Validates the full pipeline:
 *   new_build → set class → set level → greedy tree → skill setup → export
 */
import { LuaBridge } from "../build/luaBridge.js";
import { synthesizeBuild } from "../build/buildGen.js";
import { decodeBuildCode } from "../build/codec.js";

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const bridge = new LuaBridge({ forkPath, timeoutMs: 120_000 });
await bridge.start();

console.log("=== Synthesizing Monk / Invoker / Tempest Bell L90 (goal=dps) ===\n");
const t0 = Date.now();
const r = await synthesizeBuild(bridge, forkPath, {
  className: "Monk",
  ascendancyName: "Invoker",
  level: 90,
  mainSkillName: "Tempest Bell",
  goal: "dps",
  treePointBudget: 40,        // smaller than the level allows; faster
  supportCount: 3,
  gemLevel: 20,
});
const elapsed = Date.now() - t0;

console.log("=== Step log ===");
for (const line of r.log) console.log(`  ${line}`);

console.log("\n=== Summary ===");
console.log(`  class:        ${r.summary.className}${r.summary.ascendancyName ? "/" + r.summary.ascendancyName : ""}`);
console.log(`  level:        ${r.summary.level}`);
console.log(`  tree points:  ${r.summary.treePointsAllocated} (${r.summary.treeNodeIds.length} total nodes)`);
console.log(`  main skill:   ${r.summary.mainSkill ?? "(none)"}`);
console.log(`  supports:     ${r.summary.supports.join(", ") || "(none)"}`);
console.log(`  final DPS:    ${r.summary.finalDPS ?? "(unknown)"}`);
console.log(`  final Life:   ${r.summary.finalLife ?? "(unknown)"}`);
console.log(`  elapsed:      ${elapsed}ms`);
console.log(`  buildCode:    ${r.buildCode.length} chars`);

// Sanity check: round-trip the build code through the decoder
try {
  const xml = decodeBuildCode(r.buildCode);
  const hasMonk = /className="Monk"/.test(xml);
  const hasSkill = !r.summary.mainSkill || xml.includes(r.summary.mainSkill);
  console.log(`\n=== Round-trip ===`);
  console.log(`  decoded XML length: ${xml.length}`);
  console.log(`  contains className="Monk":  ${hasMonk ? "✓" : "✗"}`);
  console.log(`  contains main skill:         ${hasSkill ? "✓" : "✗"}`);
} catch (e) {
  console.log(`\n✗ Round-trip failed: ${(e instanceof Error ? e.message : String(e))}`);
}

console.log(`\n=== First 80 chars of buildCode (paste-able into PoB2) ===`);
console.log(r.buildCode.slice(0, 80) + (r.buildCode.length > 80 ? "..." : ""));

await bridge.stop();
console.log("\n=== Phase 8G smoke complete ===");
