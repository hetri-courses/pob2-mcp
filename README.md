# pob2-mcp

An MCP (Model Context Protocol) server that gives Claude — or any MCP-aware
LLM client — first-class access to **Path of Building 2**'s real calc engine,
passive-tree data, gem database, and item parser. PoE2 builds become things
the LLM can actually reason about: load a build code, get real DPS/EHP numbers
from PoB2 (not vibes), find dead nodes, simulate level-ups, compare two
builds stat-by-stat, and theorycraft node swaps without persisting changes.

> **Status:** working but pre-1.0. Tested against PoB2 0.15.0 / PoE2 0.4 tree.

## What this gives you

**26 MCP tools** across four layers:

```
┌─ Phase 1: standalone (no PoB install) ────────────────────────────┐
│  decode_build_code  encode_build_code  parse_build  summarize_build│
└────────────────────────────────────────────────────────────────────┘

┌─ Phase 2 + 3: live calc engine via LuaJIT subprocess ─────────────┐
│  lua_ping           lua_load_build         lua_get_stats          │
│  lua_get_build_info lua_get_tree           lua_get_skills         │
│  lua_get_items      lua_get_config         lua_calc_with          │
│  compare_builds                                                    │
└────────────────────────────────────────────────────────────────────┘

┌─ Phase 4 + 5: data access + mutation + theorycraft ───────────────┐
│  search_tree_nodes  get_tree_node          resolve_tree_nodes     │
│  search_gems        get_gem                gem_database_stats     │
│  fetch_build_from_url                                              │
│  lua_set_level      lua_set_config         lua_update_tree_delta  │
│  lua_add_item_text  lua_parse_item_text                           │
│  lua_set_gem_level  lua_set_gem_quality    lua_export_build_code  │
│  find_dead_nodes    simulate_level_up      analyze_item_upgrade   │
└────────────────────────────────────────────────────────────────────┘
```

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
   - Gem database parser (hand-rolled Lua-table reader for `Data/Gems.lua`)
   - URL fetcher (pobb.in)
   - LuaJIT subprocess manager + JSON-RPC client
   - Theorycraft orchestration (`find_dead_nodes`, `simulate_level_up`, `analyze_item_upgrade`)

2. **Lua side** ([`lua-patches/`](lua-patches/)) — patches you apply to a clone of
   [PathOfBuilding-PoE2](https://github.com/PathOfBuildingCommunity/PathOfBuilding-PoE2):
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

### Step 3: wire into your MCP client

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

Fully quit and reopen Claude Desktop. All 26 tools should appear in a fresh chat.

## Configuration env vars

| Var | Default | Purpose |
|---|---|---|
| `POB_FORK_PATH` | (required for Phase 2+) | Absolute path to `pob2-fork/src/` |
| `POB2_HOT_RELOAD` | `0` | Set `1` to watch `src/**/*.ts` and `pob2-fork/src/API/*.lua` and reload modules + recycle the Lua bridge on change |
| `POB_WSL_DISTRO` | active distro | Override WSL distro (Windows only) |
| `POB_TIMEOUT_MS` | `30000` | Per-request timeout for Lua bridge calls |
| `POB_API_DEBUG` | `0` | Surface Lua-side diagnostics to stderr |

## Example workflow

In a fresh Claude session:

> Use pob2 to fetch this build: pobb.in/ExX35hYNT6Gi
>
> Then find any dead nodes and show me what would happen if I bumped the
> character to level 90.

What happens under the hood:

1. `fetch_build_from_url("pobb.in/ExX35hYNT6Gi")` → returns the 5928-char build code
2. `lua_load_build({buildCode})` → LuaJIT spins up (one-time ~8s), PoB2 loads the build
3. `find_dead_nodes()` → ~250ms; loops `lua_calc_with` over the 17 allocated nodes, ranks by DPS/EHP impact, resolves each to a tree-data name
4. `simulate_level_up({levels: [90]})` → samples stats at level 90, restores original level

Claude composes the results into a natural-language answer.

## What works, what doesn't

**Works well**
- Build code decode/encode/parse (any pobb.in build round-trips)
- Real DPS/EHP/Life/EHP/charges/Spirit from PoB2's calc engine (55 stats by default; expandable)
- Theorycraft what-ifs: `calc_with`, `compare_builds`, `find_dead_nodes`, `simulate_level_up`, `analyze_item_upgrade`
- Tree-node + gem name resolution (the LLM can speak in names instead of IDs)
- pobb.in URL ingestion

**Known limitations**
- **Long URL-safe base64 codes get mangled in chat-paste** — use `fetch_build_from_url` instead of pasting raw codes
- `lua_update_tree_delta` validates path-connectivity (PoB enforces this) — adding a disconnected node silently does nothing
- `lua_add_item_text` requires proper PoE2 in-game format (with `--------` separators); malformed input falls back to a magic-rare placeholder
- Only the `0_4` passive tree version is exercised; older versions should work but aren't smoke-tested

## Project layout

```
pob2-mcp/
├── src/
│   ├── index.ts          # MCP server entry; tool registry + dispatch
│   ├── codec.ts          # base64+zlib build-code codec
│   ├── build.ts          # XML → typed structure
│   ├── luaBridge.ts      # persistent LuaJIT subprocess (stdio JSON-RPC)
│   ├── treeData.ts       # passive tree lookup/search (static)
│   ├── gemData.ts        # Gems.lua parser + search (static)
│   ├── fetchBuild.ts     # pobb.in URL resolver
│   └── theorycraft.ts    # synthesized tools (find_dead_nodes, etc.)
├── lua-patches/          # what you copy into your pob2-fork
│   ├── HeadlessWrapper.lua
│   └── API/
│       ├── Server.lua    # stdio JSON-RPC server
│       ├── Handlers.lua  # action dispatch
│       └── BuildOps.lua  # the real PoB2-touching code
├── tests/
│   ├── *.smoke.mjs       # end-to-end smoke tests run via `node`
│   └── fixtures/         # real pobb.in build codes
└── docs/
    └── PORT_PLAN.md      # original PoE1→PoE2 porting analysis
```

## License

- Node-side code (this repo's `src/`): **MIT**
- Lua-side patches (`lua-patches/`): **GPL-3.0** (inherited from PoB2)

## Acknowledgments

- [PathOfBuildingCommunity/PathOfBuilding-PoE2](https://github.com/PathOfBuildingCommunity/PathOfBuilding-PoE2) — the calc engine all of this stands on
- [ianderse/pob-mcp](https://github.com/ianderse/pob-mcp) + [ianderse/PathOfBuilding @ api-stdio](https://github.com/ianderse/PathOfBuilding/tree/api-stdio) — the PoE1 reference implementation we ported the stdio-bridge pattern from
- GGG for shipping a buildable + parseable PoE2 tree+gem dataset
