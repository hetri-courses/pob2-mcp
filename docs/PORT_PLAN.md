# Port Plan — pob-mcp PoE1 → pob2-mcp PoE2

## Goal

Adapt ianderse/pob-mcp's architecture to target PathOfBuilding-PoE2's calc engine, exposing PoE2 build analysis to Claude via MCP.

## Key insight (validated 2026-05-27)

**Deflate/Inflate stubs in PoB's HeadlessWrapper don't matter.** The Node side does base64+deflate decoding in pako, then sends raw XML to Lua via `loadBuildFromXML(xmlText, name)`. PoB1's api-stdio fork left these as `return ""` TODOs — pob-mcp works fine without them. PoB2 inherits the same stubs and the same workaround applies.

## Compatibility audit: PoB1 → PoB2

| Surface | PoB1 api-stdio | PoB2 (verified) | Compatibility |
|---|---|---|---|
| `build = mainObject.main.modes["BUILD"]` | yes | **yes** (HeadlessWrapper.lua:204) | ✅ identical |
| `newBuild()` helper | yes | **yes** (HeadlessWrapper.lua:207-210) | ✅ identical |
| `loadBuildFromXML(xml, name)` helper | yes | **yes** (HeadlessWrapper.lua:211-214) | ✅ identical |
| `loadBuildFromJSON(...)` (PoE API import) | yes | **yes** (HeadlessWrapper.lua:215-222) | ✅ identical |
| `build.calcsTab.mainOutput` (stats) | yes | likely yes (architecture preserved) | 🟡 verify |
| `build.spec` + `allocNodes` (tree) | yes | likely yes | 🟡 verify |
| `build.spec:ImportFromNodeList(...)` | yes | likely yes — but PoE2 has dual ascendancy params | 🟡 verify signature |
| `Deflate`/`Inflate` stubs | broken (returns "") | broken (returns "") | ✅ irrelevant — Node-side compression |

## File-by-file porting plan

### Phase 2a: Lua side (api-stdio branch on PoB2 fork)

| Source (PoB1 api-stdio) | Target (PoB2 fork) | Effort | Notes |
|---|---|---|---|
| `src/HeadlessWrapper.lua` (modifications) | `src/HeadlessWrapper.lua` | LOW | Apply the same diff: add api-stdio launch block (lines 169-277 of PoB1 version), path setup, utf8 fallback. ~80 lines added. |
| `src/API/Server.lua` | `src/API/Server.lua` | NONE | Verbatim copy. ~90 lines. Pure transport, zero PoB-internal references. |
| `src/API/Handlers.lua` | `src/API/Handlers.lua` | LOW | 95% verbatim. Add a few new actions for PoE2-specific concepts (combo, runic ward, lineage gem ops). ~250 lines. |
| `src/API/BuildOps.lua` | `src/API/BuildOps.lua` | MEDIUM | 80% verbatim, 20% PoE2-specific tweaks. ~733 lines source. |

### BuildOps.lua — PoE2-specific changes needed

| Function | PoE1 behavior | PoE2 change |
|---|---|---|
| `export_stats(fields)` | Default stat list assumes PoE1 stats | Add PoE2 stats: `Ward`, `RunicWard`, `Combo`, `MaxCombo`, charges (3 types), spirit reservation |
| `get_skills()` | Returns standard skill gem schema | Lineage gem schema is different — augment slots, base gem vs lineage support |
| `add_gem()` / `set_gem_*()` | PoE1 gem IDs | PoE2 has different gem ID namespace + lineage support gem mechanics |
| `set_tree()` | Single ascendancy class | PoE2's `secondaryAscendClassId` is actually used (already partially in api-stdio code, line 71-72) |
| `set_flask_active()` | Flask system | PoE2 uses charm system — different API surface |
| `get_config()` | PoE1 boss/buff flags | PoE2 has different boss list + new flags (Runic Ward, etc.) |

Everything else (tree get/set, item add/remove, build XML I/O, ping, version) is **identical**.

### Phase 2b: Node side (our pob2-mcp project)

Lift directly from pob-mcp/src/pobLuaBridge.ts and pob-mcp/src/server/luaClientManager.ts. Adaptations:

1. **Add request queue** instead of `isSending` reject — minor improvement
2. **Make POB_FORK_PATH required** — no hardcoded default
3. **Strip Jest leak** — move test-specific timeout hack to test wrapper
4. **Bound stdout buffer** — add `MAX_BUFFER_BYTES` guard against runaway output
5. **Add `lineage_*` tool family** — PoE2-specific augment slot operations

Tool catalog target: keep the ~30 Lua actions, expose as ~40-50 MCP tools (some Lua actions split into multiple MCP tools for ergonomics).

## Phase 1 status (read-only, no Lua bridge)

✅ **Complete** as of this writing:

- `D:\pob2-mcp\src\codec.ts` — base64+deflate codec (pako-based, handles URL-safe variant)
- `D:\pob2-mcp\src\build.ts` — XML → typed structure (BuildMeta, TreeSpec, SocketGroup, BuildGem, BuildItem)
- `D:\pob2-mcp\src\index.ts` — MCP server with 4 tools: `decode_build_code`, `encode_build_code`, `parse_build`, `summarize_build`
- Compiles cleanly with `npm run build`.

**What Phase 1 doesn't do:**
- No DPS/EHP calc — needs Phase 2 Lua bridge
- No tree node lookup by name (need static tree data from PoB2/Data/)
- No item analysis (just raw text dump for now)
- No round-trip encode validated against real PoE2 build codes — need a sample build to test

## Phase 1 verification gap

We need to **smoke-test against a real PoB2 build code** before claiming Phase 1 done. Options:
1. Grab any build from `pobb.in/poe2` or a Maxroll PoE2 build guide
2. Decode → re-encode → confirm bit-identical
3. Verify parsed structure matches the input

## Phase 2 prerequisites

1. **Install LuaJIT** on Windows (e.g. via scoop: `scoop install luajit`, or build from source)
2. **Fork PathOfBuilding-PoE2** to a personal repo, create `api-stdio` branch
3. **Port the 4 Lua files** per the table above
4. **Wire Node-side bridge** lifting pob-mcp's patterns
5. **Smoke test**: load a build, get stats, verify DPS number matches what PoB2 GUI shows for the same build

## License posture

- pob-mcp is GPL-3.0 — we don't copy its TypeScript source directly, just adapt patterns
- PoB2 itself is GPL-3.0 — any fork is GPL by inheritance
- Our pob2-mcp (Node side) starts MIT; if we end up copy-pasting significant pob-mcp code we relicense to GPL-3.0
- The Lua side (api-stdio branch of PoB2) is unavoidably GPL since it's a derivative of PoB2

## Risk register

| Risk | Mitigation |
|---|---|
| PoB2 internal calc API drifts during EA | Pin to a specific PoB2 commit, rebase manually each league |
| Lineage gem schema is more complex than expected | Read PoB2's Modules/SkillsTab.lua before estimating |
| Multi-ascendancy adds tree-state complexity | api-stdio already references `secondaryAscendClassId` — likely a non-issue |
| GGG's PoE2 0.5 patch changes the XML schema | Defer Phase 2 work until 0.5 lands Friday, then port |
