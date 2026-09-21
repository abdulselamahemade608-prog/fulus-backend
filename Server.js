እሺ። ያለህን server.js መሰረት አድርጌ 5ቱን channels በdefault Gate ውስጥ አስገብቻለሁ፣ ADMIN_IDS ብዙ admins እንዲደግፍ አድርጌዋለሁ፣ ADMIN_ID ግን backward-compatible ነው።
ማስታወሻ: ADMIN_IDS ውስጥ የadmins' Telegram numeric IDs በcomma ይጻፉ። Channel admin መሆን ብቻ backend admin አያደርግም።
server.js
'use strict';

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

const MINI_APP_URL =
  process.env.MINI_APP_URL ||
  'https://abdulselamahemade608-prog.github.io/Mini';

/*
 * Default required channels.
 *
 * IMPORTANT:
 * The bot must be able to use getChatMember() for these channels.
 */
const DEFAULT_GATE_CHANNELS = [
  '@andbndj',
  '@abdu_monye2',
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
  'gate_channels',
  'gate_cache_min'
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
    await q(
      `UPDATE users
       SET coins=coins+$2
       WHERE id=$1`,
      [
        uid,
        r.rowCount *
          (S.referral_reward || 0)
      ]
    );
  }
}

/* ---------- utilities ---------- */

function pick(table) {
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
  await q(
    `UPDATE tasks
     SET active=false
     WHERE id=$1
       AND max_users IS NOT NULL
       AND (
         SELECT COUNT(*)
         FROM task_subs
         WHERE task_id=$1
           AND status IN ('pending','approved')
       ) >= max_users`,
    [id]
  );
}

const chatUrl = (c) =>
  'https://t.me/' +
  String(c).replace(/^@/, '');

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
          limits[u.level - 1] ||
          limits[
            limits.length - 1
          ],

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
            S.withdraw_interval_hours
        }
      },

      invited,

      ref_link:
        `https://t.me/${await botName()}?start=ref_${u.id}`,

      is_admin:
        isAdmin(u.id)
    });
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
       SET coins=coins+$2
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
         SET coins=coins+$2
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
    const { rows } = await q(
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
       LIMIT 10`
    );

    res.json({
      top: rows
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
    ).slice(0, 24);

    const account = String(
      b.account || ''
    )
      .trim()
      .slice(0, 64);

    if (
      !(etb > 0) ||
      !method ||
      account.length < 5
    ) {
      return fail(
        res,
        400,
        'bad_input'
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

    const d = await q(
      `UPDATE users
       SET coins=coins-$2,
           last_withdraw_at=now()
       WHERE id=$1
         AND coins>=$2
       RETURNING coins`,
      [
        u.id,
        coins
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
          account
        )
        VALUES($1,$2,$3,$4,$5)
        RETURNING id`,
        [
          u.id,
          coins,
          etb,
          method,
          account
        ]
      )
    ).rows[0];

    const text =
      `Withdrawal #${w.id}\n` +
      `User: ${u.first_name} (ID: ${u.id})\n` +
      `Amount: ${etb} ETB\n` +
      `Method: ${method}\n` +
      `Account: ${account}`;

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
                  text: 'Paid',
                  callback_data:
                    `w:a:${w.id}`
                },
                {
                  text: 'Reject',
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

    await q(
      `INSERT INTO tasks(
        title,
        type,
        url,
        chat,
        reward,
        max_users
      )
      VALUES($1,$2,$3,$4,$5,$6)`,
      [
        title,
        type,
        url,
        type === 'channel'
          ? chat
          : '',
        Math.max(
          0,
          Math.floor(
            Number(
              b.reward
            ) || 0
          )
        ),
        max
      ]
    );

    res.json({
      ok: true
    });
  })
);

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
          text:
            'Welcome to Adewa. Tap the button to open the app.',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text:
                    'Open Adewa',
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
                u.first_name
               FROM withdrawals w
               JOIN users u
                 ON u.id=w.user_id
               WHERE w.id=$1`,
              [a.value.wid]
            )
          ).rows[0];

          if (w) {
            await tg(
              'sendPhoto',
              {
                chat_id:
                  PROOF_CHANNEL,
                photo: fileId,
                caption:
                  `Paid ${w.etb} ETB via ${w.method}\n` +
                  `User: ${w.first_name}`
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
                    text: 'Approve',
                    callback_data:
                      `t:a:${s.id}`
                  },
                  {
                    text: 'Reject',
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
             SET coins=coins+$2
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

          note = 'Approved';
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

          note = 'Rejected';
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
                `Your withdrawal of ${r.rows[0].etb} ETB has been paid.`
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
            'Marked as paid';
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
             coins`,
          [id]
        );

        if (r.rowCount) {
          await q(
            `UPDATE users
             SET coins=coins+$2,
                 last_withdraw_at=NULL
             WHERE id=$1`,
            [
              r.rows[0]
                .user_id,
              r.rows[0].coins
            ]
          );

          await tg(
            'sendMessage',
            {
              chat_id:
                r.rows[0].user_id,
              text:
                'Your withdrawal was rejected and your coins were returned.'
            }
          );

          note =
            'Rejected and refunded';
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
Vercel Environment Variables
አሁን ይህን አክል:
ADMIN_IDS=YOUR_TELEGRAM_ID_1,YOUR_TELEGRAM_ID_2,YOUR_TELEGRAM_ID_3
አንድ admin ብቻ ካለ:
ADMIN_IDS=YOUR_TELEGRAM_NUMERIC_ID
እነዚህ 5ቱ ግን በcode ውስጥ default ሆነው አሉ:
@andbndj
@abdu_monye2
@proof_chnallel
@ABDU_CRYPTO
@m_r_work1
ከፍተኛ አስፈላጊ: Bot-ህን በእያንዳንዱ 5 channels ውስጥ Admin አድርግ። ከዚያ Vercel Redeploy አድርግ።
Health test:
https://adewa-backend.vercel.app/health
መመለስ ያለበት:
{
  "ok": true,
  "service": "Adewa",
  "status": "online",
  "database": "connected"
}
አንድ ሌላ ነገር: የ5ቱን channels በdatabase gate_channels ውስጥ ካስቀመጥክ እንኳን ይሰራል፤ ካላስቀመጥክም ይህ code ከላይ ያሉትን 5ቱን automatic default ይጠቀማል።AD_COOLDOWN_SECONDS = int(
    os.getenv(
        "AD_COOLDOWN_SECONDS",
        "20"
    )
)

AD_SESSION_TIMEOUT = int(
    os.getenv(
        "AD_SESSION_TIMEOUT",
        "1800"
    )
)

ADDIS_TIMEZONE = ZoneInfo(
    "Africa/Addis_Ababa"
)

DB_READY = False


# ============================================================
# DEFAULT SETTINGS
# ============================================================

DEFAULT_SETTINGS = {

    # Ads
    "ad_reward": "0.50",

    # Referrals
    "referral_reward": "1.00",
    "referral_required": "10",

    # Withdrawal
    "withdrawal_enabled": "true",
    "withdrawal_cooldown_hours": "48",
    "min_withdraw": "1.00",

    # Spin
    "spin_price": "2.00",
    "spin_spins": "10",

    # Daily ads
    "daily_limit_1": "10",
    "daily_limit_2": "15",
    "daily_limit_3": "20",
}


# ============================================================
# DATABASE
# ============================================================

def db():
    if not DATABASE_URL:
        raise RuntimeError(
            "DATABASE_URL is missing"
        )

    return psycopg2.connect(
        DATABASE_URL,
        sslmode=DATABASE_SSLMODE
    )


def init_database():

    global DB_READY

    if DB_READY:
        return

    connection = db()

    try:

        cursor = connection.cursor()

        # ----------------------------------------------------
        # USERS
        # ----------------------------------------------------

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (

                id BIGSERIAL PRIMARY KEY,

                telegram_id BIGINT
                    UNIQUE NOT NULL,

                username TEXT,

                first_name TEXT,

                last_name TEXT,

                balance NUMERIC(18,2)
                    NOT NULL DEFAULT 0,

                streak INTEGER
                    NOT NULL DEFAULT 0,

                last_streak_date DATE,

                spins INTEGER
                    NOT NULL DEFAULT 0,

                created_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW(),

                updated_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW()
            );
        """)

        # ----------------------------------------------------
        # SETTINGS
        # ----------------------------------------------------

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS settings (

                key TEXT PRIMARY KEY,

                value TEXT NOT NULL
            );
        """)

        # ----------------------------------------------------
        # MEMBERSHIP CACHE
        # ----------------------------------------------------

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS membership_cache (

                telegram_id BIGINT NOT NULL,

                channel_id TEXT NOT NULL,

                is_member BOOLEAN
                    NOT NULL DEFAULT FALSE,

                checked_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW(),

                PRIMARY KEY (
                    telegram_id,
                    channel_id
                )
            );
        """)

        # ----------------------------------------------------
        # DAILY STATS
        # ----------------------------------------------------

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS daily_stats (

                telegram_id BIGINT NOT NULL,

                day DATE NOT NULL,

                ads_watched INTEGER
                    NOT NULL DEFAULT 0,

                target INTEGER
                    NOT NULL,

                completed BOOLEAN
                    NOT NULL DEFAULT FALSE,

                completed_at TIMESTAMPTZ,

                PRIMARY KEY (
                    telegram_id,
                    day
                )
            );
        """)

        # ----------------------------------------------------
        # AD SESSIONS
        # ----------------------------------------------------

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS ad_sessions (

                id TEXT PRIMARY KEY,

                telegram_id BIGINT NOT NULL,

                started_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW(),

                completed_at TIMESTAMPTZ,

                status TEXT
                    NOT NULL DEFAULT 'started',

                reward NUMERIC(18,2)
                    NOT NULL DEFAULT 0
            );
        """)

        # ----------------------------------------------------
        # REFERRALS
        # ----------------------------------------------------

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS referrals (

                id BIGSERIAL PRIMARY KEY,

                inviter_id BIGINT NOT NULL,

                referred_id BIGINT
                    UNIQUE NOT NULL,

                created_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW(),

                qualified BOOLEAN
                    NOT NULL DEFAULT FALSE,

                qualified_at TIMESTAMPTZ
            );
        """)

        # ----------------------------------------------------
        # TASKS
        # ----------------------------------------------------

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS tasks (

                id BIGSERIAL PRIMARY KEY,

                title TEXT NOT NULL,

                task_type TEXT NOT NULL,

                url TEXT,

                channel_id TEXT,

                reward NUMERIC(18,2)
                    NOT NULL DEFAULT 0,

                max_users INTEGER,

                completed_count INTEGER
                    NOT NULL DEFAULT 0,

                active BOOLEAN
                    NOT NULL DEFAULT TRUE,

                persistent BOOLEAN
                    NOT NULL DEFAULT FALSE,

                created_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW()
            );
        """)

        # ----------------------------------------------------
        # TASK COMPLETIONS
        # ----------------------------------------------------

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS task_completions (

                id BIGSERIAL PRIMARY KEY,

                task_id BIGINT NOT NULL
                    REFERENCES tasks(id)
                    ON DELETE CASCADE,

                telegram_id BIGINT NOT NULL,

                status TEXT
                    NOT NULL DEFAULT 'completed',

                proof_file_id TEXT,

                created_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW(),

                reviewed_at TIMESTAMPTZ,

                UNIQUE (
                    task_id,
                    telegram_id
                )
            );
        """)

        # ----------------------------------------------------
        # WITHDRAWALS
        # ----------------------------------------------------

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS withdrawals (

                id BIGSERIAL PRIMARY KEY,

                telegram_id BIGINT NOT NULL,

                amount NUMERIC(18,2)
                    NOT NULL,

                telebirr_name TEXT NOT NULL,

                telebirr_number TEXT NOT NULL,

                status TEXT
                    NOT NULL DEFAULT 'pending',

                requested_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW(),

                reviewed_at TIMESTAMPTZ,

                completed_at TIMESTAMPTZ,

                proof_message_id BIGINT,

                admin_note TEXT
            );
        """)

        # ----------------------------------------------------
        # ADMIN PROOF QUEUE
        # ----------------------------------------------------

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS admin_proof_queue (

                admin_id BIGINT PRIMARY KEY,

                withdrawal_id BIGINT NOT NULL
            );
        """)

        # ----------------------------------------------------
        # SPIN TRANSACTIONS
        # ----------------------------------------------------

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS spin_transactions (

                id BIGSERIAL PRIMARY KEY,

                telegram_id BIGINT NOT NULL,

                reward NUMERIC(18,2)
                    NOT NULL DEFAULT 0,

                created_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW()
            );
        """)

        # ----------------------------------------------------
        # DEFAULT SETTINGS
        # ----------------------------------------------------

        for key, value in DEFAULT_SETTINGS.items():

            cursor.execute("""
                INSERT INTO settings(
                    key,
                    value
                )
                VALUES(%s, %s)

                ON CONFLICT(key)
                DO NOTHING
            """, (
                key,
                value
            ))

        connection.commit()

        DB_READY = True

    finally:

        connection.close()


def ensure_database():

    if not DB_READY:
        init_database()


# ============================================================
# SETTINGS
# ============================================================

def get_setting(
    key,
    default=None
):

    ensure_database()

    connection = db()

    try:

        cursor = connection.cursor()

        cursor.execute("""
            SELECT value
            FROM settings
            WHERE key=%s
        """, (key,))

        row = cursor.fetchone()

        if not row:
            return default

        return row[0]

    finally:

        connection.close()


def set_setting(
    key,
    value
):

    ensure_database()

    connection = db()

    try:

        cursor = connection.cursor()

        cursor.execute("""
            INSERT INTO settings(
                key,
                value
            )
            VALUES(%s, %s)

            ON CONFLICT(key)

            DO UPDATE SET
                value=EXCLUDED.value
        """, (
            key,
            str(value)
        ))

        connection.commit()

    finally:

        connection.close()


def get_float(
    key,
    default
):

    try:

        return float(
            get_setting(
                key,
                str(default)
            )
        )

    except Exception:

        return default


def get_int(
    key,
    default
):

    try:

        return int(
            get_setting(
                key,
                str(default)
            )
        )

    except Exception:

        return default


def get_bool(
    key,
    default=False
):

    value = str(
        get_setting(
            key,
            "true"
            if default
            else "false"
        )
    ).lower()

    return value in (
        "true",
        "1",
        "yes",
        "on"
    )


# ============================================================
# TELEGRAM API
# ============================================================

def telegram(
    method,
    data=None
):

    if not BOT_TOKEN:

        raise RuntimeError(
            "BOT_TOKEN is missing"
        )

    url = (
        "https://api.telegram.org/"
        f"bot{BOT_TOKEN}/{method}"
    )

    response = requests.post(
        url,
        json=data or {},
        timeout=20
    )

    result = response.json()

    if not result.get("ok"):

        raise RuntimeError(
            result.get(
                "description",
                "Telegram API error"
            )
        )

    return result.get(
        "result"
    )


def send_message(
    chat_id,
    text,
    keyboard=None
):

    data = {
        "chat_id": chat_id,
        "text": text
    }

    if keyboard:
        data["reply_markup"] = keyboard

    return telegram(
        "sendMessage",
        data
    )


# ============================================================
# TELEGRAM MINI APP AUTH
# ============================================================

def verify_init_data(
    init_data
):

    if not init_data:
        return None

    if not BOT_TOKEN:
        return None

    try:

        data = dict(
            parse_qsl(
                init_data,
                keep_blank_values=True
            )
        )

        received_hash = data.pop(
            "hash",
            None
        )

        if not received_hash:
            return None

        data_check_string = "\n".join(
            f"{key}={value}"
            for key, value
            in sorted(data.items())
        )

        secret_key = hmac.new(
            b"WebAppData",
            BOT_TOKEN.encode(),
            hashlib.sha256
        ).digest()

        calculated_hash = hmac.new(
            secret_key,
            data_check_string.encode(),
            hashlib.sha256
        ).hexdigest()

        if not hmac.compare_digest(
            calculated_hash,
            received_hash
        ):
            return None

        auth_date = int(
            data.get(
                "auth_date",
                "0"
            )
        )

        if auth_date:

            now = int(
                datetime.now(
                    timezone.utc
                ).timestamp()
            )

            # 24-hour maximum age
            if now - auth_date > 86400:
                return None

        telegram_user = data.get(
            "user"
        )

        if not telegram_user:
            return None

        return json.loads(
            telegram_user
        )

    except Exception:

        return None


def authenticated_user():

    init_data = request.headers.get(
        "X-Telegram-Init-Data",
        ""
    )

    return verify_init_data(
        init_data
    )


# ============================================================
# USER
# ============================================================

def save_user(
    telegram_user
):

    telegram_id = int(
        telegram_user["id"]
    )

    username = telegram_user.get(
        "username"
    )

    first_name = telegram_user.get(
        "first_name"
    )

    last_name = telegram_user.get(
        "last_name"
    )

    connection = db()

    try:

        cursor = connection.cursor(
            cursor_factory=RealDictCursor
        )

        cursor.execute("""
            INSERT INTO users(
                telegram_id,
                username,
                first_name,
                last_name
            )

            VALUES(
                %s,
                %s,
                %s,
                %s
            )

            ON CONFLICT(telegram_id)

            DO UPDATE SET

                username=
                    EXCLUDED.username,

                first_name=
                    EXCLUDED.first_name,

                last_name=
                    EXCLUDED.last_name,

                updated_at=
                    NOW()

            RETURNING *
        """, (
            telegram_id,
            username,
            first_name,
            last_name
        ))

        user = cursor.fetchone()

        connection.commit()

        return user

    finally:

        connection.close()


def require_user(function):

    @wraps(function)
    def wrapper(*args, **kwargs):

        try:

            ensure_database()

            telegram_user = authenticated_user()

            if not telegram_user:

                return jsonify({
                    "ok": False,
                    "error":
                        "Invalid Telegram authentication"
                }), 401

            user = save_user(
                telegram_user
            )

            g.telegram_id = int(
                telegram_user["id"]
            )

            g.user = user

            return function(
                *args,
                **kwargs
            )

        except Exception as error:

            print(
                "API ERROR:",
                error
            )

            return jsonify({
                "ok": False,
                "error": str(error)
            }), 500

    return wrapper


# ============================================================
# CHANNEL CONFIG
# ============================================================

def required_channels():

    channels = []

    for number in range(1, 6):

        channel_id = get_setting(
            f"channel_{number}_id",
            os.getenv(
                f"CHANNEL_{number}_ID",
                ""
            ).strip()
        )

        channel_url = get_setting(
            f"channel_{number}_url",
            os.getenv(
                f"CHANNEL_{number}_URL",
                ""
            ).strip()
        )

        channel_title = get_setting(
            f"channel_{number}_title",
            os.getenv(
                f"CHANNEL_{number}_TITLE",
                f"Channel {number}"
            ).strip()
        )

        if channel_id:

            channels.append({

                "number": number,

                "id": channel_id,

                "url": channel_url,

                "title": channel_title
            })

    return channels


# ============================================================
# CHANNEL MEMBERSHIP
# ============================================================

def channel_member(
    telegram_id,
    channel,
    force=False
):

    channel_id = str(
        channel["id"]
    )

    connection = db()

    try:

        cursor = connection.cursor(
            cursor_factory=RealDictCursor
        )

        # ----------------------------------------------------
        # CACHE
        # ----------------------------------------------------

        if not force:

            cursor.execute("""
                SELECT
                    is_member,
                    checked_at

                FROM membership_cache

                WHERE telegram_id=%s
                  AND channel_id=%s
            """, (
                telegram_id,
                channel_id
            ))

            cached = cursor.fetchone()

            if cached:

                age = (
                    datetime.now(
                        timezone.utc
                    )
                    - cached["checked_at"]
                ).total_seconds()

                if age < CHANNEL_CACHE_SECONDS:

                    return bool(
                        cached["is_member"]
                    )

        # ----------------------------------------------------
        # LIVE CHECK
        # ----------------------------------------------------

        result = telegram(
            "getChatMember",
            {
                "chat_id":
                    channel_id,

                "user_id":
                    telegram_id
            }
        )

        status = result.get(
            "status"
        )

        is_member = (

            status in (
                "creator",
                "administrator",
                "member"
            )

            or (

                status == "restricted"

                and result.get(
                    "is_member",
                    False
                )
            )
        )

        cursor.execute("""
            INSERT INTO membership_cache(
                telegram_id,
                channel_id,
                is_member,
                checked_at
            )

            VALUES(
                %s,
                %s,
                %s,
                NOW()
            )

            ON CONFLICT(
                telegram_id,
                channel_id
            )

            DO UPDATE SET

                is_member=
                    EXCLUDED.is_member,

                checked_at=
                    NOW()
        """, (
            telegram_id,
            channel_id,
            is_member
        ))

        connection.commit()

        return is_member

    finally:

        connection.close()


def check_all_channels(
    telegram_id,
    force=False
):

    channels = required_channels()

    if len(channels) < 5:

        return {

            "all_joined": False,

            "error":
                "Five channels are not configured",

            "channels": []
        }

    result = []

    all_joined = True

    for channel in channels:

        try:

            joined = channel_member(
                telegram_id,
                channel,
                force
            )

        except Exception as error:

            print(
                "Channel check error:",
                error
            )

            joined = False

        result.append({

            "number":
                channel["number"],

            "id":
                channel["id"],

            "title":
                channel["title"],

            "url":
                channel["url"],

            "joined":
                joined
        })

        if not joined:
            all_joined = False

    return {

        "all_joined":
            all_joined,

        "channels":
            result
    }


# ============================================================
# LEVEL / DAILY ADS
# ============================================================

def user_level(
    streak
):

    if streak >= 14:
        return 3

    if streak >= 7:
        return 2

    return 1


def daily_limit(
    streak
):

    level = user_level(
        streak
    )

    return get_int(
        f"daily_limit_{level}",
        10
        if level == 1
        else 15
        if level == 2
        else 20
    )


def addis_today():

    return datetime.now(
        ADDIS_TIMEZONE
    ).date()


def daily_row(
    connection,
    telegram_id,
    day,
    target
):

    cursor = connection.cursor(
        cursor_factory=RealDictCursor
    )

    cursor.execute("""
        INSERT INTO daily_stats(
            telegram_id,
            day,
            target
        )

        VALUES(
            %s,
            %s,
            %s
        )

        ON CONFLICT(
            telegram_id,
            day
        )

        DO NOTHING
    """, (
        telegram_id,
        day,
        target
    ))

    cursor.execute("""
        SELECT *
        FROM daily_stats

        WHERE telegram_id=%s
          AND day=%s

        FOR UPDATE
    """, (
        telegram_id,
        day
    ))

    return cursor.fetchone()


def update_streak(
    connection,
    telegram_id,
    today
):

    cursor = connection.cursor(
        cursor_factory=RealDictCursor
    )

    cursor.execute("""
        SELECT
            streak,
            last_streak_date

        FROM users

        WHERE telegram_id=%s

        FOR UPDATE
    """, (
        telegram_id,
    ))

    user = cursor.fetchone()

    streak = user["streak"] or 0

    last_date = (
        user["last_streak_date"]
    )

    if last_date == today:

        new_streak = streak

    elif (
        last_date
        and last_date ==
        today - timedelta(days=1)
    ):

        new_streak = streak + 1

    else:

        new_streak = 1

    cursor.execute("""
        UPDATE users

        SET
            streak=%s,
            last_streak_date=%s,
            updated_at=NOW()

        WHERE telegram_id=%s
    """, (
        new_streak,
        today,
        telegram_id
    ))

    return new_streak


# ============================================================
# HOME
# ============================================================

@app.get("/api/me")
@require_user
def me():

    connection = db()

    try:

        cursor = connection.cursor(
            cursor_factory=RealDictCursor
        )

        cursor.execute("""
            SELECT *
            FROM users
            WHERE telegram_id=%s
        """, (
            g.telegram_id,
        ))

        user = cursor.fetchone()

        today = addis_today()

        limit = daily_limit(
            user["streak"]
        )

        cursor.execute("""
            SELECT ads_watched
            FROM daily_stats

            WHERE telegram_id=%s
              AND day=%s
        """, (
            g.telegram_id,
            today
        ))

        stat = cursor.fetchone()

        ads_watched = (
            stat["ads_watched"]
            if stat
            else 0
        )

        cursor.execute("""
            SELECT COUNT(*)
            FROM referrals

            WHERE inviter_id=%s
              AND qualified=TRUE
        """, (
            g.telegram_id,
        ))

        qualified_referrals = (
            cursor.fetchone()[0]
        )

        return jsonify({

            "ok": True,

            "user": {

                "telegramId":
                    g.telegram_id,

                "username":
                    user["username"],

                "firstName":
                    user["first_name"],

                "lastName":
                    user["last_name"],

                "balance":
                    float(user["balance"]),

                "streak":
                    user["streak"],

                "level":
                    user_level(
                        user["streak"]
                    ),

                "adsWatched":
                    ads_watched,

                "adsLimit":
                    limit,

                "adsRemaining":
                    max(
                        0,
                        limit - ads_watched
                    ),

                "spins":
                    user["spins"],

                "qualifiedReferrals":
                    qualified_referrals
            },

            "settings": {

                "adReward":
                    get_float(
                        "ad_reward",
                        0.50
                    ),

                "referralRequired":
                    get_int(
                        "referral_required",
                        10
                    ),

                "withdrawalEnabled":
                    get_bool(
                        "withdrawal_enabled",
                        True
                    )
            }
        })

    finally:

        connection.close()


# ============================================================
# FRONTEND CONFIG
# ============================================================

@app.get("/api/config")
@require_user
def config():

    return jsonify({

        "ok": True,

        "channels":
            required_channels(),

        "adReward":
            get_float(
                "ad_reward",
                0.50
            ),

        "referralRequired":
            get_int(
                "referral_required",
                10
            ),

        "withdrawalEnabled":
            get_bool(
                "withdrawal_enabled",
                True
            ),

        "withdrawalCooldown":
            get_int(
                "withdrawal_cooldown_hours",
                48
            ),

        "spinPrice":
            get_float(
                "spin_price",
                2
            ),

        "spinSpins":
            get_int(
                "spin_spins",
                10
            )
    })


# ============================================================
# CHANNEL CHECK API
# ============================================================

@app.post("/api/channels/check")
@require_user
def channels_check():

    body = request.get_json(
        silent=True
    ) or {}

    channel_id = str(
        body.get(
            "channelId",
            ""
        )
    )

    channel = next(
        (
            item
            for item in required_channels()
            if str(item["id"])
            == channel_id
        ),
        None
    )

    if not channel:

        return jsonify({

            "ok": False,

            "error":
                "Channel not found"
        }), 404

    joined = channel_member(
        g.telegram_id,
        channel,
        force=False
    )

    return jsonify({

        "ok": True,

        "channelId":
            channel_id,

        "joined":
            joined
    })


# ============================================================
# ADS - START
# ============================================================

@app.post("/api/ads/start")
@require_user
def ads_start():

    membership = check_all_channels(
        g.telegram_id,
        force=False
    )

    if not membership["all_joined"]:

        return jsonify({

            "ok": False,

            "error":
                "Join all required channels first",

            "channels":
                membership["channels"]
        }), 403

    connection = db()

    try:

        cursor = connection.cursor(
            cursor_factory=RealDictCursor
        )

        cursor.execute("""
            SELECT streak
            FROM users

            WHERE telegram_id=%s

            FOR UPDATE
        """, (
            g.telegram_id,
        ))

        user = cursor.fetchone()

        limit = daily_limit(
            user["streak"]
        )

        today = addis_today()

        stat = daily_row(
            connection,
            g.telegram_id,
            today,
            limit
        )

        if stat["ads_watched"] >= limit:

            connection.commit()

            return jsonify({

                "ok": False,

                "error":
                    "Daily ad limit reached",

                "adsWatched":
                    stat["ads_watched"],

                "adsLimit":
                    limit
            }), 400

        # ----------------------------------------------------
        # COOLDOWN
        # ----------------------------------------------------

        cursor.execute("""
            SELECT completed_at

            FROM ad_sessions

            WHERE telegram_id=%s
              AND status='completed'

            ORDER BY completed_at DESC

            LIMIT 1
        """, (
            g.telegram_id,
        ))

        last_ad = cursor.fetchone()

        if last_ad:

            elapsed = (
                datetime.now(
                    timezone.utc
                )
                - last_ad["completed_at"]
            ).total_seconds()

            if elapsed < AD_COOLDOWN_SECONDS:

                wait = int(
                    AD_COOLDOWN_SECONDS
                    - elapsed
                )

                connection.commit()

                return jsonify({

                    "ok": False,

                    "error":
                        f"Please wait {wait} seconds"
                }), 429

        session_id = str(
            uuid4()
        )

        cursor.execute("""
            INSERT INTO ad_sessions(
                id,
                telegram_id,
                status
            )

            VALUES(
                %s,
                %s,
                'started'
            )
        """, (
            session_id,
            g.telegram_id
        ))

        connection.commit()

        return jsonify({

            "ok": True,

            "sessionId":
                session_id,

            "minimumSeconds":
                AD_MIN_SECONDS
        })

    finally:

        connection.close()


# ============================================================
# ADS - COMPLETE
# ============================================================

@app.post("/api/ads/complete")
@require_user
def ads_complete():

    body = request.get_json(
        silent=True
    ) or {}

    session_id = str(
        body.get(
            "sessionId",
            ""
        )
    )

    if not session_id:

        return jsonify({

            "ok": False,

            "error":
                "Missing session ID"
        }), 400

    connection = db()

    try:

        cursor = connection.cursor(
            cursor_factory=RealDictCursor
        )

        cursor.execute("""
            SELECT *
            FROM ad_sessions

            WHERE id=%s
              AND telegram_id=%s

            FOR UPDATE
        """, (
            session_id,
            g.telegram_id
        ))

        session = cursor.fetchone()

        if not session:

            connection.rollback()

            return jsonify({

                "ok": False,

                "error":
                    "Invalid ad session"
            }), 400

        if session["status"] != "started":

            connection.rollback()

            return jsonify({

                "ok": False,

                "error":
                    "Ad session already used"
            }), 400

        elapsed = (
            datetime.now(
                timezone.utc
            )
            - session["started_at"]
        ).total_seconds()

        if elapsed < AD_MIN_SECONDS:

            connection.rollback()

            return jsonify({

                "ok": False,

                "error":
                    "Ad was not completed"
            }), 400

        if elapsed > AD_SESSION_TIMEOUT:

            connection.rollback()

            return jsonify({

                "ok": False,

                "error":
                    "Ad session expired"
            }), 400

        # ----------------------------------------------------
        # CHANNEL CHECK
        # ----------------------------------------------------

        membership = check_all_channels(
            g.telegram_id,
            force=False
        )

        if not membership["all_joined"]:

            connection.rollback()

            return jsonify({

                "ok": False,

                "error":
                    "Join all required channels first"
            }), 403

        # ----------------------------------------------------
        # DAILY LIMIT
        # ----------------------------------------------------

        cursor.execute("""
            SELECT streak
            FROM users

            WHERE telegram_id=%s

            FOR UPDATE
        """, (
            g.telegram_id,
        ))

        user = cursor.fetchone()

        target = daily_limit(
            user["streak"]
        )

        today = addis_today()

        stat = daily_row(
            connection,
            g.telegram_id,
            today,
            target
        )

        if stat["ads_watched"] >= target:

            connection.rollback()

            return jsonify({

                "ok": False,

                "error":
                    "Daily limit reached"
            }), 400

        reward = Decimal(
            str(
                get_float(
                    "ad_reward",
                    0.50
                )
            )
        )

        new_count = (
            stat["ads_watched"] + 1
        )

        day_completed = (
            new_count >= target
        )

        cursor.execute("""
            UPDATE daily_stats

            SET
                ads_watched=%s,
                completed=%s,

                completed_at=
                    CASE
                        WHEN %s
                        THEN NOW()

                        ELSE completed_at
                    END

            WHERE telegram_id=%s
              AND day=%s
        """, (
            new_count,
            day_completed,
            day_completed,
            g.telegram_id,
            today
        ))

        cursor.execute("""
            UPDATE ad_sessions

            SET
                status='completed',
                completed_at=NOW(),
                reward=%s

            WHERE id=%s
        """, (
            reward,
            session_id
        ))

        if day_completed:

            streak = update_streak(
                connection,
                g.telegram_id,
                today
            )

        else:

            streak = user["streak"]

        cursor.execute("""
            UPDATE users

            SET
                balance=
                    balance+%s,

                updated_at=
                    NOW()

            WHERE telegram_id=%s

            RETURNING balance
        """, (
            reward,
            g.telegram_id
        ))

        balance = cursor.fetchone()[
            "balance"
        ]

        connection.commit()

        return jsonify({

            "ok": True,

            "reward":
                float(reward),

            "balance":
                float(balance),

            "adsWatched":
                new_count,

            "adsLimit":
                daily_limit(
                    streak
                ),

            "streak":
                streak,

            "level":
                user_level(
                    streak
                ),

            "dailyCompleted":
                day_completed
        })

    except Exception:

        connection.rollback()

        raise

    finally:

        connection.close()


# ============================================================
# TASKS
# ============================================================

@app.get("/api/tasks")
@require_user
def tasks():

    connection = db()

    try:

        cursor = connection.cursor(
            cursor_factory=RealDictCursor
        )

        cursor.execute("""
            SELECT
                t.id,
                t.title,
                t.task_type,
                t.url,
                t.channel_id,
                t.reward

            FROM tasks t

            WHERE t.active=TRUE

              AND (
                    t.max_users IS NULL

                    OR

                    t.completed_count
                    < t.max_users
              )

              AND NOT EXISTS(

                    SELECT 1

                    FROM task_completions tc

                    WHERE tc.task_id=t.id

                      AND tc.telegram_id=%s

                      AND tc.status IN(
                          'completed',
                          'approved'
                      )
              )

            ORDER BY t.id DESC
        """, (
            g.telegram_id,
        ))

        rows = cursor.fetchall()

        return jsonify({

            "ok": True,

            "tasks": [

                {
                    "id":
                        row["id"],

                    "title":
                        row["title"],

                    "type":
                        row["task_type"],

                    "url":
                        row["url"],

                    "channelId":
                        row["channel_id"],

                    "reward":
                        float(row["reward"])
                }

                for row in rows
            ]
        })

    finally:

        connection.close()


@app.post("/api/tasks/complete")
@require_user
def complete_task():

    body = request.get_json(
        silent=True
    ) or {}

    task_id = body.get(
        "taskId"
    )

    if not task_id:

        return jsonify({

            "ok": False,

            "error":
                "Task ID required"
        }), 400

    connection = db()

    try:

        cursor = connection.cursor(
            cursor_factory=RealDictCursor
        )

        cursor.execute("""
            SELECT *
            FROM tasks

            WHERE id=%s
              AND active=TRUE

            FOR UPDATE
        """, (
            task_id,
        ))

        task = cursor.fetchone()

        if not task:

            connection.rollback()

            return jsonify({

                "ok": False,

                "error":
                    "Task unavailable"
            }), 404

        cursor.execute("""
            SELECT id
            FROM task_completions

            WHERE task_id=%s
              AND telegram_id=%s
        """, (
            task_id,
            g.telegram_id
        ))

        if cursor.fetchone():

            connection.rollback()

            return jsonify({

                "ok": False,

                "error":
                    "Task already completed"
            }), 400

        # ----------------------------------------------------
        # TELEGRAM TASK
        # ----------------------------------------------------

        if task["task_type"] in (
            "telegram",
            "channel"
        ):

            if not task["channel_id"]:

                connection.rollback()

                return jsonify({

                    "ok": False,

                    "error":
                        "Task channel missing"
                }), 400

            joined = channel_member(

                g.telegram_id,

                {
                    "id":
                        task["channel_id"],

                    "url":
                        task["url"] or "",

                    "title":
                        task["title"]
                },

                force=True
            )

            if not joined:

                connection.rollback()

                return jsonify({

                    "ok": False,

                    "error":
                        "Join the channel first"
                }), 403

            status = "completed"

        else:

            connection.rollback()

            return jsonify({

                "ok": False,

                "requiresProof":
                    True,

                "error":
                    "Screenshot proof required"
            }), 400

        reward = task["reward"]

        cursor.execute("""
            INSERT INTO task_completions(
                task_id,
                telegram_id,
                status
            )

            VALUES(
                %s,
                %s,
                %s
            )
        """, (
            task_id,
            g.telegram_id,
            status
        ))

        cursor.execute("""
            UPDATE tasks

            SET
                completed_count=
                    completed_count+1

            WHERE id=%s
        """, (
            task_id,
        ))

        if (
            task["max_users"] is not None

            and

            task["completed_count"] + 1
            >= task["max_users"]
        ):

            cursor.execute("""
                UPDATE tasks

                SET active=FALSE

                WHERE id=%s
            """, (
                task_id,
            ))

        cursor.execute("""
            UPDATE users

            SET
                balance=
                    balance+%s,

                updated_at=
                    NOW()

            WHERE telegram_id=%s

            RETURNING balance
        """, (
            reward,
            g.telegram_id
        ))

        balance = cursor.fetchone()[
            "balance"
        ]

        connection.commit()

        return jsonify({

            "ok": True,

            "reward":
                float(reward),

            "balance":
                float(balance)
        })

    except Exception:

        connection.rollback()

        raise

    finally:

        connection.close()


# ============================================================
# REFERRALS
# ============================================================

def create_referral(
    inviter_id,
    referred_id
):

    if inviter_id == referred_id:
        return False

    connection = db()

    try:

        cursor = connection.cursor()

        cursor.execute("""
            SELECT id
            FROM referrals

            WHERE referred_id=%s
        """, (
            referred_id,
        ))

        if cursor.fetchone():

            connection.commit()

            return False

        cursor.execute("""
            SELECT telegram_id
            FROM users

            WHERE telegram_id=%s
        """, (
            inviter_id,
        ))

        if not cursor.fetchone():

            connection.commit()

            return False

        cursor.execute("""
            INSERT INTO referrals(
                inviter_id,
                referred_id
            )

            VALUES(
                %s,
                %s
            )

            ON CONFLICT(
                referred_id
            )

            DO NOTHING
        """, (
            inviter_id,
            referred_id
        ))

        connection.commit()

        return True

    finally:

        connection.close()


@app.get("/api/referrals")
@require_user
def referral_list():

    connection = db()

    try:

        cursor = connection.cursor(
            cursor_factory=RealDictCursor
        )

        cursor.execute("""
            SELECT
                r.id,
                r.created_at,
                r.qualified,

                u.telegram_id,
                u.username,
                u.first_name

            FROM referrals r

            JOIN users u
              ON u.telegram_id=
                 r.referred_id

            WHERE r.inviter_id=%s

            ORDER BY r.created_at DESC
        """, (
            g.telegram_id,
        ))

        rows = cursor.fetchall()

        output = []

        for row in rows:

            cursor.execute("""
                SELECT COUNT(*)

                FROM daily_stats

                WHERE telegram_id=%s
                  AND day >= %s::date
                  AND completed=TRUE
            """, (
                row["telegram_id"],
                row["created_at"]
            ))

            days = min(
                2,
                cursor.fetchone()[0]
            )

            output.append({

                "id":
                    row["id"],

                "telegramId":
                    row["telegram_id"],

                "username":
                    row["username"],

                "name":
                    row["first_name"]
                    or "User",

                "day1":
                    days >= 1,

                "day2":
                    days >= 2,

                "progress":
                    int(
                        days / 2 * 100
                    ),

                "qualified":
                    row["qualified"]
            })

        cursor.execute("""
            SELECT COUNT(*)

            FROM referrals

            WHERE inviter_id=%s
              AND qualified=TRUE
        """, (
            g.telegram_id,
        ))

        qualified = cursor.fetchone()[0]

        referral_link = ""

        if BOT_USERNAME:

            referral_link = (
                "https://t.me/"
                + BOT_USERNAME
                + "?start=ref_"
                + str(g.telegram_id)
            )

        return jsonify({

            "ok": True,

            "qualified":
                qualified,

            "required":
                get_int(
                    "referral_required",
                    10
                ),

            "referralLink":
                referral_link,

            "referrals":
                output
        })

    finally:

        connection.close()


# ============================================================
# SPIN
# ============================================================

def spin_reward():

    roll = secrets.randbelow(
        10000
    )

    # 75% = 0
    if roll < 7500:

        return Decimal(
            "0.00"
        )

    # 18% = small reward
    if roll < 9300:

        return secrets.choice([

            Decimal("0.10"),
            Decimal("0.15"),
            Decimal("0.20"),
            Decimal("0.25"),
            Decimal("0.30")
        ])

    # 6.9% = medium reward
    if roll < 9990:

        return secrets.choice([

            Decimal("1.00"),
            Decimal("1.25"),
            Decimal("1.50"),
            Decimal("1.75"),
            Decimal("2.00"),
            Decimal("2.25"),
            Decimal("2.50")
        ])

    # 0.1% = large reward
    return secrets.choice([

        Decimal("15.00"),
        Decimal("17.50"),
        Decimal("20.00"),
        Decimal("22.50"),
        Decimal("25.00")
    ])


@app.post("/api/spin/buy")
@require_user
def spin_buy():

    price = Decimal(
        str(
            get_float(
                "spin_price",
                2
            )
        )
    )

    amount = get_int(
        "spin_spins",
        10
    )

    connection = db()

    try:

        cursor = connection.cursor(
            cursor_factory=RealDictCursor
        )

        cursor.execute("""
            SELECT
                balance,
                spins

            FROM users

            WHERE telegram_id=%s

            FOR UPDATE
        """, (
            g.telegram_id,
        ))

        user = cursor.fetchone()

        balance = Decimal(
            str(
                user["balance"]
            )
        )

        if balance < price:

            connection.rollback()

            return jsonify({

                "ok": False,

                "error":
                    "Insufficient balance"
            }), 400

        cursor.execute("""
            UPDATE users

            SET
                balance=
                    balance-%s,

                spins=
                    spins+%s,

                updated_at=
                    NOW()

            WHERE telegram_id=%s

            RETURNING balance, spins
        """, (
            price,
            amount,
            g.telegram_id
        ))

        updated = cursor.fetchone()

        connection.commit()

        return jsonify({

            "ok": True,

            "paid":
                float(price),

            "spinsAdded":
                amount,

            "balance":
                float(
                    updated["balance"]
                ),

            "spins":
                updated["spins"]
        })

    finally:

        connection.close()


@app.post("/api/spin/spin")
@require_user
def spin():

    connection = db()

    try:

        cursor = connection.cursor(
            cursor_factory=RealDictCursor
        )

        cursor.execute("""
            SELECT spins

            FROM users

            WHERE telegram_id=%s

            FOR UPDATE
        """, (
            g.telegram_id,
        ))

        user = cursor.fetchone()

        if user["spins"] <= 0:

            connection.rollback()

            return jsonify({

                "ok": False,

                "error":
                    "No spins available"
            }), 400

        reward = spin_reward()

        cursor.execute("""
            UPDATE users

            SET
                spins=
                    spins-1,

                balance=
                    balance+%s,

                updated_at=
                    NOW()

            WHERE telegram_id=%s

            RETURNING balance, spins
        """, (
            reward,
            g.telegram_id
        ))

        updated = cursor.fetchone()

        cursor.execute("""
            INSERT INTO spin_transactions(
                telegram_id,
                reward
            )

            VALUES(
                %s,
                %s
            )
        """, (
            g.telegram_id,
            reward
        ))

        connection.commit()

        return jsonify({

            "ok": True,

            "reward":
                float(reward),

            "balance":
                float(
                    updated["balance"]
                ),

            "spins":
                updated["spins"]
        })

    finally:

        connection.close()


# ============================================================
# WITHDRAWAL
# ============================================================

@app.post("/api/withdrawals")
@require_user
def withdrawal():

    body = request.get_json(
        silent=True
    ) or {}

    try:

        amount = Decimal(
            str(
                body.get(
                    "amount"
                )
            )
        )

    except Exception:

        return jsonify({

            "ok": False,

            "error":
                "Invalid amount"
        }), 400

    telebirr_name = str(
        body.get(
            "telebirrName",
            ""
        )
    ).strip()

    telebirr_number = str(
        body.get(
            "telebirrNumber",
            ""
        )
    ).strip()

    if amount <= 0:

        return jsonify({

            "ok": False,

            "error":
                "Invalid amount"
        }), 400

    if (
        not telebirr_name
        or not telebirr_number
    ):

        return jsonify({

            "ok": False,

            "error":
                "Telebirr information required"
        }), 400

    if not get_bool(
        "withdrawal_enabled",
        True
    ):

        return jsonify({

            "ok": False,

            "error":
                "Withdrawals are locked"
        }), 403

    minimum = Decimal(
        str(
            get_float(
                "min_withdraw",
                1
            )
        )
    )

    if amount < minimum:

        return jsonify({

            "ok": False,

            "error":
                f"Minimum withdrawal is "
                f"{minimum} ETB"
        }), 400

    # --------------------------------------------------------
    # FRESH/LIVE CHANNEL CHECK
    # --------------------------------------------------------

    membership = check_all_channels(
        g.telegram_id,
        force=True
    )

    if not membership["all_joined"]:

        return jsonify({

            "ok": False,

            "error":
                "Join all required channels",

            "channels":
                membership["channels"]
        }), 403

    connection = db()

    try:

        cursor = connection.cursor(
            cursor_factory=RealDictCursor
        )

        # ----------------------------------------------------
        # REFERRALS
        # ----------------------------------------------------

        cursor.execute("""
            SELECT COUNT(*)

            FROM referrals

            WHERE inviter_id=%s
              AND qualified=TRUE
        """, (
            g.telegram_id,
        ))

        qualified = cursor.fetchone()[0]

        required = get_int(
            "referral_required",
            10
        )

        if qualified < required:

            connection.rollback()

            return jsonify({

                "ok": False,

                "error":
                    "Qualified referral requirement not met",

                "qualified":
                    qualified,

                "required":
                    required
            }), 403

        # ----------------------------------------------------
        # COOLDOWN
        # ----------------------------------------------------

        cooldown = get_int(
            "withdrawal_cooldown_hours",
            48
        )

        cursor.execute("""
            SELECT requested_at

            FROM withdrawals

            WHERE telegram_id=%s

            ORDER BY requested_at DESC

            LIMIT 1
        """, (
            g.telegram_id,
        ))

        previous = cursor.fetchone()

        if previous:

            elapsed = (
                datetime.now(
                    timezone.utc
                )
                - previous["requested_at"]
            ).total_seconds()

            if elapsed < cooldown * 3600:

                remaining = int(
                    cooldown * 3600
                    - elapsed
                )

                connection.rollback()

                return jsonify({

                    "ok": False,

                    "error":
                        "Withdrawal cooldown active",

                    "remainingSeconds":
                        remaining
                }), 429

        # ----------------------------------------------------
        # BALANCE
        # ----------------------------------------------------

        cursor.execute("""
            SELECT balance

            FROM users

            WHERE telegram_id=%s

            FOR UPDATE
        """, (
            g.telegram_id,
        ))

        user = cursor.fetchone()

        balance = Decimal(
            str(
                user["balance"]
            )
        )

        if amount > balance:

            connection.rollback()

            return jsonify({

                "ok": False,

                "error":
                    "Insufficient balance"
            }), 400

        # Reserve money
        cursor.execute("""
            UPDATE users

            SET
                balance=
                    balance-%s,

                updated_at=
                    NOW()

            WHERE telegram_id=%s
        """, (
            amount,
            g.telegram_id
        ))

        cursor.execute("""
            INSERT INTO withdrawals(

                telegram_id,

                amount,

                telebirr_name,

                telebirr_number,

                status
            )

            VALUES(

                %s,
                %s,
                %s,
                %s,
                'pending'
            )

            RETURNING id
        """, (
            g.telegram_id,
            amount,
            telebirr_name,
            telebirr_number
        ))

        withdrawal_id = cursor.fetchone()[
            "id"
        ]

        connection.commit()

    except Exception:

        connection.rollback()

        raise

    finally:

        connection.close()

    # --------------------------------------------------------
    # ADMIN ALERT
    # --------------------------------------------------------

    keyboard = {

        "inline_keyboard": [

            [

                {
                    "text":
                        "Approve",

                    "callback_data":
                        f"wd:approve:{withdrawal_id}"
                },

                {
                    "text":
                        "Reject",

                    "callback_data":
                        f"wd:reject:{withdrawal_id}"
                }
            ]
        ]
    }

    try:

        send_message(

            ADMIN_ID,

            (
                "ADEWA WITHDRAWAL\n\n"

                f"ID: #{withdrawal_id}\n"

                f"User: {g.telegram_id}\n"

                f"Amount: {amount} ETB\n"

                f"Telebirr Name: "
                f"{telebirr_name}\n"

                f"Telebirr Number: "
                f"{telebirr_number}\n"

                f"Qualified Referrals: "
                f"{qualified}"
            ),

            keyboard
        )

    except Exception as error:

        print(
            "Admin notification error:",
            error
        )

    return jsonify({

        "ok": True,

        "withdrawalId":
            withdrawal_id,

        "status":
            "pending"
    })


# ============================================================
# TELEGRAM CALLBACKS
# ============================================================

def answer_callback(
    callback_id,
    text,
    alert=False
):

    telegram(
        "answerCallbackQuery",
        {
            "callback_query_id":
                callback_id,

            "text":
                text,

            "show_alert":
                alert
        }
    )


def handle_callback(
    callback
):

    callback_id = callback["id"]

    sender = callback.get(
        "from",
        {}
    )

    sender_id = int(
        sender.get(
            "id",
            0
        )
    )

    if sender_id != ADMIN_ID:

        answer_callback(
            callback_id,
            "Not authorized",
            True
        )

        return

    data = callback.get(
        "data",
        ""
    )

    parts = data.split(":")

    if len(parts) != 3:
        return

    if parts[0] != "wd":
        return

    action = parts[1]

    try:

        withdrawal_id = int(
            parts[2]
        )

    except Exception:

        return

    connection = db()

    try:

        cursor = connection.cursor(
            cursor_factory=RealDictCursor
        )

        cursor.execute("""
            SELECT *

            FROM withdrawals

            WHERE id=%s

            FOR UPDATE
        """, (
            withdrawal_id,
        ))

        withdrawal_row = cursor.fetchone()

        if not withdrawal_row:

            connection.rollback()

            answer_callback(
                callback_id,
                "Withdrawal not found",
                True
            )

            return

        if withdrawal_row["status"] != "pending":

            connection.rollback()

            answer_callback(
                callback_id,
                "Already processed",
                True
            )

            return

        # ----------------------------------------------------
        # REJECT
        # ----------------------------------------------------

        if action == "reject":

            cursor.execute("""
                UPDATE withdrawals

                SET
                    status='rejected',
                    reviewed_at=NOW()

                WHERE id=%s
            """, (
                withdrawal_id,
            ))

            # Refund
            cursor.execute("""
                UPDATE users

                SET
                    balance=
                        balance+%s,

                    updated_at=
                        NOW()

                WHERE telegram_id=%s
            """, (
                withdrawal_row["amount"],
                withdrawal_row["telegram_id"]
            ))

            connection.commit()

            try:

                send_message(

                    withdrawal_row[
                        "telegram_id"
                    ],

                    (
                        "Withdrawal rejected.\n\n"

                        f"Amount returned: "
                        f"{withdrawal_row['amount']} ETB"
                    )
                )

            except Exception:
                pass

            answer_callback(
                callback_id,
                "Withdrawal rejected"
            )

            return

        # ----------------------------------------------------
        # APPROVE
        # ----------------------------------------------------

        if action == "approve":

            cursor.execute("""
                UPDATE withdrawals

                SET
                    status='approved',
                    reviewed_at=NOW()

                WHERE id=%s
            """, (
                withdrawal_id,
            ))

            cursor.execute("""
                INSERT INTO admin_proof_queue(
                    admin_id,
                    withdrawal_id
                )

                VALUES(
                    %s,
                    %s
                )

                ON CONFLICT(admin_id)

                DO UPDATE SET
                    withdrawal_id=
                        EXCLUDED.withdrawal_id
            """, (
                ADMIN_ID,
                withdrawal_id
            ))

            connection.commit()

            try:

                send_message(

                    withdrawal_row[
                        "telegram_id"
                    ],

                    (
                        "Withdrawal approved.\n\n"

                        f"Amount: "
                        f"{withdrawal_row['amount']} ETB\n"

                        "Payment is being processed."
                    )
                )

            except Exception:
                pass

            send_message(

                ADMIN_ID,

                (
                    f"Withdrawal #{withdrawal_id} approved.\n\n"

                    "Now send the Telebirr payment "
                    "screenshot to this bot."
                )
            )

            answer_callback(
                callback_id,
                "Approved. Send payment proof."
            )

    finally:

        connection.close()


# ============================================================
# ADMIN PAYMENT PROOF
# ============================================================

def process_admin_photo(
    message
):

    sender_id = int(
        message.get(
            "from",
            {}
        ).get(
            "id",
            0
        )
    )

    if sender_id != ADMIN_ID:
        return

    connection = db()

    try:

        cursor = connection.cursor(
            cursor_factory=RealDictCursor
        )

        cursor.execute("""
            SELECT withdrawal_id

            FROM admin_proof_queue

            WHERE admin_id=%s
        """, (
            ADMIN_ID,
        ))

        queue = cursor.fetchone()

        if not queue:

            send_message(
                ADMIN_ID,
                "No payment proof is currently required."
            )

            return

        withdrawal_id = queue[
            "withdrawal_id"
        ]

        cursor.execute("""
            SELECT *

            FROM withdrawals

            WHERE id=%s
        """, (
            withdrawal_id,
        ))

        withdrawal_row = cursor.fetchone()

        if not withdrawal_row:

            return

        caption = (

            "ADEWA PAYMENT PROOF\n\n"

            f"Withdrawal: "
            f"#{withdrawal_id}\n"

            f"User ID: "
            f"{withdrawal_row['telegram_id']}\n"

            f"Amount: "
            f"{withdrawal_row['amount']} ETB\n"

            f"Telebirr Name: "
            f"{withdrawal_row['telebirr_name']}\n"

            f"Telebirr Number: "
            f"{withdrawal_row['telebirr_number']}\n"

            "Status: PAID"
        )

        copied = telegram(

            "copyMessage",

            {

                "chat_id":
                    PROOF_CHANNEL,

                "from_chat_id":
                    ADMIN_ID,

                "message_id":
                    message["message_id"],

                "caption":
                    caption
            }
        )

        proof_message_id = copied.get(
            "message_id"
        )

        cursor.execute("""
            UPDATE withdrawals

            SET
                status='paid',

                completed_at=NOW(),

                proof_message_id=%s

            WHERE id=%s
        """, (
            proof_message_id,
            withdrawal_id
        ))

        cursor.execute("""
            DELETE FROM admin_proof_queue

            WHERE admin_id=%s
        """, (
            ADMIN_ID,
        ))

        connection.commit()

        send_message(

            withdrawal_row[
                "telegram_id"
            ],

            (
                "Payment completed.\n\n"

                f"Amount: "
                f"{withdrawal_row['amount']} ETB\n"

                "Payment proof has been posted."
            )
        )

        send_message(

            ADMIN_ID,

            (
                f"Withdrawal #{withdrawal_id} "
                "completed successfully."
            )
        )

    except Exception as error:

        connection.rollback()

        send_message(

            ADMIN_ID,

            (
                "Payment proof failed:\n"
                f"{error}"
            )
        )

    finally:

        connection.close()


# ============================================================
# ADMIN COMMANDS
# ============================================================

def admin_command(
    message
):

    sender_id = int(
        message.get(
            "from",
            {}
        ).get(
            "id",
            0
        )
    )

    if sender_id != ADMIN_ID:
        return False

    text = message.get(
        "text",
        ""
    ).strip()

    if not text.startswith("/"):
        return False

    parts = text.split()

    command = parts[0].split("@")[0].lower()

    # --------------------------------------------------------
    # LOCK
    # --------------------------------------------------------

    if command == "/withdraw_lock":

        set_setting(
            "withdrawal_enabled",
            "false"
        )

        send_message(
            ADMIN_ID,
            "Withdrawals LOCKED."
        )

        return True

    # --------------------------------------------------------
    # UNLOCK
    # --------------------------------------------------------

    if command == "/withdraw_unlock":

        set_setting(
            "withdrawal_enabled",
            "true"
        )

        send_message(
            ADMIN_ID,
            "Withdrawals OPEN."
        )

        return True

    # --------------------------------------------------------
    # AD REWARD
    # --------------------------------------------------------

    if command == "/set_ad_reward":

        if len(parts) < 2:

            send_message(
                ADMIN_ID,
                "Usage: /set_ad_reward 0.50"
            )

            return True

        set_setting(
            "ad_reward",
            parts[1]
        )

        send_message(
            ADMIN_ID,
            f"Ad reward = {parts[1]} ETB"
        )

        return True

    # --------------------------------------------------------
    # REFERRAL REWARD
    # --------------------------------------------------------

    if command == "/set_ref_reward":

        if len(parts) < 2:

            send_message(
                ADMIN_ID,
                "Usage: /set_ref_reward 1"
            )

            return True

        set_setting(
            "referral_reward",
            parts[1]
        )

        send_message(
            ADMIN_ID,
            f"Referral reward = {parts[1]} ETB"
        )

        return True

    # --------------------------------------------------------
    # REQUIRED REFERRALS
    # --------------------------------------------------------

    if command == "/set_ref_required":

        if len(parts) < 2:

            send_message(
                ADMIN_ID,
                "Usage: /set_ref_required 10"
            )

            return True

        set_setting(
            "referral_required",
            parts[1]
        )

        send_message(
            ADMIN_ID,
            f"Required referrals = {parts[1]}"
        )

        return True

    # --------------------------------------------------------
    # MINIMUM WITHDRAW
    # --------------------------------------------------------

    if command == "/set_min_withdraw":

        if len(parts) < 2:

            send_message(
                ADMIN_ID,
                "Usage: /set_min_withdraw 10"
            )

            return True

        set_setting(
            "min_withdraw",
            parts[1]
        )

        send_message(
            ADMIN_ID,
            f"Minimum withdrawal = {parts[1]} ETB"
        )

        return True

    # --------------------------------------------------------
    # DAILY LIMITS
    # --------------------------------------------------------

    if command == "/set_limits":

        if len(parts) < 4:

            send_message(
                ADMIN_ID,
                "Usage: /set_limits 10 15 20"
            )

            return True

        set_setting(
            "daily_limit_1",
            parts[1]
        )

        set_setting(
            "daily_limit_2",
            parts[2]
        )

        set_setting(
            "daily_limit_3",
            parts[3]
        )

        send_message(
            ADMIN_ID,
            (
                "Daily limits updated:\n\n"
                f"Level 1: {parts[1]}\n"
                f"Level 2: {parts[2]}\n"
                f"Level 3: {parts[3]}"
            )
        )

        return True

    # --------------------------------------------------------
    # SPIN
    # --------------------------------------------------------

    if command == "/set_spin":

        if len(parts) < 3:

            send_message(
                ADMIN_ID,
                "Usage: /set_spin 2 10"
            )

            return True

        set_setting(
            "spin_price",
            parts[1]
        )

        set_setting(
            "spin_spins",
            parts[2]
        )

        send_message(
            ADMIN_ID,
            (
                "Spin settings updated.\n\n"
                f"Price: {parts[1]} ETB\n"
                f"Spins: {parts[2]}"
            )
        )

        return True

    # --------------------------------------------------------
    # SET CHANNEL
    # --------------------------------------------------------

    if command == "/setchannel":

        if len(parts) < 4:

            send_message(

                ADMIN_ID,

                (
                    "Usage:\n\n"
                    "/setchannel 1 @channel "
                    "https://t.me/channel "
                    "Channel Title"
                )
            )

            return True

        number = parts[1]

        channel_id = parts[2]

        channel_url = parts[3]

        title = (
            " ".join(parts[4:])
            if len(parts) > 4
            else f"Channel {number}"
        )

        set_setting(
            f"channel_{number}_id",
            channel_id
        )

        set_setting(
            f"channel_{number}_url",
            channel_url
        )

        set_setting(
            f"channel_{number}_title",
            title
        )

        send_message(

            ADMIN_ID,

            (
                f"Channel {number} updated.\n\n"

                f"ID: {channel_id}\n"
                f"URL: {channel_url}\n"
                f"Title: {title}"
            )
        )

        return True

    # --------------------------------------------------------
    # STATS
    # --------------------------------------------------------

    if command == "/stats":

        connection = db()

        try:

            cursor = connection.cursor()

            cursor.execute(
                "SELECT COUNT(*) FROM users"
            )

            users = cursor.fetchone()[0]

            cursor.execute("""
                SELECT COUNT(*)

                FROM referrals

                WHERE qualified=TRUE
            """)

            qualified = cursor.fetchone()[0]

            cursor.execute("""
                SELECT COALESCE(
                    SUM(amount),
                    0
                )

                FROM withdrawals

                WHERE status='paid'
            """)

            paid = cursor.fetchone()[0]

        finally:

            connection.close()

        send_message(

            ADMIN_ID,

            (
                "ADEWA STATISTICS\n\n"

                f"Users: {users}\n"

                f"Qualified referrals: "
                f"{qualified}\n"

                f"Paid withdrawals: "
                f"{paid} ETB"
            )
        )

        return True

    return False


# ============================================================
# /START + REFERRAL
# ============================================================

def handle_start(
    message
):

    telegram_user = message.get(
        "from",
        {}
    )

    telegram_id = int(
        telegram_user["id"]
    )

    save_user(
        telegram_user
    )

    text = message.get(
        "text",
        ""
    )

    parts = text.split(
        maxsplit=1
    )

    # --------------------------------------------------------
    # REFERRAL
    # --------------------------------------------------------

    if len(parts) > 1:

        parameter = parts[1].strip()

        if parameter.startswith(
            "ref_"
        ):

            try:

                inviter_id = int(
                    parameter[4:]
                )

                create_referral(
                    inviter_id,
                    telegram_id
                )

            except Exception:
                pass

    # --------------------------------------------------------
    # MINI APP BUTTON
    # --------------------------------------------------------

    keyboard = None

    if WEBAPP_URL:

        keyboard = {

            "inline_keyboard": [

                [

                    {
                        "text":
                            "Open Adewa",

                        "web_app": {
                            "url":
                                WEBAPP_URL
                        }
                    }
                ]
            ]
        }

    send_message(

        telegram_id,

        (
            "Welcome to Adewa.\n\n"

            "Open the Mini App to "
            "watch ads, complete tasks, "
            "refer users and withdraw."
        ),

        keyboard
    )


# ============================================================
# TELEGRAM WEBHOOK
# ============================================================

@app.post("/telegram/webhook")
def telegram_webhook():

    if WEBHOOK_SECRET:

        incoming_secret = request.headers.get(
            "X-Telegram-Bot-Api-Secret-Token",
            ""
        )

        if not hmac.compare_digest(
            incoming_secret,
            WEBHOOK_SECRET
        ):

            return jsonify({
                "ok": False
            }), 403

    update = request.get_json(
        silent=True
    ) or {}

    try:

        ensure_database()

        # ----------------------------------------------------
        # BUTTON
        # ----------------------------------------------------

        if "callback_query" in update:

            handle_callback(
                update["callback_query"]
            )

        # ----------------------------------------------------
        # MESSAGE
        # ----------------------------------------------------

        elif "message" in update:

            message = update["message"]

            sender_id = int(
                message.get(
                    "from",
                    {}
                ).get(
                    "id",
                    0
                )
            )

            # Admin payment proof
            if (
                sender_id == ADMIN_ID
                and message.get("photo")
            ):

                process_admin_photo(
                    message
                )

            elif message.get("text"):

                text = message["text"]

                if text.startswith(
                    "/start"
                ):

                    handle_start(
                        message
                    )

                elif sender_id == ADMIN_ID:

                    admin_command(
                        message
                    )

        return jsonify({
            "ok": True
        })

    except Exception as error:

        print(
            "Webhook error:",
            error
        )

        # Always return 200 to Telegram
        return jsonify({
            "ok": True
        })


# ============================================================
# HEALTH CHECK
# ============================================================

@app.get("/health")
def health():

    return jsonify({

        "ok": True,

        "service":
            "Adewa",

        "status":
            "online"
    })


# ============================================================
# LOCAL SERVER
# ============================================================

if __name__ == "__main__":

    ensure_database()

    app.run(

        host="0.0.0.0",

        port=int(
            os.getenv(
                "PORT",
                "5000"
            )
        ),

        debug=False
    )
