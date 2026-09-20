

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
const BOT_USERNAME = process.env.BOT_USERNAME;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

const ADMIN_TELEGRAM_IDS = (process.env.ADMIN_TELEGRAM_IDS || "")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter(Boolean);

const MIN_WITHDRAW = Number(process.env.MIN_WITHDRAW || 100);
const MIN_ACTIVE_REFERRALS = Number(process.env.MIN_REFERRALS || 10);
const AD_REWARD = 0.50;
const DAILY_AD_LIMIT = 30;
const REFERRAL_REWARD = Number(process.env.REFERRAL_REWARD || 5);
const VISIT_MIN_SECONDS = Number(process.env.VISIT_MIN_SECONDS || 15);

// ዋናው የቴሌግራም ቻናል (Task እና Withdrawal ላይ ግዴታ የሚደረገው)
const OFFICIAL_CHANNEL = String(process.env.OFFICIAL_CHANNEL || "@YOUR_CHANNEL_USERNAME").trim();

/* =========================================================
DATABASE
========================================================= */

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

/* =========================================================
MIDDLEWARE
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

      if (allowed.includes(origin) || origin.startsWith("https://abdulselamahemade608-prog.github.io")) {
        return callback(null, true);
      }
      return callback(new Error("CORS blocked."));
    },
    credentials: false
  })
);

app.use(express.json({ limit: "100kb" }));

/* =========================================================
BASIC ROUTES
========================================================= */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "FulusApp Backend",
    version: "1.2.0",
    status: "online"
  });
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: "connected" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, database: "error" });
  }
});

/* =========================================================
TELEGRAM AUTH VALIDATION
========================================================= */

function validateTelegramInitData(initData) {
  if (!initData || !BOT_TOKEN) {
    throw new Error("የቴሌግራም ማረጋገጫ አልተገኘም።");
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) throw new Error("Telegram hash missing.");

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calculatedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const received = Buffer.from(receivedHash, "hex");
  const calculated = Buffer.from(calculatedHash, "hex");

  if (received.length !== calculated.length || !crypto.timingSafeEqual(received, calculated)) {
    throw new Error("ትክክለኛ ያልሆነ የቴሌግራም መረጃ።");
  }

  const authDate = Number(params.get("auth_date"));
  if (!authDate || !Number.isFinite(authDate)) {
    throw new Error("Invalid Telegram auth date.");
  }

  const age = Math.floor(Date.now() / 1000) - authDate;
  if (age > 86400 || age < -60) {
    throw new Error("Telegram authentication expired.");
  }

  const userRaw = params.get("user");
  if (!userRaw) throw new Error("የተጠቃሚ መረጃ አልተገኘም።");

  let user;
  try {
    user = JSON.parse(userRaw);
  } catch {
    throw new Error("Invalid Telegram user.");
  }

  if (!user.id) throw new Error("Invalid Telegram user ID.");

  return {
    user,
    startParam: params.get("start_param") || null
  };
}

async function authenticate(req, res, next) {
  try {
    const initData = req.headers["x-telegram-init-data"];
    const auth = validateTelegramInitData(initData);
    const user = auth.user;

    await upsertUser(user, auth.startParam);
    req.telegramUser = user;
    req.startParam = auth.startParam;
    next();
  } catch (error) {
    console.error("AUTH ERROR:", error.message);
    return res.status(401).json({ ok: false, message: error.message || "የማረጋገጫ ስህተት አጋጥሟል።" });
  }
}

async function adminAuth(req, res, next) {
  const secret = req.headers["x-admin-secret"];
  if (secret && secret === ADMIN_SECRET) return next();

  try {
    const initData = req.headers["x-telegram-init-data"];
    if (initData) {
      const auth = validateTelegramInitData(initData);
      if (ADMIN_TELEGRAM_IDS.includes(Number(auth.user.id))) {
        req.telegramUser = auth.user;
        return next();
      }
    }
  } catch (e) { /* fall through */ }

  return res.status(403).json({ ok: false, message: "የአድሚን ፈቃድ ያስፈልጋል።" });
}

/* =========================================================
USER & REFERRAL LOGIC
========================================================= */

async function upsertUser(telegramUser, startParam = null) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT telegram_id FROM users WHERE telegram_id = $1 FOR UPDATE`,
      [telegramUser.id]
    );

    if (existing.rowCount === 0) {
      const referralCode = generateReferralCode(telegramUser.id);
      await client.query(
        `INSERT INTO users (telegram_id, username, first_name, last_name, photo_url, referral_code)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          telegramUser.id,
          telegramUser.username || null,
          telegramUser.first_name || null,
          telegramUser.last_name || null,
          telegramUser.photo_url || null,
          referralCode
        ]
      );
      await registerReferral(client, telegramUser.id, startParam);
    } else {
      await client.query(
        `UPDATE users
         SET username = $2, first_name = $3, last_name = $4, photo_url = $5, updated_at = NOW()
         WHERE telegram_id = $1`,
        [
          telegramUser.id,
          telegramUser.username || null,
          telegramUser.first_name || null,
          telegramUser.last_name || null,
          telegramUser.photo_url || null
        ]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function registerReferral(client, newUserId, startParam) {
  if (!startParam || !String(startParam).startsWith("ref_")) return;

  const code = String(startParam).slice(4).trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(code)) return;

  const referrerResult = await client.query(
    `SELECT telegram_id FROM users WHERE referral_code = $1 FOR UPDATE`,
    [code]
  );

  if (referrerResult.rowCount === 0) return;
  const referrerId = referrerResult.rows[0].telegram_id;
  if (String(referrerId) === String(newUserId)) return;

  // አዲስ ሪፈራል መመዝገብ (መጀመሪያ is_active = FALSE ነው የሚሆነው)
  await client.query(
    `INSERT INTO referrals (referrer_id, referred_id, is_active, reward_paid)
     VALUES ($1, $2, FALSE, FALSE)
     ON CONFLICT (referred_id) DO NOTHING`,
    [referrerId, newUserId]
  );

  await client.query(`UPDATE users SET referred_by = $2 WHERE telegram_id = $1`, [newUserId, referrerId]);
}

function generateReferralCode(telegramId) {
  const hash = crypto.createHash("sha256").update(`${telegramId}:${BOT_TOKEN}`).digest("hex");
  return hash.substring(0, 10).toUpperCase();
}

async function getSetting(key, fallback) {
  const result = await pool.query(`SELECT value FROM settings WHERE key = $1`, [key]);
  if (result.rowCount === 0) return fallback;
  return result.rows[0].value;
}

/* =========================================================
TELEGRAM CHANNEL MEMBERSHIP CHECK
========================================================= */

async function checkChannelMembership(telegramId, channelUsername) {
  if (!channelUsername) return true;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: channelUsername, user_id: telegramId })
    });
    const data = await res.json();
    if (!data.ok) return false;
    return ["creator", "administrator", "member"].includes(data.result.status) ||
      (data.result.status === "restricted" && data.result.is_member === true);
  } catch (err) {
    console.error("Channel check error:", err.message);
    return false;
  }
}

/* =========================================================
CHECK & ACTIVATE REFERRALS (2 Days Full Ads + Channel)
========================================================= */

async function checkReferralActivation(client, userId) {
  const uRes = await client.query(
    `SELECT referred_by, full_ad_days_count FROM users WHERE telegram_id = $1`,
    [userId]
  );
  if (uRes.rowCount === 0 || !uRes.rows[0].referred_by) return;

  const user = uRes.rows[0];
  const referrerId = user.referred_by;

  // መስፈርት፡ ቢያንስ የ2 ቀን ሙሉ ማስታወቂያ (full_ad_days_count >= 2) እና ቻናል መግባት
  const joinedChannel = await checkChannelMembership(userId, OFFICIAL_CHANNEL);

  if (Number(user.full_ad_days_count) >= 2 && joinedChannel) {
    const refCheck = await client.query(
      `SELECT id, is_active FROM referrals WHERE referred_id = $1 AND is_active = FALSE`,
      [userId]
    );

    if (refCheck.rowCount > 0) {
      // ሪፈራሉን ንቁ (active) ማድረግ እና ለጋባዡ ሽልማት መስጠት
      await client.query(`UPDATE referrals SET is_active = TRUE, reward_paid = TRUE WHERE referred_id = $1`, [userId]);

      const refUserRes = await client.query(`SELECT balance FROM users WHERE telegram_id = $1 FOR UPDATE`, [referrerId]);
      const before = Number(refUserRes.rows[0].balance);
      const after = before + REFERRAL_REWARD;

      await client.query(
        `UPDATE users SET balance = $2, total_earned = total_earned + $3, updated_at = NOW() WHERE telegram_id = $1`,
        [referrerId, after, REFERRAL_REWARD]
      );

      await client.query(
        `INSERT INTO transactions (telegram_id, type, amount, balance_before, balance_after, reference, description)
         VALUES ($1, 'referral', $2, $3, $4, $5, $6)`,
        [referrerId, REFERRAL_REWARD, before, after, `ref_${userId}`, "Active Referral Reward (2 Days Full Ads Completed)"]
      );
    }
  }
}

/* =========================================================
USER INFO & DASHBOARD (/api/me)
========================================================= */

app.get("/api/me", authenticate, async (req, res) => {
  try {
    const telegramId = req.telegramUser.id;
    const client = await pool.connect();
    let user;

    try {
      const userResult = await client.query(`SELECT * FROM users WHERE telegram_id = $1`, [telegramId]);
      user = userResult.rows[0];

      // የቀን አድስ ቆጣሪን በየቀኑ Reset ማድረግ
      const today = new Date().toISOString().slice(0, 10);
      const lastAdDate = user.last_ad_date ? new Date(user.last_ad_date).toISOString().slice(0, 10) : null;

      if (lastAdDate !== today) {
        await client.query(
          `UPDATE users SET today_ads_count = 0, last_ad_date = CURRENT_DATE WHERE telegram_id = $1`,
          [telegramId]
        );
        user.today_ads_count = 0;
      }
    } finally {
      client.release();
    }

    // ታስኮች (ኦፊሴላዊውን ቻናል ጨምሮ)
    const tasksResult = await pool.query(
      `SELECT t.*,
              COALESCE(tc.completed, FALSE) AS completed,
              (tc.task_id IS NOT NULL AND tc.completed = FALSE) AS started
       FROM tasks t
       LEFT JOIN task_completions tc ON tc.task_id = t.id AND tc.telegram_id = $1
       WHERE t.active = TRUE
       ORDER BY t.sort_order ASC, t.created_at ASC`,
      [telegramId]
    );

    // ንቁ ሪፈራሎች (2 ቀን ሙሉ አድስ ያዩ እና ቻናል የገቡ)
    const activeRefResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM referrals WHERE referrer_id = $1 AND is_active = TRUE`,
      [telegramId]
    );

    const totalRefResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM referrals WHERE referrer_id = $1`,
      [telegramId]
    );

    const activeCount = Number(activeRefResult.rows[0].count);
    const channelJoined = await checkChannelMembership(telegramId, OFFICIAL_CHANNEL);

    const requirements = [
      { text: `ቢያንስ ${MIN_WITHDRAW} ETB ሂሳብ ሊኖርዎት ይገባል`, completed: Number(user.balance) >= MIN_WITHDRAW },
      { text: `10 ንቁ ጓደኞችን መጋበዝ (የሁለት ቀን አድስ ያዩ) (${activeCount}/10)`, completed: activeCount >= MIN_ACTIVE_REFERRALS },
      { text: "ኦፊሴላዊ የቴሌግራም ቻናላችንን መቀላቀል", completed: channelJoined }
    ];

    const historyResult = await pool.query(
      `SELECT id, amount, method, status, created_at FROM withdrawals WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT 30`,
      [telegramId]
    );

    res.json({
      ok: true,
      user: {
        id: user.telegram_id,
        username: user.username,
        firstName: user.first_name,
        photoUrl: user.photo_url,
        botUsername: BOT_USERNAME,
        isAdmin: ADMIN_TELEGRAM_IDS.includes(Number(user.telegram_id))
      },
      balance: Number(user.balance),
      streak: user.streak,
      streakDays: {
        todayChecked: isToday(user.last_checkin_date)
      },
      todayEarned: await getTodayEarned(telegramId),
      referrals: Number(totalRefResult.rows[0].count),
      activeReferrals: activeCount,
      referralCode: user.referral_code,
      referralReward: REFERRAL_REWARD,
      ads: {
        todayCount: Number(user.today_ads_count),
        limit: DAILY_AD_LIMIT,
        reward: AD_REWARD
      },
      tasks: tasksResult.rows.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        icon: t.icon,
        type: t.type,
        reward: Number(t.reward),
        url: t.url,
        completed: t.completed,
        started: Boolean(t.started)
      })),
      withdrawalRequirements: requirements,
      paymentMethods: [
        { id: "telebirr", name: "Telebirr" },
        { id: "cbe", name: "CBE (የኢትዮጵያ ንግድ ባንክ)" }
      ],
      withdrawalHistory: historyResult.rows.map((i) => ({
        id: i.id,
        amount: Number(i.amount),
        method: i.method,
        status: i.status,
        createdAt: new Date(i.created_at).toLocaleString()
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "መረጃዎችን መጫን አልተቻለም።" });
  }
});

/* =========================================================
DAILY CHECK-IN
========================================================= */

app.post("/api/check-in", authenticate, async (req, res) => {
  const telegramId = req.telegramUser.id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(`SELECT * FROM users WHERE telegram_id = $1 FOR UPDATE`, [telegramId]);
    const user = result.rows[0];

    if (isToday(user.last_checkin_date)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, message: "የዛሬውን ቦነስ ከዚህ በፊት ወስደዋል።" });
    }

    const yesterday = getYesterdayUTC();
    const lastDate = user.last_checkin_date ? formatDate(user.last_checkin_date) : null;
    const isConsecutive = lastDate === yesterday;

    let streak = isConsecutive ? Number(user.streak) + 1 : 1;
    if (streak > 7) streak = 1;

    const rewardKey = `checkin_day_${streak}`;
    const reward = Number(await getSetting(rewardKey, 2));
    const before = Number(user.balance);
    const after = before + reward;

    await client.query(
      `UPDATE users
       SET balance = $2, streak = $3, last_checkin_date = CURRENT_DATE, total_earned = total_earned + $4, updated_at = NOW()
       WHERE telegram_id = $1`,
      [telegramId, after, streak, reward]
    );

    await client.query(
      `INSERT INTO transactions (telegram_id, type, amount, balance_before, balance_after, reference, description)
       VALUES ($1, 'checkin', $2, $3, $4, $5, $6)`,
      [telegramId, reward, before, after, `checkin_${Date.now()}`, `Daily check-in day ${streak}`]
    );

    await client.query("COMMIT");
    res.json({ ok: true, reward, streak, balance: after, message: `+${reward} ETB የቀን ቦነስ አግኝተዋል!` });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ ok: false, message: "Check-in አልተሳካም።" });
  } finally {
    client.release();
  }
});

/* =========================================================
WATCH ADS API (0.5 ETB - Limit 30/day)
========================================================= */

app.post("/api/ads/view", authenticate, async (req, res) => {
  const telegramId = req.telegramUser.id;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const uRes = await client.query(`SELECT * FROM users WHERE telegram_id = $1 FOR UPDATE`, [telegramId]);
    const user = uRes.rows[0];

    const today = new Date().toISOString().slice(0, 10);
    const lastAdDate = user.last_ad_date ? new Date(user.last_ad_date).toISOString().slice(0, 10) : null;

    let todayCount = Number(user.today_ads_count);
    if (lastAdDate !== today) {
      todayCount = 0;
    }

    if (todayCount >= DAILY_AD_LIMIT) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, message: "የዛሬውን 30 ማስታወቂያዎች ጨርሰዋል። እባክዎ ነገ ይመለሱ!" });
    }

    todayCount += 1;
    let fullDays = Number(user.full_ad_days_count);

    // 30ኛውን ማስታወቂያ ዛሬ ሲያጠናቅቅ እንደ 1 ሙሉ ቀን ይቆጠርለታል
    if (todayCount === DAILY_AD_LIMIT) {
      fullDays += 1;
    }

    const before = Number(user.balance);
    const after = before + AD_REWARD;

    await client.query(
      `UPDATE users
       SET balance = $2,
           today_ads_count = $3,
           last_ad_date = CURRENT_DATE,
           full_ad_days_count = $4,
           total_earned = total_earned + $5,
           updated_at = NOW()
       WHERE telegram_id = $1`,
      [telegramId, after, todayCount, fullDays, AD_REWARD]
    );

    await client.query(
      `INSERT INTO transactions (telegram_id, type, amount, balance_before, balance_after, reference, description)
       VALUES ($1, 'ad_reward', $2, $3, $4, $5, $6)`,
      [telegramId, AD_REWARD, before, after, `ad_${Date.now()}`, `Monetag Ad (${todayCount}/${DAILY_AD_LIMIT})`]
    );

    // ይህ ተጠቃሚ በሌላ ሰው ተጋብዞ ከሆነ 2 ቀን ማየቱን ቼክ አድርጎ ጋባዡን መሸለም
    await checkReferralActivation(client, telegramId);

    await client.query("COMMIT");

    res.json({
      ok: true,
      reward: AD_REWARD,
      balance: after,
      todayAdsCount: todayCount,
      message: `+${AD_REWARD} ETB አግኝተዋል! (${todayCount}/${DAILY_AD_LIMIT})`
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ ok: false, message: "ማስታወቂያውን መመዝገብ አልተቻለም።" });
  } finally {
    client.release();
  }
});

/* =========================================================
COMPLETE TASK
========================================================= */

app.post("/api/tasks/:id/complete", authenticate, async (req, res) => {
  const taskId = req.params.id;
  const telegramId = req.telegramUser.id;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const tRes = await client.query(`SELECT * FROM tasks WHERE id = $1 AND active = TRUE FOR UPDATE`, [taskId]);
    if (tRes.rowCount === 0) throw new Error("ታስኩ አልተገኘም።");
    const task = tRes.rows[0];

    const cRes = await client.query(
      `SELECT * FROM task_completions WHERE task_id = $1 AND telegram_id = $2 FOR UPDATE`,
      [taskId, telegramId]
    );
    if (cRes.rowCount > 0 && cRes.rows[0].completed) throw new Error("ይህንን ታስክ ከዚህ በፊት አጠናቀዋል።");

    if (task.type === "channel") {
      const channel = task.channel_username || OFFICIAL_CHANNEL;
      const joined = await checkChannelMembership(telegramId, channel);
      if (!joined) throw new Error("እባክዎ መጀመሪያ ቻናላችንን ይቀላቀሉ!");
    }

    if (task.type === "visit") {
      const startedRow = cRes.rows[0];
      if (!startedRow) {
        await client.query(
          `INSERT INTO task_completions (task_id, telegram_id, progress, completed) VALUES ($1, $2, 0, FALSE)`,
          [taskId, telegramId]
        );
        await client.query("COMMIT");
        return res.json({
          ok: true,
          completed: false,
          url: task.url || null,
          message: `Open the link, then come back after ${VISIT_MIN_SECONDS} seconds and tap Claim.`
        });
      }

      const elapsed = (Date.now() - new Date(startedRow.created_at).getTime()) / 1000;
      if (elapsed < VISIT_MIN_SECONDS) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          ok: false,
          message: `Please wait ${Math.ceil(VISIT_MIN_SECONDS - elapsed)} more seconds.`
        });
      }
    }

    const reward = Number(task.reward);
    const uRes = await client.query(`SELECT balance FROM users WHERE telegram_id = $1 FOR UPDATE`, [telegramId]);
    const before = Number(uRes.rows[0].balance);
    const after = before + reward;

    await client.query(
      `INSERT INTO task_completions (task_id, telegram_id, progress, completed) VALUES ($1, $2, 1, TRUE)
       ON CONFLICT (task_id, telegram_id) DO UPDATE SET completed = TRUE, updated_at = NOW()`,
      [taskId, telegramId]
    );

    await client.query(
      `UPDATE users SET balance = $2, total_earned = total_earned + $3, updated_at = NOW() WHERE telegram_id = $1`,
      [telegramId, after, reward]
    );

    await client.query(
      `INSERT INTO transactions (telegram_id, type, amount, balance_before, balance_after, reference, description)
       VALUES ($1, 'task', $2, $3, $4, $5, $6)`,
      [telegramId, reward, before, after, `task_${task.id}`, task.title]
    );

    // ቻናል ሲቀላቀል ሪፈራል ብቁነቱን ቼክ ማድረግ
    await checkReferralActivation(client, telegramId);

    await client.query("COMMIT");
    res.json({ ok: true, reward, balance: after, message: `ታስኩን ስላጠናቀቁ +${reward} ETB አግኝተዋል!` });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ ok: false, message: err.message });
  } finally {
    client.release();
  }
});

/* =========================================================
PROMO CODE REDEEM
========================================================= */

app.post("/api/promo/redeem", authenticate, async (req, res) => {
  const telegramId = req.telegramUser.id;
  const code = String(req.body.code || "").trim().toUpperCase();

  if (!code) return res.status(400).json({ ok: false, message: "Promo code ያስገቡ።" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const promoRes = await client.query(
      `SELECT * FROM promo_codes WHERE code = $1 AND active = TRUE FOR UPDATE`,
      [code]
    );

    if (promoRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, message: "የተሳሳተ ወይም ያልነቃ Promo code ነው።" });
    }

    const promo = promoRes.rows[0];

    if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, message: "የዚህ Promo code ጊዜ አልቋል።" });
    }

    if (promo.max_uses && promo.used_count >= promo.max_uses) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, message: "ይህ Promo code ገደቡ ላይ ደርሷል።" });
    }

    const checkRedemption = await client.query(
      `SELECT id FROM promo_redemptions WHERE code = $1 AND telegram_id = $2`,
      [code, telegramId]
    );

    if (checkRedemption.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, message: "ይህንን Promo code ከዚህ በፊት ተጠቅመውበታል።" });
    }

    const reward = Number(promo.reward);
    const userRes = await client.query(`SELECT balance FROM users WHERE telegram_id = $1 FOR UPDATE`, [telegramId]);
    const before = Number(userRes.rows[0].balance);
    const after = before + reward;

    await client.query(
      `UPDATE users SET balance = $2, total_earned = total_earned + $3, updated_at = NOW() WHERE telegram_id = $1`,
      [telegramId, after, reward]
    );

    await client.query(`INSERT INTO promo_redemptions (code, telegram_id) VALUES ($1, $2)`, [code, telegramId]);
    await client.query(`UPDATE promo_codes SET used_count = used_count + 1 WHERE code = $1`, [code]);

    await client.query(
      `INSERT INTO transactions (telegram_id, type, amount, balance_before, balance_after, reference, description)
       VALUES ($1, 'promo', $2, $3, $4, $5, $6)`,
      [telegramId, reward, before, after, `promo_${code}`, `Redeemed promo: ${code}`]
    );

    await client.query("COMMIT");
    res.json({ ok: true, reward, balance: after, message: `እንኳን ደስ አለዎት! +${reward} ETB ቦነስ አግኝተዋል።` });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ ok: false, message: "Promo code መጠቀም አልተቻለም።" });
  } finally {
    client.release();
  }
});

/* =========================================================
WITHDRAWAL REQUEST
========================================================= */

app.post("/api/withdraw", authenticate, async (req, res) => {
  const telegramId = req.telegramUser.id;
  const amount = Number(req.body.amount);
  const method = String(req.body.method || "").toLowerCase();
  const account = String(req.body.account || "").trim();

  if (!amount || amount < MIN_WITHDRAW) {
    return res.status(400).json({ ok: false, message: `ዝቅተኛው የማውጫ መጠን ${MIN_WITHDRAW} ETB ነው።` });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const uRes = await client.query(`SELECT * FROM users WHERE telegram_id = $1 FOR UPDATE`, [telegramId]);
    const user = uRes.rows[0];

    if (amount > Number(user.balance)) throw new Error("በቂ ሂሳብ የለዎትም።");

    // 1. 10 ንቁ ሪፈራሎች (2 ቀን አድስ ያዩ) መኖራቸውን ማረጋገጥ
    const refRes = await client.query(
      `SELECT COUNT(*)::int AS count FROM referrals WHERE referrer_id = $1 AND is_active = TRUE`,
      [telegramId]
    );
    const activeCount = Number(refRes.rows[0].count);

    if (activeCount < MIN_ACTIVE_REFERRALS) {
      throw new Error(`ገንዘብ ለማውጣት ቢያንስ 10 ንቁ ጓደኞች ሊኖሩዎት ይገባል (እስካሁን ያሉት: ${activeCount}/10)።`);
    }

    // 2. ኦፊሴላዊውን ቻናል መቀላቀላቸውን ማረጋገጥ
    const channelJoined = await checkChannelMembership(telegramId, OFFICIAL_CHANNEL);
    if (!channelJoined) {
      throw new Error("ገንዘብ ለማውጣት ኦፊሴላዊ የቴሌግራም ቻናላችንን መቀላቀል አለብዎት!");
    }

    const before = Number(user.balance);
    const after = before - amount;

    await client.query(`UPDATE users SET balance = $2, updated_at = NOW() WHERE telegram_id = $1`, [telegramId, after]);

    const withdrawalId = crypto.randomUUID();
    await client.query(
      `INSERT INTO withdrawals (id, telegram_id, amount, method, account_number, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [withdrawalId, telegramId, amount, method, account]
    );

    await client.query(
      `INSERT INTO transactions (telegram_id, type, amount, balance_before, balance_after, reference, description)
       VALUES ($1, 'withdrawal_hold', $2, $3, $4, $5, $6)`,
      [telegramId, -amount, before, after, withdrawalId, "Withdrawal Request"]
    );

    await client.query("COMMIT");
    res.json({ ok: true, balance: after, message: "የማውጣት ጥያቄዎ በተሳካ ሁኔታ ቀርቧል! በአጭር ጊዜ ውስጥ ይላክልዎታል።" });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ ok: false, message: err.message });
  } finally {
    client.release();
  }
});

/* =========================================================
ADMIN ENDPOINTS
========================================================= */

app.get("/api/admin/withdrawals", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT w.*, u.username, u.first_name
       FROM withdrawals w
       JOIN users u ON u.telegram_id = w.telegram_id
       ORDER BY w.created_at DESC LIMIT 100`
    );
    res.json({ ok: true, withdrawals: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, message: "መረጃውን ማግኘት አልተቻለም።" });
  }
});

app.post("/api/admin/withdrawals/:id/action", adminAuth, async (req, res) => {
  const { id } = req.params;
  const { action, note } = req.body;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const wRes = await client.query(`SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE`, [id]);
    if (wRes.rowCount === 0) throw new Error("ጥያቄው አልተገኘም።");
    const w = wRes.rows[0];
    if (w.status !== "pending") throw new Error("ጥያቄው ከዚህ በፊት ተስተናግዷል።");

    if (action === "approve") {
      await client.query(
        `UPDATE withdrawals SET status = 'paid', admin_note = $2, processed_at = NOW() WHERE id = $1`,
        [id, note || "Approved"]
      );
      await client.query(
        `UPDATE users SET total_withdrawn = total_withdrawn + $2, updated_at = NOW() WHERE telegram_id = $1`,
        [w.telegram_id, w.amount]
      );
    } else if (action === "reject") {
      const uRes = await client.query(`SELECT balance FROM users WHERE telegram_id = $1 FOR UPDATE`, [w.telegram_id]);
      const before = Number(uRes.rows[0].balance);
      const after = before + Number(w.amount);

      await client.query(`UPDATE users SET balance = $2, updated_at = NOW() WHERE telegram_id = $1`, [w.telegram_id, after]);
      await client.query(
        `UPDATE withdrawals SET status = 'rejected', admin_note = $2, processed_at = NOW() WHERE id = $1`,
        [id, note || "Rejected"]
      );
      await client.query(
        `INSERT INTO transactions (telegram_id, type, amount, balance_before, balance_after, reference, description)
         VALUES ($1, 'withdrawal_refund', $2, $3, $4, $5, $6)`,
        [w.telegram_id, w.amount, before, after, id, "Refund for rejected withdrawal"]
      );
    }

    await client.query("COMMIT");
    res.json({ ok: true, message: `ጥያቄው ${action} ሆኗል።` });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ ok: false, message: err.message });
  } finally {
    client.release();
  }
});

/* =========================================================
DATE & EARNING HELPERS
========================================================= */

async function getTodayEarned(telegramId) {
  const result = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
     WHERE telegram_id = $1 AND amount > 0 AND created_at >= CURRENT_DATE`,
    [telegramId]
  );
  return Number(result.rows[0].total);
}

function formatDate(date) {
  if (!date) return null;
  return new Date(date).toISOString().slice(0, 10);
}

function getTodayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function getYesterdayUTC() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function isToday(date) {
  if (!date) return false;
  return formatDate(date) === getTodayUTC();
}

/* =========================================================
ERROR HANDLER & LISTENER
========================================================= */

app.use((error, req, res, next) => {
  console.error("SERVER ERROR:", error);
  res.status(500).json({ ok: false, message: "Internal server error." });
});

app.listen(PORT, () => {
  console.log(`FulusApp Backend running on port ${PORT}`);
});

module.exports = app;
