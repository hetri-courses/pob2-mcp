/** Inspect the XML's Build tag to fix the round-trip regex. */
import { LuaBridge } from "../build/luaBridge.js";
import { synthesizeBuild } from "../build/buildGen.js";
import { decodeBuildCode } from "../build/codec.js";

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const b = new LuaBridge({ forkPath, timeoutMs: 120_000 });
await b.start();
const r = await synthesizeBuild(b, forkPath, {
  className: "Monk", ascendancyName: "Invoker", level: 90,
  mainSkillName: "Tempest Bell", treePointBudget: 10,
});
const xml = decodeBuildCode(r.buildCode);
const head = xml.match(/<Build[^>]*>/);
console.log("Build tag:");
console.log(head?.[0]);
await b.stop();
