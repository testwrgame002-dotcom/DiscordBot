const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  REST,
  Routes,
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags
} = require("discord.js");

const fetch = require("node-fetch");
const locks = new Map();

const cache = new Map();


const STATS_CHANNEL_ID = "1484416376436424794"; // Mismo canal para estadísticas

const GIST_ID = process.env.GIST_ID;
const LIVE_GIST_ID = process.env.LIVE_GIST_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const FILE_NAME = "gp_record.txt";


function getCache(key, ttlMs) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.time > ttlMs) return null;
  return item.data;
}

function setCache(key, data) {
  cache.set(key, { time: Date.now(), data });
}


async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} -> ${url}`);
  }
  return res.json();
}

async function fetchText(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} -> ${url}`);
  }
  return res.text();
}

async function updateStatsSafe(group, callback) {
  while (locks.get(group)) {
    await new Promise(res => setTimeout(res, 50));
  }

  locks.set(group, true);

  try {
    let stats = await loadLiveStats(group);

    stats = await callback(stats);

    await saveLiveStats(group, stats);

    return stats;
  } finally {
    locks.set(group, false);
  }
}


// ===== SISTEMA DE MENCIONES ONLINE =====
const USERS_GIST_ID = "bb18eda2ea748723d8fe0131dd740b70"; // tu gist users.json
const IDS_GIST_RAW_URL = "https://gist.githubusercontent.com/WrPages/d9db3a72fed74c496fd6cc830f9ca6e9/raw/elite_ids.txt";

const USERS_GP_GIST_ID = "5131a73fcee46b4a5c7b7faeea16efe9";
const USERS_GP_FILE = "gp_user.json";

// Mapa canal → Gist de usuarios
const CHANNEL_USER_GIST_MAP = {
  "1486277594629275770": "bb18eda2ea748723d8fe0131dd740b70", // Elite Four
  "1487362022864588902": "1c066922bc39ac136b6f234fad6d9420", // Trainer
  "1491238471556403281": "a3f5f3d8a2e6ddf2378fb3481dff49f6"  // Gym Leader
};

// Mapa canal → Gist con IDs online
const CHANNEL_ONLINE_GIST_MAP = {
  "1486277594629275770": "d9db3a72fed74c496fd6cc830f9ca6e9", // Elite Four
  "1487362022864588902": "4edcf4d341cd4f7d5d0fb8a50f8b8c3c", // Trainer
  "1491238471556403281": "e110c37b3e0b8de83a33a1b0a5eb64e8"  // Gym Leader
};


async function loadUsersGP() {
  try {
    const cached = getCache("users_gp", 30000);
    if (cached) return cached;

    const data = await fetchJson(`https://api.github.com/gists/${USERS_GP_GIST_ID}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` }
    });

    //const data = await res.json();

    if (!data.files || !data.files[USERS_GP_FILE]) return {};

    const parsed = JSON.parse(data.files[USERS_GP_FILE].content || "{}");
    setCache("users_gp", parsed);
    return parsed;

  } catch (err) {
    console.error("LOAD USERS GP ERROR:", err);
    return {};
  }
}

async function saveUsersGP(data) {
  try {
    await fetch(`https://api.github.com/gists/${USERS_GP_GIST_ID}`, {
      method: "PATCH",
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        files: {
          [USERS_GP_FILE]: {
            content: JSON.stringify(data, null, 2)
          }
        }
      })
    });

    setCache("users_gp", data);
  } catch (err) {
    console.error("SAVE USERS GP ERROR:", err);
  }
}

async function registerUserGP(message) {
  try {
    const mentionedUsers = message.mentions.users;

    if (!mentionedUsers || mentionedUsers.size === 0) {
      console.log("⚠️ No hay menciones en este GP");
      return;
    }

    let usersGP = await loadUsersGP();

    for (const [id, user] of mentionedUsers) {

      if (!usersGP[id]) {
        usersGP[id] = {
          name: user.username,
          gp: 0
        };
      }

      usersGP[id].gp += 1;

      // actualizar nombre por si cambia
      usersGP[id].name = user.username;

      console.log(`💾 GP SUMADO: ${user.username} -> ${usersGP[id].gp}`);
    }

   await saveUsersGP(usersGP);
//setCache("users_gp", usersGP);

  } catch (err) {
    console.error("REGISTER USER GP ERROR:", err);
  }
}

async function getOnlineMentions(channelId) {
  try {
    const onlineGistId = CHANNEL_ONLINE_GIST_MAP[channelId];
    if (!onlineGistId) return [];

    // IDs que están online
    const text = await fetchText(`https://gist.githubusercontent.com/WrPages/${onlineGistId}/raw`);
 //   const text = await res.text();
    const onlineIDs = text.split("\n").map(x => x.trim()).filter(Boolean);

    const userGistId = CHANNEL_USER_GIST_MAP[channelId];
    if (!userGistId) return [];

    // Traer usuarios del gist
    const userRes = await fetch(`https://api.github.com/gists/${userGistId}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` }
    });
    const userData = await userRes.json();
  const fileKeys = Object.keys(userData.files || {});
if (fileKeys.length === 0) return [];

const users = JSON.parse(userData.files[fileKeys[0]].content);

    // Array de menciones
    const mentions = [];
    for (const discordId in users) {
      const mainId = users[discordId].main_id?.trim();
      const secId = users[discordId].sec_id?.trim();
      if (onlineIDs.includes(mainId) || (secId && onlineIDs.includes(secId))) {
        mentions.push(`<@${discordId}>`);
      }
    }

    return mentions; // devuelve array de menciones
  } catch (err) {
    console.error("GET ONLINE MENTIONS ERROR:", err);
    return [];
  }
}



async function getOnlineIDs() {
  try {
    const text = await fetchText(IDS_GIST_RAW_URL);
 //   const text = await res.text();
    return text.split("\n").map(x => x.trim()).filter(x => x.length > 0);
  } catch {
    return [];
  }
}

async function getUsers() {
  try {
   const data = await fetchJson(
  `https://api.github.com/gists/${USERS_GIST_ID}`,
      {
        headers: { Authorization: `token ${GITHUB_TOKEN}` }
      }
    );

    //const data = await res.json();

    if (!data.files || !data.files["elite_users.json"]) return {};

    return JSON.parse(data.files["elite_users.json"].content || "{}");
  } catch (err) {
    console.error("GET USERS ERROR:", err);
    return {};
  }
}

async function addVipID(id, group) {
  try {
    if (!id || id === "Unknown") {
      console.log("⚠️ VIP no agregado: friendId inválido");
      return false;
    }

    const config = GROUP_CONFIG[group];
    if (!config || !config.VIP_GIST_ID || !config.VIP_FILENAME) {
      console.log("⚠️ VIP config faltante para grupo:", group);
      return false;
    }

    const res = await fetch(`https://api.github.com/gists/${config.VIP_GIST_ID}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` }
    });

    if (!res.ok) {
      throw new Error(`VIP gist fetch failed: ${res.status}`);
    }

    const data = await res.json();

    let content = data.files?.[config.VIP_FILENAME]?.content || "";
    let ids = content
      .split("\n")
      .map(x => x.trim())
      .filter(Boolean);

    if (ids.includes(id)) {
      console.log(`ℹ️ VIP ya existe en ${group}: ${id}`);
      return false;
    }

    ids.push(id);

    const patchRes = await fetch(`https://api.github.com/gists/${config.VIP_GIST_ID}`, {
      method: "PATCH",
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        files: {
          [config.VIP_FILENAME]: {
            content: ids.join("\n")
          }
        }
      })
    });

    if (!patchRes.ok) {
      throw new Error(`VIP gist patch failed: ${patchRes.status}`);
    }

    console.log(`✅ VIP agregado en ${group}: ${id}`);
    return true;
  } catch (err) {
    console.error("ADD VIP ERROR:", err);
    return false;
  }
}


const ALLOWED_CHANNELS = [
  "1486277594629275770", // canal 1
  "1491238471556403281",
  "1487362022864588902"// canal 2

   // canal 3
];
const CHANNEL_GROUP_MAP = {
  "1486277594629275770": "Elite_Four",
  "1487362022864588902": "Trainer",
  "1491238471556403281": "Gym_Leader"
};
const GROUP_CONFIG = {
  Trainer: {
    LIVE_GIST_ID: "4f35f34b50e142fd4c89ff7bb8e30190",
    LIVE_FILE: "trainer_gp_live_stats.json",
    VIP_GIST_ID: "16541fd83785a49ad4a0f22bbeb06000",
    VIP_FILENAME: "trainer_vip.txt"
  },
  Gym_Leader: {
    LIVE_GIST_ID: "931b1284bc6abffc6681f733ac4361ff",
    LIVE_FILE: "gym_gp_live_stats.json",
    VIP_GIST_ID: "79a0e30c401cfd63e78d9ec5a9210091",
    VIP_FILENAME: "gym_vip.txt"
  },
  Elite_Four: {
    LIVE_GIST_ID: "4773653072f4851e91958a333e503de9",
    LIVE_FILE: "gp_live_stats.json",
    VIP_GIST_ID: "5f2f23e0391882ab4e255bd67e98334a",
    VIP_FILENAME: "elite_vip.txt"
  }
};



// ===== LIVE GP STATS =====
//const LIVE_STATS_FILE = "gp_live_stats.json";


function getUTC6DateString() {
  const now = new Date();
  const utc6 = new Date(now.getTime() - (6 * 60 * 60 * 1000));
  return utc6.toISOString().split("T")[0];
}






let statsData = {
  currentDay: new Date().toDateString(),
  todayCount: 0,
  lastFiveDays: [],
  statsMessageId: null
};

async function saveData() {
  try {
    await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: "PATCH",
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        files: {
          [FILE_NAME]: {
            content: JSON.stringify(statsData, null, 2)
          }
        }
      })
    });
  } catch (err) {
    console.error("SAVE GIST ERROR:", err);
  }
}

async function loadData() {
  try {
    const data = await fetchJson(`https://api.github.com/gists/${GIST_ID}`);
    //const data = await res.json();
    const content = data.files[FILE_NAME].content;
    statsData = JSON.parse(content);
  } catch (err) {
    console.error("LOAD GIST ERROR:", err);
  }
}
//cambia alive o desd hilos
async function updateThreadName(message, status, rarity, packNumber, username) {
  try {
    if (!message.hasThread) return;

    const thread = await message.thread.fetch();

    // 🔥 Extraer friendId del nombre actual del hilo
    const currentName = thread.name;

    let friendIdMatch = currentName.match(/\[(\d{16})P?\]/);
    let friendId = friendIdMatch ? friendIdMatch[1] : "";

    let emoji = "⚪";
    if (status === "alive") emoji = "✅";
    if (status === "dead") emoji = "❌";

    const name =
    `${emoji} [${rarity}/5][${packNumber}P] [${username}] [${friendId}]`
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 90);

    await thread.setName(name);

  } catch (err) {
    console.error("THREAD NAME ERROR:", err);
  }
}

// termina

// ===== CARGAR LIVE STATS =====
async function loadLiveStats(group) {
  try {
    const config = GROUP_CONFIG[group];
    if (!config) return null;

    const data = await fetchJson(`https://api.github.com/gists/${config.LIVE_GIST_ID}`);
    //const data = await res.json();

    if (!data.files[config.LIVE_FILE]) {
      return {
        totalGP: 0,
        totalAlive: 0,
        currentDay: null,
        daily: { gp: 0, alive: 0 },
        history: []
      };
    }

    return JSON.parse(data.files[config.LIVE_FILE].content);

  } catch (err) {
    console.error("LOAD LIVE STATS ERROR:", err);
    return null;
  }
}
// ===== GUARDAR LIVE STATS =====
async function saveLiveStats(group, stats) {
  try {
    const config = GROUP_CONFIG[group];
    if (!config) return;
  await new Promise(res => setTimeout(res, 200));
    await fetch(`https://api.github.com/gists/${config.LIVE_GIST_ID}`, {
      method: "PATCH",
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        files: {
          [config.LIVE_FILE]: {
            content: JSON.stringify(stats, null, 2)
          }
        }
      })
    });

  } catch (err) {
    console.error("SAVE LIVE STATS ERROR:", err);
  }
}


// ===== RESET DIARIO UTC-6 =====
async function checkDailyReset(group, stats) {
  const today = getUTC6DateString();

  if (!stats.currentDay) {
    stats.currentDay = today;
    return stats;
  }

  if (today !== stats.currentDay) {

    stats.history.unshift({
      date: stats.currentDay,
      gp: stats.daily.gp,
      alive: stats.daily.alive
    });

    stats.history = stats.history.slice(0, 5);

    stats.currentDay = today;
    stats.daily = { gp: 0, alive: 0 };

  //  await saveLiveStats(group, stats);
  }

  return stats;
}



async function updateStats(client) {
  const channel = await client.channels.fetch(STATS_CHANNEL_ID);
  if (!channel) return;

  const now = new Date();
  const today = now.toDateString();

  if (today !== statsData.currentDay) {
    statsData.lastFiveDays.unshift({
      day: statsData.currentDay,
      count: statsData.todayCount
    });
    statsData.lastFiveDays = statsData.lastFiveDays.slice(0, 5);
    statsData.currentDay = today;
    statsData.todayCount = 0;
    await saveData();
  }

  const historyText =
    statsData.lastFiveDays.length > 0
      ? statsData.lastFiveDays.map(d => `▫️ **${d.day}**: ${d.count} GP`).join("\n")
      : "No previous records";

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("📊 GP Statistics")
    .addFields(
      { name: "✨ GP Today", value: `${statsData.todayCount}`, inline: false },
      { name: "🕘 Last 5 days", value: historyText, inline: false }
    )
    .setFooter({ text: "Data synced with Gist" })
    .setTimestamp();

  try {
    let msg;
    if (statsData.statsMessageId) {
      try {
        msg = await channel.messages.fetch(statsData.statsMessageId);
      } catch {
        statsData.statsMessageId = null;
      }
    }

    if (!statsData.statsMessageId) {
      msg = await channel.send({ embeds: [embed] });
      statsData.statsMessageId = msg.id;
      await saveData();
    } else if (msg) {
      await msg.edit({ embeds: [embed] });
    }
  } catch (err) {
    console.error("Error creando/actualizando panel de estadísticas:", err);
    statsData.statsMessageId = null;
  }
}

async function cleanWebhookMessage(channel) {
  try {
    const messages = await channel.messages.fetch({ limit: 10 });
    const webhookMsg = messages.find(
      msg => msg.webhookId && msg.content.includes("God Pack found")
    );
    if (webhookMsg) await webhookMsg.delete().catch(() => {});
  } catch (err) {
    console.error("CLEAN ERROR:", err);
  }
}

// **Nueva función para limpiar mensajes antiguos y enviar un mensaje de prueba**



module.exports = async (client) => {
    await loadData();
      //  await loadLiveStats();
    


  
  
  
  


  // Crear/actualizar panel de estadísticas y mensaje de prueba
  (async () => {
    try {
      console.log("Enviando/actualizando panel de estadísticas...");
      await updateStats(client);
      console.log("Panel de estadísticas OK");
    } catch (err) {
      console.error("Error inicializando bot:", err);
    }
  })();

  setInterval(() => {
    updateStats(client).catch(() => {});
  }, 60 * 60 * 1000);


client.on("messageCreate", async (message) => {
if (!ALLOWED_CHANNELS.includes(message.channel.id)) return;
  if (!message.webhookId) return;
  if (!message.content.includes("God Pack found")) return;
  // 🔥 REGISTRAR GP POR MENCIÓN
await registerUserGP(message);
const group = CHANNEL_GROUP_MAP[message.channel.id];

if (!group) {
  console.log("⚠️ Canal sin grupo");
  return;
}
  try {
    // ===== IMAGEN =====
    const attachment = message.attachments.first();
    let imageFile = null;
    if (attachment) {
      imageFile = {
        attachment: attachment.url,
        name: "card.png"
      };
    }

    // ===== DATOS =====
    const rarityMatch = message.content.match(/\[(\d)\/5\]/);
    if (!rarityMatch) return;
    const rarity = parseInt(rarityMatch[1]);

    const packMatch = message.content.match(/\[(\d)P\]/i);
    const packNumber = packMatch ? parseInt(packMatch[1]) : 1;

    let username = "Unknown";
    const usernameLine = message.content.split("\n").find(line => line.includes("(") && line.includes(")"));
    if (usernameLine) {
      const match = usernameLine.match(/^(.+?)\s*\(/);
      if (match) username = match[1].trim();
    }

// ===== FRIEND ID (16 dígitos con o sin espacios) =====
let friendId = "Unknown";

const rawText = message.content;

// Buscar 16 dígitos seguidos
let match = rawText.match(/\b\d{16}\b/);

// Si no encuentra, buscar formato con espacios
if (!match) {
  match = rawText.match(/\b(\d{4}\s\d{4}\s\d{4}\s\d{4})\b/);
  if (match) {
    friendId = match[1].replace(/\s/g, ""); // quitar espacios
  }
} else {
  friendId = match[0];
}

console.log("Friend ID detectado:", friendId);
if (friendId !== "Unknown") {
  await addVipID(friendId, group);
} else {
  console.log("⚠️ No se agregó VIP porque no se detectó friendId");
}


    // ===== COLOR =====
    let color = 0x808080;
    if (rarity === 3) color = 0x3498db;
    if (rarity === 4) color = 0x9b59b6;
    if (rarity === 5) color = 0xFFD700;

    // ===== EMBED =====
    let description = `## ✨ ${rarity}/5 • ${packNumber}P  |  **${username}**`;
    const embed = new EmbedBuilder()
      .setColor(color)
      .setDescription(description)
      .setTimestamp();
    if (imageFile) embed.setImage("attachment://card.png");

// ===== BOTONES =====
// ===== ENVIAR MENSAJE SIN BOTÓN EDIT PRIMERO =====
const buttons = new ActionRowBuilder().addComponents(
  new ButtonBuilder()
    .setCustomId("gp_alive")
    .setLabel("🟢 Alive (0)")
    .setStyle(ButtonStyle.Success),
  new ButtonBuilder()
    .setCustomId("gp_dead")
    .setLabel("🔴 Dead (0)")
    .setStyle(ButtonStyle.Danger)
);

const sentMessage = await message.channel.send({
  embeds: [embed],
  components: [buttons],
  files: imageFile ? [imageFile] : [],
  allowedMentions: { parse: ["users"] }
});


// ===== SUMAR GP TOTAL =====
await updateStatsSafe(group, async (stats) => {
  stats = await checkDailyReset(group, stats);

  // 🔥 evitar doble conteo
  if (!stats.processedMessages) stats.processedMessages = [];

  if (!stats.processedMessages.includes(sentMessage.id)) {
    stats.totalGP += 1;
    stats.daily.gp += 1;
    stats.processedMessages.push(sentMessage.id);
  }

  return stats;
});



// ===== AHORA AGREGAR BOTÓN EDIT CON EL ID REAL =====
const editButton = new ButtonBuilder()
  .setCustomId(`edit_panel_${sentMessage.id}`)
  .setStyle(ButtonStyle.Secondary)
  .setEmoji("✏️"); // solo icono, cuadro pequeño

// Tomamos la fila de botones existente y agregamos Edit
const newButtons = ActionRowBuilder.from(buttons).addComponents(editButton);

await sentMessage.edit({
  components: [newButtons]
});
    

    // ===== CREAR HILO =====
    try {
      const thread = await sentMessage.startThread({
        name: `[${rarity}/5][${packNumber}P] [${username}P] [${friendId}P]`,
        autoArchiveDuration: 1440,
        type: ChannelType.PublicThread
      });
// ===== MENSAJE GRANDE DE ACCESO AL VOTO =====
const voteAccessRow = new ActionRowBuilder().addComponents(
  new ButtonBuilder()
    .setLabel("🗳️ VOTE ALIVE OR DEAD")
    .setStyle(ButtonStyle.Link)
    .setURL(`https://discord.com/channels/${message.guild.id}/${message.channel.id}/${sentMessage.id}`)
);

await thread.send({
  components: [voteAccessRow]
});
      
// Menciones online directas
const onlineMentions = await getOnlineMentions(message.channel.id);
if (onlineMentions.length > 0) {
 await thread.send({
  content: onlineMentions.join(" "),
  allowedMentions: { parse: ["users"] }
});
}

      await thread.send("📂 Original webhook message:");
      await thread.send({
        content: message.content,
        files: message.attachments.map(att => att.url),
        allowedMentions: { parse: [] }
      });

      await message.delete().catch(() => {});
    } catch (err) {
      console.error("THREAD ERROR:", err);
    }

  } catch (err) {
    console.error("GP Handler Error:", err);
  }
});



client.on("interactionCreate", async (interaction) => {

  // =========================
  // 1️⃣ BOTÓN EDIT
  // =========================
if (interaction.isButton() && interaction.customId.startsWith("edit_panel_")) {

  const messageId = interaction.customId.replace("edit_panel_", "");
  const message = await interaction.channel.messages.fetch(messageId).catch(() => null);

  if (!message) {
   return interaction.reply({ content: "❌ Mensaje no encontrado.", flags: MessageFlags.Ephemeral });
  }

  // 🔥 LEER DATOS DESDE EL EMBED (AQUÍ VA EL PASO 4)
  const embed = message.embeds[0];
  const desc = embed?.description || "";

  const rarityMatch = desc.match(/(\d)\/5/);
  const packMatch = desc.match(/• (\d+)P/);
  const userMatch = desc.match(/\*\*(.*?)\*\*/);

  const rarity = rarityMatch ? rarityMatch[1] : "1";
  const packNumber = packMatch ? packMatch[1] : "1";
  const username = userMatch ? userMatch[1] : "Unknown";

  const modal = new ModalBuilder()
    .setCustomId(`edit_panel_${message.id}`)
    .setTitle("Editar GP Panel");

  const rarityInput = new TextInputBuilder()
    .setCustomId("rarity")
    .setLabel("Rareza (1-5)")
    .setStyle(TextInputStyle.Short)
    .setValue(String(rarity));

  const packInput = new TextInputBuilder()
    .setCustomId("pack")
    .setLabel("Packs")
    .setStyle(TextInputStyle.Short)
    .setValue(String(packNumber));

  const userInput = new TextInputBuilder()
    .setCustomId("username")
    .setLabel("Usuario")
    .setStyle(TextInputStyle.Short)
    .setValue(username);

  modal.addComponents(
    new ActionRowBuilder().addComponents(rarityInput),
    new ActionRowBuilder().addComponents(packInput),
    new ActionRowBuilder().addComponents(userInput)
  );

  return interaction.showModal(modal);
}

// =========================
// 2️⃣ MODAL SUBMIT
// =========================
if (interaction.isModalSubmit() && interaction.customId.startsWith("edit_panel_")) {

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const messageId = interaction.customId.replace("edit_panel_", "");
  const message = await interaction.channel.messages.fetch(messageId).catch(() => null);

  if (!message) {
    return interaction.editReply("❌ Mensaje no encontrado.");
  }

  const rarity = parseInt(interaction.fields.getTextInputValue("rarity"));
  const packNumber = parseInt(interaction.fields.getTextInputValue("pack"));
  const username = interaction.fields.getTextInputValue("username");

  if (isNaN(rarity) || rarity < 1 || rarity > 5) {
    return interaction.editReply("❌ Rareza inválida.");
  }

  let color = 0x808080;
  if (rarity === 3) color = 0x3498db;
  if (rarity === 4) color = 0x9b59b6;
  if (rarity === 5) color = 0xFFD700;

const oldEmbed = message.embeds[0];

const newEmbed = EmbedBuilder.from(oldEmbed)
  .setColor(color)
  .setDescription(`## ✨ ${rarity}/5 • ${packNumber}P  |  **${username}**`)
  .setImage(null); // ✅ solo quita imagen del embed

await message.edit({
  embeds: [newEmbed]
  // 🚫 NO poner files: []
});

  await interaction.editReply("✅ Panel actualizado correctamente.");
  return; // 🔥 IMPORTANTE
}

// =========================
// 3️⃣ BOTONES ALIVE / DEAD
// =========================
if (interaction.isButton()) {
  if (interaction.customId !== "gp_alive" && interaction.customId !== "gp_dead") return;

  const message = interaction.message;
  const embed = message.embeds[0];

  // ===== LEER FOOTER =====
  let footer = embed.footer?.text || "VOTES:alive=|dead=";

  // Extraer usuarios que ya votaron
  let aliveUsers = [];
  let deadUsers = [];

  const matchAlive = footer.match(/alive=([^|]*)/);
  const matchDead = footer.match(/dead=(.*)/);

  if (matchAlive && matchAlive[1]) {
    aliveUsers = matchAlive[1].split(",").map(u => u.trim()).filter(Boolean);
  }

  if (matchDead && matchDead[1]) {
    deadUsers = matchDead[1].split(",").map(u => u.trim()).filter(Boolean);
  }

  const userId = interaction.user.id;

  // 🚫 BLOQUEAR SI YA VOTÓ
const alreadyVoted = aliveUsers.includes(userId) || deadUsers.includes(userId);

if (alreadyVoted) {
  return interaction.reply({
    content: "⚠️ You already voted for this GP.",
    flags: MessageFlags.Ephemeral
  });
}

// Registrar voto en memoria temporal del mensaje

  await interaction.deferUpdate();

  // ===== CONTADORES =====
  const row = message.components[0];
  const buttons = row.components;

  let aliveCount = 0;
  let deadCount = 0;

  const aliveBtn = buttons.find(b => b.customId === "gp_alive");
  const deadBtn = buttons.find(b => b.customId === "gp_dead");

  if (aliveBtn) {
    const m = aliveBtn.label.match(/\((\d+)\)/);
    if (m) aliveCount = parseInt(m[1]);
  }

  if (deadBtn) {
    const m = deadBtn.label.match(/\((\d+)\)/);
    if (m) deadCount = parseInt(m[1]);
  }

  // ===== VOTO =====
  if (interaction.customId === "gp_alive") {
    aliveCount++;
    aliveUsers.push(userId);
  } else if (interaction.customId === "gp_dead") {
    deadCount++;
    deadUsers.push(userId);
  }

  // ===== ENVIAR LOG AL HILO =====
  try {
    const thread = message.thread;
    if (thread) {
      await thread.send({
        content: `🗳️ ${interaction.user.username} votó **${interaction.customId === "gp_alive" ? "Alive" : "Dead"}**`,
        allowedMentions: { parse: [] }
      });
    }
  } catch (err) {
    console.error("THREAD LOG ERROR:", err);
  }

  // ===== GUARDAR FOOTER =====
 // const newEmbed = EmbedBuilder.from(embed).setFooter({ text: newFooter });

  // ===== BOTONES ACTUALIZADOS =====
// ===== BOTONES ACTUALIZADOS =====
const newRow = new ActionRowBuilder();

// Mostrar Alive solo si no alcanzó el límite
if (aliveCount < 2) {
  newRow.addComponents(
    new ButtonBuilder()
      .setCustomId("gp_alive")
      .setLabel(`🟢 Alive (${aliveCount})`)
      .setStyle(ButtonStyle.Success)
  );
}

// Mostrar Dead solo si no alcanzó el límite
if (deadCount < 4) {
  newRow.addComponents(
    new ButtonBuilder()
      .setCustomId("gp_dead")
      .setLabel(`🔴 Dead (${deadCount})`)
      .setStyle(ButtonStyle.Danger)
  );
}

// Agregar botón Edit
newRow.addComponents(
  new ButtonBuilder()
    .setCustomId(`edit_panel_${message.id}`)
    .setEmoji("✏️")
    .setStyle(ButtonStyle.Secondary)
);

  // ===== ACTUALIZAR MENSAJE =====
  //await message.edit({
    //embeds: [newEmbed],
  //  components: [newRow]
//  });

 // ===== ESTADO FINAL =====
// ===== ESTADO FINAL =====
let status = null;

if (aliveCount >= 1) status = "alive"; // 🔥 cambio a 1
if (deadCount >= 4) status = "dead";

// ===== SUMAR ALIVE AL GIST =====
const alreadyAlive = footer.includes("status=alive");

if (status === "alive" && !alreadyAlive) {
  const group = CHANNEL_GROUP_MAP[message.channel.id];
  if (!group) return;

  await updateStatsSafe(group, async (stats) => {
    stats.totalAlive += 1;
    stats.daily.alive += 1;
    return stats;
  });
}
const newFooter = `VOTES:alive=${aliveUsers.join(",")}|dead=${deadUsers.join(",")}|status=${status || "none"}`;

const newEmbed = EmbedBuilder.from(embed).setFooter({ text: newFooter });


  
// ===== BOTONES =====
let components = [];

if (status) {
  // 🔒 SOLO EDIT (sin Alive/Dead)
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`edit_panel_${message.id}`)
      .setEmoji("✏️")
      .setStyle(ButtonStyle.Secondary)
  );

  components = [row];

} else {
  // 🟢 AÚN ACTIVO
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("gp_alive")
      .setLabel(`🟢 Alive (${aliveCount})`)
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId("gp_dead")
      .setLabel(`🔴 Dead (${deadCount})`)
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId(`edit_panel_${message.id}`)
      .setEmoji("✏️")
      .setStyle(ButtonStyle.Secondary)
  );

  components = [row];
}

// ===== ACTUALIZAR MENSAJE =====
await message.edit({
 // embeds: [newEmbed],
  components: components
});

// ===== ACTUALIZAR THREAD NAME SI SE ALCANZA STATUS =====
if (status) {
  const desc = embed.description || "";
  const rarity = (desc.match(/(\d)\/5/) || [])[1] || 0;
  const pack = (desc.match(/• (\d+)P/) || [])[1] || 0;
  const user = (desc.match(/\*\*(.*?)\*\*/) || [])[1] || "Unknown";

  await updateThreadName(message, status, rarity, pack, user);
}

return;
}

// 👇 cierre del interactionCreate
});

// 👇 cierre del module.exports
};

