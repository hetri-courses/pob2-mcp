/**
 * Phase 8G.5 part 2: PoB internal item text format. Take a real equipped
 * item, try to re-add it via add_item_text to verify the format works.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { LuaBridge } from "../build/luaBridge.js";
import { decodeBuildCode } from "../build/codec.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const xml = decodeBuildCode(readFileSync(path.join(here, "fixtures", "sample-build.code.txt"), "utf8").trim());
const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";

const b = new LuaBridge({ forkPath, timeoutMs: 30_000 });
await b.start();
await b.send({ action: "load_build_xml", params: { xml, name: "probe2" } });

// Get the first equipped item with raw text
const items = await b.send({ action: "get_items", params: { onlyEquipped: true } });
const equipped = (items.items ?? []).filter((it) => it.raw && it.raw.length > 0);
console.log(`${equipped.length} equipped items with raw text`);

for (const it of equipped.slice(0, 3)) {
  console.log(`\n--- ${it.slot}: ${it.name} ---`);
  console.log(it.raw);
}

// Try copying one and re-adding (proves the format round-trips)
if (equipped.length > 0) {
  const sample = equipped[0];
  console.log(`\n\n=== Re-adding ${sample.slot}: ${sample.name} text ===`);
  const r = await b.send({
    action: "add_item_text",
    params: { text: sample.raw, equip: false, slot: sample.slot },
  });
  console.log("Result:", JSON.stringify(r).slice(0, 300));
}

// Try in-game ctrl-c format too with different markers
console.log("\n=== Trying alternate placeholder formats ===");
const candidates = [
  // Format A: PoB-internal-like
  `Rarity: RARE
Doom Wrap
Iron Hauberk
LevelReq: 30
Implicits: 0
+80 to maximum Life
30% to Fire Resistance
30% to Cold Resistance
30% to Lightning Resistance
`,
  // Format B: in-game ctrl-c with item class line
  `Item Class: Body Armours
Rarity: Rare
Doom Wrap
Iron Hauberk
--------
Armour: 200
--------
Requires Level 30
--------
+80 to maximum Life
30% to Fire Resistance
30% to Cold Resistance
30% to Lightning Resistance
`,
  // Format C: minimal but with explicit base
  `Rarity: RARE
Doom Wrap
Iron Hauberk
+80 to maximum Life
30% to Fire Resistance
30% to Cold Resistance
30% to Lightning Resistance
`,
];
for (let i = 0; i < candidates.length; i++) {
  const c = candidates[i];
  const r = await b.send({ action: "add_item_text", params: { text: c, equip: false } });
  console.log(`Format ${String.fromCharCode(65 + i)}: ${JSON.stringify(r).slice(0, 200)}`);
}

await b.stop();
