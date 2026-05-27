/** Inspect get_tree response to find the allocated-node field. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { LuaBridge } from "../build/luaBridge.js";
import { decodeBuildCode } from "../build/codec.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const xml = decodeBuildCode(readFileSync(path.join(here, "fixtures", "sample-build.code.txt"), "utf8").trim());
const b = new LuaBridge({ forkPath: "D:\\pob2-mcp\\pob2-fork\\src", timeoutMs: 30_000 });
await b.start();
await b.send({ action: "load_build_xml", params: { xml, name: "inspect" } });
const r = await b.send({ action: "get_tree" });
console.log("Top-level keys:", Object.keys(r.tree).sort());
for (const k of Object.keys(r.tree)) {
  const v = r.tree[k];
  if (Array.isArray(v)) console.log(`  ${k}: array length=${v.length}, sample=${JSON.stringify(v.slice(0, 3))}`);
  else if (typeof v === "object" && v !== null) console.log(`  ${k}: object keys=${Object.keys(v).slice(0, 10).join(",")}`);
  else console.log(`  ${k}: ${JSON.stringify(v)}`);
}
await b.stop();
