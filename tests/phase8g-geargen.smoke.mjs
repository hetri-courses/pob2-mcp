/**
 * Phase 8G.6 smoke: generate gear for a Monk L90, equip all items, verify
 * Life and DPS jumped from zero.
 */
import { LuaBridge } from "../build/luaBridge.js";
import { generateGear } from "../build/gearGen.js";

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const b = new LuaBridge({ forkPath, timeoutMs: 30_000 });
await b.start();

console.log("=== Fresh Monk L90 baseline ===");
await b.send({ action: "new_build" });
await b.send({ action: "update_tree_delta", params: { className: "Monk" } });
await b.send({ action: "set_level", params: { level: 90 } });
const before = await b.send({ action: "get_stats" });
console.log(`  Life=${before.stats?.Life}, TotalDPS=${before.stats?.TotalDPS}`);

console.log("\n=== Generating + equipping gear ===");
const gear = generateGear(forkPath, { className: "Monk", level: 90 });
console.log(`Generated ${gear.length} items:`);
for (const item of gear) {
  const r = await b.send({
    action: "add_item_text",
    params: { text: item.text, equip: item.equip, slot: item.slot },
  });
  if (r.ok === false) {
    console.log(`  ✗ ${item.slot}: ${r.error}`);
  } else {
    console.log(`  ✓ ${item.slot}: ${r.item?.name}`);
  }
}

console.log("\n=== Stats after gearing ===");
const after = await b.send({ action: "get_stats" });
console.log(`  Life=${after.stats?.Life}, TotalDPS=${after.stats?.TotalDPS}, Armour=${after.stats?.Armour}, Evasion=${after.stats?.Evasion}`);
console.log(`  Fire/Cold/Lightning resists: ${after.stats?.FireResist}/${after.stats?.ColdResist}/${after.stats?.LightningResist}`);

// Confirm Life jumped
const lifeBefore = before.stats?.Life ?? 0;
const lifeAfter = after.stats?.Life ?? 0;
console.log(`\n  Life: ${lifeBefore} → ${lifeAfter}  ${lifeAfter > lifeBefore + 200 ? "✓ +200 minimum" : "✗ Life did not increase as expected"}`);

await b.stop();
