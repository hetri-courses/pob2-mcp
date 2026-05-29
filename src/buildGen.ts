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
import { loadTree, findPathToNode, type TreeNode } from "./treeData.js";
import { getGem } from "./gemData.js";
import { buildAttribCatalog } from "./attributes.js";
import { evaluateBuild } from "./content.js";
import { suggestGemLink, suggestNodeSwaps } from "./theorycraft.js";
import { encodeBuildCode } from "./codec.js";
import { generateGear } from "./gearGen.js";

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
   * Secondary DAMAGE skills (e.g. ["Tempest Bell"]). Each gets its own socket
   * group + engine-screened supports and is flagged into Full DPS, so the build
   * is measured as a synergistic whole rather than a single skill.
   */
  secondarySkills?: string[];
  /**
   * Number of tree points to allocate beyond the auto-given class-start nodes.
   * Default: derived from level (level - 2, capped at 100).
   */
  treePointBudget?: number;
  /** Stat axis for greedy ranking. Default "dps". */
  goal?: OptimisationGoal;
  /**
   * If true, after the initial stat-text allocation + gear + skills, run a
   * final calc-based refinement pass over the last K allocations using
   * suggest_node_swaps. Now that gear+skill produce real DPS, this lets us
   * swap dead allocations for measurable upgrades. Default true.
   */
  refineWithCalc?: boolean;
  /** Cap on calc refinement swaps. Default 8. */
  refineSwapLimit?: number;
  /** Number of supports to add to the main socket group. Default 3. */
  supportCount?: number;
  /** Gem level for the main skill + supports. Default 20. */
  gemLevel?: number;
  /** Slot to place the main socket group. Default "Weapon 1". */
  slot?: string;
  /**
   * If false, skip placeholder gear scaffolding. Build will have no gear and
   * DPS will be ~0; use only when the caller intends to fill items separately.
   * Default true.
   */
  generateGear?: boolean;
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
    /** Secondary damage skills, each its own Full-DPS group with supports. */
    secondary?: Array<{ skill: string; supports: string[]; groupIndex: number }>;
    /** Main skill DPS (the selected skill only). */
    finalDPS?: number;
    /** Whole-build aggregated DPS across all Full-DPS groups. */
    finalFullDPS?: number;
    finalLife?: number;
    /** Per-slot list of equipped items, for the log. */
    equippedSlots?: string[];
    /** Number of calc-refinement swaps applied. */
    calcRefineSwaps?: number;
    /** Content verdicts: is it good vs real enemies (TTK + survivability)? */
    content?: Array<{ target: string; verdict: string; summary: string }>;
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

/**
 * What a skill actually uses, derived from its gem tags. Lets the tree scorer
 * stop rewarding "Projectile Damage" on a melee skill, "Spell Damage" on an
 * attack, etc. — the "real allocation" fix.
 */
export interface SkillProfile {
  isAttack: boolean;
  isSpell: boolean;
  isProjectile: boolean;
  isMelee: boolean;
  isMinion: boolean;
  /** Damage-type tags the skill itself carries (physical/fire/cold/...). */
  damageTags: Set<string>;
}

export function deriveSkillProfile(forkPath: string, mainSkillName: string | undefined): SkillProfile | null {
  if (!mainSkillName) return null;
  const gem = getGem(forkPath, mainSkillName);
  if (!gem) return null;
  const tags = new Set(gem.tags.map((t) => t.toLowerCase()));
  return {
    isAttack: tags.has("attack"),
    isSpell: tags.has("spell"),
    isProjectile: tags.has("projectile"),
    isMelee: tags.has("melee"),
    isMinion: tags.has("minion"),
    damageTags: new Set(["physical", "fire", "cold", "lightning", "chaos"].filter((t) => tags.has(t))),
  };
}

function scoreNodeForGoal(node: TreeNode, goal: OptimisationGoal, profile?: SkillProfile | null): number {
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
  // Skill-awareness: a node that scales a delivery the skill doesn't use is
  // worthless. Penalties exceed the ~15-25 a damage node earns above, so a hard
  // mismatch (Projectile Damage on a melee strike) drops below relevant nodes.
  if (profile) {
    for (const s of stats) {
      const sl = s.toLowerCase();
      if (!profile.isProjectile && /\bprojectile|\barrow/.test(sl)) score -= 25;
      if (!profile.isSpell && /\bspell|cast speed/.test(sl)) score -= 20;
      if (!/\bbow|crossbow/.test(stats.join(" ").toLowerCase()) && profile.isMelee && /\bbow\b|crossbow/.test(sl)) score -= 20;
      if (!profile.isMinion && /\bminion|companion/.test(sl)) score -= 15;
      // Boosts for matching the skill's real profile.
      if (profile.isMelee && /\bmelee\b/.test(sl)) score += 6;
      if (profile.isAttack && /attack speed|attack damage|with attacks|increased attack/.test(sl)) score += 4;
      for (const dt of profile.damageTags) if (sl.includes(dt)) score += 8;
    }
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
  profile?: SkillProfile | null,
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
        // Skip mastery; skip ascendancy nodes — those consume separate
        // ascendancy points in PoE2, not the passive budget we're spending here.
        if (adjNode.type === "mastery") continue;
        if (adjNode.type === "ascendancy-normal" || adjNode.type === "ascendancy-notable") continue;
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
      const score = scoreNodeForGoal(node, goal, profile);
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
// Attribute satisfaction: make the build actually able to use its gems + gear.
// ---------------------------------------------------------------------------

/** BFS from the allocated set to the nearest unallocated node matching `want`. */
function nearestNode(
  tree: ReturnType<typeof loadTree>,
  allocated: Set<number>,
  want: (n: TreeNode) => boolean,
): number | null {
  const seen = new Set<number>(allocated);
  let frontier = [...allocated];
  for (let depth = 0; depth < 25 && frontier.length; depth++) {
    const next: number[] = [];
    for (const id of frontier) {
      const node = tree.byId.get(id);
      if (!node) continue;
      for (const adj of node.connections ?? []) {
        if (seen.has(adj)) continue;
        seen.add(adj);
        const adjNode = tree.byId.get(adj);
        if (!adjNode) continue;
        if (adjNode.type === "ascendancy-normal" || adjNode.type === "ascendancy-notable" ||
            adjNode.type === "jewel-socket" || adjNode.type === "class-start" || adjNode.type === "mastery") continue;
        if (want(adjNode)) return adj;
        next.push(adj);
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * After gems + gear are in place, close the attribute requirement gap so the
 * build can actually equip its gems/gear. Two levers:
 *   1. Adaptive Capability (53108) — gem attribute reqs met by highest attribute
 *      (the elegant fix for a Dex/Int Monk running 100-Str supports).
 *   2. Nearest typed attribute nodes for any remaining (gear-driven) deficit.
 * Re-measures the calc's Req* after each step (self-correcting) and reports the
 * residual gap honestly — a leftover gap means it must come from gear attributes.
 */
async function satisfyAttributes(
  bridge: LuaBridge,
  forkPath: string,
  treeVersion: string,
  allocated: Set<number>,
  log: string[],
): Promise<void> {
  const tree = loadTree(forkPath, treeVersion);
  const catalog = buildAttribCatalog(forkPath, treeVersion);
  const typedName = { Str: "Strength", Dex: "Dexterity", Int: "Intelligence" } as const;
  type A = keyof typeof typedName;

  const readGaps = async () => {
    const st = ((await bridge.send({
      action: "get_stats",
      params: { fields: ["Str", "ReqStr", "Dex", "ReqDex", "Int", "ReqInt"] },
    })).stats ?? {}) as Record<string, number>;
    const gap: Record<A, number> = {
      Str: Math.max(0, (st.ReqStr ?? 0) - (st.Str ?? 0)),
      Dex: Math.max(0, (st.ReqDex ?? 0) - (st.Dex ?? 0)),
      Int: Math.max(0, (st.ReqInt ?? 0) - (st.Int ?? 0)),
    };
    return { st, gap, total: gap.Str + gap.Dex + gap.Int };
  };

  let g = await readGaps();
  if (g.total === 0) {
    log.push(`Attributes: requirements already met (Str ${g.st.Str}/${g.st.ReqStr}, Dex ${g.st.Dex}/${g.st.ReqDex}, Int ${g.st.Int}/${g.st.ReqInt})`);
    return;
  }
  log.push(`Attributes: gap Str ${g.gap.Str} / Dex ${g.gap.Dex} / Int ${g.gap.Int}`);

  // 1. Adaptive Capability — collapses gem reqs onto the highest attribute.
  if (catalog.adaptiveCapabilityId && !allocated.has(catalog.adaptiveCapabilityId)) {
    const path = findPathToNode(forkPath, [...allocated], catalog.adaptiveCapabilityId, { version: treeVersion, maxHops: 50 });
    if (path && path.path.length) {
      const ids = path.path.map((n) => n.id);
      const r = await bridge.send({ action: "update_tree_delta", params: { addNodes: ids } });
      if (r.ok !== false) {
        ids.forEach((id) => allocated.add(id));
        g = await readGaps();
        log.push(`Attributes: +Adaptive Capability (${ids.length} nodes) → gap Str ${g.gap.Str}/Dex ${g.gap.Dex}/Int ${g.gap.Int}`);
      }
    }
  }

  // 2. Fill remaining (gear-driven) gaps with the nearest typed attribute node.
  let rounds = 0;
  while (g.total > 0 && rounds < 14) {
    rounds++;
    const need = (["Str", "Dex", "Int"] as A[]).reduce((a, b) => (g.gap[b] > g.gap[a] ? b : a));
    const want = (n: TreeNode) =>
      n.name === typedName[need] || (n.stats ?? []).some((s) => /to all Attributes/i.test(s));
    const target = nearestNode(tree, allocated, want);
    if (target == null) { log.push(`Attributes: no reachable node grants ${need}; stopping`); break; }
    const path = findPathToNode(forkPath, [...allocated], target, { version: treeVersion, maxHops: 50 });
    if (!path || !path.path.length) break;
    const ids = path.path.map((n) => n.id);
    const r = await bridge.send({ action: "update_tree_delta", params: { addNodes: ids } });
    if (r.ok === false) break;
    ids.forEach((id) => allocated.add(id));
    g = await readGaps();
  }
  log.push(
    `Attributes final: Str ${g.st.Str}/${g.st.ReqStr}, Dex ${g.st.Dex}/${g.st.ReqDex}, Int ${g.st.Int}/${g.st.ReqInt}` +
    (g.total > 0 ? ` (residual gap ${g.total} — cover with attributes on gear)` : " (satisfied)"),
  );
}

// ---------------------------------------------------------------------------
// Skill loadout: main skill + suggested supports.
// ---------------------------------------------------------------------------
/**
 * Set up one socket group as a damage layer: create it (flagged into Full DPS),
 * add the active skill, and fill it with engine-screened supports. Sets the
 * group as the main selection first so suggest_gem_link's REAL compatibility
 * screen (which only runs on the main group) applies to it — so each damage
 * skill gets its own measured supports, not the weak tag-overlap fallback.
 */
async function addSkillGroup(
  bridge: LuaBridge,
  forkPath: string,
  skillName: string,
  slot: string,
  supportCount: number,
  gemLevel: number,
  includeInFullDPS: boolean,
  log: string[],
): Promise<{ skill: string; supports: string[]; groupIndex: number } | null> {
  const gem = getGem(forkPath, skillName);
  if (!gem) { log.push(`  skip '${skillName}': not in gem DB`); return null; }
  if (gem.isSupport) { log.push(`  skip '${skillName}': it's a support, not an active skill`); return null; }

  const sg = await bridge.send({
    action: "create_socket_group",
    params: { label: `${skillName} setup`, slot, enabled: true, includeInFullDPS },
  });
  if (sg.ok === false) { log.push(`  create_socket_group(${skillName}): ${sg.error}`); return null; }
  const groupIndex = ((sg.socketGroup ?? {}) as { index?: number }).index ?? 1;

  const addMain = await bridge.send({
    action: "add_gem",
    params: { groupIndex, gemName: gem.name, level: gemLevel, quality: 0 },
  });
  if (addMain.ok === false) { log.push(`  add_gem(${skillName}): ${addMain.error}`); return null; }

  // Make this the main selection so the engine support-screen targets THIS group.
  await bridge.send({ action: "set_main_selection", params: { mainSocketGroup: groupIndex } });

  const supports: string[] = [];
  try {
    const link = await suggestGemLink(bridge, forkPath, {
      groupIndex, limit: supportCount, simLevel: gemLevel, simQuality: 0,
    });
    const positives = link.proposals.filter((p) => p.delta > 0).slice(0, supportCount);
    const picks = positives.length > 0 ? positives : link.proposals.slice(0, supportCount);
    for (const p of picks) {
      const r = await bridge.send({
        action: "add_gem",
        params: { groupIndex, gemName: p.candidate.name, level: gemLevel, quality: 0 },
      });
      if (r.ok === false) { log.push(`    skip ${p.candidate.name}: ${r.error}`); continue; }
      supports.push(p.candidate.name);
    }
  } catch (e) {
    log.push(`  suggest_gem_link(${skillName}) failed: ${(e as Error).message}`);
  }
  log.push(`  group #${groupIndex}: ${gem.name}${includeInFullDPS ? " [FullDPS]" : ""} + [${supports.join(", ") || "no supports"}]`);
  return { skill: gem.name, supports, groupIndex };
}

const SECONDARY_SLOTS = ["Body Armour", "Helmet", "Gloves", "Boots"];

/**
 * Build the full skill loadout: the main attack plus any secondary DAMAGE skills
 * (e.g. Tempest Bell). Every damage group is flagged into Full DPS and gets its
 * own supports, so the build is evaluated as a synergistic whole, not one skill.
 */
async function addSkillLoadout(
  bridge: LuaBridge,
  forkPath: string,
  mainSkillName: string,
  secondarySkills: string[],
  slot: string,
  supportCount: number,
  gemLevel: number,
  log: string[],
): Promise<{
  mainSkill: string;
  supports: string[];
  socketGroupIndex: number;
  secondary: Array<{ skill: string; supports: string[]; groupIndex: number }>;
}> {
  const mainGroup = await addSkillGroup(bridge, forkPath, mainSkillName, slot, supportCount, gemLevel, true, log);
  if (!mainGroup) throw new Error(`failed to set up main skill '${mainSkillName}'`);

  const secondary: Array<{ skill: string; supports: string[]; groupIndex: number }> = [];
  let si = 0;
  for (const sk of secondarySkills) {
    const slotFor = SECONDARY_SLOTS[si % SECONDARY_SLOTS.length];
    si++;
    const g = await addSkillGroup(bridge, forkPath, sk, slotFor, supportCount, gemLevel, true, log);
    if (g) secondary.push(g);
  }

  // Restore the primary as the main selection (TotalDPS + gem tooltips reflect it).
  await bridge.send({ action: "set_main_selection", params: { mainSocketGroup: mainGroup.groupIndex } });
  return { mainSkill: mainGroup.skill, supports: mainGroup.supports, socketGroupIndex: mainGroup.groupIndex, secondary };
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

  // 2. Set class + ascendancy.
  //
  // CRITICAL: PoB's PassiveSpec.lua line 318-321 overwrites any passed
  // ascendClassId when className is set, looking it up via ascendNameMap
  // instead. So pass the ASCENDANCY name (not the base class name) when an
  // ascendancy is selected — PoB then resolves both classId AND ascendClassId,
  // and auto-allocates the ascendancy start node.
  const classNameToSend = ascendancy ? ascendancy.name : className;
  const utd = await bridge.send({
    action: "update_tree_delta",
    params: {
      className: classNameToSend,
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

  // 4. Tree allocation (stat-text heuristic — calc DPS still 0 here).
  //    Skill-aware: feed the main skill's profile so the scorer won't reward
  //    e.g. Projectile Damage on a melee strike.
  const skillProfile = deriveSkillProfile(forkPath, opts.mainSkillName);
  if (skillProfile) {
    const flags = [
      skillProfile.isAttack && "attack", skillProfile.isSpell && "spell",
      skillProfile.isMelee && "melee", skillProfile.isProjectile && "projectile",
    ].filter(Boolean).join(",");
    log.push(`Skill profile for '${opts.mainSkillName}': ${flags || "—"} | dmg=[${[...skillProfile.damageTags].join(",")}]`);
  }
  const { allocated, pointsSpent } = await greedyAllocateTree(
    bridge,
    forkPath,
    treeVersion,
    goal,
    treePointBudget,
    log,
    skillProfile,
  );
  log.push(`Tree allocation done: ${pointsSpent} points spent, ${allocated.size} total nodes`);

  // 5. Gear scaffolding — placeholder Rares for all slots so DPS calc works.
  //    Runs before skill setup so suggest_gem_link's supports get measurable
  //    deltas (otherwise baseline=0 and every support is Δ=0).
  const equippedSlots: string[] = [];
  if (opts.generateGear !== false) {
    const caster = ["witch", "sorceress"].includes(className.toLowerCase());
    const gear = generateGear(forkPath, { className, level, caster });
    log.push(`Equipping ${gear.length} placeholder rares...`);
    for (const item of gear) {
      const r = await bridge.send({
        action: "add_item_text",
        params: { text: item.text, equip: item.equip, slot: item.slot },
      });
      if (r.ok === false) {
        log.push(`  ✗ ${item.slot}: ${r.error}`);
      } else {
        equippedSlots.push(item.slot);
      }
    }
    log.push(`Gear equipped: ${equippedSlots.length}/${gear.length} slots`);
    const preSkillStats = ((await bridge.send({ action: "get_stats" })).stats ?? {}) as Record<string, number>;
    const preSkillSk = ((await bridge.send({ action: "get_skills" })).skills ?? {}) as {
      groups?: unknown[]; mainSocketGroup?: number;
    };
    log.push(
      `Pre-skill: DPS=${preSkillStats.TotalDPS ?? 0}, Life=${preSkillStats.Life ?? 0}, ` +
      `groups=${(preSkillSk.groups ?? []).length}, mainSocketGroup=${preSkillSk.mainSocketGroup}`,
    );
  }

  // 7. Skill loadout (optional) — main + secondary damage skills, each a Full-DPS group.
  let skillResult: {
    mainSkill: string;
    supports: string[];
    secondary: Array<{ skill: string; supports: string[]; groupIndex: number }>;
  } | null = null;
  if (opts.mainSkillName) {
    try {
      skillResult = await addSkillLoadout(
        bridge,
        forkPath,
        opts.mainSkillName,
        opts.secondarySkills ?? [],
        slot,
        supportCount,
        gemLevel,
        log,
      );
    } catch (e) {
      log.push(`Skill loadout failed: ${(e as Error).message}`);
    }
  }

  // 7b. Attribute satisfaction — with gems + gear in place the calc now reports
  //     real Req*; close the gap so the build can actually equip everything.
  try {
    await satisfyAttributes(bridge, forkPath, treeVersion, allocated, log);
  } catch (e) {
    log.push(`Attribute satisfaction failed: ${(e as Error).message}`);
  }

  // 8. Calc-based refinement pass.
  //    With gear + skill in place, TotalDPS is now > 0. Use suggest_node_swaps
  //    to identify dead allocations and swap them for measurable upgrades.
  //    This is where the build actually becomes good — the stat-text heuristic
  //    picks reasonable nodes but doesn't know about synergy.
  let calcRefineSwaps = 0;
  const refine = opts.refineWithCalc !== false && skillResult != null;
  const refineLimit = opts.refineSwapLimit ?? 8;
  if (refine) {
    try {
      const swap = await suggestNodeSwaps(bridge, forkPath, {
        targetMetric: goal === "life" ? "Life" : "TotalDPS",
        maxDepth: 2,
        maxCandidates: 30,
        limit: refineLimit,
      });
      log.push(
        `Calc refine: baseline=${swap.baseline}, ${swap.proposals.length} candidate swaps ` +
        `(top delta=${swap.proposals[0]?.delta ?? 0})`
      );
      // Apply any positive-delta swap above noise floor (0.1% of baseline).
      // Lower threshold than initial v2 — even small wins compound when we
      // apply several in a row.
      const baseline = swap.baseline || 1;
      const noiseFloor = Math.max(0.1, baseline * 0.001);
      const meaningful = swap.proposals.filter((p) => p.delta > noiseFloor);
      for (const p of meaningful.slice(0, refineLimit)) {
        const apply = await bridge.send({
          action: "update_tree_delta",
          params: {
            removeNodes: [p.drop.id],
            addNodes: [p.add.id],
          },
        });
        if (apply.ok === false) {
          log.push(`  swap ${p.drop.name} → ${p.add.name}: ${apply.error}`);
          continue;
        }
        calcRefineSwaps++;
        if (calcRefineSwaps <= 5) {
          log.push(`  swap +${p.delta} : drop '${p.drop.name}' → add '${p.add.name}'`);
        }
      }
      log.push(`Calc refine applied: ${calcRefineSwaps} swaps`);
    } catch (e) {
      log.push(`Calc refine skipped: ${(e as Error).message}`);
    }
  }

  // 9. Export
  const exp = await bridge.send({ action: "export_build_xml" });
  if (exp.ok === false || typeof exp.xml !== "string") throw new Error(`export: ${exp.error || "no xml"}`);
  const buildXml = exp.xml;
  const buildCode = encodeBuildCode(buildXml);

  // Final stats snapshot
  let finalDPS: number | undefined;
  let finalFullDPS: number | undefined;
  let finalLife: number | undefined;
  try {
    const stats = (await bridge.send({ action: "get_stats" })).stats as Record<string, number>;
    finalDPS = stats.TotalDPS;
    finalFullDPS = stats.FullDPS;
    finalLife = stats.Life;
  } catch {
    /* non-fatal */
  }

  // 10. Content check — is it actually good? TTK + survivability vs real enemies,
  //     so the result is validated against content, not just a DPS number.
  let content: Array<{ target: string; verdict: string; summary: string }> = [];
  if (skillResult != null) {
    try {
      const verdicts = await evaluateBuild(bridge, forkPath);
      content = verdicts.map((v) => ({ target: v.target.name, verdict: v.verdict, summary: v.summary }));
      for (const v of verdicts) log.push(`Content: ${v.summary}`);
    } catch (e) {
      log.push(`Content eval skipped: ${(e as Error).message}`);
    }
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
      secondary: skillResult?.secondary ?? [],
      equippedSlots,
      calcRefineSwaps,
      finalDPS,
      finalFullDPS,
      finalLife,
      content,
    },
    log,
    elapsedMs: Date.now() - start,
  };
}
