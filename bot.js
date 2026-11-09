'use strict';
/*
 * DigiByte (DGB) Refer & Earn Airdrop Bot — built for Render
 *  - all users / balances / settings live in PostgreSQL (survives restarts)
 *  - instant withdrawals: the bot signs DGB transactions itself and broadcasts via a public explorer API
 *  - /health web endpoint + self-ping so a free Render service stays awake
 */
const http = require('http');
const he = require('he');
const { Pool } = require('pg');
const bitcoin = require('bitcoinjs-lib'); // v5.x
const { toHTML } = require('@telegraf/entity');
const { Telegraf, session, Scenes } = require('telegraf');
const fs = require('fs');
const path = require('path');
const { BaseScene: Scene, Stage } = Scenes;

/* ====================================================================
 *  CONFIG
 *  Secrets (token, database, wallet key) come from Render environment variables.
 * ==================================================================== */
const CONFIG = {
  BOT_TOKEN: (process.env.BOT_TOKEN || 'PASTE_NEW_BOT_TOKEN_HERE').trim(),
  DATABASE_URL: (process.env.DATABASE_URL || '').trim(),
  DATABASE_SSL: process.env.DATABASE_SSL === 'true', // true only if you use Render's EXTERNAL db url

  // Hot wallet private key (WIF). Create one with:  node gen-wallet.js
  DGB_WIF: (process.env.DGB_WIF || '').trim(),

  // Public explorer APIs used to read UTXOs and broadcast. Tried in order.
  // Format: "insight|https://host/api"  or  "blockbook|https://host/api"   (comma separated)
  EXPLORER_API_KEY: (process.env.EXPLORER_API_KEY || '').trim(), // free key from nownodes.io (sent as the "api-key" header)
  EXPLORER_APIS: (process.env.EXPLORER_APIS || 'blockbook|https://dgbbook.nownodes.io/api').split(',').map((s) => s.trim()).filter(Boolean),
  FEE_SAT_PER_BYTE: Number(process.env.FEE_SAT_PER_BYTE) || 500, // network fee; 500 sat/byte is about 0.001 DGB per withdrawal
  DUST_SAT: 100000, // change smaller than this (0.001 DGB) is added to the fee
  MAX_WITHDRAW_PER_TX: 0, // max DGB per withdrawal request, 0 = no limit

  // ---- Gorilla Case task (shown after the Telegram channel join step) ----
  GORILLA_LINK: 'https://t.me/GorillaCaseBot/app?startapp=r_100000000625',
  GORILLA_BUTTON_TEXT: '🦍 Spin Gorilla Case',
  TASK_WAIT_SECONDS: 10, // "Continue" / "Completed" pressed sooner than this = task failed
  TASK_AT_SIGNUP: true, // true = Gorilla task is part of registration: channels -> task -> wallet address -> home
  TASK_TEXT:
    '🚀 <b>Spin Gorilla Case for Free</b>\n\n' +
    'After Completing Task please click on <b>"✅ Continue"</b>',
  TASK_FAIL_TEXT:
    "❌ <b>You didn't completed the task properly, Please make sure to Spin Gorilla Case</b>\n\n" +
    'After completing task click <b>"✅ Continue"</b>',

  // ---- 🎁 Bonus button (one-time bonus, needs the Gorilla task) ----
  BONUS_FAIL_TEXT:
    "❌ <b>You didn't completed the task properly, Please make sure to Spin Gorilla Case</b>\n\n" +
    'After completing task click <b>"✅ Completed"</b>'
};

/* ====================================================================
 *  Pure helpers (no I/O)
 * ==================================================================== */
// pick inputs (largest first) and work out fee / change. P2PKH inputs, up to 2 outputs.
function selectInputs(utxos, amtSat, rate, dustSat) {
  const sorted = [...utxos].sort((a, b) => b.sat - a.sat);
  const picked = [];
  let total = 0;
  for (const u of sorted) {
    picked.push(u);
    total += u.sat;
    const fee = (148 * picked.length + 34 * 2 + 10) * rate;
    if (total >= amtSat + fee) {
      const change = total - amtSat - fee;
      if (change < dustSat) return { picked, fee: total - amtSat, change: 0 };
      return { picked, fee, change };
    }
    if (picked.length >= 150) break;
  }
  return null;
}

module.exports = { selectInputs }; // exported for tests

if (require.main !== module) return; // when imported by a test, stop here

if (CONFIG.BOT_TOKEN.startsWith('PASTE_') || !CONFIG.DATABASE_URL) {
  console.error('Set the BOT_TOKEN and DATABASE_URL environment variables first.');
  process.exit(1);
}

// default settings (seed). After first start the live copy is kept in the database.
let data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));

const options = [
  'Welcome Message', 'Bonus', 'Refer', 'Withdraw', 'Currency', 'Broad Speed',
  'Add Check', 'Remove Check', 'Withdraw Settings', 'Add Admin', 'Remove Admin',
  'Bot Off Text', 'On / Off Bot'
];
const withdraw_options = ['Auto Instant', 'Manual', 'Block-Chain Url', 'Payout Channel', 'Wallet Balance', '⬅️ Back'];

const slug = (w) => w.replace(/ /g, '-').toLowerCase();
const cb = (w) => 'adhymn_' + slug(w);
const chunk2 = (arr) => { const r = []; for (let i = 0; i < arr.length; i += 2) r.push(arr.slice(i, i + 2)); return r; };
const adminRows = () => chunk2(options.map((w) => ({ text: w, callback_data: cb(w) })));
const wdRows = () => chunk2(withdraw_options.map((w) => ({
  text: (w.includes('Auto') || w.includes('Manual')) ? (slug(w) === data.with_type ? w + '✅' : w + '❌') : w,
  callback_data: cb(w)
})));

const isAdmin = (id) => data.bot_admin.includes(id);
const round8 = (n) => Math.round(Number(n) * 1e8) / 1e8;
const fmt = (n) => Number(n || 0).toFixed(8).replace(/\.?0+$/, '');
const isNumeric = (n) => !isNaN(parseFloat(n)) && isFinite(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ====================================================================
 *  PostgreSQL
 * ==================================================================== */
const pool = new Pool({
  connectionString: CONFIG.DATABASE_URL,
  ssl: CONFIG.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  max: 8
});
pool.on('error', (e) => console.log('DB pool error:', e.message));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}',
      reset BOOLEAN NOT NULL DEFAULT false,
      ref_count INT GENERATED ALWAYS AS (
        CASE WHEN jsonb_typeof(data->'ref') = 'array' THEN jsonb_array_length(data->'ref') ELSE 0 END
      ) STORED,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_address_uq ON users ((data->>'address')) WHERE data->>'address' IS NOT NULL;
    CREATE INDEX IF NOT EXISTS users_ref_idx ON users (ref_count DESC);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS withdrawals (
      id SERIAL PRIMARY KEY, user_id BIGINT, address TEXT, amount NUMERIC,
      txid TEXT, status TEXT, error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function loadSettings() {
  const r = await pool.query("SELECT value FROM settings WHERE key = 'config'");
  const seed = data; // values from data.json
  if (r.rows[0]) {
    const saved = r.rows[0].value;
    data = { ...seed, ...saved, but: seed.but }; // button layout always comes from data.json
    data.bot_admin = [...new Set([...seed.bot_admin, ...(data.bot_admin || [])])]; // seed admins can't be locked out
    // raise "seed_version" in data.json to make the welcome/address texts in data.json replace the saved ones
    if ((seed.seed_version || 0) > (saved.seed_version || 0)) {
      data.welcome = seed.welcome;
      data.address = seed.address;
      data.seed_version = seed.seed_version;
      await saveData();
    }
  }
  else await saveData();
}
const saveData = () => pool.query(
  "INSERT INTO settings(key, value) VALUES('config', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [data]);

async function getUserData(id) {
  const r = await pool.query('SELECT data FROM users WHERE id = $1', [id]);
  return r.rows[0] ? r.rows[0].data : {};
}

/*
 * Safe read-modify-write on one user inside a transaction with a row lock.
 * fn(user) mutates `user` in place and may return a value. If the user doesn't exist,
 * fn gets null (or a new empty user when create = true).
 */
async function withUser(id, fn, create = false) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    let r = await c.query('SELECT data FROM users WHERE id = $1 FOR UPDATE', [id]);
    let u = null;
    if (r.rows.length) u = r.rows[0].data;
    else if (create) {
      await c.query('INSERT INTO users(id, data) VALUES($1, $2) ON CONFLICT (id) DO NOTHING', [id, {}]);
      r = await c.query('SELECT data FROM users WHERE id = $1 FOR UPDATE', [id]);
      u = r.rows[0].data;
    }
    const result = await fn(u);
    if (u) await c.query('UPDATE users SET data = $2 WHERE id = $1', [id, u]);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// Telegraf session (scene state) stored in the database so restarts don't break flows
const pgSessionStore = {
  async get(key) { const r = await pool.query('SELECT value FROM sessions WHERE key = $1', [key]); return r.rows[0] ? r.rows[0].value : undefined; },
  async set(key, value) { await pool.query('INSERT INTO sessions(key, value) VALUES($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()', [key, value]); },
  async delete(key) { await pool.query('DELETE FROM sessions WHERE key = $1', [key]); }
};

const logWithdrawal = async (uid, addr, amt, status) =>
  (await pool.query('INSERT INTO withdrawals(user_id, address, amount, status) VALUES($1,$2,$3,$4) RETURNING id', [uid, addr, amt, status])).rows[0].id;
const updateWithdrawal = (id, status, txid, err) =>
  pool.query('UPDATE withdrawals SET status = $2, txid = $3, error = $4 WHERE id = $1', [id, status, txid || null, err || null]);

/* ====================================================================
 *  DigiByte wallet (no node needed)
 * ==================================================================== */
const DGB = {
  messagePrefix: '\x19DigiByte Signed Message:\n',
  bech32: 'dgb',
  bip32: { public: 0x0488b21e, private: 0x0488ade4 },
  pubKeyHash: 0x1e, // addresses starting with D
  scriptHash: 0x3f, // addresses starting with S
  wif: 0x80
};

let keyPair = null;
let HOT_ADDRESS = null;
if (CONFIG.DGB_WIF) {
  try {
    keyPair = bitcoin.ECPair.fromWIF(CONFIG.DGB_WIF, DGB);
    HOT_ADDRESS = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: DGB }).address;
  } catch (e) {
    console.error('DGB_WIF is not a valid DigiByte WIF key:', e.message);
  }
}

const EXPLORERS = CONFIG.EXPLORER_APIS.map((s) => {
  const [type, ...rest] = s.includes('|') ? s.split('|') : ['insight', s];
  return { type: type.toLowerCase(), url: rest.join('|').replace(/\/+$/, '') };
});

// errors where we are SURE nothing was sent get safe = true (balance can be refunded automatically)
const safeError = (msg) => Object.assign(new Error(msg), { safe: true });

function isValidDgbAddress(addr) {
  try { bitcoin.address.toOutputScript(addr, DGB); return true; } catch (e) { return false; }
}

function hintFor(msg) {
  const m = String(msg);
  if (/HTTP 401|API_key|NOT set/i.test(m)) return 'Set a valid EXPLORER_API_KEY (free key from nownodes.io) in Render -> Environment, then redeploy.';
  if (/HTTP 403/i.test(m)) return 'The explorer refused the key (blocked or plan limit). Check your NOWNodes dashboard.';
  if (/HTTP 404/i.test(m)) return 'Wrong explorer address in EXPLORER_APIS. It should be: blockbook|https://dgbbook.nownodes.io/api';
  if (/HTTP 429/i.test(m)) return 'Too many requests to the explorer. Wait a minute, or check your NOWNodes limit.';
  if (/Insufficient hot wallet/i.test(m)) return 'The hot wallet has too little confirmed DGB. Send DGB to the hot wallet address and wait about a minute.';
  if (/fee/i.test(m)) return 'The fee may be too low. Add FEE_SAT_PER_BYTE = 1000 in Render -> Environment.';
  if (/missing inputs|conflict|spent/i.test(m)) return 'The coins were just spent by another payout. Wait a minute and try again.';
  if (/timeout|fetch failed|ENOTFOUND|ECONN/i.test(m)) return 'The explorer could not be reached. Try again in a minute.';
  return '';
}

async function httpJson(method, url, body, contentType) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const isObj = body && typeof body === 'object';
    const res = await fetch(url, {
      method,
      signal: ctl.signal,
      headers: {
        ...(CONFIG.EXPLORER_API_KEY ? { 'api-key': CONFIG.EXPLORER_API_KEY } : {}),
        ...(body ? { 'Content-Type': contentType || (isObj ? 'application/json' : 'text/plain') } : {})
      },
      body: body ? (isObj ? JSON.stringify(body) : body) : undefined
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { ok: res.ok, status: res.status, json, text };
  } finally { clearTimeout(t); }
}

async function fetchUtxos(address) {
  const errors = [];
  for (const api of EXPLORERS) {
    try {
      const url = api.type === 'blockbook' ? `${api.url}/v2/utxo/${address}` : `${api.url}/addr/${address}/utxo`;
      const r = await httpJson('GET', url);
      if (r.ok && Array.isArray(r.json)) {
        if (api.type === 'blockbook') return r.json.map((u) => ({ txid: u.txid, vout: u.vout, sat: Number(u.value) }));
        return r.json.map((u) => ({ txid: u.txid, vout: u.vout, sat: u.satoshis != null ? Number(u.satoshis) : Math.round(Number(u.amount) * 1e8) }));
      }
      // show the real reason (HTTP code + start of the reply), e.g. "HTTP 401: Missing API_key"
      errors.push(api.url + ' -> HTTP ' + r.status + ': ' + String(r.text).replace(/\s+/g, ' ').slice(0, 120) +
        (CONFIG.EXPLORER_API_KEY ? '' : ' [EXPLORER_API_KEY is NOT set]'));
    } catch (e) { errors.push(api.url + ' -> ' + e.message); }
  }
  throw safeError('Explorer API unavailable: ' + errors.join('; '));
}

// UTXOs we spent / change we created a moment ago may not show on the explorer yet — track them locally
const recentSpent = new Map(); // "txid:vout" -> timestamp
let recentChange = []; // { txid, vout, sat, ts }
const TRACK_MS = 5 * 60 * 1000;

async function getSpendable() {
  const now = Date.now();
  for (const [k, ts] of recentSpent) if (now - ts > TRACK_MS) recentSpent.delete(k);
  recentChange = recentChange.filter((c) => now - c.ts < TRACK_MS);
  const list = (await fetchUtxos(HOT_ADDRESS)).filter((u) => !recentSpent.has(u.txid + ':' + u.vout));
  const have = new Set(list.map((u) => u.txid + ':' + u.vout));
  for (const c of recentChange) {
    const k = c.txid + ':' + c.vout;
    if (!have.has(k) && !recentSpent.has(k)) list.push({ txid: c.txid, vout: c.vout, sat: c.sat });
  }
  return list;
}

async function broadcastRaw(hex) {
  let ambiguous = false;
  const rejects = [];
  for (const api of EXPLORERS) {
    try {
      let r = api.type === 'blockbook'
        ? await httpJson('POST', `${api.url}/v2/sendtx/`, hex, 'text/plain')
        : await httpJson('POST', `${api.url}/tx/send`, { rawtx: hex });
      const accepted = (x) => x.ok && !(x.json && x.json.error);
      const dup = (x) => /already|known|exists|in block chain/i.test(x.text || ''); // same tx already accepted
      if (accepted(r) || dup(r)) return;
      if (api.type === 'blockbook') { // second way: hex in the URL (the same transaction, so repeating is harmless)
        const g = await httpJson('GET', `${api.url}/v2/sendtx/${hex}`);
        if (accepted(g) || dup(g)) return;
        r = { status: r.status, text: 'POST: HTTP ' + r.status + ' ' + r.text + ' | GET: HTTP ' + g.status + ' ' + g.text };
      }
      rejects.push(api.url + ' -> ' + String(r.text).replace(/\s+/g, ' ').slice(0, 220));
    } catch (e) { // timeout / network: we cannot know if it went through
      ambiguous = true;
      rejects.push(api.url + ' -> ' + e.message);
    }
  }
  if (ambiguous) throw Object.assign(new Error('Broadcast outcome unknown: ' + rejects.join('; ')), { safe: false });
  throw safeError('Broadcast rejected: ' + rejects.join('; '));
}

async function doSend(to, amt) {
  if (!keyPair) throw safeError('Hot wallet key (DGB_WIF) is not configured');
  if (!isValidDgbAddress(to)) throw safeError('Invalid destination address');
  const amtSat = Math.round(amt * 1e8);
  const sel = selectInputs(await getSpendable(), amtSat, CONFIG.FEE_SAT_PER_BYTE, CONFIG.DUST_SAT);
  if (!sel) throw safeError('Insufficient hot wallet funds');

  const txb = new bitcoin.TransactionBuilder(DGB);
  txb.setVersion(1);
  sel.picked.forEach((u) => txb.addInput(u.txid, u.vout));
  txb.addOutput(to, amtSat);
  if (sel.change > 0) txb.addOutput(HOT_ADDRESS, sel.change);
  sel.picked.forEach((u, i) => txb.sign(i, keyPair));
  const tx = txb.build();
  const txid = tx.getId();

  const now = Date.now();
  sel.picked.forEach((u) => recentSpent.set(u.txid + ':' + u.vout, now));
  recentChange = recentChange.filter((c) => !sel.picked.some((u) => u.txid === c.txid && u.vout === c.vout));
  try {
    await broadcastRaw(tx.toHex());
  } catch (e) {
    if (e.safe) sel.picked.forEach((u) => recentSpent.delete(u.txid + ':' + u.vout)); // rejected: inputs are free again
    throw e;
  }
  if (sel.change > 0) recentChange.push({ txid, vout: 1, sat: sel.change, ts: now });
  return txid;
}

// one transaction at a time, so two withdrawals never pick the same coins
let sendQueue = Promise.resolve();
function sendDgb(to, amt) {
  const p = sendQueue.then(() => doSend(to, amt));
  sendQueue = p.catch(() => {});
  return p;
}

/* ====================================================================
 *  Bot + scenes
 * ==================================================================== */
const bot = new Telegraf(CONFIG.BOT_TOKEN);
const stage = new Stage();
const botStartTime = Date.now();

const address = new Scene('address');
const onWithdraw = new Scene('onWithdraw');
const getMsg = new Scene('getMsg');
stage.register(address, onWithdraw, getMsg);

bot.use(session({ store: pgSessionStore }));
bot.use(stage.middleware());

async function notifyAdmins(text) {
  for (const id of data.bot_admin) bot.telegram.sendMessage(id, text).catch(() => {});
}

bot.on('message', async (ctx, next) => {
  if (ctx.chat.type !== 'private' || ctx.message.date * 1000 < botStartTime - 10 * 60 * 1000) return;
  if (ctx.message.text === '/cancel') {
    ctx.replyWithMarkdown('*Done*');
    ctx.scene.leave();
    return;
  }
  const fwd = ctx.message.forward_from_chat || (ctx.message.forward_origin && ctx.message.forward_origin.chat);
  if (fwd && isAdmin(ctx.from.id)) { // helper: forward any post of a channel to get its numeric ID
    return ctx.reply('📢 ' + (fwd.title || '') + '\nChat ID: ' + fwd.id + (fwd.username ? '\nUsername: @' + fwd.username : '') +
      '\n\nUse /admin -> Add Check and send this ' + (fwd.username ? 'username' : 'ID') + ' to enforce joining.');
  }
  if (data.bot || isAdmin(ctx.from.id)) return next();
  ctx.replyWithHTML(data.bot_text);
});

async function check(ctx, next) {
  const u = await getUserData(ctx.from.id);
  if (!u.address) return ctx.replyWithMarkdown('*Register Now With /start*');
  await next();
}

/* ---------------- registration flow ---------------- */
bot.start(async (ctx) => {
  try {
    if (ctx.chat.type !== 'private') return;
    const uid = ctx.from.id;
    const ref = Number(ctx.startPayload);
    let validRef = false;
    if (ref && ref !== uid) validRef = !!(await getUserData(ref)).address; // referrer must be registered

    const isNew = await withUser(uid, (u) => {
      if (u.bal !== undefined) return false;
      u.bal = 0; // the bonus is claimed with the 🎁 Bonus button
      u.ref = [];
      if (validRef) u.pendref = ref;
      return true;
    }, true);

    if (isNew && validRef) {
      bot.telegram.sendMessage(ref,
        '<a href="tg://user?id=' + uid + '"><b>' + he.encode(ctx.from.first_name) + '</b></a> <b>Has started bot with your refer link.</b>\n<i>You will be rewarded when he complete his registration</i>',
        { parse_mode: 'HTML' }).catch(() => {});
    }
    ctx.reply(data.welcome, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: '✅ Join Airdrop', callback_data: 'next' }]] }
    });
  } catch (e) { console.log(e); }
});

function sendTask(ctx, text) {
  return ctx.reply(text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [{ text: CONFIG.GORILLA_BUTTON_TEXT, url: CONFIG.GORILLA_LINK }],
        [{ text: '✅ Continue', callback_data: 'task_continue' }]
      ]
    }
  });
}

// Step 1: verify Telegram channels, then show the Gorilla Case task
bot.action('next', async (ctx) => {
  try {
    for (const ch of data.check) {
      let status;
      try {
        status = (await bot.telegram.getChatMember(/^-?\d+$/.test(String(ch)) ? Number(ch) : ch, ctx.from.id)).status;
      } catch (e) {
        console.log('Cannot verify ' + ch + ' (is the bot admin there?): ' + e.message);
        continue;
      }
      if (!['creator', 'administrator', 'member'].includes(status)) {
        await ctx.answerCbQuery().catch(() => {});
        return ctx.replyWithMarkdown('*Must Join All Channels First*');
      }
    }
    await ctx.answerCbQuery().catch(() => {});
    const ok = await withUser(ctx.from.id, (u) => {
      if (u.bal === undefined) return false;
      u.task_started = Date.now();
      return true;
    });
    if (!ok) return ctx.reply('Register with /start first');
    ctx.deleteMessage().catch(() => {});
    if (!CONFIG.TASK_AT_SIGNUP) { // go straight to the wallet step
      await ctx.replyWithMarkdown(data.address, { disable_web_page_preview: true });
      return ctx.scene.enter('address');
    }
    await sendTask(ctx, CONFIG.TASK_TEXT);
  } catch (e) { console.log(e); }
});

// Step 2: "✅ Continue" — only accepted TASK_WAIT_SECONDS after the task was shown
bot.action('task_continue', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const res = await withUser(ctx.from.id, (u) => {
      if (u.bal === undefined) return 'noreg';
      if (!u.task_started) { u.task_started = Date.now(); return 'fail'; }
      if (Date.now() - u.task_started < CONFIG.TASK_WAIT_SECONDS * 1000) return 'fail';
      delete u.task_started;
      u.task_done = true;
      return 'ok';
    });
    if (res === 'noreg') return ctx.reply('Register with /start first');
    ctx.deleteMessage().catch(() => {});
    if (res === 'fail') return sendTask(ctx, CONFIG.TASK_FAIL_TEXT);
    await ctx.replyWithMarkdown(data.address, { disable_web_page_preview: true });
    ctx.scene.enter('address');
  } catch (e) { console.log(e); }
});

// Step 3: DigiByte address
address.on('text', async (ctx) => {
  try {
    const uid = ctx.from.id;
    const addr = ctx.message.text.trim();
    if (!isValidDgbAddress(addr)) {
      return ctx.replyWithMarkdown('❌ *Not a valid DigiByte address.*\nIt should start with `D`, `S` or `dgb1`. Please send it again.');
    }
    let refId = null;
    try {
      refId = await withUser(uid, (u) => {
        u.address = addr;
        const r = u.pendref;
        delete u.pendref;
        if (r && !u.invited) { u.invited = r; return r; }
        return null;
      }, true);
    } catch (e) {
      if (e.code === '23505') { // unique index: address already used by another account
        return ctx.replyWithMarkdown('❌ *This address is already registered by another account.* Please send a different one.');
      }
      throw e;
    }
    await ctx.scene.leave();

    if (refId) {
      const ok = await withUser(refId, (r) => {
        if (!r || r.bal === undefined) return false;
        r.bal = round8((Number(r.bal) || 0) + Number(data.reffer_bonus || 0));
        r.ref = r.ref || [];
        if (!r.ref.includes(uid)) r.ref.push(uid);
        return true;
      });
      if (ok) {
        bot.telegram.sendMessage(refId,
          '*🎯 A New Referral has registered the bot using your referral link :* [' + ctx.from.first_name.replace(/[\[\]_*`]/g, '') + '](tg://user?id=' + uid + ')',
          { parse_mode: 'Markdown' }).catch(() => {});
      }
    }
    ctx.replyWithMarkdown('*🎉 Welcome In Our ' + data.bot_cur + ' Airdrop*',
      { disable_web_page_preview: true, reply_markup: { keyboard: data.but, resize_keyboard: true } });
  } catch (e) { console.log(e); }
});

/* ---------------- user menu ---------------- */
bot.hears('📊 Statistics', check, async (ctx) => {
  const u = await getUserData(ctx.from.id);
  const pos = await pool.query('SELECT COUNT(*) + 1 AS p FROM users WHERE ref_count > (SELECT ref_count FROM users WHERE id = $1)', [ctx.from.id]);
  const inv = u.invited ? '<a href="tg://user?id=' + u.invited + '"><b>' + u.invited + '</b></a>' : '<b>N/A</b>';
  ctx.reply(`<b>👋Hello <a href="tg://user?id=${ctx.from.id}"><b>${he.encode(ctx.from.first_name)}</b></a> Here is your statistics </b>

<b>===============================
🔗 You are invited by</b> ${inv}
<b>👫 Referral :</b> ${(u.ref || []).length}
<b>📊 Airdrop balance:</b> ${fmt(u.bal)} ${he.encode(data.bot_cur)}
<b>🏆 Your position:</b> ${pos.rows[0].p}
<b>🙇‍♀️ Your personal referral link:</b> <code>https://t.me/${ctx.botInfo.username}?start=${ctx.from.id}</code>

<b>===============================

👨‍✈️ Telegram:</b> <a href="tg://user?id=${ctx.from.id}"><b>${ctx.from.id}</b></a>
<b>📥 Wallet: </b> <code>${he.encode(u.address || 'N/A')}</code>

<b><i>‼️ If your submitted data is wrong you can restart the bot with /start and resubmit it before the airdrop ends.</i></b>`,
    { parse_mode: 'HTML', disable_web_page_preview: true });
});

/* ---------------- 🎁 Bonus: one-time, needs the Gorilla Case task ---------------- */
const bonusText = () =>
  '🎁 <b>Claim your ' + fmt(data.bonus) + ' ' + he.encode(data.bot_cur) + ' bonus</b>\n\n' +
  '🚀 <b>Spin Gorilla Case for Free</b>\n\n' +
  'After completing the task, click <b>"✅ Completed"</b>';

function sendBonusTask(ctx, text) {
  return ctx.reply(text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [{ text: CONFIG.GORILLA_BUTTON_TEXT, url: CONFIG.GORILLA_LINK }],
        [{ text: '✅ Completed', callback_data: 'bonus_done' }]
      ]
    }
  });
}

bot.hears('🎁 Bonus', check, async (ctx) => {
  try {
    const res = await withUser(ctx.from.id, (u) => {
      if (u.bonus_claimed) return 'claimed';
      u.bonus_started = Date.now(); // the wait starts when the task is shown
      return 'ok';
    });
    if (res === 'claimed') return ctx.replyWithMarkdown('✅ *You have already claimed your bonus.*');
    await sendBonusTask(ctx, bonusText());
  } catch (e) { console.log(e); }
});

bot.action('bonus_done', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const amt = round8(Number(data.bonus) || 0);
    // everything happens in one locked transaction, so the bonus can only ever be paid once
    const res = await withUser(ctx.from.id, (u) => {
      if (u.bal === undefined) return 'noreg';
      if (u.bonus_claimed) return 'claimed';
      if (!u.bonus_started) { u.bonus_started = Date.now(); return 'fail'; }
      if (Date.now() - u.bonus_started < CONFIG.TASK_WAIT_SECONDS * 1000) return 'fail';
      u.bal = round8((Number(u.bal) || 0) + amt);
      u.bonus_claimed = true;
      delete u.bonus_started;
      return 'ok';
    });
    if (res === 'noreg') return ctx.reply('Register with /start first');
    ctx.deleteMessage().catch(() => {});
    if (res === 'claimed') return ctx.replyWithMarkdown('✅ *You have already claimed your bonus.*');
    if (res === 'fail') return sendBonusTask(ctx, CONFIG.BONUS_FAIL_TEXT);
    ctx.replyWithMarkdown('🎉 *Bonus claimed!* `+' + fmt(amt) + ' ' + data.bot_cur + '` has been added to your balance.');
  } catch (e) { console.log(e); }
});

bot.hears('/stat', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const r = await pool.query('SELECT COUNT(*) AS n FROM users');
  ctx.replyWithMarkdown('*Total : ' + r.rows[0].n + ' Users*');
});

/* ---------------- withdraw (instant) ---------------- */
bot.hears('📤 Withdraw', check, async (ctx) => {
  const u = await getUserData(ctx.from.id);
  const bal = Number(u.bal) || 0;
  if (bal < data.min_wd) {
    return ctx.reply('🔐 To withdraw, you need to complete the following missions:\n\n👥 At least ' + data.min_wd + ' ' + data.bot_cur + ' in Balance\n🌀 Status: ' + fmt(bal) + ' / ' + data.min_wd);
  }
  await ctx.reply('*📤 Enter the amount to be withdrawn to your wallet*\n\n*Address*\n`' + u.address + '`\n\n*Available for withdrawal*\n`' + fmt(bal) + ' ' + data.bot_cur + '`',
    { parse_mode: 'Markdown', reply_markup: { keyboard: [['Back 🔙']], resize_keyboard: true } });
  ctx.scene.enter('onWithdraw');
});

bot.hears('Back 🔙', check, (ctx) =>
  ctx.replyWithMarkdown('_Welcome Back_', { reply_markup: { keyboard: data.but, resize_keyboard: true } }));

onWithdraw.on('text', async (ctx) => {
  const uid = ctx.from.id;
  const kb = { keyboard: data.but, resize_keyboard: true };
  try {
    await ctx.scene.leave();
    const text = ctx.message.text.trim();
    if (text === 'Back 🔙') return ctx.replyWithMarkdown('_Welcome Back_', { reply_markup: kb });
    if (!isNumeric(text)) return ctx.replyWithMarkdown('❌ _Send a value that is numeric or a number_', { reply_markup: kb });
    const amt = round8(Number(text));

    // check + deduct in ONE locked transaction, so it can never be spent twice
    const r = await withUser(uid, (u) => {
      const bal = Number(u.bal) || 0;
      if (!u.address) return { err: 'noreg' };
      if (amt <= 0 || amt < data.min_wd || amt > bal) return { err: 'range', bal };
      if (CONFIG.MAX_WITHDRAW_PER_TX > 0 && amt > CONFIG.MAX_WITHDRAW_PER_TX) return { err: 'max' };
      u.bal = round8(bal - amt);
      return { wallet: u.address };
    });
    if (r.err === 'noreg') return ctx.replyWithMarkdown('*Register Now With /start*');
    if (r.err === 'range') {
      return ctx.replyWithMarkdown('😐 Send a value of at least *' + data.min_wd + ' ' + data.bot_cur + '* and not greater than *' + fmt(r.bal) + ' ' + data.bot_cur + '*', { reply_markup: kb });
    }
    if (r.err === 'max') return ctx.replyWithMarkdown('😐 Maximum per withdrawal is *' + CONFIG.MAX_WITHDRAW_PER_TX + ' ' + data.bot_cur + '*', { reply_markup: kb });

    if (data.with_type === 'manual') {
      await logWithdrawal(uid, r.wallet, amt, 'manual');
      bot.telegram.sendMessage(data.payout, '<code>' + r.wallet + ',' + fmt(amt) + '</code>', { parse_mode: 'HTML' }).catch(() => {});
      return ctx.replyWithMarkdown('*Withdraw Request Successfully Sent*', { reply_markup: kb });
    }
    await payInstant(ctx, uid, r.wallet, amt, kb);
  } catch (e) { console.log(e); }
});

async function payInstant(ctx, uid, wallet, amt, kb) {
  const wid = await logWithdrawal(uid, wallet, amt, 'pending');
  await ctx.reply('⏳ Sending your withdrawal...', { reply_markup: kb }).catch(() => {});
  try {
    const txid = await sendDgb(wallet, amt); // signed + broadcast immediately
    await updateWithdrawal(wid, 'sent', txid);
    const link = data.block_url + txid;
    ctx.reply('✅ Withdraw Successful\n\n💰 Amount: ' + fmt(amt) + ' ' + data.bot_cur + '\n🏧 Transaction: ' + link, { disable_web_page_preview: true }).catch(() => {});
    const payText = '<b><u>🚀 New Withdrawal Paid!</u>\n\n🔰 User :</b> <a href="tg://user?id=' + uid + '"><b>' + he.encode(ctx.from.first_name) + '</b></a>\n<b>🔎 Address :</b> <code>' + wallet + '</code>\n<b>💲 Amount : ' + fmt(amt) + ' $' + he.encode(data.bot_cur) + '</b>\n<b>Payout Hash</b>: <a href="' + link + '"><b>' + txid + '</b></a>\n\n<b>🔃 Bot Link : @' + ctx.botInfo.username + '</b>';
    bot.telegram.sendMessage(data.payout, payText, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});
  } catch (err) {
    console.log('Withdraw error:', err.message);
    if (err.safe) { // nothing was broadcast -> give the balance back
      await withUser(uid, (u) => { u.bal = round8((Number(u.bal) || 0) + amt); });
      await updateWithdrawal(wid, 'failed_refunded', null, err.message);
      ctx.reply('❌ Withdrawal could not be processed right now. Your balance has been restored, please try again later.').catch(() => {});
      notifyAdmins('⚠️ Withdraw failed (refunded): user ' + uid + ', ' + fmt(amt) + ' ' + data.bot_cur + '\nReason: ' + err.message + (hintFor(err.message) ? '\n\n👉 ' + hintFor(err.message) : '') + '\n\nRun /diag for a full check.');
    } else { // unknown outcome (timeout): NOT refunded automatically, to avoid paying twice
      await updateWithdrawal(wid, 'review', null, err.message);
      ctx.reply('⏳ Your withdrawal is being verified by the team. You will be notified shortly.').catch(() => {});
      notifyAdmins('🚨 MANUAL REVIEW needed\nWithdrawal #' + wid + '\nUser: ' + uid + '\nAmount: ' + fmt(amt) + ' ' + data.bot_cur + '\nAddress: ' + wallet + '\nError: ' + err.message +
        '\n\nCheck the hot wallet on the explorer. If NOT paid: /resolve ' + wid + ' refund\nIf paid: /resolve ' + wid + ' paid');
    }
  }
}

// admin: list unresolved withdrawals, and resolve them
bot.command('pending', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const r = await pool.query("SELECT id, user_id, amount, address, status, error FROM withdrawals WHERE status IN ('pending','review') ORDER BY id");
  if (!r.rows.length) return ctx.reply('No unresolved withdrawals ✅');
  ctx.reply(r.rows.map((w) => `#${w.id} user ${w.user_id}\n${fmt(w.amount)} ${data.bot_cur} -> ${w.address}\n${w.status}: ${w.error || ''}`).join('\n\n'));
});
bot.command('resolve', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const [, id, action] = ctx.message.text.trim().split(/\s+/);
  if (!/^\d+$/.test(id || '') || !['refund', 'paid'].includes(action)) return ctx.reply('Usage: /resolve <id> refund|paid');
  const r = await pool.query("UPDATE withdrawals SET status = $2 WHERE id = $1 AND status IN ('pending','review') RETURNING user_id, amount",
    [id, action === 'refund' ? 'refunded' : 'paid_manual']);
  if (!r.rows[0]) return ctx.reply('Not found, or already resolved.');
  if (action === 'refund') {
    await withUser(r.rows[0].user_id, (u) => { u.bal = round8((Number(u.bal) || 0) + Number(r.rows[0].amount)); });
  }
  ctx.reply('Withdrawal #' + id + ' marked ' + action + '.');
});

/* ---------------- admin: /diag = full withdrawal self-check in plain words ---------------- */
bot.command('diag', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const L = ['🔎 Withdrawal check', ''];
  L.push('Mode: ' + (data.with_type === 'manual' ? 'MANUAL (requests go to the payout channel, nothing is sent automatically)' : 'AUTO INSTANT'));
  L.push(keyPair ? '✅ Wallet key loaded. Hot wallet: ' + HOT_ADDRESS : '❌ DGB_WIF is missing or invalid in Render -> Environment');
  L.push(CONFIG.EXPLORER_API_KEY ? '✅ EXPLORER_API_KEY is set' : '❌ EXPLORER_API_KEY is NOT set in Render -> Environment');
  L.push('Explorer: ' + EXPLORERS.map((e) => e.type + ' ' + e.url).join(', '));
  if (keyPair) {
    try {
      const sp = await getSpendable();
      const total = sp.reduce((a, u) => a + u.sat, 0) / 1e8;
      const owedRow = (await pool.query("SELECT COALESCE(SUM((data->>'bal')::numeric), 0) AS s FROM users WHERE data ? 'bal'")).rows[0];
      const owed = owedRow ? Number(owedRow.s) : 0;
      L.push('✅ Explorer works. Hot wallet holds ' + fmt(total) + ' DGB in ' + sp.length + ' coin(s)');
      if (!sp.length) L.push('❌ The hot wallet is EMPTY. Send DGB to ' + HOT_ADDRESS + ' and wait about a minute.');
      else if (total < owed) L.push('⚠️ Users together hold ' + fmt(owed) + ' DGB, more than the wallet has. Top up the wallet before they withdraw.');
      else L.push('✅ Wallet covers all user balances (' + fmt(owed) + ' DGB).');
      if (sp.length && total > 0) L.push('✅ Ready: withdrawals should work.');
    } catch (e) {
      L.push('❌ Explorer problem: ' + e.message);
      const h = hintFor(e.message);
      if (h) L.push('👉 ' + h);
    }
  }
  ctx.reply(L.join('\n'), { disable_web_page_preview: true });
});

/* ---------------- admin: delete user data ---------------- */
// /addbal <telegram id> <amount>   -> add DGB to a user's balance (use a negative amount to remove)
bot.command('addbal', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const [, id, amt] = ctx.message.text.trim().split(/\s+/);
  if (!/^\d+$/.test(id || '') || !isNumeric(amt)) return ctx.reply('Usage: /addbal <telegram id> <amount>\nExample: /addbal 5028581330 5');
  const n = round8(Number(amt));
  const res = await withUser(id, (u) => {
    if (!u || u.bal === undefined) return null;
    const nb = round8((Number(u.bal) || 0) + n);
    if (nb < 0) return 'neg';
    u.bal = nb;
    return nb;
  });
  if (res === null) return ctx.reply('User not found. They must press /start in the bot first.');
  if (res === 'neg') return ctx.reply('Balance cannot go below 0.');
  ctx.reply('✅ Balance of ' + id + ' is now ' + fmt(res) + ' ' + data.bot_cur);
});

// /deluser <telegram id>   -> removes one user (balance, referrals, address) so they can register again
bot.command('deluser', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const id = (ctx.message.text.split(/\s+/)[1] || '').trim();
  if (!/^\d+$/.test(id)) return ctx.reply('Usage: /deluser <telegram id>\nExample: /deluser 123456789');
  const r = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
  await pool.query('DELETE FROM sessions WHERE key LIKE $1', [id + ':%']);
  ctx.reply(r.rows.length ? '🗑 User ' + id + ' deleted.' : 'User ' + id + ' not found.');
});

// /resetall CONFIRM   -> deletes ALL users and balances (settings, channels and withdrawal history are kept)
bot.command('resetall', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  if ((ctx.message.text.split(/\s+/)[1] || '') !== 'CONFIRM') {
    return ctx.reply('⚠️ This deletes ALL users, balances and referrals and cannot be undone.\nTo continue send exactly:\n/resetall CONFIRM');
  }
  await pool.query('TRUNCATE users, sessions');
  ctx.reply('🗑 All users deleted. The bot is now empty (settings were kept).');
});

/* ---------------- broadcast ---------------- */
bot.command('broad', (ctx) => { if (isAdmin(ctx.from.id)) ctx.scene.enter('getMsg'); });
getMsg.enter((ctx) => ctx.replyWithMarkdown(' *Okay Admin 👮‍♂, Send your broadcast message*'));
getMsg.hears('⬅️ Back', (ctx) => ctx.scene.leave());
getMsg.on('text', async (ctx) => {
  await ctx.scene.leave();
  if (ctx.message.text.length > 3000) return ctx.reply('Message may not exceed 3000 characters.');
  globalBroadCast(ctx);
});

async function globalBroadCast(ctx) {
  const users = (await pool.query('SELECT id FROM users')).rows.map((r) => Number(r.id));
  const html = toHTML(ctx.message);
  let fail = 0;
  ctx.reply('Your message is queued and will be posted to all of your subscribers soon. Total subscribers: ' + users.length);
  for (const id of users) {
    try { await bot.telegram.sendMessage(id, html, { parse_mode: 'HTML' }); } catch (e) { fail++; }
    await sleep(data.broad_speed);
  }
  bot.telegram.sendMessage(ctx.from.id, '<b>Your message has been posted to all of your subscribers.</b>\n\n<b>Total User:</b> ' + users.length + '\n<b>Total Sent:</b> ' + (users.length - fail) + '\n<b>Total Failed:</b> ' + fail, { parse_mode: 'HTML' });
}

/* ---------------- admin panel ---------------- */
bot.command('admin', (ctx) => {
  if (isAdmin(ctx.from.id)) ctx.replyWithMarkdown('*Welcome admin :)*\n\n_Here Is Your Admin Panel._', { reply_markup: { inline_keyboard: adminRows() } });
});

// helper: a one-input admin scene. apply() returns an error string, or nothing on success.
function adminScene(name, doneMsg, apply, panel = 'main') {
  const sc = new Scene(name);
  sc.on('text', async (ctx) => {
    const txt = ctx.message.text.trim();
    if (txt === '/cancel') { await ctx.replyWithMarkdown('*Done*'); return ctx.scene.leave(); }
    const err = await apply(txt, ctx);
    if (err) return ctx.replyWithMarkdown(err);
    await saveData();
    await ctx.scene.leave();
    ctx.replyWithMarkdown('*' + doneMsg + '*\n\n_Here Is Your Admin Panel._',
      { reply_markup: { inline_keyboard: panel === 'wd' ? wdRows() : adminRows() } });
  });
  stage.register(sc);
}

const num = (txt) => (isNumeric(txt) && Number(txt) >= 0 ? null : '*Invalid Amount*');
adminScene('bonuss', 'Bonus Amount Has Updated :)', (t) => num(t) || void (data.bonus = Number(t)));
adminScene('referam', 'Refer Amount Has Updated :)', (t) => num(t) || void (data.reffer_bonus = Number(t)));
adminScene('minwd', 'Minimum Withdraw Amount Has Updated :)', (t) => num(t) || void (data.min_wd = Number(t)));
adminScene('broad', 'Broadcast Speed Updated :)', (t) => {
  if (!isNumeric(t) || Number(t) <= 0) return '*Invalid Amount*';
  if (Number(t) > 15) return 'Sorry, *Max 15 Users* per sec broadcast can be set.';
  data.broad_speed = 1000 / Number(t);
});
adminScene('addadmin', 'User Had Promoted :)', (t) => {
  if (!isNumeric(t)) return '*Invalid User ID*';
  if (data.bot_admin.includes(Number(t))) return 'This user is already admin';
  data.bot_admin.push(Number(t));
});
adminScene('rmvadmin', 'User Had Demoted :)', (t) => {
  if (!isNumeric(t)) return '*Invalid User ID*';
  if (!data.bot_admin.includes(Number(t))) return 'This user is not admin';
  data.bot_admin = data.bot_admin.filter((id) => id !== Number(t));
});
const chanVal = (t) => (/^-?\d+$/.test(t) ? Number(t) : (t.startsWith('@') ? t : null));
adminScene('acheck', 'Channel Has Added In Check :)', (t) => {
  const v = chanVal(t);
  if (v === null) return '*Invalid.* Send @username, or the numeric ID (like -100123...) for a private channel.';
  if (data.check.includes(v)) return 'This channel is already in check';
  data.check.push(v);
});
adminScene('rcheck', 'Channel Has Removed From Check :)', (t) => {
  const v = chanVal(t);
  if (v === null) return '*Invalid.* Send @username or numeric ID.';
  if (!data.check.includes(v)) return 'This channel is not in check';
  data.check = data.check.filter((c) => c !== v);
});
adminScene('currency', 'Your Bot Currency Name Has Updated :)', (t) => { data.bot_cur = t; });
adminScene('blockurl', 'Your Block Chain URL Has Updated :)', (t) => { data.block_url = t; }, 'wd');
adminScene('payout', 'Your Payout Channel Has Updated :)', (t) => {
  if (!t.startsWith('@')) return '*Invalid Username*';
  data.payout = t;
}, 'wd');
adminScene('botoff', 'Bot Turned Off Message Has Updated :)', (t, ctx) => { data.bot_text = toHTML(ctx.message); });
adminScene('welcomemsg', 'Welcome Message Has Updated :)', (t, ctx) => { data.welcome = toHTML(ctx.message); });

const prompts = {
  'welcome-message': ['Ok good, send me a new already formatted welcome text', 'welcomemsg'],
  'bonus': ['Ok good, send me new bonus amount (claimed with the Bonus button)', 'bonuss'],
  'refer': ['Ok good, send me new refer amount', 'referam'],
  'withdraw': ['Ok good, send me new minimum withdraw amount', 'minwd'],
  'add-admin': ['Ok good, send me user id of user whom you wanna promote as admin', 'addadmin'],
  'remove-admin': ['Ok good, send me user id of user whom you wanna demote from admin', 'rmvadmin'],
  'broad-speed': ['Ok good, send me to how many users you wanna send broadcast per sec.', 'broad'],
  'currency': ['Ok good, send me currency name', 'currency'],
  'block-chain-url': ['Ok good, send me Block-Chain explorer TX URL (example: https://digiexplorer.info/tx/)', 'blockurl'],
  'payout-channel': ['Ok good, send me your payout channel username with @', 'payout'],
  'bot-off-text': ['Ok good, give me text to send to users when bot is off', 'botoff'],
  'add-check': ['Ok good, send the channel @username (or numeric ID like -100123... for a private channel) to add in check', 'acheck'],
  'remove-check': ['Ok good, send the channel @username or numeric ID to remove from check', 'rcheck']
};

bot.action(/adhymn_/, async (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Not allowed');
    ctx.answerCbQuery().catch(() => {});
    const edit = ctx.callbackQuery.data.split('_')[1];
    const safeEdit = (text, extra) => ctx.editMessageText(text, extra).catch(() => {});
    const safeMarkup = (rows) => ctx.editMessageReplyMarkup({ inline_keyboard: rows }).catch(() => {});

    if (prompts[edit]) {
      await safeEdit(prompts[edit][0]);
      return ctx.scene.enter(prompts[edit][1]);
    }
    if (edit === 'on-/-off-bot') {
      data.bot = !data.bot;
      await saveData();
      return safeEdit('*Bot Has ' + (data.bot ? 'Turned On' : 'Turned Off') + ' :)*\n\n_Here Is Your Admin Panel._', { reply_markup: { inline_keyboard: adminRows() }, parse_mode: 'Markdown' });
    }
    if (edit === '⬅️-back') return safeMarkup(adminRows());
    if (edit === 'withdraw-settings') return safeMarkup(wdRows());
    if (edit === 'auto-instant' || edit === 'manual') {
      data.with_type = edit;
      await saveData();
      return safeMarkup(wdRows());
    }
    if (edit === 'wallet-balance') {
      if (!keyPair) return ctx.reply('❌ DGB_WIF is not set, instant withdrawals are off.');
      try {
        const sp = await getSpendable();
        const total = sp.reduce((s, u) => s + u.sat, 0) / 1e8;
        const owed = await pool.query("SELECT COALESCE(SUM((data->>'bal')::numeric), 0) AS s FROM users WHERE data ? 'bal'");
        ctx.reply('💼 Hot wallet\nAddress: ' + HOT_ADDRESS + '\nBalance: ' + fmt(total) + ' DGB (' + sp.length + ' UTXOs)\n\n👥 Total user balances: ' + fmt(owed.rows[0] ? owed.rows[0].s : 0) + ' DGB');
      } catch (e) {
        ctx.reply('❌ ' + e.message + (hintFor(e.message) ? '\n\n👉 ' + hintFor(e.message) : ''));
      }
    }
  } catch (e) { console.log(e); }
});

bot.catch((err) => console.log('Bot error:', err));

/* ====================================================================
 *  Start-up: database, health endpoint (keeps Render awake), bot
 * ==================================================================== */
async function main() {
  await initDb();
  await loadSettings();

  const PORT = process.env.PORT || 10000;
  http.createServer(async (req, res) => {
    if (req.url === '/health') {
      try { await pool.query('SELECT 1'); res.end('ok'); } catch (e) { res.statusCode = 500; res.end('db error'); }
    } else res.end('DGB airdrop bot is running');
  }).listen(PORT, () => console.log('Health endpoint on port ' + PORT));

  // Render injects RENDER_EXTERNAL_URL; pinging ourselves counts as inbound traffic (best effort —
  // an external pinger such as UptimeRobot on /health is the more reliable backup).
  if (process.env.RENDER_EXTERNAL_URL) {
    setInterval(() => fetch(process.env.RENDER_EXTERNAL_URL + '/health').catch(() => {}), 9 * 60 * 1000);
  }

  bot.launch().catch((e) => { console.error('Launch failed:', e.message); process.exit(1); });
  console.log('Bot is running...');

  if (HOT_ADDRESS) {
    console.log('Hot wallet address: ' + HOT_ADDRESS);
    try { const sp = await getSpendable(); console.log('Explorer OK, hot wallet UTXOs: ' + sp.length); }
    catch (e) { console.log('⚠️ Explorer check failed: ' + e.message); }
  } else console.log('⚠️ DGB_WIF not set: use Manual withdraw mode or set the key.');

  const stuck = await pool.query("SELECT COUNT(*) AS n FROM withdrawals WHERE status IN ('pending','review')");
  if (Number(stuck.rows[0].n) > 0) notifyAdmins('⚠️ ' + stuck.rows[0].n + ' withdrawal(s) need attention. Send /pending');
}

main().catch((e) => { console.error('Fatal start-up error:', e); process.exit(1); });

const shutdown = (sig) => { try { bot.stop(sig); } catch (e) { /* not started */ } pool.end().finally(() => process.exit(0)); };
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
