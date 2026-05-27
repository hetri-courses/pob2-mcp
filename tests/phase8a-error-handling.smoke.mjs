/**
 * Phase 8A: verify add_gem now fails loudly on unknown gem names instead
 * of silently inserting a ghost gem.
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
const bridge = new LuaBridge({ forkPath, timeoutMs: 30_000 });
await bridge.start();
await bridge.send({ action: "load_build_xml", params: { xml, name: "err-test" } });

const before = await bridge.send({ action: "get_skills" });
const beforeCount = before.skills.groups[0].gems.length;
console.log(`Group 1 had ${beforeCount} gems before bad add_gem`);

// 1. Bogus name should now error
const bad = await bridge.send({
  action: "add_gem",
  params: { groupIndex: 1, gemName: "Definitely Not A Real Gem", level: 20 },
});
const cleanFail = bad.ok === false && /unknown gem name/i.test(bad.error || "");
console.log(`  bad name → ok=${bad.ok}  error="${bad.error || ""}"   ${cleanFail ? "✓ clean failure" : "✗ silent or wrong error"}`);

// 2. Group should still have the same count (no ghost insert)
const after = await bridge.send({ action: "get_skills" });
const afterCount = after.skills.groups[0].gems.length;
console.log(`  Group 1 has ${afterCount} gems after bad add_gem  ${afterCount === beforeCount ? "✓" : "✗ ghost inserted!"}`);

// 3. PoE1 name "Added Lightning Damage" doesn't exist in PoE2; should also fail
const poe1 = await bridge.send({
  action: "add_gem",
  params: { groupIndex: 1, gemName: "Added Lightning Damage", level: 20 },
});
console.log(`  PoE1 name → ok=${poe1.ok}  error="${poe1.error || ""}"   ${poe1.ok === false ? "✓" : "✗ unexpectedly accepted"}`);

// 4. Real PoE2 name should still succeed
const good = await bridge.send({
  action: "add_gem",
  params: { groupIndex: 1, gemName: "Heavy Swing", level: 20 },
});
console.log(`  real PoE2 name → ok=${good.ok}  gem=${JSON.stringify(good.gem)}   ${good.ok ? "✓" : "✗"}`);

await bridge.stop();
console.log("\n=== Error-handling smoke complete ===");
