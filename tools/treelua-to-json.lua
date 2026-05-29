-- Convert PoB's TreeData/<ver>/tree.lua (the official, calc-authoritative tree)
-- into the tree.json schema that pob2-mcp's treeData.ts + treeSvg.ts consume.
--
-- Why: PoB ships the passive tree as a Lua data table (loaded by the calc
-- engine), but our Node-side tools read JSON. Generating tree.json straight
-- from tree.lua guarantees the Node tools and the Lua calc engine speak the
-- EXACT same tree (same node ids, connections, coords) instead of drifting
-- against a separately-sourced export.
--
-- Coords use PoB's own formula (Classes/PassiveTree.lua:524-529), so the
-- precomputed x/y match what the calc engine renders:
--   angle  = orbitAnglesByOrbit[o+1][oidx+1]
--   radius = orbitRadii[o+1]
--   x = group.x + sin(angle)*radius ;  y = group.y - cos(angle)*radius
--
-- Run (under WSL, like the bridge):
--   wsl luajit tools/treelua-to-json.lua <tree.lua> <out.json> <dkjson.lua> <verLabel>
--
-- All paths are WSL paths (e.g. /mnt/d/pob2-mcp/...).

local treeLuaPath = arg[1]
local outPath     = arg[2]
local dkjsonPath  = arg[3]
local verLabel    = arg[4] or "tree.lua"

assert(treeLuaPath and outPath and dkjsonPath, "usage: luajit treelua-to-json.lua <tree.lua> <out.json> <dkjson.lua> [verLabel]")

local json = dofile(dkjsonPath)
assert(type(json) == "table" and json.encode, "dkjson did not return an encoder")

local t = dofile(treeLuaPath)
assert(type(t) == "table" and t.nodes and t.groups and t.constants, "tree.lua missing nodes/groups/constants")

local C = t.constants
local groups = t.groups

-- PoE2 base-class name -> a stable index, so class-start nodes still classify
-- as "class-start" (treeData) and render large (treeSvg). The exact integer is
-- cosmetic: the old export stored an array here and nothing compares it by value.
local NAME_IDX = {
  Warrior = 0, Witch = 1, Ranger = 2, Monk = 3, Mercenary = 4, Sorceress = 5,
  Druid = 6, Huntress = 7, Shadow = 8, Templar = 9, Marauder = 10, Duelist = 11, Scion = 12,
}

local function nodePos(node)
  if not node.group then return nil end
  local g = groups[node.group]
  if not g or g.x == nil or g.y == nil then return nil end
  local o   = node.orbit or 0
  local oi  = node.orbitIndex or 0
  local row = C.orbitAnglesByOrbit[o + 1]
  local angle = (row and row[oi + 1]) or 0
  local radius = C.orbitRadii[o + 1] or 0
  local x = g.x + math.sin(angle) * radius
  local y = g.y - math.cos(angle) * radius
  return x, y
end

local outNodes = {}
local nodeCount = 0
local minx, maxx, miny, maxy = math.huge, -math.huge, math.huge, -math.huge

for key, node in pairs(t.nodes) do
  local id = node.skill or key
  local o = {
    name  = node.name,
    icon  = node.icon,
    stats = node.stats or {},
    group = node.group,
    orbit = node.orbit,
    orbitIndex = node.orbitIndex,
    skill = id,
  }

  -- connections: keep id only (render uses straight lines; pathing uses id).
  local conns = {}
  if node.connections then
    for _, c in ipairs(node.connections) do
      conns[#conns + 1] = { id = c.id }
    end
  end
  o.connections = conns

  local x, y = nodePos(node)
  if x ~= nil then
    -- round to 3 decimals to keep the file lean (matches old export precision)
    o.x = math.floor(x * 1000 + 0.5) / 1000
    o.y = math.floor(y * 1000 + 0.5) / 1000
    if o.x < minx then minx = o.x end
    if o.x > maxx then maxx = o.x end
    if o.y < miny then miny = o.y end
    if o.y > maxy then maxy = o.y end
  end

  if node.isKeystone then o.isKeystone = true end
  if node.isNotable then o.isNotable = true end
  if node.isJewelSocket then o.isJewelSocket = true end
  if node.isMastery then o.isMastery = true end
  if node.isAttribute then o.isAttribute = true end
  if node.ascendancyName then o.ascendancyName = node.ascendancyName end
  if node.flavourText then o.flavourText = node.flavourText end
  if node.reminderText then o.reminderText = node.reminderText end

  if node.classesStart then
    o.classesStart = node.classesStart
    local idxs = {}
    for _, cn in ipairs(node.classesStart) do
      idxs[#idxs + 1] = NAME_IDX[cn] or 0
    end
    o.classStartIndex = idxs
  end

  outNodes[tostring(id)] = o
  nodeCount = nodeCount + 1
end

local outGroups = {}
for gid, g in pairs(groups) do
  outGroups[tostring(gid)] = { x = g.x, y = g.y, orbits = g.orbits, nodes = g.nodes }
end

local out = {
  nodes = outNodes,
  groups = outGroups,
  constants = {
    orbitRadii = C.orbitRadii,
    skillsPerOrbit = C.skillsPerOrbit,
    orbitAnglesByOrbit = C.orbitAnglesByOrbit,
  },
  min_x = minx, max_x = maxx, min_y = miny, max_y = maxy,
  _synthesizedFrom = verLabel,
}

local enc = json.encode(out, { indent = false })
local f = assert(io.open(outPath, "w"))
f:write(enc)
f:close()

print(string.format("wrote %s  nodes=%d  bbox=[%.0f,%.0f .. %.0f,%.0f]",
  outPath, nodeCount, minx, miny, maxx, maxy))
