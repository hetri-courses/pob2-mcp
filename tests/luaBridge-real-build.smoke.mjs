/**
 * End-to-end smoke test:
 *   1. Decode a real PoB2 build code (the pobb.in monk lvl 13 fixture)
 *   2. Load it into the calc engine via the bridge
 *   3. Read real stats — these should differ from the default lvl 1 sheet
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { LuaBridge } from "../build/luaBridge.js";
import { decodeBuildCode } from "../build/codec.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildCode = readFileSync(
  path.join(here, "fixtures", "sample-build.code.txt"),
  "utf8"
).trim();

const xml = decodeBuildCode(buildCode);
console.log(`Decoded build code: ${xml.length} chars of XML`);

const bridge = new LuaBridge({
  forkPath: "D:\\pob2-mcp\\pob2-fork\\src",
  timeoutMs: 60_000,
});

console.log("Starting bridge...");
const t0 = Date.now();
await bridge.start();
console.log(`Ready after ${Date.now() - t0}ms`);

console.log("Loading real build...");
const load = await bridge.send({
  action: "load_build_xml",
  params: { xml, name: "pobb.in monk lvl 13" },
});
console.log(`  → ${JSON.stringify(load)}`);

console.log("Build info:");
const info = await bridge.send({ action: "get_build_info" });
console.log(`  → ${JSON.stringify(info)}`);

console.log("Real stats:");
const stats = await bridge.send({ action: "get_stats" });
console.log(`  → ${JSON.stringify(stats, null, 2)}`);

await bridge.stop();
console.log("\nDone.");
