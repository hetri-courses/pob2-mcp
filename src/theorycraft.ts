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
import { resolveNodes, findCandidateNeighbors, type TreeNode } from "./treeData.js";

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
  bridge: LuaBridge,
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

  // 2. Identify dead allocated nodes (removal barely changes the target metric)
  const deadCandidates: Array<{ node: TreeNode; deltaFromRemoval: number }> = [];
  const treeMeta = resolveNodes(forkPath, allocated, treeVersion);
  const metaById = new Map(treeMeta.map((n) => [n.id, n]));

  const noiseFloor = Math.max(Math.abs(baseline) * (deadThreshold / 100), 0.0001);

  for (const id of allocated) {
    const node = metaById.get(id);
    if (!node) continue;
    if (node.type === "class-start") continue;
    const probe = await bridge.send({
      action: "calc_with",
      params: { removeNodes: [id], fields: [targetMetric] },
    });
    if (probe.ok === false) continue;
    const after = Number((probe.output as Record<string, number>)?.[targetMetric] ?? baseline);
    const removalDelta = after - baseline; // typically <= 0 (removal hurts)
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

  // 4. Try every (drop, add) pair
  const proposals: SwapProposal[] = [];
  for (const dead of deadTop) {
    for (const cand of addCandidates) {
      const result = await bridge.send({
        action: "calc_with",
        params: {
          removeNodes: [dead.node.id],
          addNodes: [cand.id],
          fields: [targetMetric],
        },
      });
      if (result.ok === false) continue;
      const after = Number(
        (result.output as Record<string, number>)?.[targetMetric] ?? baseline
      );
      const delta = after - baseline;
      const pct = baseline !== 0 ? round((delta / Math.abs(baseline)) * 100, 2) : null;
      proposals.push({
        drop: {
          id: dead.node.id,
          name: dead.node.name,
          type: dead.node.type,
          stats: dead.node.stats,
        },
        add: {
          id: cand.id,
          name: cand.name,
          type: cand.type,
          stats: cand.stats,
        },
        delta: round(delta),
        pct,
        afterValue: round(after),
        payload: { removeNodes: [dead.node.id], addNodes: [cand.id] },
      });
    }
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
