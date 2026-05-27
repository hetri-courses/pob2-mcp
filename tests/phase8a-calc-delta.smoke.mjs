/**
 * Phase 8A confirmation: when we feed add_gem a REAL PoE2 gem name,
 * does the DPS delta actually show up?
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { LuaBridge } from "../build/luaBridge.js";
import { decodeBuildCode } from "../build/codec.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildCode = readFileSync(path.join(here, "fixtures", "sample-build.code.txt"), "utf8").trim();
const xml = decodeBuildCode(buildCode);

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const bridge = new LuaBridge({ forkPath, timeoutMs: 60_000 });
await bridge.start();
await bridge.send({ action: "load_build_xml", params: { xml, name: "phase8a-delta" } });

// Find the MAIN socket group — that's the only one whose DPS is reflected in mainOutput
const skills = await bridge.send({ action: "get_skills" });
const mainIdx = skills.skills.mainSocketGroup;
const main = skills.skills.groups.find((g) => g.index === mainIdx);
console.log(`Main group: #${mainIdx} '${main?.label || ""}' active=${main?.gems?.find((x) => !x.isSupport)?.nameSpec ?? "?"}`);
console.log(`  Existing supports: ${(main?.gems || []).filter((x) => x.isSupport).map((x) => x.nameSpec).join(", ") || "(none)"}`);

const baseStats = await bridge.send({ action: "get_stats" });
const baseDPS = baseStats.stats.TotalDPS ?? 0;
const baseCombined = baseStats.stats.CombinedDPS ?? 0;
const baseFull = baseStats.stats.FullDPS ?? 0;
console.log(`Baseline: TotalDPS=${baseDPS}  CombinedDPS=${baseCombined}  FullDPS=${baseFull}`);

// Three real PoE2 supports, all should benefit the main group's skill:
const groupIdx = mainIdx;
const candidates = ["Heavy Swing", "Bloodlust", "Lightning Penetration", "Magnified Area I", "Concentrated Area"];

for (const gemName of candidates) {
  // Snapshot original gemList length
  const before = await bridge.send({ action: "get_skills" });
  const beforeLen = before.skills.groups.find((g) => g.index === groupIdx)?.gems.length;

  // Add
  const add = await bridge.send({
    action: "add_gem",
    params: { groupIndex: groupIdx, gemName, level: 20, quality: 0 },
  });
  if (add.ok === false) {
    console.log(`  ${gemName}: add_gem failed: ${add.error}`);
    continue;
  }
  const newIdx = add.gem.gemIndex;

  // Recalc
  const stats = await bridge.send({ action: "get_stats" });
  const dps = stats.stats.TotalDPS ?? 0;
  const combined = stats.stats.CombinedDPS ?? 0;
  const full = stats.stats.FullDPS ?? 0;
  const delta = dps - baseDPS;
  const pct = baseDPS > 0 ? ((delta / baseDPS) * 100).toFixed(1) : "—";

  // Dump added gem to verify gemData resolved
  const dr = await bridge.send({ action: "dump_gem", params: { groupIndex: groupIdx, gemIndex: newIdx } });
  const errMsg = dr.dump?.gem?.errMsg ?? "(none)";
  const resolvedName = dr.dump?.gem?.gemData?.name ?? "(unresolved)";

  const sign = delta > 0 ? "+" : "";
  console.log(
    `  ${gemName}: TotalDPS=${dps} (${sign}${delta}, ${pct}%) | CombinedDPS=${combined} | FullDPS=${full}  resolved='${resolvedName}'  errMsg=${errMsg}`,
  );

  // Remove for next iteration
  await bridge.send({ action: "remove_gem", params: { groupIndex: groupIdx, gemIndex: newIdx } });
}

await bridge.stop();
console.log("\n=== Phase 8A calc-delta complete ===");
