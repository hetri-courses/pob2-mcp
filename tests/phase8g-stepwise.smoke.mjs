/** Trace DPS through each step of synthesize_build to find where it breaks. */
import { LuaBridge } from "../build/luaBridge.js";
import { generateGear } from "../build/gearGen.js";
import { loadTree } from "../build/treeData.js";

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const b = new LuaBridge({ forkPath, timeoutMs: 60_000 });
await b.start();

async function snap(label) {
  const s = await b.send({ action: "get_stats" });
  const sk = await b.send({ action: "get_skills" });
  const dps = s.stats?.TotalDPS;
  const life = s.stats?.Life;
  const mainSG = sk.skills?.mainSocketGroup;
  const groupCount = (sk.skills?.groups ?? []).length;
  console.log(`[${label}] DPS=${dps} Life=${life} mainSocketGroup=${mainSG} groupCount=${groupCount}`);
}

await b.send({ action: "new_build" });
await snap("fresh");

await b.send({ action: "update_tree_delta", params: { className: "Invoker" } });
await snap("class+asc");

await b.send({ action: "set_level", params: { level: 90 } });
await snap("L90");

// Allocate 20 nodes greedily — mimic greedyAllocateTree
const treeData = loadTree(forkPath, "0_4");
let allocated = new Set((await b.send({ action: "get_tree" })).tree?.nodes?.map(Number));
for (let i = 0; i < 20; i++) {
  const frontier = new Map();
  for (const id of allocated) {
    const node = treeData.byId.get(id);
    if (!node) continue;
    for (const adj of node.connections ?? []) {
      if (allocated.has(adj) || frontier.has(adj)) continue;
      const adjNode = treeData.byId.get(adj);
      if (!adjNode || adjNode.type === "mastery") continue;
      frontier.set(adj, adjNode);
    }
  }
  let best = null;
  for (const [id, node] of frontier) {
    const score = (node.stats || []).reduce((s, st) => s + (/damage|life/i.test(st) ? 10 : 0), 0) + (node.type === "notable" ? 8 : 0);
    if (!best || score > best.score) best = { id, score };
  }
  if (!best) break;
  await b.send({ action: "update_tree_delta", params: { addNodes: [best.id] } });
  allocated.add(best.id);
}
await snap("after 20 tree allocs");

// Equip gear
const gear = generateGear(forkPath, { className: "Monk", level: 90 });
for (const item of gear) {
  await b.send({ action: "add_item_text", params: { text: item.text, equip: item.equip, slot: item.slot } });
}
await snap("after gear");

// Create socket group + add Tempest Bell + set main
const sg = await b.send({
  action: "create_socket_group",
  params: { label: "Tempest Bell setup", slot: "Weapon 1", enabled: true },
});
const gi = sg.socketGroup.index;
console.log(`Created group #${gi}`);

await b.send({
  action: "add_gem",
  params: { groupIndex: gi, gemName: "Tempest Bell", level: 20, quality: 0 },
});
await snap("after add_gem Tempest Bell");

const sm = await b.send({ action: "set_main_selection", params: { mainSocketGroup: gi } });
console.log(`set_main_selection: ${JSON.stringify(sm).slice(0, 200)}`);
await snap("after set_main_selection");

// Try Falling Thunder instead — we know it gave 839 DPS earlier
const sg2 = await b.send({
  action: "create_socket_group",
  params: { label: "Falling Thunder setup", slot: "Weapon 1", enabled: true },
});
const gi2 = sg2.socketGroup.index;
await b.send({
  action: "add_gem",
  params: { groupIndex: gi2, gemName: "Falling Thunder", level: 20, quality: 0 },
});
await b.send({ action: "set_main_selection", params: { mainSocketGroup: gi2 } });
await snap("Falling Thunder + main");

await b.stop();
