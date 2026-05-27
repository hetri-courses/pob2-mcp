/**
 * Phase 5A smoke: bug fixes for set_config + export_build_code.
 *   1. set_config: enemyLevel should round-trip via input bag
 *   2. export_build_xml: should succeed on a minimal/synthetic build
 */
import { LuaBridge } from "../build/luaBridge.js";

const bridge = new LuaBridge({ forkPath: "D:\\pob2-mcp\\pob2-fork\\src", timeoutMs: 60_000 });
await bridge.start();

// Use a minimal synthetic build — that's the failure case we want to fix.
const xml = '<?xml version="1.0" encoding="UTF-8"?><PathOfBuilding2><Build level="20" className="Monk" mainSocketGroup="1"/></PathOfBuilding2>';
await bridge.send({ action: "load_build_xml", params: { xml, name: "minimal" } });

console.log("=== set_config: write enemyLevel=84 ===");
const before = await bridge.send({ action: "get_config" });
console.log(`  before: enemyLevel=${before.config?.enemyLevel}`);
const r = await bridge.send({ action: "set_config", params: { enemyLevel: 84 } });
console.log(`  set ok=${r.ok}`);
const after = await bridge.send({ action: "get_config" });
console.log(`  after:  enemyLevel=${after.config?.enemyLevel}  ${after.config?.enemyLevel === 84 ? "✓ FIXED" : "✗ still broken"}`);

console.log("\n=== set_config: round-trip via stats (DPS should differ when enemy is harder) ===");
await bridge.send({ action: "set_config", params: { enemyLevel: 60 } });
const stats60 = (await bridge.send({ action: "get_stats", params: { fields: ["TotalEHP", "PhysicalMaximumHitTaken"] } })).stats;
await bridge.send({ action: "set_config", params: { enemyLevel: 90 } });
const stats90 = (await bridge.send({ action: "get_stats", params: { fields: ["TotalEHP", "PhysicalMaximumHitTaken"] } })).stats;
console.log(`  enemyLevel 60: EHP=${stats60.TotalEHP}  maxHit=${stats60.PhysicalMaximumHitTaken}`);
console.log(`  enemyLevel 90: EHP=${stats90.TotalEHP}  maxHit=${stats90.PhysicalMaximumHitTaken}`);
console.log(`  effective different at higher enemy level? ${stats60.TotalEHP !== stats90.TotalEHP ? "✓" : "✗ (calc didn't react to enemyLevel change)"}`);

console.log("\n=== export_build_xml on minimal build ===");
const exp = await bridge.send({ action: "export_build_xml" });
console.log(`  ok=${exp.ok}`);
console.log(`  xml length: ${exp.xml ? exp.xml.length : "(none)"}`);
if (exp.error) console.log(`  error: ${exp.error}`);

await bridge.stop();
console.log("\n=== Phase 5A smoke complete ===");
