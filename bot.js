require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelType,
  PermissionFlagsBits,
  AttachmentBuilder,
  REST,
  Routes,
} = require('discord.js');
const http = require('http');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const GIST_ID = process.env.GIST_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const LOGO = 'https://cdn.discordapp.com/attachments/1557498332262301716/1558123583371481139/Vexora.png?ex=6ace3faa&is=6accee2a&hm=c27628f8d9c71dab36f1041308bc32a630c03fadc49bf418913598bd4944c7ea&';
const PORT = process.env.PORT || 3000;

// ===== Settings =====
const REVIEW_CHANNEL_ID = '1559313542509887569';
const REQUIRED_ROLE_ID = '1556357822998913094';
const PURCHASE_ROLE_ID = '1559485646991654922';
const PURCHASE_LOG_CHANNEL_ID = '1559485972440293386';
const SUGGESTIE_CHANNEL_ID = '1557502689271619726';
const VERIFY_CHANNEL_ID = '1554510752482726015';
const VERIFY_ROLE_ID = '1554510750092099690';
const PRICING_CHANNEL_ID = '1559555369209045012';
const TICKET_PANEL_CHANNEL_ID = '1559557702915588238';
const TICKET_SUPPORT_ROLE_ID = '1554510750092099688';
const TICKET_TRANSCRIPT_CHANNEL_ID = '1554510754852511845';
const LEGIT_CHANNEL_ID = '1559585421489344513';
const VOTE_LOG_CHANNEL_ID = '1559588394336653332';
const BAN_LOG_CHANNEL_ID = '1560402931667435601';
const NOT_LEGIT_TICKET_CATEGORY_ID = '1564617622908051486';
const PRODUCT = 'Vexora External + Bypass';
const STATUS_INTERVAL = 8000;

const TICKET_CATEGORIES = {
  support: { name: 'Support', prefix: 'support', categoryId: '1559570734664122488', emoji: '🎫', color: 0x3498db },
  purchase: { name: 'Purchase', prefix: 'purchase', categoryId: '1559570790398042133', emoji: '🛒', color: 0x00ff88 },
  bug: { name: 'Bug', prefix: 'bug', categoryId: '1559570848279429290', emoji: '⚠️', color: 0xff4444 },
  notlegit: { name: 'Not Legit Proof', prefix: 'notlegit', categoryId: NOT_LEGIT_TICKET_CATEGORY_ID, emoji: '❌', color: 0xff4444 },
};

// ===== HTTP server + keep-alive =====
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('ok');
}).listen(PORT);

const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  setInterval(() => fetch(SELF_URL).catch(() => {}), 12 * 60 * 1000);
  console.log(`Keep-alive self-ping started for ${SELF_URL}`);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  presence: { status: 'online', activities: [{ name: 'Vexora.cc', type: 3 }] },
});
const reviews = new Map();

// ===== Plans =====
const PLANS = {
  '1 week': 8.5 * 24 * 60 * 60 * 1000,
  '1 month': 30.5 * 24 * 60 * 60 * 1000,
  'lifetime': null,
};

function planDurationMs(plan) { return PLANS[plan]; }

function formatDuration(ms) {
  if (ms === null) return 'Lifetime';
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  if (days > 0 && hours > 0) return `${days}d ${hours}h`;
  if (days > 0) return `${days}d`;
  return `${hours}h`;
}

function formatRemaining(endTime) {
  if (endTime === null) return 'Lifetime';
  const left = endTime - Date.now();
  if (left <= 0) return 'Expired';
  const days = Math.floor(left / (24 * 60 * 60 * 1000));
  const hours = Math.floor((left % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const minutes = Math.floor((left % (60 * 60 * 1000)) / (60 * 1000));
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// ===== Time parsing =====
function parseDuration(input) {
  const match = String(input).trim().toLowerCase().match(/^(\d+)\s*(s|m|h|d|w)$/);
  if (!match) return null;
  const n = parseInt(match[1]);
  const unit = match[2];
  const multipliers = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };
  return n * multipliers[unit];
}

function formatShortDuration(ms) {
  if (ms >= 7 * 24 * 60 * 60 * 1000) return `${Math.round(ms / (7*24*60*60*1000))}w`;
  if (ms >= 24 * 60 * 60 * 1000) return `${Math.round(ms / (24*60*60*1000))}d`;
  if (ms >= 60 * 60 * 1000) return `${Math.round(ms / (60*60*1000))}h`;
  if (ms >= 60 * 1000) return `${Math.round(ms / (60*1000))}m`;
  return `${Math.round(ms / 1000)}s`;
}

const parseGiveawayTime = parseDuration;
const formatGiveawayDuration = formatShortDuration;

// ===== Commands =====
const commands = [
  {
    name: 'review',
    description: 'Write a review for Vexora External + Bypass',
    options: [{ name: 'extra', description: 'Tell us briefly about your experience', type: 3, required: true }],
  },
  {
    name: 'purchase',
    description: 'Assign a temporary role to a user',
    options: [
      { name: 'user', description: 'The user', type: 6, required: true },
      {
        name: 'plan', description: 'Which plan', type: 3, required: true,
        choices: [
          { name: '1 week', value: '1 week' },
          { name: '1 month', value: '1 month' },
          { name: 'Lifetime', value: 'lifetime' },
        ],
      },
      { name: 'key', description: 'The key/license for the customer', type: 3, required: true },
    ],
  },
  {
    name: 'removelicense',
    description: 'Remove the active license of a user',
    options: [{ name: 'user', description: 'The user', type: 6, required: true }],
  },
  {
    name: 'suggestie',
    description: 'Submit a suggestion',
    options: [{ name: 'tekst', description: 'What is your suggestion?', type: 3, required: true }],
  },
  { name: 'refresh', description: 'Repost the overview' },
  {
    name: 'removekruis',
    description: 'Remove a number of ❌ votes from the legit poll',
    options: [{ name: 'aantal', description: 'How many crosses to remove?', type: 4, required: true, min_value: 1 }],
  },
  {
    name: 'giveaway',
    description: 'Start a giveaway',
    options: [
      { name: 'winners', description: 'Number of winners', type: 4, required: true, min_value: 1, max_value: 50 },
      { name: 'item', description: 'What is the prize?', type: 3, required: true },
      { name: 'time', description: 'Duration (e.g. 30s, 5m, 1h, 1d, 1w)', type: 3, required: true },
    ],
  },
  {
    name: 'reroll',
    description: 'Reroll the last giveaway in this channel',
    options: [
      { name: 'winners', description: 'Number of new winners', type: 4, required: true, min_value: 1, max_value: 50 },
    ],
  },
  {
    name: 'clear',
    description: 'Delete a number of messages from this channel',
    options: [
      { name: 'amount', description: 'Number of messages (1-100)', type: 4, required: true, min_value: 1, max_value: 100 },
    ],
  },
  {
    name: 'ban',
    description: 'Ban a user (permanent or temporary)',
    options: [
      { name: 'user', description: 'The user', type: 6, required: true },
      { name: 'duration', description: 'Duration (e.g. 1h, 1d, 1w) — empty = permanent', type: 3, required: false },
      { name: 'reason', description: 'Reason', type: 3, required: false },
    ],
  },
  {
    name: 'unban',
    description: 'Unban a user by their Discord ID',
    options: [
      { name: 'user_id', description: 'The Discord user ID', type: 3, required: true },
      { name: 'reason', description: 'Reason', type: 3, required: false },
    ],
  },
  {
    name: 'add',
    description: 'Add a user to this ticket',
    options: [{ name: 'user', description: 'The user', type: 6, required: true }],
  },
  {
    name: 'remove',
    description: 'Remove a user from this ticket',
    options: [{ name: 'user', description: 'The user', type: 6, required: true }],
  },
  {
    name: 'close',
    description: 'Close this ticket',
  },
  {
    name: 'rename',
    description: 'Rename this ticket',
    options: [{ name: 'name', description: 'New name', type: 3, required: true }],
  },
];

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('Commands loaded');
  } catch (e) { console.error(e); }
})();

// ===== Gist storage =====
async function readGist() {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`Gist read failed: ${res.status}`);
  const data = await res.json();
  const parsed = JSON.parse(data.files['reviews.json'].content);
  return {
    counter: parsed.counter || 0,
    purchases: parsed.purchases || [],
    suggestions: parsed.suggestions || {},
    tickets: parsed.tickets || {},
    overzichtMessageId: parsed.overzichtMessageId || null,
    legitVotes: parsed.legitVotes || { approve: [], reject: [] },
    legitMessageId: parsed.legitMessageId || null,
    giveaways: parsed.giveaways || {},
    laatsteGiveaways: parsed.laatsteGiveaways || {},
    bans: parsed.bans || [],
    notlegitTickets: parsed.notlegitTickets || {},
    confirmedRejects: parsed.confirmedRejects || [],
  };
}

async function writeGist(data) {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ files: { 'reviews.json': { content: JSON.stringify(data, null, 2) } } }),
  });
  if (!res.ok) throw new Error(`Gist write failed: ${res.status}`);
}

async function readCounter() { const d = await readGist(); return d.counter; }
async function writeCounter(n) { const d = await readGist(); d.counter = n; await writeGist(d); }

// ===== Purchase =====
async function getPurchases() { const d = await readGist(); return d.purchases; }
async function savePurchases(p) { const d = await readGist(); d.purchases = p; await writeGist(d); }

async function addPurchase(userId, plan, key) {
  const purchases = await getPurchases();
  const duration = planDurationMs(plan);
  const endTime = duration === null ? null : Date.now() + duration;
  const filtered = purchases.filter(p => p.userId !== userId);
  filtered.push({ userId, plan, key, eindTijd: endTime, gestart: Date.now() });
  await savePurchases(filtered);
  return { endTime, duration };
}

async function removePurchase(userId) {
  const purchases = await getPurchases();
  const filtered = purchases.filter(p => p.userId !== userId);
  await savePurchases(filtered);
  return purchases.find(p => p.userId === userId);
}

// ===== Bans =====
async function getBans() { const d = await readGist(); return d.bans; }
async function saveBans(b) { const d = await readGist(); d.bans = b; await writeGist(d); }

async function addTemporaryBan(userId, guildId, endTime) {
  const bans = await getBans();
  bans.push({ userId, guildId, eindTijd: endTime, gestart: Date.now() });
  await saveBans(bans);
}

async function removeBanRecord(userId, guildId) {
  const bans = await getBans();
  const filtered = bans.filter(b => !(b.userId === userId && b.guildId === guildId));
  await saveBans(filtered);
}

async function checkBans() {
  try {
    const bans = await getBans();
    const now = Date.now();
    let changed = false;

    for (const b of bans) {
      if (b.eindTijd > now) continue;

      try {
        const guild = await client.guilds.fetch(b.guildId).catch(() => null);
        if (guild) {
          await guild.bans.remove(b.userId, 'Temporary ban expired').catch(() => {});
          console.log(`Unban: ${b.userId} in ${b.guildId} (time expired)`);

          try {
            const logChannel = await client.channels.fetch(BAN_LOG_CHANNEL_ID);
            if (logChannel) {
              const embed = new EmbedBuilder()
                .setColor(0x00ff88)
                .setDescription(`🔓 <@${b.userId}> has been automatically unbanned (temporary ban expired)`)
                .setFooter({ text: 'Vexora.cc', iconURL: LOGO })
                .setTimestamp();
              await logChannel.send({ embeds: [embed] });
            }
          } catch (e) {}
        }
      } catch (e) {
        console.error(`Could not unban ${b.userId}:`, e.message);
      }

      changed = true;
    }

    if (changed) {
      const stillActive = bans.filter(b => b.eindTijd > now);
      await saveBans(stillActive);
    }
  } catch (e) {
    console.error('Error in checkBans:', e.message);
  }
}

function startBanInterval() {
  checkBans();
  setInterval(checkBans, 60000);
}

// ===== Suggestions =====
async function getSuggestions() { const d = await readGist(); return d.suggestions; }
async function saveSuggestions(s) { const d = await readGist(); d.suggestions = s; await writeGist(d); }

function buildSuggestionEmbed(s) {
  return new EmbedBuilder()
    .setTitle('New Suggestion')
    .setColor(0x5865f2)
    .setThumbnail(LOGO)
    .setDescription(s.tekst)
    .addFields(
      { name: 'By', value: `<@${s.auteurId}>`, inline: true },
      { name: 'Votes', value: `✅ ${s.approve.length}  •  ❌ ${s.reject.length}`, inline: true }
    )
    .setFooter({ text: 'Vexora.cc', iconURL: LOGO })
    .setTimestamp(s.gestart);
}

function buildSuggestionRow(messageId, s) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`suggest_approve_${messageId}`).setLabel(`✅ ${s.approve.length}`).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`suggest_reject_${messageId}`).setLabel(`❌ ${s.reject.length}`).setStyle(ButtonStyle.Secondary)
  );
}

// ===== Legit poll =====
async function getLegitVotes() { const d = await readGist(); return d.legitVotes; }
async function saveLegitVotes(v) { const d = await readGist(); d.legitVotes = v; await writeGist(d); }
async function getLegitMessageId() { const d = await readGist(); return d.legitMessageId; }
async function setLegitMessageId(id) { const d = await readGist(); d.legitMessageId = id; await writeGist(d); }

async function getConfirmedRejects() { const d = await readGist(); return d.confirmedRejects || []; }
async function saveConfirmedRejects(list) { const d = await readGist(); d.confirmedRejects = list; await writeGist(d); }

function buildLegitEmbed(votes, confirmedRejects = []) {
  const confirmedCount = confirmedRejects.length;
  return new EmbedBuilder()
    .setTitle('Are we legit?')
    .setColor(0x00ff88)
    .setDescription(
      '**No without proof = ban**\n\n' +
      `> ✅ Legit — **${votes.approve.length}**\n` +
      `> ❌ Not legit — **${votes.reject.length}**` +
      (confirmedCount > 0 ? `\n> 🟢 Confirmed (with proof) — **${confirmedCount}**` : '') +
      `\n\n*Clicking ❌ Not legit opens a private ticket where you must upload proof.*`
    )
    .setThumbnail(LOGO)
    .setFooter({ text: 'Vexora.cc', iconURL: LOGO });
}

function buildLegitRow(votes) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('legit_approve').setLabel(`✅ ${votes.approve.length}`).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('legit_reject').setLabel(`❌ ${votes.reject.length}`).setStyle(ButtonStyle.Secondary)
  );
}

async function refreshLegitPoll() {
  try {
    const channel = await client.channels.fetch(LEGIT_CHANNEL_ID);
    if (!channel) return;
    const votes = await getLegitVotes();
    const confirmed = await getConfirmedRejects();
    const messageId = await getLegitMessageId();
    if (!messageId) return;
    const msg = await channel.messages.fetch(messageId).catch(() => null);
    if (msg && msg.author.id === client.user.id) {
      await msg.edit({ embeds: [buildLegitEmbed(votes, confirmed)], components: [buildLegitRow(votes)] });
    }
  } catch (e) { console.error('Could not refresh legit poll:', e.message); }
}

// ===== Vote log =====
async function logVote(userId, type, target) {
  try {
    const channel = await client.channels.fetch(VOTE_LOG_CHANNEL_ID);
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setColor(type === 'approve' ? 0x00ff88 : 0xff4444)
      .setDescription(`<@${userId}> voted ${type === 'approve' ? '✅ approve' : '❌ reject'} on ${target}`)
      .setFooter({ text: 'Vexora.cc', iconURL: LOGO })
      .setTimestamp();
    await channel.send({ embeds: [embed] });
  } catch (e) { console.error('Could not send vote log:', e.message); }
}

// ===== Review number =====
async function scanChannel(channel) {
  let highest = 0, lastId = null, searching = true;
  while (searching) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    const messages = await channel.messages.fetch(options);
    if (messages.size === 0) break;
    for (const msg of messages.values()) {
      for (const embed of msg.embeds) {
        if (embed.title && embed.title.startsWith('Review #')) {
          const n = parseInt(embed.title.replace('Review #', ''));
          if (!isNaN(n) && n > highest) highest = n;
        }
      }
    }
    laatsteId = messages.last().id;
    if (messages.size < 100) searching = false;
  }
  return highest;
}

async function nextNumber(channel) {
  try { return (await readCounter()) + 1; }
  catch (e) { return (await scanChannel(channel)) + 1; }
}

// ===== Status =====
let statusToggle = false;
let cachedCounter = 0;

async function getMemberCount() {
  try {
    const guild = await client.guilds.fetch({ guild: GUILD_ID, force: true });
    return guild.memberCount;
  } catch (e) { return 0; }
}

async function updateStatus() {
  try {
    if (statusToggle) {
      const members = await getMemberCount();
      client.user.setActivity(`${members} Members`, { type: 3 });
    } else {
      client.user.setActivity(`${cachedCounter} Reviews`, { type: 3 });
    }
    statusToggle = !statusToggle;
  } catch (e) {}
}

async function refreshCounterCache() {
  try { cachedCounter = await readCounter(); } catch (e) {}
}

function startStatusInterval() {
  refreshCounterCache();
  updateStatus();
  setInterval(refreshCounterCache, 60000);
  setInterval(updateStatus, STATUS_INTERVAL);
}

// ===== Role expiry =====
async function checkRoleExpiry() {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const purchases = await getPurchases();
    const now = Date.now();
    for (const p of purchases) {
      if (p.eindTijd === null || p.eindTijd > now) continue;
      try {
        const member = await guild.members.fetch(p.userId);
        if (member && member.roles.cache.has(REQUIRED_ROLE_ID)) {
          await member.roles.remove(REQUIRED_ROLE_ID, 'Plan expired');
        }
      } catch (e) {}
    }
    const stillActive = purchases.filter(p => p.eindTijd === null || p.eindTijd > now);
    if (stillActive.length !== purchases.length) await savePurchases(stillActive);
  } catch (e) { console.error('Error in checkRoleExpiry:', e.message); }
}

function startExpiryInterval() {
  checkRoleExpiry();
  setInterval(checkRoleExpiry, 60000);
}

// ===== Clear bot messages =====
async function clearBotMessages(channel) {
  let lastId = null, searching = true;
  while (searching) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    const messages = await channel.messages.fetch(options);
    if (messages.size === 0) break;
    const botMsgs = messages.filter(m => m.author.id === client.user.id);
    for (const msg of botMsgs.values()) await msg.delete().catch(() => {});
    lastId = messages.last().id;
    if (messages.size < 100) searching = false;
  }
}

// ===== Overview =====
async function getOverviewMessageId() { const d = await readGist(); return d.overzichtMessageId; }
async function setOverviewMessageId(id) { const d = await readGist(); d.overzichtMessageId = id; await writeGist(d); }

async function buildOverviewEmbed() {
  const purchases = await getPurchases();
  const perPlan = {};
  for (const plan of Object.keys(PLANS)) perPlan[plan] = [];
  for (const p of purchases) {
    const planName = p.plan === 'lifetime' ? 'lifetime' : p.plan;
    if (!perPlan[planName]) perPlan[planName] = [];
    perPlan[planName].push(p);
  }
  const embed = new EmbedBuilder()
    .setTitle('Active Purchases')
    .setColor(0x5865f2)
    .setThumbnail(LOGO)
    .setFooter({ text: 'Vexora.cc', iconURL: LOGO })
    .setTimestamp();
  for (const plan of ['1 week', '1 month', 'lifetime']) {
    const list = perPlan[plan] || [];
    let value = list.length === 0 ? '*None*' : '';
    for (const p of list) {
      const remaining = formatRemaining(p.eindTijd);
      const key = p.key ? p.key : 'no key';
      value += `<@${p.userId}> — ${remaining} — \`${key}\`\n`;
    }
    if (value.length > 1024) value = value.slice(0, 1020) + '...';
    embed.addFields({ name: `**${plan}** (${list.length})`, value, inline: false });
  }
  return embed;
}

async function updateOverview() {
  try {
    const channel = await client.channels.fetch(PURCHASE_LOG_CHANNEL_ID);
    if (!channel) return;
    const embed = await buildOverviewEmbed();
    const messageId = await getOverviewMessageId();
    if (messageId) {
      try {
        const msg = await channel.messages.fetch(messageId);
        if (msg && msg.author.id === client.user.id) {
          await msg.edit({ embeds: [embed] });
          return;
        }
      } catch (e) {}
    }
    await clearBotMessages(channel);
    const newMsg = await channel.send({ embeds: [embed] });
    await setOverviewMessageId(newMsg.id);
  } catch (e) { console.error('Could not update overview:', e.message); }
}

async function restartOverview() {
  try {
    const channel = await client.channels.fetch(PURCHASE_LOG_CHANNEL_ID);
    if (!channel) return;
    await clearBotMessages(channel);
    const embed = await buildOverviewEmbed();
    const newMsg = await channel.send({ embeds: [embed] });
    await setOverviewMessageId(newMsg.id);
  } catch (e) { console.error('Could not restart overview:', e.message); }
}

function startOverviewInterval() {
  updateOverview();
  setInterval(updateOverview, 60000);
}

// ===== Giveaway =====
async function getGiveaways() { const d = await readGist(); return d.giveaways; }
async function saveGiveaways(g) { const d = await readGist(); d.giveaways = g; await writeGist(d); }
async function getLastGiveaways() { const d = await readGist(); return d.laatsteGiveaways; }
async function saveLastGiveaways(l) { const d = await readGist(); d.laatsteGiveaways = l; await writeGist(d); }

function buildGiveawayEmbed(g) {
  return new EmbedBuilder()
    .setTitle('🎉 Giveaway 🎉')
    .setColor(0xff73fa)
    .setThumbnail(LOGO)
    .setDescription(
      `**Prize:** ${g.item}\n` +
      `**Winners:** ${g.winners}\n` +
      `**Ends:** <t:${Math.floor(g.eindTijd / 1000)}:R>\n\n` +
      `React with 🎉 to enter!`
    )
    .setFooter({ text: `Vexora.cc • Hosted by ${g.hostTag || 'unknown'}`, iconURL: LOGO })
    .setTimestamp(g.gestart);
}

function buildGiveawayEndedEmbed(g, winners, isReroll = false) {
  let winnerText = 'No participants';
  if (winners.length > 0) {
    winnerText = winners.map(id => `<@${id}>`).join(', ');
  }
  return new EmbedBuilder()
    .setTitle(isReroll ? '🎉 Giveaway Rerolled 🎉' : '🎉 Giveaway Ended 🎉')
    .setColor(0x00ff88)
    .setThumbnail(LOGO)
    .setDescription(
      `**Prize:** ${g.item}\n` +
      `**${isReroll ? 'New winners' : 'Winners'}:** ${winnerText}\n\n` +
      `Congratulations! 🎊`
    )
    .setFooter({ text: 'Vexora.cc', iconURL: LOGO })
    .setTimestamp();
}

async function pickWinners(message, amount) {
  const reaction = message.reactions.cache.get('🎉');
  let participants = [];
  if (reaction) {
    const users = await reaction.users.fetch();
    participants = users.filter(u => !u.bot).map(u => u.id);
  }
  const winners = [];
  const pool = [...participants];
  const n = Math.min(amount, pool.length);
  for (let k = 0; k < n; k++) {
    const idx = Math.floor(Math.random() * pool.length);
    winners.push(pool.splice(idx, 1)[0]);
  }
  return { winners, totalParticipants: participants.length };
}

async function endGiveaway(messageId, channelId) {
  try {
    const giveaways = await getGiveaways();
    const g = giveaways[messageId];
    if (!g) return;

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      delete giveaways[messageId];
      await saveGiveaways(giveaways);
      return;
    }

    const msg = await channel.messages.fetch(messageId).catch(() => null);
    if (!msg) {
      delete giveaways[messageId];
      await saveGiveaways(giveaways);
      return;
    }

    const { winners } = await pickWinners(msg, g.winners);

    await msg.edit({ embeds: [buildGiveawayEndedEmbed(g, winners, false)] }).catch(() => {});

    if (winners.length > 0) {
      await channel.send({
        content: `🎉 Congratulations ${winners.map(id => `<@${id}>`).join(', ')}! You won **${g.item}**!`,
      }).catch(() => {});

      for (const id of winners) {
        try {
          const user = await client.users.fetch(id);
          await user.send({
            embeds: [
              new EmbedBuilder()
                .setTitle('🎉 You won a giveaway!')
                .setColor(0x00ff88)
                .setThumbnail(LOGO)
                .setDescription(`Congratulations! You won **${g.item}** in the **Vexora.cc** giveaway!`)
                .setFooter({ text: 'Vexora.cc', iconURL: LOGO })
                .setTimestamp(),
            ],
          });
        } catch (e) {}
      }
    } else {
      await channel.send({ content: `😢 No one entered the giveaway for **${g.item}**.` }).catch(() => {});
    }

    const last = await getLastGiveaways();
    last[channelId] = {
      messageId,
      item: g.item,
      winners: g.winners,
      kanaalId: channelId,
      geeindigd: Date.now(),
    };
    await saveLastGiveaways(last);

    delete giveaways[messageId];
    await saveGiveaways(giveaways);
  } catch (e) {
    console.error('End giveaway error:', e.message);
  }
}

async function restoreGiveaways() {
  try {
    const giveaways = await getGiveaways();
    const now = Date.now();
    for (const [messageId, g] of Object.entries(giveaways)) {
      const left = g.eindTijd - now;
      if (left <= 0) {
        await endGiveaway(messageId, g.kanaalId);
      } else {
        setTimeout(() => endGiveaway(messageId, g.kanaalId), left);
        console.log(`Giveaway restored: ${g.item} (ends in ${formatShortDuration(left)})`);
      }
    }
  } catch (e) { console.error('Could not restore giveaways:', e.message); }
}

// ===== Transcript =====
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderContent(content, mentions) {
  if (!content) return '';
  let html = escapeHtml(content);
  if (mentions && mentions.users) {
    for (const [id, user] of mentions.users) {
      html = html.replace(new RegExp(`&lt;@!?${id}&gt;`, 'g'), `<span class="mention">@${escapeHtml(user.username)}</span>`);
    }
  }
  if (mentions && mentions.roles) {
    for (const [id, role] of mentions.roles) {
      html = html.replace(new RegExp(`&lt;@&amp;${id}&gt;`, 'g'), `<span class="mention" style="background:#3c4270">@${escapeHtml(role.name)}</span>`);
    }
  }
  if (mentions && mentions.channels) {
    for (const [id, ch] of mentions.channels) {
      html = html.replace(new RegExp(`&lt;#${id}&gt;`, 'g'), `<span class="mention">#${escapeHtml(ch.name)}</span>`);
    }
  }
  html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank">$1</a>');
  html = html.replace(/```([\s\S]*?)```/g, '<pre class="codeblock">$1</pre>');
  html = html.replace(/`([^`]+)`/g, '<code class="inline">$1</code>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/\n/g, '<br>');
  return html;
}

function renderEmbed(e) {
  const color = e.color ? `#${e.color.toString(16).padStart(6, '0')}` : '#5865f2';
  let fields = '';
  if (e.fields && e.fields.length > 0) {
    fields = `<div class="embed-fields">${e.fields.map(f =>
      `<div class="embed-field" style="grid-column: span ${f.inline ? 1 : 2}">
        <div class="embed-field-name">${escapeHtml(f.name)}</div>
        <div class="embed-field-value">${renderContent(f.value)}</div>
      </div>`
    ).join('')}</div>`;
  }
  return `<div class="embed" style="border-left:4px solid ${color}">
    <div class="embed-grid">
      <div class="embed-main">
        ${e.author ? `<div class="embed-author">${e.author.iconURL ? `<img src="${e.author.iconURL}" class="embed-author-icon">` : ''}${escapeHtml(e.author.name)}</div>` : ''}
        ${e.title ? `<div class="embed-title">${escapeHtml(e.title)}</div>` : ''}
        ${e.description ? `<div class="embed-desc">${renderContent(e.description)}</div>` : ''}
        ${fields}
        ${e.footer ? `<div class="embed-footer">${e.footer.iconURL ? `<img src="${e.footer.iconURL}" class="embed-footer-icon">` : ''}${escapeHtml(e.footer.text)}</div>` : ''}
      </div>
      ${e.thumbnail ? `<img src="${e.thumbnail.url}" class="embed-thumb">` : ''}
    </div>
    ${e.image ? `<img src="${e.image.url}" class="embed-image">` : ''}
  </div>`;
}

function renderAttachments(attachments) {
  if (!attachments || attachments.size === 0) return '';
  return [...attachments.values()].map(a => {
    const isImage = a.contentType && a.contentType.startsWith('image/');
    if (isImage) return `<div class="attachment-image"><a href="${a.url}" target="_blank"><img src="${a.url}" alt="${escapeHtml(a.name)}"></a></div>`;
    return `<div class="attachment"><a href="${a.url}" target="_blank">📎 ${escapeHtml(a.name)}</a></div>`;
  }).join('');
}

async function makeTranscript(channel) {
  let allMessages = [], lastId = null, searching = true;
  while (searching) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    const messages = await channel.messages.fetch(options);
    if (messages.size === 0) break;
    allMessages.push(...messages.values());
    lastId = messages.last().id;
    if (messages.size < 100) searching = false;
  }
  allMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const messagesHtml = allMessages.map(m => {
    const avatar = m.author.displayAvatarURL({ extension: 'png', size: 64 });
    const time = new Date(m.createdTimestamp).toLocaleString('en-US', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const botBadge = m.author.bot ? '<span class="bot-badge">BOT</span>' : '';
    return `<div class="message">
      <img class="avatar" src="${avatar}" alt="avatar">
      <div class="message-body">
        <div class="message-header">
          <span class="username" style="color:${m.member && m.member.displayHexColor && m.member.displayHexColor !== '#000000' ? m.member.displayHexColor : '#ffffff'}">${escapeHtml(m.author.username)}</span>
          ${botBadge}
          <span class="timestamp">${time}</span>
        </div>
        ${m.content ? `<div class="message-content">${renderContent(m.content, m.mentions)}</div>` : ''}
        ${m.embeds && m.embeds.length > 0 ? m.embeds.map(renderEmbed).join('') : ''}
        ${renderAttachments(m.attachments)}
      </div>
    </div>`;
  }).join('');
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Transcript - #${escapeHtml(channel.name)}</title><link rel="icon" href="${LOGO}">
<style>
* { box-sizing: border-box; }
body { margin: 0; background: #313338; color: #dbdee1; font-family: 'gg sans', 'Whitney', 'Helvetica Neue', Arial, sans-serif; font-size: 16px; line-height: 1.375; }
.header { background: #2b2d31; padding: 16px 20px; border-bottom: 1px solid #1e1f22; position: sticky; top: 0; z-index: 10; }
.header h1 { margin: 0; font-size: 18px; color: #f2f3f5; }
.header .meta { color: #949ba4; font-size: 13px; margin-top: 4px; }
.chat { padding: 20px 0; }
.message { display: flex; padding: 4px 20px; margin-top: 16px; }
.message:hover { background: #2e3035; }
.avatar { width: 40px; height: 40px; border-radius: 50%; margin-right: 16px; flex-shrink: 0; }
.message-body { flex: 1; min-width: 0; }
.message-header { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
.username { font-weight: 500; font-size: 16px; }
.bot-badge { background: #5865f2; color: #fff; font-size: 10px; font-weight: 600; padding: 1px 4px; border-radius: 3px; letter-spacing: 0.5px; }
.timestamp { color: #949ba4; font-size: 12px; }
.message-content { color: #dbdee1; word-wrap: break-word; white-space: pre-wrap; }
.message-content a { color: #00a8fc; text-decoration: none; }
.mention { background: #3c4270; color: #c9cdfb; padding: 0 2px; border-radius: 3px; font-weight: 500; }
.inline { background: #2b2d31; padding: 1px 4px; border-radius: 3px; font-family: monospace; font-size: 14px; }
.codeblock { background: #2b2d31; padding: 8px 12px; border-radius: 4px; font-family: monospace; font-size: 14px; overflow-x: auto; margin: 4px 0; white-space: pre-wrap; }
.embed { background: #2b2d31; border-radius: 4px; padding: 12px 16px; margin-top: 8px; max-width: 520px; }
.embed-grid { display: flex; gap: 12px; }
.embed-main { flex: 1; min-width: 0; }
.embed-author { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; color: #f2f3f5; margin-bottom: 4px; }
.embed-author-icon { width: 24px; height: 24px; border-radius: 50%; }
.embed-title { font-size: 16px; font-weight: 600; color: #f2f3f5; margin-bottom: 4px; }
.embed-desc { font-size: 14px; color: #dbdee1; margin-bottom: 8px; }
.embed-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
.embed-field-name { font-size: 14px; font-weight: 600; color: #f2f3f5; margin-bottom: 2px; }
.embed-field-value { font-size: 14px; color: #dbdee1; }
.embed-thumb { width: 80px; height: 80px; border-radius: 4px; flex-shrink: 0; object-fit: cover; }
.embed-image { max-width: 100%; border-radius: 4px; margin-top: 8px; }
.embed-footer { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #949ba4; margin-top: 8px; }
.embed-footer-icon { width: 20px; height: 20px; border-radius: 50%; }
.attachment { margin-top: 6px; font-size: 14px; }
.attachment a { color: #00a8fc; text-decoration: none; }
.attachment-image { margin-top: 8px; }
.attachment-image img { max-width: 400px; max-height: 300px; border-radius: 4px; }
</style></head><body>
<div class="header"><h1>Transcript: #${escapeHtml(channel.name)}</h1><div class="meta">${allMessages.length} messages • Generated on ${new Date().toLocaleString('en-US')}</div></div>
<div class="chat">${messagesHtml}</div>
</body></html>`;
  return { html, messageCount: allMessages.length };
}

// ===== Close ticket (reusable) =====
async function closeTicket(channel, closerId) {
  const tickets = await getTickets();
  const ticket = tickets[channel.id];
  if (!ticket) return { ok: false, reason: 'This is not an active ticket.' };

  try {
    const { html, messageCount } = await makeTranscript(channel);
    const buffer = Buffer.from(html, 'utf-8');
    const attachment = new AttachmentBuilder(buffer, { name: `transcript-${channel.name}.html` });
    const transcriptChannel = await client.channels.fetch(TICKET_TRANSCRIPT_CHANNEL_ID);
    const cat = TICKET_CATEGORIES[ticket.categorie];

    const transcriptEmbed = new EmbedBuilder()
      .setTitle('Ticket Transcript').setColor(cat ? cat.color : 0x5865f2).setThumbnail(LOGO)
      .addFields(
        { name: 'Channel', value: `#${channel.name}`, inline: true },
        { name: 'Customer', value: `<@${ticket.userId}>`, inline: true },
        { name: 'Closed by', value: `<@${closerId}>`, inline: true },
        { name: 'Category', value: cat ? cat.name : 'Unknown', inline: true },
        { name: 'Messages', value: `${messageCount}`, inline: true }
      ).setFooter({ text: 'Vexora.cc', iconURL: LOGO }).setTimestamp();

    await transcriptChannel.send({ embeds: [transcriptEmbed], files: [attachment] });
  } catch (e) {
    console.error('Could not create transcript:', e.message);
  }

  await removeTicket(channel.id);

  setTimeout(async () => {
    try { await channel.delete('Ticket closed'); } catch (e) {}
  }, 5000);

  return { ok: true };
}

// ===== Verify =====
async function setupVerify() {
  try {
    const channel = await client.channels.fetch(VERIFY_CHANNEL_ID);
    if (!channel) return;
    await clearBotMessages(channel);
    const embed = new EmbedBuilder()
      .setTitle('Verify').setColor(0x5865f2)
      .setDescription('Click below to gain access to the server.')
      .setThumbnail(LOGO).setFooter({ text: 'Vexora.cc', iconURL: LOGO });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('verify_button').setLabel('Verify').setEmoji('✅').setStyle(ButtonStyle.Success)
    );
    await channel.send({ embeds: [embed], components: [row] });
  } catch (e) { console.error('Could not set up verify:', e.message); }
}

// ===== Pricing =====
async function setupPricing() {
  try {
    const channel = await client.channels.fetch(PRICING_CHANNEL_ID);
    if (!channel) return;
    await clearBotMessages(channel);
    const embed = new EmbedBuilder()
      .setTitle('Vexora.cc Private').setColor(0x5865f2).setThumbnail(LOGO)
      .setDescription('> Premium external cheat with advanced bypass.\n> ⚡ Fast delivery • 🔒 Safe • 🕐 24/7 Support')
      .addFields(
        { name: '💰 Pricing', value: '```\n1 Week    →  €7.50\n1 Month   →  €20.00\nLifetime  →  €60.00\n```', inline: false },
        { name: '🛡️ Product', value: '> • External Cheat\n> • Advanced bypass — removes all traces after execution\n> • Daily Updates\n> • Easy to use interface\n> • 24/7 Support', inline: false },
        { name: '👥 Group Deals', value: '```\nDuo    →  €30 per person\nTrio   →  €20 per person\nSquad  →  €15 per person\nMore?  →  Open a ticket\n```', inline: false }
      )
      .setFooter({ text: 'Vexora.cc', iconURL: LOGO });
    await channel.send({ embeds: [embed] });
  } catch (e) { console.error('Could not post pricing:', e.message); }
}

// ===== Ticket panel =====
async function setupTicketPanel() {
  try {
    const channel = await client.channels.fetch(TICKET_PANEL_CHANNEL_ID);
    if (!channel) return;
    await clearBotMessages(channel);
    const embed = new EmbedBuilder()
      .setTitle('Tickets').setColor(0x5865f2)
      .setDescription('Choose a category below to open a ticket.\n\n> ⚡ Fast delivery\n> 🔒 Safe & reliable\n> 🕐 24/7 Support')
      .setThumbnail(LOGO).setFooter({ text: 'Vexora.cc', iconURL: LOGO });
    const menu = new StringSelectMenuBuilder()
      .setCustomId('ticket_category_select').setPlaceholder('Category...')
      .addOptions([
        { label: 'Support', value: 'support', emoji: '🎫' },
        { label: 'Purchase', value: 'purchase', emoji: '🛒' },
        { label: 'Bug', value: 'bug', emoji: '⚠️' },
      ]);
    const row = new ActionRowBuilder().addComponents(menu);
    await channel.send({ embeds: [embed], components: [row] });
  } catch (e) { console.error('Could not post ticket panel:', e.message); }
}

// ===== Legit poll =====
async function setupLegitPoll() {
  try {
    const channel = await client.channels.fetch(LEGIT_CHANNEL_ID);
    if (!channel) return;
    const votes = await getLegitVotes();
    const confirmed = await getConfirmedRejects();
    const embed = buildLegitEmbed(votes, confirmed);
    const row = buildLegitRow(votes);
    const messageId = await getLegitMessageId();
    if (messageId) {
      try {
        const msg = await channel.messages.fetch(messageId);
        if (msg && msg.author.id === client.user.id) {
          await msg.edit({ embeds: [embed], components: [row] });
          return;
        }
      } catch (e) {}
    }
    await clearBotMessages(channel);
    const newMsg = await channel.send({ embeds: [embed], components: [row] });
    await setLegitMessageId(newMsg.id);
  } catch (e) { console.error('Could not post legit poll:', e.message); }
}

// ===== Ticket storage =====
async function getTickets() { const d = await readGist(); return d.tickets; }
async function saveTickets(t) { const d = await readGist(); d.tickets = t; await writeGist(d); }
async function addTicket(channelId, userId, categoryKey) {
  const t = await getTickets();
  t[channelId] = { userId, categorie: categoryKey, gestart: Date.now(), extraUsers: [] };
  await saveTickets(t);
}
async function removeTicket(channelId) {
  const t = await getTickets();
  delete t[channelId];
  await saveTickets(t);
}

// ===== Not-legit ticket storage =====
async function getNotLegitTickets() { const d = await readGist(); return d.notlegitTickets; }
async function saveNotLegitTickets(n) { const d = await readGist(); d.notlegitTickets = n; await writeGist(d); }
async function setNotLegitStatus(channelId, status) {
  const n = await getNotLegitTickets();
  if (n[channelId]) {
    n[channelId].status = status;
    n[channelId].updatedAt = Date.now();
    await saveNotLegitTickets(n);
  }
}

// ===== Helpers =====
function stars(n) { return '⭐'.repeat(n) + '☆'.repeat(5 - n); }

function starRow(chosen) {
  const row = new ActionRowBuilder();
  for (let i = 1; i <= 5; i++) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`star_${i}`).setLabel(`${i} ⭐`)
        .setStyle(chosen === i ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(chosen !== null && chosen !== i)
    );
  }
  return row;
}

function submitRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('submit').setLabel('Submit').setStyle(ButtonStyle.Primary)
  );
}

function notLegitReviewRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('notlegit_positive').setLabel('Positive').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('notlegit_false').setLabel('False').setEmoji('❌').setStyle(ButtonStyle.Danger)
  );
}

// ===== Interaction handler =====
client.on('interactionCreate', async (i) => {
  // /review
  if (i.isChatInputCommand() && i.commandName === 'review') {
    if (i.channelId !== REVIEW_CHANNEL_ID) return i.reply({ content: `You can only post a review in <#${REVIEW_CHANNEL_ID}>.`, ephemeral: true });
    if (!i.member.roles.cache.has(REQUIRED_ROLE_ID)) return i.reply({ content: `You need the <@&${REQUIRED_ROLE_ID}> role to post a review.`, ephemeral: true });
    const extra = i.options.getString('extra');
    reviews.set(i.user.id, { product: PRODUCT, extra, rating: null });
    const embed = new EmbedBuilder().setTitle('Create Review').setDescription(`**Product:** ${PRODUCT}\n\nChoose a star rating.`).setColor(0x5865f2).setThumbnail(LOGO);
    return i.reply({ embeds: [embed], components: [starRow(null), submitRow()], ephemeral: true });
  }

  // /purchase
  if (i.isChatInputCommand() && i.commandName === 'purchase') {
    if (!i.member.roles.cache.has(PURCHASE_ROLE_ID)) return i.reply({ content: `You need the <@&${PURCHASE_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply();
    const targetUser = i.options.getUser('user');
    const plan = i.options.getString('plan');
    const key = i.options.getString('key');
    const duration = planDurationMs(plan);
    if (duration === undefined) return i.editReply({ content: 'Unknown plan.' });
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const member = await guild.members.fetch(targetUser.id);
      await member.roles.add(REQUIRED_ROLE_ID, `Purchase: ${plan}`);
      const { endTime } = await addPurchase(targetUser.id, plan, key);
      await updateOverview();
      const planText = plan === 'lifetime' ? 'Lifetime' : plan;
      const embed = new EmbedBuilder()
        .setTitle('Purchase Completed').setColor(0x00ff88).setThumbnail(LOGO)
        .setDescription(`Thanks for your purchase, <@${targetUser.id}>!\n\nYour plan is active and your key is shown below.`)
        .addFields(
          { name: 'Customer', value: `<@${targetUser.id}>`, inline: true },
          { name: 'Plan', value: planText, inline: true },
          { name: 'Duration', value: formatDuration(duration), inline: true },
          { name: 'Key', value: `\`\`\`${key}\`\`\``, inline: false },
          { name: 'Expires', value: endTime === null ? 'Never (Lifetime)' : `<t:${Math.floor(endTime/1000)}:F> (<t:${Math.floor(endTime/1000)}:R>)`, inline: false }
        )
        .setFooter({ text: 'Vexora.cc', iconURL: LOGO }).setTimestamp();
      await i.editReply({ embeds: [embed] });
      try {
        const dmEmbed = new EmbedBuilder()
          .setTitle('Thank you for your purchase!').setColor(0x00ff88).setThumbnail(LOGO)
          .setDescription(`Hey <@${targetUser.id}>,\n\nThanks for purchasing the **${planText} Plan** for **${PRODUCT}**!\n\nHere is your key:\n\`\`\`${key}\`\`\`\nKeep it safe!\n\nWant to leave a review? Use \`/review\`. 💙`)
          .setFooter({ text: 'Vexora.cc', iconURL: LOGO }).setTimestamp();
        await targetUser.send({ embeds: [dmEmbed] });
      } catch (e) {}
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // /removelicense
  if (i.isChatInputCommand() && i.commandName === 'removelicense') {
    if (!i.member.roles.cache.has(PURCHASE_ROLE_ID)) return i.reply({ content: `You need the <@&${PURCHASE_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply();
    const targetUser = i.options.getUser('user');
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const member = await guild.members.fetch(targetUser.id);
      const existing = await removePurchase(targetUser.id);
      if (!existing) return i.editReply({ content: `⚠️ <@${targetUser.id}> has no active license.` });
      let roleRemoved = false;
      if (member.roles.cache.has(REQUIRED_ROLE_ID)) {
        await member.roles.remove(REQUIRED_ROLE_ID, 'License removed');
        roleRemoved = true;
      }
      await updateOverview();
      const embed = new EmbedBuilder().setTitle('License Removed').setColor(0xff4444).setThumbnail(LOGO)
        .addFields(
          { name: 'Customer', value: `<@${targetUser.id}>`, inline: true },
          { name: 'Plan', value: existing.plan === 'lifetime' ? 'Lifetime' : existing.plan, inline: true },
          { name: 'Key', value: existing.key ? `\`${existing.key}\`` : 'none', inline: false },
          { name: 'Role removed', value: roleRemoved ? 'Yes' : 'No', inline: true }
        ).setFooter({ text: 'Vexora.cc', iconURL: LOGO }).setTimestamp();
      await i.editReply({ embeds: [embed] });
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // /suggestie
  if (i.isChatInputCommand() && i.commandName === 'suggestie') {
    await i.deferReply({ ephemeral: true });
    const text = i.options.getString('tekst');
    try {
      const channel = await client.channels.fetch(SUGGESTIE_CHANNEL_ID);
      const placeholder = new EmbedBuilder().setTitle('New Suggestion').setColor(0x5865f2).setThumbnail(LOGO).setDescription('Loading...').setFooter({ text: 'Vexora.cc', iconURL: LOGO }).setTimestamp();
      const msg = await channel.send({ embeds: [placeholder] });
      const suggestions = await getSuggestions();
      suggestions[msg.id] = { tekst: text, auteurId: i.user.id, approve: [], reject: [], gestart: Date.now() };
      await saveSuggestions(suggestions);
      const s = suggestions[msg.id];
      await msg.edit({ embeds: [buildSuggestionEmbed(s)], components: [buildSuggestionRow(msg.id, s)] });
      await i.editReply({ content: `Your suggestion has been posted in <#${SUGGESTIE_CHANNEL_ID}>.` });
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // /refresh
  if (i.isChatInputCommand() && i.commandName === 'refresh') {
    if (!i.member.roles.cache.has(PURCHASE_ROLE_ID)) return i.reply({ content: `You need the <@&${PURCHASE_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply({ ephemeral: true });
    try {
      await restartOverview();
      await i.editReply({ content: `Overview refreshed in <#${PURCHASE_LOG_CHANNEL_ID}>.` });
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // /removekruis
  if (i.isChatInputCommand() && i.commandName === 'removekruis') {
    if (!i.member.roles.cache.has(PURCHASE_ROLE_ID)) return i.reply({ content: `You need the <@&${PURCHASE_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply();
    const amount = i.options.getInteger('aantal');
    try {
      const votes = await getLegitVotes();
      const current = votes.reject.length;
      if (current === 0) return i.editReply({ content: '⚠️ There are currently no crosses to remove.' });
      const toRemove = Math.min(amount, current);
      votes.reject.splice(current - toRemove, toRemove);
      await saveLegitVotes(votes);
      await refreshLegitPoll();
      try {
        const logChannel = await client.channels.fetch(VOTE_LOG_CHANNEL_ID);
        if (logChannel) {
          const embed = new EmbedBuilder().setColor(0xff4444)
            .setDescription(`🧹 <@${i.user.id}> removed **${toRemove}** ❌ vote(s) from the legit poll.`)
            .setFooter({ text: 'Vexora.cc', iconURL: LOGO }).setTimestamp();
          await logChannel.send({ embeds: [embed] });
        }
      } catch (e) {}
      const embed = new EmbedBuilder().setTitle('Crosses Removed').setColor(0xff4444).setThumbnail(LOGO)
        .addFields(
          { name: 'Removed', value: `${toRemove}`, inline: true },
          { name: 'Remaining ❌', value: `${votes.reject.length}`, inline: true },
          { name: 'Total ✅', value: `${votes.approve.length}`, inline: true }
        ).setFooter({ text: 'Vexora.cc', iconURL: LOGO }).setTimestamp();
      if (toRemove < amount) embed.setDescription(`⚠️ You asked to remove **${amount}**, but there were only **${current}**.`);
      await i.editReply({ embeds: [embed] });
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // /giveaway
  if (i.isChatInputCommand() && i.commandName === 'giveaway') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) {
      return i.reply({
        content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role to start a giveaway.`,
        ephemeral: true,
      });
    }

    await i.deferReply();

    const winners = i.options.getInteger('winners');
    const item = i.options.getString('item');
    const timeStr = i.options.getString('time');
    const durationMs = parseDuration(timeStr);

    if (!durationMs || durationMs < 10 * 1000) {
      return i.editReply({ content: '⚠️ Invalid time. Use format like `30s`, `5m`, `1h`, `1d`, `1w` (minimum 10s).' });
    }
    if (durationMs > 30 * 24 * 60 * 60 * 1000) {
      return i.editReply({ content: '⚠️ Maximum duration is 30 days.' });
    }

    try {
      const endTime = Date.now() + durationMs;
      const giveaways = await getGiveaways();

      const giveawayData = {
        item,
        winners,
        eindTijd: endTime,
        gestart: Date.now(),
        kanaalId: i.channelId,
        hostId: i.user.id,
        hostTag: i.user.username,
      };

      const embed = buildGiveawayEmbed(giveawayData);
      const msg = await i.channel.send({ embeds: [embed] });
      await msg.react('🎉');

      giveawayData.messageId = msg.id;
      giveaways[msg.id] = giveawayData;
      await saveGiveaways(giveaways);

      setTimeout(() => endGiveaway(msg.id, i.channelId), durationMs);

      const confirmation = new EmbedBuilder()
        .setTitle('Giveaway Started')
        .setColor(0x00ff88)
        .setThumbnail(LOGO)
        .addFields(
          { name: 'Prize', value: item, inline: true },
          { name: 'Winners', value: `${winners}`, inline: true },
          { name: 'Duration', value: formatShortDuration(durationMs), inline: true },
          { name: 'Ends', value: `<t:${Math.floor(endTime / 1000)}:F> (<t:${Math.floor(endTime / 1000)}:R>)`, inline: false }
        )
        .setFooter({ text: 'Vexora.cc', iconURL: LOGO })
        .setTimestamp();

      await i.editReply({ embeds: [confirmation] });
    } catch (e) {
      console.error('Giveaway error:', e);
      await i.editReply({ content: `Error: ${e.message}` });
    }
    return;
  }

  // /reroll
  if (i.isChatInputCommand() && i.commandName === 'reroll') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) {
      return i.reply({
        content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role to reroll.`,
        ephemeral: true,
      });
    }

    await i.deferReply();

    const amount = i.options.getInteger('winners');

    try {
      const last = await getLastGiveaways();
      const info = last[i.channelId];

      if (!info) {
        return i.editReply({
          content: '⚠️ No ended giveaway found in this channel to reroll.',
        });
      }

      const channel = await client.channels.fetch(i.channelId);
      if (!channel) return i.editReply({ content: 'Channel not found.' });

      const msg = await channel.messages.fetch(info.messageId).catch(() => null);
      if (!msg) {
        return i.editReply({
          content: '⚠️ The original giveaway message no longer exists, cannot reroll.',
        });
      }

      const { winners, totalParticipants } = await pickWinners(msg, amount);

      if (totalParticipants === 0) {
        return i.editReply({
          content: '⚠️ There are no participants to pick from.',
        });
      }

      const g = { item: info.item, winners: amount };

      await msg.edit({ embeds: [buildGiveawayEndedEmbed(g, winners, true)] }).catch(() => {});

      if (winners.length > 0) {
        await channel.send({
          content: `🎉 **Reroll!** Congratulations ${winners.map(id => `<@${id}>`).join(', ')}! You won **${info.item}**!`,
        }).catch(() => {});

        for (const id of winners) {
          try {
            const user = await client.users.fetch(id);
            await user.send({
              embeds: [
                new EmbedBuilder()
                  .setTitle('🎉 You won a giveaway!')
                  .setColor(0x00ff88)
                  .setThumbnail(LOGO)
                  .setDescription(`Congratulations! You won **${info.item}** in the **Vexora.cc** reroll!`)
                  .setFooter({ text: 'Vexora.cc', iconURL: LOGO })
                  .setTimestamp(),
              ],
            });
          } catch (e) {}
        }
      }

      const confirmation = new EmbedBuilder()
        .setTitle('Reroll Complete')
        .setColor(0x00ff88)
        .setThumbnail(LOGO)
        .addFields(
          { name: 'Prize', value: info.item, inline: true },
          { name: 'New winners', value: `${winners.length}`, inline: true },
          { name: 'Total participants', value: `${totalParticipants}`, inline: true }
        )
        .setFooter({ text: 'Vexora.cc', iconURL: LOGO })
        .setTimestamp();

      await i.editReply({ embeds: [confirmation] });
    } catch (e) {
      console.error('Reroll error:', e);
      await i.editReply({ content: `Error: ${e.message}` });
    }
    return;
  }

  // /clear
  if (i.isChatInputCommand() && i.commandName === 'clear') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) {
      return i.reply({
        content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role to delete messages.`,
        ephemeral: true,
      });
    }

    await i.deferReply({ ephemeral: true });

    const amount = i.options.getInteger('amount');

    try {
      const deleted = await i.channel.bulkDelete(amount, true);

      const embed = new EmbedBuilder()
        .setTitle('Messages Deleted')
        .setColor(0xff4444)
        .setThumbnail(LOGO)
        .addFields(
          { name: 'Deleted', value: `${deleted.size}`, inline: true },
          { name: 'Channel', value: `<#${i.channelId}>`, inline: true },
          { name: 'By', value: `<@${i.user.id}>`, inline: true }
        )
        .setFooter({ text: 'Vexora.cc', iconURL: LOGO })
        .setTimestamp();

      await i.editReply({ embeds: [embed] });

      try {
        const logChannel = await client.channels.fetch(VOTE_LOG_CHANNEL_ID);
        if (logChannel) {
          const logEmbed = new EmbedBuilder()
            .setColor(0xff4444)
            .setDescription(`🧹 <@${i.user.id}> deleted **${deleted.size}** message(s) in <#${i.channelId}>.`)
            .setFooter({ text: 'Vexora.cc', iconURL: LOGO })
            .setTimestamp();
          await logChannel.send({ embeds: [logEmbed] });
        }
      } catch (e) {}
    } catch (e) {
      console.error('Clear error:', e);
      await i.editReply({
        content: `Error: ${e.message}\n\nNote: messages older than 14 days cannot be bulk deleted.`,
      });
    }
    return;
  }

  // /ban
  if (i.isChatInputCommand() && i.commandName === 'ban') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) {
      return i.reply({
        content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role to ban users.`,
        ephemeral: true,
      });
    }

    await i.deferReply();

    const targetUser = i.options.getUser('user');
    const durationStr = i.options.getString('duration');
    const reason = i.options.getString('reason') || 'No reason provided';

    let durationMs = null;
    if (durationStr) {
      durationMs = parseDuration(durationStr);
      if (!durationMs) {
        return i.editReply({ content: '⚠️ Invalid duration. Use format like `1h`, `1d`, `1w`, `30m`.' });
      }
      if (durationMs < 60 * 1000) {
        return i.editReply({ content: '⚠️ Minimum duration is 1 minute.' });
      }
      if (durationMs > 365 * 24 * 60 * 60 * 1000) {
        return i.editReply({ content: '⚠️ Maximum duration is 1 year.' });
      }
    }

    try {
      const guild = await client.guilds.fetch(GUILD_ID);

      const existingBan = await guild.bans.fetch(targetUser.id).catch(() => null);
      if (existingBan) {
        return i.editReply({ content: `⚠️ <@${targetUser.id}> is already banned.` });
      }

      try {
        const dmEmbed = new EmbedBuilder()
          .setTitle('You have been banned')
          .setColor(0xff4444)
          .setThumbnail(LOGO)
          .addFields(
            { name: 'Server', value: 'Vexora.cc', inline: true },
            { name: 'Duration', value: durationMs ? formatShortDuration(durationMs) : 'Permanent', inline: true },
            { name: 'Reason', value: reason, inline: false }
          )
          .setFooter({ text: 'Vexora.cc', iconURL: LOGO })
          .setTimestamp();
        await targetUser.send({ embeds: [dmEmbed] });
      } catch (e) {}

      await guild.bans.create(targetUser.id, { reason: `${reason} | by ${i.user.tag}` });

      if (durationMs) {
        await addTemporaryBan(targetUser.id, GUILD_ID, Date.now() + durationMs);
      }

      try {
        const logChannel = await client.channels.fetch(BAN_LOG_CHANNEL_ID);
        if (logChannel) {
          const logEmbed = new EmbedBuilder()
            .setColor(0xff4444)
            .setTitle('🔨 Ban')
            .setThumbnail(targetUser.displayAvatarURL())
            .addFields(
              { name: 'User', value: `${targetUser.tag} (<@${targetUser.id}>)`, inline: false },
              { name: 'Moderator', value: `<@${i.user.id}>`, inline: true },
              { name: 'Duration', value: durationMs ? formatShortDuration(durationMs) : 'Permanent', inline: true },
              { name: 'Reason', value: reason, inline: false }
            )
            .setFooter({ text: 'Vexora.cc', iconURL: LOGO })
            .setTimestamp();
          await logChannel.send({ embeds: [logEmbed] });
        }
      } catch (e) {}

      const embed = new EmbedBuilder()
        .setTitle('User Banned')
        .setColor(0xff4444)
        .setThumbnail(LOGO)
        .addFields(
          { name: 'User', value: `<@${targetUser.id}>`, inline: true },
          { name: 'Duration', value: durationMs ? formatShortDuration(durationMs) : 'Permanent', inline: true },
          { name: 'Reason', value: reason, inline: false }
        )
        .setFooter({ text: 'Vexora.cc', iconURL: LOGO })
        .setTimestamp();

      if (durationMs) {
        embed.addFields({
          name: 'Expires',
          value: `<t:${Math.floor((Date.now() + durationMs) / 1000)}:F> (<t:${Math.floor((Date.now() + durationMs) / 1000)}:R>)`,
          inline: false,
        });
      }

      await i.editReply({ embeds: [embed] });
    } catch (e) {
      console.error('Ban error:', e);
      await i.editReply({ content: `Error: ${e.message}` });
    }
    return;
  }

  // /unban
  if (i.isChatInputCommand() && i.commandName === 'unban') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) {
      return i.reply({
        content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role to unban users.`,
        ephemeral: true,
      });
    }

    await i.deferReply();

    const userId = i.options.getString('user_id').trim();
    const reason = i.options.getString('reason') || 'No reason provided';

    if (!/^\d{17,20}$/.test(userId)) {
      return i.editReply({ content: '⚠️ Invalid Discord ID. It must be 17-20 digits.' });
    }

    try {
      const guild = await client.guilds.fetch(GUILD_ID);

      const existingBan = await guild.bans.fetch(userId).catch(() => null);
      if (!existingBan) {
        return i.editReply({ content: `⚠️ User \`${userId}\` is not banned.` });
      }

      await guild.bans.remove(userId, `${reason} | by ${i.user.tag}`);
      await removeBanRecord(userId, GUILD_ID);

      try {
        const logChannel = await client.channels.fetch(BAN_LOG_CHANNEL_ID);
        if (logChannel) {
          const logEmbed = new EmbedBuilder()
            .setColor(0x00ff88)
            .setTitle('🔓 Unban')
            .addFields(
              { name: 'User', value: `${existingBan.user.tag} (<@${userId}>)`, inline: false },
              { name: 'Moderator', value: `<@${i.user.id}>`, inline: true },
              { name: 'Reason', value: reason, inline: false }
            )
            .setFooter({ text: 'Vexora.cc', iconURL: LOGO })
            .setTimestamp();
          await logChannel.send({ embeds: [logEmbed] });
        }
      } catch (e) {}

      const embed = new EmbedBuilder()
        .setTitle('User Unbanned')
        .setColor(0x00ff88)
        .setThumbnail(LOGO)
        .addFields(
          { name: 'User', value: `${existingBan.user.tag} (<@${userId}>)`, inline: false },
          { name: 'Reason', value: reason, inline: false }
        )
        .setFooter({ text: 'Vexora.cc', iconURL: LOGO })
        .setTimestamp();

      await i.editReply({ embeds: [embed] });
    } catch (e) {
      console.error('Unban error:', e);
      await i.editReply({ content: `Error: ${e.message}` });
    }
    return;
  }

  // /add
  if (i.isChatInputCommand() && i.commandName === 'add') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) {
      return i.reply({
        content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role to add users.`,
        ephemeral: true,
      });
    }

    await i.deferReply({ ephemeral: true });

    const tickets = await getTickets();
    const ticket = tickets[i.channelId];
    if (!ticket) return i.editReply({ content: 'This is not an active ticket.' });

    const targetUser = i.options.getUser('user');

    try {
      await i.channel.permissionOverwrites.edit(targetUser.id, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        AttachFiles: true,
      });

      if (!ticket.extraUsers) ticket.extraUsers = [];
      if (!ticket.extraUsers.includes(targetUser.id)) ticket.extraUsers.push(targetUser.id);
      tickets[i.channelId] = ticket;
      await saveTickets(tickets);

      await i.channel.send({ content: `➕ <@${targetUser.id}> has been added to this ticket by <@${i.user.id}>.` });
      await i.editReply({ content: `✅ <@${targetUser.id}> has been added.` });
    } catch (e) {
      console.error('Add error:', e);
      await i.editReply({ content: `Error: ${e.message}` });
    }
    return;
  }

  // /remove
  if (i.isChatInputCommand() && i.commandName === 'remove') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) {
      return i.reply({
        content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role to remove users.`,
        ephemeral: true,
      });
    }

    await i.deferReply({ ephemeral: true });

    const tickets = await getTickets();
    const ticket = tickets[i.channelId];
    if (!ticket) return i.editReply({ content: 'This is not an active ticket.' });

    const targetUser = i.options.getUser('user');

    if (targetUser.id === ticket.userId) {
      return i.editReply({ content: '⚠️ You cannot remove the ticket owner. Use `/close` instead.' });
    }

    try {
      await i.channel.permissionOverwrites.delete(targetUser.id);

      if (ticket.extraUsers) {
        ticket.extraUsers = ticket.extraUsers.filter(id => id !== targetUser.id);
        tickets[i.channelId] = ticket;
        await saveTickets(tickets);
      }

      await i.channel.send({ content: `➖ <@${targetUser.id}> has been removed from this ticket by <@${i.user.id}>.` });
      await i.editReply({ content: `✅ <@${targetUser.id}> has been removed.` });
    } catch (e) {
      console.error('Remove error:', e);
      await i.editReply({ content: `Error: ${e.message}` });
    }
    return;
  }

  // /close
  if (i.isChatInputCommand() && i.commandName === 'close') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) {
      return i.reply({
        content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role to close tickets.`,
        ephemeral: true,
      });
    }

    const tickets = await getTickets();
    if (!tickets[i.channelId]) {
      return i.reply({ content: 'This is not an active ticket.', ephemeral: true });
    }

    await i.reply({ content: '🔒 Ticket is being closed and transcript is being saved...' });

    const result = await closeTicket(i.channel, i.user.id);
    if (!result.ok) {
      console.error('Could not close ticket:', result.reason);
    }
    return;
  }

  // /rename
  if (i.isChatInputCommand() && i.commandName === 'rename') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) {
      return i.reply({
        content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role to rename tickets.`,
        ephemeral: true,
      });
    }

    await i.deferReply({ ephemeral: true });

    const tickets = await getTickets();
    if (!tickets[i.channelId]) {
      return i.editReply({ content: 'This is not an active ticket.' });
    }

    const newName = i.options.getString('name')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 100);

    if (!newName) {
      return i.editReply({ content: '⚠️ Invalid name. Use only letters, numbers and dashes.' });
    }

    try {
      const oldName = i.channel.name;
      await i.channel.setName(newName);

      await i.channel.send({ content: `✏️ Ticket renamed from \`${oldName}\` to \`${newName}\` by <@${i.user.id}>.` });
      await i.editReply({ content: `✅ Ticket renamed to \`${newName}\`.` });
    } catch (e) {
      console.error('Rename error:', e);
      await i.editReply({ content: `Error: ${e.message}` });
    }
    return;
  }

  // Ticket category select
  if (i.isStringSelectMenu() && i.customId === 'ticket_category_select') {
    await i.deferReply({ ephemeral: true });
    const choice = i.values[0];
    const cat = TICKET_CATEGORIES[choice];
    if (!cat) return i.editReply({ content: 'Unknown category.' });
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const tickets = await getTickets();
      const existing = Object.entries(tickets).find(([_, t]) => t.userId === i.user.id);
      if (existing) return i.editReply({ content: `You already have an open ticket: <#${existing[0]}>` });
      const channelName = `${cat.prefix}-${i.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
      const ticketChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: cat.categoryId,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
          { id: TICKET_SUPPORT_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] },
          { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
        ],
        topic: `Ticket from ${i.user.tag} — ${cat.name}`,
      });
      await addTicket(ticketChannel.id, i.user.id, choice);
      const embed = new EmbedBuilder().setTitle(cat.name).setColor(cat.color)
        .setDescription(`<@${i.user.id}> — describe your question below.`)
        .setFooter({ text: 'Vexora.cc', iconURL: LOGO }).setTimestamp();
      const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket_close').setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger)
      );
      await ticketChannel.send({ content: `<@${i.user.id}> <@&${TICKET_SUPPORT_ROLE_ID}>`, embeds: [embed], components: [closeRow] });
      await i.editReply({ content: `Ticket created: <#${ticketChannel.id}>` });
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // Buttons
  if (i.isButton()) {
    // ===== VERIFY =====
    if (i.customId === 'verify_button') {
      try {
        if (i.member.roles.cache.has(VERIFY_ROLE_ID)) return i.reply({ content: 'You are already verified.', ephemeral: true });
        await i.member.roles.add(VERIFY_ROLE_ID, 'Verified via button');
        await i.reply({ content: '✅ You are verified! Welcome to Vexora.cc.', ephemeral: true });
      } catch (e) { await i.reply({ content: `Error: ${e.message}`, ephemeral: true }); }
      return;
    }

    // ===== LEGIT POLL =====
    if (i.customId === 'legit_approve') {
      try {
        const votes = await getLegitVotes();
        const userId = i.user.id;
        votes.approve = votes.approve.filter(id => id !== userId);
        votes.reject = votes.reject.filter(id => id !== userId);
        votes.approve.push(userId);
        const confirmed = await getConfirmedRejects();
        const newConfirmed = confirmed.filter(id => id !== userId);
        if (newConfirmed.length !== confirmed.length) await saveConfirmedRejects(newConfirmed);
        await saveLegitVotes(votes);
        await refreshLegitPoll();
        await i.reply({ content: '✅ Your vote has been saved as **Legit**.', ephemeral: true });
        await logVote(userId, 'approve', '**Are we legit?**');
      } catch (e) { await i.reply({ content: `Error: ${e.message}`, ephemeral: true }); }
      return;
    }

    if (i.customId === 'legit_reject') {
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const tickets = await getTickets();

        const existingNotLegit = Object.entries(tickets).find(
          ([_, t]) => t.userId === i.user.id && t.categorie === 'notlegit'
        );
        if (existingNotLegit) {
          return i.reply({
            content: `You already have an open proof ticket: <#${existingNotLegit[0]}>. Upload your proof there.`,
            ephemeral: true,
          });
        }

        await i.deferReply({ ephemeral: true });

        // ⚠️ GEEN stemregistratie hier — pas na Positive door staff.

        const cat = TICKET_CATEGORIES.notlegit;
        const channelName = `notlegit-${i.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 90);
        const ticketChannel = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: NOT_LEGIT_TICKET_CATEGORY_ID,
          permissionOverwrites: [
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
            { id: TICKET_SUPPORT_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] },
            { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
          ],
          topic: `Not-Legit proof from ${i.user.tag}`,
        });

        await addTicket(ticketChannel.id, i.user.id, 'notlegit');

        const notLegitStore = await getNotLegitTickets();
        notLegitStore[ticketChannel.id] = {
          userId: i.user.id,
          status: 'pending',
          createdAt: Date.now(),
        };
        await saveNotLegitTickets(notLegitStore);

        // Korte, duidelijke Engelse tekst
        const promptEmbed = new EmbedBuilder()
          .setTitle('Upload proof')
          .setColor(0xff4444)
          .setThumbnail(LOGO)
          .setDescription(
            `Please upload your proof here (screenshots, video, files).\n\n` +
            `Staff will review it and click **Positive** or **False**.`
          )
          .setFooter({ text: 'Vexora.cc', iconURL: LOGO })
          .setTimestamp();

        const closeRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('ticket_close').setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger)
        );

        await ticketChannel.send({
          content: `<@${i.user.id}> <@&${TICKET_SUPPORT_ROLE_ID}>`,
          embeds: [promptEmbed],
          components: [notLegitReviewRow(), closeRow],
        });

        await i.editReply({ content: `✅ Ticket created: <#${ticketChannel.id}> — upload your proof there.` });
      } catch (e) {
        console.error('legit_reject error:', e);
        try { await i.editReply({ content: `Error: ${e.message}` }); } catch (_) {}
      }
      return;
    }

    // ===== NOT-LEGIT REVIEW (Positive / False) =====
    if (i.customId === 'notlegit_positive' || i.customId === 'notlegit_false') {
      if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) {
        return i.reply({ content: `Only staff with the <@&${TICKET_SUPPORT_ROLE_ID}> role can review this.`, ephemeral: true });
      }

      await i.deferReply({ ephemeral: true });

      const nlt = await getNotLegitTickets();
      const entry = nlt[i.channelId];
      const tickets = await getTickets();
      const ticket = tickets[i.channelId];

      if (!entry || !ticket || ticket.categorie !== 'notlegit') {
        return i.editReply({ content: 'This is not an active Not-Legit proof ticket.' });
      }
      if (entry.status !== 'pending') {
        return i.editReply({ content: `This ticket has already been reviewed as **${entry.status}**.` });
      }

      try {
        const targetUserId = entry.userId;
        const votes = await getLegitVotes();
        const confirmed = await getConfirmedRejects();

        if (i.customId === 'notlegit_positive') {
          // ✅ PAS NU de ❌-stem toevoegen + bevestigen
          if (!votes.reject.includes(targetUserId)) votes.reject.push(targetUserId);
          if (!confirmed.includes(targetUserId)) confirmed.push(targetUserId);
          await saveLegitVotes(votes);
          await saveConfirmedRejects(confirmed);
          await setNotLegitStatus(i.channelId, 'positive');

          await refreshLegitPoll();

          const embed = new EmbedBuilder()
            .setTitle('✅ Reviewed: Positive')
            .setColor(0x00ff88)
            .setThumbnail(LOGO)
            .setDescription(
              `Proof from <@${targetUserId}> is **valid**.\n\n` +
              `The ❌ vote has been added and confirmed on the legit poll.\n\n` +
              `Reviewed by: <@${i.user.id}>`
            )
            .setFooter({ text: 'Vexora.cc', iconURL: LOGO })
            .setTimestamp();
          await i.channel.send({ embeds: [embed] });

          try {
            const logChannel = await client.channels.fetch(VOTE_LOG_CHANNEL_ID);
            if (logChannel) {
              const logEmbed = new EmbedBuilder()
                .setColor(0x00ff88)
                .setDescription(`✅ **Not-Legit confirmed** — <@${targetUserId}> (proof approved by <@${i.user.id}>)\nTicket: #${i.channel.name}`)
                .setFooter({ text: 'Vexora.cc', iconURL: LOGO })
                .setTimestamp();
              await logChannel.send({ embeds: [logEmbed] });
            }
          } catch (e) {}

          await i.editReply({ content: '✅ Reviewed as **Positive**. The vote has been added and confirmed.' });
        } else {
          // ❌ False → er was nog geen stem, dus niets aan de teller veranderen
          await setNotLegitStatus(i.channelId, 'false');

          const embed = new EmbedBuilder()
            .setTitle('❌ Reviewed: False')
            .setColor(0xff4444)
            .setThumbnail(LOGO)
            .setDescription(
              `Proof from <@${targetUserId}> is **not valid**.\n\n` +
              `No vote has been added to the legit poll.\n\n` +
              `Reviewed by: <@${i.user.id}>`
            )
            .setFooter({ text: 'Vexora.cc', iconURL: LOGO })
            .setTimestamp();
          await i.channel.send({ embeds: [embed] });

          try {
            const logChannel = await client.channels.fetch(VOTE_LOG_CHANNEL_ID);
            if (logChannel) {
              const logEmbed = new EmbedBuilder()
                .setColor(0xff4444)
                .setDescription(`❌ **Not-Legit rejected** — <@${targetUserId}> (proof rejected by <@${i.user.id}>)\nTicket: #${i.channel.name}`)
                .setFooter({ text: 'Vexora.cc', iconURL: LOGO })
                .setTimestamp();
              await logChannel.send({ embeds: [logEmbed] });
            }
          } catch (e) {}

          await i.editReply({ content: '❌ Reviewed as **False**. No vote was added.' });
        }
      } catch (e) {
        console.error('notlegit review error:', e);
        try { await i.editReply({ content: `Error: ${e.message}` }); } catch (_) {}
      }
      return;
    }

    // ===== TICKET CLOSE =====
    if (i.customId === 'ticket_close') {
      try {
        const tickets = await getTickets();
        const ticket = tickets[i.channelId];
        if (!ticket) return i.reply({ content: 'This is not an active ticket.', ephemeral: true });
        const isOwner = ticket.userId === i.user.id;
        const isStaff = i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID);
        if (!isOwner && !isStaff) return i.reply({ content: 'You cannot close this ticket.', ephemeral: true });
        await i.reply({ content: '🔒 Ticket is being closed...' });
        await closeTicket(i.channel, i.user.id);
      } catch (e) { await i.reply({ content: `Error: ${e.message}`, ephemeral: true }); }
      return;
    }

    // ===== SUGGESTIONS =====
    if (i.customId.startsWith('suggest_approve_') || i.customId.startsWith('suggest_reject_')) {
      const messageId = i.customId.split('_').pop();
      if (!i.member.roles.cache.has(REQUIRED_ROLE_ID)) return i.reply({ content: `You need the <@&${REQUIRED_ROLE_ID}> role to vote.`, ephemeral: true });
      try {
        const suggestions = await getSuggestions();
        const s = suggestions[messageId];
        if (!s) return i.reply({ content: 'This suggestion no longer exists.', ephemeral: true });
        const isApprove = i.customId.startsWith('suggest_approve_');
        const userId = i.user.id;
        s.approve = s.approve.filter(id => id !== userId);
        s.reject = s.reject.filter(id => id !== userId);
        if (isApprove) s.approve.push(userId);
        else s.reject.push(userId);
        await saveSuggestions(suggestions);
        await i.update({ embeds: [buildSuggestionEmbed(s)], components: [buildSuggestionRow(messageId, s)] });
        await logVote(userId, isApprove ? 'approve' : 'reject', `suggestion: **${s.tekst.slice(0, 80)}${s.tekst.length > 80 ? '...' : ''}**`);
      } catch (e) { await i.reply({ content: `Error: ${e.message}`, ephemeral: true }); }
      return;
    }

    // ===== REVIEW STARS =====
    const review = reviews.get(i.user.id);
    if (!review) return i.reply({ content: 'This review has expired. Use /review again.', ephemeral: true });

    if (i.customId.startsWith('star_')) {
      const n = parseInt(i.customId.split('_')[1]);
      review.rating = n;
      return i.update({ components: [starRow(n), submitRow()] });
    }

    if (i.customId === 'submit') {
      if (!review.rating) return i.reply({ content: 'Choose a star rating first.', ephemeral: true });
      await i.deferUpdate();
      let number;
      try { number = await nextNumber(i.channel); } catch (e) { number = '?'; }
      if (number !== '?') {
        try { await writeCounter(number); cachedCounter = number; } catch (e) {}
      }
      const embed = new EmbedBuilder()
        .setTitle(`Review #${number}`).setColor(0xffd700).setTimestamp()
        .setAuthor({ name: i.user.displayName, iconURL: i.user.displayAvatarURL() })
        .addFields(
          { name: 'Product', value: review.product },
          { name: 'Rating', value: `${stars(review.rating)} (${review.rating}/5)` },
          { name: 'Extra', value: review.extra }
        ).setThumbnail(LOGO).setFooter({ text: 'Vexora.cc', iconURL: LOGO });
      await i.editReply({ components: [] });
      await i.channel.send({ embeds: [embed] });
      reviews.delete(i.user.id);
    }
  }
});

// ===== Member leave =====
client.on('guildMemberRemove', async (member) => {
  if (member.guild.id !== GUILD_ID) return;
  try {
    const purchases = await getPurchases();
    const had = purchases.find(p => p.userId === member.id);
    if (!had) return;
    const filtered = purchases.filter(p => p.userId !== member.id);
    await savePurchases(filtered);
    await updateOverview();
  } catch (e) {}
});

// ===== Channel delete =====
client.on('channelDelete', async (channel) => {
  try {
    const tickets = await getTickets();
    if (tickets[channel.id]) {
      delete tickets[channel.id];
      await saveTickets(tickets);
    }
    const nlt = await getNotLegitTickets();
    if (nlt[channel.id]) {
      delete nlt[channel.id];
      await saveNotLegitTickets(nlt);
    }
  } catch (e) {}
});

// ===== Ready =====
client.once('ready', async () => {
  console.log(`Online as ${client.user.tag}`);
  startStatusInterval();
  startExpiryInterval();
  startBanInterval();

  await updateOverview();
  startOverzichtInterval();

  await setupVerify();
  await setupPricing();
  await setupTicketPanel();
  await setupLegitPoll();

  await restoreGiveaways();
});

client.login(TOKEN);
