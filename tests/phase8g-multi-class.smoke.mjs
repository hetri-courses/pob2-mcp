/**
 * Phase 8G v2: smoke across multiple class + skill combos to verify the
 * pipeline doesn't break for any class.
 */
import { LuaBridge } from "../build/luaBridge.js";
import { synthesizeBuild } from "../build/buildGen.js";
import { decodeBuildCode } from "../build/codec.js";

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const bridge = new LuaBridge({ forkPath, timeoutMs: 180_000 });
await bridge.start();

const targets = [
  { className: "Monk", ascendancyName: "Invoker", mainSkillName: "Tempest Bell" },
  { className: "Witch", ascendancyName: "Infernalist", mainSkillName: "Spark" },
  { className: "Warrior", ascendancyName: "Titan", mainSkillName: "Earthquake" },
  { className: "Ranger", ascendancyName: "Deadeye", mainSkillName: "Lightning Arrow" },
];

const results = [];
for (const t of targets) {
  console.log(`\n=== ${t.className}/${t.ascendancyName} + ${t.mainSkillName} ===`);
  try {
    const r = await synthesizeBuild(bridge, forkPath, {
      ...t,
      level: 90,
      treePointBudget: 20,
      supportCount: 3,
      gemLevel: 20,
      refineWithCalc: false, // skip refine for speed
    });
    const xml = decodeBuildCode(r.buildCode);
    const buildTag = xml.match(/<Build[^>]*>/)?.[0] ?? "";
    const ascClass = /ascendClassName="([^"]+)"/.exec(buildTag)?.[1];
    const className = /className="([^"]+)"/.exec(buildTag)?.[1];
    const hasSkill = xml.includes(t.mainSkillName);
    const checks = {
      class: className === t.className,
      ascendancy: ascClass === t.ascendancyName,
      skill: hasSkill,
      gearCount: (r.summary.equippedSlots ?? []).length >= 9,
      lifeOK: (r.summary.finalLife ?? 0) > 1500,
      dpsOK: (r.summary.finalDPS ?? 0) > 100,
    };
    const all = Object.values(checks).every((v) => v);
    results.push({ target: t, summary: r.summary, checks, all });
    console.log(`  DPS=${r.summary.finalDPS}, Life=${r.summary.finalLife}, gear=${r.summary.equippedSlots?.length}, supports=${(r.summary.supports ?? []).length}`);
    console.log(`  Checks: ${JSON.stringify(checks)}  ${all ? "✓" : "✗"}`);
  } catch (e) {
    console.log(`  ✗ THREW: ${(e instanceof Error ? e.message : String(e))}`);
    results.push({ target: t, error: String(e) });
  }
}

await bridge.stop();

console.log("\n=== Summary ===");
const passed = results.filter((r) => r.all).length;
console.log(`  ${passed}/${results.length} class combos passed all checks`);
for (const r of results) {
  if (!r.all) {
    console.log(`  ✗ ${r.target.className}/${r.target.ascendancyName} + ${r.target.mainSkillName}`);
    if (r.error) console.log(`     error: ${r.error}`);
    else console.log(`     failed: ${JSON.stringify(r.checks)}`);
  }
}
