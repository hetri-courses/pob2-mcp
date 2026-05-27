/**
 * Diagnostic: dump build.spec.tree.classes table keys + curClassId after loading
 * a real Monk fixture, to understand the index mismatch.
 *
 * We need a Lua-side handler that can eval arbitrary expressions, but BuildOps
 * doesn't have one. Workaround: use the ping handler's debug fields by adding
 * a one-off lua_eval action. Cleaner: introspect via existing actions:
 *   - get_tree returns classId and ascendClassId (already)
 *   - need: spec.tree.classes structure
 *
 * For now: print what we can from existing handlers + check expected class names
 * via tree.json (Node-side).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { LuaBridge } from "../build/luaBridge.js";
import { decodeBuildCode } from "../build/codec.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildCode = readFileSync(path.join(here, "fixtures", "sample-build.code.txt"), "utf8").trim();
const xml = decodeBuildCode(buildCode);

const bridge = new LuaBridge({ forkPath: "D:\\pob2-mcp\\pob2-fork\\src", timeoutMs: 60_000 });
await bridge.start();
await bridge.send({ action: "load_build_xml", params: { xml, name: "Monk lvl 13" } });

const tree = await bridge.send({ action: "get_tree" });
console.log("get_tree:", JSON.stringify(tree.tree, null, 2));

const info = await bridge.send({ action: "get_build_info" });
console.log("get_build_info:", JSON.stringify(info.info, null, 2));

// Parse the XML directly to compare what was saved
const m = xml.match(/<Build\s+([^>]*)>/);
console.log("\nRaw <Build> attrs:", m?.[1]);

await bridge.stop();
