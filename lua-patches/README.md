# Lua-side patches for PathOfBuilding-PoE2

These are the modifications you apply to your local clone of
[PathOfBuilding-PoE2](https://github.com/PathOfBuildingCommunity/PathOfBuilding-PoE2)
so the pob2-mcp Node server can talk to it over stdio JSON-RPC.

## What's here

| File | Drop-in target | What it does |
|---|---|---|
| `HeadlessWrapper.lua` | `pob2-fork/src/HeadlessWrapper.lua` | Replaces PoB2's HeadlessWrapper. Adds an api-stdio launch block (gated by `POB_API_STDIO=1` or `--stdio` flag) that sets up `package.path`, initialises the build module, and starts `API/Server.lua`. The non-api-stdio path is preserved untouched. |
| `API/Server.lua` | `pob2-fork/src/API/Server.lua` | Newline-delimited JSON-RPC server over stdin/stdout. Dispatches `{action, params}` requests to `API/Handlers.lua` and writes JSON responses. |
| `API/Handlers.lua` | `pob2-fork/src/API/Handlers.lua` | Thin dispatch layer that maps action names to `BuildOps` calls and wraps responses in `{ok, ...}`. |
| `API/BuildOps.lua` | `pob2-fork/src/API/BuildOps.lua` | The actual operations: load build XML, get/set tree, get stats, calc-what-if, gem level/quality mutations, item add/parse, etc. Most of the PoE2-specific logic lives here. |

## Install

```bash
# Clone PoB2 (full repo, ~575 MB)
git clone https://github.com/PathOfBuildingCommunity/PathOfBuilding-PoE2.git ./pob2-fork

# Copy our patches in
cp HeadlessWrapper.lua pob2-fork/src/HeadlessWrapper.lua
mkdir -p pob2-fork/src/API
cp API/*.lua pob2-fork/src/API/
```

Then set `POB_FORK_PATH=/absolute/path/to/pob2-fork/src` in the MCP server config
(see the top-level [README](../README.md) for details).

## Provenance + license

The three `API/*.lua` files are adapted from
[ianderse/PathOfBuilding @ api-stdio](https://github.com/ianderse/PathOfBuilding/tree/api-stdio)
(GPL-3.0) with PoE2-specific fixes documented in their headers.

`HeadlessWrapper.lua` is PoB2's own file with our api-stdio launch block added
inside a clearly-marked `===== api-stdio additions =====` region.

Both PoB2 and the api-stdio fork are GPL-3.0 — so the contents of this
`lua-patches/` directory are also GPL-3.0. The Node-side MCP server in the
parent directory is MIT (no PoB code copied).
