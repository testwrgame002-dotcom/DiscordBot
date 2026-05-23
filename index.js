//125, 1160 cambio tiempo
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  MessageFlags
} = require("discord.js")


const { Redis } = require("@upstash/redis")

const gpHandler = require("./gpHandler");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
})

// ================= CONFIG =================

const TOKEN = process.env.TOKEN

const PANEL_CHANNEL_ID = "1494760619985862676"
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
})

function onlineKey(group) {
  return `online:${group}`
}

function normalizeRedisIds(ids) {
  if (!Array.isArray(ids)) return []

  return ids
    .map(id => String(id).trim())
    .filter(id => /^\d{16}$/.test(id))
}
function usersKey(group) {
  return `users:${group}`
}

function vipKey(group) {
  return `vip:${group}`
}

function schedulesKey() {
  return "daily_schedules"
}

function panelDataKey() {
  return "panel_data"
}

function activeRolesKey() {
  return "active_roles"
}

function safeJsonParse(value, fallback = {}) {
  try {
    if (!value) return fallback
    if (typeof value === "object") return value
    return JSON.parse(value)
  } catch {
    return fallback
  }
}
function uniqueList(arr) {
  return [...new Set(
    arr
      .map(x => String(x || "").trim())
      .filter(Boolean)
  )]
}

function buildUserData(oldData, interaction, updates = {}) {

  const discordName =
    interaction.member?.displayName ||
    interaction.user?.username ||
    "Unknown"

  const oldAliases = Array.isArray(oldData.aliases)
    ? oldData.aliases
    : []

  const finalMainId =
    updates.main_id !== undefined
      ? updates.main_id
      : oldData.main_id || null

  const finalSecId =
    updates.sec_id !== undefined
      ? updates.sec_id
      : oldData.sec_id || null

  const name =
    updates.name ||
    oldData.name ||
    discordName

  const heartbeatName =
    updates.heartbeatName ||
    oldData.heartbeatName ||
    name

  const aliases = uniqueList([
    ...oldAliases,
    oldData.name,
    oldData.heartbeatName,
    discordName,
    name,
    heartbeatName
  ])

  return {
    ...oldData,

    name,
    heartbeatName,
    aliases,

    main_id: finalMainId,
    sec_id: finalSecId,

    ...updates
  }
}
// ================= RIVAL DUO SYSTEM =================

const RIVAL_DUOS_KEY = "rival_duos"
const RIVAL_DUO_BY_USER_KEY = "rival_duo_by_user"
const RIVAL_DUO_BY_GAMEID_KEY = "rival_duo_by_gameid"
//const RIVAL_DUO_ROTATION_MS = 2 * 60 * 1000
const RIVAL_DUO_ROTATION_MS = 60 * 60 * 1000

function rivalDuoPendingKey(discordId) {
  return `rival_duo_pending:${discordId}`
}

function createRivalDuoId() {
  return `duo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function rivalNow() {
  return Date.now()
}

function isValidGameId(id) {
  return /^\d{16}$/.test(String(id || "").trim())
}

function parseRivalJson(value, fallback = {}) {
  try {
    if (!value) return fallback
    if (typeof value === "object") return value
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function getRivalDuoMembers(duo) {
  return Object.entries(duo?.members || {}).map(([discordId, member]) => ({
    discordId,
    ...member
  }))
}

function getRivalDuoMember(duo, discordId) {
  return duo?.members?.[String(discordId)] || null
}

function isRivalDuoFull(duo) {
  return getRivalDuoMembers(duo).length >= 2
}

function displayRivalDuoName(duo) {
  const members = getRivalDuoMembers(duo)

  if (!members.length) return "Empty Duo"

  return members
    .map(m => m.name || m.heartbeatName || "Unknown")
    .join(" & ")
}

async function loadAllRivalDuos() {
  try {
    const data = await redis.hgetall(RIVAL_DUOS_KEY)

    if (!data || typeof data !== "object") return {}

    const out = {}

    for (const duoId in data) {
      out[duoId] = parseRivalJson(data[duoId], null)
    }

    return out
  } catch (err) {
    console.error("Error loading rival duos:", err)
    return {}
  }
}

async function saveRivalDuo(duo) {
  try {
    if (!duo?.id) return false

    await redis.hset(RIVAL_DUOS_KEY, {
      [duo.id]: JSON.stringify(duo)
    })

    return true
  } catch (err) {
    console.error("Error saving rival duo:", err)
    return false
  }
}

async function getRivalDuoById(duoId) {
  try {
    const raw = await redis.hget(RIVAL_DUOS_KEY, String(duoId))
    return parseRivalJson(raw, null)
  } catch (err) {
    console.error("Error loading rival duo by id:", err)
    return null
  }
}

async function getRivalDuoByUser(discordId) {
  try {
    const raw = await redis.hget(RIVAL_DUO_BY_USER_KEY, String(discordId))

    if (!raw) return null

    const ref = parseRivalJson(raw, null)

    if (!ref?.duoId) return null

    return await getRivalDuoById(ref.duoId)
  } catch (err) {
    console.error("Error loading rival duo by user:", err)
    return null
  }
}

async function getAllRivalDuosByUser(discordId) {
  const duos = await loadAllRivalDuos()
  const found = []

  for (const duo of Object.values(duos)) {
    if (!duo) continue

    if (duo.members && duo.members[String(discordId)]) {
      found.push(duo)
    }
  }

  return found
}

async function saveRivalDuoIndexes(duo) {
  try {
    for (const member of getRivalDuoMembers(duo)) {
      await redis.hset(RIVAL_DUO_BY_USER_KEY, {
        [member.discordId]: JSON.stringify({
          duoId: duo.id,
          discordId: member.discordId
        })
      })

      await redis.hset(RIVAL_DUO_BY_GAMEID_KEY, {
        [member.gameId]: JSON.stringify({
          duoId: duo.id,
          discordId: member.discordId
        })
      })
    }

    return true
  } catch (err) {
    console.error("Error saving rival duo indexes:", err)
    return false
  }
}

async function findOpenRivalDuos() {
  const duos = await loadAllRivalDuos()

  return Object.values(duos)
    .filter(Boolean)
    .filter(duo => !isRivalDuoFull(duo))
}

async function savePendingRivalDuoRegistration(discordId, data) {
  await redis.set(rivalDuoPendingKey(discordId), JSON.stringify(data), {
    ex: 10 * 60
  })
}

async function loadPendingRivalDuoRegistration(discordId) {
  const raw = await redis.get(rivalDuoPendingKey(discordId))
  return parseRivalJson(raw, null)
}

async function clearPendingRivalDuoRegistration(discordId) {
  await redis.del(rivalDuoPendingKey(discordId))
}

async function registerRivalDuoMember({
  discordId,
  name,
  heartbeatName,
  gameId,
  duoId = null
}) {
  discordId = String(discordId)
  gameId = String(gameId || "").trim()
  duoId = duoId ? String(duoId) : null

  if (!isValidGameId(gameId)) {
    return {
      ok: false,
      message: "❌ ID must be exactly 16 digits."
    }
  }

  let duo = null

  if (duoId) {
    duo = await getRivalDuoById(duoId)

    if (!duo) {
      return {
        ok: false,
        message: "❌ This Rival Duo no longer exists."
      }
    }

    if (!duo.members || typeof duo.members !== "object") {
      duo.members = {}
    }

    if (duo.members[discordId]) {
      return {
        ok: false,
        message: "❌ You are already registered in this Rival Duo."
      }
    }

    if (isRivalDuoFull(duo)) {
      return {
        ok: false,
        message: "❌ This Rival Duo is already full."
      }
    }
  } else {
    duo = {
      id: createRivalDuoId(),
      createdAt: rivalNow(),
      members: {},
      onlineUsers: {},
      activeGameId: null,
      activeDiscordId: null,
      activeIndex: 0,
      lastRotationAt: 0,
      lastHeartbeatAt: {},
      lastHeartbeatStats: {},
      status: "waiting",
      offlineReason: null,
      offlineAt: null
    }
  }

duo.members[discordId] = {
  discordId,
  name: name || "Unknown",
  heartbeatName: heartbeatName || name || "Unknown",
  gameId,
  aliases: uniqueList([
    name,
    heartbeatName
  ])
}

const saved = await saveRivalDuo(duo)

  if (!saved) {
    return {
      ok: false,
      message: "❌ Could not save Rival Duo in Redis."
    }
  }

  const reloaded = await getRivalDuoById(duo.id)

  if (!reloaded?.members?.[discordId]) {
    return {
      ok: false,
      message: "❌ Rival Duo was not saved correctly. Try again."
    }
  }

  const indexed = await saveRivalDuoIndexes(reloaded)

  if (!indexed) {
    return {
      ok: false,
      message: "❌ Rival Duo was saved, but indexes could not be updated."
    }
  }

  if (isRivalDuoFull(reloaded)) {
    return {
      ok: true,
      message: `✅ Rival Duo completed: **${displayRivalDuoName(reloaded)}**.`
    }
  }

  return {
    ok: true,
    message: "✅ Rival Duo created. Waiting for your reroll partner."
  }
}

async function removeRivalDuoIdsFromElite(duo) {
  const ids = getRivalDuoMembers(duo)
    .map(m => String(m.gameId || "").trim())
    .filter(isValidGameId)

  if (!ids.length) return

  await redis.srem("online:Elite_Four", ...ids)
}

async function activateRivalDuoId(duo, force = false) {
  const members = getRivalDuoMembers(duo)

  if (members.length < 2) {
    await removeRivalDuoIdsFromElite(duo)

    duo.activeGameId = null
    duo.activeDiscordId = null
    duo.status = "waiting_partner"

    await saveRivalDuo(duo)

    return {
      ok: false,
      waiting: true,
      message: "⏳ Waiting for reroll partner."
    }
  }

  const bothOnline = members.every(member => {
    return duo.onlineUsers?.[member.discordId] === true
  })

  if (!bothOnline) {
    await removeRivalDuoIdsFromElite(duo)

    duo.activeGameId = null
    duo.activeDiscordId = null
    duo.status = "waiting_partner"

    await saveRivalDuo(duo)

    return {
      ok: false,
      waiting: true,
      message: "⏳ Waiting for reroll partner."
    }
  }

  const now = rivalNow()

  const shouldRotate =
    force ||
    !duo.lastRotationAt ||
    //now - Number(duo.lastRotationAt || 0) >= 60 * 60 * 1000
    now - Number(duo.lastRotationAt || 0) >= RIVAL_DUO_ROTATION_MS

  if (!duo.activeGameId || shouldRotate) {
    const index = Number(duo.activeIndex || 0) % members.length
    const activeMember = members[index]
    
if (!activeMember || !isValidGameId(activeMember.gameId)) {
  return {
    ok: false,
    waiting: true,
    message: "❌ Rival Duo active member has an invalid or missing game ID."
  }
}
    await removeRivalDuoIdsFromElite(duo)

    duo.activeGameId = activeMember.gameId
    duo.activeDiscordId = activeMember.discordId
    duo.lastRotationAt = now
    duo.activeIndex = (index + 1) % members.length
    duo.status = "online"

    await redis.sadd("online:Elite_Four", String(activeMember.gameId))
    await saveRivalDuo(duo)

    return {
      ok: true,
      waiting: false,
      message: `🟢 Rival Duo online in Elite Four.\nActive ID: **${activeMember.gameId}**\nActive user: <@${activeMember.discordId}>`
    }
  }

if (!isValidGameId(duo.activeGameId)) {
  return {
    ok: false,
    waiting: true,
    message: "❌ Rival Duo activeGameId is invalid or missing."
  }
}

await redis.sadd("online:Elite_Four", String(duo.activeGameId))
await saveRivalDuo(duo)

  return {
    ok: true,
    waiting: false,
    message: `🟢 Rival Duo already online.\nActive ID: **${duo.activeGameId}**\nActive user: <@${duo.activeDiscordId}>`
  }
}

async function setRivalDuoOnline(discordId) {
  discordId = String(discordId)

  const allDuos = await loadAllRivalDuos()
  const messages = []
  let found = false

  for (const duoId in allDuos) {
    const duo = allDuos[duoId]
    if (!duo || !duo.members) continue

    if (!duo.members[discordId]) continue

    found = true

    if (!duo.onlineUsers || typeof duo.onlineUsers !== "object") {
      duo.onlineUsers = {}
    }

    duo.onlineUsers[discordId] = true

    await saveRivalDuo(duo)

    const result = await activateRivalDuoId(duo, false)

    messages.push(
      `🤝 **${displayRivalDuoName(duo)}**\n${result.message}`
    )
  }

  if (!found) {
    return {
      ok: false,
      message: "❌ You are not registered in any Rival Duo."
    }
  }

  return {
    ok: true,
    message: messages.join("\n\n")
  }
}

async function setRivalDuoOffline(discordId, reason = "offline") {
  discordId = String(discordId)

  const allDuos = await loadAllRivalDuos()
  const messages = []
  let found = false

  for (const duoId in allDuos) {
    const duo = allDuos[duoId]
    if (!duo || !duo.members) continue

    if (!duo.members[discordId]) continue

    found = true

    await removeRivalDuoIdsFromElite(duo)

    duo.onlineUsers = {}
    duo.activeGameId = null
    duo.activeDiscordId = null
    duo.status = "offline"
    duo.offlineReason = reason
    duo.offlineAt = rivalNow()

    await saveRivalDuo(duo)

    messages.push(`🔴 Rival Duo offline: **${displayRivalDuoName(duo)}**.`)
  }

  if (!found) {
    return {
      ok: false,
      message: "❌ You are not registered in any Rival Duo."
    }
  }

  return {
    ok: true,
    message: messages.join("\n")
  }
}

async function tickRivalDuoRotation() {
  const duos = await loadAllRivalDuos()

  for (const duo of Object.values(duos)) {
    if (!duo) continue
    if (duo.status !== "online") continue

    await activateRivalDuoId(duo, false)
  }
}
async function changeRivalDuoGameId(discordId, newGameId) {
  discordId = String(discordId)
  newGameId = String(newGameId || "").trim()

  if (!isValidGameId(newGameId)) {
    return {
      ok: false,
      message: "❌ ID must be exactly 16 digits."
    }
  }

  const duo = await getRivalDuoByUser(discordId)

  if (!duo) {
    return {
      ok: false,
      message: "❌ You are not registered in a Rival Duo."
    }
  }

  const member = getRivalDuoMember(duo, discordId)

  if (!member) {
    return {
      ok: false,
      message: "❌ Rival Duo member data was not found."
    }
  }

  const oldGameId = String(member.gameId || "").trim()

  if (oldGameId === newGameId) {
    return {
      ok: true,
      message: `✅ Your Rival Duo ID is already **${newGameId}**.`
    }
  }

if (oldGameId && isValidGameId(oldGameId)) {
  await redis.srem("online:Elite_Four", oldGameId)

  if (typeof redis.hdel === "function") {
    await redis.hdel(RIVAL_DUO_BY_GAMEID_KEY, oldGameId)
  } else {
    const indexes = await redis.hgetall(RIVAL_DUO_BY_GAMEID_KEY)

    if (indexes && typeof indexes === "object") {
      delete indexes[oldGameId]

      await redis.del(RIVAL_DUO_BY_GAMEID_KEY)

      if (Object.keys(indexes).length > 0) {
        await redis.hset(RIVAL_DUO_BY_GAMEID_KEY, indexes)
      }
    }
  }
}

  member.gameId = newGameId
  member.updatedAt = rivalNow()

  duo.members[discordId] = member

  if (String(duo.activeDiscordId || "") === discordId) {
    duo.activeGameId = newGameId
    duo.lastRotationAt = rivalNow()

    if (duo.status === "online") {
      await redis.sadd("online:Elite_Four", newGameId)
    }
  }

  await saveRivalDuo(duo)
  await saveRivalDuoIndexes(duo)

  return {
    ok: true,
    message:
      `🔄 Rival Duo ID updated.\n` +
      `Old ID: ${oldGameId || "None"}\n` +
      `New ID: ${newGameId}`
  }
}
function formatRivalDuoTime(ms) {
  ms = Math.max(0, Number(ms) || 0)

  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function getRivalDuoStatusLabel(duo) {
  const members = getRivalDuoMembers(duo)

  if (members.length < 2) return "⏳ Waiting Partner"

  const bothOnline = members.every(member => {
    return duo.onlineUsers?.[member.discordId] === true
  })

  if (duo.status === "online" && bothOnline && duo.activeGameId) {
    return "🟢 Online"
  }

  if (!bothOnline) {
    return "⏳ Waiting Both Online"
  }

  if (duo.status === "offline") {
    return "🔴 Offline"
  }

  return "⚫ Offline"
}

async function buildRivalDuoListMessage() {
  const duos = await loadAllRivalDuos()
  const list = Object.values(duos).filter(Boolean)

  if (!list.length) {
    return "📭 No Rival Duos registered."
  }

  const rotationMs = RIVAL_DUO_ROTATION_MS

  let msg = "🤝 **Rival Duo List**\n\n"

  let index = 1

  for (const duo of list) {
    const members = getRivalDuoMembers(duo)
    const status = getRivalDuoStatusLabel(duo)

    const activeMember = members.find(m => {
      return String(m.discordId) === String(duo.activeDiscordId)
    })

    const nextMember = members.find(m => {
      return String(m.discordId) !== String(duo.activeDiscordId)
    })

    let elapsedText = "0s"
    let remainingText = "Not active"

    if (duo.status === "online" && duo.activeGameId && duo.lastRotationAt) {
      const elapsed = Date.now() - Number(duo.lastRotationAt || 0)
      const remaining = Math.max(0, rotationMs - elapsed)

      elapsedText = formatRivalDuoTime(elapsed)
      remainingText = formatRivalDuoTime(remaining)
    }

    msg += `**#${index} — ${displayRivalDuoName(duo)}**\n`
    msg += `Status: ${status}\n`

    if (members[0]) {
      const onlineIcon = duo.onlineUsers?.[members[0].discordId] ? "🟢" : "🔴"
      msg += `${onlineIcon} User A: <@${members[0].discordId}> | ID: \`${members[0].gameId}\`\n`
    } else {
      msg += `⚫ User A: Empty\n`
    }

    if (members[1]) {
      const onlineIcon = duo.onlineUsers?.[members[1].discordId] ? "🟢" : "🔴"
      msg += `${onlineIcon} User B: <@${members[1].discordId}> | ID: \`${members[1].gameId}\`\n`
    } else {
      msg += `⚫ User B: Empty\n`
    }

    if (duo.activeGameId) {
      msg += `Active ID: \`${duo.activeGameId}\`\n`
      msg += `Active user: ${activeMember ? `<@${activeMember.discordId}>` : "Unknown"}\n`
      msg += `Active time: **${elapsedText}**\n`
      msg += `Time left: **${remainingText}**\n`
      msg += `Next: ${nextMember ? `<@${nextMember.discordId}> | \`${nextMember.gameId}\`` : "Unknown"}\n`
    } else {
      msg += `Active ID: None\n`
      msg += `Time left: Not active\n`
    }

    msg += "\n"
    index++
  }

  if (msg.length > 1900) {
    msg = msg.slice(0, 1850) + "\n\n⚠️ List truncated because Discord messages have a size limit."
  }

  return msg
}
// ================= GROUP CONFIG =================

const GROUP_CONFIG = {
  Trainer: {
    label: "Trainer"
  },
  Gym_Leader: {
    label: "Gym Leader"
  },
  Elite_Four: {
    label: "Elite Four"
  }
}




// ================= HELPERS =================

function isChampion(interaction) {
  return interaction.member.roles.cache.some(r => r.name === "Champion");
}

function getGroupLabel(group) {
  const labels = {
    Trainer: "Trainer",
    Gym_Leader: "Gym Leader",
    Elite_Four: "Elite Four"
  };
  return labels[group] || group;
}

function buildGroupOptions() {
  return [
    { label: "Trainer", value: "Trainer" },
    { label: "Gym Leader", value: "Gym_Leader" },
    { label: "Elite Four", value: "Elite_Four" }
  ];
}
function normalizeGroupRoleName(roleName) {
  const map = {
    "Trainer": "Trainer",
    "Gym_Leader": "Gym_Leader",
    "Gym Leader": "Gym_Leader",
    "Elite_Four": "Elite_Four",
    "Elite Four": "Elite_Four"
  };

  return map[roleName] || null;
}

function getMemberGroups(member) {
  return member.roles.cache
    .map(role => normalizeGroupRoleName(role.name))
    .filter(Boolean)
    .filter((group, index, arr) => arr.indexOf(group) === index);
}
function normalizeSelectableRoleName(roleName) {
  const normalGroup = normalizeGroupRoleName(roleName)

  if (normalGroup) return normalGroup

  if (roleName === "Rival_Duo" || roleName === "Rival Duo") {
    return "Rival_Duo"
  }

  return null
}

function getMemberSelectableRoles(member) {
  return member.roles.cache
    .map(role => normalizeSelectableRoleName(role.name))
    .filter(Boolean)
    .filter((group, index, arr) => arr.indexOf(group) === index)
}

function getSelectableRoleLabel(group) {
  if (group === "Rival_Duo") return "Rival Duo"
  return getGroupLabel(group)
}
function isValidId(id) {
  return /^\d{16}$/.test(String(id).trim())
}

async function getActiveRoles() {
  try {
    const data = await redis.hgetall(activeRolesKey())

    if (!data || typeof data !== "object") {
      return {}
    }

    return data
  } catch (err) {
    console.error("Error loading active roles from Redis:", err)
    return {}
  }
}

async function saveActiveRoles(data) {
  try {
    if (!data || typeof data !== "object") return

    await redis.del(activeRolesKey())

    if (Object.keys(data).length > 0) {
      await redis.hset(activeRolesKey(), data)
    }
  } catch (err) {
    console.error("Error saving active roles to Redis:", err)
  }
}


async function loadSchedules() {
  try {
    const data = await redis.get(schedulesKey())
    return safeJsonParse(data, {})
  } catch (err) {
    console.error("Error loading schedules from Redis:", err)
    return {}
  }
}

async function saveSchedules(data) {
  try {
    await redis.set(schedulesKey(), JSON.stringify(data || {}))
  } catch (err) {
    console.error("Error saving schedules to Redis:", err)
  }
}

async function getUsers(group) {
  try {
    if (!GROUP_CONFIG[group]) {
      console.error("getUsers invalid group:", group)
      return {}
    }

    const data = await redis.hgetall(usersKey(group))

    if (!data || typeof data !== "object") {
      return {}
    }

    const users = {}

    for (const uid in data) {
      users[uid] = safeJsonParse(data[uid], {})
    }

    return users
  } catch (err) {
    console.error(`Error loading users from Redis for ${group}:`, err)
    return {}
  }
}

async function saveUsers(users, group) {
  try {
    if (!GROUP_CONFIG[group]) {
      console.error("saveUsers invalid group:", group)
      return false
    }

    const key = usersKey(group)

    await redis.del(key)

    const payload = {}

    for (const uid in users) {
      payload[uid] = JSON.stringify(users[uid])
    }

    if (Object.keys(payload).length > 0) {
      await redis.hset(key, payload)
    }

    return true
  } catch (err) {
    console.error(`Error saving users to Redis for ${group}:`, err)
    return false
  }
}

async function setOnlineStatus(action, id, group) {
  try {
    id = String(id || "").trim()

    if (!["online", "offline"].includes(action)) {
      console.error("Invalid action:", action)
      return false
    }

    if (!isValidId(id)) {
      console.error("Invalid ID:", id)
      return false
    }

    if (!GROUP_CONFIG[group]) {
      console.error("Invalid group:", group)
      return false
    }

    const key = onlineKey(group)

    if (action === "online") {
      await redis.sadd(key, id)
    }

    if (action === "offline") {
      await redis.srem(key, id)
    }

    return true
  } catch (err) {
    console.error(`setOnlineStatus ${action} error:`, err)
    return false
  }
}

async function getOnlineIDs(group) {
  if (!GROUP_CONFIG[group]) return []

  try {
    const ids = await redis.smembers(onlineKey(group))
    return normalizeRedisIds(ids)
  } catch (err) {
    console.error(`getOnlineIDs Redis error for ${group}:`, err)
    return []
  }
}

async function addVipID(id, group) {
  try {
    id = String(id || "").trim()

    if (!isValidId(id)) {
      console.error("Invalid VIP ID:", id)
      return false
    }

    if (!GROUP_CONFIG[group]) {
      console.error("Invalid VIP group:", group)
      return false
    }

    await redis.sadd(vipKey(group), id)

    console.log(`✅ VIP added to Redis ${group}:`, id)
    return true
  } catch (err) {
    console.error("Error saving VIP to Redis:", err)
    return false
  }
}

// ===== GROUP =====
async function getUserGroup(interaction) {
  const activeRoles = await getActiveRoles();

  const memberGroups = getMemberGroups(interaction.member);

  if (!memberGroups.length) return null;

  const savedRole = activeRoles[interaction.user.id];

  if (savedRole && memberGroups.includes(savedRole)) {
    return savedRole;
  }

  return memberGroups[0];
}
async function isActiveRivalDuo(interaction) {
  const activeRoles = await getActiveRoles()
  const selected = activeRoles[interaction.user.id]

  const hasRivalDuoRole = interaction.member.roles.cache.some(role =>
    role.name === "Rival_Duo" || role.name === "Rival Duo"
  )

  return hasRivalDuoRole && selected === "Rival_Duo"
}
/// panel
async function loadPanelData() {
  try {
    const data = await redis.get(panelDataKey())
    return safeJsonParse(data, {})
  } catch (err) {
    console.error("Error loading panel data from Redis:", err)
    return {}
  }
}

async function savePanelData(data) {
  try {
    await redis.set(panelDataKey(), JSON.stringify(data || {}))
  } catch (err) {
    console.error("Error saving panel data to Redis:", err)
  }
}


// ================= SCHEDULER =================

function startScheduler(){
  setInterval(async () => {
    try {
      const schedules = await loadSchedules()
      const now = new Date()

      const hour = now.getUTCHours()
      const min = now.getUTCMinutes()
      const todayUTC = now.toISOString().slice(0, 10)

      let changed = false

      for (const uid in schedules) {
        const s = schedules[uid]

        if (!s.group || !s.main_id) continue

        if (
          hour === s.online_hour &&
          min === s.online_minute &&
          s.last_online !== todayUTC
        ) {
          const ok = await setOnlineStatus("online", s.main_id, s.group)

          if (ok) {
            s.last_online = todayUTC
            changed = true
            console.log("🟢 Scheduled online:", s.main_id, s.group)
          }
        }

        if (
          hour === s.offline_hour &&
          min === s.offline_minute &&
          s.last_offline !== todayUTC
        ) {
          const ok = await setOnlineStatus("offline", s.main_id, s.group)

          if (ok) {
            s.last_offline = todayUTC
            changed = true
            console.log("🔴 Scheduled offline:", s.main_id, s.group)
          }
        }
      }

      if (changed) await saveSchedules(schedules)

    } catch (err) {
      console.error("Scheduler error:", err)
    }
  }, 60000)
}

// ================= PANEL =================

async function sendPanel(channel){

  const panelData = await loadPanelData()

  const embed = new EmbedBuilder()
    .setTitle("🎮 PANEL CONTROL")
   // .setDescription("Usa botones para controlar todo")

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("register").setLabel("Register").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("add_sec").setLabel("Add Sec").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("change").setLabel("Change").setStyle(ButtonStyle.Secondary)
  )

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("online").setLabel("Online").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("offline").setLabel("Offline").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("online_sec").setLabel("Online Sec").setStyle(ButtonStyle.Success)
  )

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("list").setLabel("List").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("online_list").setLabel("Online List").setStyle(ButtonStyle.Secondary)
  )

  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("schedule").setLabel("Schedule").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("change_role").setLabel("Change Role").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("set_offline").setLabel("Force Offline").setStyle(ButtonStyle.Danger)
  )

const row5 = new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId("gp").setLabel("Add VIP").setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId("heartbeat_name").setLabel("Heartbeat Name").setStyle(ButtonStyle.Secondary),
  new ButtonBuilder().setCustomId("register_duo").setLabel("Register Duo").setStyle(ButtonStyle.Primary),
  new ButtonBuilder().setCustomId("duo_list").setLabel("Duo List").setStyle(ButtonStyle.Secondary)
)
  const panelPayload = {
    embeds:[embed],
    components:[row1,row2,row3,row4,row5]
  }

  try {

    // 🔁 SI YA EXISTE → EDITAR
    if(panelData.messageId){
      const msg = await channel.messages.fetch(panelData.messageId)
      await msg.edit(panelPayload)
      console.log("♻️ Panel actualizado")
      return
    }

  } catch(err){
    console.log("Panel anterior no encontrado, creando nuevo...")
  }

  // 🆕 SI NO EXISTE → CREAR NUEVO
  const newMsg = await channel.send(panelPayload)

  panelData.messageId = newMsg.id
  await savePanelData(panelData)

  console.log("✅ Panel creado y guardado")
}

// ================= READY =================

client.once("clientReady", async () => {
  try {
    console.log("🔥 Bot listo")

    const ch = await client.channels.fetch(PANEL_CHANNEL_ID)
    await sendPanel(ch)

    startScheduler()

    setInterval(async () => {
      try {
        await tickRivalDuoRotation()
      } catch (err) {
        console.error("Rival Duo rotation error:", err)
      }
   // }, 10 * 1000)
     }, 60 * 1000)

    await gpHandler(client)
  } catch (err) {
    console.error("Ready error:", err)
  }
})

//const { MessageFlags } = require("discord.js");

const OWN_BUTTONS = new Set([
  "register",
  "add_sec",
  "change",
  "online",
  "offline",
  "online_sec",
  "list",
  "online_list",
  "schedule",
  "change_role",
  "set_offline",
  "gp",
  "heartbeat_name",
  "register_duo",
"duo_list"
]);

const OWN_MODALS = new Set([
  "reg_modal",
  "sec_modal",
  "change_modal",
  "schedule_modal",
  "gp_modal",
  "heartbeat_modal",
  "rival_duo_register_modal"
]);
const OWN_SELECTS = new Set([
  "role_select",
  "offline_group_select",
  "forced_offline_user_select",
  "gp_group_select"
]);

function isOwnInteraction(interaction) {
  if (interaction.isButton()) {
    return OWN_BUTTONS.has(interaction.customId)
  }

  if (interaction.isModalSubmit()) {
    return OWN_MODALS.has(interaction.customId)
  }

if (interaction.isStringSelectMenu()) {
  return (
    OWN_SELECTS.has(interaction.customId) || interaction.customId.startsWith("gp_group_select:") || interaction.customId.startsWith("rival_duo_select_")
  )
}

  return false
}

// ================= INTERACTIONS =================
client.on("interactionCreate", async interaction => {
  try {
    if (!isOwnInteraction(interaction)) return

    if (interaction.deferred || interaction.replied) {
      console.warn(
        "Interaction already acknowledged before index handler:",
        interaction.customId,
        interaction.user.id
      )
      return
    }

    // ================= BOTONES =================
if (interaction.isButton()) {

  if (interaction.customId === "register_duo") {
    const hasRole = interaction.member.roles.cache.some(r => r.name === "Rival_Duo")

    if (!hasRole) {
      return interaction.reply({
        content: "❌ You need the Rival_Duo role to register here.",
        flags: MessageFlags.Ephemeral
      })
    }

    const modal = new ModalBuilder()
      .setCustomId("rival_duo_register_modal")
      .setTitle("Register Rival Duo")

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("game_id")
          .setLabel("Your 16 digit game ID")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("heartbeat_name")
          .setLabel("Your exact heartbeat name")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      )
    )

    return interaction.showModal(modal)
  }

  if (interaction.customId === "duo_list") {
  const hasRole =
    interaction.member.roles.cache.some(r => r.name === "Rival_Duo") ||
    interaction.member.roles.cache.some(r => r.name === "Champion")

  if (!hasRole) {
    return interaction.reply({
      content: "❌ You need the Rival_Duo or Champion role to use this.",
      flags: MessageFlags.Ephemeral
    })
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const message = await buildRivalDuoListMessage()

  return interaction.editReply(message)
}

  const modalButtonIds = ["register", "add_sec", "change", "schedule", "gp", "heartbeat_name"]
const willOpenModal = modalButtonIds.includes(interaction.customId)

if (!willOpenModal && !interaction.deferred && !interaction.replied) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
}
if (interaction.customId === "change" && await isActiveRivalDuo(interaction)) {
  const modal = new ModalBuilder()
    .setCustomId("change_modal")
    .setTitle("Change Rival Duo ID")

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("id")
        .setLabel("New 16 digit ID")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    )
  )

  return interaction.showModal(modal)
}
const isRivalDuoButton = ["online", "offline"].includes(interaction.customId) &&
  await isActiveRivalDuo(interaction)

if (isRivalDuoButton) {
  try {
    if (interaction.customId === "online") {
      const result = await setRivalDuoOnline(interaction.user.id)

      return interaction.editReply(
        result?.message || "❌ Rival Duo online failed without response."
      )
    }

    if (interaction.customId === "offline") {
      const result = await setRivalDuoOffline(interaction.user.id, "manual_offline")

      return interaction.editReply(
        result?.message || "❌ Rival Duo offline failed without response."
      )
    }
  } catch (err) {
    console.error("RIVAL DUO BUTTON ERROR:", err)

    return interaction.editReply(
      `❌ Rival Duo error: ${err.message || "Unknown error"}`
    )
  }
}

  const group = await getUserGroup(interaction)
  if (!group) {
    return interaction.reply({
      content: "❌ No group",
      flags: MessageFlags.Ephemeral
    })
  }

const isModalButton = modalButtonIds.includes(interaction.customId)

if (!isModalButton && !interaction.deferred && !interaction.replied) {
  console.log("Index handling button:", interaction.customId, "user:", interaction.user.id)
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
}

      const config = GROUP_CONFIG[group]


      if (interaction.customId === "register") {
        const modal = new ModalBuilder()
          .setCustomId("reg_modal")
          .setTitle("Register ID")

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("id")
              .setLabel("16 digit ID")
              .setStyle(TextInputStyle.Short)
          )
        )

        return interaction.showModal(modal)
      }

      if (interaction.customId === "add_sec") {
        const modal = new ModalBuilder()
          .setCustomId("sec_modal")
          .setTitle("Add Secondary ID")

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("id")
              .setLabel("16 digit ID")
              .setStyle(TextInputStyle.Short)
          )
        )

        return interaction.showModal(modal)
      }

      if (interaction.customId === "change") {
        const modal = new ModalBuilder()
          .setCustomId("change_modal")
          .setTitle("Change Main ID")

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("id")
              .setLabel("New 16 digit ID")
              .setStyle(TextInputStyle.Short)
          )
        )

        return interaction.showModal(modal)
      }
      if (interaction.customId === "heartbeat_name") {
  const modal = new ModalBuilder()
    .setCustomId("heartbeat_modal")
    .setTitle("Heartbeat Name")

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("name")
        .setLabel("Exact name shown in heartbeat")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    )
  )

  return interaction.showModal(modal)
}

if (interaction.customId === "online") {

  const users = await getUsers(group)
  const userData = users[interaction.user.id]

  if (!userData?.main_id) return interaction.editReply("❌ Register first")

  const ok = await setOnlineStatus("online", userData.main_id, group)

  if (!ok) {
    return interaction.editReply("❌ Could not set online")
  }

  return interaction.editReply("🟢 ONLINE. It now appears in Online List.")
}

      if (interaction.customId === "online_sec") {
        const users = await getUsers(group)
        const userData = users[interaction.user.id]

        if (!userData?.sec_id) return interaction.editReply("❌ No secondary ID")

const ok = await setOnlineStatus("online", userData.sec_id, group)

if (!ok) {
  return interaction.editReply("❌ Could not set secondary online")
}

return interaction.editReply("🟢 SEC ONLINE. It now appears in Online List.")
      }

if (interaction.customId === "offline") {

  const users = await getUsers(group)
  const userData = users[interaction.user.id]

  if (!userData) return interaction.editReply("❌ Not registered")

  let okMain = true
  let okSec = true

  if (userData.main_id) {
    okMain = await setOnlineStatus("offline", userData.main_id, group)
  }

  if (userData.sec_id) {
    okSec = await setOnlineStatus("offline", userData.sec_id, group)
  }

  if (!okMain || !okSec) {
    return interaction.editReply("❌ Some IDs could not be set offline")
  }

  return interaction.editReply("🔴 OFFLINE")
}

      if (interaction.customId === "list") {
        const users = await getUsers(group)

        if (Object.keys(users).length === 0) {
          return interaction.editReply("📭 No users")
        }

        let msg = "📋 Users:\n\n"

        for (const uid in users) {
          const u = users[uid]
          msg += `👤 ${u.name} | 📡 ${u.heartbeatName || u.name} → ${u.main_id}\n`
        }

        return interaction.editReply(msg)
      }

if (interaction.customId === "online_list") {
  const users = await getUsers(group)
  const ids = await getOnlineIDs(group)

  if (!ids.length) return interaction.editReply("⚫ No online")

  let msg = "🟢 Online:\n\n"
  let found = false

  for (const uid in users) {
    const u = users[uid]

    const mainId = String(u.main_id || "").trim()
    const secId = String(u.sec_id || "").trim()

    const mainOnline = mainId && ids.includes(mainId)
    const secOnline = secId && ids.includes(secId)

    if (mainOnline || secOnline) {
      const shownIds = []

      if (mainOnline) shownIds.push(`Main: ${mainId}`)
      if (secOnline) shownIds.push(`Sec: ${secId}`)

      msg += `👤 ${u.name} | 📡 ${u.heartbeatName || u.name} → ${shownIds.join(" | ")}\n`
      found = true
    }
  }

  const rivalDuos = await loadAllRivalDuos()

for (const duo of Object.values(rivalDuos)) {
  if (!duo) continue

  const members = getRivalDuoMembers(duo)

  for (const member of members) {
    const gameId = String(member.gameId || "").trim()

    if (!gameId) continue
    if (!ids.includes(gameId)) continue

    msg += `🤝 ${member.name || "Unknown"} | 📡 ${member.heartbeatName || member.name || "Unknown"} → Rival Duo: ${gameId}\n`

    found = true
  }
}

  if (!found) msg += "⚫ No registered users online\n"

  return interaction.editReply(msg)
}

      if (interaction.customId === "schedule") {
        const modal = new ModalBuilder()
          .setCustomId("schedule_modal")
          .setTitle("Schedule UTC")

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("on")
              .setLabel("Online HH:MM")
              .setStyle(TextInputStyle.Short)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("off")
              .setLabel("Offline HH:MM")
              .setStyle(TextInputStyle.Short)
          )
        )

        return interaction.showModal(modal)
      }

if (interaction.customId === "change_role") {
  const memberGroups = getMemberSelectableRoles(interaction.member)

  if (memberGroups.length < 2) {
    return interaction.editReply("❌ You need at least 2 group roles to switch.")
  }

  const activeRoles = await getActiveRoles()
  const currentRole = activeRoles[interaction.user.id] || await getUserGroup(interaction)

  const roles = memberGroups.map(group => ({
    label: getSelectableRoleLabel(group),
    value: group
  }))

  const menu = new StringSelectMenuBuilder()
    .setCustomId("role_select")
    .setPlaceholder("Select your active role")
    .addOptions(roles)

  return interaction.editReply({
    content: `Current active role: **${getSelectableRoleLabel(currentRole)}**\nSelect your new active role:`,
    components: [new ActionRowBuilder().addComponents(menu)]
  })
}

      if (interaction.customId === "set_offline") {
        if (!isChampion(interaction)) {
          return interaction.editReply("❌ Only Champion can use this button")
        }

        const menu = new StringSelectMenuBuilder()
          .setCustomId("offline_group_select")
          .setPlaceholder("Select group")
          .addOptions(buildGroupOptions())

        return interaction.editReply({
          content: "Select the group where you want to force offline",
          components: [new ActionRowBuilder().addComponents(menu)]
        })
      }

      if (interaction.customId === "gp") {
        if (!isChampion(interaction)) {
          return interaction.reply({
            content: "❌ Only Champion can use this button",
            flags: MessageFlags.Ephemeral
          })
        }

        const modal = new ModalBuilder()
          .setCustomId("gp_modal")
          .setTitle("Add VIP")

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("id")
              .setLabel("VIP ID")
              .setStyle(TextInputStyle.Short)
          )
        )

        return interaction.showModal(modal)
      }
    }

    // ================= MODALES =================
    if (interaction.isModalSubmit()) {

      if (interaction.customId === "rival_duo_register_modal") {
  const hasRole = interaction.member.roles.cache.some(r => r.name === "Rival_Duo")

  if (!hasRole) {
    return interaction.reply({
      content: "❌ You need the Rival_Duo role to register here.",
      flags: MessageFlags.Ephemeral
    })
  }

  const gameId = interaction.fields.getTextInputValue("game_id").trim()
  const heartbeatName = interaction.fields.getTextInputValue("heartbeat_name").trim()

  if (!isValidGameId(gameId)) {
    return interaction.reply({
      content: "❌ The ID must be exactly 16 digits.",
      flags: MessageFlags.Ephemeral
    })
  }

  const pending = {
    discordId: interaction.user.id,
    name: interaction.member?.displayName || interaction.user.username,
    heartbeatName,
    gameId
  }

  await savePendingRivalDuoRegistration(interaction.user.id, pending)

  const openDuos = await findOpenRivalDuos()

 if (!openDuos.length) {
  const result = await registerRivalDuoMember(pending)

  if (result.ok) {
    await redis.hset(activeRolesKey(), {
      [interaction.user.id]: "Rival_Duo"
    })
  }

  return interaction.reply({
    content: result.message,
    flags: MessageFlags.Ephemeral
  })
}

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`rival_duo_select_${interaction.user.id}`)
    .setPlaceholder("Select open Duo or create new")
    .addOptions([
      {
        label: "Create new Rival Duo",
        value: "create_new"
      },
      ...openDuos.slice(0, 24).map(duo => ({
        label: displayRivalDuoName(duo).slice(0, 100),
        value: duo.id
      }))
    ])

  return interaction.reply({
    content: "There are open Rival Duo registrations. Select one or create a new Duo.",
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: MessageFlags.Ephemeral
  })
}

if (interaction.customId === "change_modal") {
  if (await isActiveRivalDuo(interaction)) {
    const id = interaction.fields.getTextInputValue("id").trim()

    if (!isValidId(id)) {
      return interaction.reply({
        content: "❌ ID must be exactly 16 digits",
        flags: MessageFlags.Ephemeral
      })
    }

    const result = await changeRivalDuoGameId(interaction.user.id, id)

    return interaction.reply({
      content: result.message,
      flags: MessageFlags.Ephemeral
    })
  }
}

      const config = GROUP_CONFIG[group]
      const users = await getUsers(group)

      if (interaction.customId === "reg_modal") {
        const id = interaction.fields.getTextInputValue("id").trim()

        if (!isValidId(id)) {
          return interaction.reply({
            content: "❌ ID must be exactly 16 digits",
            flags: MessageFlags.Ephemeral
          })
        }

const oldData = users[interaction.user.id] || {}

users[interaction.user.id] = buildUserData(oldData, interaction, {
  main_id: id,
  sec_id: oldData.sec_id || null
})

await saveUsers(users, group)
        return interaction.reply({
          content:
  `✅ Registered\n` +
  `👤 Display name: **${users[interaction.user.id].name}**\n` +
  `📡 Heartbeat name: **${users[interaction.user.id].heartbeatName}**`,
          flags: MessageFlags.Ephemeral
        })
      }

      if (interaction.customId === "sec_modal") {
        const id = interaction.fields.getTextInputValue("id").trim()

        if (!isValidId(id)) {
          return interaction.reply({
            content: "❌ ID must be exactly 16 digits",
            flags: MessageFlags.Ephemeral
          })
        }

        if (!users[interaction.user.id]) {
          return interaction.reply({
            content: "❌ Register first",
            flags: MessageFlags.Ephemeral
          })
        }

users[interaction.user.id] = buildUserData(users[interaction.user.id], interaction, {
  sec_id: id
})

await saveUsers(users, group)
        return interaction.reply({
          content: "✅ Secondary added",
          flags: MessageFlags.Ephemeral
        })
      }

if (interaction.customId === "change_modal") {
  const id = interaction.fields.getTextInputValue("id").trim()

  if (!isValidId(id)) {
    return interaction.reply({
      content: "❌ ID must be exactly 16 digits",
      flags: MessageFlags.Ephemeral
    })
  }


  if (!users[interaction.user.id]) {
    return interaction.reply({
      content: "❌ Register first",
      flags: MessageFlags.Ephemeral
    })
  }

  const oldMainId = users[interaction.user.id].main_id

  if (oldMainId && oldMainId !== id) {
    await setOnlineStatus("offline", oldMainId, group)
  }

  users[interaction.user.id] = buildUserData(users[interaction.user.id], interaction, {
    main_id: id
  })

  await saveUsers(users, group)

  return interaction.reply({
    content: "🔄 Updated",
    flags: MessageFlags.Ephemeral
  })
}

      if (interaction.customId === "heartbeat_modal") {
  const heartbeatName = interaction.fields.getTextInputValue("name").trim()

  if (!heartbeatName) {
    return interaction.reply({
      content: "❌ Invalid heartbeat name.",
      flags: MessageFlags.Ephemeral
    })
  }

  const oldData = users[interaction.user.id]

  if (!oldData?.main_id) {
    return interaction.reply({
      content: "❌ Register first.",
      flags: MessageFlags.Ephemeral
    })
  }

  users[interaction.user.id] = buildUserData(oldData, interaction, {
    heartbeatName,
    aliases: uniqueList([
      ...(Array.isArray(oldData.aliases) ? oldData.aliases : []),
      oldData.name,
      oldData.heartbeatName,
      heartbeatName
    ])
  })

  await saveUsers(users, group)

  return interaction.reply({
    content:
      `✅ Heartbeat name updated.\n` +
      `👤 Display name: **${users[interaction.user.id].name}**\n` +
      `📡 Heartbeat name: **${users[interaction.user.id].heartbeatName}**`,
    flags: MessageFlags.Ephemeral
  })
}

      if (interaction.customId === "schedule_modal") {
        const onRaw = interaction.fields.getTextInputValue("on").trim()
        const offRaw = interaction.fields.getTextInputValue("off").trim()

        if (!/^\d{1,2}:\d{2}$/.test(onRaw) || !/^\d{1,2}:\d{2}$/.test(offRaw)) {
          return interaction.reply({
            content: "❌ Use HH:MM format",
            flags: MessageFlags.Ephemeral
          })
        }

        const [onHour, onMinute] = onRaw.split(":").map(Number)
        const [offHour, offMinute] = offRaw.split(":").map(Number)

        if (
          onHour < 0 || onHour > 23 ||
          offHour < 0 || offHour > 23 ||
          onMinute < 0 || onMinute > 59 ||
          offMinute < 0 || offMinute > 59
        ) {
          return interaction.reply({
            content: "❌ Invalid UTC time",
            flags: MessageFlags.Ephemeral
          })
        }

        if (!users[interaction.user.id]?.main_id) {
          return interaction.reply({
            content: "❌ Register first",
            flags: MessageFlags.Ephemeral
          })
        }

        const schedules = await loadSchedules()

        schedules[interaction.user.id] = {
          group,
          main_id: users[interaction.user.id].main_id,
          online_hour: onHour,
          online_minute: onMinute,
          offline_hour: offHour,
          offline_minute: offMinute
        }

        await saveSchedules(schedules)

        return interaction.reply({
          content: "✅ Schedule saved",
          flags: MessageFlags.Ephemeral
        })
      }

     if (interaction.customId === "gp_modal") {
  if (!isChampion(interaction)) {
    return interaction.reply({
      content: "❌ Only Champion can use this function",
      flags: MessageFlags.Ephemeral
    })
  }

  const id = interaction.fields.getTextInputValue("id").trim()

  if (!isValidId(id)) {
    return interaction.reply({
      content: "❌ ID must be exactly 16 digits",
      flags: MessageFlags.Ephemeral
    })
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`gp_group_select:${id}`)
    .setPlaceholder("Select group")
    .addOptions(buildGroupOptions())

  return interaction.reply({
    content: `Select the group where you want to add VIP ID ${id}`,
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: MessageFlags.Ephemeral
  })
}
    }

    // ================= SELECT MENUS =================
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith("rival_duo_select_")) {
  const targetUserId = interaction.customId.replace("rival_duo_select_", "")

  if (interaction.user.id !== targetUserId) {
    return interaction.reply({
      content: "❌ This menu is not for you.",
      flags: MessageFlags.Ephemeral
    })
  }

  const pending = await loadPendingRivalDuoRegistration(interaction.user.id)

  if (!pending) {
    return interaction.update({
      content: "❌ Registration expired. Press Register Duo again.",
      components: []
    })
  }

  const selected = interaction.values[0]

const result = await registerRivalDuoMember({
  ...pending,
  duoId: selected === "create_new" ? null : selected
})

if (result.ok) {
  await redis.hset(activeRolesKey(), {
    [interaction.user.id]: "Rival_Duo"
  })
}

await clearPendingRivalDuoRegistration(interaction.user.id)

return interaction.update({
  content: result.message,
  components: []
})
}
      if (interaction.customId.startsWith("gp_group_select:")) {
        if (!isChampion(interaction)) {
          return interaction.update({
            content: "❌ Only Champion can use this function",
            components: []
          })
        }

        const id = interaction.customId.split(":")[1]
        const group = interaction.values[0]

        await addVipID(id, group)

        return interaction.update({
          content: `✅ VIP ID added to ${getGroupLabel(group)}`,
          components: []
        })
      }

      if (interaction.customId === "offline_group_select") {
        if (!isChampion(interaction)) {
          return interaction.update({
            content: "❌ Only Champion can use this function",
            components: []
          })
        }

        const group = interaction.values[0]
        const config = GROUP_CONFIG[group]

        const ids = await getOnlineIDs(group)
        const users = await getUsers(group)

        if (!ids.length) {
          return interaction.update({
            content: `⚫ No users online in ${getGroupLabel(group)}`,
            components: []
          })
        }

        const onlineOptions = []

        for (const uid in users) {
          const u = users[uid]
          const matchedId = ids.find(id => id === u.main_id || id === u.sec_id)

          if (matchedId) {
            onlineOptions.push({
              label: u.name || `User ${uid}`,
              value: `${group}|${matchedId}`,
              description: matchedId === u.main_id ? "Main ID online" : "Secondary ID online"
            })
          }
        }

        if (!onlineOptions.length) {
          const fallbackOptions = ids.slice(0, 25).map(id => ({
            label: id,
            value: `${group}|${id}`
          }))

          const fallbackMenu = new StringSelectMenuBuilder()
            .setCustomId("forced_offline_user_select")
            .setPlaceholder("Select online user")
            .addOptions(fallbackOptions)

          return interaction.update({
            content: `Online users found in ${getGroupLabel(group)} (fallback by ID)`,
            components: [new ActionRowBuilder().addComponents(fallbackMenu)]
          })
        }

        const menu = new StringSelectMenuBuilder()
          .setCustomId("forced_offline_user_select")
          .setPlaceholder("Select online user")
          .addOptions(onlineOptions.slice(0, 25))

        return interaction.update({
          content: `Select the online user to force offline in ${getGroupLabel(group)}`,
          components: [new ActionRowBuilder().addComponents(menu)]
        })
      }

if (interaction.customId === "forced_offline_user_select") {
  if (!isChampion(interaction)) {
    return interaction.update({
      content: "❌ Only Champion can use this function",
      components: []
    })
  }

  const raw = interaction.values[0]
  const [group, id] = raw.split("|")

  const ok = await setOnlineStatus("offline", id, group)

  if (!ok) {
    return interaction.update({
      content: "❌ Could not force this user offline",
      components: []
    })
  }

  return interaction.update({
    content: `🔴 User forced offline in ${getGroupLabel(group)}`,
    components: []
  })
}

if (interaction.customId === "role_select") {
  const selected = interaction.values[0]

  await redis.hset(activeRolesKey(), {
    [interaction.user.id]: selected
  })

  return interaction.update({
    content: `✅ Active role set to **${getSelectableRoleLabel(selected)}**`,
    components: []
  })
}
    }
  } catch (err) {
    console.error("INDEX interaction error:", err)

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "❌ Internal error",
        flags: MessageFlags.Ephemeral
      }).catch(() => {})
    } else {
      await interaction.followUp({
        content: "❌ Internal error",
        flags: MessageFlags.Ephemeral
      }).catch(() => {})
    }
  }
})


  client.on("error", err => {
  console.error("Discord client error:", err);
});

process.on("unhandledRejection", err => {
  console.error("Unhandled rejection:", err);
});

process.on("uncaughtException", err => {
  console.error("Uncaught exception:", err);
});

// ================= START =================

client.login(TOKEN)
