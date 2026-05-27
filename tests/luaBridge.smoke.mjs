/**
 * Phase 2.6 bridge smoke test (no MCP layer involved).
 *
 * Spawns LuaJIT + PoB2 via WSL, walks through:
 *   1. start → ready banner
 *   2. ping → pong
 *   3. new_build → ok
 *   4. get_build_info → level/name/treeVersion
 *   5. get_stats → real life/mana/resists from PoB's calc engine
 *   6. stop → clean exit
 *
 * Validates the bridge in isolation so MCP-level failures are easier to localize.
 */

import { LuaBridge } from "../build/luaBridge.js";

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";

console.log("\n=== Lua bridge smoke test ===");
console.log(`forkPath: ${forkPath}`);

const bridge = new LuaBridge({ forkPath, timeoutMs: 60_000 });

console.log("[1] starting bridge (wsl luajit HeadlessWrapper.lua --stdio)...");
const t0 = Date.now();
await bridge.start();
console.log(`    ready after ${Date.now() - t0}ms`);

console.log("[2] ping...");
const pong = await bridge.ping();
console.log(`    ping → ${pong}`);

console.log("[3] new_build...");
const nb = await bridge.send({ action: "new_build" });
console.log(`    → ${JSON.stringify(nb)}`);

console.log("[4] get_build_info...");
const info = await bridge.send({ action: "get_build_info" });
console.log(`    → ${JSON.stringify(info)}`);

console.log("[5] get_stats...");
const stats = await bridge.send({ action: "get_stats" });
console.log(`    → ${JSON.stringify(stats)}`);

console.log("[6] stop...");
await bridge.stop();
console.log("    stopped cleanly");

console.log("\n=== Bridge smoke complete ===\n");
