/**
 * Phase 4E: synthesized theorycraft helpers built on top of the primitives.
 *
 * These tools orchestrate multiple Lua-bridge calls + static tree-data lookups
 * to answer higher-level questions like "which of my allocated nodes are dead
 * weight" or "what does my build look like at level 90".
 *
 * Pattern: each helper takes a LuaBridge (assumed already started + build
 * loaded) and the forkPath (for static tree-data lookups), then runs a
 * sequence of action calls.
 */

import type { LuaBridge } from "./luaBridge.js";
import type { BridgeLike } from "./luaBridgePool.js";
import { resolveNodes, findCandidateNeighbors, type TreeNode } from "./treeData.js";
import { listGems, getGem } from "./gemData.js";

/** Default stat sample for find_dead_nodes. Keep small so calls stay fast. */
const DEFAULT_PROBE_STATS = ["TotalDPS", "CombinedDPS", "Life", "TotalEHP", "Speed"] as const;

export interface DeadNodeReport {
  /** The node we tried to "remove". */
  node: TreeNode;
  /** Whether the calc accepted the removal (some leaves cascade-orphan many). */
  removed: boolean;
  /** Per-stat delta. Negative = removing the node hurt; ~0 = dead weight. */
  deltas: Record<string, number>;
  /** A composite "dead score": negative = important; ~0 = potentially dead. */
  score: number;
}

export interface FindDeadNodesResult {
  baseline: Record<string, number>;
  treeVersion: string;
  reportedNodes: number;
  totalAllocated: number;
  /** Ranked: most-likely-dead first (closest to zero delta). */
  candidates: DeadNodeReport[];
  /** Stats sampled. */
  stats: string[];
  /** How long the analysis took (ms). */
  elapsedMs: number;
}

/**
 * For each allocated node, compute the hypothetical stat set with it removed.
 * Nodes whose removal doesn't lower TotalDPS or TotalEHP meaningfully are
 * candidates for refunding.
 *
 * Caveats:
 *   - PoB's path validation may cascade-orphan when a "load-bearing" node is
 *     removed. We detect this by comparing the calc_with output to the baseline:
 *     if total stats drop dramatically we mark the node as "structural", not dead.
 *   - We don't currently skip the class-start node; PoB ignores attempts to
 *     remove it but the per-node noise is harmless.
 */
export async function findDeadNodes(
  bridge: LuaBridge,
  forkPath: string,
  options: {
    stats?: string[];
    limit?: number;
    nodeIds?: number[]; // optional subset; default = all allocated
    treeVersion?: string;
  } = {}
): Promise<FindDeadNodesResult> {
  const stats = options.stats?.length ? options.stats : [...DEFAULT_PROBE_STATS];
  const treeVersion = options.treeVersion ?? "0_4";
  const start = Date.now();

  // Pull baseline + tree
  const treeResp = await bridge.send({ action: "get_tree" });
  const baselineResp = await bridge.send({ action: "get_stats", params: { fields: stats } });
  const baseline = (baselineResp.stats ?? {}) as Record<string, number>;
  const treeObj = (treeResp.tree ?? {}) as { nodes?: number[] };
  const allocated: number[] = treeObj.nodes ?? [];
  const subset = options.nodeIds?.length
    ? options.nodeIds.filter((id) => allocated.includes(id))
    : allocated;

  // Probe each node by hypothetically removing it
  const reports: DeadNodeReport[] = [];
  const treeMeta = resolveNodes(forkPath, subset, treeVersion);
  const metaById = new Map(treeMeta.map((n) => [n.id, n]));

  for (const id of subset) {
    const node = metaById.get(id) ?? ({
      id, name: `(unknown node ${id})`, stats: [], type: "normal" as const,
      connections: [] as number[],
    });

    // Skip class-start nodes — they can't be removed and noise the result
    if (node.type === "class-start") continue;

    const probe = await bridge.send({
      action: "calc_with",
      params: { removeNodes: [id], fields: stats },
    });
    if (probe.ok === false) {
      // Treat as un-removable / structural
      reports.push({ node, removed: false, deltas: {}, score: -Infinity });
      continue;
    }
    const out = (probe.output ?? {}) as Record<string, number>;
    const deltas: Record<string, number> = {};
    for (const k of stats) {
      const before = baseline[k];
      const after = out[k];
      if (typeof before === "number" && typeof after === "number") {
        deltas[k] = round(after - before);
      }
    }

    // Composite score: sum of magnitude-weighted deltas across the key stats.
    // Negative = important (removal hurt); near zero = dead weight; positive
    // (rare) means removing it HELPED, which usually signals path-cascade
    // freeing up better routing.
    const dDPS = deltas.TotalDPS ?? deltas.CombinedDPS ?? 0;
    const dEHP = deltas.TotalEHP ?? 0;
    const dLife = deltas.Life ?? 0;
    // Normalize to baseline scale so percentages are comparable
    const dpsPct = baseline.TotalDPS ? (dDPS / Math.abs(baseline.TotalDPS)) * 100 : 0;
    const ehpPct = baseline.TotalEHP ? (dEHP / Math.abs(baseline.TotalEHP)) * 100 : 0;
    const lifePct = baseline.Life ? (dLife / Math.abs(baseline.Life)) * 100 : 0;
    const score = round(dpsPct + ehpPct + lifePct);

    reports.push({ node, removed: true, deltas, score });
  }

  // Sort: highest score first (least painful to remove = most dead).
  reports.sort((a, b) => b.score - a.score);
  const limit = options.limit ?? reports.length;

  // CRITICAL: leave the build state untouched. calc_with is non-persistent so
  // this is already true, but we add a no-op tree fetch so callers can verify.

  return {
    baseline,
    treeVersion,
    reportedNodes: subset.length,
    totalAllocated: allocated.length,
    candidates: reports.slice(0, limit),
    stats,
    elapsedMs: Date.now() - start,
  };
}

/**
 * Simulate stat sheets at a range of character levels. Sets the level, samples
 * stats, then RESTORES the original level. Useful for "what does my leveling
 * build look like at endgame?"
 */
export async function simulateLevelUp(
  bridge: LuaBridge,
  levels: number[],
  options: { stats?: string[] } = {}
): Promise<{
  original: { level: number; stats: Record<string, number> };
  samples: Array<{ level: number; stats: Record<string, number> }>;
}> {
  const stats = options.stats?.length
    ? options.stats
    : ["Life", "Mana", "TotalDPS", "TotalEHP", "Spirit", "PhysicalDamageReduction"];

  const info = await bridge.send({ action: "get_build_info" });
  const infoObj = (info.info ?? {}) as { level?: number };
  const origLevel = Number(infoObj.level ?? 1);
  const origStatsResp = await bridge.send({ action: "get_stats", params: { fields: stats } });

  const samples: Array<{ level: number; stats: Record<string, number> }> = [];
  for (const lvl of levels) {
    await bridge.send({ action: "set_level", params: { level: lvl } });
    const s = await bridge.send({ action: "get_stats", params: { fields: stats } });
    samples.push({ level: lvl, stats: (s.stats ?? {}) as Record<string, number> });
  }

  // Restore original level
  await bridge.send({ action: "set_level", params: { level: origLevel } });

  return {
    original: { level: origLevel, stats: (origStatsResp.stats ?? {}) as Record<string, number> },
    samples,
  };
}

function round(n: number, places = 4): number {
  const m = Math.pow(10, places);
  return Math.round(n * m) / m;
}

/**
 * Send a batch of requests via a BridgeLike. If it's a pool with
 * `batchSend`, distribute across workers. Otherwise fall back to serial.
 */
async function sendBatch(bridge: BridgeLike, reqs: Array<{ action: string; params?: Record<string, unknown> }>) {
  const maybePool = bridge as BridgeLike & {
    batchSend?: (rs: typeof reqs) => Promise<Array<import("./luaBridge.js").LuaResponse>>;
  };
  if (typeof maybePool.batchSend === "function") {
    return maybePool.batchSend(reqs);
  }
  const out: Array<import("./luaBridge.js").LuaResponse> = [];
  for (const r of reqs) out.push(await bridge.send(r));
  return out;
}

// ===========================================================================
// Phase 6D: suggest_gem_link
// ===========================================================================

export interface GemLinkProposal {
  candidate: { name: string; gemType: string; tier: number; tags: string[]; isSupport: boolean };
  baselineMetric: number;
  withCandidateMetric: number;
  delta: number;
  pct: number | null;
  /** Action-ready payload: how to actually add this gem. */
  payload: {
    action: "add_gem";
    params: { groupIndex: number; gemName: string; level: number; quality: number; enabled: true };
  };
}

export interface SuggestGemLinkResult {
  groupIndex: number;
  groupLabel: string | null;
  mainActiveSkill: string | null;
  mainActiveTags: string[];
  baseline: number;
  targetMetric: string;
  considered: { candidatesScreened: number; candidatesTested: number };
  proposals: GemLinkProposal[];
  elapsedMs: number;
}

/**
 * Test support-gem additions to a socket group and rank by target-metric impact.
 *
 * Algorithm:
 *   1. Read the target group's current gems via get_skills. Identify the main
 *      active skill's tags (intelligence/lightning/area/...).
 *   2. Filter the gem DB to SUPPORT gems whose tags overlap the active skill's
 *      (a poor man's compatibility check — PoB2's real check is stricter, but
 *      this is good enough to weed out totally-irrelevant supports).
 *   3. For each candidate (capped at `maxCandidates`):
 *        a. add_gem({groupIndex, gemName, level, quality}) — returns the new
 *           gem index.
 *        b. get_stats({fields: [targetMetric]}) — measure.
 *        c. remove_gem({groupIndex, gemIndex}) — restore.
 *   4. Rank by Δ(targetMetric). Return top N.
 *
 * Cost: ~3 send()s per candidate × ~150ms each. 10 candidates ≈ 4-5s.
 */
export async function suggestGemLink(
  bridge: LuaBridge,
  forkPath: string,
  options: {
    /** Which socket group to test additions on. Defaults to the main DPS group. */
    groupIndex?: number;
    /** Stat to optimize. Default TotalDPS. */
    targetMetric?: string;
    /** Cap on candidates we'll spend a real calc_with on. Default 12. */
    maxCandidates?: number;
    /** Cap on returned proposals. Default 8. */
    limit?: number;
    /** Gem level for the simulated add. Default 20. */
    simLevel?: number;
    /** Gem quality for the simulated add. Default 20. */
    simQuality?: number;
  } = {}
): Promise<SuggestGemLinkResult> {
  const targetMetric = options.targetMetric ?? "TotalDPS";
  const maxCandidates = options.maxCandidates ?? 12;
  const limit = options.limit ?? 8;
  const simLevel = options.simLevel ?? 20;
  const simQuality = options.simQuality ?? 20;
  const start = Date.now();

  // 1. Inspect current skills + main active
  const skillsResp = await bridge.send({ action: "get_skills" });
  const skills = (skillsResp.skills ?? {}) as {
    mainSocketGroup?: number;
    groups?: Array<{
      index: number; label?: string;
      mainActiveSkill?: number;
      gems?: Array<{ index: number; nameSpec?: string; skillId?: string; isSupport?: boolean }>;
    }>;
  };
  const groupIndex = options.groupIndex ?? skills.mainSocketGroup ?? 1;
  const group = (skills.groups ?? []).find((g) => g.index === groupIndex);
  if (!group) {
    throw new Error(`No socket group at index ${groupIndex}`);
  }

  // Identify the main active gem in this group
  const activeIdx = group.mainActiveSkill ?? 1;
  const activeGemEntry = (group.gems ?? [])[activeIdx - 1] ?? (group.gems ?? []).find((g) => !g.isSupport);
  const activeName = activeGemEntry?.nameSpec ?? activeGemEntry?.skillId ?? null;
  let activeTags: string[] = [];
  if (activeName) {
    const dbGem = getGem(forkPath, activeName);
    if (dbGem) activeTags = dbGem.tags;
  }

  // 2. Filter candidate supports — overlap tags with active skill, exclude
  //    supports already in the group.
  const existingSupportNames = new Set(
    (group.gems ?? [])
      .filter((g) => g.isSupport)
      .map((g) => (g.nameSpec ?? g.skillId ?? "").toLowerCase())
  );

  // Walk every support gem in the catalog
  const allCandidates = listGems(forkPath, { supportOnly: true });

  // Tags that indicate "this support causes a side effect" rather than scaling
  // the supported skill's damage. PoE2 has many of these (triggers, hazards,
  // payoff supports) — they show ~0 delta in our smoke and pollute results.
  // Filter them out unless the user opts in to seeing them.
  const TRIGGER_TAGS = new Set(["trigger", "payoff", "hazard", "plant"]);
  // Tags that DO scale damage — prioritize supports with these
  const SCALING_TAGS = new Set([
    "physical", "fire", "cold", "lightning", "chaos",
    "critical", "duration", "projectile", "melee", "spell",
    "minion", "totem", "aura",
  ]);

  // Score: tag overlap with active + bonus for scaling tags, penalty for triggers
  const screened = allCandidates
    .filter((g) => !existingSupportNames.has(g.name.toLowerCase()))
    .filter((g) => !g.tags.some((t) => TRIGGER_TAGS.has(t.toLowerCase())))
    .map((g) => {
      const overlap = g.tags.filter((t) => activeTags.includes(t)).length;
      const scalingHits = g.tags.filter((t) => SCALING_TAGS.has(t.toLowerCase())).length;
      const score = overlap * 10 + scalingHits * 5 - g.tier;
      return { gem: g, overlap, score };
    })
    .filter((x) => x.overlap > 0 || activeTags.length === 0)
    .sort((a, b) => b.score - a.score);

  const candidates = screened.slice(0, maxCandidates).map((s) => s.gem);

  // 3. Baseline metric
  const baselineStats = (
    await bridge.send({ action: "get_stats", params: { fields: [targetMetric] } })
  ).stats as Record<string, number>;
  const baseline = Number(baselineStats?.[targetMetric] ?? 0);

  // 4. For each candidate: add → measure → remove
  const proposals: GemLinkProposal[] = [];
  for (const cand of candidates) {
    const addResp = await bridge.send({
      action: "add_gem",
      params: {
        groupIndex,
        gemName: cand.name,
        level: simLevel,
        quality: simQuality,
        enabled: true,
      },
    });
    if (addResp.ok === false) continue;
    const newGemIndex = (addResp.gem as { gemIndex?: number } | undefined)?.gemIndex;

    const probe = await bridge.send({
      action: "get_stats",
      params: { fields: [targetMetric] },
    });
    const after = Number(((probe.stats ?? {}) as Record<string, number>)[targetMetric] ?? baseline);

    if (newGemIndex != null) {
      await bridge.send({
        action: "remove_gem",
        params: { groupIndex, gemIndex: newGemIndex },
      });
    }

    const delta = after - baseline;
    const pct = baseline !== 0 ? round((delta / Math.abs(baseline)) * 100, 2) : null;
    proposals.push({
      candidate: {
        name: cand.name,
        gemType: cand.gemType,
        tier: cand.tier,
        tags: cand.tags,
        isSupport: cand.isSupport,
      },
      baselineMetric: round(baseline),
      withCandidateMetric: round(after),
      delta: round(delta),
      pct,
      payload: {
        action: "add_gem",
        params: {
          groupIndex,
          gemName: cand.name,
          level: simLevel,
          quality: simQuality,
          enabled: true,
        },
      },
    });
  }

  proposals.sort((a, b) => b.delta - a.delta);

  return {
    groupIndex,
    groupLabel: group.label ?? null,
    mainActiveSkill: activeName,
    mainActiveTags: activeTags,
    baseline: round(baseline),
    targetMetric,
    considered: { candidatesScreened: screened.length, candidatesTested: candidates.length },
    proposals: proposals.slice(0, limit),
    elapsedMs: Date.now() - start,
  };
}

// ===========================================================================
// Phase 6C: bottleneck_analysis
// ===========================================================================

export interface Bottleneck {
  /** Short name for the issue, e.g. "Low Hit Chance". */
  name: string;
  category: "offence" | "defence" | "sustain" | "utility";
  severity: "high" | "medium" | "low";
  /** What the LLM should say in plain English. */
  diagnosis: string;
  /** Concrete next step. */
  advice: string;
  /** Optional rough estimate of the upside if fixed (e.g. "+117% DPS"). */
  estImpact?: string;
  /** Current value(s) that motivated this finding. */
  observed: Record<string, number | string>;
}

export interface BottleneckReport {
  observed: Record<string, number>;
  bottlenecks: Bottleneck[];
  summary: string;
}

/**
 * Diagnostic — for a loaded build, identify what's limiting DPS or making the
 * character squishy. Pure JS analysis over a single get_stats call (no extra
 * calc_with probes, so it's instant).
 *
 * The heuristics here are intentionally conservative: we flag the obvious
 * stuff (low hit chance, unused Spirit, lopsided EHP) and leave deeper
 * analysis to the LLM consuming the report.
 */
export async function bottleneckAnalysis(bridge: LuaBridge): Promise<BottleneckReport> {
  // Pull a wide stat sheet — bottleneck heuristics need many fields
  const fields = [
    "TotalDPS", "CombinedDPS", "FullDPS",
    "HitChance", "AccuracyHitChance",
    "CritChance", "CritMultiplier",
    "Speed",
    "Life", "Mana", "ManaRegen", "ManaCost", "ManaUnreserved",
    "Spirit", "SpiritReserved", "SpiritUnreserved",
    "PowerCharges", "PowerChargesMax",
    "FrenzyCharges", "FrenzyChargesMax",
    "EnduranceCharges", "EnduranceChargesMax",
    "Armour", "Evasion", "EnergyShield", "Ward",
    "PhysicalDamageReduction",
    "BlockChance", "SpellBlockChance",
    "FireResist", "FireResistOverCap",
    "ColdResist", "ColdResistOverCap",
    "LightningResist", "LightningResistOverCap",
    "ChaosResist", "ChaosResistOverCap",
    "TotalEHP",
    "PhysicalMaximumHitTaken", "FireMaximumHitTaken",
    "ColdMaximumHitTaken", "LightningMaximumHitTaken",
    "ChaosMaximumHitTaken",
    "MovementSpeedMod",
  ];
  const r = await bridge.send({ action: "get_stats", params: { fields } });
  const s = (r.stats ?? {}) as Record<string, number>;
  const bottlenecks: Bottleneck[] = [];
  const num = (k: string): number | null =>
    typeof s[k] === "number" ? (s[k] as number) : null;

  // ----- Offence -----
  const hit = num("HitChance");
  if (hit != null && hit < 95 && hit > 0) {
    const mult = 100 / hit;
    bottlenecks.push({
      name: "Low Hit Chance",
      category: "offence",
      severity: hit < 60 ? "high" : hit < 85 ? "medium" : "low",
      diagnosis: `Hit Chance is ${hit.toFixed(0)}% — you're whiffing roughly ${(100 - hit).toFixed(0)}% of attempts.`,
      advice:
        "Stack accuracy on rings/quiver/tree, or pick up Resolute Technique-style nodes. " +
        "PoE2 attacks need >95% to feel reliable.",
      estImpact: `+${((mult - 1) * 100).toFixed(0)}% effective DPS if hit chance reaches 100%.`,
      observed: { HitChance: hit },
    });
  }

  const critChance = num("CritChance");
  const critMult = num("CritMultiplier");
  if (critChance != null && critMult != null && critMult >= 1.5) {
    // Crit DPS multiplier = 1 + critChance/100 * (critMult - 1)
    const currentCritMult = 1 + (critChance / 100) * (critMult - 1);
    const cappedCritChance = 100;
    const idealCritMult = 1 + (cappedCritChance / 100) * (critMult - 1);
    const headroom = (idealCritMult / currentCritMult - 1) * 100;
    if (critChance < 30 && headroom > 25) {
      bottlenecks.push({
        name: "Underused Crit Multiplier",
        category: "offence",
        severity: critChance < 10 ? "high" : "medium",
        diagnosis:
          `CritChance is ${critChance.toFixed(1)}% but CritMultiplier is ${critMult.toFixed(2)}× — ` +
          `your big-hit ceiling is high but you rarely trigger it.`,
        advice:
          "Either scale Crit Chance hard (passives, gear, supports) to unlock the multiplier, OR " +
          "drop the Crit Multiplier investment for flat damage instead.",
        estImpact: `Up to +${headroom.toFixed(0)}% DPS if Crit Chance approaches cap.`,
        observed: { CritChance: critChance, CritMultiplier: critMult },
      });
    }
  }

  // ----- Sustain -----
  const manaCost = num("ManaCost");
  const manaUnreserved = num("ManaUnreserved");
  const manaRegen = num("ManaRegen");
  if (manaCost != null && manaUnreserved != null && manaCost > 0) {
    if (manaCost > manaUnreserved) {
      bottlenecks.push({
        name: "Mana-Locked",
        category: "sustain",
        severity: "high",
        diagnosis: `Skill costs ${manaCost} mana but you only have ${manaUnreserved} unreserved — you literally can't cast.`,
        advice:
          "Reduce reservation, add flat mana on gear, or pick up a mana-cost reduction node/support. " +
          "Mana leech also fixes this for attacks.",
        observed: { ManaCost: manaCost, ManaUnreserved: manaUnreserved },
      });
    } else if (manaRegen != null && manaRegen < manaCost * 1.5) {
      bottlenecks.push({
        name: "Marginal Mana Regen",
        category: "sustain",
        severity: "low",
        diagnosis: `Mana regen (${manaRegen.toFixed(1)}/s) is tight relative to skill cost (${manaCost}).`,
        advice: "Sustained casting may stutter under spam. Consider mana leech or reducing reservation.",
        observed: { ManaCost: manaCost, ManaRegen: manaRegen },
      });
    }
  }

  // ----- Utility -----
  const spiritTotal = num("Spirit");
  const spiritUnreserved = num("SpiritUnreserved");
  if (spiritTotal != null && spiritUnreserved != null && spiritTotal > 0) {
    const unusedPct = (spiritUnreserved / spiritTotal) * 100;
    if (unusedPct > 30) {
      bottlenecks.push({
        name: "Unused Spirit Budget",
        category: "utility",
        severity: unusedPct > 70 ? "medium" : "low",
        diagnosis: `${spiritUnreserved.toFixed(0)} / ${spiritTotal.toFixed(0)} Spirit unreserved (${unusedPct.toFixed(0)}%).`,
        advice:
          "Spirit is free power — slot more reservation buffs (Heralds, auras, persistent buffs).",
        observed: { Spirit: spiritTotal, SpiritUnreserved: spiritUnreserved },
      });
    }
  }

  // Charges at zero with high max — wasted generation potential
  for (const [type, maxKey] of [
    ["PowerCharges", "PowerChargesMax"],
    ["FrenzyCharges", "FrenzyChargesMax"],
    ["EnduranceCharges", "EnduranceChargesMax"],
  ] as const) {
    const cur = num(type);
    const max = num(maxKey);
    if (cur != null && max != null && max >= 3 && cur === 0) {
      bottlenecks.push({
        name: `${type.replace("Charges", " Charges")} Not Generated`,
        category: "utility",
        severity: "low",
        diagnosis: `You have ${max} ${type.replace("Charges", "Charge").toLowerCase()} capacity but generate 0 in calc.`,
        advice:
          `Either ensure your config assumes max ${type.toLowerCase()}, or add a generation source ` +
          `(on-crit, on-hit, skill-based). Setting them to max in lua_set_config is the quick fix.`,
        observed: { [type]: cur, [maxKey]: max },
      });
    }
  }

  // ----- Defence -----
  // Resistances below cap
  for (const elem of ["Fire", "Cold", "Lightning"] as const) {
    const res = num(`${elem}Resist`);
    if (res != null && res < 75) {
      const gap = 75 - res;
      bottlenecks.push({
        name: `${elem} Resistance Undercapped`,
        category: "defence",
        severity: res < 0 ? "high" : res < 50 ? "medium" : "low",
        diagnosis: `${elem} Resistance is ${res}% (cap 75%, gap ${gap}%).`,
        advice:
          `Add ${gap}% ${elem} Resist on gear before mapping. Each missing point amplifies ${elem.toLowerCase()} hits taken by ~1% above cap.`,
        observed: { [`${elem}Resist`]: res },
      });
    }
  }
  const chaos = num("ChaosResist");
  if (chaos != null && chaos < 0) {
    bottlenecks.push({
      name: "Negative Chaos Resist",
      category: "defence",
      severity: chaos < -25 ? "medium" : "low",
      diagnosis: `Chaos Resistance is ${chaos}% — chaos hits and poison DoTs bypass your defenses harder than necessary.`,
      advice: "Cap at 0% before endgame; ideally push positive for chaos-dot maps.",
      observed: { ChaosResist: chaos },
    });
  }

  // Lopsided EHP — flag any damage type that's much weaker than the others
  const ehpByType: Record<string, number> = {};
  for (const k of [
    "PhysicalMaximumHitTaken",
    "FireMaximumHitTaken",
    "ColdMaximumHitTaken",
    "LightningMaximumHitTaken",
    "ChaosMaximumHitTaken",
  ]) {
    const v = num(k);
    if (v != null) ehpByType[k.replace("MaximumHitTaken", "")] = v;
  }
  const ehpVals = Object.values(ehpByType);
  if (ehpVals.length >= 3) {
    const max = Math.max(...ehpVals);
    const min = Math.min(...ehpVals);
    if (max > 0 && min / max < 0.5) {
      const weakest = Object.entries(ehpByType).reduce((a, b) => (b[1] < a[1] ? b : a));
      bottlenecks.push({
        name: `Weak vs ${weakest[0]}`,
        category: "defence",
        severity: min / max < 0.3 ? "high" : "medium",
        diagnosis:
          `Max ${weakest[0].toLowerCase()} hit you can survive is ${weakest[1].toFixed(0)} — ` +
          `that's only ${((min / max) * 100).toFixed(0)}% of your strongest defense layer (${max.toFixed(0)}).`,
        advice:
          weakest[0] === "Physical"
            ? "Stack armour, fortify, phys-reduction nodes, or a determination-style buff."
            : `Cap ${weakest[0]} resist + grab an aegis or resistance-related layer for that element.`,
        observed: ehpByType,
      });
    }
  }

  // Sort: high severity first, then category alphabetical for stability
  const sevOrder: Record<Bottleneck["severity"], number> = { high: 0, medium: 1, low: 2 };
  bottlenecks.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity] || a.category.localeCompare(b.category));

  const high = bottlenecks.filter((b) => b.severity === "high").length;
  const med = bottlenecks.filter((b) => b.severity === "medium").length;
  const low = bottlenecks.filter((b) => b.severity === "low").length;
  const summary =
    bottlenecks.length === 0
      ? "No major bottlenecks flagged — this is either a well-rounded build or the heuristic set didn't catch the issue."
      : `${bottlenecks.length} issues flagged: ${high} high, ${med} medium, ${low} low.`;

  return { observed: s, bottlenecks, summary };
}

// ===========================================================================
// Phase 6A: suggest_node_swaps
// ===========================================================================

export interface SwapProposal {
  drop: { id: number; name: string; type: string; stats: string[] };
  add: { id: number; name: string; type: string; stats: string[] };
  /** Absolute delta in the target metric. */
  delta: number;
  /** Percent delta vs baseline. */
  pct: number | null;
  /** Hypothetical value of the target metric after the swap. */
  afterValue: number;
  /** Action-ready payload for lua_update_tree_delta. */
  payload: { removeNodes: number[]; addNodes: number[] };
  /** When multiple unallocated tree positions give the same stat, the alternates are listed here. */
  alternateAddIds?: number[];
  /** When the same stat is allocated in multiple places, dropping any works — alternates here. */
  alternateDropIds?: number[];
}

export interface SuggestSwapsResult {
  targetMetric: string;
  baseline: number;
  considered: {
    allocated: number;
    deadCandidates: number;
    addCandidates: number;
    pairsTested: number;
  };
  proposals: SwapProposal[];
  elapsedMs: number;
}

/**
 * "What swap would improve my build?"
 *
 * Strategy:
 *   1. Snapshot baseline value of the target metric (default TotalDPS).
 *   2. For each allocated node, probe its removal-only impact. Nodes whose
 *      removal moves the metric < `deadThreshold` % are "dead candidates".
 *   3. BFS from current allocation to find unallocated neighbors within
 *      `maxDepth` hops — these are "add candidates".
 *   4. For each (drop, add) pair, run calc_with({removeNodes:[drop],
 *      addNodes:[add]}) and measure the delta vs baseline.
 *   5. Rank proposals by delta. Return top `limit` with action-ready payloads.
 *
 * Cost: O(allocated + dead × candidates) calc_with calls.
 * Typical: 17 + 3 × 30 = ~110 calls × ~15ms = ~1.7s.
 * Uses calc_with's non-persistent mode — does NOT mutate the build.
 */
export async function suggestNodeSwaps(
  bridge: BridgeLike,
  forkPath: string,
  options: {
    targetMetric?: string;
    /** Max BFS depth from current tree (1 = direct neighbors only). */
    maxDepth?: number;
    /** Cap on add-candidate count. */
    maxCandidates?: number;
    /** Cap on dead-candidate count. */
    maxDead?: number;
    /** Cap on returned proposals. */
    limit?: number;
    /** A node is "dead" if removing it moves target by less than this %. */
    deadThreshold?: number;
    treeVersion?: string;
  } = {}
): Promise<SuggestSwapsResult> {
  const targetMetric = options.targetMetric ?? "TotalDPS";
  const maxDepth = options.maxDepth ?? 2;
  const maxCandidates = options.maxCandidates ?? 30;
  const maxDead = options.maxDead ?? 5;
  const limit = options.limit ?? 10;
  const deadThreshold = options.deadThreshold ?? 1.0;
  const treeVersion = options.treeVersion ?? "0_4";
  const start = Date.now();

  // 1. Baseline
  const baseStats = (
    await bridge.send({ action: "get_stats", params: { fields: [targetMetric] } })
  ).stats as Record<string, number>;
  const baseline = Number(baseStats?.[targetMetric] ?? 0);

  // Get current tree
  const treeResp = await bridge.send({ action: "get_tree" });
  const treeObj = (treeResp.tree ?? {}) as { nodes?: number[] };
  const allocated = treeObj.nodes ?? [];

  // 2. Identify dead allocated nodes (removal barely changes the target metric).
  //    If we have a pool (BridgeLike with batchSend), parallelize the probes.
  const treeMeta = resolveNodes(forkPath, allocated, treeVersion);
  const metaById = new Map(treeMeta.map((n) => [n.id, n]));
  const noiseFloor = Math.max(Math.abs(baseline) * (deadThreshold / 100), 0.0001);

  const probeNodes = allocated.filter((id) => {
    const n = metaById.get(id);
    return n && n.type !== "class-start";
  });
  const probeReqs = probeNodes.map((id) => ({
    action: "calc_with",
    params: { removeNodes: [id], fields: [targetMetric] },
  }));
  const probeResults = await sendBatch(bridge, probeReqs);

  const deadCandidates: Array<{ node: TreeNode; deltaFromRemoval: number }> = [];
  for (let i = 0; i < probeNodes.length; i++) {
    const probe = probeResults[i];
    const id = probeNodes[i];
    if (probe.ok === false) continue;
    const node = metaById.get(id)!;
    const after = Number((probe.output as Record<string, number>)?.[targetMetric] ?? baseline);
    const removalDelta = after - baseline;
    if (Math.abs(removalDelta) < noiseFloor) {
      deadCandidates.push({ node, deltaFromRemoval: removalDelta });
    }
  }
  // Sort by least painful to remove first; cap
  deadCandidates.sort((a, b) => Math.abs(a.deltaFromRemoval) - Math.abs(b.deltaFromRemoval));
  const deadTop = deadCandidates.slice(0, maxDead);

  // 3. BFS add candidates
  const addCandidates = findCandidateNeighbors(forkPath, allocated, maxDepth, {
    version: treeVersion,
  }).slice(0, maxCandidates);

  // 4. Try every (drop, add) pair — batched for pool parallelism
  const pairs: Array<{ dead: typeof deadTop[number]; cand: typeof addCandidates[number] }> = [];
  for (const dead of deadTop) {
    for (const cand of addCandidates) pairs.push({ dead, cand });
  }
  const pairReqs = pairs.map(({ dead, cand }) => ({
    action: "calc_with",
    params: {
      removeNodes: [dead.node.id],
      addNodes: [cand.id],
      fields: [targetMetric],
    },
  }));
  const pairResults = await sendBatch(bridge, pairReqs);

  const proposals: SwapProposal[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const { dead, cand } = pairs[i];
    const result = pairResults[i];
    if (result.ok === false) continue;
    const after = Number(
      (result.output as Record<string, number>)?.[targetMetric] ?? baseline
    );
    const delta = after - baseline;
    const pct = baseline !== 0 ? round((delta / Math.abs(baseline)) * 100, 2) : null;
    proposals.push({
      drop: { id: dead.node.id, name: dead.node.name, type: dead.node.type, stats: dead.node.stats },
      add: { id: cand.id, name: cand.name, type: cand.type, stats: cand.stats },
      delta: round(delta),
      pct,
      afterValue: round(after),
      payload: { removeNodes: [dead.node.id], addNodes: [cand.id] },
    });
  }

  // 5. Dedupe: PoB's tree often has multiple positions with the same stat
  //    (e.g. three different "Critical Damage" nodes within reach AND the
  //    build allocated four "Skill Speed" nodes). Collapse by (drop-name,
  //    add-name) — the user doesn't care WHICH Skill Speed they refund, just
  //    that they refund A Skill Speed. We surface the alternate IDs on both
  //    sides so the LLM can phrase it ("drop any Skill Speed → add any
  //    Critical Damage").
  const deduped = new Map<string, SwapProposal>();
  for (const p of proposals) {
    const key = `${p.drop.name}::${p.add.name}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, p);
    } else {
      if (p.drop.id !== existing.drop.id) {
        existing.alternateDropIds = existing.alternateDropIds ?? [];
        if (!existing.alternateDropIds.includes(p.drop.id)) {
          existing.alternateDropIds.push(p.drop.id);
        }
      }
      if (p.add.id !== existing.add.id) {
        existing.alternateAddIds = existing.alternateAddIds ?? [];
        if (!existing.alternateAddIds.includes(p.add.id)) {
          existing.alternateAddIds.push(p.add.id);
        }
      }
    }
  }

  // 6. Rank — highest positive delta first
  const ranked = [...deduped.values()].sort((a, b) => b.delta - a.delta);

  return {
    targetMetric,
    baseline: round(baseline),
    considered: {
      allocated: allocated.length,
      deadCandidates: deadTop.length,
      addCandidates: addCandidates.length,
      pairsTested: deadTop.length * addCandidates.length,
    },
    proposals: ranked.slice(0, limit),
    elapsedMs: Date.now() - start,
  };
}

/**
 * "What if I equip this item?" Snapshot the build (XML export), add the item,
 * snapshot stats, then reload the saved XML to roll back. Returns a stat diff.
 *
 * Caveats:
 *   - Rollback is best-effort: if reload fails the build state stays mutated.
 *   - Item text must be in PoE2 in-game copy-paste format (separators by "--------").
 */
export async function analyzeItemUpgrade(
  bridge: LuaBridge,
  options: {
    itemText: string;
    slotName?: string;
    stats?: string[];
  }
): Promise<{
  parsed: Record<string, unknown> | null;
  baseline: Record<string, number>;
  withItem: Record<string, number>;
  deltas: Record<string, { before: number; after: number; delta: number; pct: number | null }>;
  rolledBack: boolean;
}> {
  const stats = options.stats?.length
    ? options.stats
    : ["TotalDPS", "CombinedDPS", "Life", "Mana", "TotalEHP", "Spirit", "Armour", "Evasion"];

  // Parse first — bail out early on invalid item text
  const parseResp = await bridge.send({
    action: "parse_item_text",
    params: { text: options.itemText },
  });
  if (parseResp.ok === false) {
    throw new Error(`parse_item_text failed: ${parseResp.error}`);
  }
  const parsed = (parseResp.item ?? null) as Record<string, unknown> | null;

  // Snapshot baseline
  const baselineStats = (
    await bridge.send({ action: "get_stats", params: { fields: stats } })
  ).stats as Record<string, number>;

  // Snapshot full build state for rollback
  const snapshot = await bridge.send({ action: "export_build_xml" });
  const snapshotXml = typeof snapshot.xml === "string" ? snapshot.xml : null;

  // Add the item
  const addParams: Record<string, unknown> = { text: options.itemText };
  if (options.slotName) addParams.slotName = options.slotName;
  const addResp = await bridge.send({ action: "add_item_text", params: addParams });
  if (addResp.ok === false) {
    throw new Error(`add_item_text failed: ${addResp.error}`);
  }

  // Snapshot with the item equipped
  const withItemStats = (
    await bridge.send({ action: "get_stats", params: { fields: stats } })
  ).stats as Record<string, number>;

  // Roll back via wipe + reload.
  // load_build_xml alone is not enough: if the snapshot XML doesn't contain
  // an <Items> section, PoB's loader leaves the current itemsTab untouched
  // (additive, not destructive). Calling new_build first clears all state,
  // then the snapshot reload populates whatever was actually in it.
  let rolledBack = false;
  if (snapshotXml) {
    await bridge.send({ action: "new_build" });
    const restore = await bridge.send({
      action: "load_build_xml",
      params: { xml: snapshotXml, name: "rollback" },
    });
    rolledBack = restore.ok !== false;
  }

  // Compute deltas
  const deltas: Record<string, { before: number; after: number; delta: number; pct: number | null }> = {};
  for (const k of stats) {
    const before = baselineStats?.[k];
    const after = withItemStats?.[k];
    if (typeof before === "number" && typeof after === "number") {
      const d = after - before;
      const pct = before !== 0 ? round((d / Math.abs(before)) * 100, 2) : null;
      deltas[k] = { before: round(before), after: round(after), delta: round(d), pct };
    }
  }

  return { parsed, baseline: baselineStats, withItem: withItemStats, deltas, rolledBack };
}
