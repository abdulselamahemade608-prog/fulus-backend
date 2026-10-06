const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');

const BOT = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME;            // without @
const ADMIN = String(process.env.ADMIN_ID);
const APP_URL = process.env.WEBAPP_URL;                   // https://your-app.vercel.app
const WH_SECRET = process.env.WEBHOOK_SECRET;
const AD_SECRET = process.env.ADSGRAM_SECRET;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const q = (t, p) => pool.query(t, p).then(r => r.rows);
const tg = (m, b) => fetch(`https://api.telegram.org/bot${BOT}/${m}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b)
}).then(r => r.json()).catch(() => ({}));

const app = express();
app.use(express.json());

/* ---------- helpers ---------- */
async function upsertUser(u, ref) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
  await q(`INSERT INTO users(id,name,username,photo,referred_by) VALUES($1,$2,$3,$4,$5)
           ON CONFLICT (id) DO UPDATE SET name=$2, username=$3, photo=COALESCE($4,users.photo)`,
    [u.id, name, u.username || null, u.photo_url || null, ref && ref != u.id ? ref : null]);
}

async function missingChannels(uid) {
  const chans = await q('SELECT * FROM channels ORDER BY id');
  const out = [];
  for (const c of chans) {
    const r = await tg('getChatMember', { chat_id: c.chat_id, user_id: uid });
    const st = r.result && r.result.status;
    if (!['member', 'administrator', 'creator'].includes(st)) out.push(c);
  }
  return out;
}

// marks verified + credits the referrer once
async function syncVerify(uid, missing) {
  if (missing.length) { await q('UPDATE users SET verified=false WHERE id=$1', [uid]); return; }
  await q('UPDATE users SET verified=true, verified_at=COALESCE(verified_at,now()) WHERE id=$1', [uid]);
  const r = await q('UPDATE users SET credited=true WHERE id=$1 AND credited=false RETURNING referred_by', [uid]);
  if (r[0] && r[0].referred_by) await q('UPDATE users SET invites=invites+1 WHERE id=$1', [r[0].referred_by]);
}

const settings = async () => Object.fromEntries((await q('SELECT * FROM settings')).map(s => [s.key, s.value]));

function auth(req, res, next) {
  try {
    const p = new URLSearchParams(req.headers['x-init'] || '');
    const hash = p.get('hash'); p.delete('hash');
    const str = [...p.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${k}=${v}`).join('\n');
    const key = crypto.createHmac('sha256', 'WebAppData').update(BOT).digest();
    if (crypto.createHmac('sha256', key).update(str).digest('hex') !== hash) throw 0;
    req.user = JSON.parse(p.get('user'));
    next();
  } catch { res.status(401).json({ error: 'unauthorized' }); }
}
const admin = (req, res, next) => String(req.user.id) === ADMIN ? next() : res.status(403).json({ error: 'forbidden' });

/* ---------- Telegram webhook ---------- */
app.post('/api/webhook/:s', async (req, res) => {
  res.sendStatus(200);
  if (req.params.s !== WH_SECRET) return;
  const u = req.body;
  try {
    if (u.message && u.message.text && u.message.text.startsWith('/start')) {
      const m = u.message, ref = parseInt((m.text.split(' ')[1] || '').replace('ref_', '')) || null;
      await upsertUser(m.from, ref);
      const chans = await q('SELECT * FROM channels ORDER BY id');
      const kb = chans.map(c => [{ text: '📢 ' + c.title, url: c.url }]);
      kb.push([{ text: '✅ JOINED', callback_data: 'joined' }]);
      await tg('sendMessage', {
        chat_id: m.chat.id,
        text: `👋 Welcome ${m.from.first_name}!\n\nℹ️ Complete the steps below to start win Reward.\n\n⭐ Join all required channels.\n\n📢 Then verify your membership.`,
        reply_markup: { inline_keyboard: kb }
      });
    }
    if (u.callback_query && u.callback_query.data === 'joined') {
      const cq = u.callback_query, uid = cq.from.id;
      await upsertUser(cq.from);
      const miss = await missingChannels(uid);
      await syncVerify(uid, miss);
      if (miss.length) {
        return tg('answerCallbackQuery', { callback_query_id: cq.id, show_alert: true,
          text: '❌ Please join: ' + miss.map(c => c.title).join(', ') });
      }
      await tg('answerCallbackQuery', { callback_query_id: cq.id });
      await tg('sendMessage', {
        chat_id: uid, text: '✅ Verified! Tap below to open the Mini App.',
        reply_markup: { inline_keyboard: [[{ text: '🚀 Open Mini App', web_app: { url: APP_URL } }]] }
      });
    }
  } catch (e) { console.error(e); }
});

/* ---------- Adsgram server-side reward callback ----------
   Adsgram block "Reward URL":  https://YOUR-APP.vercel.app/api/reward?userid=[userId]&secret=YOUR_ADSGRAM_SECRET */
app.get('/api/reward', async (req, res) => {
  const uid = parseInt(req.query.userid);
  if (!uid || req.query.secret !== AD_SECRET) return res.sendStatus(403);
  await q('INSERT INTO ads_log(user_id) SELECT id FROM users WHERE id=$1', [uid]);
  await q('UPDATE users SET ads=ads+1 WHERE id=$1', [uid]);
  res.sendStatus(200);
});

/* ---------- Mini app API ---------- */
app.get('/api/me', auth, async (req, res) => {
  const uid = req.user.id;
  await upsertUser(req.user);
  const missing = await missingChannels(uid);
  await syncVerify(uid, missing);
  if (missing.length) return res.json({ missing });
  const [me] = await q('SELECT * FROM users WHERE id=$1', [uid]);
  const [{ r }] = await q('SELECT count(*)+1 AS r FROM users WHERE verified AND ads+invites > $1', [me.ads + me.invites]);
  const adsWeek = await q(`SELECT to_char(d,'Dy') lbl, count(a.id)::int c
    FROM generate_series(current_date-6,current_date,'1 day') d
    LEFT JOIN ads_log a ON a.user_id=$1 AND a.created_at::date=d::date GROUP BY d ORDER BY d`, [uid]);
  const invWeek = await q(`SELECT to_char(d,'Dy') lbl, count(u.id)::int c
    FROM generate_series(current_date-6,current_date,'1 day') d
    LEFT JOIN users u ON u.referred_by=$1 AND u.credited AND u.verified_at::date=d::date GROUP BY d ORDER BY d`, [uid]);
  const invited = await q('SELECT id,name,photo,verified FROM users WHERE referred_by=$1 ORDER BY created_at DESC LIMIT 100', [uid]);
  res.json({ missing: [], me, rank: Number(r), adsWeek, invWeek, invited,
    isAdmin: String(uid) === ADMIN, settings: await settings(),
    link: `https://t.me/${BOT_USERNAME}?start=ref_${uid}` });
});

app.get('/api/leaderboard', auth, async (req, res) => {
  res.json(await q(`SELECT id,name,username,photo,ads,invites FROM users WHERE verified
                    ORDER BY ads+invites DESC, id LIMIT 30`));
});

/* ---------- Admin ---------- */
app.get('/api/admin', auth, admin, async (req, res) => {
  const [s] = await q(`SELECT count(*)::int total, count(*) FILTER (WHERE verified)::int verified,
                       coalesce(sum(ads),0)::int ads FROM users`);
  res.json({ stats: s, channels: await q('SELECT * FROM channels ORDER BY id'), settings: await settings() });
});
app.post('/api/admin/settings', auth, admin, async (req, res) => {
  for (const k of ['reward1', 'reward2', 'reward3', 'adsgram_block'])
    if (req.body[k] != null) await q('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [k, String(req.body[k])]);
  res.json({ ok: true });
});
app.post('/api/admin/channel', auth, admin, async (req, res) => {
  const { chat_id, title, url } = req.body;
  if (!chat_id || !title || !url) return res.status(400).json({ error: 'missing' });
  await q('INSERT INTO channels(chat_id,title,url) VALUES($1,$2,$3)', [chat_id, title, url]);
  res.json({ ok: true });
});
app.delete('/api/admin/channel/:id', auth, admin, async (req, res) => {
  await q('DELETE FROM channels WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = app;
