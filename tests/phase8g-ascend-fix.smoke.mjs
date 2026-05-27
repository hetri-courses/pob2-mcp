/** Phase 8G.7 fix: pass ascendancy name as className → both classId+ascendClassId resolved. */
import { LuaBridge } from "../build/luaBridge.js";

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const b = new LuaBridge({ forkPath, timeoutMs: 30_000 });
await b.start();

console.log("=== Pass className='Invoker' (the ascendancy name) ===");
await b.send({ action: "new_build" });
const r = await b.send({ action: "update_tree_delta", params: { className: "Invoker" } });
console.log("  tree:", JSON.stringify(r.tree).slice(0, 250));

const exp = await b.send({ action: "export_build_xml" });
const m = /className="([^"]+)".*ascendClassName="([^"]+)"/s.exec(exp.xml || "");
console.log(`  XML className="${m?.[1]}" ascendClassName="${m?.[2]}"`);

// Compare to base case
console.log("\n=== Compare: passing className='Monk' (no ascendancy) ===");
await b.send({ action: "new_build" });
const r2 = await b.send({ action: "update_tree_delta", params: { className: "Monk" } });
console.log("  tree:", JSON.stringify(r2.tree).slice(0, 250));
const exp2 = await b.send({ action: "export_build_xml" });
const m2 = /className="([^"]+)".*ascendClassName="([^"]+)"/s.exec(exp2.xml || "");
console.log(`  XML className="${m2?.[1]}" ascendClassName="${m2?.[2]}"`);

await b.stop();
