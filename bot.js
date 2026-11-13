require('dotenv').config();
const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle, ChannelType, PermissionFlagsBits, AttachmentBuilder,
  REST, Routes,
} = require('discord.js');
const http = require('http');
const crypto = require('crypto');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const GIST_ID = process.env.GIST_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const LOGO = 'https://cdn.discordapp.com/attachments/1567554042039771136/1570551432594063360/logo_rifle.png?ex=6af78180&is=6af63000&hm=41f5f60378d370bcbc50b0353922b61884533ba5ff080665c59d814c503b6749&';
const PORT = process.env.PORT || 3000;

// ============================================================================
//  License keys  -  HWID bound
//  Storage: the same GitHub gist the bot already uses ("keys" field).
//  API:     POST /auth/login   { "key": "SCORPION-....", "hwid": "<hash>" }
//           GET  /auth/ping
//  readGist/writeGist are function declarations, so they are hoisted and can be
//  used here even though they are defined further down in this file.
// ============================================================================

// Only these two Discord accounts may use the key commands.
const KEY_ADMIN_IDS = new Set([
  '1033753872927293520',
  '710623438657683486',
]);

const KEY_PREFIX = 'SCORPION';
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const KEY_PATTERN = /^SCORPION-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

// Plan -> duration. null = lifetime.
const PLAN_MS = {
  '1 week': 7 * 24 * 60 * 60 * 1000,
  '1 month': 30.5 * 24 * 60 * 60 * 1000,
  'lifetime': null,
};

const PLAN_CHOICES = [
  { name: '1 week', value: '1 week' },
  { name: '1 month', value: '1 month' },
  { name: 'Lifetime', value: 'lifetime' },
];

const KEY_EMBED_COLOR = 0x2b2b2b;
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW = 60 * 1000;
const LAST_SEEN_THROTTLE = 60 * 1000;

// ---- key helpers -----------------------------------------------------------

function generateKey() {
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let part = '';
    for (let i = 0; i < 4; i++) part += KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)];
    groups.push(part);
  }
  return KEY_PREFIX + '-' + groups.join('-');
}

function normalizeKey(input) {
  if (!input) return '';
  const cleaned = String(input).trim().toUpperCase().replace(/\s+/g, '');
  if (KEY_PATTERN.test(cleaned)) return cleaned;
  const bare = cleaned.replace(/-/g, '');
  if (/^SCORPION[A-Z0-9]{16}$/.test(bare)) {
    return bare.slice(0, 8) + '-' + bare.slice(8, 12) + '-' + bare.slice(12, 16) +
      '-' + bare.slice(16, 20) + '-' + bare.slice(20, 24);
  }
  return cleaned;
}

function parseKeyDuration(input) {
  const m = String(input || '').trim().toLowerCase().match(/^(\d+)\s*(s|m|h|d|w)$/);
  if (!m) return null;
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  return parseInt(m[1], 10) * mult[m[2]];
}

function formatStamp(ms) {
  if (ms === null || ms === undefined) return 'Lifetime';
  return '<t:' + Math.floor(ms / 1000) + ':F> (<t:' + Math.floor(ms / 1000) + ':R>)';
}

function maskHwid(hwid) {
  if (!hwid) return 'not bound';
  if (hwid.length <= 16) return hwid;
  return hwid.slice(0, 12) + '...' + hwid.slice(-4);
}

function newKeyRecord(plan, product, createdBy, note) {
  return {
    plan: plan,
    product: product || null,
    hwid: null,
    username: null,
    createdBy: createdBy,
    createdAt: Date.now(),
    activatedAt: null,
    expiresAt: null,
    pendingMs: 0,
    paused: false,
    pausedAt: null,
    banned: false,
    lastSeen: null,
    note: note || '',
  };
}

function keyStatusOf(rec) {
  if (rec.banned) return 'revoked';
  if (rec.paused) return 'paused';
  if (!rec.hwid) return 'unbound';
  if (rec.expiresAt !== null && rec.expiresAt !== undefined && Date.now() > rec.expiresAt) return 'expired';
  return 'active';
}

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req, limit) {
  limit = limit || 4096;
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > limit) { reject(new Error('payload_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      if (!chunks.length) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

const rateBuckets = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.reset) {
    rateBuckets.set(ip, { count: 1, reset: now + RATE_LIMIT_WINDOW });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX;
}

function clientIp(req) {
  const fwd = req.headers && req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// ---- key system ------------------------------------------------------------

function createKeySystem(opts) {
  const readGist = opts.readGist;
  const writeGist = opts.writeGist;

  // Serialize every read-modify-write of the gist so concurrent logins and
  // admin commands cannot clobber each other.
  let lock = Promise.resolve();

  function mutate(mutator) {
    const task = lock.then(async function () {
      const data = await readGist();
      if (!data.keys || typeof data.keys !== 'object') data.keys = {};
      const out = await mutator(data.keys, data);
      const dirty = !out || out.dirty !== false;
      if (dirty) await writeGist(data);
      return out ? out.result : undefined;
    });
    lock = task.then(function () {}, function () {});
    return task;
  }

  // ---- auth ---------------------------------------------------------------

  function authLogin(key, hwid, username) {
    return mutate(function (keys) {
      const rec = keys[key];
      if (!rec) return { result: { status: 401, body: { ok: false, error: 'invalid_key' } }, dirty: false };
      if (rec.banned) return { result: { status: 403, body: { ok: false, error: 'revoked' } }, dirty: false };

      const now = Date.now();
      if (rec.paused) return { result: { status: 403, body: { ok: false, error: 'paused' } }, dirty: false };
      if (rec.expiresAt !== null && rec.expiresAt !== undefined && now > rec.expiresAt) {
        return { result: { status: 403, body: { ok: false, error: 'expired' } }, dirty: false };
      }
      if (rec.hwid && rec.hwid !== hwid) {
        return { result: { status: 409, body: { ok: false, error: 'hwid_mismatch' } }, dirty: false };
      }

      let dirty = false;

      if (!rec.hwid) {
        rec.hwid = hwid;
        if (!rec.activatedAt) {
          rec.activatedAt = now;
          const dur = PLAN_MS[rec.plan];
          rec.expiresAt = (dur === null || dur === undefined)
            ? null
            : now + dur + (rec.pendingMs || 0);
          rec.pendingMs = 0;
        }
        dirty = true;
      }

      if (!rec.lastSeen || now - rec.lastSeen > LAST_SEEN_THROTTLE) {
        rec.lastSeen = now;
        dirty = true;
      }

      // Keep the display name the user typed in the loader (shown in /keyinfo).
      if (username && rec.username !== username) {
        rec.username = username;
        dirty = true;
      }

      return {
        result: {
          status: 200,
          body: {
            ok: true,
            plan: rec.plan,
            product: rec.product || null,
            expiresAt: rec.expiresAt === undefined ? null : rec.expiresAt,
            activatedAt: rec.activatedAt || null,
          },
        },
        dirty: dirty,
      };
    });
  }

  // ---- http ---------------------------------------------------------------

  async function handleAuthRequest(req, res, url) {
    if (req.method === 'GET' && (url === '/auth/ping' || url === '/health')) {
      sendJson(res, 200, { ok: true, service: 'scorpion-auth' });
      return;
    }

    if (req.method === 'POST' && url === '/auth/login') {
      if (isRateLimited(clientIp(req))) {
        sendJson(res, 429, { ok: false, error: 'rate_limited' });
        return;
      }

      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: 'bad_request' });
        return;
      }

      const key = normalizeKey(body.key);
      const hwid = typeof body.hwid === 'string' ? body.hwid.trim() : '';
      const username = typeof body.username === 'string'
        ? body.username.trim().slice(0, 64)
        : '';

      if (!KEY_PATTERN.test(key)) {
        sendJson(res, 400, { ok: false, error: 'invalid_key_format' });
        return;
      }
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(hwid)) {
        sendJson(res, 400, { ok: false, error: 'invalid_hwid' });
        return;
      }

      try {
        const out = await authLogin(key, hwid, username);
        sendJson(res, out.status, out.body);
      } catch (e) {
        sendJson(res, 500, { ok: false, error: 'server_error' });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not_found' });
  }

  // Synchronous router: returns true when the request belongs to the auth API.
  function handleHttp(req, res) {
    const url = (req.url || '/').split('?')[0];
    const isAuth = url === '/auth/login' || url === '/auth/ping' || url === '/health';
    if (!isAuth) return false;
    handleAuthRequest(req, res, url).catch(function () {
      sendJson(res, 500, { ok: false, error: 'server_error' });
    });
    return true;
  }

  // ---- admin commands -----------------------------------------------------

  const commands = [
    {
      name: 'keygen',
      description: 'Generate license keys',
      options: [
        { name: 'plan', description: 'Plan for the keys', type: 3, required: true, choices: PLAN_CHOICES },
        { name: 'amount', description: 'How many keys (1-25)', type: 4, required: false, min_value: 1, max_value: 25 },
        { name: 'note', description: 'Optional note', type: 3, required: false },
      ],
    },
    {
      name: 'keyinfo',
      description: 'Show info about a license key',
      options: [{ name: 'key', description: 'License key', type: 3, required: true }],
    },
    {
      name: 'keyreset',
      description: 'Unbind the HWID of a key so it can be used on another PC',
      options: [{ name: 'key', description: 'License key', type: 3, required: true }],
    },
    {
      name: 'keyrevoke',
      description: 'Revoke a license key',
      options: [
        { name: 'key', description: 'License key', type: 3, required: true },
        { name: 'reason', description: 'Reason', type: 3, required: false },
      ],
    },
    {
      name: 'keylist',
      description: 'List license keys',
      options: [{ name: 'plan', description: 'Filter by plan', type: 3, required: false, choices: PLAN_CHOICES }],
    },
    {
      name: 'pause',
      description: 'Pause or resume the countdown of a key',
      options: [{ name: 'key', description: 'License key', type: 3, required: true }],
    },
    {
      name: 'extend',
      description: 'Add time to a key (e.g. 7d, 12h)',
      options: [
        { name: 'key', description: 'License key', type: 3, required: true },
        { name: 'duration', description: 'Amount of time, e.g. 7d / 12h / 30m', type: 3, required: true },
      ],
    },
    {
      name: 'shorten',
      description: 'Remove time from a key (e.g. 7d, 12h)',
      options: [
        { name: 'key', description: 'License key', type: 3, required: true },
        { name: 'duration', description: 'Amount of time, e.g. 7d / 12h / 30m', type: 3, required: true },
      ],
    },
  ];

  function keyEmbed(title, fields) {
    return new EmbedBuilder().setTitle(title).setColor(KEY_EMBED_COLOR).addFields(fields);
  }

  async function cmdKeygen(i) {
    const plan = i.options.getString('plan');
    const amount = i.options.getInteger('amount') || 1;
    const note = i.options.getString('note') || '';

    if (!(plan in PLAN_MS)) {
      await i.reply({ content: 'Unknown plan.', ephemeral: true });
      return;
    }

    await i.deferReply({ ephemeral: true });

    const created = await mutate(function (keys) {
      const list = [];
      for (let n = 0; n < amount; n++) {
        let key = generateKey();
        while (keys[key]) key = generateKey();
        keys[key] = newKeyRecord(plan, null, i.user.id, note);
        list.push(key);
      }
      return { result: list, dirty: true };
    });

    await i.editReply({
      embeds: [keyEmbed('🔑 Keys generated', [
        { name: 'Plan', value: plan, inline: true },
        { name: 'Amount', value: String(created.length), inline: true },
        { name: 'Keys', value: '```\n' + created.join('\n') + '\n```', inline: false },
      ]).setFooter({ text: 'Scorpion' }).setTimestamp()],
    });
  }

  async function cmdKeyinfo(i) {
    const key = normalizeKey(i.options.getString('key'));
    await i.deferReply({ ephemeral: true });

    const data = await readGist();
    const rec = data.keys ? data.keys[key] : null;
    if (!rec) {
      await i.editReply({ content: '⚠️ Unknown key.' });
      return;
    }

    await i.editReply({
      embeds: [keyEmbed('🔑 ' + key, [
        { name: 'Status', value: keyStatusOf(rec), inline: true },
        { name: 'Plan', value: rec.plan || '?', inline: true },
        { name: 'Product', value: rec.product || '-', inline: true },
        { name: 'Username', value: rec.username || '-', inline: true },
        { name: 'HWID', value: '`' + maskHwid(rec.hwid) + '`', inline: false },
        { name: 'Created', value: formatStamp(rec.createdAt), inline: true },
        { name: 'Activated', value: rec.activatedAt ? formatStamp(rec.activatedAt) : 'not activated', inline: true },
        { name: 'Expires', value: rec.activatedAt ? formatStamp(rec.expiresAt) : 'starts on activation', inline: true },
        { name: 'Last seen', value: rec.lastSeen ? formatStamp(rec.lastSeen) : 'never', inline: true },
        { name: 'Note', value: rec.note || '-', inline: true },
      ]).setFooter({ text: 'Scorpion' }).setTimestamp()],
    });
  }

  async function cmdKeyreset(i) {
    const key = normalizeKey(i.options.getString('key'));
    await i.deferReply({ ephemeral: true });

    const out = await mutate(function (keys) {
      const rec = keys[key];
      if (!rec) return { result: null, dirty: false };
      rec.hwid = null;
      rec.lastSeen = null;
      return { result: rec, dirty: true };
    });

    if (!out) {
      await i.editReply({ content: '⚠️ Unknown key.' });
      return;
    }
    await i.editReply({
      content: '✅ HWID unbound for `' + key + '`. The next login binds the new PC. Expiry is unchanged.',
    });
  }

  async function cmdKeyrevoke(i) {
    const key = normalizeKey(i.options.getString('key'));
    const reason = i.options.getString('reason') || '';
    await i.deferReply({ ephemeral: true });

    const out = await mutate(function (keys) {
      const rec = keys[key];
      if (!rec) return { result: null, dirty: false };
      rec.banned = true;
      rec.revokedAt = Date.now();
      if (reason) rec.revokeReason = reason;
      return { result: rec, dirty: true };
    });

    if (!out) {
      await i.editReply({ content: '⚠️ Unknown key.' });
      return;
    }
    await i.editReply({ content: '🚫 Key `' + key + '` revoked.' + (reason ? ' Reason: ' + reason : '') });
  }

  async function cmdKeylist(i) {
    const planFilter = i.options.getString('plan');
    await i.deferReply({ ephemeral: true });

    const data = await readGist();
    const all = data.keys || {};
    const entries = Object.entries(all)
      .filter(function (e) { return !planFilter || (e[1].plan === planFilter); })
      .sort(function (a, b) { return (b[1].createdAt || 0) - (a[1].createdAt || 0); });

    if (!entries.length) {
      await i.editReply({ content: 'No keys found.' });
      return;
    }

    const shown = entries.slice(0, 30).map(function (e) {
      const rec = e[1];
      return '`' + e[0] + '` — ' + keyStatusOf(rec) + ' — ' + (rec.plan || '?') +
        (rec.hwid ? ' — ' + maskHwid(rec.hwid) : '');
    }).join('\n');

    await i.editReply({
      embeds: [keyEmbed('🔑 Keys (' + entries.length + ')', [
        { name: 'Showing', value: String(Math.min(30, entries.length)), inline: true },
        { name: 'Total', value: String(entries.length), inline: true },
        { name: 'List', value: shown.slice(0, 3900), inline: false },
      ]).setFooter({ text: 'Scorpion' }).setTimestamp()],
    });
  }

  async function cmdPause(i) {
    const key = normalizeKey(i.options.getString('key'));
    await i.deferReply({ ephemeral: true });

    const out = await mutate(function (keys) {
      const rec = keys[key];
      if (!rec) return { result: null, dirty: false };
      const now = Date.now();

      if (!rec.paused) {
        rec.paused = true;
        rec.pausedAt = now;
        return { result: { paused: true, rec: rec }, dirty: true };
      }

      // resume: shift the expiry by the time spent paused
      const frozen = now - (rec.pausedAt || now);
      if (rec.expiresAt !== null && rec.expiresAt !== undefined) rec.expiresAt += frozen;
      rec.paused = false;
      rec.pausedAt = null;
      return { result: { paused: false, rec: rec, frozen: frozen }, dirty: true };
    });

    if (!out) {
      await i.editReply({ content: '⚠️ Unknown key.' });
      return;
    }

    if (out.paused) {
      await i.editReply({ content: '⏸️ Key `' + key + '` paused. Countdown is frozen until you run `/pause` again.' });
    } else {
      const mins = Math.round(out.frozen / 60000);
      await i.editReply({ content: '▶️ Key `' + key + '` resumed (+' + mins + ' min added back).' });
    }
  }

  async function changeKeyTime(i, sign) {
    const key = normalizeKey(i.options.getString('key'));
    const raw = i.options.getString('duration');
    const ms = parseKeyDuration(raw);

    await i.deferReply({ ephemeral: true });

    if (!ms) {
      await i.editReply({ content: '⚠️ Invalid duration. Use e.g. `7d`, `12h`, `30m`.' });
      return;
    }

    const out = await mutate(function (keys) {
      const rec = keys[key];
      if (!rec) return { result: { error: 'unknown' }, dirty: false };
      if (rec.banned) return { result: { error: 'revoked' }, dirty: false };

      const delta = sign * ms;

      // Not activated yet: shift the duration that starts at activation.
      if (!rec.activatedAt) {
        const planMs = PLAN_MS[rec.plan];
        let pending = (rec.pendingMs || 0) + delta;
        if (planMs !== null && planMs !== undefined) {
          const floor = -planMs;
          if (pending < floor) pending = floor;
        }
        rec.pendingMs = pending;
        return { result: { mode: 'pending', rec: rec }, dirty: true };
      }

      if (rec.expiresAt === null || rec.expiresAt === undefined) {
        return { result: { error: 'lifetime' }, dirty: false };
      }

      rec.expiresAt += delta;
      const now = Date.now();
      if (rec.expiresAt < now) rec.expiresAt = now;
      return { result: { mode: 'active', rec: rec }, dirty: true };
    });

    if (!out || out.error === 'unknown') {
      await i.editReply({ content: '⚠️ Unknown key.' });
      return;
    }
    if (out.error === 'revoked') {
      await i.editReply({ content: '⚠️ That key is revoked.' });
      return;
    }
    if (out.error === 'lifetime') {
      await i.editReply({ content: '⚠️ Lifetime keys have no expiry to change.' });
      return;
    }

    const arrow = sign > 0 ? '➕' : '➖';
    if (out.mode === 'pending') {
      await i.editReply({
        content: arrow + ' `' + key + '` is not activated yet. Pending adjustment: ' +
          Math.round((out.rec.pendingMs || 0) / 60000) + ' min (applied at activation).',
      });
    } else {
      await i.editReply({
        content: arrow + ' `' + key + '` updated. New expiry: ' + formatStamp(out.rec.expiresAt),
      });
    }
  }

  async function handleInteraction(i) {
    if (!i.isChatInputCommand()) return false;

    const name = i.commandName;
    const known = ['keygen', 'keyinfo', 'keyreset', 'keyrevoke', 'keylist', 'pause', 'extend', 'shorten'];
    if (known.indexOf(name) === -1) return false;

    if (!KEY_ADMIN_IDS.has(i.user.id)) {
      await i.reply({ content: '❌ You are not allowed to use this command.', ephemeral: true });
      return true;
    }

    try {
      if (name === 'keygen') await cmdKeygen(i);
      else if (name === 'keyinfo') await cmdKeyinfo(i);
      else if (name === 'keyreset') await cmdKeyreset(i);
      else if (name === 'keyrevoke') await cmdKeyrevoke(i);
      else if (name === 'keylist') await cmdKeylist(i);
      else if (name === 'pause') await cmdPause(i);
      else if (name === 'extend') await changeKeyTime(i, 1);
      else if (name === 'shorten') await changeKeyTime(i, -1);
    } catch (e) {
      console.error('key command ' + name + ':', e && e.message);
      try {
        if (i.deferred || i.replied) await i.editReply({ content: '❌ Error: ' + (e && e.message) });
        else await i.reply({ content: '❌ Error: ' + (e && e.message), ephemeral: true });
      } catch (_) {}
    }

    return true;
  }

  // ---- used by /purchase --------------------------------------------------

  async function registerKey(key, plan, product, createdBy) {
    const normalized = normalizeKey(key);
    if (!KEY_PATTERN.test(normalized)) return { created: false, valid: false };

    return mutate(function (keys) {
      if (keys[normalized]) {
        return { result: { created: false, valid: true, record: keys[normalized] }, dirty: false };
      }
      keys[normalized] = newKeyRecord(plan, product, createdBy, 'created by /purchase');
      return { result: { created: true, valid: true, record: keys[normalized] }, dirty: true };
    });
  }

  return {
    commands: commands,
    handleInteraction: handleInteraction,
    handleHttp: handleHttp,
    registerKey: registerKey,
    normalizeKey: normalizeKey,
    generateKey: generateKey,
  };
}

const keyApi = createKeySystem({ readGist, writeGist });

// ===== Colors =====
const COLOR_LIGHT_BLUE = 0x2b2b2b;
const COLOR_RED = 0x2b2b2b;
const COLOR_GOLD = 0x2b2b2b;
const COLOR_DARK = 0x2b2b2b;

// ===== Settings =====
const CUSTOMER_ROLE_ID = '1564635023787950090';
const REVIEW_CHANNEL_ID = '1568416985832890438';
const PURCHASE_ROLE_ID = '1564415128659824731';
const PURCHASE_LOG_CHANNEL_ID = '1564761373026681205';
const SUGGESTIE_CHANNEL_ID = '1568755542799945909';
const RULES_CHANNEL_ID = '1564632375336505344';
const VERIFY_ROLE_ID = '1564415134171013154';
const PRICING_CHANNEL_ID = '1568415867677712576';
const TICKET_PANEL_CHANNEL_ID = '1564415332737884233';
const TICKET_SUPPORT_ROLE_ID = '1564415128659824731';
const TICKET_TAG_ROLE_ID = '1564638227204149258';
const TICKET_TRANSCRIPT_CHANNEL_ID = '1568756706371051531';
const LEGIT_CHANNEL_ID = '1568417066732490802';
const VOTE_LOG_CHANNEL_ID = '1555729409535774833';
const BAN_LOG_CHANNEL_ID = '1555729409535774833';
const NOT_LEGIT_TICKET_CATEGORY_ID = '1568757119774097559';
const PAYMENT_METHODS_CHANNEL_ID = '1568415315690258493';
const PRODUCT_PANEL_CHANNEL_ID = '1568762246270681129';
const KEY_OVERVIEW_CHANNEL_ID = '1570948087671820310';
const WELCOME_CHANNEL_ID = '1565405396527489134';
const STATUS_INTERVAL = 8000;

// ===== Payment Methods =====
const PAYMENT_METHODS = {
  ideal:  { name: 'iDeal',        emoji: '<:ideal:1564724669129560174>' },
  tikkie: { name: 'Tikkie',       emoji: '<:tikkie:1564724092244983958>' },
  paypal: { name: 'PayPal',       emoji: '<:paypal:1564726369219510354>' },
  crypto: { name: 'Crypto (LTC)', emoji: '<:ltc:1564724536979759124>' },
  bank:   { name: 'Bank Transfer', emoji: '<:bank:1564724257164886078>' },
};

const TICKET_CATEGORIES = {
  support: { name: 'Support', prefix: 'support', categoryId: '1568757364494958712', emoji: '🎫', color: COLOR_LIGHT_BLUE },
  purchase: { name: 'Purchase', prefix: 'purchase', categoryId: '1568757476931932202', emoji: '🛒', color: COLOR_LIGHT_BLUE },
  bug: { name: 'Bug', prefix: 'bug', categoryId: '1568757622327222313', emoji: '⚠️', color: COLOR_RED },
  notlegit: { name: 'Not Legit Proof', prefix: 'notlegit', categoryId: NOT_LEGIT_TICKET_CATEGORY_ID, emoji: '❌', color: COLOR_RED },
};

// ===== Rules =====
const RULES_TEXT =
  "**1. PAYMENTS**\n> • Only use the official payment methods provided by Scorpion.\n> • Double-check your order and total price before paying.\n> • Fake payment proofs and fraud are strictly prohibited.\n> • Never send payments to unofficial accounts.\n\n" +
  "**2. ORDERS**\n> • Check your order carefully before completing your purchase.\n> • Always provide accurate information.\n> • Delivery times may vary depending on the product.\n> • Open a ticket if you experience any issues with your order.\n\n" +
  "**3. REFUNDS**\n> • Submit all refund requests through a ticket.\n> • Refund requests are handled according to applicable policies and laws.\n> • All applicable consumer rights remain valid.\n\n" +
  "**4. FRAUD AND ABUSE**\n> • Scamming, fraud, and abuse are strictly prohibited.\n> • False claims regarding payments or orders are not allowed.\n\n" +
  "**5. CUSTOMER SUPPORT**\n> • Open a ticket if you need assistance.\n> • Do not spam tickets or create multiple tickets for the same issue.\n> • Remain respectful towards staff members.\n> • Never share your passwords or sensitive information.\n\n" +
  "**6. ADVERTISING**\n> • Advertising other shops without permission is prohibited.\n> • Spam and unsolicited promotional messages are not allowed.\n> • Advertising is only permitted in designated channels.\n\n" +
  "*Thank you for choosing Scorpion.*";

// ===== HTTP =====
http.createServer((req, res) => {
  if (keyApi.handleHttp(req, res)) return;
  res.writeHead(200);
  res.end('ok');
}).listen(PORT);
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) setInterval(() => fetch(SELF_URL).catch(() => {}), 12 * 60 * 1000);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  presence: { status: 'online', activities: [{ name: 'Scorpion', type: 3 }] },
});
const pendingPurchases = new Map();

// ===== Plans =====
const PLANS = {
  '1 week': 8.5 * 24 * 60 * 60 * 1000,
  '1 month': 30.5 * 24 * 60 * 60 * 1000,
  'lifetime': null,
};
const planDurationMs = (plan) => PLANS[plan];

function formatDuration(ms) {
  if (ms === null) return 'Lifetime';
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  if (days > 0 && hours > 0) return `${days}d ${hours}h`;
  if (days > 0) return `${days}d`;
  return `${hours}h`;
}
function formatRemaining(endTime) {
  if (endTime === null) return 'Lifetime';
  const left = endTime - Date.now();
  if (left <= 0) return 'Expired';
  const days = Math.floor(left / 86400000);
  const hours = Math.floor((left % 86400000) / 3600000);
  const minutes = Math.floor((left % 3600000) / 60000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
function parseDuration(input) {
  const m = String(input).trim().toLowerCase().match(/^(\d+)\s*(s|m|h|d|w)$/);
  if (!m) return null;
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  return parseInt(m[1]) * mult[m[2]];
}
function formatShortDuration(ms) {
  if (ms >= 604800000) return `${Math.round(ms / 604800000)}w`;
  if (ms >= 86400000) return `${Math.round(ms / 86400000)}d`;
  if (ms >= 3600000) return `${Math.round(ms / 3600000)}h`;
  if (ms >= 60000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 1000)}s`;
}
function emojiToId(emojiStr) {
  const match = emojiStr.match(/:(\d+)>/);
  return match ? match[1] : null;
}

// ===== Commands =====
const commands = [
  {
    name: 'purchase',
    description: 'Assign a product role + customer role to a user with a license key',
    options: [
      { name: 'user', description: 'The user', type: 6, required: true },
      { name: 'product', description: 'Select the product', type: 3, required: true, autocomplete: true },
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
  { name: 'delivered', description: 'Mark this purchase ticket as delivered and ask the customer for a review' },
  {
    name: 'removelicense',
    description: 'Remove the active license of a user',
    options: [
      { name: 'user', description: 'The user', type: 6, required: true },
      { name: 'product', description: 'Product (empty = all)', type: 3, required: false, autocomplete: true },
    ],
  },
  { name: 'suggestie', description: 'Submit a suggestion', options: [{ name: 'tekst', description: 'Your suggestion', type: 3, required: true }] },
  { name: 'refresh', description: 'Repost the overview' },
  { name: 'removekruis', description: 'Remove ❌ votes', options: [{ name: 'aantal', description: 'How many?', type: 4, required: true, min_value: 1 }] },
  {
    name: 'giveaway', description: 'Start a giveaway',
    options: [
      { name: 'winners', description: 'Number of winners', type: 4, required: true, min_value: 1, max_value: 50 },
      { name: 'item', description: 'Prize', type: 3, required: true },
      { name: 'time', description: 'Duration (30s, 5m, 1h, 1d, 1w)', type: 3, required: true },
    ],
  },
  { name: 'reroll', description: 'Reroll last giveaway', options: [{ name: 'winners', description: 'New winners count', type: 4, required: true, min_value: 1, max_value: 50 }] },
  { name: 'clear', description: 'Delete messages', options: [{ name: 'amount', description: 'Amount (1-100)', type: 4, required: true, min_value: 1, max_value: 100 }] },
  {
    name: 'ban', description: 'Ban a user',
    options: [
      { name: 'user', description: 'User', type: 6, required: true },
      { name: 'duration', description: 'Duration (1h, 1d, 1w) — empty = permanent', type: 3, required: false },
      { name: 'reason', description: 'Reason', type: 3, required: false },
    ],
  },
  {
    name: 'unban', description: 'Unban a user',
    options: [
      { name: 'user_id', description: 'User ID', type: 3, required: true },
      { name: 'reason', description: 'Reason', type: 3, required: false },
    ],
  },
  { name: 'add', description: 'Add user to ticket', options: [{ name: 'user', description: 'User', type: 6, required: true }] },
  { name: 'remove', description: 'Remove user from ticket', options: [{ name: 'user', description: 'User', type: 6, required: true }] },
  { name: 'close', description: 'Close this ticket' },
  { name: 'rename', description: 'Rename this ticket', options: [{ name: 'name', description: 'New name', type: 3, required: true }] },
  ...keyApi.commands,
];

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('Commands loaded');
  } catch (e) { console.error(e); }
})();

// ===== Gist =====
async function readGist() {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`Gist read failed: ${res.status}`);
  const data = await res.json();
  const parsed = JSON.parse(data.files['zenith.json'].content);
  return {
    reviewCounter: parsed.reviewCounter || 0,
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
    paymentMethodsMessageId: parsed.paymentMethodsMessageId || null,
    products: parsed.products || {},
    productPanelMessageId: parsed.productPanelMessageId || null,
    rulesMessageId: parsed.rulesMessageId || null,
    keyOverviewMessageId: parsed.keyOverviewMessageId || null,
    keys: parsed.keys || {},
  };
}
async function writeGist(data) {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: { 'zenith.json': { content: JSON.stringify(data, null, 2) } } }),
  });
  if (!res.ok) throw new Error(`Gist write failed: ${res.status}`);
}

// Review teller
const getReviewCounter = async () => (await readGist()).reviewCounter;
async function writeReviewCounter(n) { const d = await readGist(); d.reviewCounter = n; await writeGist(d); }

// ===== Producten =====
const getProducts = async () => (await readGist()).products;
async function saveProducts(p) { const d = await readGist(); d.products = p; await writeGist(d); }
const getProductPanelMessageId = async () => (await readGist()).productPanelMessageId;
async function setProductPanelMessageId(id) { const d = await readGist(); d.productPanelMessageId = id; await writeGist(d); }

// ===== Purchases =====
const getPurchases = async () => (await readGist()).purchases;
async function savePurchases(p) { const d = await readGist(); d.purchases = p; await writeGist(d); }

async function addPurchase(userId, productName, plan, key, roleId) {
  const purchases = await getPurchases();
  const duration = planDurationMs(plan);
  const endTime = duration === null ? null : Date.now() + duration;
  const filtered = purchases.filter(p => !(p.userId === userId && p.productName === productName));
  filtered.push({ userId, productName, plan, key, roleId, eindTijd: endTime, gestart: Date.now() });
  await savePurchases(filtered);
  return { endTime, duration };
}

async function removePurchase(userId, productName = null) {
  const purchases = await getPurchases();
  let removed;
  let filtered;
  if (productName) {
    removed = purchases.filter(p => p.userId === userId && p.productName === productName);
    filtered = purchases.filter(p => !(p.userId === userId && p.productName === productName));
  } else {
    removed = purchases.filter(p => p.userId === userId);
    filtered = purchases.filter(p => p.userId !== userId);
  }
  await savePurchases(filtered);
  return removed;
}

// ===== Bans =====
const getBans = async () => (await readGist()).bans;
async function saveBans(b) { const d = await readGist(); d.bans = b; await writeGist(d); }
async function addTemporaryBan(userId, guildId, endTime) {
  const bans = await getBans();
  bans.push({ userId, guildId, eindTijd: endTime, gestart: Date.now() });
  await saveBans(bans);
}
async function removeBanRecord(userId, guildId) {
  const bans = await getBans();
  await saveBans(bans.filter(b => !(b.userId === userId && b.guildId === guildId)));
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
          try {
            const log = await client.channels.fetch(BAN_LOG_CHANNEL_ID);
            if (log) {
              await log.send({ embeds: [new EmbedBuilder()
                .setColor(COLOR_LIGHT_BLUE)
                .setDescription(`🔓 <@${b.userId}> auto-unbanned (temporary ban expired)`)
                .setFooter({ text: 'Scorpion', iconURL: LOGO })
                .setTimestamp()] });
            }
          } catch (e) {}
        }
      } catch (e) {}
      changed = true;
    }
    if (changed) await saveBans(bans.filter(b => b.eindTijd > now));
  } catch (e) { console.error('checkBans:', e.message); }
}
function startBanInterval() { checkBans(); setInterval(checkBans, 60000); }

// ===== Suggestions =====
const getSuggestions = async () => (await readGist()).suggestions;
async function saveSuggestions(s) { const d = await readGist(); d.suggestions = s; await writeGist(d); }

function buildSuggestionEmbed(s) {
  return new EmbedBuilder()
    .setTitle('New Suggestion')
    .setColor(COLOR_LIGHT_BLUE)
    .setThumbnail(LOGO)
    .setDescription(s.tekst)
    .addFields(
      { name: 'By', value: `<@${s.auteurId}>`, inline: true },
      { name: 'Votes', value: `✅ ${s.approve.length}  •  ❌ ${s.reject.length}`, inline: true }
    )
    .setFooter({ text: 'Scorpion', iconURL: LOGO })
    .setTimestamp(s.gestart);
}
function buildSuggestionRow(messageId, s) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`suggest_approve_${messageId}`).setLabel(`✅ ${s.approve.length}`).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`suggest_reject_${messageId}`).setLabel(`❌ ${s.reject.length}`).setStyle(ButtonStyle.Secondary)
  );
}

// ===== Legit poll =====
const getLegitVotes = async () => (await readGist()).legitVotes;
async function saveLegitVotes(v) { const d = await readGist(); d.legitVotes = v; await writeGist(d); }
const getLegitMessageId = async () => (await readGist()).legitMessageId;
async function setLegitMessageId(id) { const d = await readGist(); d.legitMessageId = id; await writeGist(d); }
const getConfirmedRejects = async () => (await readGist()).confirmedRejects || [];
async function saveConfirmedRejects(list) { const d = await readGist(); d.confirmedRejects = list; await writeGist(d); }

function buildLegitEmbed(votes, confirmedRejects = []) {
  const cc = confirmedRejects.length;
  return new EmbedBuilder()
    .setTitle('Are we legit?')
    .setColor(COLOR_LIGHT_BLUE)
    .setDescription(
      '**No without proof = ban**\n\n' +
      `> ✅ Legit — **${votes.approve.length}**\n` +
      `> ❌ Not legit — **${votes.reject.length}**` +
      (cc > 0 ? `\n> 🟢 Confirmed (with proof) — **${cc}**` : '')
    )
    .setThumbnail(LOGO)
    .setFooter({ text: 'Scorpion', iconURL: LOGO });
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
  } catch (e) { console.error('refreshLegitPoll:', e.message); }
}
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
      const msg = await channel.messages.fetch(messageId).catch(() => null);
      if (msg && msg.author.id === client.user.id) {
        await msg.edit({ embeds: [embed], components: [row] });
        return;
      }
    }
    await clearBotMessages(channel);
    const newMsg = await channel.send({ embeds: [embed], components: [row] });
    await setLegitMessageId(newMsg.id);
  } catch (e) { console.error('setupLegitPoll:', e.message); }
}

// ===== Vote log =====
async function logVote(userId, type, target) {
  try {
    const channel = await client.channels.fetch(VOTE_LOG_CHANNEL_ID);
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setColor(COLOR_LIGHT_BLUE)
      .setDescription(`<@${userId}> voted ${type === 'approve' ? '✅ approve' : '❌ reject'} on ${target}`)
      .setFooter({ text: 'Scorpion', iconURL: LOGO })
      .setTimestamp();
    await channel.send({ embeds: [embed] });
  } catch (e) {}
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
    lastId = messages.last().id;
    if (messages.size < 100) searching = false;
  }
  return highest;
}
async function nextReviewNumber(channel) {
  try { return (await getReviewCounter()) + 1; }
  catch (e) { return (await scanChannel(channel)) + 1; }
}

// ===== Status =====
let statusToggle = false;
let cachedReviewCounter = 0;
async function getMemberCount() {
  try { const g = await client.guilds.fetch({ guild: GUILD_ID, force: true }); return g.memberCount; }
  catch (e) { return 0; }
}
async function updateStatus() {
  try {
    if (statusToggle) {
      const m = await getMemberCount();
      client.user.setActivity(`${m} Members`, { type: 3 });
    } else {
      client.user.setActivity(`${cachedReviewCounter} Reviews`, { type: 3 });
    }
    statusToggle = !statusToggle;
  } catch (e) {}
}
async function refreshCounterCache() { try { cachedReviewCounter = await getReviewCounter(); } catch (e) {} }
function startStatusInterval() {
  refreshCounterCache();
  updateStatus();
  setInterval(refreshCounterCache, 60000);
  setInterval(updateStatus, STATUS_INTERVAL);
}

// ===== Role expiry (per product) =====
async function checkRoleExpiry() {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const purchases = await getPurchases();
    const now = Date.now();
    const toRemove = [];
    for (const p of purchases) {
      if (p.eindTijd === null || p.eindTijd > now) continue;
      toRemove.push(p);
      try {
        const member = await guild.members.fetch(p.userId).catch(() => null);
        if (member && p.roleId && member.roles.cache.has(p.roleId)) {
          const hasOther = purchases.some(o =>
            o.userId === p.userId && o.productName === p.productName &&
            o.eindTijd !== null && o.eindTijd > now
          );
          if (!hasOther) {
            await member.roles.remove(p.roleId, `Product ${p.productName} expired`).catch(() => {});
            console.log(`Removed role ${p.roleId} from ${p.userId} (${p.productName} expired)`);
          }
        }
      } catch (e) {}
    }
    if (toRemove.length > 0) {
      const remaining = purchases.filter(p => !toRemove.includes(p));
      await savePurchases(remaining);
      await updateOverview();
    }
  } catch (e) { console.error('checkRoleExpiry:', e.message); }
}
function startExpiryInterval() { checkRoleExpiry(); setInterval(checkRoleExpiry, 60000); }

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
const getOverviewMessageId = async () => (await readGist()).overzichtMessageId;
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
    .setColor(COLOR_LIGHT_BLUE)
    .setThumbnail(LOGO)
    .setFooter({ text: 'Scorpion', iconURL: LOGO })
    .setTimestamp();
  for (const plan of ['1 week', '1 month', 'lifetime']) {
    const list = perPlan[plan] || [];
    let value = list.length === 0 ? '*None*' : '';
    for (const p of list) {
      const remaining = formatRemaining(p.eindTijd);
      const key = p.key ? p.key : 'no key';
      const prod = p.productName ? ` [${p.productName}]` : '';
      value += `<@${p.userId}>${prod} — ${remaining} — \`${key}\`\n`;
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
        if (msg && msg.author.id === client.user.id) { await msg.edit({ embeds: [embed] }); return; }
      } catch (e) {}
    }
    await clearBotMessages(channel);
    const newMsg = await channel.send({ embeds: [embed] });
    await setOverviewMessageId(newMsg.id);
  } catch (e) { console.error('updateOverview:', e.message); }
}
async function restartOverview() {
  try {
    const channel = await client.channels.fetch(PURCHASE_LOG_CHANNEL_ID);
    if (!channel) return;
    await clearBotMessages(channel);
    const embed = await buildOverviewEmbed();
    const newMsg = await channel.send({ embeds: [embed] });
    await setOverviewMessageId(newMsg.id);
  } catch (e) { console.error('restartOverview:', e.message); }
}
function startOverviewInterval() { updateOverview(); setInterval(updateOverview, 60000); }

// ===== Key overview =====
const getKeyOverviewMessageId = async () => (await readGist()).keyOverviewMessageId;
async function setKeyOverviewMessageId(id) { const d = await readGist(); d.keyOverviewMessageId = id; await writeGist(d); }

function keyStatusLabel(rec) {
  if (rec.banned) return '🚫 revoked';
  if (rec.paused) return '⏸️ paused';
  if (!rec.hwid) return '🟡 not activated';
  if (rec.expiresAt !== null && rec.expiresAt !== undefined && Date.now() > rec.expiresAt) return '🔴 expired';
  return '🟢 active';
}

function keyLineText(key, rec) {
  let time;
  if (!rec.activatedAt) time = 'not started';
  else if (rec.expiresAt === null || rec.expiresAt === undefined) time = 'Lifetime';
  else time = formatRemaining(rec.expiresAt);

  const user = rec.username ? rec.username : '—';
  const plan = rec.plan || '?';
  return '`' + key + '` · ' + keyStatusLabel(rec) + ' · ' + plan + ' · ' + user + ' · ' + time;
}

function buildKeyOverviewEmbeds(keys) {
  const all = Object.entries(keys || {});
  // Revoked keys are hidden from the list (only counted in the header).
  const revoked = all.filter(([, rec]) => rec.banned).length;
  const entries = all
    .filter(([, rec]) => !rec.banned)
    .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

  let active = 0, idle = 0, dead = 0;
  const lines = entries.map(([k, rec]) => {
    const label = keyStatusLabel(rec);
    if (label.indexOf('🟢') !== -1) active++;
    else if (label.indexOf('🟡') !== -1) idle++;
    else dead++;
    return keyLineText(k, rec);
  });

  const summary = new EmbedBuilder()
    .setTitle('🔑 License Keys')
    .setColor(COLOR_LIGHT_BLUE)
    .setThumbnail(LOGO)
    .addFields(
      { name: 'Total', value: String(entries.length), inline: true },
      { name: 'Active', value: String(active), inline: true },
      { name: 'Not activated', value: String(idle), inline: true },
      { name: 'Inactive', value: String(dead), inline: true }
    )
    .setFooter({ text: 'Scorpion', iconURL: LOGO })
    .setTimestamp();

  if (revoked > 0) {
    summary.addFields({ name: 'Revoked (hidden)', value: String(revoked), inline: true });
  }

  const embeds = [summary];

  const MAX = 3800;
  const chunks = [];
  let chunk = '';
  for (const line of lines) {
    if (chunk.length + line.length + 1 > MAX) { chunks.push(chunk); chunk = ''; }
    chunk += line + '\n';
  }
  if (chunk.length) chunks.push(chunk);
  if (!chunks.length) chunks.push('*No keys generated yet.*');

  for (let i = 0; i < chunks.length && embeds.length < 10; i++) {
    embeds.push(new EmbedBuilder()
      .setColor(COLOR_LIGHT_BLUE)
      .setDescription(chunks[i].slice(0, 4000))
      .setFooter({ text: `Scorpion · ${i + 1}/${chunks.length}`, iconURL: LOGO }));
  }

  if (chunks.length > 9) {
    embeds[embeds.length - 1].setFooter({ text: `Scorpion · showing 9/${chunks.length} pages`, iconURL: LOGO });
  }
  return embeds;
}

async function updateKeyOverview() {
  try {
    const channel = await client.channels.fetch(KEY_OVERVIEW_CHANNEL_ID).catch(() => null);
    if (!channel) return;

    const data = await readGist();
    const embeds = buildKeyOverviewEmbeds(data.keys || {});

    const messageId = await getKeyOverviewMessageId();
    if (messageId) {
      const msg = await channel.messages.fetch(messageId).catch(() => null);
      if (msg && msg.author.id === client.user.id) {
        await msg.edit({ embeds });
        return;
      }
    }
    await clearBotMessages(channel);
    const newMsg = await channel.send({ embeds });
    await setKeyOverviewMessageId(newMsg.id);
  } catch (e) { console.error('updateKeyOverview:', e.message); }
}

function startKeyOverviewInterval() { updateKeyOverview(); setInterval(updateKeyOverview, 60000); }

// ===== Product Paneel =====
function buildProductPanelEmbed(products) {
  const list = Object.entries(products);
  const embed = new EmbedBuilder()
    .setTitle('📦 Product Management')
    .setColor(COLOR_LIGHT_BLUE)
    .setThumbnail(LOGO)
    .setFooter({ text: 'Scorpion', iconURL: LOGO })
    .setTimestamp();
  if (list.length === 0) {
    embed.setDescription('*No products configured yet.*\n\nUse the buttons below to add or remove products.');
  } else {
    const fields = list.map(([name, data]) => ({
      name: `📦 ${name}`,
      value: `> Role: <@&${data.roleId}>`,
      inline: false,
    }));
    embed.setDescription('All products and their linked roles:');
    embed.addFields(fields.slice(0, 25));
  }
  return embed;
}
function buildProductPanelRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('product_add').setLabel('Add Product').setEmoji('➕').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('product_remove').setLabel('Remove Product').setEmoji('🗑️').setStyle(ButtonStyle.Danger)
    ),
  ];
}
async function setupProductPanel() {
  try {
    const channel = await client.channels.fetch(PRODUCT_PANEL_CHANNEL_ID).catch(() => null);
    if (!channel) return console.error('Product panel channel not found');
    await clearBotMessages(channel);
    const products = await getProducts();
    const embed = buildProductPanelEmbed(products);
    const rows = buildProductPanelRows();
    const msg = await channel.send({ embeds: [embed], components: rows });
    await setProductPanelMessageId(msg.id);
    console.log('Product panel placed');
  } catch (e) { console.error('setupProductPanel:', e.message); }
}
async function updateProductPanel() {
  try {
    const channel = await client.channels.fetch(PRODUCT_PANEL_CHANNEL_ID).catch(() => null);
    if (!channel) return;
    const messageId = await getProductPanelMessageId();
    if (!messageId) return setupProductPanel();
    const msg = await channel.messages.fetch(messageId).catch(() => null);
    if (!msg) return setupProductPanel();
    const products = await getProducts();
    await msg.edit({ embeds: [buildProductPanelEmbed(products)], components: buildProductPanelRows() });
  } catch (e) { console.error('updateProductPanel:', e.message); }
}

// ===== Payment Methods =====
const getPaymentMethodsMessageId = async () => (await readGist()).paymentMethodsMessageId;
async function setPaymentMethodsMessageId(id) { const d = await readGist(); d.paymentMethodsMessageId = id; await writeGist(d); }

async function setupPaymentMethods() {
  try {
    const channel = await client.channels.fetch(PAYMENT_METHODS_CHANNEL_ID).catch(() => null);
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setTitle('Payment Methods')
      .setColor(COLOR_DARK)
      .setDescription(
        `→   ${PAYMENT_METHODS.ideal.emoji}  **(iDeal)**\n` +
        `→   ${PAYMENT_METHODS.tikkie.emoji}  **(Tikkie)**\n` +
        `→   ${PAYMENT_METHODS.paypal.emoji}  **(PayPal)**\n` +
        `→   ${PAYMENT_METHODS.crypto.emoji}  **(Cryptocurrencies, LTC) = 10% Off!**\n` +
        `→   ${PAYMENT_METHODS.bank.emoji}  **(Bank Transfer)**\n\n` +
        `-# Please share your suggestions for new payment methods we can add.`
      );
    const messageId = await getPaymentMethodsMessageId();
    if (messageId) {
      const msg = await channel.messages.fetch(messageId).catch(() => null);
      if (msg && msg.author.id === client.user.id) {
        await msg.edit({ embeds: [embed] });
        return;
      }
    }
    await clearBotMessages(channel);
    const newMsg = await channel.send({ embeds: [embed] });
    await setPaymentMethodsMessageId(newMsg.id);
  } catch (e) { console.error('setupPaymentMethods:', e.message); }
}

// ===== Rules + Verify =====
const getRulesMessageId = async () => (await readGist()).rulesMessageId;
async function setRulesMessageId(id) { const d = await readGist(); d.rulesMessageId = id; await writeGist(d); }

async function getVerifiedCount() {
  try {
    const guild = await client.guilds.fetch({ guild: GUILD_ID, force: true });
    await guild.members.fetch({ force: true });
    const role = guild.roles.cache.get(VERIFY_ROLE_ID);
    if (!role) return 0;
    const cachedCount = role.members.size;
    if (cachedCount > 0) return cachedCount;
    let count = 0;
    guild.members.cache.forEach(m => { if (m.roles.cache.has(VERIFY_ROLE_ID)) count++; });
    return count;
  } catch (e) { console.error('getVerifiedCount error:', e.message); return 0; }
}

async function updateRulesMessage() {
  try {
    const channel = await client.channels.fetch(RULES_CHANNEL_ID).catch(() => null);
    if (!channel) return;
    const messageId = await getRulesMessageId();
    if (!messageId) return setupRules();
    const verifiedCount = await getVerifiedCount();
    const msg = await channel.messages.fetch(messageId).catch(() => null);
    if (!msg) return setupRules();
    const embed = new EmbedBuilder()
      .setAuthor({ name: 'Scorpion RULES', iconURL: LOGO })
      .setColor(COLOR_DARK)
      .setDescription(`Welcome to Scorpion. Please read the rules carefully before placing an order.\n\n${RULES_TEXT}`)
      .setFooter({ text: 'Scorpion', iconURL: LOGO })
      .setThumbnail(LOGO)
      .setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('verify_accept_rules').setLabel(`✅ ${verifiedCount}`).setStyle(ButtonStyle.Secondary)
    );
    await msg.edit({ embeds: [embed], components: [row] });
  } catch (e) { console.error('updateRulesMessage:', e.message); }
}

async function setupRules() {
  try {
    const channel = await client.channels.fetch(RULES_CHANNEL_ID).catch(() => null);
    if (!channel) return console.error('Rules channel not found');
    await clearBotMessages(channel);
    const verifiedCount = await getVerifiedCount();
    const embed = new EmbedBuilder()
      .setAuthor({ name: 'Scorpion RULES', iconURL: LOGO })
      .setColor(COLOR_DARK)
      .setDescription(`Welcome to Scorpion. Please read the rules carefully before placing an order.\n\n${RULES_TEXT}`)
      .setFooter({ text: 'Scorpion', iconURL: LOGO })
      .setThumbnail(LOGO)
      .setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('verify_accept_rules').setLabel(`✅ ${verifiedCount}`).setStyle(ButtonStyle.Secondary)
    );
    const newMsg = await channel.send({ embeds: [embed], components: [row] });
    await setRulesMessageId(newMsg.id);
    console.log('Rules message placed');
  } catch (e) { console.error('setupRules:', e.message); }
}

// ===== Giveaway =====
const getGiveaways = async () => (await readGist()).giveaways;
async function saveGiveaways(g) { const d = await readGist(); d.giveaways = g; await writeGist(d); }
const getLastGiveaways = async () => (await readGist()).laatsteGiveaways;
async function saveLastGiveaways(l) { const d = await readGist(); d.laatsteGiveaways = l; await writeGist(d); }

function buildGiveawayEmbed(g) {
  return new EmbedBuilder()
    .setTitle('🎉 Giveaway 🎉').setColor(COLOR_LIGHT_BLUE).setThumbnail(LOGO)
    .setDescription(`**Prize:** ${g.item}\n**Winners:** ${g.winners}\n**Ends:** <t:${Math.floor(g.eindTijd / 1000)}:R>\n\nReact with 🎉 to enter!`)
    .setFooter({ text: `Scorpion • Hosted by ${g.hostTag || 'unknown'}`, iconURL: LOGO })
    .setTimestamp(g.gestart);
}
function buildGiveawayEndedEmbed(g, winners, isReroll = false) {
  const winnerText = winners.length > 0 ? winners.map(id => `<@${id}>`).join(', ') : 'No participants';
  return new EmbedBuilder()
    .setTitle(isReroll ? '🎉 Giveaway Rerolled 🎉' : '🎉 Giveaway Ended 🎉').setColor(COLOR_LIGHT_BLUE).setThumbnail(LOGO)
    .setDescription(`**Prize:** ${g.item}\n**${isReroll ? 'New winners' : 'Winners'}:** ${winnerText}\n\nCongratulations! 🎊`)
    .setFooter({ text: 'Scorpion', iconURL: LOGO }).setTimestamp();
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
    if (!channel) { delete giveaways[messageId]; await saveGiveaways(giveaways); return; }
    const msg = await channel.messages.fetch(messageId).catch(() => null);
    if (!msg) { delete giveaways[messageId]; await saveGiveaways(giveaways); return; }
    const { winners } = await pickWinners(msg, g.winners);
    await msg.edit({ embeds: [buildGiveawayEndedEmbed(g, winners, false)] }).catch(() => {});
    if (winners.length > 0) {
      await channel.send({ content: `🎉 Congratulations ${winners.map(id => `<@${id}>`).join(', ')}! You won **${g.item}**!` }).catch(() => {});
      for (const id of winners) {
        try {
          const user = await client.users.fetch(id);
          await user.send({ embeds: [new EmbedBuilder()
            .setTitle('🎉 You won a giveaway!').setColor(COLOR_LIGHT_BLUE).setThumbnail(LOGO)
            .setDescription(`Congratulations! You won **${g.item}** in the **Scorpion** giveaway!`)
            .setFooter({ text: 'Scorpion', iconURL: LOGO }).setTimestamp()] });
        } catch (e) {}
      }
    } else {
      await channel.send({ content: `😢 No one entered the giveaway for **${g.item}**.` }).catch(() => {});
    }
    const last = await getLastGiveaways();
    last[channelId] = { messageId, item: g.item, winners: g.winners, kanaalId: channelId, geeindigd: Date.now() };
    await saveLastGiveaways(last);
    delete giveaways[messageId];
    await saveGiveaways(giveaways);
  } catch (e) { console.error('endGiveaway:', e.message); }
}
async function restoreGiveaways() {
  try {
    const giveaways = await getGiveaways();
    const now = Date.now();
    for (const [messageId, g] of Object.entries(giveaways)) {
      const left = g.eindTijd - now;
      if (left <= 0) await endGiveaway(messageId, g.kanaalId);
      else setTimeout(() => endGiveaway(messageId, g.kanaalId), left);
    }
  } catch (e) { console.error('restoreGiveaways:', e.message); }
}

// ===== Transcript =====
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function renderContent(content, mentions) {
  if (!content) return '';
  let html = escapeHtml(content);
  if (mentions?.users) for (const [id, u] of mentions.users)
    html = html.replace(new RegExp(`&lt;@!?${id}&gt;`, 'g'), `<span class="mention">@${escapeHtml(u.username)}</span>`);
  if (mentions?.roles) for (const [id, r] of mentions.roles)
    html = html.replace(new RegExp(`&lt;@&amp;${id}&gt;`, 'g'), `<span class="mention">@${escapeHtml(r.name)}</span>`);
  if (mentions?.channels) for (const [id, c] of mentions.channels)
    html = html.replace(new RegExp(`&lt;#${id}&gt;`, 'g'), `<span class="mention">#${escapeHtml(c.name)}</span>`);
  html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank">$1</a>');
  html = html.replace(/```([\s\S]*?)```/g, '<pre class="codeblock">$1</pre>');
  html = html.replace(/`([^`]+)`/g, '<code class="inline">$1</code>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/\n/g, '<br>');
  return html;
}
function renderEmbed(e) {
  const color = '#2b2b2b';
  let fields = '';
  if (e.fields?.length) {
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
  if (!attachments?.size) return '';
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
    if (!messages.size) break;
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
      <img class="avatar" src="${avatar}">
      <div class="message-body">
        <div class="message-header">
          <span class="username">${escapeHtml(m.author.username)}</span>${botBadge}
          <span class="timestamp">${time}</span>
        </div>
        ${m.content ? `<div class="message-content">${renderContent(m.content, m.mentions)}</div>` : ''}
        ${m.embeds?.length ? m.embeds.map(renderEmbed).join('') : ''}
        ${renderAttachments(m.attachments)}
      </div>
    </div>`;
  }).join('');
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Transcript - #${escapeHtml(channel.name)}</title>
<style>
* { box-sizing: border-box; }
body { margin: 0; background: #313338; color: #dbdee1; font-family: 'gg sans', 'Whitney', Arial, sans-serif; font-size: 16px; line-height: 1.375; }
.header { background: #2b2d31; padding: 16px 20px; border-bottom: 1px solid #1e1f22; position: sticky; top: 0; z-index: 10; }
.header h1 { margin: 0; font-size: 18px; color: #f2f3f5; }
.header .meta { color: #949ba4; font-size: 13px; margin-top: 4px; }
.chat { padding: 20px 0; }
.message { display: flex; padding: 4px 20px; margin-top: 16px; }
.message:hover { background: #2e3035; }
.avatar { width: 40px; height: 40px; border-radius: 50%; margin-right: 16px; flex-shrink: 0; }
.message-body { flex: 1; min-width: 0; }
.message-header { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
.username { font-weight: 500; font-size: 16px; color: #fff; }
.bot-badge { background: #2b2b2b; color: #fff; font-size: 10px; font-weight: 600; padding: 1px 4px; border-radius: 3px; }
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
<div class="header"><h1>Transcript: #${escapeHtml(channel.name)}</h1><div class="meta">${allMessages.length} messages • ${new Date().toLocaleString('en-US')}</div></div>
<div class="chat">${messagesHtml}</div>
</body></html>`;
  return { html, messageCount: allMessages.length };
}

// ===== Close ticket =====
async function closeTicket(channel, closerId) {
  const tickets = await getTickets();
  const ticket = tickets[channel.id];
  if (!ticket) return { ok: false, reason: 'Not an active ticket.' };
  try {
    const { html, messageCount } = await makeTranscript(channel);
    const attachment = new AttachmentBuilder(Buffer.from(html, 'utf-8'), { name: `transcript-${channel.name}.html` });
    const transcriptChannel = await client.channels.fetch(TICKET_TRANSCRIPT_CHANNEL_ID);
    const cat = TICKET_CATEGORIES[ticket.categorie];
    const transcriptEmbed = new EmbedBuilder()
      .setTitle('Ticket Transcript').setColor(COLOR_LIGHT_BLUE).setThumbnail(LOGO)
      .addFields(
        { name: 'Channel', value: `#${channel.name}`, inline: true },
        { name: 'Customer', value: `<@${ticket.userId}>`, inline: true },
        { name: 'Closed by', value: `<@${closerId}>`, inline: true },
        { name: 'Category', value: cat ? cat.name : 'Unknown', inline: true },
        { name: 'Messages', value: `${messageCount}`, inline: true }
      ).setFooter({ text: 'Scorpion', iconURL: LOGO }).setTimestamp();
    await transcriptChannel.send({ embeds: [transcriptEmbed], files: [attachment] });
  } catch (e) { console.error('transcript:', e.message); }
  await removeTicket(channel.id);
  setTimeout(async () => { try { await channel.delete('Ticket closed'); } catch (e) {} }, 5000);
  return { ok: true };
}

// ===== Pricing =====
async function setupPricing() {
  try {
    const channel = await client.channels.fetch(PRICING_CHANNEL_ID);
    if (!channel) return;
    await clearBotMessages(channel);
    const embed = new EmbedBuilder()
      .setTitle('Scorpion Custom Bypass').setColor(COLOR_LIGHT_BLUE).setThumbnail(LOGO)
      .setDescription('> Premium external cheat with advanced bypass.\n> ⚡ Fast delivery • 🔒 Safe • 🕐 24/7 Support')
      .addFields(
        { name: '💰 Pricing', value: '```\n1 Week    →  €7.50\n1 Month   →  €20.00\nLifetime  →  €60.00\n```', inline: false },
        { name: '🛡️ Product', value: '> • External Cheat\n> • Advanced bypass\n> • Daily Updates\n> • Easy to use interface\n> • 24/7 Support', inline: false },
        { name: '👥 Group Deals', value: '```\nDuo    →  €35 per person\nTrio   →  €25 per person\nSquad  →  €20 per person\n```', inline: false }
      )
      .setFooter({ text: 'Scorpion', iconURL: LOGO });
    await channel.send({ embeds: [embed] });
  } catch (e) { console.error('setupPricing:', e.message); }
}

// ===== Ticket panel =====
async function setupTicketPanel() {
  try {
    const channel = await client.channels.fetch(TICKET_PANEL_CHANNEL_ID);
    if (!channel) return;
    await clearBotMessages(channel);
    const embed = new EmbedBuilder()
      .setTitle('Tickets').setColor(COLOR_LIGHT_BLUE)
      .setDescription('Choose a category below to open a ticket.\n\n> ⚡ Fast delivery\n> 🔒 Safe & reliable\n> 🕐 24/7 Support')
      .setThumbnail(LOGO).setFooter({ text: 'Scorpion', iconURL: LOGO });
    const menu = new StringSelectMenuBuilder()
      .setCustomId('ticket_category_select').setPlaceholder('Category...')
      .addOptions([
        { label: 'Support', value: 'support', emoji: '🎫' },
        { label: 'Purchase', value: 'purchase', emoji: '🛒' },
        { label: 'Bug', value: 'bug', emoji: '⚠️' },
      ]);
    const row = new ActionRowBuilder().addComponents(menu);
    await channel.send({ embeds: [embed], components: [row] });
  } catch (e) { console.error('setupTicketPanel:', e.message); }
}

// ===== Ticket storage =====
const getTickets = async () => (await readGist()).tickets;
async function saveTickets(t) { const d = await readGist(); d.tickets = t; await writeGist(d); }
async function addTicket(channelId, userId, categoryKey, extra = {}) {
  const t = await getTickets();
  t[channelId] = { userId, categorie: categoryKey, gestart: Date.now(), extraUsers: [], ...extra };
  await saveTickets(t);
}
async function removeTicket(channelId) {
  const t = await getTickets();
  delete t[channelId];
  await saveTickets(t);
}
const getNotLegitTickets = async () => (await readGist()).notlegitTickets;
async function saveNotLegitTickets(n) { const d = await readGist(); d.notlegitTickets = n; await writeGist(d); }
async function setNotLegitStatus(channelId, status) {
  const n = await getNotLegitTickets();
  if (n[channelId]) { n[channelId].status = status; n[channelId].updatedAt = Date.now(); await saveNotLegitTickets(n); }
}

// ===== Helpers =====
function stars(n) { return '⭐'.repeat(n) + '☆'.repeat(5 - n); }
function notLegitReviewRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('notlegit_positive').setLabel('Positive').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('notlegit_false').setLabel('False').setEmoji('❌').setStyle(ButtonStyle.Danger)
  );
}

// ===== Create ticket helper =====
async function createTicket(guild, user, categoryKey, extraData = {}) {
  const cat = TICKET_CATEGORIES[categoryKey];
  if (!cat) throw new Error('Unknown category');
  const tickets = await getTickets();
  if (Object.values(tickets).find(t => t.userId === user.id)) throw new Error('You already have an open ticket.');

  const channelName = `${cat.prefix}-${user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 90);
  const ticketChannel = await guild.channels.create({
    name: channelName, type: ChannelType.GuildText, parent: cat.categoryId,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
      { id: TICKET_SUPPORT_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
    ],
    topic: `Ticket from ${user.tag} — ${cat.name}`,
  });

  await addTicket(ticketChannel.id, user.id, categoryKey, extraData);

  const embed = new EmbedBuilder()
    .setTitle(cat.name).setColor(cat.color)
    .setDescription(`<@${user.id}> — describe your question below.`)
    .setFooter({ text: 'Scorpion', iconURL: LOGO }).setTimestamp();

  if (extraData.productName) {
    embed.addFields(
      { name: 'Product', value: extraData.productName, inline: true },
      { name: 'Plan', value: extraData.plan || '?', inline: true },
      { name: 'Payment', value: extraData.paymentName || '?', inline: true }
    );
  }
  if (extraData.question) {
    embed.addFields({ name: 'Question', value: extraData.question, inline: false });
  }

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger)
  );
  await ticketChannel.send({ content: `<@${user.id}> <@&${TICKET_TAG_ROLE_ID}>`, embeds: [embed], components: [closeRow] });
  return ticketChannel;
}

// ===== Interaction handler =====
client.on('interactionCreate', async (i) => {
  if (i.isAutocomplete()) {
    try {
      const products = await getProducts();
      const focused = i.options.getFocused().toLowerCase();
      const filtered = Object.keys(products)
        .filter(p => p.toLowerCase().includes(focused))
        .slice(0, 25)
        .map(p => ({ name: p, value: p }));
      await i.respond(filtered);
    } catch (e) { try { await i.respond([]); } catch (_) {} }
    return;
  }

  // ===== License keys =====
  if (await keyApi.handleInteraction(i)) {
    // Refresh the key overview right away after an admin key command.
    if (['keygen', 'keyreset', 'keyrevoke', 'pause', 'extend', 'shorten'].indexOf(i.commandName) !== -1) {
      updateKeyOverview().catch(() => {});
    }
    return;
  }

  // ===== /purchase =====
  if (i.isChatInputCommand() && i.commandName === 'purchase') {
    if (!i.member.roles.cache.has(PURCHASE_ROLE_ID)) return i.reply({ content: `You need the <@&${PURCHASE_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply();
    const targetUser = i.options.getUser('user');
    const productName = i.options.getString('product');
    const plan = i.options.getString('plan');
    const key = i.options.getString('key');

    const products = await getProducts();
    const productData = products[productName];
    if (!productData) return i.editReply({ content: `⚠️ Product **${productName}** not found. Add it in <#${PRODUCT_PANEL_CHANNEL_ID}>.` });

    const duration = planDurationMs(plan);
    if (duration === undefined) return i.editReply({ content: 'Unknown plan.' });

    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const member = await guild.members.fetch(targetUser.id);
      const roleId = productData.roleId;
      if (roleId) await member.roles.add(roleId, `Purchase: ${productName} (${plan})`).catch(() => {});
      await member.roles.add(CUSTOMER_ROLE_ID, `Purchase: ${productName} (${plan})`).catch(() => {});
      // Make the delivered key usable by the auth API (HWID binds on first login).
      await keyApi.registerKey(key, plan, productName, i.user.id).catch(() => {});
      const { endTime } = await addPurchase(targetUser.id, productName, plan, key, roleId);
      await updateOverview();
      const planText = plan === 'lifetime' ? 'Lifetime' : plan;
      const embed = new EmbedBuilder()
        .setTitle('Purchase Completed').setColor(COLOR_LIGHT_BLUE).setThumbnail(LOGO)
        .setDescription(`Thanks for your purchase, <@${targetUser.id}>!\n\nYour plan is active and your key is shown below.`)
        .addFields(
          { name: 'Customer', value: `<@${targetUser.id}>`, inline: true },
          { name: 'Product', value: productName, inline: true },
          { name: 'Plan', value: planText, inline: true },
          { name: 'Duration', value: formatDuration(duration), inline: true },
          { name: 'Product Role', value: roleId ? `<@&${roleId}>` : 'None', inline: true },
          { name: 'Customer Role', value: `<@&${CUSTOMER_ROLE_ID}>`, inline: true },
          { name: 'Key', value: `\`\`\`${key}\`\`\``, inline: false },
          { name: 'Expires', value: endTime === null ? 'Never (Lifetime)' : `<t:${Math.floor(endTime/1000)}:F> (<t:${Math.floor(endTime/1000)}:R>)`, inline: false }
        )
        .setFooter({ text: 'Scorpion', iconURL: LOGO }).setTimestamp();
      await i.editReply({ embeds: [embed] });
      try {
        const dmEmbed = new EmbedBuilder()
          .setTitle('Thank you for your purchase!').setColor(COLOR_LIGHT_BLUE).setThumbnail(LOGO)
          .setDescription(`Hey <@${targetUser.id}>,\n\nThanks for purchasing the **${planText} Plan** for **${productName}**!\n\nHere is your key:\n\`\`\`${key}\`\`\`\nKeep it safe! 💙`)
          .setFooter({ text: 'Scorpion', iconURL: LOGO }).setTimestamp();
        await targetUser.send({ embeds: [dmEmbed] });
      } catch (e) {}
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // ===== /delivered =====
  if (i.isChatInputCommand() && i.commandName === 'delivered') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) return i.reply({ content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role.`, ephemeral: true });
    const tickets = await getTickets();
    const ticket = tickets[i.channelId];
    if (!ticket) return i.reply({ content: '⚠️ This is not an active ticket.', ephemeral: true });
    if (ticket.categorie !== 'purchase') return i.reply({ content: '⚠️ This command only works in purchase tickets.', ephemeral: true });

    await i.deferReply();
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const customerId = ticket.userId;
      const member = await guild.members.fetch(customerId).catch(() => null);
      if (member && !member.roles.cache.has(CUSTOMER_ROLE_ID)) {
        await member.roles.add(CUSTOMER_ROLE_ID, 'Purchase delivered').catch(() => {});
      }

      const confirmEmbed = new EmbedBuilder()
        .setTitle('📦 Did you receive your delivery?')
        .setColor(COLOR_LIGHT_BLUE)
        .setThumbnail(LOGO)
        .setDescription(
          `<@${customerId}>, please confirm if you have successfully received your delivery.\n\n` +
          `If you click **Yes**, a review will be automatically posted in <#${REVIEW_CHANNEL_ID}>.`
        )
        .setFooter({ text: 'Scorpion', iconURL: LOGO })
        .setTimestamp();

      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`confirm_delivery_${customerId}_${ticket.productName || 'unknown'}_${ticket.plan || 'unknown'}`)
          .setLabel('Yes').setEmoji('✅').setStyle(ButtonStyle.Success)
      );

      await i.channel.send({ embeds: [confirmEmbed], components: [confirmRow] });
      await i.editReply({ content: '✅ Delivery confirmation sent to the customer.' });
    } catch (e) { await i.editReply({ content: `❌ Error: ${e.message}` }); }
    return;
  }

  // ===== /removelicense =====
  if (i.isChatInputCommand() && i.commandName === 'removelicense') {
    if (!i.member.roles.cache.has(PURCHASE_ROLE_ID)) return i.reply({ content: `You need the <@&${PURCHASE_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply();
    const targetUser = i.options.getUser('user');
    const productName = i.options.getString('product');
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const member = await guild.members.fetch(targetUser.id);
      const existing = await removePurchase(targetUser.id, productName || null);
      if (!existing || existing.length === 0) return i.editReply({ content: `⚠️ <@${targetUser.id}> has no active license${productName ? ` for **${productName}**` : ''}.` });
      let rolesRemoved = 0;
      for (const p of existing) {
        if (p.roleId && member.roles.cache.has(p.roleId)) {
          const stillHas = (await getPurchases()).some(o => o.userId === targetUser.id && o.productName === p.productName);
          if (!stillHas) { await member.roles.remove(p.roleId, 'License removed').catch(() => {}); rolesRemoved++; }
        }
      }
      const remaining = (await getPurchases()).filter(p => p.userId === targetUser.id);
      if (remaining.length === 0 && member.roles.cache.has(CUSTOMER_ROLE_ID)) {
        await member.roles.remove(CUSTOMER_ROLE_ID, 'No active purchases').catch(() => {});
      }
      await updateOverview();
      const embed = new EmbedBuilder().setTitle('License Removed').setColor(COLOR_RED).setThumbnail(LOGO)
        .addFields(
          { name: 'Customer', value: `<@${targetUser.id}>`, inline: true },
          { name: 'Products removed', value: existing.map(e => e.productName).join(', '), inline: false },
          { name: 'Roles removed', value: `${rolesRemoved}`, inline: true }
        ).setFooter({ text: 'Scorpion', iconURL: LOGO }).setTimestamp();
      await i.editReply({ embeds: [embed] });
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // ===== /suggestie =====
  if (i.isChatInputCommand() && i.commandName === 'suggestie') {
    await i.deferReply({ ephemeral: true });
    const text = i.options.getString('tekst');
    try {
      const channel = await client.channels.fetch(SUGGESTIE_CHANNEL_ID);
      const placeholder = new EmbedBuilder().setTitle('New Suggestion').setColor(COLOR_LIGHT_BLUE).setThumbnail(LOGO).setDescription('Loading...').setFooter({ text: 'Scorpion', iconURL: LOGO }).setTimestamp();
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

  // ===== /refresh =====
  if (i.isChatInputCommand() && i.commandName === 'refresh') {
    if (!i.member.roles.cache.has(PURCHASE_ROLE_ID)) return i.reply({ content: `You need the <@&${PURCHASE_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply({ ephemeral: true });
    try {
      await restartOverview();
      await i.editReply({ content: `Overview refreshed in <#${PURCHASE_LOG_CHANNEL_ID}>.` });
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // ===== /removekruis =====
  if (i.isChatInputCommand() && i.commandName === 'removekruis') {
    if (!i.member.roles.cache.has(PURCHASE_ROLE_ID)) return i.reply({ content: `You need the <@&${PURCHASE_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply();
    const amount = i.options.getInteger('aantal');
    try {
      const votes = await getLegitVotes();
      if (votes.reject.length === 0) return i.editReply({ content: '⚠️ No crosses to remove.' });
      const toRemove = Math.min(amount, votes.reject.length);
      votes.reject.splice(votes.reject.length - toRemove, toRemove);
      await saveLegitVotes(votes);
      await refreshLegitPoll();
      await i.editReply({ content: `✅ Removed **${toRemove}** ❌ vote(s).` });
      await logVote(i.user.id, 'reject', `removed ${toRemove} crosses`);
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // ===== /giveaway =====
  if (i.isChatInputCommand() && i.commandName === 'giveaway') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) return i.reply({ content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply();
    const winners = i.options.getInteger('winners');
    const item = i.options.getString('item');
    const durationMs = parseDuration(i.options.getString('time'));
    if (!durationMs || durationMs < 10000) return i.editReply({ content: '⚠️ Invalid time (min 10s).' });
    if (durationMs > 30 * 86400000) return i.editReply({ content: '⚠️ Max 30 days.' });
    try {
      const endTime = Date.now() + durationMs;
      const giveaways = await getGiveaways();
      const data = { item, winners, eindTijd: endTime, gestart: Date.now(), kanaalId: i.channelId, hostId: i.user.id, hostTag: i.user.username };
      const msg = await i.channel.send({ embeds: [buildGiveawayEmbed(data)] });
      await msg.react('🎉');
      data.messageId = msg.id;
      giveaways[msg.id] = data;
      await saveGiveaways(giveaways);
      setTimeout(() => endGiveaway(msg.id, i.channelId), durationMs);
      await i.editReply({ content: `✅ Giveaway started! Ends <t:${Math.floor(endTime/1000)}:R>.` });
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // ===== /reroll =====
  if (i.isChatInputCommand() && i.commandName === 'reroll') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) return i.reply({ content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply();
    const amount = i.options.getInteger('winners');
    try {
      const last = await getLastGiveaways();
      const info = last[i.channelId];
      if (!info) return i.editReply({ content: '⚠️ No ended giveaway in this channel.' });
      const channel = await client.channels.fetch(i.channelId);
      const msg = await channel.messages.fetch(info.messageId).catch(() => null);
      if (!msg) return i.editReply({ content: '⚠️ Original message not found.' });
      const { winners, totalParticipants } = await pickWinners(msg, amount);
      if (totalParticipants === 0) return i.editReply({ content: '⚠️ No participants.' });
      const g = { item: info.item, winners: amount };
      await msg.edit({ embeds: [buildGiveawayEndedEmbed(g, winners, true)] }).catch(() => {});
      if (winners.length > 0) {
        await channel.send({ content: `🎉 **Reroll!** Congratulations ${winners.map(id => `<@${id}>`).join(', ')}! You won **${info.item}**!` }).catch(() => {});
      }
      await i.editReply({ content: `✅ Rerolled (${winners.length} winners).` });
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // ===== /clear =====
  if (i.isChatInputCommand() && i.commandName === 'clear') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) return i.reply({ content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply({ ephemeral: true });
    const amount = i.options.getInteger('amount');
    try {
      const deleted = await i.channel.bulkDelete(amount, true);
      await i.editReply({ content: `✅ Deleted **${deleted.size}** messages.` });
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // ===== /ban =====
  if (i.isChatInputCommand() && i.commandName === 'ban') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) return i.reply({ content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply();
    const targetUser = i.options.getUser('user');
    const durationStr = i.options.getString('duration');
    const reason = i.options.getString('reason') || 'No reason provided';
    let durationMs = null;
    if (durationStr) {
      durationMs = parseDuration(durationStr);
      if (!durationMs) return i.editReply({ content: '⚠️ Invalid duration.' });
      if (durationMs < 60000) return i.editReply({ content: '⚠️ Min 1 minute.' });
      if (durationMs > 365 * 86400000) return i.editReply({ content: '⚠️ Max 1 year.' });
    }
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const existingBan = await guild.bans.fetch(targetUser.id).catch(() => null);
      if (existingBan) return i.editReply({ content: `⚠️ <@${targetUser.id}> is already banned.` });
      try {
        await targetUser.send({ embeds: [new EmbedBuilder().setTitle('You have been banned').setColor(COLOR_RED).setThumbnail(LOGO)
          .addFields(
            { name: 'Server', value: 'Scorpion', inline: true },
            { name: 'Duration', value: durationMs ? formatShortDuration(durationMs) : 'Permanent', inline: true },
            { name: 'Reason', value: reason, inline: false }
          ).setFooter({ text: 'Scorpion', iconURL: LOGO }).setTimestamp()] });
      } catch (e) {}
      await guild.bans.create(targetUser.id, { reason: `${reason} | by ${i.user.tag}` });
      if (durationMs) await addTemporaryBan(targetUser.id, GUILD_ID, Date.now() + durationMs);
      try {
        const log = await client.channels.fetch(BAN_LOG_CHANNEL_ID);
        if (log) await log.send({ embeds: [new EmbedBuilder().setColor(COLOR_RED).setTitle('🔨 Ban')
          .setThumbnail(targetUser.displayAvatarURL())
          .addFields(
            { name: 'User', value: `${targetUser.tag} (<@${targetUser.id}>)`, inline: false },
            { name: 'Moderator', value: `<@${i.user.id}>`, inline: true },
            { name: 'Duration', value: durationMs ? formatShortDuration(durationMs) : 'Permanent', inline: true },
            { name: 'Reason', value: reason, inline: false }
          ).setFooter({ text: 'Scorpion', iconURL: LOGO }).setTimestamp()] });
      } catch (e) {}
      await i.editReply({ content: `✅ Banned <@${targetUser.id}>${durationMs ? ` for ${formatShortDuration(durationMs)}` : ' permanently'}.` });
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // ===== /unban =====
  if (i.isChatInputCommand() && i.commandName === 'unban') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) return i.reply({ content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply();
    const userId = i.options.getString('user_id').trim();
    const reason = i.options.getString('reason') || 'No reason provided';
    if (!/^\d{17,20}$/.test(userId)) return i.editReply({ content: '⚠️ Invalid Discord ID.' });
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const existingBan = await guild.bans.fetch(userId).catch(() => null);
      if (!existingBan) return i.editReply({ content: `⚠️ User \`${userId}\` is not banned.` });
      await guild.bans.remove(userId, `${reason} | by ${i.user.tag}`);
      await removeBanRecord(userId, GUILD_ID);
      try {
        const log = await client.channels.fetch(BAN_LOG_CHANNEL_ID);
        if (log) await log.send({ embeds: [new EmbedBuilder().setColor(COLOR_LIGHT_BLUE).setTitle('🔓 Unban')
          .addFields(
            { name: 'User', value: `${existingBan.user.tag} (<@${userId}>)`, inline: false },
            { name: 'Moderator', value: `<@${i.user.id}>`, inline: true },
            { name: 'Reason', value: reason, inline: false }
          ).setFooter({ text: 'Scorpion', iconURL: LOGO }).setTimestamp()] });
      } catch (e) {}
      await i.editReply({ content: `✅ Unbanned ${existingBan.user.tag}.` });
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // ===== /add =====
  if (i.isChatInputCommand() && i.commandName === 'add') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) return i.reply({ content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply({ ephemeral: true });
    const tickets = await getTickets();
    const ticket = tickets[i.channelId];
    if (!ticket) return i.editReply({ content: 'Not an active ticket.' });
    const targetUser = i.options.getUser('user');
    try {
      await i.channel.permissionOverwrites.edit(targetUser.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true });
      if (!ticket.extraUsers) ticket.extraUsers = [];
      if (!ticket.extraUsers.includes(targetUser.id)) ticket.extraUsers.push(targetUser.id);
      await saveTickets(tickets);
      await i.channel.send({ content: `➕ <@${targetUser.id}> added by <@${i.user.id}>.` });
      await i.editReply({ content: `✅ Added <@${targetUser.id}>.` });
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // ===== /remove =====
  if (i.isChatInputCommand() && i.commandName === 'remove') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) return i.reply({ content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply({ ephemeral: true });
    const tickets = await getTickets();
    const ticket = tickets[i.channelId];
    if (!ticket) return i.editReply({ content: 'Not an active ticket.' });
    const targetUser = i.options.getUser('user');
    if (targetUser.id === ticket.userId) return i.editReply({ content: '⚠️ Cannot remove the ticket owner. Use `/close`.' });
    try {
      await i.channel.permissionOverwrites.delete(targetUser.id);
      if (ticket.extraUsers) ticket.extraUsers = ticket.extraUsers.filter(id => id !== targetUser.id);
      await saveTickets(tickets);
      await i.channel.send({ content: `➖ <@${targetUser.id}> removed by <@${i.user.id}>.` });
      await i.editReply({ content: `✅ Removed <@${targetUser.id}>.` });
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // ===== /close =====
  if (i.isChatInputCommand() && i.commandName === 'close') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) return i.reply({ content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role.`, ephemeral: true });
    const tickets = await getTickets();
    if (!tickets[i.channelId]) return i.reply({ content: 'Not an active ticket.', ephemeral: true });
    await i.reply({ content: '🔒 Closing ticket...' });
    await closeTicket(i.channel, i.user.id);
    return;
  }

  // ===== /rename =====
  if (i.isChatInputCommand() && i.commandName === 'rename') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) return i.reply({ content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply({ ephemeral: true });
    const tickets = await getTickets();
    if (!tickets[i.channelId]) return i.editReply({ content: 'Not an active ticket.' });
    const newName = i.options.getString('name').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
    if (!newName) return i.editReply({ content: '⚠️ Invalid name.' });
    try { await i.channel.setName(newName); await i.editReply({ content: `✅ Renamed to \`${newName}\`.` }); }
    catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // ===== Select menus =====
  if (i.isStringSelectMenu()) {
    if (i.customId === 'ticket_category_select') {
      const choice = i.values[0];

      if (choice === 'purchase') {
        await i.deferReply({ ephemeral: true });
        const products = await getProducts();
        const productNames = Object.keys(products);
        if (productNames.length === 0) return i.editReply({ content: '⚠️ No products available. Please contact staff.' });
        pendingPurchases.set(i.user.id, { productName: null, plan: null, payment: null });
        const menu = new StringSelectMenuBuilder()
          .setCustomId('purchase_product_select')
          .setPlaceholder('Select a product')
          .addOptions(productNames.slice(0, 25).map(p => ({ label: p, value: p })));
        return i.editReply({
          embeds: [new EmbedBuilder().setTitle('🛒 Purchase').setDescription('Which product do you want to buy?').setColor(COLOR_LIGHT_BLUE).setThumbnail(LOGO)],
          components: [new ActionRowBuilder().addComponents(menu)]
        });
      }

      const cat = TICKET_CATEGORIES[choice];
      if (!cat) return i.reply({ content: 'Unknown category.', ephemeral: true });

      const tickets = await getTickets();
      if (Object.values(tickets).find(t => t.userId === i.user.id)) {
        return i.reply({ content: '❌ You already have an open ticket.', ephemeral: true });
      }

      const modal = new ModalBuilder().setCustomId(`modal_create_ticket_${choice}`).setTitle(`${cat.name} Ticket`);
      const input = new TextInputBuilder()
        .setCustomId('question_answer')
        .setLabel(choice === 'support' ? 'How can we help you?' : 'Describe the bug')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return i.showModal(modal);
    }

    if (i.customId === 'purchase_product_select') {
      const data = pendingPurchases.get(i.user.id);
      if (!data) return i.update({ content: 'Session expired. Please start over.', components: [] });
      data.productName = i.values[0];
      const planMenu = new StringSelectMenuBuilder()
        .setCustomId('purchase_plan_select').setPlaceholder('Select a plan')
        .addOptions([
          { label: '1 week', value: '1 week' },
          { label: '1 month', value: '1 month' },
          { label: 'Lifetime', value: 'lifetime' },
        ]);
      return i.update({
        embeds: [new EmbedBuilder().setTitle('🛒 Purchase').setDescription(`**Product:** ${data.productName}\n\nWhich plan do you want?`).setColor(COLOR_LIGHT_BLUE).setThumbnail(LOGO)],
        components: [new ActionRowBuilder().addComponents(planMenu)]
      });
    }

    if (i.customId === 'purchase_plan_select') {
      const data = pendingPurchases.get(i.user.id);
      if (!data) return i.update({ content: 'Session expired. Please start over.', components: [] });
      data.plan = i.values[0];
      const payMenu = new StringSelectMenuBuilder()
        .setCustomId('purchase_payment_select').setPlaceholder('Select a payment method')
        .addOptions(
          Object.entries(PAYMENT_METHODS).map(([key, m]) => {
            const id = emojiToId(m.emoji);
            return { label: m.name, value: key, emoji: id ? { id } : undefined };
          })
        );
      return i.update({
        embeds: [new EmbedBuilder().setTitle('🛒 Purchase')
          .setDescription(`**Product:** ${data.productName}\n**Plan:** ${data.plan}\n\nWhich payment method do you want to use?`)
          .setColor(COLOR_LIGHT_BLUE).setThumbnail(LOGO)],
        components: [new ActionRowBuilder().addComponents(payMenu)]
      });
    }

    if (i.customId === 'purchase_payment_select') {
      const data = pendingPurchases.get(i.user.id);
      if (!data) return i.update({ content: 'Session expired. Please start over.', components: [] });
      data.payment = i.values[0];
      const paymentName = PAYMENT_METHODS[data.payment]?.name || data.payment;
      await i.deferUpdate();
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const ticketChannel = await createTicket(guild, i.user, 'purchase', {
          productName: data.productName,
          plan: data.plan,
          paymentName,
        });
        pendingPurchases.delete(i.user.id);
        await i.editReply({ content: `✅ Ticket created: <#${ticketChannel.id}>`, embeds: [], components: [] });
      } catch (e) {
        pendingPurchases.delete(i.user.id);
        await i.editReply({ content: `❌ Error: ${e.message}`, embeds: [], components: [] });
      }
      return;
    }

    if (i.customId === 'product_remove_select') {
      if (!i.member.roles.cache.has(PURCHASE_ROLE_ID)) return i.reply({ content: 'No permission.', ephemeral: true });
      const productName = i.values[0];
      const products = await getProducts();
      if (!products[productName]) return i.update({ content: 'Product not found.', components: [] });
      delete products[productName];
      await saveProducts(products);
      await updateProductPanel();
      return i.update({ content: `✅ Product **${productName}** removed.`, components: [] });
    }
  }

  // ===== Modals =====
  if (i.isModalSubmit()) {
    if (i.customId === 'product_add_modal') {
      if (!i.member.roles.cache.has(PURCHASE_ROLE_ID)) return i.reply({ content: 'No permission.', ephemeral: true });
      const name = i.fields.getTextInputValue('product_name').trim();
      const roleId = i.fields.getTextInputValue('role_id').trim().replace(/[<@&>]/g, '');
      if (!name) return i.reply({ content: '⚠️ Product name required.', ephemeral: true });
      if (!/^\d{17,20}$/.test(roleId)) return i.reply({ content: '⚠️ Invalid role ID.', ephemeral: true });
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const role = await guild.roles.fetch(roleId).catch(() => null);
        if (!role) return i.reply({ content: '⚠️ Role not found in this server.', ephemeral: true });
        const products = await getProducts();
        if (products[name]) return i.reply({ content: `⚠️ Product **${name}** already exists.`, ephemeral: true });
        products[name] = { roleId };
        await saveProducts(products);
        await updateProductPanel();
        return i.reply({ content: `✅ Product **${name}** added with role <@&${roleId}>.`, ephemeral: true });
      } catch (e) { return i.reply({ content: `Error: ${e.message}`, ephemeral: true }); }
    }

    if (i.customId.startsWith('modal_create_ticket_')) {
      const categoryKey = i.customId.replace('modal_create_ticket_', '');
      const question = i.fields.getTextInputValue('question_answer');
      await i.deferReply({ ephemeral: true });
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const ticketChannel = await createTicket(guild, i.user, categoryKey, { question });
        await i.editReply({ content: `✅ Ticket created: <#${ticketChannel.id}>` });
      } catch (e) { await i.editReply({ content: `❌ Error: ${e.message}` }); }
      return;
    }
  }

  // ===== Buttons =====
  if (i.isButton()) {
    if (i.customId.startsWith('confirm_delivery_')) {
      const parts = i.customId.split('_');
      const customerId = parts[2];
      const productName = parts[3] ? parts[3].replace(/_/g, ' ') : 'Unknown';
      const plan = parts[4] ? parts[4].replace(/_/g, ' ') : 'Unknown';

      if (i.user.id !== customerId) return i.reply({ content: '❌ Only the customer can confirm delivery.', ephemeral: true });
      await i.deferReply({ ephemeral: true });

      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const customerUser = await client.users.fetch(customerId).catch(() => i.user);

        let reviewNum = 1;
        try {
          const reviewChannel = await client.channels.fetch(REVIEW_CHANNEL_ID).catch(() => null);
          reviewNum = await nextReviewNumber(reviewChannel);
          await writeReviewCounter(reviewNum);
          cachedReviewCounter = reviewNum;
        } catch (e) { console.error('Review counter error:', e.message); }

        const reviewEmbed = new EmbedBuilder()
          .setTitle(`Review #${reviewNum}`)
          .setColor(COLOR_GOLD)
          .setThumbnail(LOGO)
          .setAuthor({ name: customerUser.displayName || customerUser.username, iconURL: customerUser.displayAvatarURL() })
          .addFields(
            { name: 'Product', value: productName, inline: true },
            { name: 'Plan', value: plan === 'lifetime' ? 'Lifetime' : plan, inline: true },
            { name: 'Customer', value: `<@${customerId}>`, inline: true }
          )
          .setDescription('✅ Verified purchase — thank you for your review!')
          .setFooter({ text: 'Scorpion', iconURL: LOGO })
          .setTimestamp();

        const reviewChannel = await client.channels.fetch(REVIEW_CHANNEL_ID).catch(() => null);
        if (reviewChannel) {
          await reviewChannel.send({ embeds: [reviewEmbed] });
        }

        const tickets = await getTickets();
        if (tickets[i.channelId]) {
          await removeTicket(i.channelId);
          setTimeout(async () => { try { await i.channel.delete('Delivery confirmed'); } catch (e) {} }, 5000);
        }

        await i.editReply({ content: `✅ Thank you! Your review has been posted in <#${REVIEW_CHANNEL_ID}>.` });
      } catch (e) {
        await i.editReply({ content: `❌ Error: ${e.message}` });
      }
      return;
    }

    if (i.customId === 'verify_accept_rules') {
      try {
        if (i.member.roles.cache.has(VERIFY_ROLE_ID)) return i.reply({ content: '❌ You are already verified!', ephemeral: true });
        await i.member.roles.add(VERIFY_ROLE_ID);
        await i.reply({ content: '✅ You have accepted the rules and are now verified!', ephemeral: true });
        setTimeout(() => { updateRulesMessage().catch(() => {}); }, 1500);
      } catch (e) { await i.reply({ content: `❌ Error: ${e.message}`, ephemeral: true }); }
      return;
    }

    if (i.customId === 'product_add') {
      if (!i.member.roles.cache.has(PURCHASE_ROLE_ID)) return i.reply({ content: 'No permission.', ephemeral: true });
      const modal = new ModalBuilder().setCustomId('product_add_modal').setTitle('Add Product');
      const input1 = new TextInputBuilder().setCustomId('product_name').setLabel('Product name').setStyle(TextInputStyle.Short).setRequired(true);
      const input2 = new TextInputBuilder().setCustomId('role_id').setLabel('Role ID (or @role)').setStyle(TextInputStyle.Short).setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input1), new ActionRowBuilder().addComponents(input2));
      return i.showModal(modal);
    }

    if (i.customId === 'product_remove') {
      if (!i.member.roles.cache.has(PURCHASE_ROLE_ID)) return i.reply({ content: 'No permission.', ephemeral: true });
      const products = await getProducts();
      const list = Object.keys(products);
      if (!list.length) return i.reply({ content: '⚠️ No products to remove.', ephemeral: true });
      const menu = new StringSelectMenuBuilder().setCustomId('product_remove_select').setPlaceholder('Select product to remove')
        .addOptions(list.slice(0, 25).map(p => ({ label: p, value: p })));
      return i.reply({ content: 'Which product do you want to remove?', components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
    }

    if (i.customId === 'legit_approve') {
      try {
        const votes = await getLegitVotes();
        votes.approve = votes.approve.filter(id => id !== i.user.id);
        votes.reject = votes.reject.filter(id => id !== i.user.id);
        votes.approve.push(i.user.id);
        const confirmed = await getConfirmedRejects();
        const newConfirmed = confirmed.filter(id => id !== i.user.id);
        if (newConfirmed.length !== confirmed.length) await saveConfirmedRejects(newConfirmed);
        await saveLegitVotes(votes);
        await refreshLegitPoll();
        await i.reply({ content: '✅ Saved as **Legit**.', ephemeral: true });
        await logVote(i.user.id, 'approve', '**Are we legit?**');
      } catch (e) { await i.reply({ content: `Error: ${e.message}`, ephemeral: true }); }
      return;
    }

    if (i.customId === 'legit_reject') {
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const tickets = await getTickets();
        const existingNotLegit = Object.entries(tickets).find(([_, t]) => t.userId === i.user.id && t.categorie === 'notlegit');
        if (existingNotLegit) return i.reply({ content: `You already have an open proof ticket: <#${existingNotLegit[0]}>.`, ephemeral: true });
        await i.deferReply({ ephemeral: true });
        const cat = TICKET_CATEGORIES.notlegit;
        const channelName = `notlegit-${i.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 90);
        const ticketChannel = await guild.channels.create({
          name: channelName, type: ChannelType.GuildText, parent: NOT_LEGIT_TICKET_CATEGORY_ID,
          permissionOverwrites: [
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
            { id: TICKET_SUPPORT_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] },
            { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
          ],
          topic: `Not-Legit proof from ${i.user.tag}`,
        });
        await addTicket(ticketChannel.id, i.user.id, 'notlegit');
        const nlt = await getNotLegitTickets();
        nlt[ticketChannel.id] = { userId: i.user.id, status: 'pending', createdAt: Date.now() };
        await saveNotLegitTickets(nlt);
        const promptEmbed = new EmbedBuilder()
          .setTitle('Upload proof').setColor(COLOR_RED).setThumbnail(LOGO)
          .setDescription(`Please upload your proof here (screenshots, video, files).\n\nStaff will review it and click **Positive** or **False**.`)
          .setFooter({ text: 'Scorpion', iconURL: LOGO }).setTimestamp();
        const closeRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('ticket_close').setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger)
        );
        await ticketChannel.send({ content: `<@${i.user.id}> <@&${TICKET_TAG_ROLE_ID}>`, embeds: [promptEmbed], components: [notLegitReviewRow(), closeRow] });
        await i.editReply({ content: `✅ Ticket created: <#${ticketChannel.id}>` });
      } catch (e) { try { await i.editReply({ content: `Error: ${e.message}` }); } catch (_) {} }
      return;
    }

    if (i.customId === 'notlegit_positive' || i.customId === 'notlegit_false') {
      if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) return i.reply({ content: 'Only staff.', ephemeral: true });
      await i.deferReply({ ephemeral: true });
      const nlt = await getNotLegitTickets();
      const entry = nlt[i.channelId];
      const tickets = await getTickets();
      const ticket = tickets[i.channelId];
      if (!entry || !ticket || ticket.categorie !== 'notlegit') return i.editReply({ content: 'Not a Not-Legit ticket.' });
      if (entry.status !== 'pending') return i.editReply({ content: `Already reviewed as **${entry.status}**.` });
      try {
        const targetUserId = entry.userId;
        const votes = await getLegitVotes();
        const confirmed = await getConfirmedRejects();
        if (i.customId === 'notlegit_positive') {
          if (!votes.reject.includes(targetUserId)) votes.reject.push(targetUserId);
          if (!confirmed.includes(targetUserId)) confirmed.push(targetUserId);
          await saveLegitVotes(votes);
          await saveConfirmedRejects(confirmed);
          await setNotLegitStatus(i.channelId, 'positive');
          await refreshLegitPoll();
          await i.channel.send({ embeds: [new EmbedBuilder().setTitle('✅ Reviewed: Positive').setColor(COLOR_LIGHT_BLUE).setThumbnail(LOGO)
            .setDescription(`Proof from <@${targetUserId}> is **valid**. ❌ vote added.\nReviewed by: <@${i.user.id}>`)
            .setFooter({ text: 'Scorpion', iconURL: LOGO }).setTimestamp()] });
          await i.editReply({ content: '✅ Positive.' });
        } else {
          await setNotLegitStatus(i.channelId, 'false');
          await i.channel.send({ embeds: [new EmbedBuilder().setTitle('❌ Reviewed: False').setColor(COLOR_RED).setThumbnail(LOGO)
            .setDescription(`Proof from <@${targetUserId}> is **not valid**. No vote added.\nReviewed by: <@${i.user.id}>`)
            .setFooter({ text: 'Scorpion', iconURL: LOGO }).setTimestamp()] });
          await i.editReply({ content: '❌ False.' });
        }
      } catch (e) { try { await i.editReply({ content: `Error: ${e.message}` }); } catch (_) {} }
      return;
    }

    if (i.customId === 'ticket_close') {
      try {
        const tickets = await getTickets();
        const ticket = tickets[i.channelId];
        if (!ticket) return i.reply({ content: 'Not a ticket.', ephemeral: true });
        const isOwner = ticket.userId === i.user.id;
        const isStaff = i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID);
        if (!isOwner && !isStaff) return i.reply({ content: 'No permission.', ephemeral: true });
        await i.reply({ content: '🔒 Closing...' });
        await closeTicket(i.channel, i.user.id);
      } catch (e) { await i.reply({ content: `Error: ${e.message}`, ephemeral: true }); }
      return;
    }

    if (i.customId.startsWith('suggest_approve_') || i.customId.startsWith('suggest_reject_')) {
      const messageId = i.customId.split('_').pop();
      if (!i.member.roles.cache.has(CUSTOMER_ROLE_ID)) return i.reply({ content: `You need the <@&${CUSTOMER_ROLE_ID}> role.`, ephemeral: true });
      try {
        const suggestions = await getSuggestions();
        const s = suggestions[messageId];
        if (!s) return i.reply({ content: 'Suggestion no longer exists.', ephemeral: true });
        const isApprove = i.customId.startsWith('suggest_approve_');
        s.approve = s.approve.filter(id => id !== i.user.id);
        s.reject = s.reject.filter(id => id !== i.user.id);
        if (isApprove) s.approve.push(i.user.id);
        else s.reject.push(i.user.id);
        await saveSuggestions(suggestions);
        await i.update({ embeds: [buildSuggestionEmbed(s)], components: [buildSuggestionRow(messageId, s)] });
        await logVote(i.user.id, isApprove ? 'approve' : 'reject', `suggestion: **${s.tekst.slice(0, 80)}**`);
      } catch (e) { await i.reply({ content: `Error: ${e.message}`, ephemeral: true }); }
      return;
    }
  }
});

// ===== Welcome =====
client.on('guildMemberAdd', async (member) => {
  if (member.guild.id !== GUILD_ID) return;
  try {
    const channel = await client.channels.fetch(WELCOME_CHANNEL_ID).catch(() => null);
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setTitle('Welcome to Scorpion!')
      .setColor(COLOR_LIGHT_BLUE)
      .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
      .setDescription(
        `Welcome <@${member.id}>! 🎉\n\n` +
        `Please read the rules in <#${RULES_CHANNEL_ID}> and accept them to get access.\n\n` +
        `> 🛒 Products → <#${PRICING_CHANNEL_ID}>\n` +
        `> 🎫 Need help? Open a ticket.`
      )
      .setFooter({ text: `Member #${member.guild.memberCount}`, iconURL: LOGO })
      .setTimestamp();
    await channel.send({ embeds: [embed] });
  } catch (e) { console.error('Welcome:', e.message); }
  await updateRulesMessage();
});

// ===== Member leave =====
client.on('guildMemberRemove', async (member) => {
  if (member.guild.id !== GUILD_ID) return;
  try {
    const purchases = await getPurchases();
    const had = purchases.find(p => p.userId === member.id);
    if (!had) return;
    await savePurchases(purchases.filter(p => p.userId !== member.id));
    await updateOverview();
  } catch (e) {}
});

// ===== Role update (verify count) =====
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  if (newMember.guild.id !== GUILD_ID) return;
  const hadRole = oldMember.roles.cache.has(VERIFY_ROLE_ID);
  const hasRole = newMember.roles.cache.has(VERIFY_ROLE_ID);
  if (hadRole !== hasRole) {
    setTimeout(() => { updateRulesMessage().catch(() => {}); }, 1000);
  }
});

// ===== Channel delete =====
client.on('channelDelete', async (channel) => {
  try {
    const tickets = await getTickets();
    if (tickets[channel.id]) { delete tickets[channel.id]; await saveTickets(tickets); }
    const nlt = await getNotLegitTickets();
    if (nlt[channel.id]) { delete nlt[channel.id]; await saveNotLegitTickets(nlt); }
  } catch (e) {}
});

// ===== Ready =====
client.once('ready', async () => {
  console.log(`Online as ${client.user.tag}`);
  startStatusInterval();
  startExpiryInterval();
  startBanInterval();

  await updateOverview();
  startOverviewInterval();

  await updateKeyOverview();
  startKeyOverviewInterval();

  await setupRules();
  await setupPricing();
  await setupTicketPanel();
  await setupLegitPoll();
  await setupProductPanel();
  await setupPaymentMethods();

  await restoreGiveaways();
});

client.login(TOKEN);
