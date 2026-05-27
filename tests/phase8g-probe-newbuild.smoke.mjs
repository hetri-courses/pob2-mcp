/**
 * Phase 8G.1: probe new_build flow — what state does a fresh build start in,
 * and how do we set class + ascendancy?
 */
import { LuaBridge } from "../build/luaBridge.js";

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const b = new LuaBridge({ forkPath, timeoutMs: 30_000 });
await b.start();

console.log("=== After fresh boot ===");
const t0 = await b.send({ action: "get_build_info" });
console.log("  build_info:", JSON.stringify(t0.info ?? {}));

console.log("\n=== new_build ===");
const nb = await b.send({ action: "new_build" });
console.log("  result:", JSON.stringify(nb));

const t1 = await b.send({ action: "get_build_info" });
console.log("  build_info:", JSON.stringify(t1.info ?? {}));

console.log("\n=== get_tree on fresh build ===");
const tr = await b.send({ action: "get_tree" });
console.log("  tree keys:", Object.keys(tr.tree ?? {}).sort());
console.log("  classId:", tr.tree?.classId, " ascendClassId:", tr.tree?.ascendClassId);
console.log("  nodes (allocated):", (tr.tree?.nodes ?? []).length);

console.log("\n=== get_skills on fresh build ===");
const sk = await b.send({ action: "get_skills" });
console.log("  groups:", (sk.skills?.groups ?? []).length);

console.log("\n=== set_tree to change class ===");
// Most classes start with a different classId. Let's try set_tree with classId=2 (DexClass = Ranger? Monk?)
// First, what class is fresh build?
const cls = t1.info?.className;
console.log(`  className from build_info: ${cls}`);

// Try update_tree_delta with className
const utd = await b.send({
  action: "update_tree_delta",
  params: { className: "Monk", classId: 8, ascendClassName: "None", allocate: [], deallocate: [] },
});
console.log("  update_tree_delta:", JSON.stringify(utd).slice(0, 300));

const t2 = await b.send({ action: "get_build_info" });
console.log("  build_info after:", JSON.stringify(t2.info ?? {}));
const tr2 = await b.send({ action: "get_tree" });
console.log("  tree classId after:", tr2.tree?.classId, " ascendClassId:", tr2.tree?.ascendClassId);

console.log("\n=== export build XML to see what we have ===");
const exp = await b.send({ action: "export_build_xml" });
console.log("  XML length:", exp.xml?.length, "  first 500 chars:");
console.log(exp.xml?.slice(0, 500));

await b.stop();
