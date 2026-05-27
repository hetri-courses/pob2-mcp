/**
 * Phase 5C smoke: item analysis (parse + upgrade what-if).
 */
import { LuaBridge } from "../build/luaBridge.js";
import { analyzeItemUpgrade } from "../build/theorycraft.js";

const bridge = new LuaBridge({ forkPath: "D:\\pob2-mcp\\pob2-fork\\src", timeoutMs: 60_000 });
await bridge.start();

// Load a minimal build so we have something to upgrade
const xml = '<?xml version="1.0" encoding="UTF-8"?><PathOfBuilding2><Build level="60" className="Monk" mainSocketGroup="1"/></PathOfBuilding2>';
await bridge.send({ action: "load_build_xml", params: { xml, name: "upgrade-test" } });

const magebloodText = `Rarity: UNIQUE
Mageblood
Heavy Belt
--------
Requires Level 65
--------
Item Level: 84
--------
+25 to Strength
--------
+50 to maximum Life
You can have 5 active Magic Utility Flasks
Magic Utility Flasks always apply their Buff while you have any Charges
`;

console.log("=== parse_item_text (no equip) ===");
const parseResp = await bridge.send({
  action: "parse_item_text",
  params: { text: magebloodText },
});
console.log(`  ok=${parseResp.ok}`);
if (parseResp.ok) {
  const it = parseResp.item;
  console.log(`  name: ${it.name}`);
  console.log(`  base: ${it.baseName}  rarity: ${it.rarity}  ilvl: ${it.itemLevel}`);
  console.log(`  requirements: ${JSON.stringify(it.requirements)}`);
  console.log(`  explicit mods (${it.explicitMods.length}):`);
  for (const m of it.explicitMods) console.log(`    - ${m}`);
}

// Confirm nothing was added: get_items count should still be 0
const items = await bridge.send({ action: "get_items" });
console.log(`  items after parse: ${items.items?.length ?? 0} (should be 0 — parse doesn't equip)`);

console.log("\n=== analyze_item_upgrade ===");
const result = await analyzeItemUpgrade(bridge, {
  itemText: magebloodText,
  slotName: "Belt",
});
console.log(`  parsed.name: ${result.parsed?.name}`);
console.log(`  rolledBack: ${result.rolledBack}`);
console.log("  Deltas:");
for (const [k, v] of Object.entries(result.deltas)) {
  if (v.delta === 0) continue;
  const sign = v.delta > 0 ? "+" : "";
  console.log(`    ${k.padEnd(15)}  ${v.before}  →  ${v.after}  (${sign}${v.delta}${v.pct != null ? `, ${v.pct}%` : ""})`);
}

// Verify rollback: get_items should be back to 0
const itemsAfter = await bridge.send({ action: "get_items" });
console.log(`  items after analyze: ${itemsAfter.items?.length ?? 0} (should be 0 if rolled back)`);

await bridge.stop();
console.log("\n=== Phase 5C smoke complete ===");
