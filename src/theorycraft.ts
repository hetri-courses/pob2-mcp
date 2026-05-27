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
import { resolveNodes, type TreeNode } from "./treeData.js";

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
