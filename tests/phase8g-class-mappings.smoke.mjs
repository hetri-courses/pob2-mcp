/**
 * Phase 8G.1: identify class names + IDs + ascendancies from tree.json.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const forkPath = "D:\\pob2-mcp\\pob2-fork\\src";
const raw = JSON.parse(readFileSync(path.join(forkPath, "TreeData", "0_4", "tree.json"), "utf8"));

console.log("classes top-level:", JSON.stringify(raw.classes ?? "(not found)", null, 2).slice(0, 3000));
