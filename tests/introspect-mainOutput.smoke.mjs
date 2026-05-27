/**
 * Phase 3A.1: introspection only.
 * Load a real build, then list every key in build.calcsTab.mainOutput so we
 * know what stat names PoB2's calc engine actually exposes.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { LuaBridge } from "../build/luaBridge.js";
import { decodeBuildCode } from "../build/codec.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildCode = readFileSync(
  path.join(here, "fixtures", "sample-build.code.txt"),
  "utf8"
).trim();
const xml = decodeBuildCode(buildCode);

const bridge = new LuaBridge({ forkPath: "D:\\pob2-mcp\\pob2-fork\\src", timeoutMs: 60_000 });
await bridge.start();

await bridge.send({ action: "load_build_xml", params: { xml, name: "introspect" } });

// Use the existing get_stats endpoint with a special wildcard via the fields list:
// passing a single field "*" doesn't trigger introspection in the current impl,
// so instead we leverage that BuildOps.export_stats uses a fixed default; we'll
// reach for the underlying object via raw_eval. But BuildOps doesn't have a
// generic eval handler — so use an alternative: send fields=[a huge known list]
// and see which return values come back.

// Cleaner: temporarily abuse Handlers by sending an unknown action so it tells
// us — no, that won't help either. Better approach: write a tiny custom action
// directly. But we don't want to extend Handlers for a one-off. So:
//
// PRAGMATIC APPROACH: ask the bridge to evaluate Lua directly via a temporary
// debug handler. We don't have one. Instead, request an EXHAUSTIVE list of
// candidate fields and report which ones come back non-nil.

const CANDIDATES = [
  // Standard / PoE1 carry-overs
  "Life", "EnergyShield", "Mana", "Ward", "Armour", "Evasion",
  "LifeRegen", "ManaRegen", "EnergyShieldRegen", "WardRegen",
  "FireResist", "ColdResist", "LightningResist", "ChaosResist",
  "FireResistOverCap", "ColdResistOverCap", "LightningResistOverCap", "ChaosResistOverCap",
  "BlockChance", "SpellBlockChance",
  "AttackDodgeChance", "SpellDodgeChance",
  "PhysicalDamageReduction", "DamageTakenWhenHit",
  // DPS metrics
  "TotalDPS", "FullDPS", "CombinedDPS", "WithDoTDPS",
  "AverageDamage", "AverageHit", "Speed", "AttackRate", "CastRate",
  "Hit", "HitChance", "AccuracyHitChance", "CritChance", "CritMultiplier",
  "PhysicalHitAverage", "PhysicalDPS",
  "FireHitAverage", "FireDPS",
  "ColdHitAverage", "ColdDPS",
  "LightningHitAverage", "LightningDPS",
  "ChaosHitAverage", "ChaosDPS",
  // DoT
  "TotalDot", "TotalDotDPS", "BleedDPS", "IgniteDPS", "PoisonDPS", "DecayDPS",
  // PoE2-specific
  "Spirit", "SpiritReserved", "SpiritUnreserved",
  "Combo", "MaxCombo",
  "RunicWard",
  "PowerCharges", "PowerChargesMax",
  "FrenzyCharges", "FrenzyChargesMax",
  "EnduranceCharges", "EnduranceChargesMax",
  // Speed/util
  "MovementSpeedMod", "MoveSpeedMod", "MoveSpeed",
  "ManaUnreserved", "LifeUnreserved", "ESUnreserved",
  // Effective HP / pools
  "TotalEHP", "PhysicalMaximumHitTaken", "FireMaximumHitTaken",
  "ColdMaximumHitTaken", "LightningMaximumHitTaken", "ChaosMaximumHitTaken",
  // Recovery
  "LifeRecoverable", "LifeLeechRate", "ManaLeechRate",
  // Mana cost
  "ManaCost", "ManaCostPercent",
  // Meta
  "ActiveSkill", "SkillDPSStats", "ActiveSkillName",
];

const r = await bridge.send({ action: "get_stats", params: { fields: CANDIDATES } });
const stats = r.stats || {};
delete stats._meta;

console.log("\n=== PoB2 mainOutput key probe ===");
console.log(`Tested ${CANDIDATES.length} candidate field names.`);
console.log(`Returned ${Object.keys(stats).length} non-nil values.\n`);

const present = Object.keys(stats).sort();
const missing = CANDIDATES.filter((k) => !(k in stats)).sort();

console.log("PRESENT in mainOutput:");
for (const k of present) console.log(`  ${k.padEnd(35)} = ${JSON.stringify(stats[k])}`);

console.log("\nMISSING (returned nil):");
for (const k of missing) console.log(`  ${k}`);

await bridge.stop();
