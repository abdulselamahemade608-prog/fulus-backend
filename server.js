
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

/* =========================================================
   CONFIG
========================================================= */
const app = express();
const PORT = Number(process.env.PORT || 3000);

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME || "AdewaBot";
const DATABASE_URL = process.env.DATABASE_URL;

// የአንተ ቋሚ Admin Telegram ID
const ADMIN_TELEGRAM_ID = 8845432223;

const REQUIRED_CHANNEL_USERNAME = process.env.REQUIRED_CHANNEL || "@proof_chnallel";
const PROOF_CHANNEL_ID = process.env.PROOF_CHANNEL_ID || "@proof_chnallel"; // ፎቶ የሚለጠፍበት ቻናል

/* =========================================================
   DATABASE POOL
========================================================= */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

/* =========================================================
   MIDDLEWARE & CORS
========================================================= */
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      const allowed = [
        process.env.FRONTEND_URL,
        "https://telegram.org",
        "https://web.telegram.org"
      ].filter(Boolean);

      if (allowed.includes(origin)) return callback(null, true);
      if (origin.startsWith("https://abdulselamahemade608-prog.github.io")) {
        return callback(null, true);
      }
      return callback(null, true); // CORS bypass for Telegram Mini App webviews
    },
    credentials: false
  })
);

app.use(express.json({ limit: "150kb" }));

/* =========================================================
   TELEGRAM BOT API HELPER
========================================================= */
async function telegramApi(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.description || "Telegram API error.");
  return data.result;
}

// ቻናል ውስጥ መኖራቸውን በቅጽበት ማረጋገጫ
async function checkChannelMembership(telegramId, channel) {
  try {
    const member = await telegramApi("getChatMember", {
      chat_id: channel,
      user_id: telegramId
    });
    return (
      ["creator", "administrator", "member"].includes(member.status) ||
      (member.status === "restricted" && member.is_member === true)
    );
  } catch (error) {
    console.error(`Membership check failed for ${telegramId}:`, error.message);
    return false;
  }
}

/* =========================================================
   TELEGRAM INIT DATA AUTH
========================================================= */
function validateTelegramInitData(initData) {
  if (!initData || !BOT_TOKEN) throw new Error("Missing Telegram credentials.");

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) throw new Error("Hash missing.");

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calculatedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const received = Buffer.from(receivedHash, "hex");
  const calculated = Buffer.from(calculatedHash, "hex");

  if (received.length !== calculated.length || !crypto.timingSafeEqual(received, calculated)) {
    throw new Error("Invalid authentication signature.");
  }

  const userRaw = params.get("user");
  if (!userRaw) throw new Error("Telegram user not found.");

  return {
    user: JSON.parse(userRaw),
    startParam: params.get("start_param") || null
  };
}

async function authenticate(req, res, next) {
  try {
    const initData = req.headers["x-telegram-init-data"];
    const auth = validateTelegramInitData(initData);
    await upsertUser(auth.user, auth.startParam);
    req.telegramUser = auth.user;
    next();
  } catch (error) {
    return res.status(401).json({ ok: false, message: error.message || "Auth failed." });
  }
}

async function adminOnly(req, res, next) {
  try {
    const initData = req.headers["x-telegram-init-data"];
    const auth = validateTelegramInitData(initData);
    if (Number(auth.user.id) !== ADMIN_TELEGRAM_ID) {
      return res.status(403).json({ ok: false, message: "Access denied: Admin only." });
    }
    req.telegramUser = auth.user;
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, message: "Unauthorized." });
  }
}

/* =========================================================
   USER CREATION & REFERRAL REGISTRATION
========================================================= */
async function upsertUser(tgUser, startParam) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(`SELECT telegram_id FROM users WHERE telegram_id = $1`, [tgUser.id]);

    if (existing.rowCount === 0) {
      const referralCode = crypto.createHash("sha256").update(`${tgUser.id}:${Date.now()}`).digest("hex").slice(0, 8).toUpperCase();
      await client.query(
        `INSERT INTO users (telegram_id, username, first_name, last_name, photo_url, referral_code)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tgUser.id, tgUser.username || null, tgUser.first_name || null, tgUser.last_name || null, tgUser.photo_url || null, referralCode]
      );

      // Referral link registration (ref_CODE)
      if (startParam && String(startParam).startsWith("ref_")) {
        const refCode = String(startParam).slice(4).trim().toUpperCase();
        const refRes = await client.query(`SELECT telegram_id FROM users WHERE referral_code = $1`, [refCode]);
        if (refRes.rowCount > 0 && String(refRes.rows[0].telegram_id) !== String(tgUser.id)) {
          const referrerId = refRes.rows[0].telegram_id;
          await client.query(
            `INSERT INTO referrals (referrer_id, referred_id, reward_paid) VALUES ($1, $2, FALSE)
             ON CONFLICT (referred_id) DO NOTHING`,
            [referrerId, tgUser.id]
          );
          await client.query(`UPDATE users SET referred_by = $2 WHERE telegram_id = $1`, [tgUser.id, referrerId]);
        }
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/* =========================================================
   GET SETTING HELPER
========================================================= */
async function getSetting(key, fallback) {
  try {
    const res = await pool.query(`SELECT value FROM settings WHERE key = $1`, [key]);
    if (res.rowCount === 0) return fallback;
    return res.rows[0].value;
  } catch {
    return fallback;
  }
}

/* =========================================================
   ROUTES: USER PROFILE & APP STATE (/api/me)
========================================================= */
app.get("/api/me", authenticate, async (req, res) => {
  try {
    const telegramId = req.telegramUser.id;

    // 1. User Info
    const userRes = await pool.query(`SELECT * FROM users WHERE telegram_id = $1`, [telegramId]);
    const user = userRes.rows[0];

    // 2. Today's Ads
    const adsRes = await pool.query(
      `SELECT count FROM daily_ads WHERE telegram_id = $1 AND ad_date = CURRENT_DATE`,
      [telegramId]
    );
    const todayAds = adsRes.rowCount > 0 ? Number(adsRes.rows[0].count) : 0;

    // 3. Channel Status
    const isChannelJoined = await checkChannelMembership(telegramId, REQUIRED_CHANNEL_USERNAME);

    // 4. Tasks (Exclude completed channel tasks if already joined)
    const tasksRes = await pool.query(
      `SELECT t.*, COALESCE(tc.completed, FALSE) as completed
       FROM tasks t
       LEFT JOIN task_completions tc ON tc.task_id = t.id AND tc.telegram_id = $1
       WHERE t.active = TRUE ORDER BY t.sort_order ASC, t.created_at ASC`,
      [telegramId]
    );

    // 5. Active Referral Tracker (Day 1, Day 2 & Channel)
    const refUsersRes = await pool.query(
      `SELECT u.telegram_id, u.first_name, u.username, u.created_at
       FROM referrals r
       JOIN users u ON u.telegram_id = r.referred_id
       WHERE r.referrer_id = $1`,
      [telegramId]
    );

    let qualifiedCount = 0;
    const referralsList = [];

    for (const ref of refUsersRes.rows) {
      // Day 1 = Registration date, Day 2 = Registration date + 1 day
      const d1Res = await pool.query(
        `SELECT count FROM daily_ads WHERE telegram_id = $1 AND ad_date = $2::date`,
        [ref.telegram_id, ref.created_at]
      );
      const d2Res = await pool.query(
        `SELECT count FROM daily_ads WHERE telegram_id = $1 AND ad_date = ($2::date + INTERVAL '1 day')::date`,
        [ref.telegram_id, ref.created_at]
      );

      const day1Ads = d1Res.rowCount > 0 ? Number(d1Res.rows[0].count) : 0;
      const day2Ads = d2Res.rowCount > 0 ? Number(d2Res.rows[0].count) : 0;
      const channelJoined = await checkChannelMembership(ref.telegram_id, REQUIRED_CHANNEL_USERNAME);

      const isQualified = day1Ads >= 30 && day2Ads >= 30 && channelJoined;
      if (isQualified) qualifiedCount++;

      referralsList.push({
        telegramId: ref.telegram_id,
        firstName: ref.first_name,
        username: ref.username,
        day1Ads,
        day2Ads,
        channelJoined
      });
    }

    // 6. Settings & History
    const minWithdraw = Number(await getSetting("min_withdraw", "100"));
    const refReward = Number(await getSetting("referral_reward", "5"));

    const historyRes = await pool.query(
      `SELECT id, amount, method, status, created_at FROM withdrawals WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [telegramId]
    );

    res.json({
      ok: true,
      user: {
        id: user.telegram_id,
        username: user.username,
        firstName: user.first_name,
        referralCode: user.referral_code,
        botUsername: BOT_USERNAME
      },
      balance: Number(user.balance),
      todayAds,
      maxAdsDaily: 30,
      adReward: 0.50,
      referralReward: refReward,
      isChannelJoined,
      qualifiedReferralsCount: qualifiedCount,
      referralsList,
      tasks: tasksRes.rows.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        icon: t.icon,
        type: t.type,
        reward: Number(t.reward),
        url: t.url,
        completed: t.completed
      })),
      withdrawalHistory: historyRes.rows,
      settings: { min_withdraw: minWithdraw, referral_reward: refReward }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Could not fetch user details." });
  }
});

/* =========================================================
   ROUTES: MONETAG REWARD CLAIM (/api/ads/reward)
========================================================= */
app.post("/api/ads/reward", authenticate, async (req, res) => {
  const telegramId = req.telegramUser.id;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Quota Verification
    const adsRes = await client.query(
      `SELECT count FROM daily_ads WHERE telegram_id = $1 AND ad_date = CURRENT_DATE FOR UPDATE`,
      [telegramId]
    );

    let count = 0;
    if (adsRes.rowCount > 0) {
      count = Number(adsRes.rows[0].count);
    }

    if (count >= 30) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, message: "Daily quota of 30 ads reached." });
    }

    // Increment Ads Count
    await client.query(
      `INSERT INTO daily_ads (telegram_id, ad_date, count) VALUES ($1, CURRENT_DATE, 1)
       ON CONFLICT (telegram_id, ad_date) DO UPDATE SET count = daily_ads.count + 1`,
      [telegramId]
    );

    // Credit Balance (+0.50 ETB)
    const adReward = 0.50;
    const userRes = await client.query(
      `SELECT balance FROM users WHERE telegram_id = $1 FOR UPDATE`,
      [telegramId]
    );
    const before = Number(userRes.rows[0].balance);
    const after = before + adReward;

    await client.query(
      `UPDATE users SET balance = $2, total_earned = total_earned + $3, updated_at = NOW() WHERE telegram_id = $1`,
      [telegramId, after, adReward]
    );

    await client.query(
      `INSERT INTO transactions (telegram_id, type, amount, balance_before, balance_after, reference, description)
       VALUES ($1, 'ad_reward', $2, $3, $4, $5, 'Watched Monetag Rewarded Ad')`,
      [telegramId, adReward, before, after, `ad_${Date.now()}`]
    );

    await client.query("COMMIT");
    res.json({ ok: true, balance: after, todayAds: count + 1 });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ ok: false, message: "Ad reward failed." });
  } finally {
    client.release();
  }
});

/* =========================================================
   ROUTES: TASK VERIFICATION (/api/tasks/:id/verify)
========================================================= */
app.post("/api/tasks/:id/verify", authenticate, async (req, res) => {
  const taskId = req.params.id;
  const telegramId = req.telegramUser.id;

  // 1. Check if it's the mandatory channel task
  if (taskId === "mandatory-channel") {
    const isMember = await checkChannelMembership(telegramId, REQUIRED_CHANNEL_USERNAME);
    if (!isMember) {
      return res.status(400).json({ ok: false, message: "You have not joined the official channel yet!" });
    }
    return res.json({ ok: true, message: "Channel membership verified successfully!" });
  }

  // 2. Standard DB tasks
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const taskRes = await client.query(`SELECT * FROM tasks WHERE id = $1 AND active = TRUE`, [taskId]);
    if (taskRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, message: "Task not found." });
    }

    const task = taskRes.rows[0];

    // If task is channel type
    if (task.type === "channel" && task.channel_username) {
      const isMember = await checkChannelMembership(telegramId, task.channel_username);
      if (!isMember) {
        await client.query("ROLLBACK");
        return res.status(400).json({ ok: false, message: "Please join the channel first." });
      }
    }

    // Grant reward & mark completion
    const reward = Number(task.reward);
    const uRes = await client.query(`SELECT balance FROM users WHERE telegram_id = $1 FOR UPDATE`, [telegramId]);
    const before = Number(uRes.rows[0].balance);
    const after = before + reward;

    await client.query(
      `INSERT INTO task_completions (task_id, telegram_id, completed) VALUES ($1, $2, TRUE)
       ON CONFLICT (task_id, telegram_id) DO NOTHING`,
      [taskId, telegramId]
    );

    await client.query(`UPDATE users SET balance = $2, total_earned = total_earned + $3 WHERE telegram_id = $1`, [
      telegramId,
      after,
      reward
    ]);

    await client.query("COMMIT");
    res.json({ ok: true, message: `Task complete! +${reward} ETB earned.` });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ ok: false, message: err.message });
  } finally {
    client.release();
  }
});

/* =========================================================
   ROUTES: PROMO CODE REDEEM (/api/promo/redeem)
========================================================= */
app.post("/api/promo/redeem", authenticate, async (req, res) => {
  const telegramId = req.telegramUser.id;
  const code = String(req.body.code || "").trim().toUpperCase();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pRes = await client.query(`SELECT * FROM promo_codes WHERE code = $1 AND active = TRUE FOR UPDATE`, [code]);
    if (pRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, message: "Invalid promo code." });
    }

    const promo = pRes.rows[0];
    const redRes = await client.query(`SELECT id FROM promo_redemptions WHERE code = $1 AND telegram_id = $2`, [code, telegramId]);
    if (redRes.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, message: "You already redeemed this code." });
    }

    const reward = Number(promo.reward);
    const uRes = await client.query(`SELECT balance FROM users WHERE telegram_id = $1 FOR UPDATE`, [telegramId]);
    const after = Number(uRes.rows[0].balance) + reward;

    await client.query(`UPDATE users SET balance = $2 WHERE telegram_id = $1`, [telegramId, after]);
    await client.query(`INSERT INTO promo_redemptions (code, telegram_id) VALUES ($1, $2)`, [code, telegramId]);
    await client.query(`UPDATE promo_codes SET used_count = used_count + 1 WHERE code = $1`, [code]);

    await client.query("COMMIT");
    res.json({ ok: true, message: `Promo applied! +${reward} ETB credited.` });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ ok: false, message: "Failed to redeem promo." });
  } finally {
    client.release();
  }
});

/* =========================================================
   ROUTES: SPIN WHEEL (/api/wheel/spin)
========================================================= */
app.post("/api/wheel/spin", authenticate, async (req, res) => {
  const telegramId = req.telegramUser.id;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1 spin per 10 ads watched today
    const adsRes = await client.query(
      `SELECT count FROM daily_ads WHERE telegram_id = $1 AND ad_date = CURRENT_DATE`,
      [telegramId]
    );
    const todayAds = adsRes.rowCount > 0 ? Number(adsRes.rows[0].count) : 0;
    const allowedSpins = Math.floor(todayAds / 10);

    const spinRes = await client.query(
      `SELECT spins_used FROM wheel_spins WHERE telegram_id = $1 AND spin_date = CURRENT_DATE FOR UPDATE`,
      [telegramId]
    );
    const used = spinRes.rowCount > 0 ? Number(spinRes.rows[0].spins_used) : 0;

    if (used >= allowedSpins) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        message: `No spins remaining. Watch ${10 - (todayAds % 10)} more ads to get 1 spin!`
      });
    }

    // Random Spin Reward (0.20, 0.50, or 1.00 ETB)
    const rewards = [0.20, 0.50, 0.50, 1.00];
    const prize = rewards[Math.floor(Math.random() * rewards.length)];

    await client.query(
      `INSERT INTO wheel_spins (telegram_id, spin_date, spins_used) VALUES ($1, CURRENT_DATE, 1)
       ON CONFLICT (telegram_id, spin_date) DO UPDATE SET spins_used = wheel_spins.spins_used + 1`,
      [telegramId]
    );

    const uRes = await client.query(`SELECT balance FROM users WHERE telegram_id = $1 FOR UPDATE`, [telegramId]);
    const after = Number(uRes.rows[0].balance) + prize;
    await client.query(`UPDATE users SET balance = $2 WHERE telegram_id = $1`, [telegramId, after]);

    await client.query("COMMIT");
    res.json({ ok: true, message: `🎡 Lucky Win! You received +${prize} ETB.` });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ ok: false, message: "Spin failed." });
  } finally {
    client.release();
  }
});

/* =========================================================
   ROUTES: WITHDRAWAL REQUEST (/api/withdraw)
========================================================= */
app.post("/api/withdraw", authenticate, async (req, res) => {
  const telegramId = req.telegramUser.id;
  const amount = Number(req.body.amount);
  const method = String(req.body.method || "").toLowerCase();
  const account = String(req.body.account || "").trim();

  const minWithdraw = Number(await getSetting("min_withdraw", "100"));

  if (!amount || amount < minWithdraw) {
    return res.status(400).json({ ok: false, message: `Minimum withdrawal is ${minWithdraw} ETB.` });
  }

  // 1. Verify Official Channel Active Membership
  const isChannelJoined = await checkChannelMembership(telegramId, REQUIRED_CHANNEL_USERNAME);
  if (!isChannelJoined) {
    return res.status(400).json({ ok: false, message: "You must join and remain in our official channel!" });
  }

  // 2. Verify 10 Fully Qualified Referrals (2 full days ads + channel)
  const refUsersRes = await pool.query(
    `SELECT u.telegram_id, u.created_at FROM referrals r
     JOIN users u ON u.telegram_id = r.referred_id WHERE r.referrer_id = $1`,
    [telegramId]
  );

  let qualifiedCount = 0;
  for (const ref of refUsersRes.rows) {
    const d1 = await pool.query(
      `SELECT count FROM daily_ads WHERE telegram_id = $1 AND ad_date = $2::date`,
      [ref.telegram_id, ref.created_at]
    );
    const d2 = await pool.query(
      `SELECT count FROM daily_ads WHERE telegram_id = $1 AND ad_date = ($2::date + INTERVAL '1 day')::date`,
      [ref.telegram_id, ref.created_at]
    );

    const d1Count = d1.rowCount > 0 ? Number(d1.rows[0].count) : 0;
    const d2Count = d2.rowCount > 0 ? Number(d2.rows[0].count) : 0;
    const chMember = await checkChannelMembership(ref.telegram_id, REQUIRED_CHANNEL_USERNAME);

    if (d1Count >= 30 && d2Count >= 30 && chMember) {
      qualifiedCount++;
    }
  }
let qualifiedCount = 0;
for (const ref of refUsersRes.rows) {
}

if (qualifiedCount < 0) {
  return res.status(400).json({
    ok: false,
    message: `You need 10 qualified referrals. Currently qualified: ${qualifiedCount}/10`
  });
}


  // 3. Process Balance Reservation
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const uRes = await client.query(`SELECT balance FROM users WHERE telegram_id = $1 FOR UPDATE`, [telegramId]);
    const balance = Number(uRes.rows[0].balance);

    if (amount > balance) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, message: "Insufficient balance." });
    }

    const after = balance - amount;
    await client.query(`UPDATE users SET balance = $2 WHERE telegram_id = $1`, [telegramId, after]);

    const withdrawalId = crypto.randomUUID();
    await client.query(
      `INSERT INTO withdrawals (id, telegram_id, amount, method, account_number, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [withdrawalId, telegramId, amount, method, account]
    );

    await client.query("COMMIT");

    // Telegram Bot Alert to Admin
    try {
      await telegramApi("sendMessage", {
        chat_id: ADMIN_TELEGRAM_ID,
        text: `🔔 *New Withdrawal Request!*\n\n` +
              `👤 User ID: \`${telegramId}\`\n` +
              `💰 Amount: *${amount} ETB*\n` +
              `🏦 Method: *${method.toUpperCase()}*\n` +
              `📱 Account: \`${account}\`\n` +
              `👥 Qualified Referrals: *${qualifiedCount}/10*\n\n` +
              `Open Admin Panel to approve with screenshot.`,
        parse_mode: "Markdown"
      });
    } catch (e) {
      console.error("Admin telegram alert error:", e.message);
    }

    res.json({ ok: true, message: "Withdrawal request submitted for review." });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ ok: false, message: err.message });
  } finally {
    client.release();
  }
});

/* =========================================================
   ROUTES: ADMIN CONTROLS (ONLY FOR ADMIN_TELEGRAM_ID)
========================================================= */
app.get("/api/admin/dashboard", adminOnly, async (req, res) => {
  try {
    const listRes = await pool.query(
      `SELECT w.*, u.username, u.first_name FROM withdrawals w
       JOIN users u ON u.telegram_id = w.telegram_id
       WHERE w.status = 'pending' ORDER BY w.created_at DESC`
    );
    res.json({ ok: true, pendingWithdrawals: listRes.rows });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Approve With Screenshot Proof & Auto-Post to Proof Channel
app.post("/api/admin/withdrawals/:id/approve-with-proof", adminOnly, async (req, res) => {
  const { id } = req.params;
  const { screenshotUrl, transactionId } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const wRes = await client.query(`SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE`, [id]);
    if (wRes.rowCount === 0) throw new Error("Withdrawal not found.");

    const w = wRes.rows[0];
    if (w.status !== "pending") throw new Error("Already processed.");

    await client.query(
      `UPDATE withdrawals SET status = 'paid', admin_note = $2, processed_at = NOW() WHERE id = $1`,
      [id, `TxRef: ${transactionId || "N/A"}`]
    );
    await client.query(
      `UPDATE users SET total_withdrawn = total_withdrawn + $2 WHERE telegram_id = $1`,
      [w.telegram_id, w.amount]
    );

    await client.query("COMMIT");

    // Auto-Post Screenshot Proof to Telegram Proof Channel
    try {
      await telegramApi("sendPhoto", {
        chat_id: PROOF_CHANNEL_ID,
        photo: screenshotUrl,
        caption: `✅ *Withdrawal Successful / ክፍያ ተፈጽሟል*\n\n` +
                 `👤 User: \`${w.telegram_id}\`\n` +
                 `💵 Amount: *${w.amount} ETB*\n` +
                 `💳 Method: *${w.method.toUpperCase()}*\n` +
                 `🧾 Ref ID: \`${transactionId || "CONFIRMED"}\`\n\n` +
                 `🎉 Join @AdewaBot to start earning daily!`,
        parse_mode: "Markdown"
      });
    } catch (postErr) {
      console.error("Proof channel post failed:", postErr.message);
    }

    res.json({ ok: true, message: "Approved & posted to proof channel!" });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ ok: false, message: err.message });
  } finally {
    client.release();
  }
});

app.post("/api/admin/withdrawals/:id/reject", adminOnly, async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const wRes = await client.query(`SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE`, [id]);
    const w = wRes.rows[0];

    // Refund reserved balance
    await client.query(`UPDATE users SET balance = balance + $2 WHERE telegram_id = $1`, [w.telegram_id, w.amount]);
    await client.query(`UPDATE withdrawals SET status = 'rejected', processed_at = NOW() WHERE id = $1`, [id]);

    await client.query("COMMIT");
    res.json({ ok: true, message: "Withdrawal rejected and balance refunded." });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ ok: false, message: err.message });
  } finally {
    client.release();
  }
});

// Update Settings
app.post("/api/admin/settings", adminOnly, async (req, res) => {
  const { referral_reward, min_withdraw } = req.body;
  try {
    if (referral_reward) {
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ('referral_reward', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [String(referral_reward)]
      );
    }
    if (min_withdraw) {
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ('min_withdraw', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [String(min_withdraw)]
      );
    }
    res.json({ ok: true, message: "Settings updated." });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Create Task without code
app.post("/api/admin/tasks", adminOnly, async (req, res) => {
  const { title, url, reward, type } = req.body;
  try {
    await pool.query(
      `INSERT INTO tasks (id, title, url, reward, type) VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
      [title, url, Number(reward || 1), type || "visit"]
    );
    res.json({ ok: true, message: "Task published." });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Create Promo Code
app.post("/api/admin/promo", adminOnly, async (req, res) => {
  const { code, reward } = req.body;
  try {
    await pool.query(
      `INSERT INTO promo_codes (code, reward) VALUES ($1, $2)
       ON CONFLICT (code) DO UPDATE SET reward = $2, active = TRUE`,
      [String(code).trim().toUpperCase(), Number(reward || 5)]
    );
    res.json({ ok: true, message: "Promo voucher created." });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/* =========================================================
   SERVER BOOT
========================================================= */
app.listen(PORT, () => {
  console.log(`Adewa backend online on port ${PORT}`);
});

module.exports = app;
