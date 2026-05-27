/**
 * Phase 4C smoke test: enriched get_items + get_skills via real build.
 * Use the actual Monk lvl 13 fixture so item/gem data is populated.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { LuaBridge } from "../build/luaBridge.js";
import { decodeBuildCode } from "../build/codec.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildCode = readFileSync(path.join(here, "fixtures", "sample-build.code.txt"), "utf8").trim();
const xml = decodeBuildCode(buildCode);

const bridge = new LuaBridge({ forkPath: "D:\\pob2-mcp\\pob2-fork\\src", timeoutMs: 60_000 });
await bridge.start();
await bridge.send({ action: "load_build_xml", params: { xml, name: "Monk lvl 13" } });

console.log("=== get_items (onlyEquipped=true, default) ===");
let r = await bridge.send({ action: "get_items" });
console.log(`  ${r.items.length} equipped items`);
for (const it of r.items.slice(0, 5)) {
  const mods = (it.raw ?? "").split("\n").slice(0, 3).map(s => s.trim()).filter(Boolean).join(" | ");
  console.log(`  ${it.slot.padEnd(15)} [${it.rarity ?? "?"}] ${it.name ?? "(no name)"}`);
  if (mods) console.log(`    └─ ${mods.slice(0, 100)}`);
}

console.log("\n=== get_items (onlyEquipped=false) ===");
r = await bridge.send({ action: "get_items", params: { onlyEquipped: false } });
console.log(`  ${r.items.length} total slots (vs ${r.items.filter(i => i.id > 0).length} equipped)`);

console.log("\n=== get_skills (now with per-gem data) ===");
r = await bridge.send({ action: "get_skills" });
console.log(`  mainSocketGroup=${r.skills.mainSocketGroup}  ${r.skills.groups.length} groups`);
for (const g of r.skills.groups.slice(0, 4)) {
  console.log(`  [${g.index}] ${g.slot ?? "—"} ${g.enabled ? "" : "(disabled)"}`);
  for (const gem of g.gems ?? []) {
    const flags = [
      gem.isSupport === true ? "support" : "active",
      gem.enabled ? null : "DISABLED",
    ].filter(Boolean).join(",");
    console.log(`    └─ ${gem.nameSpec ?? gem.skillId ?? "?"} L${gem.level} Q${gem.quality}% (${flags})`);
  }
}

await bridge.stop();
console.log("\n=== Phase 4C smoke complete ===");
