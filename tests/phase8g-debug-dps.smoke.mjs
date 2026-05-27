/** Phase 8G debug: figure out why DPS is 0 with gear+skill in synthesized build. */
import { LuaBridge } from "../build/luaBridge.js";
import { generateGear } from "../build/gearGen.js";

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const b = new LuaBridge({ forkPath, timeoutMs: 30_000 });
await b.start();

await b.send({ action: "new_build" });
await b.send({ action: "update_tree_delta", params: { className: "Invoker" } });
await b.send({ action: "set_level", params: { level: 90 } });

// Equip gear
const gear = generateGear(forkPath, { className: "Monk", level: 90 });
for (const item of gear) {
  await b.send({ action: "add_item_text", params: { text: item.text, equip: item.equip, slot: item.slot } });
}
const s1 = await b.send({ action: "get_stats" });
console.log(`After gear: TotalDPS=${s1.stats?.TotalDPS}, Life=${s1.stats?.Life}`);

// Try a few different active skills
const skills = ["Tempest Bell", "Falling Thunder", "Spear Throw", "Whirling Slash", "Spark", "Earthquake"];
for (const skillName of skills) {
  // Reset to known good state — re-add the skill in a fresh group
  const sg = await b.send({
    action: "create_socket_group",
    params: { label: skillName + " test", slot: "Weapon 1", enabled: true },
  });
  const groupIndex = sg.socketGroup?.index;
  if (!groupIndex) continue;
  const ag = await b.send({
    action: "add_gem",
    params: { groupIndex, gemName: skillName, level: 20, quality: 0 },
  });
  if (ag.ok === false) {
    console.log(`  ${skillName}: add_gem failed - ${ag.error}`);
    continue;
  }
  // Set this group as main
  await b.send({ action: "set_main_selection", params: { groupIndex } });
  const stats = await b.send({ action: "get_stats" });
  console.log(`  ${skillName}: TotalDPS=${stats.stats?.TotalDPS}, CombinedDPS=${stats.stats?.CombinedDPS}, AverageDamage=${stats.stats?.AverageDamage}`);
  // Remove that group for next iteration
  await b.send({ action: "remove_skill", params: { groupIndex } });
}

await b.stop();
