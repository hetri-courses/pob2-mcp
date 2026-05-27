-- API/BuildOps.lua
-- Thin wrappers around PoB headless objects for programmatic operations

local M = {}

-- Constants
local MIN_PLAYER_LEVEL = 1
local MAX_PLAYER_LEVEL = 100
local NUM_FLASK_SLOTS = 5
local MAX_ITEM_TEXT_LENGTH = 10240  -- 10KB

-- Ensure outputs are (re)built and return the main output table safely
function M.get_main_output()
  if not build or not build.calcsTab then
    return nil, "build not initialized"
  end
  if build.calcsTab.BuildOutput then
    build.calcsTab:BuildOutput()
  end
  local output = build.calcsTab and build.calcsTab.mainOutput or nil
  if not output then
    return nil, "no output available"
  end
  return output
end

-- Export a subset of useful stats from main output.
-- If `fields` is provided, only export those keys (when present).
-- The default list below was empirically validated against PoB2 0.15.0's
-- mainOutput surface (see tests/introspect-mainOutput.smoke.mjs).
function M.export_stats(fields)
  local output, err = M.get_main_output()
  if not output then
    return nil, err
  end
  local wanted = fields or {
    -- Damage / DPS
    "TotalDPS", "CombinedDPS", "FullDPS", "AverageDamage",
    "Speed", "HitChance", "AccuracyHitChance",
    "CritChance", "CritMultiplier",
    "TotalDot", "TotalDotDPS",
    -- Life / Mana / ES / Ward pools
    "Life", "LifeUnreserved", "LifeRecoverable", "LifeRegen", "LifeLeechRate",
    "Mana", "ManaUnreserved", "ManaRegen", "ManaLeechRate", "ManaCost",
    "EnergyShield", "EnergyShieldRegen",
    "Ward", "WardRegen",
    -- PoE2: Spirit (reservation budget)
    "Spirit", "SpiritReserved", "SpiritUnreserved",
    -- Charges (PoE2 caps these per type; show current + max)
    "PowerCharges", "PowerChargesMax",
    "FrenzyCharges", "FrenzyChargesMax",
    "EnduranceCharges", "EnduranceChargesMax",
    -- Defensive layers
    "Armour", "Evasion", "PhysicalDamageReduction",
    "BlockChance", "SpellBlockChance",
    "AttackDodgeChance", "SpellDodgeChance",
    -- Resistances (and over-cap, useful for penetration/curse math)
    "FireResist", "FireResistOverCap",
    "ColdResist", "ColdResistOverCap",
    "LightningResist", "LightningResistOverCap",
    "ChaosResist", "ChaosResistOverCap",
    -- Effective HP and max-hit-taken per damage type
    "TotalEHP",
    "PhysicalMaximumHitTaken", "FireMaximumHitTaken",
    "ColdMaximumHitTaken", "LightningMaximumHitTaken",
    "ChaosMaximumHitTaken",
    -- Movement
    "MovementSpeedMod",
  }
  local result = {}
  for _, k in ipairs(wanted) do
    if type(output[k]) ~= 'nil' then
      result[k] = output[k]
    end
  end
  -- include some metadata if available
  result._meta = result._meta or {}
  if build and build.targetVersion then
    result._meta.treeVersion = tostring(build.targetVersion)
  end
  if build and build.characterLevel then
    result._meta.level = tonumber(build.characterLevel)
  end
  if build and build.buildName then
    result._meta.buildName = tostring(build.buildName)
  end
  return result
end

-- Read current tree allocation and metadata
function M.get_tree()
  if not build or not build.spec then
    return nil, "build/spec not initialized"
  end
  local spec = build.spec
  local out = {
    treeVersion = spec.treeVersion,
    classId = tonumber(spec.curClassId) or 0,
    ascendClassId = tonumber(spec.curAscendClassId) or 0,
    secondaryAscendClassId = tonumber(spec.curSecondaryAscendClassId or 0) or 0,
    nodes = {},
    masteryEffects = {},
  }
  for id, _ in pairs(spec.allocNodes or {}) do
    table.insert(out.nodes, id)
  end
  for mastery, effect in pairs(spec.masterySelections or {}) do
    out.masteryEffects[mastery] = effect
  end
  table.sort(out.nodes)
  return out
end

-- Set tree allocation from parameters (full replace, not delta).
-- params: { className?, classId?, ascendClassId, secondaryAscendClassId?, nodes:[int], masteryEffects?:{[id]=effect}, treeVersion? }
function M.set_tree(params)
  if not build or not build.spec then
    return nil, "build/spec not initialized"
  end
  if type(params) ~= 'table' then
    return nil, "invalid params"
  end
  local className = params.className or (build.spec and build.spec.curClassName)
  local classId = tonumber(params.classId or 0) or 0
  local ascendId = tonumber(params.ascendClassId or 0) or 0
  local secondaryId = tonumber(params.secondaryAscendClassId or 0) or 0
  local nodes = {}
  if type(params.nodes) == 'table' then
    for _, v in ipairs(params.nodes) do
      table.insert(nodes, tonumber(v))
    end
  end
  local mastery = params.masteryEffects or {}
  local treeVersion = params.treeVersion
  -- Import (resets nodes internally and rebuilds) — PoE2 9-arg signature
  build.spec:ImportFromNodeList(className, classId, ascendId, secondaryId, nodes, {}, {}, mastery, treeVersion)
  -- Rebuild calcs to reflect changes
  M.get_main_output()
  return true
end

-- Export full build XML.
-- Build:SaveDB iterates `build.savers`, but PoB clears that table in Shutdown()
-- (and CloseBuild may trigger Shutdown if loading partially failed). For
-- minimal/synthetic builds the load can short-circuit through CloseBuild,
-- leaving savers nil and SaveDB crashing at Build.lua:2248. Reconstruct the
-- savers map from the existing tab objects before serializing — it's just a
-- mapping table, not stateful itself.
function M.export_build_xml()
  if not build or not build.SaveDB then
    return nil, 'build not initialized'
  end
  if not build.savers then
    build.savers = {
      ["Config"] = build.configTab,
      ["Notes"] = build.notesTab,
      ["Party"] = build.partyTab,
      ["Tree"] = build.treeTab,
      ["TreeView"] = build.treeTab and build.treeTab.viewer,
      ["Items"] = build.itemsTab,
      ["Skills"] = build.skillsTab,
      ["Calcs"] = build.calcsTab,
      ["Import"] = build.importTab,
    }
  end
  local ok, xml = pcall(function() return build:SaveDB('api-export') end)
  if not ok then return nil, 'SaveDB error: ' .. tostring(xml) end
  if not xml then return nil, 'failed to compose xml' end
  return xml
end

-- Set player level and rebuild
function M.set_level(level)
  if not build or not build.configTab then
    return nil, 'build/config not initialized'
  end
  local lvl = tonumber(level)
  if not lvl or lvl < MIN_PLAYER_LEVEL or lvl > MAX_PLAYER_LEVEL then
    return nil, string.format('invalid level (must be %d-%d)', MIN_PLAYER_LEVEL, MAX_PLAYER_LEVEL)
  end
  build.characterLevel = lvl
  build.characterLevelAutoMode = false
  if build.configTab and build.configTab.BuildModList then
    build.configTab:BuildModList()
  end
  M.get_main_output()
  return true
end

-- Basic build info
function M.get_build_info()
  if not build then return nil, 'build not initialized' end
  local info = {
    name = build.buildName,
    level = build.characterLevel,
    className = build and build.buildClassName or (build.Build and build.Build.className) or nil,
    ascendClassName = build and build.buildAscendName or (build.Build and build.Build.ascendClassName) or nil,
    treeVersion = build.targetVersion or (build.spec and build.spec.treeVersion) or nil,
  }
  return info
end

-- Update tree by delta lists.
-- PoE2 ImportFromNodeList signature (note: 9 args, className first):
--   ImportFromNodeList(className, classId, ascendClassId, secondaryAscendClassId,
--                      hashList, weaponSets, hashOverrides, masteryEffects, treeVersion)
-- If className is truthy, PoB resolves classId/ascendClassId via tree.classNameMap —
-- which is the canonical way to identify the class. We pass curClassName from
-- the loaded spec so the import keeps the same class.
function M.update_tree_delta(params)
  if not build or not build.spec then return nil, 'build/spec not initialized' end
  local current, err = M.get_tree()
  if not current then return nil, err end
  local set = {}
  for _, id in ipairs(current.nodes) do set[id] = true end
  if params and type(params.removeNodes) == 'table' then
    for _, id in ipairs(params.removeNodes) do set[tonumber(id)] = nil end
  end
  if params and type(params.addNodes) == 'table' then
    for _, id in ipairs(params.addNodes) do set[tonumber(id)] = true end
  end
  local nodes = {}
  for id,_ in pairs(set) do table.insert(nodes, id) end
  table.sort(nodes)
  local mastery = current.masteryEffects or {}
  local className = params.className or (build.spec and build.spec.curClassName)
  local classId = params.classId or current.classId or 0
  local ascendId = params.ascendClassId or current.ascendClassId or 0
  local secId = params.secondaryAscendClassId or current.secondaryAscendClassId or 0
  local tv = params.treeVersion or current.treeVersion

  build.spec:ImportFromNodeList(
    className,                           -- 1: className (preferred; resolves via classNameMap)
    tonumber(classId) or 0,              -- 2: classId (fallback when className nil)
    tonumber(ascendId) or 0,             -- 3: ascendClassId
    tonumber(secId) or 0,                -- 4: secondaryAscendClassId
    nodes,                                -- 5: hashList (node IDs to allocate)
    {},                                   -- 6: weaponSets (per-node weapon-set map; PoE2 dual sets, empty=default)
    {},                                   -- 7: hashOverrides
    mastery,                              -- 8: masteryEffects
    tv                                    -- 9: treeVersion
  )
  M.get_main_output()
  return true
end


-- Calculate what-if scenario without persisting changes.
-- params: { addNodes?: number[], removeNodes?: number[], useFullDPS?: boolean,
--          fields?: string[] }  -- optional whitelist of stat names to return
--
-- IMPORTANT: PoB's full mainOutput table contains reference cycles for loaded
-- builds (items point back at the build, etc.), which would crash dkjson when
-- the response is encoded. We pluck a flat set of named scalar fields — same
-- pattern as export_stats — to avoid the cycle entirely. Bonus: the response
-- is ~1KB instead of ~50KB.
function M.calc_with(params)
  if not build or not build.calcsTab then return nil, 'build not initialized' end

  -- The set of fields to pluck. Defaults match export_stats so calc_with and
  -- get_stats return comparable shapes.
  local fields = params and params.fields or {
    "TotalDPS", "CombinedDPS", "FullDPS", "AverageDamage",
    "Speed", "HitChance", "CritChance", "CritMultiplier",
    "Life", "LifeUnreserved", "LifeRegen",
    "Mana", "ManaUnreserved", "ManaRegen", "ManaCost",
    "EnergyShield", "Ward",
    "Spirit", "SpiritReserved", "SpiritUnreserved",
    "PowerCharges", "FrenzyCharges", "EnduranceCharges",
    "Armour", "Evasion", "PhysicalDamageReduction",
    "BlockChance", "SpellBlockChance",
    "FireResist", "ColdResist", "LightningResist", "ChaosResist",
    "TotalEHP",
    "PhysicalMaximumHitTaken", "FireMaximumHitTaken",
    "ColdMaximumHitTaken", "LightningMaximumHitTaken", "ChaosMaximumHitTaken",
    "MovementSpeedMod",
  }

  local ok, result = pcall(function()
    local calcFunc, _baseOutput = build.calcsTab:GetMiscCalculator()
    if type(calcFunc) ~= 'function' then
      error('GetMiscCalculator did not return a function (got ' .. type(calcFunc) .. ')')
    end

    local override = {}
    if params and type(params.addNodes) == 'table' then
      override.addNodes = {}
      for _, id in ipairs(params.addNodes) do
        local n = build.spec and build.spec.nodes and build.spec.nodes[tonumber(id)]
        if n then override.addNodes[n] = true end
      end
    end
    if params and type(params.removeNodes) == 'table' then
      override.removeNodes = {}
      for _, id in ipairs(params.removeNodes) do
        local n = build.spec and build.spec.nodes and build.spec.nodes[tonumber(id)]
        if n then override.removeNodes[n] = true end
      end
    end

    local out = calcFunc(override, params and params.useFullDPS)

    -- Pluck flat fields only — never return tables (would cycle).
    local pluck = {}
    for _, k in ipairs(fields) do
      local v = out and out[k]
      if v ~= nil and type(v) ~= 'table' and type(v) ~= 'function' then
        pluck[k] = v
      end
    end
    return pluck
  end)

  if not ok then
    return nil, 'calc_with: ' .. tostring(result)
  end
  return result
end


-- Get basic config values.
-- PoB2 stores user-controlled config in `configTab.input.<key>`. The derived
-- `configTab.enemyLevel` field is computed by ConfigTab:Build() from
-- `input.enemyLevel`, so we read from input (source of truth) and fall back to
-- the derived field for display purposes.
function M.get_config()
  if not build or not build.configTab then return nil, 'build/config not initialized' end
  local input = build.configTab.input or {}
  local cfg = {
    bandit = input.bandit or build.bandit,
    pantheonMajorGod = input.pantheonMajorGod or build.pantheonMajorGod,
    pantheonMinorGod = input.pantheonMinorGod or build.pantheonMinorGod,
    -- enemyLevel: prefer the user input; fall back to the derived value.
    enemyLevel = input.enemyLevel or build.configTab.enemyLevel,
  }
  return cfg
end

-- Set selected config values and rebuild.
-- All writes go through `configTab.input.<key>` — that's the bag ConfigTab:Build()
-- reads from. Writing to `configTab.enemyLevel` directly (as we did in 4D)
-- gets overwritten on the next BuildModList → :Build() cycle, which is why
-- the verification showed our enemyLevel:84 being silently reset to 82.
function M.set_config(params)
  if not build or not build.configTab then return nil, 'build/config not initialized' end
  if type(params) ~= 'table' then return nil, 'invalid params' end
  local input = build.configTab.input or {}
  build.configTab.input = input
  local changed = false
  if params.bandit ~= nil then input.bandit = tostring(params.bandit); changed = true end
  if params.pantheonMajorGod ~= nil then input.pantheonMajorGod = tostring(params.pantheonMajorGod); changed = true end
  if params.pantheonMinorGod ~= nil then input.pantheonMinorGod = tostring(params.pantheonMinorGod); changed = true end
  if params.enemyLevel ~= nil then
    input.enemyLevel = tonumber(params.enemyLevel) or input.enemyLevel
    changed = true
  end
  if changed and build.configTab.BuildModList then build.configTab:BuildModList() end
  M.get_main_output()
  return true
end


-- Skills API
-- Returns each socket group with both the resolved displaySkillList names AND
-- the raw gemList (what's actually socketed: nameSpec, level, quality, enabled).
-- The raw gemList is the source of truth for theorycrafting "what if I raise
-- this gem's level?" questions.
function M.get_skills()
  if not build or not build.skillsTab or not build.calcsTab then return nil, 'skills not initialized' end
  local groups = {}
  for idx, g in ipairs(build.skillsTab.socketGroupList or {}) do
    -- Resolved (post-trigger / post-replacement) skill display names
    local skillNames = {}
    if g.displaySkillList then
      for _, eff in ipairs(g.displaySkillList) do
        if eff and eff.activeEffect and eff.activeEffect.grantedEffect then
          table.insert(skillNames, eff.activeEffect.grantedEffect.name)
        end
      end
    end

    -- Raw gems as the player socketed them
    local gems = {}
    if g.gemList then
      for gemIdx, gem in ipairs(g.gemList) do
        local entry = {
          index = gemIdx,
          nameSpec = gem.nameSpec,
          skillId = gem.skillId,
          gemId = gem.gemId,
          level = tonumber(gem.level) or 1,
          quality = tonumber(gem.quality) or 0,
          qualityId = gem.qualityId,
          enabled = gem.enabled ~= false,
          count = tonumber(gem.count) or 1,
        }
        -- Mark whether this is a support gem (if we can tell)
        if gem.gemData and gem.gemData.grantedEffect then
          entry.isSupport = gem.gemData.grantedEffect.support == true
        end
        table.insert(gems, entry)
      end
    end

    table.insert(groups, {
      index = idx,
      label = g.label,
      slot = g.slot,
      enabled = g.enabled,
      includeInFullDPS = g.includeInFullDPS,
      mainActiveSkill = g.mainActiveSkill,
      skills = skillNames,
      gems = gems,
    })
  end
  local result = {
    mainSocketGroup = build.mainSocketGroup,
    calcsSkillNumber = build.calcsTab.input and build.calcsTab.input.skill_number or nil,
    groups = groups,
  }
  return result
end

function M.set_main_selection(params)
  if not build or not build.skillsTab or not build.calcsTab then return nil, 'skills not initialized' end
  if type(params) ~= 'table' then return nil, 'invalid params' end
  if params.mainSocketGroup ~= nil then
    build.mainSocketGroup = tonumber(params.mainSocketGroup) or build.mainSocketGroup
  end
  local g = build.skillsTab.socketGroupList[build.mainSocketGroup]
  if not g then return nil, 'invalid mainSocketGroup' end
  if params.mainActiveSkill ~= nil then
    g.mainActiveSkill = tonumber(params.mainActiveSkill) or g.mainActiveSkill
  end
  if params.skillPart ~= nil then
    local idx = g.mainActiveSkill or 1
    local src = g.displaySkillList and g.displaySkillList[idx] and g.displaySkillList[idx].activeEffect and g.displaySkillList[idx].activeEffect.srcInstance
    if src then src.skillPart = tonumber(params.skillPart) end
  end
  -- Keep calcsTab in sync: use active group index
  build.calcsTab.input.skill_number = build.mainSocketGroup
  M.get_main_output()
  return true
end

-- Items API
function M.add_item_text(params)
  if not build or not build.itemsTab then return nil, 'items not initialized' end
  if type(params) ~= 'table' or type(params.text) ~= 'string' then return nil, 'missing text' end

  -- Validate input to prevent potential issues
  if #params.text == 0 then return nil, 'item text cannot be empty' end
  if #params.text > MAX_ITEM_TEXT_LENGTH then
    return nil, string.format('item text too long (max %d bytes)', MAX_ITEM_TEXT_LENGTH)
  end

  -- Use pcall to safely handle item creation
  local ok, item = pcall(new, 'Item', params.text)
  if not ok then return nil, 'invalid item text: ' .. tostring(item) end
  if not item or not item.baseName then return nil, 'failed to parse item' end

  item:NormaliseQuality()
  build.itemsTab:AddItem(item, params.noAutoEquip == true)
  if params.slotName then
    local slot = tostring(params.slotName)
    if build.itemsTab.slots[slot] then
      build.itemsTab.slots[slot]:SetSelItemId(item.id)
      build.itemsTab:PopulateSlots()
    end
  end
  build.itemsTab:AddUndoState()
  build.buildFlag = true
  M.get_main_output()
  return { id = item.id, name = item.name, slot = params.slotName or item:GetPrimarySlot() }
end

-- Parse an item text WITHOUT adding it to the build. Returns the parsed
-- structure (name, base, rarity, mod lists, requirements) for analysis tools.
function M.parse_item_text(params)
  if type(params) ~= 'table' or type(params.text) ~= 'string' then return nil, 'missing text' end
  if #params.text == 0 then return nil, 'item text cannot be empty' end
  if #params.text > MAX_ITEM_TEXT_LENGTH then
    return nil, string.format('item text too long (max %d bytes)', MAX_ITEM_TEXT_LENGTH)
  end

  local ok, item = pcall(new, 'Item', params.text)
  if not ok then return nil, 'parse failed: ' .. tostring(item) end
  if not item or not item.baseName then return nil, 'no baseName parsed' end

  pcall(function() item:NormaliseQuality() end)

  -- Pluck flat scalar fields + mod lists (avoid cyclic structures).
  local result = {
    name = item.name,
    baseName = item.baseName,
    type = item.type,
    rarity = item.rarity,
    quality = tonumber(item.quality) or 0,
    itemLevel = tonumber(item.itemLevel) or nil,
    corrupted = item.corrupted == true,
    requirements = nil,
    implicitMods = {},
    explicitMods = {},
    enchantMods = {},
    runeMods = {},
    raw = item.raw or params.text,
  }
  -- Requirements summary
  if item.requirements then
    result.requirements = {
      level = tonumber(item.requirements.level) or nil,
      strength = tonumber(item.requirements.strength) or nil,
      dexterity = tonumber(item.requirements.dexterity) or nil,
      intelligence = tonumber(item.requirements.intelligence) or nil,
    }
  end
  -- Pluck mod text from the parsed item. PoB stores them as lists of objects;
  -- we want the human-readable line for each.
  local function pluckList(src, target)
    if type(src) ~= 'table' then return end
    for _, mod in ipairs(src) do
      local line = mod and (mod.line or mod.text or mod[1])
      if type(line) == 'string' then table.insert(target, line) end
    end
  end
  pluckList(item.implicitModLines, result.implicitMods)
  pluckList(item.explicitModLines, result.explicitMods)
  pluckList(item.enchantModLines, result.enchantMods)
  pluckList(item.runeModLines, result.runeMods)

  return result
end

function M.set_flask_active(params)
  if not build or not build.itemsTab then return nil, 'items not initialized' end
  if type(params) ~= 'table' then return nil, 'invalid params' end
  local idx = tonumber(params.index)
  local active = params.active == true
  if not idx or idx < 1 or idx > NUM_FLASK_SLOTS then
    return nil, string.format('invalid flask index (must be 1-%d)', NUM_FLASK_SLOTS)
  end
  local slotName = 'Flask ' .. tostring(idx)
  if not build.itemsTab.activeItemSet or not build.itemsTab.activeItemSet[slotName] then return nil, 'slot not found' end
  build.itemsTab.activeItemSet[slotName].active = active
  build.itemsTab:AddUndoState()
  build.buildFlag = true
  M.get_main_output()
  return true
end


-- Get equipped items summary.
-- params: { onlyEquipped?: boolean (default true) }
--   onlyEquipped=true (default) skips empty slots; cleaner for LLM consumption.
--   onlyEquipped=false returns every slot the build has, including empty ones
--     (useful for "what slots are available?").
function M.get_items(params)
  if not build or not build.itemsTab then return nil, 'items not initialized' end
  local onlyEquipped = true
  if params and params.onlyEquipped == false then onlyEquipped = false end

  local itemsTab = build.itemsTab
  local result = { }
  -- Prefer orderedSlots for deterministic order
  local ordered = itemsTab.orderedSlots or {}
  local seen = {}
  local function add_slot(slotName)
    if seen[slotName] then return end
    seen[slotName] = true
    local slotCtrl = itemsTab.slots[slotName]
    if not slotCtrl then return end
    local selId = slotCtrl.selItemId or 0
    if onlyEquipped and selId == 0 then return end
    local entry = { slot = slotName, id = selId }
    if selId > 0 then
      local it = itemsTab.items[selId]
      if it then
        entry.name = it.name
        entry.baseName = it.baseName
        entry.type = it.type
        entry.rarity = it.rarity
        entry.raw = it.raw
      end
    end
    -- Flask/Tincture activation flag stored in activeItemSet
    local set = itemsTab.activeItemSet
    if set and set[slotName] and set[slotName].active ~= nil then
      entry.active = set[slotName].active and true or false
    end
    table.insert(result, entry)
  end
  for _, slot in ipairs(ordered) do
    if slot and slot.slotName then add_slot(slot.slotName) end
  end
  -- Add any remaining slots not in ordered list
  for slotName, _ in pairs(itemsTab.slots or {}) do add_slot(slotName) end
  return result
end


-- Skill/Gem Creation and Modification API

-- Create a new socket group
-- params: { label?: string, slot?: string, enabled?: boolean, includeInFullDPS?: boolean }
function M.create_socket_group(params)
  if not build or not build.skillsTab then return nil, 'skills not initialized' end
  if type(params) ~= 'table' then params = {} end

  local socketGroup = {
    label = params.label or '',
    slot = params.slot,
    enabled = params.enabled ~= false,
    includeInFullDPS = params.includeInFullDPS == true,
    gemList = {},
    mainActiveSkill = 1,
    mainActiveSkillCalcs = 1,
  }

  -- Get the active skill set
  local skillSetId = build.skillsTab.activeSkillSetId or 1
  local skillSet = build.skillsTab.skillSets[skillSetId]
  if not skillSet then return nil, 'active skill set not found' end

  -- Add to socket group list
  table.insert(skillSet.socketGroupList, socketGroup)
  local index = #skillSet.socketGroupList

  -- Process the socket group
  if build.skillsTab.ProcessSocketGroup then
    build.skillsTab:ProcessSocketGroup(socketGroup)
  end

  build.buildFlag = true
  M.get_main_output()

  return { index = index, label = socketGroup.label }
end

-- Add a gem to a socket group
-- params: { groupIndex: number, gemName: string, level?: number, quality?: number, qualityId?: string, enabled?: boolean }
function M.add_gem(params)
  if not build or not build.skillsTab then return nil, 'skills not initialized' end
  if type(params) ~= 'table' then return nil, 'invalid params' end
  if not params.groupIndex or not params.gemName then return nil, 'missing groupIndex or gemName' end

  local skillSetId = build.skillsTab.activeSkillSetId or 1
  local skillSet = build.skillsTab.skillSets[skillSetId]
  if not skillSet then return nil, 'active skill set not found' end

  local groupIndex = tonumber(params.groupIndex)
  local socketGroup = skillSet.socketGroupList[groupIndex]
  if not socketGroup then return nil, 'socket group not found at index ' .. tostring(groupIndex) end

  -- Create gem instance
  local gemInstance = {
    nameSpec = tostring(params.gemName),
    level = tonumber(params.level) or 20,
    quality = tonumber(params.quality) or 0,
    qualityId = params.qualityId or 'Default',
    enabled = params.enabled ~= false,
    enableGlobal1 = true,
    enableGlobal2 = false,
    count = tonumber(params.count) or 1,
  }

  -- Try to find gem data
  if build.data and build.data.gems then
    for _, gemData in pairs(build.data.gems) do
      if gemData.name == gemInstance.nameSpec or gemData.nameSpec == gemInstance.nameSpec then
        gemInstance.gemId = gemData.id
        if gemData.grantedEffect then
          gemInstance.skillId = gemData.grantedEffect.id
        elseif gemData.grantedEffectId then
          gemInstance.skillId = gemData.grantedEffectId
        end
        gemInstance.gemData = gemData
        break
      end
    end
  end

  table.insert(socketGroup.gemList, gemInstance)
  local gemIndex = #socketGroup.gemList

  if build.skillsTab.ProcessSocketGroup then
    build.skillsTab:ProcessSocketGroup(socketGroup)
  end

  build.buildFlag = true
  M.get_main_output()

  return { gemIndex = gemIndex, name = gemInstance.nameSpec }
end

-- Set gem level
-- params: { groupIndex: number, gemIndex: number, level: number }
function M.set_gem_level(params)
  if not build or not build.skillsTab then return nil, 'skills not initialized' end
  if type(params) ~= 'table' then return nil, 'invalid params' end
  if not params.groupIndex or not params.gemIndex or not params.level then
    return nil, 'missing groupIndex, gemIndex, or level'
  end

  local skillSetId = build.skillsTab.activeSkillSetId or 1
  local skillSet = build.skillsTab.skillSets[skillSetId]
  if not skillSet then return nil, 'active skill set not found' end

  local groupIndex = tonumber(params.groupIndex)
  local gemIndex = tonumber(params.gemIndex)
  local level = tonumber(params.level)

  local socketGroup = skillSet.socketGroupList[groupIndex]
  if not socketGroup then return nil, 'socket group not found' end

  local gemInstance = socketGroup.gemList[gemIndex]
  if not gemInstance then return nil, 'gem not found' end

  if level < 1 or level > 40 then return nil, 'invalid level (must be 1-40)' end

  gemInstance.level = level

  if build.skillsTab.ProcessSocketGroup then
    build.skillsTab:ProcessSocketGroup(socketGroup)
  end

  build.buildFlag = true
  M.get_main_output()

  return true
end

-- Set gem quality
-- params: { groupIndex: number, gemIndex: number, quality: number, qualityId?: string }
function M.set_gem_quality(params)
  if not build or not build.skillsTab then return nil, 'skills not initialized' end
  if type(params) ~= 'table' then return nil, 'invalid params' end
  if not params.groupIndex or not params.gemIndex or not params.quality then
    return nil, 'missing groupIndex, gemIndex, or quality'
  end

  local skillSetId = build.skillsTab.activeSkillSetId or 1
  local skillSet = build.skillsTab.skillSets[skillSetId]
  if not skillSet then return nil, 'active skill set not found' end

  local groupIndex = tonumber(params.groupIndex)
  local gemIndex = tonumber(params.gemIndex)
  local quality = tonumber(params.quality)

  local socketGroup = skillSet.socketGroupList[groupIndex]
  if not socketGroup then return nil, 'socket group not found' end

  local gemInstance = socketGroup.gemList[gemIndex]
  if not gemInstance then return nil, 'gem not found' end

  if quality < 0 or quality > 23 then return nil, 'invalid quality (must be 0-23)' end

  gemInstance.quality = quality
  if params.qualityId then
    gemInstance.qualityId = tostring(params.qualityId)
  end

  if build.skillsTab.ProcessSocketGroup then
    build.skillsTab:ProcessSocketGroup(socketGroup)
  end

  build.buildFlag = true
  M.get_main_output()

  return true
end

-- Remove a socket group
-- params: { groupIndex: number }
function M.remove_skill(params)
  if not build or not build.skillsTab then return nil, 'skills not initialized' end
  if type(params) ~= 'table' then return nil, 'invalid params' end
  if not params.groupIndex then return nil, 'missing groupIndex' end

  local skillSetId = build.skillsTab.activeSkillSetId or 1
  local skillSet = build.skillsTab.skillSets[skillSetId]
  if not skillSet then return nil, 'active skill set not found' end

  local groupIndex = tonumber(params.groupIndex)
  local socketGroup = skillSet.socketGroupList[groupIndex]
  if not socketGroup then return nil, 'socket group not found' end

  -- Don't allow removing special groups with sources
  if socketGroup.source then
    return nil, 'cannot remove special socket groups (item/node granted skills)'
  end

  table.remove(skillSet.socketGroupList, groupIndex)

  build.buildFlag = true
  M.get_main_output()

  return true
end

-- Remove a gem from a socket group
-- params: { groupIndex: number, gemIndex: number }
function M.remove_gem(params)
  if not build or not build.skillsTab then return nil, 'skills not initialized' end
  if type(params) ~= 'table' then return nil, 'invalid params' end
  if not params.groupIndex or not params.gemIndex then
    return nil, 'missing groupIndex or gemIndex'
  end

  local skillSetId = build.skillsTab.activeSkillSetId or 1
  local skillSet = build.skillsTab.skillSets[skillSetId]
  if not skillSet then return nil, 'active skill set not found' end

  local groupIndex = tonumber(params.groupIndex)
  local gemIndex = tonumber(params.gemIndex)

  local socketGroup = skillSet.socketGroupList[groupIndex]
  if not socketGroup then return nil, 'socket group not found' end

  local gemInstance = socketGroup.gemList[gemIndex]
  if not gemInstance then return nil, 'gem not found' end

  table.remove(socketGroup.gemList, gemIndex)

  if build.skillsTab.ProcessSocketGroup then
    build.skillsTab:ProcessSocketGroup(socketGroup)
  end

  build.buildFlag = true
  M.get_main_output()

  return true
end


-- Search for passive tree nodes by keyword
-- params: { keyword: string, nodeType?: string ('normal'|'notable'|'keystone'), maxResults?: number, includeAllocated?: boolean }
function M.search_nodes(params)
  if not build or not build.spec then return nil, 'build/spec not initialized' end
  if type(params) ~= 'table' or type(params.keyword) ~= 'string' then
    return nil, 'missing or invalid keyword'
  end

  local keyword = params.keyword:lower()
  local nodeType = params.nodeType and params.nodeType:lower() or nil
  local maxResults = tonumber(params.maxResults) or 50
  local includeAllocated = params.includeAllocated ~= false

  local results = {}
  local count = 0

  -- Get allocated nodes set for quick lookup
  local allocatedSet = {}
  if build.spec.allocNodes then
    for id, _ in pairs(build.spec.allocNodes) do
      allocatedSet[id] = true
    end
  end

  -- Search through all nodes
  for id, node in pairs(build.spec.nodes) do
    if count >= maxResults then break end

    -- Skip if already allocated and we don't want allocated nodes
    if not includeAllocated and allocatedSet[id] then
      goto continue
    end

    -- Filter by node type if specified
    if nodeType then
      local nType = 'normal'
      if node.isKeystone then nType = 'keystone'
      elseif node.isNotable then nType = 'notable'
      elseif node.isJewelSocket then nType = 'jewel'
      elseif node.isMultipleChoiceOption then nType = 'mastery'
      elseif node.ascendancyName then nType = 'ascendancy'
      end
      if nType ~= nodeType then goto continue end
    end

    -- Check if keyword matches name
    local matches = false
    if node.name and node.name:lower():find(keyword, 1, true) then
      matches = true
    end

    -- Check if keyword matches stats/modifiers
    if not matches and node.sd then
      for _, stat in ipairs(node.sd) do
        if type(stat) == 'string' and stat:lower():find(keyword, 1, true) then
          matches = true
          break
        end
      end
    end

    -- Check modifiers list
    if not matches and node.modList then
      for _, mod in ipairs(node.modList) do
        local modStr = tostring(mod)
        if modStr:lower():find(keyword, 1, true) then
          matches = true
          break
        end
      end
    end

    if matches then
      local nodeType = 'normal'
      if node.isKeystone then nodeType = 'keystone'
      elseif node.isNotable then nodeType = 'notable'
      elseif node.isJewelSocket then nodeType = 'jewel'
      elseif node.isMultipleChoiceOption then nodeType = 'mastery'
      elseif node.ascendancyName then nodeType = 'ascendancy'
      end

      local stats = {}
      if node.sd then
        for _, stat in ipairs(node.sd) do
          if type(stat) == 'string' then
            table.insert(stats, stat)
          end
        end
      end

      table.insert(results, {
        id = id,
        name = node.name or 'Unnamed',
        type = nodeType,
        stats = stats,
        allocated = allocatedSet[id] == true,
        x = node.x,
        y = node.y,
        orbit = node.orbit,
        orbitIndex = node.orbitIndex,
        ascendancyName = node.ascendancyName,
      })
      count = count + 1
    end

    ::continue::
  end

  -- Sort results: keystones first, then notables, then normal
  table.sort(results, function(a, b)
    local typeOrder = { keystone = 1, notable = 2, jewel = 3, mastery = 4, ascendancy = 5, normal = 6 }
    local aOrder = typeOrder[a.type] or 99
    local bOrder = typeOrder[b.type] or 99
    if aOrder ~= bOrder then
      return aOrder < bOrder
    end
    return (a.name or '') < (b.name or '')
  end)

  return { nodes = results, count = #results }
end

return M
