/**
 * Phase 8A: verify screen_supports returns only supports PoB's calc engine
 * actually considers compatible. Sanity: melee/slam supports should NOT
 * appear for Twister (a wind/area/projectile skill).
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
await bridge.send({ action: "load_build_xml", params: { xml, name: "screen" } });

const r = await bridge.send({ action: "screen_supports" });
if (r.ok === false) {
  console.log(`ERR ${r.error}`);
  await bridge.stop();
  process.exit(1);
}

const s = r.screen;
console.log(`Main active: ${s.activeSkillName}`);
console.log(`  compatible: ${s.compatible.length}`);
console.log(`  incompatible: ${s.incompatibleCount}`);

// Sanity 1: melee/slam supports should NOT be in the compatible list for Twister
const meleeInList = s.compatible.filter((g) => g.tags.includes("melee") || g.tags.includes("slam"));
console.log(`\n  melee/slam supports in compatible list: ${meleeInList.length} ` +
  `(should be ~0 since Twister isn't melee)`);
for (const g of meleeInList.slice(0, 5)) console.log(`    - ${g.name}  [${g.tags.join(",")}]`);

// Sanity 2: projectile supports SHOULD be in (Twister has projectile tag)
const projInList = s.compatible.filter((g) => g.tags.includes("projectile"));
console.log(`\n  projectile supports in compatible list: ${projInList.length}`);
for (const g of projInList.slice(0, 10)) console.log(`    - ${g.name}  [${g.tags.join(",")}]`);

// Sanity 3: spell-only supports should NOT be in (Twister is attack)
const spellOnly = s.compatible.filter((g) => g.tags.includes("spell") && !g.tags.includes("attack"));
console.log(`\n  spell-only (no attack) in compatible: ${spellOnly.length} (should be ~0)`);
for (const g of spellOnly.slice(0, 5)) console.log(`    - ${g.name}  [${g.tags.join(",")}]`);

// Show top 12 compatible by name
console.log(`\n  First 12 compatible supports:`);
for (const g of s.compatible.slice(0, 12)) console.log(`    - ${g.name}  [${g.tags.join(",")}]`);

await bridge.stop();
console.log("\n=== screen_supports smoke complete ===");
