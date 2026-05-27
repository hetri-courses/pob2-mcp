/**
 * Diagnostic for calc_with crash on loaded builds.
 * With POB_API_DEBUG=1 and our pcall wrapper, the error message should now
 * surface as a structured response instead of killing the process.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { LuaBridge } from "../build/luaBridge.js";
import { decodeBuildCode } from "../build/codec.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildCode = readFileSync(path.join(here, "fixtures", "sample-build.code.txt"), "utf8").trim();
const xml = decodeBuildCode(buildCode);

const bridge = new LuaBridge({
  forkPath: "D:\\pob2-mcp\\pob2-fork\\src",
  timeoutMs: 60_000,
});
process.env.POB2_DEBUG = "1"; // surface PoB stderr in Node side too

console.log("Starting bridge with POB_API_DEBUG=1...");
// We need to inject POB_API_DEBUG into the WSL spawn env. The bridge currently
// doesn't pass extra env vars through, so the debug stderr from BuildOps may
// not appear. Workaround: spawn directly with the env.
bridge.start = bridge.start.bind(bridge);
await bridge.start();

console.log("\n=== Test 1: calc_with on FRESH build ===");
await bridge.send({ action: "new_build" });
let r = await bridge.send({ action: "calc_with", params: {} });
console.log("  ok=" + r.ok + (r.ok ? "" : "  error=" + r.error));
if (r.ok && r.output) {
  console.log("  Life=" + r.output.Life + "  TotalDPS=" + r.output.TotalDPS);
}

console.log("\n=== Test 2: calc_with on LOADED build (was the crash path) ===");
await bridge.send({ action: "load_build_xml", params: { xml, name: "monk lvl 13" } });
r = await bridge.send({ action: "calc_with", params: {} });
console.log("  ok=" + r.ok + (r.ok ? "" : "  error=" + r.error));
if (r.ok && r.output) {
  console.log("  Life=" + r.output.Life + "  TotalDPS=" + r.output.TotalDPS);
}

console.log("\n=== Test 3: calc_with with NODE REMOVAL (theorycraft) ===");
const tree = await bridge.send({ action: "get_tree" });
const baselineStats = (await bridge.send({ action: "get_stats" })).stats;
const allocated = tree.tree?.nodes ?? [];
console.log("  build has " + allocated.length + " allocated nodes; trying to remove the last 3");
const toRemove = allocated.slice(-3);
console.log("  removeNodes=" + JSON.stringify(toRemove));
r = await bridge.send({ action: "calc_with", params: { removeNodes: toRemove } });
if (r.ok) {
  console.log("  what-if Life=" + r.output.Life + "  TotalDPS=" + r.output.TotalDPS);
  console.log(
    "  baseline Life=" + baselineStats.Life + "  TotalDPS=" + baselineStats.TotalDPS
  );
  const deltaLife = r.output.Life - baselineStats.Life;
  const deltaDPS = r.output.TotalDPS - baselineStats.TotalDPS;
  console.log("  delta Life=" + deltaLife + "  delta TotalDPS=" + deltaDPS.toFixed(3));
  if (deltaLife === 0 && deltaDPS === 0) {
    console.log("  ⚠ no change — those nodes may have been dead weight, or override didn't apply");
  }
} else {
  console.log("  >>> ERROR <<<:", r.error);
}

console.log("\n=== Test 4: verify baseline NOT persisted (calc_with should be transient) ===");
const afterStats = (await bridge.send({ action: "get_stats" })).stats;
const persistedLife = afterStats.Life === baselineStats.Life;
const persistedDPS = afterStats.TotalDPS === baselineStats.TotalDPS;
console.log("  Life still " + afterStats.Life + " (matches baseline " + baselineStats.Life + ")? " + persistedLife);
console.log("  TotalDPS still " + afterStats.TotalDPS + " (matches baseline)? " + persistedDPS);
if (!persistedLife || !persistedDPS) {
  console.log("  ⚠ calc_with PERSISTED state — that's a bug. Should not mutate.");
}

await bridge.stop();
