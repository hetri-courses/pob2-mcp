/**
 * Phase 8A diagnostic: compare a gem loaded from XML vs one added via add_gem.
 *
 * Hypothesis: BuildOps.add_gem produces a gem instance that's missing fields
 * PoB's calc pipeline expects, causing suggest_gem_link to show 0 deltas.
 *
 * This script dumps both shapes side-by-side so we can see exactly what's
 * missing.
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
await bridge.send({ action: "load_build_xml", params: { xml, name: "phase8a" } });

// 1. Show all groups to pick a target with multiple gems
const skills = await bridge.send({ action: "get_skills" });
console.log(`=== ${skills.skills.groups?.length ?? 0} socket groups in fixture ===`);
for (const g of skills.skills.groups ?? []) {
  const gemSummary = (g.gems ?? []).map((x) => `${x.isSupport ? "sup:" : "act:"}${x.nameSpec}`).join(", ");
  console.log(`  #${g.index} '${g.label || "(no label)"}' [${g.slot || "—"}] enabled=${g.enabled} : ${gemSummary || "(empty)"}`);
}

// 2. Pick the main group (most likely to have gems)
const mainIdx = skills.skills.mainSocketGroup;
const main = (skills.skills.groups ?? []).find((g) => g.index === mainIdx);
if (!main || (main.gems ?? []).length === 0) {
  console.log("\n!! main group is empty, can't compare loaded gem. Aborting.");
  await bridge.stop();
  process.exit(1);
}

// 3. Dump every gem in the main group
console.log(`\n=== Dumping LOADED gems in group #${mainIdx} '${main.label}' ===`);
for (let i = 1; i <= main.gems.length; i++) {
  const dr = await bridge.send({ action: "dump_gem", params: { groupIndex: mainIdx, gemIndex: i } });
  if (dr.ok === false) {
    console.log(`  gem #${i}: ERR ${dr.error}`);
    continue;
  }
  console.log(`\n  --- gem #${i}: ${dr.dump.gem.nameSpec} ---`);
  console.log(JSON.stringify(dr.dump.gem, null, 2));
}

// 4. Add a REAL PoE2 support gem and dump it
const supportName = "Lightning Penetration"; // confirmed in Gems.lua
console.log(`\n=== Adding '${supportName}' via add_gem to group #${mainIdx} ===`);
const addRes = await bridge.send({
  action: "add_gem",
  params: { groupIndex: mainIdx, gemName: supportName, level: 20, quality: 0 },
});
console.log(`  add_gem result: ${JSON.stringify(addRes)}`);

// 5. Get the new gem's index by re-querying skills
const skillsAfter = await bridge.send({ action: "get_skills" });
const mainAfter = (skillsAfter.skills.groups ?? []).find((g) => g.index === mainIdx);
const newGemIndex = mainAfter.gems.length;
console.log(`  added gem now at index ${newGemIndex} (group now has ${mainAfter.gems.length} gems)`);

const dumpAdded = await bridge.send({
  action: "dump_gem",
  params: { groupIndex: mainIdx, gemIndex: newGemIndex },
});
if (dumpAdded.ok === false) {
  console.log(`  dump_gem on added: ERR ${dumpAdded.error}`);
} else {
  console.log(`\n=== Dump of ADDED gem (index #${newGemIndex}) ===`);
  console.log(JSON.stringify(dumpAdded.dump.gem, null, 2));
}

// 6. Side-by-side key diff: loaded[last] vs added
const lastLoadedDump = await bridge.send({
  action: "dump_gem",
  params: { groupIndex: mainIdx, gemIndex: main.gems.length }, // last loaded gem
});
if (lastLoadedDump.ok && dumpAdded.ok !== false) {
  const loadedKeys = new Set(Object.keys(lastLoadedDump.dump.gem));
  const addedKeys = new Set(Object.keys(dumpAdded.dump.gem));
  const onlyInLoaded = [...loadedKeys].filter((k) => !addedKeys.has(k)).sort();
  const onlyInAdded = [...addedKeys].filter((k) => !loadedKeys.has(k)).sort();
  console.log("\n=== Key diff ===");
  console.log("  in LOADED but missing from ADDED:");
  for (const k of onlyInLoaded) {
    const v = lastLoadedDump.dump.gem[k];
    const vStr = typeof v === "object" ? `<${v?.__table ? "table" : "obj"}>` : JSON.stringify(v);
    console.log(`    ${k} = ${vStr}`);
  }
  console.log("  in ADDED but missing from LOADED:");
  for (const k of onlyInAdded) console.log(`    ${k}`);
}

await bridge.stop();
console.log("\n=== Phase 8A diagnostic complete ===");
