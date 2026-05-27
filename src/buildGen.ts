/**
 * Phase 8G: synthesize_build — generate a starter PoE2 build from minimal inputs.
 *
 * Pipeline:
 *   1. Reset bridge: new_build → start with classId=0
 *   2. Set class (and optional ascendancy) via update_tree_delta(className, ascendClassId)
 *   3. Set character level
 *   4. Greedy tree allocation:
 *      - BFS from currently-allocated nodes; rank adjacent unallocated nodes
 *        by stat-text heuristic (matches the user's optimisation goal: DPS,
 *        life, hybrid).
 *      - Add the top scorer; repeat until `treePointBudget` is hit.
 *      - For the first N points we use stat-text scoring (calc DPS is 0
 *        with no gear/skills). For the last K points, optionally switch
 *        to real calc deltas via suggest_node_swaps.
 *   5. Skill setup:
 *      - Look up `mainSkillName` in gem DB.
 *      - create_socket_group(slot)
 *      - add_gem(mainSkillName, level)
 *      - suggest_gem_link → top supports → add_gem each
 *   6. Export the resulting build XML, encode to a pobb.in-ready code.
 *
 * v1 limits (intentional, defer to follow-up):
 *   - No gear generation. The build exports without items; the user gets
 *     a tree+skill loadout and adds items themselves.
 *   - Calc-based tree refinement is disabled by default (cheap stat-text
 *     heuristic only) so synthesis stays under ~15 seconds.
 *   - Single socket group / single main skill. Doesn't generate multi-skill
 *     loadouts.
 */

import type { LuaBridge } from "./luaBridge.js";
import { findClass, findAscendancy, type Ascendancy } from "./classes.js";
import { loadTree, type TreeNode } from "./treeData.js";
import { getGem } from "./gemData.js";
import { suggestGemLink } from "./theorycraft.js";
import { encodeBuildCode } from "./codec.js";

export type OptimisationGoal = "dps" | "life" | "hybrid" | "defence";

export interface SynthesizeBuildOptions {
  /** Class name, e.g., "Monk". Required. */
  className: string;
  /** Ascendancy name, e.g., "Invoker". Optional — defaults to no ascendancy. */
  ascendancyName?: string;
  /** Character level. Default 90. */
  level?: number;
  /** Main skill gem name, e.g., "Tempest Bell". Required if you want skill setup. */
  mainSkillName?: string;
  /**
   * Number of tree points to allocate beyond the auto-given class-start nodes.
   * Default: derived from level (level - 2, capped at 100).
   */
  treePointBudget?: number;
  /** Stat axis for greedy ranking. Default "dps". */
  goal?: OptimisationGoal;
  /**
   * If true, the final ~10 allocations switch from stat-text heuristic to
   * real calc-delta via suggest_node_swaps. Slower but tunes the build.
   * Default: false (keep synthesis under ~15s).
   */
  refineWithCalc?: boolean;
  /** Number of supports to add to the main socket group. Default 3. */
  supportCount?: number;
  /** Gem level for the main skill + supports. Default 20. */
  gemLevel?: number;
  /** Slot to place the main socket group. Default "Weapon 1". */
  slot?: string;
}

export interface SynthesizeBuildResult {
  /** PoB-encodable build code (URL-safe base64 of zlib(xml)). */
  buildCode: string;
  /** Raw XML for diagnostics. */
  buildXml: string;
  /** What we ended up with. */
  summary: {
    className: string;
    ascendancyName: string | null;
    level: number;
    treePointsAllocated: number;
    treeNodeIds: number[];
    mainSkill: string | null;
    supports: string[];
    finalDPS?: number;
    finalLife?: number;
  };
  /** Step-by-step log of what we did. Helpful when synthesis disappoints. */
  log: string[];
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Stat-text heuristic: score a node by how well its stats match a goal.
// ---------------------------------------------------------------------------
const STAT_KEYWORDS: Record<OptimisationGoal, { positive: RegExp[]; negative: RegExp[] }> = {
  dps: {
    positive: [
      /damage/i, /attack speed/i, /cast speed/i, /critical/i,
      /accuracy/i, /penetrat/i, /pierce/i, /chain/i, /projectile/i,
      /more damage/i, /increased.*damage/i, /multiplier/i,
    ],
    negative: [/minion/i, /totem/i, /trap/i, /mine/i, /^reduced/i],
  },
  life: {
    positive: [
      /to maximum life/i, /life recover/i, /life regen/i, /^increased.*life/i,
      /flask life/i, /unreserve.*life/i,
    ],
    negative: [/reserve/i],
  },
  hybrid: {
    positive: [
      /to maximum life/i, /life regen/i, /damage/i, /attack speed/i,
      /critical/i, /accuracy/i, /resist/i,
    ],
    negative: [],
  },
  defence: {
    positive: [
      /resist/i, /armour/i, /evasion/i, /energy shield/i, /block/i, /dodge/i,
      /to maximum life/i, /life regen/i, /^reduced.*damage taken/i,
    ],
    negative: [/^reduced/i, /increased.*damage taken/i],
  },
};

function scoreNodeForGoal(node: TreeNode, goal: OptimisationGoal): number {
  const stats = node.stats ?? [];
  if (!stats.length) return 0;
  const { positive, negative } = STAT_KEYWORDS[goal];
  let score = 0;
  for (const s of stats) {
    for (const re of positive) if (re.test(s)) score += 5;
    for (const re of negative) if (re.test(s)) score -= 3;
    // Bigger numbers in stat text → larger bonuses, e.g., "30% increased Damage" beats "10%"
    const numMatch = /(\d+)/.exec(s);
    if (numMatch) score += Math.min(Number(numMatch[1]) / 10, 5);
  }
  // Notable + keystone get a tier bonus
  if (node.type === "notable") score += 8;
  if (node.type === "keystone") score += 15;
  // Jewels and masteries are not worth picking via heuristic (require jewel inventory)
  if (node.type === "jewel-socket") score = -1;
  if (node.type === "mastery") score = -1;
  return score;
}

// ---------------------------------------------------------------------------
// Tree allocation: greedy adjacent BFS, scored.
// ---------------------------------------------------------------------------
async function greedyAllocateTree(
  bridge: LuaBridge,
  forkPath: string,
  treeVersion: string,
  goal: OptimisationGoal,
  pointBudget: number,
  log: string[],
): Promise<{ allocated: Set<number>; pointsSpent: number }> {
  const treeData = loadTree(forkPath, treeVersion);
  // The class start has already auto-allocated some nodes; query state.
  const initial = await bridge.send({ action: "get_tree" });
  const initialTree = (initial.tree ?? {}) as { nodes?: number[] };
  const allocated = new Set<number>((initialTree.nodes ?? []).map(Number));
  log.push(`Tree alloc start: ${allocated.size} class-start nodes`);

  let spent = 0;
  while (spent < pointBudget) {
    // Find adjacent unallocated nodes (frontier)
    const frontier = new Map<number, TreeNode>();
    for (const id of allocated) {
      const node = treeData.byId.get(id);
      if (!node) continue;
      for (const adj of node.connections ?? []) {
        if (allocated.has(adj)) continue;
        const adjNode = treeData.byId.get(adj);
        if (!adjNode) continue;
        // Skip mastery + ascendancy-not-yet-ours
        if (adjNode.type === "mastery") continue;
        frontier.set(adj, adjNode);
      }
    }
    if (frontier.size === 0) {
      log.push(`Frontier exhausted after ${spent} points`);
      break;
    }
    // Score each frontier node
    let best: { id: number; node: TreeNode; score: number } | null = null;
    for (const [id, node] of frontier) {
      const score = scoreNodeForGoal(node, goal);
      if (!best || score > best.score) best = { id, node, score };
    }
    if (!best || best.score <= 0) {
      log.push(`No positively-scored frontier node (best=${best?.score ?? "—"}); stopping`);
      break;
    }

    // Commit
    const allocList = Array.from(allocated).concat(best.id);
    const resp = await bridge.send({
      action: "update_tree_delta",
      params: { addNodes: [best.id] },
    });
    if (resp.ok === false) {
      log.push(`update_tree_delta failed at point ${spent}: ${resp.error}`);
      break;
    }
    allocated.add(best.id);
    spent++;
    if (spent <= 6 || spent % 10 === 0) {
      log.push(`  +${spent}: ${best.node.type} '${best.node.name}' (score=${best.score.toFixed(1)})`);
    }
    // sanity-check: don't loop forever
    if (allocated.size > pointBudget + 30) break;
    void allocList;
  }
  return { allocated, pointsSpent: spent };
}

// ---------------------------------------------------------------------------
// Skill loadout: main skill + suggested supports.
// ---------------------------------------------------------------------------
async function addSkillLoadout(
  bridge: LuaBridge,
  forkPath: string,
  mainSkillName: string,
  slot: string,
  supportCount: number,
  gemLevel: number,
  log: string[],
): Promise<{ mainSkill: string; supports: string[]; socketGroupIndex: number }> {
  // Validate the main skill exists
  const mainGem = getGem(forkPath, mainSkillName);
  if (!mainGem) throw new Error(`Unknown main skill: ${mainSkillName}`);
  if (mainGem.isSupport) throw new Error(`'${mainSkillName}' is a support, not an active skill`);

  // Create the socket group
  const sg = await bridge.send({
    action: "create_socket_group",
    params: { label: `${mainSkillName} setup`, slot, enabled: true },
  });
  if (sg.ok === false) throw new Error(`create_socket_group: ${sg.error}`);
  const sgInfo = (sg.socketGroup ?? {}) as { index?: number };
  const groupIndex = sgInfo.index ?? 1;
  log.push(`Created socket group #${groupIndex} '${mainSkillName} setup' in slot '${slot}'`);

  // Add main skill
  const addMain = await bridge.send({
    action: "add_gem",
    params: { groupIndex, gemName: mainGem.name, level: gemLevel, quality: 0 },
  });
  if (addMain.ok === false) throw new Error(`add_gem(main): ${addMain.error}`);
  log.push(`  added main: ${mainGem.name} L${gemLevel}`);

  // Set this group as main so suggest_gem_link targets it
  const setMain = await bridge.send({
    action: "set_main_selection",
    params: { groupIndex },
  });
  if (setMain.ok === false) log.push(`  warn: set_main_selection failed (${setMain.error})`);

  // Run suggest_gem_link to find compatible supports
  const supports: string[] = [];
  try {
    const link = await suggestGemLink(bridge, forkPath, {
      groupIndex,
      maxCandidates: 40,
      limit: supportCount,
      simLevel: gemLevel,
      simQuality: 0,
    });
    log.push(`  suggest_gem_link: tested ${link.considered.candidatesTested}, baseline ${link.targetMetric}=${link.baseline}`);
    // Pick top N positive-delta supports
    const positives = link.proposals.filter((p) => p.delta > 0).slice(0, supportCount);
    if (positives.length === 0) {
      log.push(`  warn: no positive-delta supports found. Using top-${supportCount} by raw ordering.`);
    }
    const picks = positives.length > 0 ? positives : link.proposals.slice(0, supportCount);
    for (const p of picks) {
      const r = await bridge.send({
        action: "add_gem",
        params: { groupIndex, gemName: p.candidate.name, level: gemLevel, quality: 0 },
      });
      if (r.ok === false) {
        log.push(`    skip: add_gem(${p.candidate.name}): ${r.error}`);
        continue;
      }
      supports.push(p.candidate.name);
      log.push(`  added support: ${p.candidate.name} (Δ${p.delta > 0 ? "+" : ""}${p.delta})`);
    }
  } catch (e) {
    log.push(`  suggest_gem_link failed: ${(e as Error).message}; skipping supports`);
  }

  return { mainSkill: mainGem.name, supports, socketGroupIndex: groupIndex };
}

// ---------------------------------------------------------------------------
// Top-level orchestrator
// ---------------------------------------------------------------------------
export async function synthesizeBuild(
  bridge: LuaBridge,
  forkPath: string,
  opts: SynthesizeBuildOptions,
): Promise<SynthesizeBuildResult> {
  const start = Date.now();
  const log: string[] = [];

  const className = opts.className;
  const level = opts.level ?? 90;
  const goal = opts.goal ?? "dps";
  const supportCount = opts.supportCount ?? 3;
  const gemLevel = opts.gemLevel ?? 20;
  const slot = opts.slot ?? "Weapon 1";
  const treePointBudget = opts.treePointBudget ?? Math.min(level - 2, 100);

  // Validate class
  const cls = findClass(forkPath, className);
  if (!cls) throw new Error(`Unknown class '${className}'. Try one of: Monk, Ranger, Warrior, Witch, Sorceress, Huntress, Mercenary, Druid.`);

  let ascendancy: Ascendancy | null = null;
  if (opts.ascendancyName) {
    ascendancy = findAscendancy(forkPath, className, opts.ascendancyName);
    if (!ascendancy) {
      throw new Error(
        `Unknown ascendancy '${opts.ascendancyName}' for ${className}. ` +
        `Try: ${cls.ascendancies.map((a) => a.name).join(", ")}`,
      );
    }
  }

  log.push(`Synthesizing: ${className}${ascendancy ? "/" + ascendancy.name : ""} L${level} goal=${goal}`);

  // 1. Reset to a fresh build
  const reset = await bridge.send({ action: "new_build" });
  if (reset.ok === false) throw new Error(`new_build: ${reset.error}`);

  // 2. Set class + ascendancy via update_tree_delta
  const utd = await bridge.send({
    action: "update_tree_delta",
    params: {
      className,
      ascendClassId: ascendancy?.ascendClassId ?? 0,
      addNodes: [],
    },
  });
  if (utd.ok === false) throw new Error(`set class: ${utd.error}`);
  const utdTree = (utd.tree ?? {}) as { classId?: number; ascendClassId?: number; treeVersion?: string };
  log.push(`Class set: classId=${utdTree.classId} ascendClassId=${utdTree.ascendClassId}`);
  const treeVersion = utdTree.treeVersion ?? "0_4";

  // 3. Set level
  const sl = await bridge.send({ action: "set_level", params: { level } });
  if (sl.ok === false) throw new Error(`set_level: ${sl.error}`);

  // 4. Tree allocation
  const { allocated, pointsSpent } = await greedyAllocateTree(
    bridge,
    forkPath,
    treeVersion,
    goal,
    treePointBudget,
    log,
  );
  log.push(`Tree allocation done: ${pointsSpent} points spent, ${allocated.size} total nodes`);

  // 5. Skill loadout (optional)
  let skillResult: { mainSkill: string; supports: string[] } | null = null;
  if (opts.mainSkillName) {
    try {
      skillResult = await addSkillLoadout(
        bridge,
        forkPath,
        opts.mainSkillName,
        slot,
        supportCount,
        gemLevel,
        log,
      );
    } catch (e) {
      log.push(`Skill loadout failed: ${(e as Error).message}`);
    }
  }

  // 6. Export
  const exp = await bridge.send({ action: "export_build_xml" });
  if (exp.ok === false || typeof exp.xml !== "string") throw new Error(`export: ${exp.error || "no xml"}`);
  const buildXml = exp.xml;
  const buildCode = encodeBuildCode(buildXml);

  // Final stats snapshot
  let finalDPS: number | undefined;
  let finalLife: number | undefined;
  try {
    const stats = (await bridge.send({ action: "get_stats" })).stats as Record<string, number>;
    finalDPS = stats.TotalDPS;
    finalLife = stats.Life;
  } catch {
    /* non-fatal */
  }

  return {
    buildCode,
    buildXml,
    summary: {
      className,
      ascendancyName: ascendancy?.name ?? null,
      level,
      treePointsAllocated: pointsSpent,
      treeNodeIds: Array.from(allocated),
      mainSkill: skillResult?.mainSkill ?? null,
      supports: skillResult?.supports ?? [],
      finalDPS,
      finalLife,
    },
    log,
    elapsedMs: Date.now() - start,
  };
}
