#!/usr/bin/env node
/**
 * pob2-mcp — MCP server for Path of Building 2.
 *
 * Phase 1 (always available): XML codec + typed parser. No PoB install needed.
 * Phase 2 (opt-in via POB_FORK_PATH): persistent LuaJIT subprocess running
 * the patched HeadlessWrapper.lua, exposing PoB2's real calc engine via stdio
 * JSON-RPC. See docs/PORT_PLAN.md.
 *
 * Required env for Phase 2:
 *   POB_FORK_PATH    Absolute Windows path to pob2-fork/src/ (the directory
 *                    containing the patched HeadlessWrapper.lua).
 *   POB_WSL_DISTRO   Optional. WSL distro name; defaults to the active distro.
 *
 * Hot reload: when POB2_HOT_RELOAD=1, codec/build modules re-import on src
 * changes. The Lua bridge subprocess is NOT reloaded — that requires a
 * server restart (Phase 2 calc state is expensive to rebuild).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { watch as chokidarWatch } from "chokidar";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LuaBridge, LuaBridgeError, type LuaResponse } from "./luaBridge.js";
import { LuaBridgePool } from "./luaBridgePool.js";
import { searchNodes, getNode, resolveNodes, findPathToNode, type TreeNodeType } from "./treeData.js";
import { fetchBuild, FetchBuildError } from "./fetchBuild.js";
import {
  findDeadNodes,
  simulateLevelUp,
  analyzeItemUpgrade,
  suggestNodeSwaps,
  bottleneckAnalysis,
  suggestGemLink,
} from "./theorycraft.js";
import { synthesizeBuild } from "./buildGen.js";
import { loadClasses } from "./classes.js";
import { searchRunes, getRune } from "./runes.js";
import { searchUniques, getUnique } from "./uniques.js";
import { generateBuildGuide } from "./htmlGuide.js";
import { searchGems, getGem, gemStats, type GemType } from "./gemData.js";

const SERVER_NAME = "pob2-mcp";
const SERVER_VERSION = "0.0.1";

// ----- Reloadable module references ------------------------------------------

type CodecMod = typeof import("./codec.js");
type BuildMod = typeof import("./build.js");

let codec: CodecMod;
let buildMod: BuildMod;

/**
 * (Re)load the codec and build-parser modules.
 *
 * On first call: standard imports. On subsequent calls: cache-busted dynamic
 * imports so Node treats them as fresh modules. The new exports replace the
 * old ones; existing handler closures see the new code on their next call.
 */
async function loadModules(): Promise<void> {
  const first = !codec;
  if (first) {
    codec = await import("./codec.js");
    buildMod = await import("./build.js");
  } else {
    const v = Date.now();
    codec = await import(`./codec.js?v=${v}`);
    buildMod = await import(`./build.js?v=${v}`);
  }
}

// ----- Tool catalog ----------------------------------------------------------

const TOOLS = [
  {
    name: "decode_build_code",
    description:
      "Decode a PoB2 build code (the base64-encoded share string) into the underlying XML. " +
      "Use this when the user pastes a build code and you need to see what's inside.",
    inputSchema: {
      type: "object",
      properties: {
        buildCode: {
          type: "string",
          description: "The PoB2 build code, e.g. from pobb.in or a Maxroll share link.",
        },
      },
      required: ["buildCode"],
    },
  },
  {
    name: "encode_build_code",
    description:
      "Encode a raw PoB2 XML payload back into a build code that can be imported into PoB2 or shared.",
    inputSchema: {
      type: "object",
      properties: {
        xml: { type: "string", description: "The raw <PathOfBuilding>...</PathOfBuilding> XML." },
      },
      required: ["xml"],
    },
  },
  {
    name: "parse_build",
    description:
      "Decode and parse a PoB2 build code into a typed structure: character meta, passive trees, " +
      "skill socket groups (gem links), and equipped items. The right tool for 'what's in this build?'.",
    inputSchema: {
      type: "object",
      properties: {
        buildCode: { type: "string", description: "The PoB2 build code." },
      },
      required: ["buildCode"],
    },
  },
  {
    name: "summarize_build",
    description:
      "Decode a PoB2 build code and return a high-level natural-language summary: class, " +
      "ascendancy, level, main skill, key supports, item highlights. Use when a user shares a " +
      "build and you want a quick overview before drilling in.",
    inputSchema: {
      type: "object",
      properties: {
        buildCode: { type: "string", description: "The PoB2 build code." },
      },
      required: ["buildCode"],
    },
  },
  // ----- Phase 2 tools (require POB_FORK_PATH + Lua bridge) -----
  {
    name: "lua_ping",
    description:
      "Health-check the PoB2 Lua bridge subprocess. Returns true if the calc engine is alive. " +
      "Phase 2: only works if POB_FORK_PATH is configured.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "lua_load_build",
    description:
      "Load a PoB2 build code into the live calc engine. Use this BEFORE calling lua_get_stats " +
      "to populate the build state. Phase 2 only.",
    inputSchema: {
      type: "object",
      properties: {
        buildCode: { type: "string", description: "PoB2 build code (URL-safe base64+zlib XML)." },
        name: { type: "string", description: "Optional build name for the calc context (default 'API Build')." },
      },
      required: ["buildCode"],
    },
  },
  {
    name: "lua_get_stats",
    description:
      "Read the current build's offence/defence stats from PoB2's calc engine. Returns real " +
      "Life/ES/Armour/Evasion/Resists/Mana/etc. as computed by PoB. Requires a build to be loaded " +
      "first (use lua_load_build). Phase 2 only.",
    inputSchema: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: limit the response to specific stat names (e.g. ['Life','TotalDPS']). " +
            "If omitted, returns the default stat set.",
        },
      },
    },
  },
  {
    name: "lua_get_build_info",
    description:
      "Read top-level build metadata from the live calc engine: name, level, class, " +
      "ascendancy, tree version. Phase 2 only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "lua_get_tree",
    description:
      "Read the current build's passive tree from the live calc engine: allocated node IDs, " +
      "class/ascendancy class IDs, tree version, mastery effects. Useful before lua_calc_with " +
      "for planning node swaps.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "lua_get_skills",
    description:
      "Read the current build's skill setup: socket groups (gem links), main active skill, " +
      "which group is configured as the DPS source. Phase 2 only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "lua_get_items",
    description:
      "Read the current build's equipped items: name, baseName, type, rarity, raw mod text, " +
      "and active flag for flasks/tinctures. By default returns ONLY equipped slots; set " +
      "onlyEquipped=false to see every slot the build can have (empty included). Phase 2 only.",
    inputSchema: {
      type: "object",
      properties: {
        onlyEquipped: {
          type: "boolean",
          description: "If true (default), skip empty slots. Set false to enumerate all slots.",
        },
      },
    },
  },
  {
    name: "lua_get_config",
    description:
      "Read PoB calc configuration: enemy level, boss flags, charges, buff toggles. These " +
      "settings affect DPS/EHP calculations. Phase 2 only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "lua_calc_with",
    description:
      "Theorycraft what-if: recompute build stats with a HYPOTHETICAL set of node " +
      "additions/removals, without persisting the change. Use this to answer 'what if I " +
      "take node X instead of node Y?' — get back the hypothetical Life/DPS/EHP/etc. and " +
      "compare against the current build's stats. Phase 2 only.",
    inputSchema: {
      type: "object",
      properties: {
        addNodes: {
          type: "array",
          items: { type: "number" },
          description: "Passive node IDs to hypothetically allocate.",
        },
        removeNodes: {
          type: "array",
          items: { type: "number" },
          description: "Passive node IDs to hypothetically deallocate.",
        },
        useFullDPS: {
          type: "boolean",
          description: "Use FullDPS (all skills combined) instead of main-skill DPS.",
        },
      },
    },
  },
  {
    name: "compare_builds",
    description:
      "Load two PoB2 build codes sequentially, compute stats for each, and return a side-by-side " +
      "diff. Reports which stats improved, regressed, or stayed the same. Synthesized tool — uses " +
      "the live calc engine internally. Phase 2 only.",
    inputSchema: {
      type: "object",
      properties: {
        buildCodeA: { type: "string", description: "First build code (baseline)." },
        buildCodeB: { type: "string", description: "Second build code (comparison)." },
        labelA: { type: "string", description: "Optional label for build A (default 'A')." },
        labelB: { type: "string", description: "Optional label for build B (default 'B')." },
      },
      required: ["buildCodeA", "buildCodeB"],
    },
  },
  // ----- Phase 4A: Tree-node metadata (static data, no Lua bridge needed) ----
  {
    name: "search_tree_nodes",
    description:
      "Search the PoE2 passive tree by node name (and optionally stats). Returns ranked results " +
      "with each node's ID, name, type (keystone/notable/normal/ascendancy-*), and stat lines. " +
      "Use this to translate human queries like 'Hollow Palm' into node IDs you can pass to " +
      "lua_calc_with. Requires POB_FORK_PATH (uses static TreeData/<version>/tree.json).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term (e.g. 'Hollow Palm', 'attack speed')." },
        treeVersion: { type: "string", description: "Tree version (default '0_4')." },
        types: {
          type: "array",
          items: { type: "string", enum: ["keystone", "notable", "normal", "ascendancy-notable", "ascendancy-normal", "jewel-socket", "class-start", "mastery"] },
          description: "Restrict to these node types.",
        },
        ascendancy: { type: "string", description: "Restrict to a specific ascendancy class name (e.g. 'Invoker', 'Pathfinder')." },
        matchStats: { type: "boolean", description: "Also match against stat text (slower but useful for 'find me all evasion nodes')." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_tree_node",
    description:
      "Look up a single passive tree node by its numeric ID. Returns name, stats, type, " +
      "ascendancy (if applicable). Use this to identify a node you got from lua_get_tree.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Node ID." },
        treeVersion: { type: "string", description: "Tree version (default '0_4')." },
      },
      required: ["id"],
    },
  },
  {
    name: "resolve_tree_nodes",
    description:
      "Bulk-resolve a list of node IDs to their names + types + stats. Useful for translating " +
      "a lua_get_tree response into a human-readable build summary.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "number" }, description: "Node IDs to resolve." },
        treeVersion: { type: "string", description: "Tree version (default '0_4')." },
      },
      required: ["ids"],
    },
  },
  // ----- Phase 4B: URL fetcher ----------------------------------------------
  {
    name: "fetch_build_from_url",
    description:
      "Resolve a pobb.in URL (or a raw build code) into a build code ready for parse_build / " +
      "lua_load_build. Saves users from pasting 5000+ char base64 strings into chat. Accepts " +
      "URLs like 'https://pobb.in/abc123' or 'pobb.in/abc123/raw', or a raw build-code string " +
      "(returned as-is). Only pobb.in supported initially.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "pobb.in URL or raw build code." },
      },
      required: ["url"],
    },
  },
  // ----- Phase 4D: Mutation tools (modify loaded build state) ---------------
  {
    name: "lua_set_level",
    description:
      "Set the character level on the loaded build and recompute stats. Useful for projecting " +
      "stats at endgame (e.g. set level 90 to see what a leveling build looks like maxed out).",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "number", description: "Character level (1-100)." },
      },
      required: ["level"],
    },
  },
  {
    name: "lua_set_config",
    description:
      "Update PoB calc config — boss level, charges, buff flags — and recompute. Affects DPS/EHP.",
    inputSchema: {
      type: "object",
      properties: {
        enemyLevel: { type: "number", description: "Override enemy level for calcs." },
        bandit: { type: "string", description: "PoE1 bandit reward (may be unused in PoE2)." },
        pantheonMajorGod: { type: "string" },
        pantheonMinorGod: { type: "string" },
      },
    },
  },
  {
    name: "lua_update_tree_delta",
    description:
      "PERSIST a tree change to the loaded build: add and/or remove a list of node IDs. Unlike " +
      "lua_calc_with (which is transient), this actually mutates the build state. Recomputes " +
      "stats. Useful for committing to a node swap after theorycrafting it.",
    inputSchema: {
      type: "object",
      properties: {
        addNodes: { type: "array", items: { type: "number" } },
        removeNodes: { type: "array", items: { type: "number" } },
        classId: { type: "number" },
        ascendClassId: { type: "number" },
        secondaryAscendClassId: { type: "number" },
        treeVersion: { type: "string" },
      },
    },
  },
  {
    name: "lua_add_item_text",
    description:
      "Add an item to the build by pasting its raw item text (the in-game copy-paste format). " +
      "Optionally equip it to a specific slot. Useful for 'add this Mageblood and see what it does'.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Raw item text in PoE in-game copy-paste format." },
        slotName: { type: "string", description: "Optional slot to equip to (e.g. 'Belt')." },
        noAutoEquip: { type: "boolean", description: "If true, just add to inventory without equipping." },
      },
      required: ["text"],
    },
  },
  {
    name: "lua_set_gem_level",
    description:
      "Set the level of a specific gem in a socket group. Use lua_get_skills to find the " +
      "groupIndex and gemIndex first. Recomputes stats.",
    inputSchema: {
      type: "object",
      properties: {
        groupIndex: { type: "number", description: "1-based index from lua_get_skills.groups[].index" },
        gemIndex: { type: "number", description: "1-based index from gems[].index" },
        level: { type: "number" },
      },
      required: ["groupIndex", "gemIndex", "level"],
    },
  },
  {
    name: "lua_set_gem_quality",
    description: "Set a gem's quality % (0-20+ in PoE2). Recomputes stats.",
    inputSchema: {
      type: "object",
      properties: {
        groupIndex: { type: "number" },
        gemIndex: { type: "number" },
        quality: { type: "number" },
        qualityId: { type: "string", description: "Optional quality type (e.g. 'Default')." },
      },
      required: ["groupIndex", "gemIndex", "quality"],
    },
  },
  {
    name: "lua_export_build_code",
    description:
      "Serialize the current build state (with any mutations applied) back to a PoB2 build code, " +
      "ready to share via pobb.in or import into PoB2 directly.",
    inputSchema: { type: "object", properties: {} },
  },
  // ----- Phase 4E: synthesized theorycraft tools ----------------------------
  {
    name: "find_dead_nodes",
    description:
      "For each allocated passive node, recompute the build's stats with that node hypothetically " +
      "removed. Ranks nodes by 'dead weight' — those whose removal barely affects DPS/EHP/Life " +
      "are candidates for refunding. Runs lua_calc_with once per node; expect ~1s for a 17-node " +
      "build. Does NOT persist changes (uses calc_with's transient mode).",
    inputSchema: {
      type: "object",
      properties: {
        stats: {
          type: "array",
          items: { type: "string" },
          description: "Which stats to sample (default: TotalDPS, CombinedDPS, Life, TotalEHP, Speed).",
        },
        nodeIds: {
          type: "array",
          items: { type: "number" },
          description: "Subset of allocated nodes to probe (default: all).",
        },
        limit: { type: "number", description: "Cap the candidate list length." },
        treeVersion: { type: "string" },
      },
    },
  },
  {
    name: "simulate_level_up",
    description:
      "Compute stat sheets at a sequence of character levels (e.g. [60, 80, 90, 100]) without " +
      "permanently changing the build. Returns each sample plus the original level it restored to.",
    inputSchema: {
      type: "object",
      properties: {
        levels: {
          type: "array",
          items: { type: "number" },
          description: "Levels to sample. E.g. [60, 80, 90, 100].",
        },
        stats: {
          type: "array",
          items: { type: "string" },
          description: "Stats to sample at each level.",
        },
      },
      required: ["levels"],
    },
  },
  // ----- Phase 5B: Gem database (static, no Lua bridge needed) -----
  {
    name: "search_gems",
    description:
      "Search PoE2 skill + support gems by name (and optionally tag). Returns ranked results " +
      "with each gem's id, name, type (Spell/Attack/Support/Minion/Mark/Buff/Warcry/Banner/etc.), " +
      "tags, stat requirements, tier. Use this to find gem names → lua_add_gem-able identifiers. " +
      "903 gems in the PoE2 0_4 dataset.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term (e.g. 'Tempest Bell', 'lightning')." },
        gemType: {
          type: "string",
          description: "Restrict by gem type: Spell, Attack, Support, Minion, Mark, Buff, Warcry, Banner, Shapeshift, Totem.",
        },
        tag: { type: "string", description: "Restrict by tag (e.g. 'lightning', 'melee', 'projectile')." },
        matchTags: { type: "boolean", description: "Also match against tagString text." },
        supportOnly: { type: "boolean", description: "Return only support gems." },
        activeOnly: { type: "boolean", description: "Return only active-skill gems (no supports)." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_gem",
    description:
      "Look up a gem by id (Metadata/...) or by exact name. Returns full metadata: tags, " +
      "stat requirements, gem family, tier, natural max level.",
    inputSchema: {
      type: "object",
      properties: {
        idOrName: { type: "string", description: "Gem id (Metadata/Items/Gems/...) or exact name." },
      },
      required: ["idOrName"],
    },
  },
  {
    name: "gem_database_stats",
    description:
      "Get aggregate statistics about the gem database: total count, breakdown by gem type, " +
      "unique tag count. Useful sanity-check / overview.",
    inputSchema: { type: "object", properties: {} },
  },
  // ----- Phase 5C: Item analysis -----
  {
    name: "lua_parse_item_text",
    description:
      "Parse a PoE2 item text (in-game copy-paste format) into structured fields — name, base, " +
      "rarity, requirements, mod lists — WITHOUT adding it to the build. Useful for inspecting " +
      "items before deciding to equip them. Phase 2 (Lua bridge).",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Raw item text in PoE2 in-game copy-paste format." },
      },
      required: ["text"],
    },
  },
  {
    name: "analyze_item_upgrade",
    description:
      "What-if for items: snapshot current stats, equip the item, snapshot again, then roll " +
      "back the build state. Returns stat deltas (Life, DPS, EHP, etc.) so you can decide if " +
      "an item is an upgrade. Phase 2 — requires a build to be loaded first.",
    inputSchema: {
      type: "object",
      properties: {
        itemText: { type: "string", description: "Raw item text in PoE2 paste format." },
        slotName: { type: "string", description: "Optional slot to equip (e.g. 'Belt'). Defaults to auto." },
        stats: {
          type: "array",
          items: { type: "string" },
          description: "Stats to sample (default: TotalDPS, Life, TotalEHP, etc.).",
        },
      },
      required: ["itemText"],
    },
  },
  // ----- Phase 7: HTML build guide generator -----
  {
    name: "generate_build_guide",
    description:
      "Generate a single self-contained HTML build guide for the currently-loaded build. " +
      "Pulls live calc-engine stats, resolves passive node names + icons, gem links + tooltips, " +
      "equipped items + rarity colors, and renders into one .html file with inline CSS+JS. Icons " +
      "are fetched from poe2db.tw and base64-embedded so the file works offline once generated. " +
      "Auto-links PoE2 jargon to a glossary section. Output defaults to " +
      "D:\\pob2-mcp\\generated\\<buildName>.html.",
    inputSchema: {
      type: "object",
      properties: {
        outputPath: { type: "string", description: "Override full output path." },
        outputDir: { type: "string", description: "Override output directory (filename auto-derived from build name)." },
        title: { type: "string", description: "Override page title." },
        fetchIcons: { type: "boolean", description: "Set false to skip network icon fetches (use placeholders only). Default true." },
        iconTimeoutMs: { type: "number", description: "Per-icon fetch timeout (default 10000)." },
      },
    },
  },
  // ----- Phase 6D: gem suggestions -----
  {
    name: "suggest_gem_link",
    description:
      "Find which support gems would improve a socket group's main skill. Filters via PoB's " +
      "calcLib.canGrantedEffectSupportActiveSkill (real requireSkillTypes/excludeSkillTypes check), " +
      "then simulates each candidate via add_gem → get_stats → remove_gem. Returns ranked " +
      "proposals with action-ready payloads. Non-persistent — won't mutate the loaded build.",
    inputSchema: {
      type: "object",
      properties: {
        groupIndex: { type: "number", description: "Socket group index (default: build's mainSocketGroup)." },
        targetMetric: { type: "string", description: "Stat to optimize. Default 'TotalDPS'." },
        maxCandidates: { type: "number", description: "How many supports to actually simulate (ranked by a damage-tag heuristic first). Default 60 (~6s). Pass a high value (e.g. 250) to test ALL compatible supports — exhaustive but slower; the heuristic can't see tag-less damage supports like some crit gems." },
        limit: { type: "number", description: "Max proposals to return. Default 8." },
        simLevel: { type: "number", description: "Gem level for the simulated add. Default 20." },
        simQuality: { type: "number", description: "Gem quality for the simulated add. Default 20." },
      },
    },
  },
  // ----- Phase 8G: build synthesis -----
  {
    name: "synthesize_build",
    description:
      "Generate a complete starter PoE2 build from class + level + main skill. Pipeline: " +
      "fresh-build → set class+ascendancy → greedy stat-text tree allocation (toward goal: " +
      "dps/life/hybrid/defence) → equip placeholder Rare gear for all 9+ slots → create " +
      "socket group with main skill → add compatible supports via suggest_gem_link → " +
      "calc-based tree refinement (suggest_node_swaps using real DPS deltas) → export. " +
      "Returns a PoB-importable build code with measurable Life and DPS — verified across " +
      "Monk/Witch/Warrior/Ranger end-to-end. Ascendancy is fully activated (ascendClassName " +
      "set in XML, auto-allocates the ascendancy start node). v2 typically runs in 5-9s.",
    inputSchema: {
      type: "object",
      properties: {
        className: { type: "string", description: "Class name, e.g., 'Monk', 'Witch', 'Warrior'." },
        ascendancyName: { type: "string", description: "Optional ascendancy name, e.g., 'Invoker', 'Stormweaver'." },
        level: { type: "number", description: "Character level. Default 90." },
        mainSkillName: { type: "string", description: "Active skill gem name, e.g., 'Tempest Bell', 'Spark', 'Earthquake'." },
        goal: { type: "string", description: "'dps' | 'life' | 'hybrid' | 'defence'. Default 'dps'." },
        treePointBudget: { type: "number", description: "Extra points to allocate (beyond class start). Default: min(level-2, 100)." },
        supportCount: { type: "number", description: "How many supports to add to the main group. Default 3." },
        gemLevel: { type: "number", description: "Level for main skill + supports. Default 20." },
        slot: { type: "string", description: "Socket group slot. Default 'Weapon 1'." },
        generateGear: { type: "boolean", description: "Equip placeholder Rare gear for all slots. Default true. Set false if caller will populate items separately." },
        refineWithCalc: { type: "boolean", description: "Run a final calc-based tree refinement pass via suggest_node_swaps. Default true." },
        refineSwapLimit: { type: "number", description: "Max calc-refinement swaps to apply. Default 8." },
      },
      required: ["className"],
    },
  },
  {
    name: "list_classes",
    description:
      "List all PoE2 classes and their ascendancies for the loaded tree version. " +
      "Useful before calling synthesize_build to pick valid (className, ascendancyName) pairs. " +
      "Honors POB_TREE_VERSION (set 0_5 to see Martial Artist / Spirit Walker).",
    inputSchema: {
      type: "object",
      properties: {
        treeVersion: { type: "string", description: "Tree version (default from POB_TREE_VERSION env, else '0_4')." },
      },
    },
  },
  // ----- Runes / Soul Cores (static, parses Data/ModRunes.lua) -----
  {
    name: "search_runes",
    description:
      "Search PoE2 runes + soul cores (socketable augments) by name, mod text, slot, or type. " +
      "Reads Data/ModRunes.lua directly — no calc engine needed. Covers whatever version the " +
      "pob2-fork is synced to (0.5's Ancient Runes + Runic Ward Runes appear automatically once " +
      "the fork updates). Returns name, per-slot effects, and rank.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to match against rune name / mod text. Empty = list all (up to limit)." },
        slot: { type: "string", description: "Filter to runes usable in a slot (e.g., 'helmet', 'body armour', 'weapon')." },
        type: { type: "string", description: "Filter by augment type (e.g., 'Rune', 'SoulCore')." },
        limit: { type: "number", description: "Max results. Default 30." },
      },
    },
  },
  {
    name: "get_rune",
    description: "Get full details for a single rune / soul core by exact name (per-slot effects + rank).",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Exact rune name." } },
      required: ["name"],
    },
  },
  // ----- Unique items (static, parses Data/Uniques/*.lua) -----
  {
    name: "search_uniques",
    description:
      "Search PoE2 unique items by name, base type, or mod text. Reads Data/Uniques/*.lua directly " +
      "— no calc engine needed. Returns name, base type, slot category, variants, and mod lines " +
      "(PoB markup stripped). New uniques appear automatically once the pob2-fork updates.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to match against unique name / base type / mod text. Empty = list all (up to limit)." },
        category: { type: "string", description: "Filter by slot category (amulet, body, staff, ring, etc.)." },
        limit: { type: "number", description: "Max results. Default 30." },
      },
    },
  },
  {
    name: "get_unique",
    description: "Get full details for a single unique item by exact name (base type, variants, all mods).",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Exact unique name, e.g., 'Astramentis'." } },
      required: ["name"],
    },
  },
  // ----- Phase 6C: diagnostic -----
  {
    name: "bottleneck_analysis",
    description:
      "Diagnose the loaded build: what's holding back DPS or EHP? Reads stats and flags issues " +
      "like low hit chance, underused Crit Multiplier, uncapped resistances, unused Spirit, " +
      "mana-locked skills, lopsided EHP layers. Returns a ranked list of bottlenecks with " +
      "severity (high/medium/low) and concrete advice. Pure stat analysis — no extra calc " +
      "calls, ~50ms.",
    inputSchema: { type: "object", properties: {} },
  },
  // ----- Phase 6B: pathfinding -----
  {
    name: "find_path_to_node",
    description:
      "Find the cheapest path from the currently-loaded build's allocation to a target passive " +
      "node. Returns the ordered sequence of intermediate UNALLOCATED nodes to take (including " +
      "the target itself) plus total point cost. Use after suggest_node_swaps when a recommended " +
      "add is multiple hops from your current tree. Skips ascendancy and jewel-socket nodes " +
      "during traversal (same routing rules PoB uses).",
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "number", description: "Node ID to path to (use search_tree_nodes to find one)." },
        treeVersion: { type: "string", description: "Tree version (default '0_4')." },
        maxHops: { type: "number", description: "BFS hop limit (default 30)." },
      },
      required: ["targetId"],
    },
  },
  // ----- Phase 6A: suggestion engine -----
  {
    name: "suggest_node_swaps",
    description:
      "Recommend passive-tree swaps that improve a target metric (default TotalDPS). " +
      "Identifies 'dead' allocated nodes (whose removal barely affects the metric), pairs each " +
      "with unallocated neighbors within `maxDepth` hops, runs hypothetical calc_with for each " +
      "swap, and returns ranked proposals with action-ready payloads for lua_update_tree_delta. " +
      "Non-persistent — does NOT mutate the loaded build. Typical runtime ~1-3 seconds.",
    inputSchema: {
      type: "object",
      properties: {
        targetMetric: {
          type: "string",
          description: "Stat to optimize (e.g. 'TotalDPS', 'TotalEHP', 'Life'). Default: TotalDPS.",
        },
        maxDepth: {
          type: "number",
          description: "BFS hop limit from current tree (1=direct neighbors only). Default 2.",
        },
        maxCandidates: {
          type: "number",
          description: "Cap on add-candidate count. Default 30.",
        },
        maxDead: {
          type: "number",
          description: "Cap on dead-node candidates we'll consider dropping. Default 5.",
        },
        limit: { type: "number", description: "Max proposals to return. Default 10." },
        deadThreshold: {
          type: "number",
          description: "Percentage impact threshold below which a node is considered 'dead'. Default 1.0.",
        },
        treeVersion: { type: "string", description: "Tree version (default '0_4')." },
      },
    },
  },
] as const;

// ----- Server setup ----------------------------------------------------------

await loadModules();

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  // Declare tools.listChanged so the client honors our hot-reload notifications
  { capabilities: { tools: { listChanged: true } } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    switch (name) {
      case "decode_build_code":
        return ok({ xml: codec.decodeBuildCode(str(args, "buildCode")) });

      case "encode_build_code":
        return ok({ buildCode: codec.encodeBuildCode(str(args, "xml")) });

      case "parse_build": {
        const xml = codec.decodeBuildCode(str(args, "buildCode"));
        return ok(buildMod.parseBuildXml(xml));
      }

      case "summarize_build": {
        const xml = codec.decodeBuildCode(str(args, "buildCode"));
        const build = buildMod.parseBuildXml(xml);
        return ok({ summary: summarize(build), build });
      }

      // ----- Phase 2: live calc engine via Lua bridge -----
      case "lua_ping": {
        const b = await ensureBridge();
        const pong = await b.ping();
        return ok({ alive: pong });
      }
      case "lua_load_build": {
        const b = await ensureBridge();
        const buildCode = str(args, "buildCode");
        const xml = codec.decodeBuildCode(buildCode);
        const buildName =
          (args as Record<string, unknown> | undefined)?.name as string | undefined;
        const r = await b.send({
          action: "load_build_xml",
          params: { xml, name: buildName ?? "API Build" },
        });
        // Keep pool replicas in sync if a pool exists
        if (pool && r.ok !== false) {
          try { await pool.resyncFromPrimary(); }
          catch (e) { console.error("[lua-pool] resync failed:", e); }
        }
        return luaResponseTo(r);
      }
      case "lua_get_stats": {
        const b = await ensureBridge();
        const fields = (args as Record<string, unknown> | undefined)?.fields;
        const r = await b.send({
          action: "get_stats",
          params: Array.isArray(fields) ? { fields } : {},
        });
        return luaResponseTo(r);
      }
      case "lua_get_build_info": {
        const b = await ensureBridge();
        const r = await b.send({ action: "get_build_info" });
        return luaResponseTo(r);
      }
      case "lua_get_tree": {
        const b = await ensureBridge();
        const r = await b.send({ action: "get_tree" });
        return luaResponseTo(r);
      }
      case "lua_get_skills": {
        const b = await ensureBridge();
        const r = await b.send({ action: "get_skills" });
        return luaResponseTo(r);
      }
      case "lua_get_items": {
        const b = await ensureBridge();
        const a = (args as Record<string, unknown> | undefined) ?? {};
        const params: Record<string, unknown> = {};
        if (typeof a.onlyEquipped === "boolean") params.onlyEquipped = a.onlyEquipped;
        const r = await b.send({ action: "get_items", params });
        return luaResponseTo(r);
      }
      case "lua_get_config": {
        const b = await ensureBridge();
        const r = await b.send({ action: "get_config" });
        return luaResponseTo(r);
      }
      case "lua_calc_with": {
        const b = await ensureBridge();
        const a = (args as Record<string, unknown> | undefined) ?? {};
        const params: Record<string, unknown> = {};
        if (Array.isArray(a.addNodes)) params.addNodes = a.addNodes;
        if (Array.isArray(a.removeNodes)) params.removeNodes = a.removeNodes;
        if (typeof a.useFullDPS === "boolean") params.useFullDPS = a.useFullDPS;
        const r = await b.send({ action: "calc_with", params });
        return luaResponseTo(r);
      }
      case "compare_builds": {
        return ok(await compareBuilds(args));
      }
      case "search_tree_nodes": {
        const a = (args as Record<string, unknown> | undefined) ?? {};
        const fp = requireForkPath();
        const results = searchNodes(
          fp,
          String(a.query ?? ""),
          {
            limit: typeof a.limit === "number" ? a.limit : undefined,
            types: Array.isArray(a.types) ? (a.types as TreeNodeType[]) : undefined,
            ascendancy: typeof a.ascendancy === "string" ? a.ascendancy : undefined,
            matchStats: a.matchStats === true,
          },
          typeof a.treeVersion === "string" ? a.treeVersion : undefined
        );
        return ok({ count: results.length, results });
      }
      case "get_tree_node": {
        const a = (args as Record<string, unknown> | undefined) ?? {};
        const id = Number(a.id);
        if (!Number.isFinite(id)) return err("id must be a number");
        const fp = requireForkPath();
        const node = getNode(fp, id, typeof a.treeVersion === "string" ? a.treeVersion : undefined);
        return node ? ok({ node }) : err(`No tree node with id ${id}`);
      }
      case "resolve_tree_nodes": {
        const a = (args as Record<string, unknown> | undefined) ?? {};
        if (!Array.isArray(a.ids)) return err("ids must be an array of numbers");
        const fp = requireForkPath();
        const nodes = resolveNodes(fp, a.ids as number[], typeof a.treeVersion === "string" ? a.treeVersion : undefined);
        return ok({ count: nodes.length, nodes });
      }
      case "fetch_build_from_url": {
        const u = str(args, "url");
        const result = await fetchBuild(u);
        return ok(result);
      }

      // ----- Phase 4D mutation tools -----
      case "lua_set_level": {
        const b = await ensureBridge();
        const a = (args as Record<string, unknown> | undefined) ?? {};
        const level = Number(a.level);
        if (!Number.isFinite(level)) return err("level must be a number");
        const r = await b.send({ action: "set_level", params: { level } });
        return luaResponseTo(r);
      }
      case "lua_set_config": {
        const b = await ensureBridge();
        const a = (args as Record<string, unknown> | undefined) ?? {};
        const r = await b.send({ action: "set_config", params: a });
        return luaResponseTo(r);
      }
      case "lua_update_tree_delta": {
        const b = await ensureBridge();
        const a = (args as Record<string, unknown> | undefined) ?? {};
        const r = await b.send({ action: "update_tree_delta", params: a });
        return luaResponseTo(r);
      }
      case "lua_add_item_text": {
        const b = await ensureBridge();
        const a = (args as Record<string, unknown> | undefined) ?? {};
        const text = String(a.text ?? "");
        if (!text) return err("text is required");
        const params: Record<string, unknown> = { text };
        if (typeof a.slotName === "string") params.slotName = a.slotName;
        if (typeof a.noAutoEquip === "boolean") params.noAutoEquip = a.noAutoEquip;
        const r = await b.send({ action: "add_item_text", params });
        return luaResponseTo(r);
      }
      case "lua_set_gem_level": {
        const b = await ensureBridge();
        const a = (args as Record<string, unknown> | undefined) ?? {};
        const r = await b.send({
          action: "set_gem_level",
          params: {
            groupIndex: Number(a.groupIndex),
            gemIndex: Number(a.gemIndex),
            level: Number(a.level),
          },
        });
        return luaResponseTo(r);
      }
      case "lua_set_gem_quality": {
        const b = await ensureBridge();
        const a = (args as Record<string, unknown> | undefined) ?? {};
        const params: Record<string, unknown> = {
          groupIndex: Number(a.groupIndex),
          gemIndex: Number(a.gemIndex),
          quality: Number(a.quality),
        };
        if (typeof a.qualityId === "string") params.qualityId = a.qualityId;
        const r = await b.send({ action: "set_gem_quality", params });
        return luaResponseTo(r);
      }
      case "lua_export_build_code": {
        const b = await ensureBridge();
        const r = await b.send({ action: "export_build_xml" });
        if (r.ok === false) return err(typeof r.error === "string" ? r.error : "export failed");
        const xml = String(r.xml ?? "");
        if (!xml) return err("export returned empty XML");
        const buildCode = codec.encodeBuildCode(xml);
        return ok({ buildCode, xmlLength: xml.length });
      }

      // ----- Phase 4E synthesized theorycraft tools -----
      case "find_dead_nodes": {
        const b = await ensureBridge();
        const fp = requireForkPath();
        const a = (args as Record<string, unknown> | undefined) ?? {};
        const result = await findDeadNodes(b, fp, {
          stats: Array.isArray(a.stats) ? (a.stats as string[]) : undefined,
          nodeIds: Array.isArray(a.nodeIds) ? (a.nodeIds as number[]) : undefined,
          limit: typeof a.limit === "number" ? a.limit : undefined,
          treeVersion: typeof a.treeVersion === "string" ? a.treeVersion : undefined,
        });
        return ok(result);
      }
      case "simulate_level_up": {
        const b = await ensureBridge();
        const a = (args as Record<string, unknown> | undefined) ?? {};
        if (!Array.isArray(a.levels)) return err("levels must be an array of numbers");
        const result = await simulateLevelUp(b, a.levels as number[], {
          stats: Array.isArray(a.stats) ? (a.stats as string[]) : undefined,
        });
        return ok(result);
      }
      // ----- Phase 5B gem database -----
      case "search_gems": {
        const fp = requireForkPath();
        const a = (args as Record<string, unknown> | undefined) ?? {};
        const results = searchGems(fp, String(a.query ?? ""), {
          limit: typeof a.limit === "number" ? a.limit : undefined,
          gemType: typeof a.gemType === "string" ? (a.gemType as GemType) : undefined,
          tag: typeof a.tag === "string" ? a.tag : undefined,
          matchTags: a.matchTags === true,
          supportOnly: a.supportOnly === true,
          activeOnly: a.activeOnly === true,
        });
        return ok({ count: results.length, results });
      }
      case "get_gem": {
        const fp = requireForkPath();
        const a = (args as Record<string, unknown> | undefined) ?? {};
        const gem = getGem(fp, String(a.idOrName ?? ""));
        return gem ? ok({ gem }) : err(`No gem found for: ${a.idOrName}`);
      }
      case "gem_database_stats": {
        const fp = requireForkPath();
        return ok(gemStats(fp));
      }
      // ----- Phase 5C item analysis -----
      case "lua_parse_item_text": {
        const b = await ensureBridge();
        const text = str(args, "text");
        const r = await b.send({ action: "parse_item_text", params: { text } });
        return luaResponseTo(r);
      }
      case "analyze_item_upgrade": {
        const b = await ensureBridge();
        const a = (args as Record<string, unknown> | undefined) ?? {};
        const itemText = String(a.itemText ?? "");
        if (!itemText) return err("itemText is required");
        const result = await analyzeItemUpgrade(b, {
          itemText,
          slotName: typeof a.slotName === "string" ? a.slotName : undefined,
          stats: Array.isArray(a.stats) ? (a.stats as string[]) : undefined,
        });
        return ok(result);
      }
      case "generate_build_guide": {
        const b = await ensureBridge();
        const fp = requireForkPath();
        const a = (args as Record<string, unknown> | undefined) ?? {};
        const result = await generateBuildGuide(b, fp, {
          outputPath: typeof a.outputPath === "string" ? a.outputPath : undefined,
          outputDir: typeof a.outputDir === "string" ? a.outputDir : undefined,
          title: typeof a.title === "string" ? a.title : undefined,
          fetchIcons: a.fetchIcons === false ? false : undefined,
          iconTimeoutMs: typeof a.iconTimeoutMs === "number" ? a.iconTimeoutMs : undefined,
        });
        return ok(result);
      }
      case "suggest_gem_link": {
        const b = await ensureBridge();
        const fp = requireForkPath();
        const a = (args as Record<string, unknown> | undefined) ?? {};
        const result = await suggestGemLink(b, fp, {
          groupIndex: typeof a.groupIndex === "number" ? a.groupIndex : undefined,
          targetMetric: typeof a.targetMetric === "string" ? a.targetMetric : undefined,
          maxCandidates: typeof a.maxCandidates === "number" ? a.maxCandidates : undefined,
          limit: typeof a.limit === "number" ? a.limit : undefined,
          simLevel: typeof a.simLevel === "number" ? a.simLevel : undefined,
          simQuality: typeof a.simQuality === "number" ? a.simQuality : undefined,
        });
        return ok(result);
      }
      case "bottleneck_analysis": {
        const b = await ensureBridge();
        const result = await bottleneckAnalysis(b);
        return ok(result);
      }
      case "synthesize_build": {
        const b = await ensureBridge();
        const fp = requireForkPath();
        const a = (args as Record<string, unknown> | undefined) ?? {};
        if (typeof a.className !== "string") return err("className is required");
        const goal = typeof a.goal === "string" ? a.goal : undefined;
        if (goal && !["dps", "life", "hybrid", "defence"].includes(goal)) {
          return err("goal must be one of: dps, life, hybrid, defence");
        }
        const result = await synthesizeBuild(b, fp, {
          className: a.className,
          ascendancyName: typeof a.ascendancyName === "string" ? a.ascendancyName : undefined,
          level: typeof a.level === "number" ? a.level : undefined,
          mainSkillName: typeof a.mainSkillName === "string" ? a.mainSkillName : undefined,
          goal: goal as "dps" | "life" | "hybrid" | "defence" | undefined,
          treePointBudget: typeof a.treePointBudget === "number" ? a.treePointBudget : undefined,
          supportCount: typeof a.supportCount === "number" ? a.supportCount : undefined,
          gemLevel: typeof a.gemLevel === "number" ? a.gemLevel : undefined,
          slot: typeof a.slot === "string" ? a.slot : undefined,
        });
        return ok(result);
      }
      case "list_classes": {
        const fp = requireForkPath();
        const a = (args as Record<string, unknown> | undefined) ?? {};
        const version = typeof a.treeVersion === "string" ? a.treeVersion : (process.env.POB_TREE_VERSION || "0_4");
        const classes = loadClasses(fp, version);
        return ok({ treeVersion: version, classes });
      }
      case "search_runes": {
        const fp = requireForkPath();
        const a = (args as Record<string, unknown> | undefined) ?? {};
        const results = searchRunes(fp, typeof a.query === "string" ? a.query : "", {
          slot: typeof a.slot === "string" ? a.slot : undefined,
          type: typeof a.type === "string" ? a.type : undefined,
          limit: typeof a.limit === "number" ? a.limit : undefined,
        });
        return ok({ count: results.length, runes: results });
      }
      case "get_rune": {
        const fp = requireForkPath();
        const a = (args as Record<string, unknown> | undefined) ?? {};
        if (typeof a.name !== "string") return err("name is required");
        const rune = getRune(fp, a.name);
        if (!rune) return err(`No rune named '${a.name}'`);
        return ok({ rune });
      }
      case "search_uniques": {
        const fp = requireForkPath();
        const a = (args as Record<string, unknown> | undefined) ?? {};
        const results = searchUniques(fp, typeof a.query === "string" ? a.query : "", {
          category: typeof a.category === "string" ? a.category : undefined,
          limit: typeof a.limit === "number" ? a.limit : undefined,
        });
        return ok({ count: results.length, uniques: results });
      }
      case "get_unique": {
        const fp = requireForkPath();
        const a = (args as Record<string, unknown> | undefined) ?? {};
        if (typeof a.name !== "string") return err("name is required");
        const unique = getUnique(fp, a.name);
        if (!unique) return err(`No unique named '${a.name}'`);
        return ok({ unique });
      }
      case "find_path_to_node": {
        const b = await ensureBridge();
        const fp = requireForkPath();
        const a = (args as Record<string, unknown> | undefined) ?? {};
        const targetId = Number(a.targetId);
        if (!Number.isFinite(targetId)) return err("targetId must be a number");
        const treeResp = await b.send({ action: "get_tree" });
        const treeObj = (treeResp.tree ?? {}) as { nodes?: number[] };
        const allocated = treeObj.nodes ?? [];
        const result = findPathToNode(fp, allocated, targetId, {
          version: typeof a.treeVersion === "string" ? a.treeVersion : undefined,
          maxHops: typeof a.maxHops === "number" ? a.maxHops : undefined,
        });
        if (!result) return err(`Target node ${targetId} not reachable from current allocation`);
        return ok({
          targetId,
          alreadyAllocated: result.alreadyAllocated,
          cost: result.cost,
          path: result.path,
          payload: result.path.length
            ? { addNodes: result.path.map((n) => n.id) }
            : null,
        });
      }
      case "suggest_node_swaps": {
        const b = await ensurePool();
        const fp = requireForkPath();
        const a = (args as Record<string, unknown> | undefined) ?? {};
        const result = await suggestNodeSwaps(b, fp, {
          targetMetric: typeof a.targetMetric === "string" ? a.targetMetric : undefined,
          maxDepth: typeof a.maxDepth === "number" ? a.maxDepth : undefined,
          maxCandidates: typeof a.maxCandidates === "number" ? a.maxCandidates : undefined,
          maxDead: typeof a.maxDead === "number" ? a.maxDead : undefined,
          limit: typeof a.limit === "number" ? a.limit : undefined,
          deadThreshold: typeof a.deadThreshold === "number" ? a.deadThreshold : undefined,
          treeVersion: typeof a.treeVersion === "string" ? a.treeVersion : undefined,
        });
        return ok(result);
      }

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    // Check by error name (not instanceof) so reloaded classes still match.
    if (e instanceof Error && e.name === "BuildCodecError") {
      return err(`Build codec error: ${e.message}`);
    }
    if (e instanceof LuaBridgeError) {
      return err(`Lua bridge: ${e.message}`);
    }
    if (e instanceof FetchBuildError) {
      return err(`Fetch error: ${e.message}`);
    }
    return err(e instanceof Error ? e.message : String(e));
  }
});

// ----- Hot reload (opt-in) ---------------------------------------------------

if (process.env.POB2_HOT_RELOAD === "1") {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // tsx serves .ts files directly — watch the source dir, not the build dir.
  // Try src/ first; if we're running compiled JS from build/, watch this dir.
  const srcDir = path.resolve(here, "..", "src");
  const watchDir = fileURLToPath(import.meta.url).includes(`${path.sep}src${path.sep}`)
    ? srcDir
    : here;

  let pending = false;
  let scheduled: NodeJS.Timeout | null = null;

  const reload = async (reason: string) => {
    if (pending) return;
    pending = true;
    try {
      await loadModules();
      // Tell the client the tool list may have changed. Even though our 4 tools
      // are static today, this is the right signal for code changes — and once
      // we add dynamic tool registration, the same path supports it.
      await server.notification({ method: "notifications/tools/list_changed" });
      console.error(`[hot-reload] reloaded (${reason})`);
    } catch (e) {
      console.error("[hot-reload] failed:", e);
    } finally {
      pending = false;
    }
  };

  const watcher = chokidarWatch(watchDir, {
    ignoreInitial: true,
    // Watch source files; skip our own entry point (can't reload ourselves).
    ignored: (p: string) =>
      /node_modules/.test(p) ||
      /\.git/.test(p) ||
      /\bindex\.(ts|js)$/.test(p),
  });

  watcher.on("change", (filepath: string) => {
    // Debounce: editors often write multiple times in quick succession.
    if (scheduled) clearTimeout(scheduled);
    scheduled = setTimeout(() => {
      scheduled = null;
      void reload(path.basename(filepath));
    }, 150);
  });

  console.error(`[hot-reload] watching ${watchDir}`);
}

// ----- Lua-side hot reload (recycle bridge on .lua changes) -----------------

if (process.env.POB2_HOT_RELOAD === "1" && process.env.POB_FORK_PATH) {
  const apiDir = path.join(process.env.POB_FORK_PATH, "API");
  const wrapperPath = path.join(process.env.POB_FORK_PATH, "HeadlessWrapper.lua");
  const luaWatcher = chokidarWatch([apiDir, wrapperPath], {
    ignoreInitial: true,
    ignored: (p: string) => /node_modules/.test(p) || /\.git/.test(p),
  });

  let scheduled: NodeJS.Timeout | null = null;
  luaWatcher.on("change", (filepath: string) => {
    if (!filepath.endsWith(".lua")) return;
    if (scheduled) clearTimeout(scheduled);
    scheduled = setTimeout(() => {
      scheduled = null;
      void recycleBridge(`lua change: ${path.basename(filepath)}`);
    }, 200);
  });

  console.error(`[lua-bridge] auto-recycle on .lua change in ${apiDir}`);
}

// ----- Helpers ---------------------------------------------------------------

function str(args: unknown, key: string): string {
  const v = (args as Record<string, unknown> | undefined)?.[key];
  if (typeof v !== "string") {
    throw new Error(`Missing or non-string argument: ${key}`);
  }
  return v;
}

function ok(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function err(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function summarize(build: import("./build.js").PoB2Build): string {
  const m = build.meta;
  const mainGroup =
    m.mainSocketGroup != null ? build.skills[m.mainSocketGroup - 1] : null;
  const mainSkill =
    mainGroup?.gems.find((g) => !g.support)?.name ?? "(no main skill set)";
  const supports = mainGroup?.gems.filter((g) => g.support).map((g) => g.name) ?? [];
  const treeNodes = build.trees[0]?.nodes.length ?? 0;
  const itemCount = build.items.length;

  return [
    `${m.className} / ${m.ascendClassName}, level ${m.level}`,
    `Main skill: ${mainSkill}${supports.length ? ` + ${supports.join(", ")}` : ""}`,
    `Passive nodes allocated: ${treeNodes}`,
    `Equipped items: ${itemCount}`,
    m.version ? `PoB2 version: ${m.version}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// ----- Lua bridge (lazy singleton; Phase 2 only) -----------------------------

let bridge: LuaBridge | null = null;
let pool: LuaBridgePool | null = null;
let bridgeInit: Promise<LuaBridge> | null = null;
let poolInit: Promise<void> | null = null;

/**
 * Kill the current Lua bridge (if any) so the next ensureBridge() call spawns
 * a fresh one. Used by the Lua-side hot reload watcher when BuildOps.lua or
 * HeadlessWrapper.lua changes.
 */
async function recycleBridge(reason: string): Promise<void> {
  if (!bridge && !bridgeInit) return;
  console.error(`[lua-bridge] recycling (${reason})`);
  const prev = bridge;
  const prevPool = pool;
  bridge = null;
  pool = null;
  bridgeInit = null;
  poolInit = null;
  if (prevPool) {
    try { await prevPool.stop(); } catch { /* ignore */ }
  }
  if (prev) {
    try { await prev.stop(); } catch { /* ignore */ }
  }
}

async function ensureBridge(): Promise<LuaBridge> {
  if (bridge?.isAlive()) return bridge;
  if (bridgeInit) return bridgeInit;

  const forkPath = process.env.POB_FORK_PATH;
  if (!forkPath) {
    throw new LuaBridgeError(
      "POB_FORK_PATH not set. Phase 2 tools require the env var to point at " +
        "pob2-fork/src/ (the directory containing the patched HeadlessWrapper.lua)."
    );
  }

  bridgeInit = (async () => {
    const b = new LuaBridge({
      forkPath,
      wslDistro: process.env.POB_WSL_DISTRO,
      timeoutMs: process.env.POB_TIMEOUT_MS ? parseInt(process.env.POB_TIMEOUT_MS, 10) : undefined,
    });
    console.error(`[lua-bridge] starting (forkPath=${forkPath})`);
    const t0 = Date.now();
    await b.start();
    console.error(`[lua-bridge] ready after ${Date.now() - t0}ms`);
    bridge = b;
    return b;
  })().finally(() => {
    bridgeInit = null;
  });

  return bridgeInit;
}

/**
 * Get the parallel pool if POB2_POOL_SIZE > 0; otherwise return the primary
 * bridge. The pool's replicas are spawned lazily on first use. Replicas are
 * re-synced to the primary's build state.
 */
async function ensurePool(): Promise<LuaBridge | LuaBridgePool> {
  const size = parseInt(process.env.POB2_POOL_SIZE ?? "0", 10);
  if (!Number.isFinite(size) || size <= 0) return ensureBridge();

  const primary = await ensureBridge();
  if (pool && pool.size === 1 + size) return pool;
  if (poolInit) { await poolInit; return pool ?? primary; }

  poolInit = (async () => {
    const forkPath = process.env.POB_FORK_PATH!;
    const p = new LuaBridgePool(primary, {
      forkPath,
      wslDistro: process.env.POB_WSL_DISTRO,
      timeoutMs: process.env.POB_TIMEOUT_MS ? parseInt(process.env.POB_TIMEOUT_MS, 10) : undefined,
      size,
    });
    console.error(`[lua-pool] spawning ${size} replicas...`);
    const t0 = Date.now();
    await p.startReplicas();
    console.error(`[lua-pool] ${size} replicas ready after ${Date.now() - t0}ms (size=${p.size} total)`);
    pool = p;
  })().finally(() => {
    poolInit = null;
  });
  await poolInit;
  return pool ?? primary;
}

/** Throws if POB_FORK_PATH isn't set — required for static tree-data tools too. */
function requireForkPath(): string {
  const fp = process.env.POB_FORK_PATH;
  if (!fp) {
    throw new Error(
      "POB_FORK_PATH not set. This tool reads PoB2 tree data from " +
        "$POB_FORK_PATH/TreeData/<version>/tree.json."
    );
  }
  return fp;
}

/** Map a raw Lua response into an MCP tool result, surfacing errors as isError. */
function luaResponseTo(r: LuaResponse) {
  if (r.ok === false) return err(typeof r.error === "string" ? r.error : "Lua bridge error");
  // strip the ok field for cleaner output to the LLM
  const { ok: _ok, ...rest } = r;
  void _ok;
  return ok(rest);
}

/**
 * Load two builds sequentially through the live calc engine and produce a
 * structured diff. We load A, snapshot its stats, load B, snapshot its stats,
 * then compute per-stat deltas. Numeric stats get absolute + percent deltas;
 * non-numeric stats just get the before/after values.
 */
async function compareBuilds(args: unknown) {
  const a = (args as Record<string, unknown> | undefined) ?? {};
  const codeA = a.buildCodeA;
  const codeB = a.buildCodeB;
  if (typeof codeA !== "string" || typeof codeB !== "string") {
    throw new Error("compare_builds requires string buildCodeA and buildCodeB");
  }
  const labelA = typeof a.labelA === "string" ? a.labelA : "A";
  const labelB = typeof a.labelB === "string" ? a.labelB : "B";

  const b = await ensureBridge();
  const xmlA = codec.decodeBuildCode(codeA);
  const xmlB = codec.decodeBuildCode(codeB);

  const loadA = await b.send({ action: "load_build_xml", params: { xml: xmlA, name: labelA } });
  if (loadA.ok === false) throw new Error(`Failed to load ${labelA}: ${loadA.error}`);
  const statsA = (await b.send({ action: "get_stats" })).stats as Record<string, unknown>;

  const loadB = await b.send({ action: "load_build_xml", params: { xml: xmlB, name: labelB } });
  if (loadB.ok === false) throw new Error(`Failed to load ${labelB}: ${loadB.error}`);
  const statsB = (await b.send({ action: "get_stats" })).stats as Record<string, unknown>;

  // Compute the diff
  const keys = new Set([...Object.keys(statsA ?? {}), ...Object.keys(statsB ?? {})]);
  keys.delete("_meta");
  const diff: Record<string, unknown> = {};
  let improved = 0;
  let regressed = 0;
  let unchanged = 0;
  for (const k of [...keys].sort()) {
    const va = statsA?.[k];
    const vb = statsB?.[k];
    if (typeof va === "number" && typeof vb === "number") {
      const delta = vb - va;
      const pct = va !== 0 ? (delta / Math.abs(va)) * 100 : null;
      diff[k] = {
        [labelA]: round(va),
        [labelB]: round(vb),
        delta: round(delta),
        pct: pct != null ? round(pct, 1) : null,
      };
      if (delta > 0.0001) improved++;
      else if (delta < -0.0001) regressed++;
      else unchanged++;
    } else if (va !== vb) {
      diff[k] = { [labelA]: va, [labelB]: vb };
    }
  }

  return {
    summary: {
      [labelA]: statsA?._meta ?? null,
      [labelB]: statsB?._meta ?? null,
      improved,
      regressed,
      unchanged,
    },
    diff,
  };
}

function round(n: number, places = 4): number {
  const m = Math.pow(10, places);
  return Math.round(n * m) / m;
}

// ----- Entry point -----------------------------------------------------------

// Clean shutdown of the Lua bridge on signals
const shutdown = async () => {
  if (bridge) {
    console.error("[lua-bridge] stopping...");
    try {
      await bridge.stop();
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[${SERVER_NAME} v${SERVER_VERSION}] ready on stdio` +
    (process.env.POB2_HOT_RELOAD === "1" ? " (hot-reload on)" : "") +
    (process.env.POB_FORK_PATH ? ` (lua bridge available)` : ` (Phase 1 only — POB_FORK_PATH not set)`)
);
