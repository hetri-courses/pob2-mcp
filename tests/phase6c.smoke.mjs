/**
 * Phase 6C smoke: bottleneck_analysis on the Monk lvl 13 fixture.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { LuaBridge } from "../build/luaBridge.js";
import { decodeBuildCode } from "../build/codec.js";
import { bottleneckAnalysis } from "../build/theorycraft.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildCode = readFileSync(path.join(here, "fixtures", "sample-build.code.txt"), "utf8").trim();
const xml = decodeBuildCode(buildCode);

const bridge = new LuaBridge({ forkPath: "D:\\pob2-mcp\\pob2-fork\\src", timeoutMs: 60_000 });
await bridge.start();
await bridge.send({ action: "load_build_xml", params: { xml, name: "Monk lvl 13" } });

const t0 = Date.now();
const r = await bottleneckAnalysis(bridge);
console.log(`Analysis in ${Date.now() - t0}ms`);
console.log(`\n${r.summary}\n`);

for (const b of r.bottlenecks) {
  const sevTag =
    b.severity === "high" ? "🔴" : b.severity === "medium" ? "🟡" : "🟢";
  console.log(`${sevTag} [${b.category}] ${b.name}`);
  console.log(`    ${b.diagnosis}`);
  console.log(`    → ${b.advice}`);
  if (b.estImpact) console.log(`    impact: ${b.estImpact}`);
  console.log("");
}

await bridge.stop();
