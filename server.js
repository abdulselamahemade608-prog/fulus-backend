'use strict';

/*
 * ---------------------------------------------------------
 * ONE-TIME DATABASE MIGRATION
 * Run this once against your Postgres database before
 * deploying this version (psql / any SQL client):
 *
 *   ALTER TABLE users
 *     ADD COLUMN IF NOT EXISTS vip_unlimited_until timestamptz,
 *     ADD COLUMN IF NOT EXISTS lang varchar(5) DEFAULT 'am',
 *     ADD COLUMN IF NOT EXISTS last_ip text,
 *     ADD COLUMN IF NOT EXISTS ads_coins numeric NOT NULL DEFAULT 0,
 *     ADD COLUMN IF NOT EXISTS invite_coins numeric NOT NULL DEFAULT 0,
 *     ADD COLUMN IF NOT EXISTS daily_ads numeric NOT NULL DEFAULT 0,
 *     ADD COLUMN IF NOT EXISTS daily_invite numeric NOT NULL DEFAULT 0,
 *     ADD COLUMN IF NOT EXISTS daily_task numeric NOT NULL DEFAULT 0,
 *     ADD COLUMN IF NOT EXISTS daily_earn_day date;
 *
 *   ALTER TABLE withdrawals
 *     ADD COLUMN IF NOT EXISTS holder_name text,
 *     ADD COLUMN IF NOT EXISTS from_ads numeric NOT NULL DEFAULT 0,
 *     ADD COLUMN IF NOT EXISTS from_invite numeric NOT NULL DEFAULT 0;
 *
 *   ALTER TABLE tasks
 *     ADD COLUMN IF NOT EXISTS sponsor text;
 *
 *   CREATE TABLE IF NOT EXISTS task_broadcasts(
 *     id bigserial PRIMARY KEY,
 *     task_id bigint NOT NULL,
 *     chat_id bigint NOT NULL,
 *     message_id bigint NOT NULL
 *   );
 *   CREATE INDEX IF NOT EXISTS task_broadcasts_task_idx
 *     ON task_broadcasts(task_id);
 *
 * Also set this new environment variable on Vercel:
 *   CRON_SECRET = <any random string you pick>
 * It protects the two cron endpoints added below
 * (/api/cron/streak-reminder and /api/cron/weekly-rewards).
 * Point a Vercel Cron Job (or any scheduler) at each URL
 * with header:  x-cron-key: <that same value>
 *
 * New: BOT_USERNAME = your bot's @username without the @
 * (used only inside the proof-channel message templates).
 * ---------------------------------------------------------
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');

/* ---------- config (Vercel environment variables) ---------- */

const BOT_TOKEN = process.env.BOT_TOKEN || '';

/*
 * ADMIN_ID = old/single admin support
 * ADMIN_IDS = multiple admins, comma separated
 *
 * Example:
 * ADMIN_IDS=123456789,987654321,555555555
 */
const ADMIN_IDS = String(
  process.env.ADMIN_IDS || process.env.ADMIN_ID || ''
)
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

const PROOF_CHANNEL = process.env.PROOF_CHANNEL || '@proof_chnallel';

const WITHDRAW_CHANNEL =
  process.env.WITHDRAW_CHANNEL || '';

const WEBHOOK_SECRET =
  process.env.WEBHOOK_SECRET || '';

const CRON_SECRET =
  process.env.CRON_SECRET || '';

const MINI_APP_URL =
  process.env.MINI_APP_URL ||
  'https://abdulselamahemade608-prog.github.io/Mini';

const BOT_USERNAME =
  process.env.BOT_USERNAME || '';

/*
 * ---------- AI FAQ / admin assistant (NEW) ----------
 * Answers ordinary user questions automatically using
 * Claude, so a human admin doesn't have to reply to every
 * "how do I withdraw" / "when do I get paid" message.
 *
 * Set these two on Vercel:
 *   ANTHROPIC_API_KEY = your Anthropic API key
 *   CLAUDE_MODEL      = optional, defaults to a fast/cheap model
 */
const ANTHROPIC_API_KEY =
  process.env.ANTHROPIC_API_KEY || '';

const CLAUDE_MODEL =
  process.env.CLAUDE_MODEL ||
  'claude-haiku-4-5-20251001';

/*
 * Fallback knowledge used until an admin sets custom
 * knowledge with /setfaq <text>, or via
 * POST /api/admin/setting {key:"faq_knowledge", value:"..."}.
 * Edit this any time — it only affects the AI's answers,
 * nothing else in the app.
 */
const DEFAULT_FAQ_KNOWLEDGE = `
App name: Adewa (formerly FulusApp) — a Telegram Mini App where users earn coins.
Sections: Home, Tasks, Invite, Withdraw.
Earning sources: watching ads, completing tasks, inviting friends.
Coins convert to Birr (ETB); the exchange rate is set by the admin (often 100 coins = 1 Birr).
Withdraw methods: Telebirr, CBE, M-Pesa (Safaricom). Each withdrawal has a small service fee.
Withdrawals are reviewed and paid manually by an admin; proof of payment is posted in the proof channel.
Invited friends must join the required channels and be active on 2 separate days before the inviter is paid the referral reward.
There are daily limits on ads/earnings, and VIP users (based on invite count) get higher or unlimited ad limits.
If you don't know a specific number (exact fee %, exact minimum withdrawal, exact reward), say a human admin will confirm it — never guess exact figures.
`;

/*
 * The only 3 withdraw methods allowed, and the
 * validation rule for the phone/account number
 * typed for each one.
 */
const WITHDRAW_METHODS = {
  telebirr: /^09\d{8}$/,
  mpesa: /^07\d{8}$/,
  cbe: /^(1000\d{9}|10000\d{8})$/
};

/*
 * Default required channels.
 *
 * IMPORTANT:
 * The bot must be able to use getChatMember() for these channels.
 */
const DEFAULT_GATE_CHANNELS = [
  '@andbndj',
  '@proof_chnallel',
  '@ABDU_CRYPTO',
  '@m_r_work1'
];

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

const todayStr = () =>
  new Date().toISOString().slice(0, 10);

const dayDiff = (a, b) =>
  Math.round((Date.parse(a) - Date.parse(b)) / 864e5);

const fail = (res, code, error, extra = {}) =>
  res.status(code).json({ error, ...extra });

const isAdmin = (id) =>
  ADMIN_IDS.includes(String(id));

/* ---------- telegram helpers ---------- */

async function tg(method, body) {
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    );

    return await r.json();
  } catch (e) {
    return {
      ok: false,
      description: String(e)
    };
  }
}

/* ---------- AI FAQ helper (NEW) ---------- */

async function askFAQAI(question, knowledge) {
  if (!ANTHROPIC_API_KEY) return null;

  try {
    const r = await fetch(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 400,
          system:
            'You are the automatic support assistant for the Adewa Telegram earning app. ' +
            'Reply directly and briefly (2-5 short sentences), in the SAME language the user wrote in (Amharic or English). ' +
            'Only rely on the facts given below. If the question is unrelated to the app, or you are not sure of an exact number or rule, ' +
            'say that a human admin will confirm it soon — never invent amounts, dates, or rules.\n\n' +
            knowledge,
          messages: [
            {
              role: 'user',
              content: String(question).slice(0, 2000)
            }
          ]
        })
      }
    );

    const data = await r.json();

    const text = (data.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
      .trim();

    return text || null;
  } catch (e) {
    console.error('askFAQAI', e);
    return null;
  }
}

/* ---------- Telegram Mini App auth ---------- */

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

  const secret = crypto
    .createHmac('sha256', 'WebAppData')
    .update(BOT_TOKEN)
    .digest();

  const calc = crypto
    .createHmac('sha256', secret)
    .update(str)
    .digest('hex');

  if (calc !== hash) return null;

  if (
    Date.now() / 1000 -
      Number(p.get('auth_date') || 0) >
    86400
  ) {
    return null;
  }

  try {
    return {
      user: JSON.parse(p.get('user')),
      start: p.get('start_param') || ''
    };
  } catch {
    return null;
  }
}

/* ---------- settings ---------- */

let sCache = {
  t: 0,
  v: {}
};

async function settings() {
  if (Date.now() - sCache.t < 30000) {
    return sCache.v;
  }

  const { rows } = await q(
    'SELECT key, value FROM settings'
  );

  const v = {};

  rows.forEach((r) => {
    v[r.key] = r.value;
  });

  /*
   * If gate_channels is missing or empty,
   * automatically use the 5 default channels.
   */
  if (
    !Array.isArray(v.gate_channels) ||
    !v.gate_channels.length
  ) {
    v.gate_channels = DEFAULT_GATE_CHANNELS;
  }

  /*
   * FIX: if the admin panel has never saved these yet,
   * the settings table simply has no row for them, so
   * S.free_table / S.paid_table / S.spin_cost were
   * `undefined`. That produced an empty prize list in
   * /api/me (the wheel showed "undefined" segments) and
   * crashed pick() with a "Cannot read properties of
   * undefined (reading 'reduce')" 500 whenever a user
   * actually spun. These defaults keep the spin screen
   * working immediately, and the admin panel still
   * overrides them the moment real values are saved.
   */
  if (
    !Array.isArray(v.free_table) ||
    !v.free_table.length
  ) {
    v.free_table = [
      [0, 55],
      [3, 25],
      [5, 15],
      [10, 5]
    ];
  }

  if (
    !Array.isArray(v.paid_table) ||
    !v.paid_table.length
  ) {
    v.paid_table = [
      [0, 40],
      [5, 25],
      [10, 15],
      [20, 10],
      [25, 1],
      [1, 9]
    ];
  }

  if (
    v.spin_cost === undefined ||
    v.spin_cost === null ||
    v.spin_cost === ''
  ) {
    v.spin_cost = 20;
  }

  if (
    v.coin_per_etb === undefined ||
    v.coin_per_etb === null ||
    v.coin_per_etb === ''
  ) {
    /* 1 ETB = 100 coins by default; admin can change this any time. */
    v.coin_per_etb = 100;
  }

  /*
   * Admin toggles: which earning source can currently be
   * withdrawn. Default both on (normal withdraw behaviour).
   */
  if (v.ads_payment_enabled === undefined) {
    v.ads_payment_enabled = true;
  }

  if (v.invite_payment_enabled === undefined) {
    v.invite_payment_enabled = true;
  }

  if (
    v.withdraw_fee_percent === undefined ||
    v.withdraw_fee_percent === null ||
    v.withdraw_fee_percent === ''
  ) {
    v.withdraw_fee_percent = 3;
  }

  if (
    v.free_spins === undefined ||
    v.free_spins === null ||
    v.free_spins === ''
  ) {
    v.free_spins = 5;
  }

  /*
   * AI FAQ / admin assistant (NEW): on by default,
   * admin can turn it off with /faqoff or the setting.
   */
  if (v.faq_bot_enabled === undefined) {
    v.faq_bot_enabled = true;
  }

  sCache = {
    t: Date.now(),
    v
  };

  return v;
}

const SETTING_KEYS = [
  'coin_per_etb',
  'ad_reward',
  'ad_cooldown',
  'ad_min_seconds',
  'ads_per_level',
  'free_spins',
  'spin_cost',
  'free_table',
  'paid_table',
  'freeze_price',
  'milestone_bonus',
  'referral_reward',
  'min_withdraw_etb',
  'withdraw_referrals_required',
  'withdraw_interval_hours',
  'global_daily_cap_etb',
  'withdrawals_open',
  'ads_payment_enabled',
  'invite_payment_enabled',
  'withdraw_fee_percent',
  'gate_channels',
  'gate_cache_min',

  /* --- VIP / weekly rewards / anti-cheat --- */
  'vip_invites_unlimited',
  'weekly_top_inviter_min',
  'weekly_top_inviter_bonus_etb',
  'anticheat_ip_check',

  /* --- AI FAQ / admin assistant (NEW) --- */
  'faq_knowledge',
  'faq_bot_enabled'
];

/* ---------- users ---------- */

async function ensureUser(tu, refId) {
  const ins = await q(
    `INSERT INTO users(id, first_name, username)
     VALUES($1,$2,$3)
     ON CONFLICT(id) DO NOTHING
     RETURNING id`,
    [
      tu.id,
      tu.first_name || '',
      tu.username || ''
    ]
  );

  if (ins.rowCount) {
    if (
      refId &&
      /^\d+$/.test(String(refId)) &&
      String(refId) !== String(tu.id)
    ) {
      await q(
        `UPDATE users
         SET referred_by=$2
         WHERE id=$1
         AND EXISTS(
           SELECT 1 FROM users WHERE id=$2
         )`,
        [tu.id, refId]
      );
    }
  } else {
    await q(
      `UPDATE users
       SET first_name=$2,
           username=$3
       WHERE id=$1`,
      [
        tu.id,
        tu.first_name || '',
        tu.username || ''
      ]
    );
  }
}

/* ---------- authentication ---------- */

const auth = ah(async (req, res, next) => {
  const d = verifyInitData(
    req.headers['x-init-data']
  );

  if (!d || !d.user) {
    return fail(res, 401, 'bad_auth');
  }

  const m = /^ref_(\d+)$/.exec(
    d.start || ''
  );

  await ensureUser(
    d.user,
    m ? m[1] : null
  );

  const { rows } = await q(
    `SELECT *,
      last_checkin::text AS last_checkin_s,
      free_spins_day::text AS fsd
     FROM users
     WHERE id=$1`,
    [d.user.id]
  );

  const u = rows[0];

  if (!u) {
    return fail(res, 404, 'user_not_found');
  }

  if (u.banned) {
    return fail(res, 403, 'banned');
  }

  const dev = String(
    req.headers['x-device'] || ''
  ).slice(0, 64);

  if (dev && !u.device_hash) {
    await q(
      `UPDATE users
       SET device_hash=$2
       WHERE id=$1`,
      [u.id, dev]
    );

    const c = await q(
      `SELECT COUNT(*)::int AS c
       FROM users
       WHERE device_hash=$1`,
      [dev]
    );

    if (c.rows[0].c > 2) {
      await q(
        `UPDATE users
         SET flagged=true
         WHERE id=$1`,
        [u.id]
      );

      u.flagged = true;
    }

    u.device_hash = dev;
  }

  /*
   * Best-effort anti-cheat: track the caller's IP
   * (Vercel puts the real client IP in x-forwarded-for)
   * and flag accounts that pile up on the same IP.
   * This is a simple heuristic, not real VPN detection —
   * true VPN/proxy detection needs a paid IP-reputation
   * API (e.g. ipqualityscore.com); wire one in here if
   * you get a key, using the same flagging pattern.
   */
  const ip = String(
    req.headers['x-forwarded-for'] || ''
  )
    .split(',')[0]
    .trim()
    .slice(0, 64);

  if (ip && ip !== u.last_ip) {
    await q(
      `UPDATE users
       SET last_ip=$2
       WHERE id=$1`,
      [u.id, ip]
    );

    u.last_ip = ip;

    const S = await settings();

    if (S.anticheat_ip_check) {
      const c = await q(
        `SELECT COUNT(*)::int AS c
         FROM users
         WHERE last_ip=$1`,
        [ip]
      );

      if (c.rows[0].c > 2) {
        await q(
          `UPDATE users
           SET flagged=true
           WHERE last_ip=$1`,
          [ip]
        );

        u.flagged = true;
      }
    }
  }

  req.user = u;

  next();
});

/* ---------- Gate ---------- */

const forceThrottle = new Map();

async function checkGate(user, force) {
  const S = await settings();

  let chans = Array.isArray(S.gate_channels)
    ? S.gate_channels
    : DEFAULT_GATE_CHANNELS;

  if (!chans.length) {
    chans = DEFAULT_GATE_CHANNELS;
  }

  const cached =
    user.gate_ok_until &&
    new Date(user.gate_ok_until) >
      new Date();

  if (cached && !force) {
    return {
      ok: true,
      channels: chans.map((c) => ({
        chat: c,
        joined: true
      }))
    };
  }

  if (force) {
    const last =
      forceThrottle.get(user.id) || 0;

    if (Date.now() - last < 2000) {
      return {
        ok: false,
        channels: chans.map((c) => ({
          chat: c,
          joined: false
        })),
        throttled: true
      };
    }

    forceThrottle.set(
      user.id,
      Date.now()
    );
  }

  const channels = await Promise.all(
    chans.map(async (c) => {
      const r = await tg(
        'getChatMember',
        {
          chat_id: c,
          user_id: user.id
        }
      );

      let joined = false;

      if (r.ok) {
        const st = r.result.status;

        joined =
          st === 'restricted'
            ? !!r.result.is_member
            : [
                'member',
                'administrator',
                'creator'
              ].includes(st);
      }

      return {
        chat: c,
        joined,
        error: r.ok
          ? null
          : r.description
      };
    })
  );

  const ok = channels.every(
    (x) => x.joined
  );

  await q(
    `UPDATE users
     SET gate_ok_until=$2,
         gate_passed =
           gate_passed OR $3
     WHERE id=$1`,
    [
      user.id,
      ok
        ? new Date(
            Date.now() +
              (S.gate_cache_min || 10) *
                60000
          )
        : null,
      ok
    ]
  );

  return {
    ok,
    channels
  };
}

const needGate = ah(
  async (req, res, next) => {
    const g = await checkGate(
      req.user,
      false
    );

    if (!g.ok) {
      return fail(
        res,
        403,
        'gate'
      );
    }

    next();
  }
);

/* ---------- admin ---------- */

const adminOnly = (
  req,
  res,
  next
) =>
  isAdmin(req.user.id)
    ? next()
    : fail(res, 403, 'admin');

/* ---------- referrals ---------- */

async function processReferrals(uid) {
  const S = await settings();

  const r = await q(
    `UPDATE users u
     SET referral_paid=true
     WHERE u.referred_by=$1
       AND u.referral_paid=false
       AND u.gate_passed
       AND NOT u.flagged
       AND (
         SELECT COUNT(
           DISTINCT (
             a.started_at
             AT TIME ZONE 'UTC'
           )::date
         )
         FROM ad_views a
         WHERE a.user_id=u.id
           AND a.completed
       ) >= 2
     RETURNING u.id`,
    [uid]
  );

  if (r.rowCount) {
    const amt =
      r.rowCount *
      (S.referral_reward || 0);

    await q(
      `UPDATE users
       SET coins=coins+$2,
           invite_coins=invite_coins+$2,
           daily_ads =
             CASE WHEN daily_earn_day=CURRENT_DATE
               THEN daily_ads ELSE 0 END,
           daily_task =
             CASE WHEN daily_earn_day=CURRENT_DATE
               THEN daily_task ELSE 0 END,
           daily_invite =
             CASE WHEN daily_earn_day=CURRENT_DATE
               THEN daily_invite+$2 ELSE $2 END,
           daily_earn_day=CURRENT_DATE
       WHERE id=$1`,
      [uid, amt]
    );
  }
}

/* ---------- VIP (unlimited ads) ---------- */

async function vipStatus(user) {
  const S = await settings();

  if (
    user.vip_unlimited_until &&
    new Date(user.vip_unlimited_until) >
      new Date()
  ) {
    return true;
  }

  const need = Number(
    S.vip_invites_unlimited || 0
  );

  if (!need) return false;

  const refs = (
    await q(
      `SELECT COUNT(*)::int AS c
       FROM users
       WHERE referred_by=$1
         AND referral_paid`,
      [user.id]
    )
  ).rows[0].c;

  return refs >= need;
}

/* ---------- utilities ---------- */

function pick(table) {
  /*
   * FIX: defend against a missing/empty prize table so a
   * spin never crashes with a 500 (it now just pays 0
   * instead of throwing).
   */
  if (!Array.isArray(table) || !table.length) {
    return 0;
  }

  const total = table.reduce(
    (a, r) => a + Number(r[1]),
    0
  );

  let x =
    crypto.randomInt(
      Math.max(
        1,
        Math.round(total * 100)
      )
    ) / 100;

  for (const [prize, w] of table) {
    x -= Number(w);

    if (x < 0) {
      return Number(prize);
    }
  }

  return Number(table[0][0]);
}

async function finishTask(id) {
  const r = await q(
    `UPDATE tasks
     SET active=false
     WHERE id=$1
       AND active
       AND max_users IS NOT NULL
       AND (
         SELECT COUNT(*)
         FROM task_subs
         WHERE task_id=$1
           AND status IN ('pending','approved')
       ) >= max_users
     RETURNING id`,
    [id]
  );

  if (r.rowCount) {
    await deleteTaskBroadcast(id);
  }
}

/*
 * Deletes every broadcast message that was sent
 * for this task (once its slots are full) and
 * clears the tracking rows.
 */
async function deleteTaskBroadcast(taskId) {
  const { rows } = await q(
    `SELECT chat_id, message_id
     FROM task_broadcasts
     WHERE task_id=$1`,
    [taskId]
  );

  for (const m of rows) {
    await tg('deleteMessage', {
      chat_id: m.chat_id,
      message_id: m.message_id
    }).catch(() => {});
  }

  await q(
    `DELETE FROM task_broadcasts
     WHERE task_id=$1`,
    [taskId]
  );
}

const chatUrl = (c) =>
  'https://t.me/' +
  String(c).replace(/^@/, '');

/*
 * Builds the exact proof-channel caption for a paid
 * withdrawal, in the format for each of the 3 methods.
 */
function buildProofCaption(w, feePercent) {
  const fee =
    Math.round(
      w.etb * feePercent
    ) / 100;

  const final =
    Math.round(
      (w.etb - fee) * 100
    ) / 100;

  const user =
    '@' + (w.username || w.first_name || 'user');

  const footer =
    `\n-------------------------------\n\n` +
    `🤖 Bot: ${BOT_USERNAME ? '@' + BOT_USERNAME : '-'}`;

  if (w.method === 'telebirr') {
    return (
      `💸 New Withdrawal approve \n` +
      `----------------\n` +
      `👤 User: ${user}\n` +
      `📱 Telebirr Number: ${w.account}\n` +
      `💵 Requested Amount:${w.etb.toFixed(2)} Birr\n` +
      `📉 ${feePercent}% Service Fee: ${fee.toFixed(2)} Birr\n` +
      `💰 Final Amount: ${final.toFixed(2)} Birr\n` +
      `🔍 Status: Paid ` +
      footer
    );
  }

  if (w.method === 'mpesa') {
    return (
      `💸 New Withdrawal Approved \n` +
      `----------------\n` +
      `👤 User: ${user}\n` +
      `📱 Mepeas Number: ${w.account}\n` +
      `💵 Requested Amount:${w.etb.toFixed(2)} Birr\n` +
      `📉 ${feePercent}% Service Fee: ${fee.toFixed(2)} Birr\n` +
      `💰 Final Amount: ${final.toFixed(2)} Birr\n` +
      `🔍 Status: Paid ` +
      footer
    );
  }

  /* cbe */
  return (
    `💸 New Withdrawal approve \n` +
    `----------------\n` +
    `👤 User: ${user}\n` +
    `📱 Cbe Number: ${w.account}\n` +
    `💵 Requested Amount:${w.etb.toFixed(2)} Birr\n` +
    `📉 ${feePercent}% Service Fee: ${fee.toFixed(2)} Birr\n` +
    `💰 Final Amount: ${final.toFixed(2)} Birr\n` +
    `🔍 Status: Paid ` +
    footer
  );
}

/* ---------- basics ---------- */

app.get(
  '/health',
  ah(async (req, res) => {
    await q('SELECT 1');

    res.json({
      ok: true,
      service: 'Adewa',
      status: 'online',
      database: 'connected'
    });
  })
);

/* ---------- gate endpoint ---------- */

app.get(
  '/api/gate',
  auth,
  ah(async (req, res) => {
    const g = await checkGate(
      req.user,
      req.query.force === '1'
    );

    res.json({
      ok: g.ok,
      channels: g.channels.map(
        (c) => ({
          chat: c.chat,
          joined: c.joined,
          url: chatUrl(c.chat)
        })
      )
    });
  })
);

/* ---------- me ---------- */

app.get(
  '/api/me',
  auth,
  ah(async (req, res) => {
    const S = await settings();

    await processReferrals(
      req.user.id
    );

    const u = (
      await q(
        `SELECT *,
          last_checkin::text AS last_checkin_s,
          free_spins_day::text AS fsd
         FROM users
         WHERE id=$1`,
        [req.user.id]
      )
    ).rows[0];

    const t = todayStr();

    const limits =
      S.ads_per_level || [
        10,
        15,
        20
      ];

    const adsToday = (
      await q(
        `SELECT COUNT(*)::int AS c
         FROM ad_views
         WHERE user_id=$1
           AND completed
           AND (
             started_at
             AT TIME ZONE 'UTC'
           )::date=$2::date`,
        [u.id, t]
      )
    ).rows[0].c;

    const refs = (
      await q(
        `SELECT COUNT(*)::int AS c
         FROM users
         WHERE referred_by=$1
           AND referral_paid`,
        [u.id]
      )
    ).rows[0].c;

    const invited = (
      await q(
        `SELECT COUNT(*)::int AS c
         FROM users
         WHERE referred_by=$1`,
        [u.id]
      )
    ).rows[0].c;

    const vip = await vipStatus(u);

    let state = 'new';

    if (u.last_checkin_s) {
      const d = dayDiff(
        t,
        u.last_checkin_s
      );

      state =
        d === 0
          ? 'done'
          : d === 1
          ? 'ready'
          : d === 2 &&
            u.streak > 0
          ? 'recoverable'
          : 'lost';
    }

    const freeUsed =
      u.fsd === t
        ? u.free_spins_used
        : 0;

    const nextAt =
      u.last_withdraw_at
        ? new Date(
            new Date(
              u.last_withdraw_at
            ).getTime() +
              (S.withdraw_interval_hours ||
                48) *
                3600000
          )
        : null;

    const total = (tb) =>
      tb.reduce(
        (a, r) =>
          a + Number(r[1]),
        0
      );

    res.json({
      user: {
        id: u.id,
        name: u.first_name,
        coins: Number(u.coins),
        ads_coins: Number(u.ads_coins || 0),
        invite_coins: Number(u.invite_coins || 0),
        level: u.level,
        streak: u.streak,
        best: u.best_streak,
        state,
        flagged: u.flagged
      },

      cfg: {
        coin_per_etb:
          S.coin_per_etb,

        ad_reward:
          S.ad_reward,

        ads_today:
          adsToday,

        ads_limit:
          vip
            ? null
            : limits[u.level - 1] ||
              limits[
                limits.length - 1
              ],

        vip,

        levels: limits,

        freeze_price:
          S.freeze_price,

        milestone_bonus:
          S.milestone_bonus,

        referral_reward:
          S.referral_reward,

        gate_channels:
          S.gate_channels ||
          DEFAULT_GATE_CHANNELS,

        spin: {
          free_left: Math.max(
            0,
            (S.free_spins || 0) -
              freeUsed
          ),

          cost:
            S.spin_cost,

          free_prizes: [
            ...new Set(
              (S.free_table || [])
                .map((r) =>
                  Number(r[0])
                )
            )
          ].sort(
            (a, b) => a - b
          ),

          paid_odds:
            (S.paid_table || [])
              .map((r) => [
                Number(r[0]),
                Math.round(
                  (Number(r[1]) /
                    total(
                      S.paid_table
                    )) *
                    1000
                ) / 10
              ])
        },

        withdraw: {
          open:
            S.withdrawals_open !==
            false,

          min_etb:
            S.min_withdraw_etb,

          refs_required:
            S.withdraw_referrals_required,

          refs_have:
            refs,

          next_at:
            nextAt &&
            nextAt > new Date()
              ? nextAt.toISOString()
              : null,

          interval_h:
            S.withdraw_interval_hours,

          methods: Object.keys(
            WITHDRAW_METHODS
          ),

          ads_enabled:
            S.ads_payment_enabled !== false,

          invite_enabled:
            S.invite_payment_enabled !== false,

          fee_percent:
            Number(S.withdraw_fee_percent || 0),

          max_coins: Math.max(
            0,
            Math.floor(
              (S.ads_payment_enabled !== false
                ? Number(u.ads_coins || 0)
                : 0) +
              (S.invite_payment_enabled !== false
                ? Number(u.invite_coins || 0)
                : 0)
            )
          )
        }
      },

      invited,

      lang: u.lang || 'en',

      ref_link:
        `https://t.me/${await botName()}?start=ref_${u.id}`,

      is_admin:
        isAdmin(u.id)
    });
  })
);

/* ---------- language ---------- */

app.post(
  '/api/lang',
  auth,
  ah(async (req, res) => {
    const lang = 'en';

    await q(
      `UPDATE users
       SET lang=$2
       WHERE id=$1`,
      [req.user.id, lang]
    );

    res.json({ ok: true, lang });
  })
);

/* ---------- bot name ---------- */

let _bot = '';

async function botName() {
  if (_bot) return _bot;

  const r = await tg(
    'getMe',
    {}
  );

  _bot = r.ok
    ? r.result.username
    : '';

  return _bot;
}

/* ---------- streak ---------- */

app.post(
  '/api/checkin',
  auth,
  needGate,
  ah(async (req, res) => {
    const u = req.user;
    const S = await settings();
    const t = todayStr();

    const diff =
      u.last_checkin_s
        ? dayDiff(
            t,
            u.last_checkin_s
          )
        : null;

    if (diff === 0) {
      return fail(
        res,
        409,
        'already'
      );
    }

    if (
      diff === 2 &&
      u.streak > 0 &&
      !req.body.restart
    ) {
      return fail(
        res,
        409,
        'recoverable'
      );
    }

    const streak =
      diff === 1
        ? u.streak + 1
        : 1;

    const maxLevel =
      (
        S.ads_per_level || [
          10,
          15,
          20
        ]
      ).length;

    const newLevel = Math.min(
      maxLevel,
      1 +
        Math.floor(
          streak / 7
        )
    );

    let level = u.level;
    let bonus = 0;

    if (newLevel > u.level) {
      level = newLevel;
      bonus = Number(
        S.milestone_bonus || 0
      );
    }

    await q(
      `UPDATE users
       SET streak=$2,
           best_streak=GREATEST(best_streak,$2),
           last_checkin=$3::date,
           level=$4,
           coins=coins+$5
       WHERE id=$1`,
      [
        u.id,
        streak,
        t,
        level,
        bonus
      ]
    );

    res.json({
      ok: true,
      streak,
      level,
      bonus
    });
  })
);

app.post(
  '/api/streak/freeze',
  auth,
  needGate,
  ah(async (req, res) => {
    const u = req.user;
    const S = await settings();
    const t = todayStr();

    if (
      !(
        u.last_checkin_s &&
        dayDiff(
          t,
          u.last_checkin_s
        ) === 2 &&
        u.streak > 0
      )
    ) {
      return fail(
        res,
        409,
        'not_recoverable'
      );
    }

    const r = await q(
      `UPDATE users
       SET coins=coins-$2,
           last_checkin=($3::date - 1)
       WHERE id=$1
         AND coins>=$2`,
      [
        u.id,
        S.freeze_price,
        t
      ]
    );

    if (!r.rowCount) {
      return fail(
        res,
        402,
        'no_coins'
      );
    }

    res.json({
      ok: true
    });
  })
);

/* ---------- ads ---------- */

app.post(
  '/api/ad/start',
  auth,
  needGate,
  ah(async (req, res) => {
    const u = req.user;
    const S = await settings();
    const t = todayStr();

    const limits =
      S.ads_per_level || [
        10,
        15,
        20
      ];

    const limit =
      limits[u.level - 1] ||
      limits[
        limits.length - 1
      ];

    const vip = await vipStatus(u);

    if (!vip) {
      const cnt = (
        await q(
          `SELECT COUNT(*)::int AS c
           FROM ad_views
           WHERE user_id=$1
             AND completed
             AND (
               started_at
               AT TIME ZONE 'UTC'
             )::date=$2::date`,
          [u.id, t]
        )
      ).rows[0].c;

      if (cnt >= limit) {
        return fail(
          res,
          429,
          'quota'
        );
      }
    }

    const last = (
      await q(
        `SELECT EXTRACT(
           EPOCH FROM
           (now()-started_at)
         ) AS s
         FROM ad_views
         WHERE user_id=$1
         ORDER BY id DESC
         LIMIT 1`,
        [u.id]
      )
    ).rows[0];

    const cd =
      S.ad_cooldown || 30;

    if (
      last &&
      Number(last.s) < cd
    ) {
      return fail(
        res,
        429,
        'cooldown',
        {
          wait: Math.ceil(
            cd -
              Number(last.s)
          )
        }
      );
    }

    const nonce =
      crypto.randomBytes(16)
        .toString('hex');

    await q(
      `INSERT INTO ad_views(
        user_id,
        nonce
      )
      VALUES($1,$2)`,
      [
        u.id,
        nonce
      ]
    );

    res.json({
      nonce
    });
  })
);

app.post(
  '/api/ad/complete',
  auth,
  needGate,
  ah(async (req, res) => {
    const u = req.user;
    const S = await settings();

    const nonce = String(
      (req.body || {}).nonce ||
        ''
    );

    const reward = Number(
      S.ad_reward || 0
    );

    const r = await q(
      `UPDATE ad_views
       SET completed=true,
           reward=$3
       WHERE nonce=$1
         AND user_id=$2
         AND completed=false
         AND started_at <=
           now() -
           ($4::int *
           interval '1 second')
       RETURNING id`,
      [
        nonce,
        u.id,
        reward,
        S.ad_min_seconds || 10
      ]
    );

    if (!r.rowCount) {
      return fail(
        res,
        400,
        'invalid_view'
      );
    }

    const c = await q(
      `UPDATE users
       SET coins=coins+$2,
           ads_coins=ads_coins+$2,
           daily_invite =
             CASE WHEN daily_earn_day=CURRENT_DATE
               THEN daily_invite ELSE 0 END,
           daily_task =
             CASE WHEN daily_earn_day=CURRENT_DATE
               THEN daily_task ELSE 0 END,
           daily_ads =
             CASE WHEN daily_earn_day=CURRENT_DATE
               THEN daily_ads+$2 ELSE $2 END,
           daily_earn_day=CURRENT_DATE
       WHERE id=$1
       RETURNING coins`,
      [
        u.id,
        reward
      ]
    );

    res.json({
      ok: true,
      reward,
      coins: Number(
        c.rows[0].coins
      )
    });
  })
);

/* ---------- spin ---------- */

app.post(
  '/api/spin',
  auth,
  needGate,
  ah(async (req, res) => {
    const u = req.user;
    const S = await settings();
    const t = todayStr();

    const kind =
      (req.body || {}).kind ===
      'paid'
        ? 'paid'
        : 'free';

    let cost = 0;

    if (kind === 'free') {
      const r = await q(
        `UPDATE users
         SET free_spins_day=$2::date,
             free_spins_used =
               CASE
                 WHEN free_spins_day=$2::date
                 THEN free_spins_used+1
                 ELSE 1
               END
         WHERE id=$1
           AND (
             free_spins_day
               IS DISTINCT FROM $2::date
             OR free_spins_used < $3
           )
         RETURNING free_spins_used`,
        [
          u.id,
          t,
          S.free_spins || 0
        ]
      );

      if (!r.rowCount) {
        return fail(
          res,
          409,
          'no_spins'
        );
      }
    } else {
      cost = Number(
        S.spin_cost || 0
      );

      const r = await q(
        `UPDATE users
         SET coins=coins-$2
         WHERE id=$1
           AND coins>=$2
         RETURNING coins`,
        [
          u.id,
          cost
        ]
      );

      if (!r.rowCount) {
        return fail(
          res,
          402,
          'no_coins'
        );
      }
    }

    const prize = pick(
      kind === 'free'
        ? S.free_table
        : S.paid_table
    );

    const c = await q(
      `UPDATE users
       SET coins=coins+$2
       WHERE id=$1
       RETURNING coins,
                 free_spins_used,
                 free_spins_day::text AS fsd`,
      [
        u.id,
        prize
      ]
    );

    await q(
      `INSERT INTO spins(
        user_id,
        kind,
        cost,
        prize
      )
      VALUES($1,$2,$3,$4)`,
      [
        u.id,
        kind,
        cost,
        prize
      ]
    );

    const used =
      c.rows[0].fsd === t
        ? c.rows[0]
            .free_spins_used
        : 0;

    res.json({
      prize,
      coins: Number(
        c.rows[0].coins
      ),
      free_left: Math.max(
        0,
        (S.free_spins || 0) -
          used
      )
    });
  })
);

app.get(
  '/api/winners',
  auth,
  ah(async (req, res) => {
    const { rows } = await q(
      `SELECT
        u.first_name AS name,
        s.prize
       FROM spins s
       JOIN users u
         ON u.id=s.user_id
       WHERE s.prize >= 10
       ORDER BY s.id DESC
       LIMIT 10`
    );

    res.json({
      winners: rows
    });
  })
);

/* ---------- tasks ---------- */

app.get(
  '/api/tasks',
  auth,
  needGate,
  ah(async (req, res) => {
    const { rows } = await q(
      `SELECT
        t.id,
        t.title,
        t.type,
        t.url,
        t.reward,
        t.max_users,
        s.status AS my_status,
        (
          SELECT COUNT(*)::int
          FROM task_subs x
          WHERE x.task_id=t.id
            AND x.status IN (
              'pending',
              'approved'
            )
        ) AS taken
       FROM tasks t
       LEFT JOIN task_subs s
         ON s.task_id=t.id
        AND s.user_id=$1
       WHERE t.active
         AND (
           s.status IS NULL
           OR s.status <> 'approved'
         )
       ORDER BY t.id DESC`,
      [req.user.id]
    );

    res.json({
      tasks: rows.filter(
        (t) =>
          !t.max_users ||
          t.taken < t.max_users ||
          t.my_status
      )
    });
  })
);

app.post(
  '/api/tasks/:id/verify',
  auth,
  needGate,
  ah(async (req, res) => {
    const t = (
      await q(
        `SELECT *
         FROM tasks
         WHERE id=$1
           AND active
           AND type='channel'`,
        [req.params.id]
      )
    ).rows[0];

    if (!t) {
      return fail(
        res,
        404,
        'not_found'
      );
    }

    const prev = (
      await q(
        `SELECT status
         FROM task_subs
         WHERE task_id=$1
           AND user_id=$2`,
        [
          t.id,
          req.user.id
        ]
      )
    ).rows[0];

    if (
      prev &&
      prev.status === 'approved'
    ) {
      return fail(
        res,
        409,
        'already'
      );
    }

    if (!prev && t.max_users) {
      const n = (
        await q(
          `SELECT COUNT(*)::int AS c
           FROM task_subs
           WHERE task_id=$1
             AND status IN (
               'pending',
               'approved'
             )`,
          [t.id]
        )
      ).rows[0].c;

      if (n >= t.max_users) {
        return fail(
          res,
          409,
          'limit'
        );
      }
    }

    const r = await tg(
      'getChatMember',
      {
        chat_id: t.chat,
        user_id: req.user.id
      }
    );

    const st = r.ok
      ? r.result.status
      : null;

    const joined =
      st === 'restricted'
        ? !!r.result.is_member
        : [
            'member',
            'administrator',
            'creator'
          ].includes(st);

    if (!joined) {
      return fail(
        res,
        400,
        'not_joined'
      );
    }

    const up = await q(
      `INSERT INTO task_subs(
        task_id,
        user_id,
        status
      )
      VALUES($1,$2,'approved')
      ON CONFLICT (
        task_id,
        user_id
      )
      DO UPDATE SET
        status='approved'
      WHERE task_subs.status <> 'approved'
      RETURNING id`,
      [
        t.id,
        req.user.id
      ]
    );

    if (up.rowCount) {
      await q(
        `UPDATE users
         SET coins=coins+$2,
             daily_ads =
               CASE WHEN daily_earn_day=CURRENT_DATE
                 THEN daily_ads ELSE 0 END,
             daily_invite =
               CASE WHEN daily_earn_day=CURRENT_DATE
                 THEN daily_invite ELSE 0 END,
             daily_task =
               CASE WHEN daily_earn_day=CURRENT_DATE
                 THEN daily_task+$2 ELSE $2 END,
             daily_earn_day=CURRENT_DATE
         WHERE id=$1`,
        [
          req.user.id,
          t.reward
        ]
      );

      await finishTask(t.id);
    }

    res.json({
      ok: true,
      reward: Number(
        t.reward
      )
    });
  })
);

app.post(
  '/api/tasks/:id/start',
  auth,
  needGate,
  ah(async (req, res) => {
    const t = (
      await q(
        `SELECT *
         FROM tasks
         WHERE id=$1
           AND active
           AND type='social'`,
        [req.params.id]
      )
    ).rows[0];

    if (!t) {
      return fail(
        res,
        404,
        'not_found'
      );
    }

    const prev = (
      await q(
        `SELECT status
         FROM task_subs
         WHERE task_id=$1
           AND user_id=$2`,
        [
          t.id,
          req.user.id
        ]
      )
    ).rows[0];

    if (
      prev &&
      (
        prev.status === 'pending' ||
        prev.status === 'approved'
      )
    ) {
      return fail(
        res,
        409,
        'already'
      );
    }

    if (!prev && t.max_users) {
      const n = (
        await q(
          `SELECT COUNT(*)::int AS c
           FROM task_subs
           WHERE task_id=$1
             AND status IN (
               'pending',
               'approved'
             )`,
          [t.id]
        )
      ).rows[0].c;

      if (n >= t.max_users) {
        return fail(
          res,
          409,
          'limit'
        );
      }
    }

    await q(
      `INSERT INTO task_subs(
        task_id,
        user_id,
        status
      )
      VALUES($1,$2,'awaiting')
      ON CONFLICT (
        task_id,
        user_id
      )
      DO UPDATE SET
        status='awaiting'`,
      [
        t.id,
        req.user.id
      ]
    );

    res.json({
      ok: true,
      bot:
        `https://t.me/${await botName()}`
    });
  })
);

/* ---------- promo ---------- */

app.post(
  '/api/promo',
  auth,
  needGate,
  ah(async (req, res) => {
    const code = String(
      (req.body || {}).code || ''
    )
      .trim()
      .toUpperCase()
      .slice(0, 32);

    const p = (
      await q(
        `SELECT *
         FROM promos
         WHERE code=$1
           AND active`,
        [code]
      )
    ).rows[0];

    if (!p) {
      return fail(
        res,
        404,
        'invalid_code'
      );
    }

    const use = await q(
      `INSERT INTO promo_uses(
        code,
        user_id
      )
      VALUES($1,$2)
      ON CONFLICT DO NOTHING
      RETURNING code`,
      [
        code,
        req.user.id
      ]
    );

    if (!use.rowCount) {
      return fail(
        res,
        409,
        'already'
      );
    }

    const ok = await q(
      `UPDATE promos
       SET uses=uses+1
       WHERE code=$1
         AND (
           max_uses IS NULL
           OR uses < max_uses
         )
       RETURNING uses`,
      [code]
    );

    if (!ok.rowCount) {
      await q(
        `DELETE FROM promo_uses
         WHERE code=$1
           AND user_id=$2`,
        [
          code,
          req.user.id
        ]
      );

      return fail(
        res,
        409,
        'code_full'
      );
    }

    await q(
      `UPDATE users
       SET coins=coins+$2
       WHERE id=$1`,
      [
        req.user.id,
        p.reward
      ]
    );

    res.json({
      ok: true,
      reward: Number(
        p.reward
      )
    });
  })
);

/* ---------- leaderboard ---------- */

app.get(
  '/api/leaderboard',
  auth,
  ah(async (req, res) => {
    const S = await settings();

    const top = (
      await q(
        `SELECT
          u.first_name AS name,
          COUNT(*)::int AS ads
         FROM ad_views a
         JOIN users u
           ON u.id=a.user_id
         WHERE a.completed
           AND a.started_at >
             now() - interval '7 days'
         GROUP BY u.id
         ORDER BY ads DESC
         LIMIT 55`
      )
    ).rows;

    const inviters = (
      await q(
        `SELECT
          u.first_name AS name,
          COUNT(*)::int AS invites
         FROM users ref
         JOIN users u
           ON u.id=ref.referred_by
         WHERE ref.referral_paid
           AND ref.created_at >
             now() - interval '7 days'
         GROUP BY u.id
         ORDER BY invites DESC
         LIMIT 55`
      )
    ).rows;

    const coinPerEtb = Number(
      S.coin_per_etb || 1
    ) || 1;

    const earners = (
      await q(
        `SELECT
          u.first_name AS name,
          ROUND(u.coins / $1, 2) AS pending_etb,
          COALESCE(w.paid, 0) AS paid_etb,
          ROUND(
            u.coins / $1
              + COALESCE(w.paid, 0)
              + COALESCE(w.pending, 0),
            2
          ) AS total_earned_etb
         FROM users u
         LEFT JOIN (
           SELECT
             user_id,
             SUM(etb)
               FILTER (
                 WHERE status='paid'
               ) AS paid,
             SUM(etb)
               FILTER (
                 WHERE status='pending'
               ) AS pending
           FROM withdrawals
           GROUP BY user_id
         ) w
           ON w.user_id=u.id
         ORDER BY total_earned_etb DESC
         LIMIT 55`,
        [coinPerEtb]
      )
    ).rows;

    res.json({
      top,
      inviters,
      earners
    });
  })
);

/* ---------- withdrawals ---------- */

app.get(
  '/api/withdrawals',
  auth,
  ah(async (req, res) => {
    const { rows } = await q(
      `SELECT
        id,
        etb,
        method,
        status,
        created_at
       FROM withdrawals
       WHERE user_id=$1
       ORDER BY id DESC
       LIMIT 10`,
      [req.user.id]
    );

    res.json({
      items: rows
    });
  })
);

app.post(
  '/api/withdraw',
  auth,
  ah(async (req, res) => {
    const u = req.user;
    const S = await settings();

    const g = await checkGate(
      u,
      true
    );

    if (!g.ok) {
      return fail(
        res,
        403,
        'gate'
      );
    }

    if (
      S.withdrawals_open ===
      false
    ) {
      return fail(
        res,
        423,
        'closed'
      );
    }

    if (u.flagged) {
      return fail(
        res,
        403,
        'under_review'
      );
    }

    const b = req.body || {};

    const etb =
      Math.round(
        Number(b.etb) * 100
      ) / 100;

    const method = String(
      b.method || ''
    )
      .trim()
      .toLowerCase();

    const account = String(
      b.account || ''
    )
      .trim()
      .slice(0, 32);

    const holderName = String(
      b.holder_name || b.owner_name || ''
    )
      .trim()
      .slice(0, 64);

    if (
      !(etb > 0) ||
      !WITHDRAW_METHODS[method]
    ) {
      return fail(
        res,
        400,
        'bad_input'
      );
    }

    if (
      !WITHDRAW_METHODS[method].test(
        account
      )
    ) {
      return fail(
        res,
        400,
        'bad_phone'
      );
    }

    if (holderName.length < 3) {
      return fail(
        res,
        400,
        'bad_name'
      );
    }

    if (
      !S.ads_payment_enabled &&
      !S.invite_payment_enabled
    ) {
      return fail(
        res,
        423,
        'no_payment_source'
      );
    }

    if (
      etb <
      Number(
        S.min_withdraw_etb || 0
      )
    ) {
      return fail(
        res,
        400,
        'min',
        {
          min:
            S.min_withdraw_etb
        }
      );
    }

    if (
      u.last_withdraw_at &&
      Date.now() -
        new Date(
          u.last_withdraw_at
        ).getTime() <
        (S.withdraw_interval_hours ||
          48) *
          3600000
    ) {
      return fail(
        res,
        429,
        'interval'
      );
    }

    const refs = (
      await q(
        `SELECT COUNT(*)::int AS c
         FROM users
         WHERE referred_by=$1
           AND referral_paid`,
        [u.id]
      )
    ).rows[0].c;

    if (
      refs <
      (
        S.withdraw_referrals_required ||
        0
      )
    ) {
      return fail(
        res,
        403,
        'referrals'
      );
    }

    const cap = (
      await q(
        `SELECT
          COALESCE(
            SUM(etb),
            0
          ) AS s
         FROM withdrawals
         WHERE status IN (
           'pending',
           'paid'
         )
           AND (
             created_at
             AT TIME ZONE 'UTC'
           )::date=$1::date`,
        [todayStr()]
      )
    ).rows[0].s;

    if (
      Number(cap) + etb >
      Number(
        S.global_daily_cap_etb ||
          1e9
      )
    ) {
      return fail(
        res,
        429,
        'cap'
      );
    }

    const coins = Math.round(
      etb * S.coin_per_etb
    );

    /*
     * Only the enabled source(s) count toward what can
     * actually be withdrawn right now.
     */
    const availAds = S.ads_payment_enabled
      ? Number(u.ads_coins || 0)
      : 0;

    const availInvite = S.invite_payment_enabled
      ? Number(u.invite_coins || 0)
      : 0;

    if (coins > availAds + availInvite) {
      return fail(
        res,
        402,
        'no_coins'
      );
    }

    /*
     * Spend from ads_coins first, then invite_coins,
     * whichever of the two is currently enabled.
     */
    const fromAds = Math.min(
      coins,
      availAds
    );

    const fromInvite =
      coins - fromAds;

    const d = await q(
      `UPDATE users
       SET coins=coins-$2,
           ads_coins=GREATEST(0, ads_coins-$3),
           invite_coins=GREATEST(0, invite_coins-$4),
           last_withdraw_at=now()
       WHERE id=$1
         AND coins>=$2
       RETURNING coins`,
      [
        u.id,
        coins,
        fromAds,
        fromInvite
      ]
    );

    if (!d.rowCount) {
      return fail(
        res,
        402,
        'no_coins'
      );
    }

    const w = (
      await q(
        `INSERT INTO withdrawals(
          user_id,
          coins,
          etb,
          method,
          account,
          holder_name,
          from_ads,
          from_invite
        )
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING id`,
        [
          u.id,
          coins,
          etb,
          method,
          account,
          holderName,
          fromAds,
          fromInvite
        ]
      )
    ).rows[0];

    const text =
      `Withdrawal #${w.id}\n` +
      `User: ${u.first_name} (ID: ${u.id}) @${u.username || '-'}\n` +
      `Amount: ${etb} ETB\n` +
      `Method: ${method}\n` +
      `Account: ${account}\n` +
      `Holder name: ${holderName}`;

    /*
     * Send withdrawal request
     * to every configured admin.
     */
    for (const adminId of ADMIN_IDS) {
      await tg(
        'sendMessage',
        {
          chat_id: adminId,
          text,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '✅ Paid',
                  callback_data:
                    `w:a:${w.id}`
                },
                {
                  text: '❌ Reject',
                  callback_data:
                    `w:r:${w.id}`
                }
              ]
            ]
          }
        }
      );
    }

    if (WITHDRAW_CHANNEL) {
      await tg(
        'sendMessage',
        {
          chat_id:
            WITHDRAW_CHANNEL,
          text
        }
      );
    }

    res.json({
      ok: true,
      id: w.id,
      coins: Number(
        d.rows[0].coins
      )
    });
  })
);

/* ---------- admin overview ---------- */

app.get(
  '/api/admin/overview',
  auth,
  adminOnly,
  ah(async (req, res) => {
    const S = await settings();

    const stats = (
      await q(
        `SELECT
          (
            SELECT COUNT(*)::int
            FROM users
          ) AS users,

          (
            SELECT COUNT(*)::int
            FROM users
            WHERE created_at >
              now() - interval '1 day'
          ) AS new_today,

          (
            SELECT COUNT(*)::int
            FROM users
            WHERE flagged
          ) AS flagged,

          (
            SELECT COUNT(*)::int
            FROM task_subs
            WHERE status='pending'
          ) AS pending_tasks,

          (
            SELECT
              COALESCE(
                SUM(coins),
                0
              )::bigint
            FROM users
          ) AS coins_owed`
      )
    ).rows[0];

    const pending = (
      await q(
        `SELECT
          w.id,
          w.etb,
          w.method,
          w.account,
          u.first_name
         FROM withdrawals w
         JOIN users u
           ON u.id=w.user_id
         WHERE w.status='pending'
         ORDER BY w.id`
      )
    ).rows;

    const tasks = (
      await q(
        `SELECT
          t.*,
          (
            SELECT COUNT(*)::int
            FROM task_subs s
            WHERE s.task_id=t.id
              AND s.status IN (
                'pending',
                'approved'
              )
          ) AS taken
         FROM tasks t
         ORDER BY id DESC
         LIMIT 50`
      )
    ).rows;

    const promos = (
      await q(
        'SELECT * FROM promos ORDER BY code'
      )
    ).rows;

    const s = {};

    SETTING_KEYS.forEach(
      (k) => {
        s[k] = S[k];
      }
    );

    res.json({
      stats,
      pending,
      tasks,
      promos,
      settings: s,
      admins: ADMIN_IDS
    });
  })
);

/* ---------- admin settings ---------- */

app.post(
  '/api/admin/setting',
  auth,
  adminOnly,
  ah(async (req, res) => {
    const {
      key,
      value
    } = req.body || {};

    if (
      !SETTING_KEYS.includes(key)
    ) {
      return fail(
        res,
        400,
        'bad_key'
      );
    }

    if (
      /_table$/.test(key) &&
      !(
        Array.isArray(value) &&
        value.length &&
        value.every(
          (r) =>
            Array.isArray(r) &&
            r.length === 2 &&
            r.every((n) =>
              Number.isFinite(
                Number(n)
              )
            )
        )
      )
    ) {
      return fail(
        res,
        400,
        'bad_table'
      );
    }

    if (
      key === 'gate_channels' &&
      !(
        Array.isArray(value) &&
        value.every(
          (c) =>
            /^@\w{4,}$/.test(
              String(c)
            )
        )
      )
    ) {
      return fail(
        res,
        400,
        'bad_channels'
      );
    }

    await q(
      `INSERT INTO settings(
        key,
        value
      )
      VALUES($1,$2)
      ON CONFLICT(key)
      DO UPDATE SET
        value=$2`,
      [
        key,
        JSON.stringify(value)
      ]
    );

    sCache.t = 0;

    res.json({
      ok: true
    });
  })
);

/* ---------- admin tasks ---------- */

app.post(
  '/api/admin/task',
  auth,
  adminOnly,
  ah(async (req, res) => {
    const b = req.body || {};

    const type =
      b.type === 'channel'
        ? 'channel'
        : 'social';

    const title = String(
      b.title || ''
    )
      .trim()
      .slice(0, 80);

    const chat = String(
      b.chat || ''
    ).trim();

    let url = String(
      b.url || ''
    ).trim();

    if (type === 'channel') {
      if (
        !/^@\w{4,}$/.test(chat)
      ) {
        return fail(
          res,
          400,
          'bad_channel'
        );
      }

      url = chatUrl(chat);
    }

    if (
      !title ||
      !/^https?:\/\//.test(url)
    ) {
      return fail(
        res,
        400,
        'bad_input'
      );
    }

    const max =
      Number(b.max_users) > 0
        ? Math.floor(
            Number(
              b.max_users
            )
          )
        : null;

    const reward = Math.max(
      0,
      Math.floor(
        Number(b.reward) || 0
      )
    );

    const sponsor = String(
      b.sponsor || ''
    )
      .trim()
      .slice(0, 60);

    const ins = await q(
      `INSERT INTO tasks(
        title,
        type,
        url,
        chat,
        reward,
        max_users,
        sponsor
      )
      VALUES($1,$2,$3,$4,$5,$6,$7)
      RETURNING id`,
      [
        title,
        type,
        url,
        type === 'channel'
          ? chat
          : '',
        reward,
        max,
        sponsor || null
      ]
    );

    const taskId = ins.rows[0].id;

    if (b.broadcast) {
      /*
       * Fire off in the background so the request
       * doesn't hang waiting on every user — for a
       * very large user base, move this to a proper
       * job queue instead.
       */
      broadcastTask(
        taskId,
        title,
        reward,
        sponsor
      ).catch((e) =>
        console.error(
          'broadcastTask',
          e
        )
      );
    }

    res.json({
      ok: true,
      id: taskId
    });
  })
);

/*
 * Sends the new task to every non-banned user with a
 * single "✅ Start" inline button that opens the mini
 * app. Tracks each message so it can be deleted once
 * the task's slots fill up (see deleteTaskBroadcast).
 */
async function broadcastTask(taskId, title, reward, sponsor) {
  const { rows } = await q(
    'SELECT id FROM users WHERE NOT banned'
  );

  for (const u of rows) {
    const r = await tg(
      'sendMessage',
      {
        chat_id: u.id,
        text:
          `🆕 New task: ${title}\n` +
          (sponsor
            ? `📣 Sponsored by: ${sponsor}\n`
            : '') +
          `Reward: ${reward} coins`,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '✅ Start',
                web_app: {
                  url: MINI_APP_URL
                }
              }
            ]
          ]
        }
      }
    );

    if (r.ok) {
      await q(
        `INSERT INTO task_broadcasts(
          task_id,
          chat_id,
          message_id
        )
        VALUES($1,$2,$3)`,
        [
          taskId,
          u.id,
          r.result.message_id
        ]
      );
    }

    /*
     * Stay under Telegram's ~30 msg/sec limit.
     */
    await new Promise((r2) =>
      setTimeout(r2, 40)
    );
  }
}

app.post(
  '/api/admin/task/:id/toggle',
  auth,
  adminOnly,
  ah(async (req, res) => {
    await q(
      `UPDATE tasks
       SET active = NOT active
       WHERE id=$1`,
      [req.params.id]
    );

    res.json({
      ok: true
    });
  })
);

/* ---------- admin promo ---------- */

app.post(
  '/api/admin/promo',
  auth,
  adminOnly,
  ah(async (req, res) => {
    const b = req.body || {};

    const code = String(
      b.code || ''
    )
      .trim()
      .toUpperCase()
      .slice(0, 32);

    if (
      !/^[A-Z0-9_]{3,32}$/.test(
        code
      )
    ) {
      return fail(
        res,
        400,
        'bad_input'
      );
    }

    await q(
      `INSERT INTO promos(
        code,
        reward,
        max_uses
      )
      VALUES($1,$2,$3)
      ON CONFLICT(code)
      DO UPDATE SET
        reward=$2,
        max_uses=$3,
        active=true`,
      [
        code,
        Math.max(
          0,
          Math.floor(
            Number(
              b.reward
            ) || 0
          )
        ),
        Number(b.max_uses) > 0
          ? Math.floor(
              Number(
                b.max_uses
              )
            )
          : null
      ]
    );

    res.json({
      ok: true
    });
  })
);

/* ---------- admin broadcast ---------- */

async function broadcastAll(text) {
  const { rows } = await q(
    'SELECT id FROM users WHERE NOT banned'
  );

  let sent = 0;

  for (const u of rows) {
    const r = await tg('sendMessage', {
      chat_id: u.id,
      text
    });

    if (r.ok) sent++;

    await new Promise((r2) =>
      setTimeout(r2, 40)
    );
  }

  return sent;
}

app.post(
  '/api/admin/broadcast',
  auth,
  adminOnly,
  ah(async (req, res) => {
    const text = String(
      (req.body || {}).text || (req.body || {}).message || ''
    )
      .trim()
      .slice(0, 2000);

    if (!text) {
      return fail(res, 400, 'bad_input');
    }

    /*
     * Fire in the background — don't make the admin
     * panel wait for every user to be messaged.
     */
    broadcastAll(text)
      .then((sent) =>
        console.log('broadcast sent to', sent)
      )
      .catch((e) =>
        console.error('broadcastAll', e)
      );

    res.json({ ok: true });
  })
);

/* ---------- admin: post daily leaderboard to proof channel ---------- */

app.post(
  '/api/admin/daily-leaderboard/post',
  auth,
  adminOnly,
  ah(async (req, res) => {
    const { rows } = await q(
      `SELECT username, first_name, daily_ads, daily_invite, daily_task
       FROM users
       WHERE daily_earn_day=CURRENT_DATE
         AND (daily_ads+daily_invite+daily_task) > 0
       ORDER BY (daily_ads+daily_invite+daily_task) DESC
       LIMIT 7`
    );

    if (!rows.length) {
      return fail(res, 404, 'no_earnings');
    }

    let text =
      "Today's top earners — Ads · Invite · Task · Total\n";

    rows.forEach((r, i) => {
      const name =
        '@' + (r.username || r.first_name || 'user');

      const total =
        Number(r.daily_ads) +
        Number(r.daily_invite) +
        Number(r.daily_task);

      text +=
        `${i + 1} ${name}   ${r.daily_ads}   ${r.daily_invite}   ${r.daily_task}   ${total} coins\n`;
    });

    text += '\nWork fast, earn fast!';

    const r = await tg('sendMessage', {
      chat_id: PROOF_CHANNEL,
      text
    });

    if (!r.ok) {
      console.error('daily leaderboard', r.description);
      return fail(res, 502, 'post_failed');
    }

    res.json({ ok: true });
  })
);

/* ---------- admin user ---------- */

app.post(
  '/api/admin/user',
  auth,
  adminOnly,
  ah(async (req, res) => {
    const {
      id,
      action
    } = req.body || {};

    if (
      !/^\d+$/.test(
        String(id)
      )
    ) {
      return fail(
        res,
        400,
        'bad_input'
      );
    }

    const sql = {
      unflag:
        'UPDATE users SET flagged=false WHERE id=$1',

      ban:
        'UPDATE users SET banned=true WHERE id=$1',

      unban:
        'UPDATE users SET banned=false WHERE id=$1'
    }[action];

    if (!sql) {
      return fail(
        res,
        400,
        'bad_input'
      );
    }

    await q(sql, [id]);

    res.json({
      ok: true
    });
  })
);

/* ---------- Telegram bot webhook ---------- */

async function handleUpdate(u) {
  if (u.message) {
    const m = u.message;
    const from = m.from;

    /* ---------- /start ---------- */

    if (
      m.text &&
      m.text.startsWith('/start')
    ) {
      const r =
        /^ref_(\d+)$/.exec(
          m.text.split(' ')[1] ||
            ''
        );

      await ensureUser(
        from,
        r ? r[1] : null
      );

      await tg(
        'sendMessage',
        {
          chat_id: m.chat.id,
          text: r
            ? 'Welcome to Adewa! You were invited by a friend — tap the button below to open the app.'
            : 'Welcome to Adewa. Tap the button to open the app.',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text:
                    '✅ Open Adewa',
                  web_app: {
                    url:
                      MINI_APP_URL
                  }
                }
              ]
            ]
          }
        }
      );

      return;
    }

    /* ---------- /skip ---------- */

    if (
      m.text === '/skip' &&
      isAdmin(from.id)
    ) {
      await q(
        `DELETE FROM settings
         WHERE key='awaiting_proof'`
      );

      await tg(
        'sendMessage',
        {
          chat_id: from.id,
          text: 'Skipped.'
        }
      );

      return;
    }

    /* ---------- /topearners ---------- */

    if (
      m.text === '/topearners' &&
      isAdmin(from.id)
    ) {
      const { rows } = await q(
        `SELECT
          username,
          first_name,
          daily_ads,
          daily_invite,
          daily_task
         FROM users
         WHERE daily_earn_day=CURRENT_DATE
           AND (daily_ads+daily_invite+daily_task) > 0
         ORDER BY (daily_ads+daily_invite+daily_task) DESC
         LIMIT 7`
      );

      if (!rows.length) {
        await tg('sendMessage', {
          chat_id: from.id,
          text: 'No earnings recorded yet today.'
        });

        return;
      }

      let text =
        "Today's top earners — Ads · Invite · Task · Total\n";

      rows.forEach((r, i) => {
        const name =
          '@' + (r.username || r.first_name || 'user');

        const total =
          Number(r.daily_ads) +
          Number(r.daily_invite) +
          Number(r.daily_task);

        text +=
          `${i + 1} ${name}        ${r.daily_ads}        ${r.daily_invite}       ${r.daily_task}         ${total} Birr \n`;
      });

      text += '\nWork fast, earn fast!';

      await tg('sendMessage', {
        chat_id: PROOF_CHANNEL,
        text
      });

      await tg('sendMessage', {
        chat_id: from.id,
        text: 'Posted to the proof channel.'
      });

      return;
    }

    /* ---------- /broadcast ---------- */

    if (
      m.text &&
      m.text.startsWith('/broadcast ') &&
      isAdmin(from.id)
    ) {
      const text = m.text
        .slice('/broadcast '.length)
        .trim();

      if (text) {
        broadcastAll(text).catch((e) =>
          console.error('broadcastAll', e)
        );

        await tg('sendMessage', {
          chat_id: from.id,
          text: 'Broadcast started.'
        });
      }

      return;
    }

    /* ---------- /setfaq (NEW, admin) ---------- */

    if (
      m.text &&
      m.text.startsWith('/setfaq ') &&
      isAdmin(from.id)
    ) {
      const text = m.text
        .slice('/setfaq '.length)
        .trim();

      if (text) {
        await q(
          `INSERT INTO settings(key, value)
           VALUES('faq_knowledge', $1)
           ON CONFLICT(key)
           DO UPDATE SET value=$1`,
          [JSON.stringify(text)]
        );

        sCache.t = 0;

        await tg('sendMessage', {
          chat_id: from.id,
          text: 'FAQ knowledge updated.'
        });
      }

      return;
    }

    /* ---------- /faqon /faqoff (NEW, admin) ---------- */

    if (
      (m.text === '/faqon' ||
        m.text === '/faqoff') &&
      isAdmin(from.id)
    ) {
      const enabled = m.text === '/faqon';

      await q(
        `INSERT INTO settings(key, value)
         VALUES('faq_bot_enabled', $1)
         ON CONFLICT(key)
         DO UPDATE SET value=$1`,
        [JSON.stringify(enabled)]
      );

      sCache.t = 0;

      await tg('sendMessage', {
        chat_id: from.id,
        text: enabled
          ? 'AI FAQ auto-reply is ON.'
          : 'AI FAQ auto-reply is OFF.'
      });

      return;
    }

    /* ---------- AI FAQ auto-reply (NEW) ----------
     * Any plain text message that isn't a command and
     * wasn't matched by anything above gets an instant
     * AI-generated answer, acting like a second admin.
     */

    if (
      m.text &&
      !m.text.startsWith('/')
    ) {
      const S = await settings();

      if (S.faq_bot_enabled === false) {
        return;
      }

      await tg('sendChatAction', {
        chat_id: m.chat.id,
        action: 'typing'
      });

      const knowledge =
        S.faq_knowledge || DEFAULT_FAQ_KNOWLEDGE;

      const answer = await askFAQAI(
        m.text,
        knowledge
      );

      await tg('sendMessage', {
        chat_id: m.chat.id,
        text:
          answer ||
          'Thanks for your message — an admin will reply soon. / አመሰግናለሁ፣ አድሚን በቅርቡ ይመልስልዎታል።'
      });

      if (!answer) {
        for (const adminId of ADMIN_IDS) {
          await tg('sendMessage', {
            chat_id: adminId,
            text:
              `❓ Unanswered question from ${from.first_name || 'user'} (ID: ${from.id}):\n${m.text}`
          });
        }
      }

      return;
    }

    /* ---------- photo ---------- */

    if (m.photo) {
      const fileId =
        m.photo[
          m.photo.length - 1
        ].file_id;

      /* Payment proof from admin */

      if (isAdmin(from.id)) {
        const a = (
          await q(
            `SELECT value
             FROM settings
             WHERE key='awaiting_proof'`
          )
        ).rows[0];

        if (
          a &&
          a.value &&
          a.value.wid
        ) {
          const w = (
            await q(
              `SELECT
                w.etb,
                w.method,
                w.account,
                u.first_name,
                u.username
               FROM withdrawals w
               JOIN users u
                 ON u.id=w.user_id
               WHERE w.id=$1`,
              [a.value.wid]
            )
          ).rows[0];

          if (w) {
            const S = await settings();

            await tg(
              'sendPhoto',
              {
                chat_id:
                  PROOF_CHANNEL,
                photo: fileId,
                caption: buildProofCaption(
                  {
                    ...w,
                    etb: Number(w.etb)
                  },
                  Number(
                    S.withdraw_fee_percent || 3
                  )
                )
              }
            );
          }

          await q(
            `DELETE FROM settings
             WHERE key='awaiting_proof'`
          );

          await tg(
            'sendMessage',
            {
              chat_id: from.id,
              text:
                'Posted to the proof channel.'
            }
          );

          return;
        }
      }

      /* ---------- task proof ---------- */

      const s = (
        await q(
          `SELECT
            s.id,
            t.title,
            t.reward
           FROM task_subs s
           JOIN tasks t
             ON t.id=s.task_id
           WHERE s.user_id=$1
             AND s.status='awaiting'
           ORDER BY s.id DESC
           LIMIT 1`,
          [from.id]
        )
      ).rows[0];

      if (!s) {
        await tg(
          'sendMessage',
          {
            chat_id: from.id,
            text:
              'Open the app, choose a task, then send your screenshot here.'
          }
        );

        return;
      }

      await q(
        `UPDATE task_subs
         SET status='pending'
         WHERE id=$1`,
        [s.id]
      );

      /*
       * Send task proof to ALL admins.
       */
      for (const adminId of ADMIN_IDS) {
        await tg(
          'sendPhoto',
          {
            chat_id: adminId,
            photo: fileId,
            caption:
              `New task proof\n` +
              `User: ${from.first_name} (ID: ${from.id})\n` +
              `Task: ${s.title} (${s.reward} coins)`,
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '✅ Approve',
                    stylr: 'succeas',
                    callback_data:
                      `t:a:${s.id}`
                  },
                  {
                    text: '❌ Reject',
                    callback_data:
                      `t:r:${s.id}`
                  }
                ]
              ]
            }
          }
        );
      }

      await tg(
        'sendMessage',
        {
          chat_id: from.id,
          text:
            'Screenshot received. An admin will review it soon.'
        }
      );
    }

    return;
  }

  /* ---------- callback query ---------- */

  if (u.callback_query) {
    const cq =
      u.callback_query;

    /*
     * Multiple admin support.
     */
    if (!isAdmin(cq.from.id)) {
      await tg(
        'answerCallbackQuery',
        {
          callback_query_id:
            cq.id
        }
      );

      return;
    }

    const [
      kind,
      act,
      id
    ] = String(
      cq.data
    ).split(':');

    let note = 'Done';

    /* ---------- task ---------- */

    if (kind === 't') {
      if (act === 'a') {
        const r = await q(
          `UPDATE task_subs
           SET status='approved'
           WHERE id=$1
             AND status='pending'
           RETURNING
             task_id,
             user_id`,
          [id]
        );

        if (r.rowCount) {
          const tk = (
            await q(
              `SELECT
                reward,
                title
               FROM tasks
               WHERE id=$1`,
              [
                r.rows[0]
                  .task_id
              ]
            )
          ).rows[0];

          await q(
            `UPDATE users
             SET coins=coins+$2,
                 daily_ads =
                   CASE WHEN daily_earn_day=CURRENT_DATE
                     THEN daily_ads ELSE 0 END,
                 daily_invite =
                   CASE WHEN daily_earn_day=CURRENT_DATE
                     THEN daily_invite ELSE 0 END,
                 daily_task =
                   CASE WHEN daily_earn_day=CURRENT_DATE
                     THEN daily_task+$2 ELSE $2 END,
                 daily_earn_day=CURRENT_DATE
             WHERE id=$1`,
            [
              r.rows[0].user_id,
              tk.reward
            ]
          );

          await finishTask(
            r.rows[0].task_id
          );

          await tg(
            'sendMessage',
            {
              chat_id:
                r.rows[0].user_id,
              text:
                `Task approved: ${tk.title}. You earned ${tk.reward} coins.`
            }
          );

          note = '✅ Approved';
        } else {
          note =
            'Already handled';
        }
      } else {
        const r = await q(
          `UPDATE task_subs
           SET status='rejected'
           WHERE id=$1
             AND status='pending'
           RETURNING user_id`,
          [id]
        );

        if (r.rowCount) {
          await tg(
            'sendMessage',
            {
              chat_id:
                r.rows[0].user_id,
              text:
                'Your task proof was rejected. Open the app to try again.'
            }
          );

          note = '❌ Rejected';
        } else {
          note =
            'Already handled';
        }
      }
    }

    /* ---------- withdrawal ---------- */

    else if (kind === 'w') {
      if (act === 'a') {
        const r = await q(
          `UPDATE withdrawals
           SET status='paid',
               decided_at=now()
           WHERE id=$1
             AND status='pending'
           RETURNING
             user_id,
             etb`,
          [id]
        );

        if (r.rowCount) {
          await q(
            `INSERT INTO settings(
              key,
              value
            )
            VALUES(
              'awaiting_proof',
              $1
            )
            ON CONFLICT(key)
            DO UPDATE SET
              value=$1`,
            [
              JSON.stringify({
                wid: Number(id)
              })
            ]
          );

          await tg(
            'sendMessage',
            {
              chat_id:
                r.rows[0].user_id,
              text:
                `💸 New Withdrawal requests accepted \n` +
                `----------------\n` +
                `💵 Amount: ${Number(r.rows[0].etb).toFixed(2)} Birr\n` +
                `🔍 Status: Paid \n` +
                `-------------------------------\n\n` +
                `🤖 Proof channel: ${PROOF_CHANNEL}`
            }
          );

          /*
           * Tell the admin who clicked.
           */
          await tg(
            'sendMessage',
            {
              chat_id:
                cq.from.id,
              text:
                'Send the payment screenshot now to post it in the proof channel, or send /skip.'
            }
          );

          note =
            '✅ Marked as paid';
        } else {
          note =
            'Already handled';
        }
      } else {
        const r = await q(
          `UPDATE withdrawals
           SET status='rejected',
               decided_at=now()
           WHERE id=$1
             AND status='pending'
           RETURNING
             user_id,
             coins,
             etb,
             method,
             from_ads,
             from_invite`,
          [id]
        );

        if (r.rowCount) {
          await q(
            `UPDATE users
             SET coins=coins+$2,
                 ads_coins=ads_coins+$3,
                 invite_coins=invite_coins+$4,
                 last_withdraw_at=NULL
             WHERE id=$1`,
            [
              r.rows[0].user_id,
              r.rows[0].coins,
              r.rows[0].from_ads,
              r.rows[0].from_invite
            ]
          );

          await tg(
            'sendMessage',
            {
              chat_id:
                r.rows[0].user_id,
              text:
                `💸 New Withdrawal requests rejected \n` +
                `----------------\n` +
                `💵 Requested Amount: ${Number(r.rows[0].etb).toFixed(2)} Birr\n` +
                `        Reback to Your balance \n` +
                `🔍 Status: Rejected`
            }
          );

          note =
            '❌ Rejected and refunded';
        } else {
          note =
            'Already handled';
        }
      }
    }

    await tg(
      'answerCallbackQuery',
      {
        callback_query_id:
          cq.id,
        text: note
      }
    );

    if (cq.message) {
      await tg(
        'editMessageReplyMarkup',
        {
          chat_id:
            cq.message.chat.id,
          message_id:
            cq.message.message_id,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: note,
                  callback_data:
                    'noop'
                }
              ]
            ]
          }
        }
      );
    }
  }
}

/* ---------- cron: daily streak reminder ---------- */

const cronAuth = (req, res, next) =>
  CRON_SECRET &&
  req.headers['x-cron-key'] === CRON_SECRET
    ? next()
    : fail(res, 403, 'cron_forbidden');

/*
 * Call this once a day (evening, local time) from
 * Vercel Cron. Warns anyone who checked in yesterday
 * but not yet today that their streak will be lost.
 */
app.all(
  '/api/cron/streak-reminder',
  cronAuth,
  ah(async (req, res) => {
    const t = todayStr();

    const { rows } = await q(
      `SELECT id, lang, streak
       FROM users
       WHERE NOT banned
         AND streak > 0
         AND last_checkin::text <> $1
         AND last_checkin::text =
           (
             $1::date - 1
           )::text`,
      [t]
    );

    for (const u of rows) {
      await tg('sendMessage', {
        chat_id: u.id,
        text: `🔥 Your ${u.streak}-day streak will be lost if you don't check in today! Open the app now.`
      }).catch(() => {});

      await new Promise((r) =>
        setTimeout(r, 40)
      );
    }

    res.json({
      ok: true,
      notified: rows.length
    });
  })
);

/* ---------- cron: weekly rewards ---------- */

/*
 * Call this once a week (e.g. Sunday night) from
 * Vercel Cron. Pays the top inviter (if they cleared
 * the minimum invite count) and gives the top
 * ad-watcher of the week unlimited ads for 7 days.
 */
app.all(
  '/api/cron/weekly-rewards',
  cronAuth,
  ah(async (req, res) => {
    const S = await settings();

    const result = {
      top_inviter: null,
      top_ad_watcher: null
    };

    /* ---- top inviter ---- */

    const minInvites = Number(
      S.weekly_top_inviter_min || 200
    );

    const bonusEtb = Number(
      S.weekly_top_inviter_bonus_etb || 0
    );

    const inviter = (
      await q(
        `SELECT
          u.id,
          COUNT(*)::int AS invites
         FROM users ref
         JOIN users u
           ON u.id=ref.referred_by
         WHERE ref.referral_paid
           AND ref.created_at >
             now() - interval '7 days'
         GROUP BY u.id
         HAVING COUNT(*) >= $1
         ORDER BY invites DESC
         LIMIT 1`,
        [minInvites]
      )
    ).rows[0];

    if (inviter && bonusEtb > 0) {
      const bonusCoins = Math.round(
        bonusEtb *
          Number(S.coin_per_etb || 1)
      );

      await q(
        `UPDATE users
         SET coins=coins+$2
         WHERE id=$1`,
        [inviter.id, bonusCoins]
      );

      await tg('sendMessage', {
        chat_id: inviter.id,
        text:
          `🏆 You were this week's top inviter (${inviter.invites} invites)! ` +
          `Bonus: ${bonusEtb} ETB (${bonusCoins} coins) has been added to your balance.`
      }).catch(() => {});

      result.top_inviter = inviter;
    }

    /* ---- top ad watcher ---- */

    const watcher = (
      await q(
        `SELECT
          u.id,
          COUNT(*)::int AS ads
         FROM ad_views a
         JOIN users u
           ON u.id=a.user_id
         WHERE a.completed
           AND a.started_at >
             now() - interval '7 days'
         GROUP BY u.id
         ORDER BY ads DESC
         LIMIT 1`
      )
    ).rows[0];

    if (watcher) {
      await q(
        `UPDATE users
         SET vip_unlimited_until=
           now() + interval '7 days'
         WHERE id=$1`,
        [watcher.id]
      );

      await tg('sendMessage', {
        chat_id: watcher.id,
        text:
          `🏆 You watched the most ads this week (${watcher.ads})! ` +
          `You now have unlimited ads for the next 7 days.`
      }).catch(() => {});

      result.top_ad_watcher = watcher;
    }

    res.json({
      ok: true,
      ...result
    });
  })
);

/* ---------- webhook ---------- */

app.post(
  '/api/webhook',
  async (req, res) => {
    if (
      WEBHOOK_SECRET &&
      req.headers[
        'x-telegram-bot-api-secret-token'
      ] !== WEBHOOK_SECRET
    ) {
      return res.sendStatus(403);
    }

    try {
      await handleUpdate(
        req.body || {}
      );
    } catch (e) {
      console.error(
        'webhook',
        e
      );
    }

    res.sendStatus(200);
  }
);

/* ---------- export ---------- */

module.exports = app;

if (require.main === module) {
  app.listen(
    process.env.PORT || 3000,
    () => {
      console.log(
        `Adewa server running on port ${
          process.env.PORT || 3000
        }`
      );
    }
  );
  }
