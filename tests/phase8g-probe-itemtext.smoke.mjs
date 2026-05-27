/**
 * Phase 8G.5: probe PoE2 item text format. Look at Monk fixture items and
 * verify what add_item_text accepts vs what parse_item_text returns.
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
await b.send({ action: "load_build_xml", params: { xml, name: "probe" } });

// 1. Show what existing items look like
console.log("=== Items in fixture ===");
const items = await b.send({ action: "get_items", params: { onlyEquipped: false } });
const list = items.items ?? [];
console.log(`Found ${list.length} items.`);
for (const it of list.slice(0, 5)) {
  console.log(`\n--- ${it.slot || "(unequipped)"} : ${it.name || "?"} (${it.rarity || "?"}) ---`);
  console.log(it.raw || "(no raw)");
}

// 2. Try adding a clean placeholder Body Armour
console.log("\n\n=== Attempting add_item_text: simple placeholder Body Armour ===");
const placeholderArmour = `Rarity: Rare
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
`;
const r = await b.send({
  action: "add_item_text",
  params: { text: placeholderArmour, equip: true, slot: "Body Armour" },
});
console.log("add_item_text:", JSON.stringify(r).slice(0, 500));

// 3. After adding, query items again
const after = await b.send({ action: "get_items", params: { onlyEquipped: false } });
const newOne = (after.items ?? []).find((it) => it.name === "Doom Wrap");
console.log("\nAfter add, our item:", JSON.stringify(newOne).slice(0, 500));

// 4. Check DPS impact
const stats = await b.send({ action: "get_stats" });
console.log(`\nTotalDPS now: ${stats.stats?.TotalDPS}, Life: ${stats.stats?.Life}`);

// 5. Try parse_item_text to see what fields PoE2 expects
console.log("\n=== parse_item_text on the same text ===");
const parsed = await b.send({ action: "parse_item_text", params: { text: placeholderArmour } });
console.log(JSON.stringify(parsed, null, 2).slice(0, 800));

await b.stop();
