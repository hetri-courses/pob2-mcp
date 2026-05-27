/**
 * Phase 6E smoke: parallel calc pool vs serial baseline.
 * Runs suggestNodeSwaps once with a pool and once without to compare elapsed.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { LuaBridge } from "../build/luaBridge.js";
import { LuaBridgePool } from "../build/luaBridgePool.js";
import { decodeBuildCode } from "../build/codec.js";
import { suggestNodeSwaps } from "../build/theorycraft.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildCode = readFileSync(path.join(here, "fixtures", "sample-build.code.txt"), "utf8").trim();
const xml = decodeBuildCode(buildCode);
const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";

console.log("=== Spawning primary bridge ===");
const primary = new LuaBridge({ forkPath, timeoutMs: 60_000 });
await primary.start();
await primary.send({ action: "load_build_xml", params: { xml, name: "pool-test" } });

console.log("\n=== Serial run (size=1) ===");
const tSerial = Date.now();
const serial = await suggestNodeSwaps(primary, forkPath, { maxDepth: 2, maxCandidates: 30, limit: 5 });
console.log(`  ${serial.considered.pairsTested + serial.considered.allocated} calc_with calls in ${Date.now() - tSerial}ms`);
console.log(`  top: drop '${serial.proposals[0]?.drop.name}' → add '${serial.proposals[0]?.add.name}' (${serial.proposals[0]?.delta})`);

console.log("\n=== Pool size=3 (1 primary + 2 replicas) ===");
const pool = new LuaBridgePool(primary, { forkPath, size: 2, timeoutMs: 60_000 });
console.log("  spawning replicas...");
const tSpawn = Date.now();
await pool.startReplicas();
console.log(`  replicas ready in ${Date.now() - tSpawn}ms (size=${pool.size})`);

const tPool = Date.now();
const parallel = await suggestNodeSwaps(pool, forkPath, { maxDepth: 2, maxCandidates: 30, limit: 5 });
console.log(`  same workload in ${Date.now() - tPool}ms (vs serial ${Date.now() - tSerial - (Date.now() - tPool)}ms)`);
console.log(`  top: drop '${parallel.proposals[0]?.drop.name}' → add '${parallel.proposals[0]?.add.name}' (${parallel.proposals[0]?.delta})`);

// Sanity: results should be identical
const same =
  serial.proposals.length === parallel.proposals.length &&
  serial.proposals.every((p, i) => p.delta === parallel.proposals[i].delta);
console.log(`  results identical across serial vs pool? ${same ? "✓" : "✗"}`);

await pool.stop();
await primary.stop();
console.log("\n=== Phase 6E smoke complete ===");
