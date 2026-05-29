/**
 * Content-aware build evaluator.
 *
 * A build is only "good" if it can actually clear the content it targets:
 *   - OFFENSE: kill the target in a sane time  (time-to-kill = enemyLife / DPS)
 *   - DEFENSE: survive the target's hits        (enemy hit ≤ MaximumHitTaken)
 * Raw DPS / EHP numbers don't answer either question on their own — this module
 * compares them against the actual enemy, using PoB2's own data so there's no
 * guesswork:
 *   - data.monsterLifeTable[level]   — base monster life by level   (Data/Misc.lua)
 *   - data.monsterDamageTable[level] — base monster hit by level     (Data/Misc.lua)
 *   - enemy DPS multipliers by boss tier                            (Modules/Data.lua)
 *       normal 1/4.40, standard boss 4/4.40, pinnacle 8/4.40, uber 10/4.25
 *   - per ConfigOptions: a boss's hit = monsterDamageTable[lvl] * 1.5 * tierMult
 *       (chaos hits are 1/2.5 of that), and MaximumHitTaken per type is read
 *       straight from the calc.
 *
 * NOTE on enemy life: PoB's own "Enemy Life Equivalent" uses the *base*
 * monsterLifeTable[level] (no hidden boss-life multiplier — verified in
 * CalcOffence.lua). So TTK here is "vs a level-N monster" by default; a target
 * may set `lifeMult` to model a specific boss's larger health pool.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { LuaBridge } from "./luaBridge.js";

/** Enemy DPS multipliers per boss tier, from Modules/Data.lua (data.misc). */
const TIER_DPS_MULT = {
  none: 1 / 4.40,
  boss: 4 / 4.40,
  pinnacle: 8 / 4.40,
  uber: 10 / 4.25,
} as const;
export type BossTier = keyof typeof TIER_DPS_MULT;

const DMG_TYPES = ["Physical", "Fire", "Cold", "Lightning", "Chaos"] as const;
export type DamageType = (typeof DMG_TYPES)[number];

// ---- monster tables (parsed from Data/Misc.lua, cached) --------------------
interface MonsterTables { life: number[]; damage: number[] }
const TABLE_CACHE = new Map<string, MonsterTables>();

function parseLuaArray(blob: string, name: string): number[] {
  const m = blob.match(new RegExp(`data\\.${name}\\s*=\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`content.ts: ${name} not found in Misc.lua`);
  return m[1].split(",").map((s) => parseFloat(s.trim())).filter((n) => Number.isFinite(n));
}

export function loadMonsterTables(forkPath: string): MonsterTables {
  const hit = TABLE_CACHE.get(forkPath);
  if (hit) return hit;
  const blob = readFileSync(path.join(forkPath, "Data", "Misc.lua"), "utf8");
  const tables: MonsterTables = {
    life: parseLuaArray(blob, "monsterLifeTable"),
    damage: parseLuaArray(blob, "monsterDamageTable"),
  };
  TABLE_CACHE.set(forkPath, tables);
  return tables;
}

/** 1-indexed level → table value (tables are level-1..level-N in order). */
function atLevel(table: number[], level: number): number {
  const i = Math.max(1, Math.min(level, table.length)) - 1;
  return table[i] ?? table[table.length - 1] ?? 0;
}

export interface ContentTarget {
  name: string;
  level: number;
  tier: BossTier;
  /** Multiplier on base monster life to model a specific boss's HP. Default 1. */
  lifeMult?: number;
  /** Offense passes if TTK ≤ this (seconds). */
  ttkBudgetSec: number;
  /**
   * Minimum effective HP to consider the build non-squishy for this target,
   * on top of the per-hit survivability check. e.g. community consensus is
   * ~6000+ EHP for the Arbiter of Ash. 0 = no floor.
   */
  ehpFloor?: number;
}

/**
 * Default targets. Map clears use base monster life (lifeMult 1 — meaningful for
 * trash). The pinnacle entry's lifeMult is intentionally 1 (PoB's own reference)
 * — set it from real boss HP for an absolute pinnacle TTK; the DEFENSE check is
 * already exact (uses PoB's pinnacle damage multiplier).
 */
export const DEFAULT_TARGETS: ContentTarget[] = [
  { name: "Endgame map pack (rare, lvl 82)", level: 82, tier: "boss", ttkBudgetSec: 4, lifeMult: 1 },
  { name: "Pinnacle boss (lvl 84)", level: 84, tier: "pinnacle", ttkBudgetSec: 30, lifeMult: 1, ehpFloor: 6000 },
];

/** Per-type incoming hit of a {tier} enemy at {level}: table*1.5*mult (chaos /2.5). */
export function bossHitByType(forkPath: string, level: number, tier: BossTier): Record<DamageType, number> {
  const { damage } = loadMonsterTables(forkPath);
  const base = atLevel(damage, level) * 1.5 * TIER_DPS_MULT[tier];
  return {
    Physical: base, Fire: base, Cold: base, Lightning: base, Chaos: base / 2.5,
  };
}

export interface ContentVerdict {
  target: ContentTarget;
  dps: number;
  enemyLife: number;
  ttkSeconds: number;
  offenseOk: boolean;
  ehp: number;
  /** Per-type: the boss's hit, the build's max survivable hit, and whether it survives. */
  hits: Array<{ type: DamageType; incoming: number; maxHitTaken: number; survived: boolean; marginPct: number }>;
  /** The damage type the build is most vulnerable to (smallest margin). */
  weakest: DamageType;
  defenseOk: boolean;
  verdict: "good" | "squishy" | "too-slow" | "squishy-and-slow" | "broken";
  summary: string;
}

const MAXHIT_FIELD: Record<DamageType, string> = {
  Physical: "PhysicalMaximumHitTaken",
  Fire: "FireMaximumHitTaken",
  Cold: "ColdMaximumHitTaken",
  Lightning: "LightningMaximumHitTaken",
  Chaos: "ChaosMaximumHitTaken",
};

/**
 * Evaluate the currently-loaded build against a content target. Sets the enemy
 * level on the calc, reads DPS + per-type MaximumHitTaken + EHP, then compares
 * against the target's life (TTK) and hits (survivability).
 */
export async function evaluateAgainstTarget(
  bridge: LuaBridge,
  forkPath: string,
  target: ContentTarget,
): Promise<ContentVerdict> {
  await bridge.send({ action: "set_config", params: { enemyLevel: target.level } });
  const fields = ["TotalDPS", "TotalEHP", ...DMG_TYPES.map((t) => MAXHIT_FIELD[t])];
  const stats = ((await bridge.send({ action: "get_stats", params: { fields } })).stats ?? {}) as Record<string, number>;

  const dps = Number(stats.TotalDPS ?? 0);
  const ehp = Number(stats.TotalEHP ?? 0);
  const enemyLife = atLevel(loadMonsterTables(forkPath).life, target.level) * (target.lifeMult ?? 1);
  const ttkSeconds = dps > 0 ? enemyLife / dps : Infinity;
  const offenseOk = ttkSeconds <= target.ttkBudgetSec;

  const incoming = bossHitByType(forkPath, target.level, target.tier);
  const hits = DMG_TYPES.map((type) => {
    const inc = incoming[type];
    const maxHit = Number(stats[MAXHIT_FIELD[type]] ?? 0);
    const survived = maxHit >= inc;
    const marginPct = inc > 0 ? Math.round((maxHit / inc - 1) * 100) : 0;
    return { type, incoming: Math.round(inc), maxHitTaken: Math.round(maxHit), survived, marginPct };
  });
  const weakestHit = hits.reduce((a, b) => (b.marginPct < a.marginPct ? b : a));
  const ehpOk = !target.ehpFloor || ehp >= target.ehpFloor;
  const defenseOk = hits.every((h) => h.survived) && ehpOk;

  const verdict: ContentVerdict["verdict"] =
    dps <= 0 ? "broken"
      : offenseOk && defenseOk ? "good"
        : !offenseOk && !defenseOk ? "squishy-and-slow"
          : !defenseOk ? "squishy" : "too-slow";

  const ttkStr = Number.isFinite(ttkSeconds) ? `${ttkSeconds.toFixed(1)}s` : "∞";
  const ehpNote = target.ehpFloor ? ` EHP ${Math.round(ehp)}${ehpOk ? "≥" : "<"}${target.ehpFloor}.` : "";
  const summary =
    `${target.name}: ${verdict.toUpperCase()} — ` +
    `offense ${offenseOk ? "OK" : "FAIL"} (TTK ${ttkStr} vs ${target.ttkBudgetSec}s budget, DPS ${Math.round(dps)} vs ${Math.round(enemyLife)} life); ` +
    `defense ${defenseOk ? "OK" : "FAIL"} (weakest: ${weakestHit.type} hit ${weakestHit.incoming} vs max-survivable ${weakestHit.maxHitTaken}, ${weakestHit.marginPct >= 0 ? "+" : ""}${weakestHit.marginPct}% margin).${ehpNote}`;

  return { target, dps, enemyLife, ttkSeconds, offenseOk, ehp, hits, weakest: weakestHit.type, defenseOk, verdict, summary };
}

/** Evaluate against several targets (default: map pack + pinnacle boss). */
export async function evaluateBuild(
  bridge: LuaBridge,
  forkPath: string,
  targets: ContentTarget[] = DEFAULT_TARGETS,
): Promise<ContentVerdict[]> {
  const out: ContentVerdict[] = [];
  for (const t of targets) out.push(await evaluateAgainstTarget(bridge, forkPath, t));
  return out;
}
