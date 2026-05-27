/** Phase 8C debug: why are only 1/17 allocated nodes highlighted? */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { LuaBridge } from "../build/luaBridge.js";
import { decodeBuildCode } from "../build/codec.js";
import { loadRawTree, nodeCoords } from "../build/treeSvg.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const xml = decodeBuildCode(readFileSync(path.join(here, "fixtures", "sample-build.code.txt"), "utf8").trim());
const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";

const b = new LuaBridge({ forkPath, timeoutMs: 30_000 });
await b.start();
await b.send({ action: "load_build_xml", params: { xml, name: "debug" } });
const r = await b.send({ action: "get_tree" });
await b.stop();

const allocated = new Set((r.tree.nodes ?? []).map(Number));
const raw = loadRawTree(forkPath, "0_4");

console.log(`Allocated count: ${allocated.size}`);
for (const id of allocated) {
  const node = raw.nodes[String(id)];
  if (!node) {
    console.log(`  ${id}: NOT IN RAW TREE`);
    continue;
  }
  const xy = nodeCoords(raw, node);
  const skipReason = node.isMastery
    ? "MASTERY (skipped)"
    : node.ascendancyName
      ? `ASCENDANCY '${node.ascendancyName}' (skipped — not current)`
      : !xy
        ? "NO COORDS"
        : "rendered";
  console.log(`  ${id} '${node.name || "?"}'  group=${node.group} orbit=${node.orbit}/${node.orbitIndex}  ${skipReason}`);
}
