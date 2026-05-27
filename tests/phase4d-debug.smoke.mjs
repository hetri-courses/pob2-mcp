/**
 * Phase 4D debug: print full responses to find the ok=false mystery.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { LuaBridge } from "../build/luaBridge.js";
import { decodeBuildCode } from "../build/codec.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildCode = readFileSync(path.join(here, "fixtures", "sample-build.code.txt"), "utf8").trim();
const xml = decodeBuildCode(buildCode);

process.env.POB_API_DEBUG = "1";
process.env.POB2_DEBUG = "1";
const bridge = new LuaBridge({ forkPath: "D:\\pob2-mcp\\pob2-fork\\src", timeoutMs: 60_000 });
await bridge.start();
await bridge.send({ action: "load_build_xml", params: { xml, name: "Monk lvl 13" } });

console.log("=== set_gem_level full response ===");
let r = await bridge.send({ action: "set_gem_level", params: { groupIndex: 2, gemIndex: 1, level: 20 } });
console.log(JSON.stringify(r, null, 2));

console.log("\n=== update_tree_delta full response ===");
r = await bridge.send({ action: "update_tree_delta", params: { addNodes: [64601] } });
console.log(JSON.stringify(r, null, 2));

console.log("\n=== export_build_xml full response (truncated) ===");
r = await bridge.send({ action: "export_build_xml" });
console.log("keys:", Object.keys(r));
console.log("ok:", r.ok, "error:", r.error);
console.log("xml type:", typeof r.xml, "length:", r.xml?.length);

await bridge.stop();
