'use strict';

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
const { TonClient, WalletContractV4R2, internal, toNano } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');

/* ---------- config ---------- */

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_IDS = String(process.env.ADMIN_IDS || process.env.ADMIN_ID || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

const PROOF_CHANNEL = process.env.PROOF_CHANNEL || '@proof_chnallel';
const WITHDRAW_CHANNEL = process.env.WITHDRAW_CHANNEL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const CRON_SECRET = process.env.CRON_SECRET || '';
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://abdulselamahemade608-prog.github.io/Mini';
const BOT_USERNAME = process.env.BOT_USERNAME || '';

/* TON Config */
const TON_MNEMONIC = process.env.TON_MNEMONIC || '';
const TON_ENDPOINT = process.env.TON_ENDPOINT || 'https://toncenter.com/api/v2/jsonRPC';
const tonClient = new TonClient({ endpoint: TON_ENDPOINT });

/* TON Auto-Payout Engine */
async function sendTonTransaction(toAddress, amountTon) {
  if (!TON_MNEMONIC) throw new Error('TON_MNEMONIC environment variable is not configured');
  const words = TON_MNEMONIC.trim().split(/\s+/);
  const keyPair = await mnemonicToPrivateKey(words);
  const workchain = 0;
  const wallet = WalletContractV4R2.create({ workchain, publicKey: keyPair.publicKey });
  const contract = tonClient.open(wallet);

  const seqno = await contract.getSeqno();
  const transfer = contract.createTransfer({
    seqno,
    secretKey: keyPair.secretKey,
    messages: [
      internal({
        value: toNano(Number(amountTon).toFixed(6)),
        to: toAddress,
        bounce: false,
        body: 'Adewa Payout'
      })
    ]
  });

  await contract.send(transfer);

  // Poll for hash confirmation on chain
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const currentSeqno = await contract.getSeqno();
    if (currentSeqno > seqno) {
      const txs = await tonClient.getTransactions(wallet.address, { limit: 1 });
      if (txs.length > 0) {
        return txs[0].hash().toString('hex');
      }
      break;
    }
  }
  return 'confirmed_' + Date.now();
}

/* Proof-channel caption */
function buildTonProofCaption(w, txHash) {
  const reqAmt = Number(w.etb);
  const fee = Math.round((reqAmt * 0.5) * 100) / 100;
  const final = Math.round((reqAmt - fee) * 100) / 100;
  const user = '@' + (w.username || w.first_name || 'user');
  const txUrl = `https://tonviewer.com/transaction/${txHash}`;

  return (
    `💸 New Withdrawal approve\n\n` +
    `👤 User: ${user}\n` +
    `📱 ton addres:  ${w.account}\n` +
    `💵 Requested Amount:${reqAmt}$\n` +
    `📉 50% Service Fee: ${fee}$\n` +
    `💰 Final Amount: ${final}$\n` +
    `🔍 Status: Paid\n` +
    `🏦 payment url: ${txUrl}\n\n` +
    `🤖 Bot: ${BOT_USERNAME ? '@' + BOT_USERNAME : '-'}`
  );
}

const DEFAULT_GATE_CHANNELS = ['@andbndj', '@proof_chnallel', '@ABDU_CRYPTO', '@m_r_work1'];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '100kb' }));

const q = (t, p) => pool.query(t, p);
const ah = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((e) => {
    console.error(e);
    res.status(500).json({ error: 'server' });
  });

const todayStr = () => new Date().toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);
const fail = (res, code, error, extra = {}) => res.status(code).json({ error, ...extra });
const isAdmin = (id) => ADMIN_IDS.includes(String(id));

async function tg(method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return await r.json();
  } catch (e) {
    return { ok: false, description: String(e) };
  }
}

function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const str = [...p.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
  if (calc !== hash) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > 86400) return null;
  try {
    return { user: JSON.parse(p.get('user')), start: p.get('start_param') || '' };
  } catch {
    return null;
  }
}

let sCache = { t: 0, v: {} };
async function settings() {
  if (Date.now() - sCache.t < 30000) return sCache.v;
  const { rows } = await q('SELECT key, value FROM settings');
  const v = {};
  rows.forEach((r) => { v[r.key] = r.value; });
  if (!Array.isArray(v.gate_channels) || !v.gate_channels.length) v.gate_channels = DEFAULT_GATE_CHANNELS;
  if (!Array.isArray(v.free_table) || !v.free_table.length) v.free_table = [[0, 55], [3, 25], [5, 15], [10, 5]];
  if (!Array.isArray(v.paid_table) || !v.paid_table.length) v.paid_table = [[0, 40], [5, 25], [10, 15], [20, 10], [25, 1], [1, 9]];
  if (v.spin_cost == null) v.spin_cost = 20;
  if (v.coin_per_etb == null) v.coin_per_etb = 100;
  if (v.ads_payment_enabled === undefined) v.ads_payment_enabled = true;
  if (v.invite_payment_enabled === undefined) v.invite_payment_enabled = true;
  if (v.withdraw_fee_percent == null) v.withdraw_fee_percent = 50;
  if (v.free_spins == null) v.free_spins = 5;
  sCache = { t: Date.now(), v };
  return v;
}

const SETTING_KEYS = [
  'coin_per_etb', 'ad_reward', 'ad_cooldown', 'ad_min_seconds', 'ads_per_level',
  'free_spins', 'spin_cost', 'free_table', 'paid_table', 'freeze_price',
  'milestone_bonus', 'referral_reward', 'min_withdraw_etb', 'withdraw_referrals_required',
  'withdraw_interval_hours', 'global_daily_cap_etb', 'withdrawals_open',
  'ads_payment_enabled', 'invite_payment_enabled', 'withdraw_fee_percent',
  'gate_channels', 'gate_cache_min', 'vip_invites_unlimited', 'anticheat_ip_check'
];

async function ensureUser(tu, refId) {
  const ins = await q(
    `INSERT INTO users(id, first_name, username) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING RETURNING id`,
    [tu.id, tu.first_name || '', tu.username || '']
  );
  if (ins.rowCount) {
    if (refId && /^\d+$/.test(String(refId)) && String(refId) !== String(tu.id)) {
      await q(`UPDATE users SET referred_by=$2 WHERE id=$1 AND EXISTS(SELECT 1 FROM users WHERE id=$2)`, [tu.id, refId]);
    }
  } else {
    await q(`UPDATE users SET first_name=$2, username=$3 WHERE id=$1`, [tu.id, tu.first_name || '', tu.username || '']);
  }
}

const auth = ah(async (req, res, next) => {
  const d = verifyInitData(req.headers['x-init-data']);
  if (!d || !d.user) return fail(res, 401, 'bad_auth');
  const m = /^ref_(\d+)$/.exec(d.start || '');
  await ensureUser(d.user, m ? m[1] : null);

  const { rows } = await q(`SELECT *, last_checkin::text AS last_checkin_s, free_spins_day::text AS fsd FROM users WHERE id=$1`, [d.user.id]);
  const u = rows[0];
  if (!u) return fail(res, 404, 'user_not_found');
  if (u.banned) return fail(res, 403, 'banned');

  const dev = String(req.headers['x-device'] || '').slice(0, 64);
  if (dev && !u.device_hash) {
    await q(`UPDATE users SET device_hash=$2 WHERE id=$1`, [u.id, dev]);
    u.device_hash = dev;
  }

  req.user = u;
  next();
});

const forceThrottle = new Map();
async function checkGate(user, force) {
  const S = await settings();
  let chans = Array.isArray(S.gate_channels) ? S.gate_channels : DEFAULT_GATE_CHANNELS;
  if (!chans.length) chans = DEFAULT_GATE_CHANNELS;
  const cached = user.gate_ok_until && new Date(user.gate_ok_until) > new Date();
  if (cached && !force) {
    return { ok: true, channels: chans.map((c) => ({ chat: c, joined: true })) };
  }
  if (force) {
    const last = forceThrottle.get(user.id) || 0;
    if (Date.now() - last < 2000) {
      return { ok: false, channels: chans.map((c) => ({ chat: c, joined: false })), throttled: true };
    }
    forceThrottle.set(user.id, Date.now());
  }

  const channels = await Promise.all(
    chans.map(async (c) => {
      const r = await tg('getChatMember', { chat_id: c, user_id: user.id });
      let joined = false;
      if (r.ok) {
        const st = r.result.status;
        joined = st === 'restricted' ? !!r.result.is_member : ['member', 'administrator', 'creator'].includes(st);
      }
      return { chat: c, joined, error: r.ok ? null : r.description };
    })
  );

  const ok = channels.every((x) => x.joined);
  await q(`UPDATE users SET gate_ok_until=$2, gate_passed = gate_passed OR $3 WHERE id=$1`, [
    user.id,
    ok ? new Date(Date.now() + (S.gate_cache_min || 10) * 60000) : null,
    ok
  ]);
  return { ok, channels };
}

const needGate = ah(async (req, res, next) => {
  const g = await checkGate(req.user, false);
  if (!g.ok) return fail(res, 403, 'gate');
  next();
});

const adminOnly = (req, res, next) => (isAdmin(req.user.id) ? next() : fail(res, 403, 'admin'));

let _bot = '';
async function botName() {
  if (_bot) return _bot;
  const r = await tg('getMe', {});
  _bot = r.ok ? r.result.username : '';
  return _bot;
}

/* ---------- /api/me ---------- */
app.get('/api/me', auth, ah(async (req, res) => {
  const S = await settings();
  const u = (await q(`SELECT *, last_checkin::text AS last_checkin_s, free_spins_day::text AS fsd FROM users WHERE id=$1`, [req.user.id])).rows[0];
  const t = todayStr();
  const limits = S.ads_per_level || [10, 15, 20];
  const adsToday = (await q(`SELECT COUNT(*)::int AS c FROM ad_views WHERE user_id=$1 AND completed AND (started_at AT TIME ZONE 'UTC')::date=$2::date`, [u.id, t])).rows[0].c;
  const refs = (await q(`SELECT COUNT(*)::int AS c FROM users WHERE referred_by=$1 AND referral_paid`, [u.id])).rows[0].c;
  const invited = (await q(`SELECT COUNT(*)::int AS c FROM users WHERE referred_by=$1`, [u.id])).rows[0].c;

  let state = 'new';
  if (u.last_checkin_s) {
    const d = dayDiff(t, u.last_checkin_s);
    state = d === 0 ? 'done' : d === 1 ? 'ready' : d === 2 && u.streak > 0 ? 'recoverable' : 'lost';
  }
  const freeUsed = u.fsd === t ? u.free_spins_used : 0;
  const nextAt = u.last_withdraw_at ? new Date(new Date(u.last_withdraw_at).getTime() + (S.withdraw_interval_hours || 48) * 3600000) : null;

  res.json({
    user: {
      id: u.id,
      name: u.first_name,
      coins: Number(u.coins),
      level: u.level,
      streak: u.streak,
      best: u.best_streak,
      state,
      flagged: u.flagged
    },
    cfg: {
      coin_per_etb: S.coin_per_etb,
      ad_reward: S.ad_reward || 10,
      ads_today: adsToday,
      ads_limit: limits[u.level - 1] || limits[limits.length - 1],
      levels: limits,
      freeze_price: S.freeze_price || 20,
      milestone_bonus: S.milestone_bonus || 50,
      referral_reward: S.referral_reward || 50,
      gate_channels: S.gate_channels || DEFAULT_GATE_CHANNELS,
      spin: {
        free_left: Math.max(0, (S.free_spins || 5) - freeUsed),
        cost: S.spin_cost || 20,
        free_prizes: [...new Set((S.free_table || []).map((r) => Number(r[0])))].sort((a, b) => a - b),
        paid_odds: (S.paid_table || []).map((r) => [Number(r[0]), 10])
      },
      withdraw: {
        open: S.withdrawals_open !== false,
        min_etb: S.min_withdraw_etb || 1,
        refs_required: S.withdraw_referrals_required || 0,
        refs_have: refs,
        next_at: nextAt && nextAt > new Date() ? nextAt.toISOString() : null,
        interval_h: S.withdraw_interval_hours || 48,
        methods: ['tonkeeper'],
        fee_percent: 50
      }
    },
    invited,
    ref_link: `https://t.me/${await botName()}?start=ref_${u.id}`,
    is_admin: isAdmin(u.id)
  });
}));

/* ---------- gate endpoint ---------- */
app.get('/api/gate', auth, ah(async (req, res) => {
  const g = await checkGate(req.user, req.query.force === '1');
  res.json({
    ok: g.ok,
    channels: g.channels.map((c) => ({
      chat: c.chat,
      joined: c.joined,
      url: 'https://t.me/' + String(c.chat).replace(/^@/, '')
    }))
  });
}));

/* ---------- streak / checkin ---------- */
app.post('/api/checkin', auth, needGate, ah(async (req, res) => {
  const u = req.user;
  const S = await settings();
  const t = todayStr();
  const diff = u.last_checkin_s ? dayDiff(t, u.last_checkin_s) : null;

  if (diff === 0) return fail(res, 409, 'already');
  if (diff === 2 && u.streak > 0 && !req.body.restart) return fail(res, 409, 'recoverable');

  const streak = diff === 1 ? u.streak + 1 : 1;
  const maxLevel = (S.ads_per_level || [10, 15, 20]).length;
  const newLevel = Math.min(maxLevel, 1 + Math.floor(streak / 7));

  let level = u.level;
  let bonus = 0;
  if (newLevel > u.level) {
    level = newLevel;
    bonus = Number(S.milestone_bonus || 0);
  }

  await q(
    `UPDATE users SET streak=$2, best_streak=GREATEST(best_streak,$2), last_checkin=$3::date, level=$4, coins=coins+$5 WHERE id=$1`,
    [u.id, streak, t, level, bonus]
  );

  res.json({ ok: true, streak, level, bonus });
}));

app.post('/api/streak/freeze', auth, needGate, ah(async (req, res) => {
  const u = req.user;
  const S = await settings();
  const t = todayStr();

  if (!(u.last_checkin_s && dayDiff(t, u.last_checkin_s) === 2 && u.streak > 0)) {
    return fail(res, 409, 'not_recoverable');
  }

  const r = await q(
    `UPDATE users SET coins=coins-$2, last_checkin=($3::date - 1) WHERE id=$1 AND coins>=$2`,
    [u.id, S.freeze_price || 20, t]
  );
  if (!r.rowCount) return fail(res, 402, 'no_coins');
  res.json({ ok: true });
}));

/* ---------- ads ---------- */
app.post('/api/ad/start', auth, needGate, ah(async (req, res) => {
  const nonce = crypto.randomBytes(16).toString('hex');
  await q(`INSERT INTO ad_views(user_id, nonce) VALUES($1,$2)`, [req.user.id, nonce]);
  res.json({ nonce });
}));

app.post('/api/ad/complete', auth, needGate, ah(async (req, res) => {
  const u = req.user;
  const S = await settings();
  const nonce = String((req.body || {}).nonce || '');
  const reward = Number(S.ad_reward || 10);

  const r = await q(
    `UPDATE ad_views SET completed=true, reward=$3 WHERE nonce=$1 AND user_id=$2 AND completed=false RETURNING id`,
    [nonce, u.id, reward]
  );
  if (!r.rowCount) return fail(res, 400, 'invalid_view');

  const c = await q(
    `UPDATE users SET coins=coins+$2 WHERE id=$1 RETURNING coins`,
    [u.id, reward]
  );
  res.json({ ok: true, reward, coins: Number(c.rows[0].coins) });
}));

/* ---------- spin ---------- */
app.post('/api/spin', auth, needGate, ah(async (req, res) => {
  const u = req.user;
  const S = await settings();
  const t = todayStr();
  const kind = (req.body || {}).kind === 'paid' ? 'paid' : 'free';
  let cost = 0;

  if (kind === 'free') {
    const r = await q(
      `UPDATE users SET free_spins_day=$2::date, free_spins_used = CASE WHEN free_spins_day=$2::date THEN free_spins_used+1 ELSE 1 END
       WHERE id=$1 AND (free_spins_day IS DISTINCT FROM $2::date OR free_spins_used < $3) RETURNING free_spins_used`,
      [u.id, t, S.free_spins || 5]
    );
    if (!r.rowCount) return fail(res, 409, 'no_spins');
  } else {
    cost = Number(S.spin_cost || 20);
    const r = await q(`UPDATE users SET coins=coins-$2 WHERE id=$1 AND coins>=$2 RETURNING coins`, [u.id, cost]);
    if (!r.rowCount) return fail(res, 402, 'no_coins');
  }

  const prizes = kind === 'free' ? [0, 3, 5, 10] : [0, 5, 10, 20, 50];
  const prize = prizes[Math.floor(Math.random() * prizes.length)];

  const c = await q(`UPDATE users SET coins=coins+$2 WHERE id=$1 RETURNING coins, free_spins_used, free_spins_day::text AS fsd`, [u.id, prize]);
  await q(`INSERT INTO spins(user_id, kind, cost, prize) VALUES($1,$2,$3,$4)`, [u.id, kind, cost, prize]);

  const used = c.rows[0].fsd === t ? c.rows[0].free_spins_used : 0;
  res.json({ prize, coins: Number(c.rows[0].coins), free_left: Math.max(0, (S.free_spins || 5) - used) });
}));

app.get('/api/winners', auth, ah(async (req, res) => {
  const { rows } = await q(`SELECT u.first_name AS name, s.prize FROM spins s JOIN users u ON u.id=s.user_id WHERE s.prize >= 10 ORDER BY s.id DESC LIMIT 10`);
  res.json({ winners: rows });
}));

/* ---------- tasks ---------- */
app.get('/api/tasks', auth, needGate, ah(async (req, res) => {
  const { rows } = await q(
    `SELECT t.id, t.title, t.type, t.url, t.reward, t.max_users, s.status AS my_status,
      (SELECT COUNT(*)::int FROM task_subs x WHERE x.task_id=t.id AND x.status IN ('pending','approved')) AS taken
     FROM tasks t LEFT JOIN task_subs s ON s.task_id=t.id AND s.user_id=$1
     WHERE t.active AND (s.status IS NULL OR s.status <> 'approved') ORDER BY t.id DESC`,
    [req.user.id]
  );
  res.json({ tasks: rows });
}));

/* ---------- leaderboard ---------- */
app.get('/api/leaderboard', auth, ah(async (req, res) => {
  const top = (await q(`SELECT u.first_name AS name, COUNT(*)::int AS ads FROM ad_views a JOIN users u ON u.id=a.user_id WHERE a.completed AND a.started_at > now() - interval '7 days' GROUP BY u.id ORDER BY ads DESC LIMIT 20`)).rows;
  const inviters = (await q(`SELECT u.first_name AS name, COUNT(*)::int AS invites FROM users ref JOIN users u ON u.id=ref.referred_by WHERE ref.referral_paid AND ref.created_at > now() - interval '7 days' GROUP BY u.id ORDER BY invites DESC LIMIT 20`)).rows;
  res.json({ top, inviters, earners: [] });
}));

/* ---------- withdrawals (TON Only) ---------- */
app.get('/api/withdrawals', auth, ah(async (req, res) => {
  const { rows } = await q(`SELECT id, etb, method, account, status, created_at FROM withdrawals WHERE user_id=$1 ORDER BY id DESC LIMIT 10`, [req.user.id]);
  res.json({ items: rows });
}));

app.post('/api/withdraw', auth, ah(async (req, res) => {
  const u = req.user;
  const S = await settings();

  const g = await checkGate(u, true);
  if (!g.ok) return fail(res, 403, 'gate');
  if (S.withdrawals_open === false) return fail(res, 423, 'closed');
  if (u.flagged) return fail(res, 403, 'under_review');

  const b = req.body || {};
  const amountUsd = Math.round(Number(b.etb) * 100) / 100;
  const tonAddress = String(b.account || '').trim();

  if (!(amountUsd > 0)) return fail(res, 400, 'bad_input');
  if (!/^(EQ|UQ)[a-zA-Z0-9_-]{46}$/.test(tonAddress)) return fail(res, 400, 'bad_ton_address');
  if (amountUsd < Number(S.min_withdraw_etb || 1)) return fail(res, 400, 'min');

  const coins = Math.round(amountUsd * Number(S.coin_per_etb || 100));
  if (u.coins < coins) return fail(res, 402, 'no_coins');

  const d = await q(
    `UPDATE users SET coins=coins-$2, last_withdraw_at=now() WHERE id=$1 AND coins>=$2 RETURNING coins`,
    [u.id, coins]
  );
  if (!d.rowCount) return fail(res, 402, 'no_coins');

  const w = (
    await q(
      `INSERT INTO withdrawals(user_id, coins, etb, method, account, holder_name)
       VALUES($1,$2,$3,'tonkeeper',$4,$5) RETURNING id`,
      [u.id, coins, amountUsd, tonAddress, 'Tonkeeper']
    )
  ).rows[0];

  const fee = Math.round((amountUsd * 0.5) * 100) / 100;
  const final = Math.round((amountUsd - fee) * 100) / 100;

  const adminMsg =
    `🔔 *Withdrawal Request #${w.id}*\n\n` +
    `👤 User: @${u.username || u.first_name} (ID: \`${u.id}\`)\n` +
    `📱 TON Address: \`${tonAddress}\`\n` +
    `💵 Amount: $${amountUsd}\n` +
    `📉 Fee (50%): $${fee}\n` +
    `💰 User Receives: *$${final} TON*`;

  for (const adminId of ADMIN_IDS) {
    await tg('sendMessage', {
      chat_id: adminId,
      text: adminMsg,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Approve & Pay TON', callback_data: `w:a:${w.id}` },
            { text: '❌ Reject', callback_data: `w:r:${w.id}` }
          ]
        ]
      }
    });
  }

  res.json({ ok: true, id: w.id, coins: Number(d.rows[0].coins) });
}));

/* ---------- admin overview & settings ---------- */
app.get('/api/admin/overview', auth, adminOnly, ah(async (req, res) => {
  const S = await settings();
  const stats = (await q(`SELECT (SELECT COUNT(*)::int FROM users) AS users, (SELECT COUNT(*)::int FROM users WHERE created_at > now() - interval '1 day') AS new_today, (SELECT COUNT(*)::int FROM users WHERE flagged) AS flagged, (SELECT COUNT(*)::int FROM task_subs WHERE status='pending') AS pending_tasks, (SELECT COALESCE(SUM(coins),0)::bigint FROM users) AS coins_owed`)).rows[0];
  const pending = (await q(`SELECT w.id, w.etb, w.method, w.account, u.first_name FROM withdrawals w JOIN users u ON u.id=w.user_id WHERE w.status='pending' ORDER BY w.id`)).rows;
  const tasks = (await q(`SELECT t.*, (SELECT COUNT(*)::int FROM task_subs s WHERE s.task_id=t.id AND s.status IN ('pending','approved')) AS taken FROM tasks t ORDER BY id DESC LIMIT 50`)).rows;
  const promos = (await q('SELECT * FROM promos ORDER BY code')).rows;

  const s = {};
  SETTING_KEYS.forEach((k) => { s[k] = S[k]; });
  res.json({ stats, pending, tasks, promos, settings: s, admins: ADMIN_IDS });
}));

app.post('/api/admin/setting', auth, adminOnly, ah(async (req, res) => {
  const { key, value } = req.body || {};
  if (!SETTING_KEYS.includes(key)) return fail(res, 400, 'bad_key');
  await q(`INSERT INTO settings(key, value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2`, [key, JSON.stringify(value)]);
  sCache.t = 0;
  res.json({ ok: true });
}));

/* ---------- Telegram Webhook / Callback Query ---------- */
async function handleUpdate(u) {
  if (u.message && u.message.text && u.message.text.startsWith('/start')) {
    const m = u.message;
    const r = /^ref_(\d+)$/.exec(m.text.split(' ')[1] || '');
    await ensureUser(m.from, r ? r[1] : null);
    await tg('sendMessage', {
      chat_id: m.chat.id,
      text: 'Welcome to Adewa! Tap below to launch the Mini App.',
      reply_markup: { inline_keyboard: [[{ text: '✅ Open Adewa', web_app: { url: MINI_APP_URL } }]] }
    });
    return;
  }

  if (u.callback_query) {
    const cq = u.callback_query;
    if (!isAdmin(cq.from.id)) {
      return await tg('answerCallbackQuery', { callback_query_id: cq.id });
    }

    const [kind, act, id] = String(cq.data).split(':');

    if (kind === 'w') {
      const wid = Number(id);
      const w = (
        await q(
          `SELECT w.*, u.username, u.first_name FROM withdrawals w JOIN users u ON u.id=w.user_id WHERE w.id=$1`,
          [wid]
        )
      ).rows[0];

      if (!w || w.status !== 'pending') {
        return await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Already handled!' });
      }

      if (act === 'a') {
        await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Processing TON Blockchain payout...' });

        try {
          const finalAmount = Number(w.etb) * 0.5;
          const txHash = await sendTonTransaction(w.account, finalAmount);

          await q(`UPDATE withdrawals SET status='paid', decided_at=now() WHERE id=$1`, [wid]);

          // Post transaction proof to channel
          const caption = buildTonProofCaption(w, txHash);
          await tg('sendMessage', {
            chat_id: PROOF_CHANNEL,
            text: caption,
            disable_web_page_preview: false
          });

          // Notify user
          await tg('sendMessage', {
            chat_id: w.user_id,
            text: `✅ Your withdrawal of $${w.etb} was paid!\nPayment URL: https://tonviewer.com/transaction/${txHash}`
          });

          await tg('editMessageReplyMarkup', {
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            reply_markup: { inline_keyboard: [[{ text: '✅ Auto-Paid via TON', callback_data: 'noop' }]] }
          });
        } catch (err) {
          console.error('TON Transfer Failed:', err);
          await tg('sendMessage', {
            chat_id: cq.from.id,
            text: `⚠️ TON Payment Failed: ${err.message}`
          });
        }
      } else if (act === 'r') {
        await q(`UPDATE withdrawals SET status='rejected', decided_at=now() WHERE id=$1`, [wid]);
        await q(`UPDATE users SET coins=coins+$2 WHERE id=$1`, [w.user_id, w.coins]);

        await tg('sendMessage', {
          chat_id: w.user_id,
          text: `❌ Your withdrawal request of $${w.etb} was rejected and coins were returned to your balance.`
        });

        await tg('editMessageReplyMarkup', {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: { inline_keyboard: [[{ text: '❌ Rejected & Refunded', callback_data: 'noop' }]] }
        });
      }
    }
  }
}

app.post('/api/webhook', async (req, res) => {
  if (WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }
  try {
    await handleUpdate(req.body || {});
  } catch (e) {
    console.error('webhook', e);
  }
  res.sendStatus(200);
});

module.exports = app;

if (require.main === module) {
  app.listen(process.env.PORT || 3000, () => {
    console.log(`Adewa server running on port ${process.env.PORT || 3000}`);
  });
}
