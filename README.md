# pob2-mcp

An MCP (Model Context Protocol) server that gives Claude — or any MCP-aware
LLM client — first-class access to **Path of Building 2**'s real calc engine,
passive-tree data, gem database, and item parser. PoE2 builds become things
the LLM can actually reason about: load a build code, get real DPS/EHP numbers
from PoB2 (not vibes), find dead nodes, simulate level-ups, compare two
builds stat-by-stat, theorycraft node swaps and support gem links without
persisting changes, render an HTML build guide with an inline passive tree
SVG, and even **synthesize a complete starter build from scratch** given a
class + skill.

> **Status:** working, 1.0-eligible. Verified against PoB2 0.15+ / PoE2 0.4
> tree. Infrastructure pre-validated for the 0.5 upgrade (sync the upstream
> fork after launch and our tools should Just Work).

## What this gives you

**39 MCP tools** across the full stack — from standalone codec functions
that need nothing installed, all the way to a one-shot orchestrator that
generates a fully-equipped, passively-allocated build with placeholder
items, supports, and calc-refined tree.

```
┌─ Standalone (no PoB install) ─────────────────────────────────────┐
│  decode_build_code   encode_build_code   parse_build              │
│  summarize_build                                                   │
└────────────────────────────────────────────────────────────────────┘

┌─ Static data lookups ─────────────────────────────────────────────┐
│  search_tree_nodes   get_tree_node       resolve_tree_nodes       │
│  search_gems         get_gem             gem_database_stats       │
│  list_classes        find_path_to_node                            │
└────────────────────────────────────────────────────────────────────┘

┌─ External ────────────────────────────────────────────────────────┐
│  fetch_build_from_url (pobb.in URLs)                              │
└────────────────────────────────────────────────────────────────────┘

┌─ Live calc engine — read ────────────────────────────────────────┐
│  lua_ping            lua_load_build      lua_get_stats            │
│  lua_get_build_info  lua_get_tree        lua_get_skills           │
│  lua_get_items       lua_get_config      lua_calc_with            │
└────────────────────────────────────────────────────────────────────┘

┌─ Live calc engine — mutate ──────────────────────────────────────┐
│  lua_set_level       lua_set_config      lua_update_tree_delta    │
│  lua_add_item_text   lua_parse_item_text                          │
│  lua_set_gem_level   lua_set_gem_quality lua_export_build_code    │
└────────────────────────────────────────────────────────────────────┘

┌─ Theorycraft + suggestion engine ─────────────────────────────────┐
│  compare_builds      find_dead_nodes     simulate_level_up        │
│  analyze_item_upgrade                    bottleneck_analysis      │
│  suggest_node_swaps  suggest_gem_link                             │
└────────────────────────────────────────────────────────────────────┘

┌─ Generation ──────────────────────────────────────────────────────┐
│  generate_build_guide  (HTML with inline tree SVG + icons)        │
│  synthesize_build      (class+skill → complete build code)        │
└────────────────────────────────────────────────────────────────────┘
```

## Recent additions worth knowing about

- **`synthesize_build`** — give it `className`, optional `ascendancyName`,
  `level`, `mainSkillName`, and a goal (`dps`/`life`/`hybrid`/`defence`).
  It fresh-builds, sets class + ascendancy, allocates ~level-2 passive
  points via a stat-text heuristic, equips Rare gear in 9+ slots so calc
  is meaningful, adds the main skill plus 3 compatible supports, runs a
  calc-based tree refinement pass, and returns a PoB-importable build
  code. ~5-9 seconds. Verified end-to-end across Monk/Witch/Warrior/
  Ranger combos producing real DPS (460 → 4151 depending on skill).
- **`generate_build_guide`** — writes a self-contained HTML guide with
  base64-embedded gem/passive icons (97% coverage via a `poe2db.tw`
  scrape) and an **inline SVG of the passive tree** with the build's
  allocated nodes highlighted (~310KB SVG for the 0_4 tree).
- **`suggest_gem_link`** — uses PoB's own `calcLib.canGrantedEffectSupport`
  for canonical compatibility filtering, then probes via `add_gem` →
  `get_stats` → `remove_gem`. Returns ranked supports with real DPS
  deltas (Zerphi's Infamy +52%, Lightning Attunement +23%, etc.).
- **`suggest_node_swaps`** — finds dead allocated nodes paired with
  reachable unallocated neighbors via BFS; runs hypothetical calc_with
  for each swap; returns ranked proposals.
- **`bottleneck_analysis`** — pure stat analysis flagging low hit chance,
  uncapped resistances, unused Spirit, lopsided EHP, etc. ~50ms.
- **`find_path_to_node`** — BFS pathing from the current allocation to a
  target node, with point cost.
- **Parallel calc pool** (`POB2_POOL_SIZE`) — spawns N extra LuaBridges
  that round-robin over `calc_with` probes. ~10× speedup on
  `suggest_node_swaps` at the cost of N×~200MB RAM.

## Why this exists

[ianderse/pob-mcp](https://github.com/ianderse/pob-mcp) did something similar
for **PoE1**, but PoE2 has different XML schemas, a different calc API, a
different passive tree, and new mechanics (Spirit, charges, dual weapon sets,
Lineage gems). The PoE2 community needed its own bridge. This is that bridge.

## Architecture

```
                stdio JSON-RPC                stdio JSON-lines
Claude  <─────>  pob2-mcp (Node)  <─────>  LuaJIT + PoB2 headless
        MCP                          our                    patched
                                    bridge                HeadlessWrapper
                                                            + API/*
```

Two halves:

1. **Node side** (this repo's `src/`) — TypeScript MCP server. Owns:
   - Build-code codec (base64 + zlib via pako)
   - XML parser → typed structure (`fast-xml-parser`)
   - Passive tree-data loader (static read of `TreeData/<version>/tree.json`)
   - Inline SVG passive-tree renderer (`treeSvg.ts`)
   - Gem database parser (hand-rolled Lua-table reader for `Data/Gems.lua`)
   - Item-base loader (parses `Data/Bases/*.lua` for 1046 PoE2 bases)
   - Gem-icon static map (scraped from `poe2db.tw`)
   - URL fetcher (pobb.in)
   - Icon resolver (poe2db.tw + base64-embed, with WAF-bypassing headers)
   - LuaJIT subprocess manager + JSON-RPC client + optional parallel pool
   - Theorycraft orchestration (dead nodes, level sim, node/gem swaps,
     bottleneck analysis, build synthesis, gear generation)
   - HTML build-guide composer (`htmlGuide.ts`)

2. **Lua side** ([`lua-patches/`](lua-patches/)) — patches applied to a clone
   of [PathOfBuilding-PoE2](https://github.com/PathOfBuildingCommunity/PathOfBuilding-PoE2):
   - Modified `HeadlessWrapper.lua` with an api-stdio launch block (gated by env var)
   - New `API/Server.lua`, `API/Handlers.lua`, `API/BuildOps.lua`

The Lua side runs PoB2's actual calc engine in headless mode and exposes
~30 actions over stdio. The Node side wraps those into MCP tools plus a
bunch of static-data tools that don't need PoB running.

## Install

### Prerequisites

- **Node.js ≥ 20** (uses ESM + modern features)
- **LuaJIT 2.1** — for running PoB2 headless
  - On Windows we go through WSL2 (Ubuntu). `wsl --user root -- apt-get install -y luajit luarocks libluajit-5.1-dev build-essential && wsl --user root -- luarocks --lua-version 5.1 install luautf8`
  - On Linux/macOS: install via your package manager + `luarocks install luautf8`
- **A clone of PathOfBuilding-PoE2** somewhere on disk

### Step 1: install Node deps

```bash
git clone https://github.com/hetri-courses/pob2-mcp.git
cd pob2-mcp
npm install
npm run build
```

### Step 2: prepare a PoB2 fork

```bash
git clone https://github.com/PathOfBuildingCommunity/PathOfBuilding-PoE2.git ./pob2-fork
cp -r lua-patches/* pob2-fork/src/   # this copies HeadlessWrapper.lua + API/
```

The full fork is ~575 MB so it lives outside this repo (`.gitignore`d).

### Step 3 (optional, recommended): refresh the gem-icon scrape

```bash
node tools/scrape-gem-icons.mjs
```

One-shot; bumps gem-icon coverage in `generate_build_guide` from ~11% to
~99% by mapping 1000 PoE2 gems to their actual `poe2db.tw` CDN paths.
Cached in `data/gem-icons.json`; only refetches if > 24h old.

### Step 4: wire into your MCP client

For **Claude Desktop**, edit `%APPDATA%\Claude\claude_desktop_config.json`
(Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS):

```json
{
  "mcpServers": {
    "pob2": {
      "command": "node",
      "args": [
        "/absolute/path/to/pob2-mcp/node_modules/tsx/dist/cli.mjs",
        "/absolute/path/to/pob2-mcp/src/index.ts"
      ],
      "env": {
        "POB_FORK_PATH": "/absolute/path/to/pob2-fork/src",
        "POB2_HOT_RELOAD": "1"
      }
    }
  }
}
```

Fully quit and reopen Claude Desktop. All 39 tools should appear in a fresh chat.

## Configuration env vars

| Var | Default | Purpose |
|---|---|---|
| `POB_FORK_PATH` | (required for live tools) | Absolute path to `pob2-fork/src/` |
| `POB2_HOT_RELOAD` | `0` | Set `1` to watch `src/**/*.ts` and `pob2-fork/src/API/*.lua` and reload modules + recycle the Lua bridge on change |
| `POB2_POOL_SIZE` | `0` | Spawn N extra LuaBridges that round-robin over `calc_with`. ~10× speedup on `suggest_node_swaps` for N=2-3, at the cost of N×~200MB RAM. |
| `POB_TREE_VERSION` | `0_4` | Default passive-tree version for all static tree tools (`search_tree_nodes`, `get_tree_node`, `find_path_to_node`, `resolve_tree_nodes`, `list_classes`, tree SVG). Set to `0_5` for league-start theorycraft once a `TreeData/0_5/tree.json` exists. |
| `POB_WSL_DISTRO` | active distro | Override WSL distro (Windows only) |
| `POB_TIMEOUT_MS` | `30000` | Per-request timeout for Lua bridge calls |
| `POB_API_DEBUG` | `0` | Surface Lua-side diagnostics to stderr |

## Getting ahead of a new patch (tree-level)

When a new PoE2 patch drops, GGG publishes the authoritative passive-tree
export at [grindinggear/poe2-skilltree-export](https://github.com/grindinggear/poe2-skilltree-export)
(branch = version, e.g. `0.5.0`) the moment it's live — often hours before
PoB ships its own `TreeData/<version>/tree.json`. Our **static** tree tools
(search, pathing, node stats, class enumeration, SVG) read `tree.json`
directly and don't need the calc engine, so you can do full tree-level
theorycraft on a new tree immediately:

```bash
# 1. Grab GGG's export for the new version
git clone --depth 1 --branch 0.5.0 \
  https://github.com/grindinggear/poe2-skilltree-export.git /tmp/0.5tree

# 2. Convert it to PoB's tree.json schema (reuses orbit constants from 0_4)
node tools/ggg-to-pob-tree.mjs /tmp/0.5tree/data.json \
  pob2-fork/src/TreeData/0_5/tree.json \
  pob2-fork/src/TreeData/0_4/tree.json

# 3. Point the static tools at it
#    (set POB_TREE_VERSION=0_5 in your MCP client env)
```

You'll then have `list_classes` returning the new ascendancies (Martial
Artist, Spirit Walker, …), `search_tree_nodes` finding new notables with
their real stat text, `find_path_to_node` routing through the new tree, and
the HTML guide's tree SVG rendering the new layout.

> **What this does NOT do:** the calc engine still runs the *previous*
> patch's formulas + gem data until PoB updates its Lua side. DPS/EHP numbers
> on a brand-new patch's mechanics (e.g. Runic Ward, new gems) will be wrong
> or missing. This is tree *structure* only — pathing, node stats,
> ascendancy layout, visualization. For accurate calc, `git pull` your
> pob2-fork once PoB ships the patch and drop GGG's data for theirs.

## Example workflows

### Reason about an existing build

> Use pob2 to fetch this build: pobb.in/ExX35hYNT6Gi
>
> Then find any dead nodes, suggest 5 better tree swaps, and show me what
> would happen if I bumped the character to level 90.

Under the hood:

1. `fetch_build_from_url("pobb.in/ExX35hYNT6Gi")` → 5928-char build code
2. `lua_load_build({buildCode})` → LuaJIT spins up (one-time ~8s), PoB2 loads
3. `find_dead_nodes()` → ~250ms; loops `lua_calc_with` over allocated nodes, ranks by DPS/EHP impact
4. `suggest_node_swaps()` → ~1-3s; pairs each dead node with reachable neighbors, probes each, returns ranked swaps
5. `simulate_level_up({levels: [90]})` → samples stats at L90, restores

### Synthesize a build from nothing

> Build me a Monk/Invoker starter at level 90 using Tempest Bell.

Under the hood: `synthesize_build({ className: "Monk", ascendancyName:
"Invoker", level: 90, mainSkillName: "Tempest Bell" })` → 5-9 seconds
later you get a PoB-importable build code with ~40 allocated nodes,
a calc-refined tree, 9 Rare items equipped, Tempest Bell + 3 best
supports per the calc engine, ~500-800 baseline DPS.

### Generate an HTML build guide

> Now render an HTML guide for that build to D:\builds\monk-tempest.html.

`generate_build_guide` produces a self-contained ~450KB HTML file with
a tooltip-equipped passive-tree SVG, base64-embedded gem and slot icons,
a glossary auto-linker for jargon, and per-section breakdowns.

## What works, what doesn't

**Works well**
- Build code decode/encode/parse (any pobb.in build round-trips)
- Real DPS/EHP/Life/charges/Spirit from PoB2's calc engine (55+ stats by default; expandable)
- Theorycraft what-ifs: `calc_with`, `compare_builds`, `find_dead_nodes`,
  `simulate_level_up`, `analyze_item_upgrade`, `suggest_node_swaps`,
  `suggest_gem_link`, `bottleneck_analysis`
- Tree-node + gem name resolution (the LLM can speak in names instead of IDs)
- pobb.in URL ingestion
- HTML guide generation with inline passive-tree SVG + ~97% gem-icon coverage
- Build synthesis from class + skill (Monk/Witch/Warrior/Ranger verified end-to-end)

**Known limitations**
- **Long URL-safe base64 codes get mangled in chat-paste** — use `fetch_build_from_url` instead of pasting raw codes
- `lua_update_tree_delta` validates path-connectivity (PoB enforces this) — adding a disconnected node silently does nothing
- `lua_add_item_text` requires real PoE2 base names (Data/Bases/*.lua) — fabricated bases get rejected. `synthesize_build` handles this; manual `lua_add_item_text` callers must use real names
- `synthesize_build`'s calc-refinement may apply 0 swaps when the stat-text heuristic already lands on a locally-optimal tree — this is correct behavior, not a failure
- `synthesize_build` gear is mid-tier RARE with no jewel sockets, no Uniques, no custom passives — a starting point, not endgame
- Only the `0_4` passive tree version is exercised; older versions should work but aren't smoke-tested. **0.5 readiness:** upstream `PathOfBuilding-PoE2` has merged several `[0.5]` commits already; once `TreeData/0_5/` ships post-launch, a `git pull` in your fork should be enough.

## Project layout

```
pob2-mcp/
├── src/
│   ├── index.ts            # MCP server entry; tool registry + dispatch
│   ├── codec.ts            # base64+zlib build-code codec
│   ├── build.ts            # XML → typed structure
│   ├── luaBridge.ts        # persistent LuaJIT subprocess (stdio JSON-RPC)
│   ├── luaBridgePool.ts    # parallel-bridge pool for calc_with batches
│   ├── treeData.ts         # passive tree lookup/search (static)
│   ├── treeSvg.ts          # inline SVG renderer for the passive tree
│   ├── gemData.ts          # Gems.lua parser + search (static)
│   ├── bases.ts            # Data/Bases/*.lua parser → ItemBase[]
│   ├── classes.ts          # tree.classes → ClassInfo[] for class/ascendancy lookup
│   ├── icons.ts            # passive + gem + slot icon resolver (poe2db.tw + bundled)
│   ├── glossary.ts         # PoE2 jargon → tooltip text
│   ├── htmlGuide.ts        # HTML build-guide composer (uses everything above)
│   ├── fetchBuild.ts       # pobb.in URL resolver
│   ├── gearGen.ts          # placeholder-Rare item generator (synthesize_build's gear)
│   ├── buildGen.ts         # synthesize_build orchestrator
│   └── theorycraft.ts      # synthesized analysis tools
├── data/
│   └── gem-icons.json      # scraped gem-name → icon-path map (~1000 entries)
├── tools/
│   └── scrape-gem-icons.mjs  # one-shot poe2db.tw → gem-icons.json
├── lua-patches/            # what you copy into your pob2-fork
│   ├── HeadlessWrapper.lua
│   └── API/
│       ├── Server.lua      # stdio JSON-RPC server
│       ├── Handlers.lua    # action dispatch
│       └── BuildOps.lua    # the real PoB2-touching code
├── tests/
│   ├── *.smoke.mjs         # end-to-end smoke tests run via `node`
│   └── fixtures/           # real pobb.in build codes
└── docs/
    └── PORT_PLAN.md        # original PoE1→PoE2 porting analysis
```

## License

- Node-side code (this repo's `src/`): **MIT**
- Lua-side patches (`lua-patches/`): **GPL-3.0** (inherited from PoB2)

## Acknowledgments

- [PathOfBuildingCommunity/PathOfBuilding-PoE2](https://github.com/PathOfBuildingCommunity/PathOfBuilding-PoE2) — the calc engine all of this stands on
- [ianderse/pob-mcp](https://github.com/ianderse/pob-mcp) + [ianderse/PathOfBuilding @ api-stdio](https://github.com/ianderse/PathOfBuilding/tree/api-stdio) — the PoE1 reference implementation we ported the stdio-bridge pattern from
- [poe2db.tw](https://poe2db.tw) — gem + passive icon CDN
- GGG for shipping a buildable + parseable PoE2 tree+gem dataset
