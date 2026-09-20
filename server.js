

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");
const multer = require("multer");

/* =========================================================
   CONFIG & CONSTANTS
   ========================================================= */

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME || "AdewaBot";
const DATABASE_URL = process.env.DATABASE_URL;

const ADMIN_TELEGRAM_ID = 8845432223;
const MANDATORY_CHANNEL = "@proof_chnallel";
const PROOF_CHANNEL_ID = process.env.PROOF_CHANNEL_ID || "@proof_chnallel";

const AD_REWARD = 0.50;
const MAX_DAILY_ADS = 30;
const AD_COOLDOWN_SECONDS = 20;
const MIN_WITHDRAW = 100.00;
const REQUIRED_QUALIFIED_REFS = 10;

/* Multer memory storage for screenshot upload */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

/* =========================================================
   DATABASE POOL
   ========================================================= */

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

/* =========================================================
   MIDDLEWARE
   ========================================================= */

app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: "500kb" }));

/* =========================================================
   TELEGRAM INIT DATA AUTHENTICATION & FINGERPRINTING
   ========================================================= */

function validateTelegramInitData(initData) {
  if (!initData || !BOT_TOKEN) {
    throw new Error("Missing Telegram authentication context.");
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) throw new Error("Telegram hash parameter missing.");

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
    throw new Error("Invalid Telegram security signature.");
  }

  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > 86400) {
    throw new Error("Session expired. Please relaunch from Telegram.");
  }

  const userRaw = params.get("user");
  if (!userRaw) throw new Error("Telegram user profile missing.");

  return {
    user: JSON.parse(userRaw),
    startParam: params.get("start_param") || null
  };
}

async function authenticate(req, res, next) {
  try {
    const initData = req.headers["x-telegram-init-data"];
    const auth = validateTelegramInitData(initData);
    const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;

    req.telegramUser = auth.user;
    req.startParam = auth.startParam;
    req.clientIp = clientIp;

    await upsertUser(auth.user, auth.startParam, clientIp);
    next();
  } catch (error) {
    return res.status(401).json({ ok: false, message: error.message || "Authentication failed." });
  }
}

async function adminOnly(req, res, next) {
  try {
    const initData = req.headers["x-telegram-init-data"];
    const auth = validateTelegramInitData(initData);

    if (Number(auth.user.id) !== ADMIN_TELEGRAM_ID) {
      return res.status(403).json({ ok: false, message: "Access denied. Admin rights required." });
    }
    req.telegramUser = auth.user;
    next();
  } catch (e) {
    return res.status(403).json({ ok: false, message: "Admin authorization rejected." });
  }
}

/* =========================================================
   USER PROFILE & REFERRAL REGISTRATION
   ========================================================= */

function generateReferralCode(telegramId) {
  return crypto.createHash("sha256").update(`${telegramId}:${BOT_TOKEN}`).digest("hex").substring(0, 8).toUpperCase();
}

async function upsertUser(u, startParam, ip) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT id FROM users WHERE telegram_id = $1 FOR UPDATE", [u.id]);

    if (existing.rowCount === 0) {
      const refCode = generateReferralCode(u.id);
      let referrerId = null;

      if (startParam && startParam.startsWith("ref_")) {
        const code = startParam.slice(4).trim().toUpperCase();
        const refRes = await client.query("SELECT telegram_id FROM users WHERE referral_code = $1", [code]);
        if (refRes.rowCount > 0 && String(refRes.rows[0].telegram_id) !== String(u.id)) {
          referrerId = refRes.rows[0].telegram_id;
        }
      }

      await client.query(
        `INSERT INTO users (telegram_id, username, first_name, last_name, photo_url, referral_code, referred_by, registration_ip, last_ip)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [u.id, u.username || null, u.first_name || null, u.last_name || null, u.photo_url || null, refCode, referrerId, ip]
      );

      if (referrerId) {
        await client.query(
          `INSERT INTO referrals (referrer_id, referred_id) VALUES ($1, $2) ON CONFLICT (referred_id) DO NOTHING`,
          [referrerId, u.id]
        );
      }
    } else {
      await client.query(
        `UPDATE users
         SET username = $2, first_name = $3, last_name = $4, photo_url = $5, last_ip = $6, updated_at = NOW()
         WHERE telegram_id = $1`,
        [u.id, u.username || null, u.first_name || null, u.last_name || null, u.photo_url || null, ip]
      );
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
   TELEGRAM BOT API HELPERS
   ========================================================= */

async function telegramBotCall(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return await res.json();
}

async function checkTelegramChannelMembership(telegramId, channelUsername) {
  try {
    const data = await telegramBotCall("getChatMember", {
      chat_id: channelUsername,
      user_id: telegramId
    });
    if (!data.ok) return false;
    return ["creator", "administrator", "member"].includes(data.result.status) ||
           (data.result.status === "restricted" && data.result.is_member === true);
  } catch (err) {
    console.error("Channel check error:", err.message);
    return false;
  }
}

/* =========================================================
   CORE ROUTES
   ========================================================= */

/* 1. Account Initialization & Live State */
app.get("/api/me", authenticate, async (req, res) => {
  try {
    const uid = req.telegramUser.id;

    // Verify channel status live
    const isChannelMember = await checkTelegramChannelMembership(uid, MANDATORY_CHANNEL);
    await pool.query("UPDATE users SET channel_joined = $1 WHERE telegram_id = $2", [isChannelMember, uid]);

    const userRes = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [uid]);
    const user = userRes.rows[0];

    // Today's Ads Progress
    const todayProgress = await pool.query(
      "SELECT ads_watched FROM daily_ad_progress WHERE telegram_id = $1 AND ad_date = CURRENT_DATE",
      [uid]
    );
    const todayAdsWatched = todayProgress.rows[0]?.ads_watched || 0;

    // Referrals List with 2-day Qualification Tracking
    const refsRes = await pool.query(
      `SELECT 
          u.telegram_id AS id,
          u.first_name AS name,
          u.channel_joined,
          COALESCE(p1.ads_watched, 0) AS day1_ads,
          COALESCE(p2.ads_watched, 0) AS day2_ads,
          r.is_qualified
       FROM referrals r
       JOIN users u ON u.telegram_id = r.referred_id
       LEFT JOIN daily_ad_progress p1 ON p1.telegram_id = u.telegram_id AND p1.ad_date = CURRENT_DATE
       LEFT JOIN daily_ad_progress p2 ON p2.telegram_id = u.telegram_id AND p2.ad_date = CURRENT_DATE - INTERVAL '1 day'
       WHERE r.referrer_id = $1
       ORDER BY r.created_at DESC`,
      [uid]
    );

    // Update qualification status if completed Day 1 + Day 2 + Channel
    let qualifiedCount = 0;
    for (const row of refsRes.rows) {
      const qualifies = row.day1_ads >= MAX_DAILY_ADS && row.day2_ads >= MAX_DAILY_ADS && row.channel_joined;
      if (qualifies && !row.is_qualified) {
        await pool.query("UPDATE referrals SET is_qualified = TRUE, qualified_at = NOW() WHERE referrer_id = $1 AND referred_id = $2", [uid, row.id]);
        qualifiedCount++;
      } else if (row.is_qualified) {
        qualifiedCount++;
      }
    }

    // Dynamic tasks excluding completed ones
    const tasksRes = await pool.query(
      `SELECT t.*, tc.completed
       FROM tasks t
       LEFT JOIN task_completions tc ON tc.task_id = t.id AND tc.telegram_id = $1
       WHERE t.active = TRUE AND (tc.completed IS NULL OR tc.completed = FALSE)
       ORDER BY t.sort_order ASC`,
      [uid]
    );

    // Withdrawal History
    const historyRes = await pool.query(
      "SELECT id, amount, method, account_number, status, created_at FROM withdrawals WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT 20",
      [uid]
    );

    res.json({
      ok: true,
      user: {
        id: user.telegram_id,
        username: user.username,
        firstName: user.first_name,
        photoUrl: user.photo_url,
        referralCode: user.referral_code,
        botUsername: BOT_USERNAME,
        isAdmin: Number(user.telegram_id) === ADMIN_TELEGRAM_ID
      },
      balance: Number(user.balance),
      todayAdsWatched,
      maxDailyAds: MAX_DAILY_ADS,
      adReward: AD_REWARD,
      spinsAvailable: user.spins_available,
      channelVerified: isChannelMember,
      officialChannelUsername: MANDATORY_CHANNEL,
      qualifiedReferralsCount: qualifiedCount,
      totalReferralsCount: refsRes.rowCount,
      referralsList: refsRes.rows.map(r => ({
        id: r.id,
        name: r.name,
        channelJoined: r.channel_joined,
        day1Ads: r.day1_ads,
        day2Ads: r.day2_ads,
        isQualified: r.is_qualified
      })),
      tasks: tasksRes.rows.map(t => ({
        id: t.id,
        title: t.title,
        description: t.description,
        icon: t.icon,
        type: t.type,
        reward: Number(t.reward),
        url: t.url,
        completed: false
      })),
      withdrawalHistory: historyRes.rows.map(h => ({
        id: h.id,
        amount: Number(h.amount),
        method: h.method,
        account: h.account_number,
        status: h.status,
        createdAt: h.created_at
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Failed to load account profile." });
  }
});

/* 2. Secure Ad Reward Processing with Anti-Cheat */
app.post("/api/ads/claim", authenticate, async (req, res) => {
  const uid = req.telegramUser.id;
  const ip = req.clientIp;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Anti-Cheat: 20 Seconds Cooldown verification
    const lastAd = await client.query(
      "SELECT watched_at FROM ad_logs WHERE telegram_id = $1 ORDER BY watched_at DESC LIMIT 1",
      [uid]
    );
    if (lastAd.rowCount > 0) {
      const diffSec = (Date.now() - new Date(lastAd.rows[0].watched_at).getTime()) / 1000;
      if (diffSec < AD_COOLDOWN_SECONDS) {
        await client.query("ROLLBACK");
        return res.status(429).json({
          ok: false,
          message: `Anti-cheat: Please wait ${Math.ceil(AD_COOLDOWN_SECONDS - diffSec)} more seconds.`
        });
      }
    }

    // Daily 30 Ads Limiter
    const progress = await client.query(
      `INSERT INTO daily_ad_progress (telegram_id, ad_date, ads_watched)
       VALUES ($1, CURRENT_DATE, 1)
       ON CONFLICT (telegram_id, ad_date)
       DO UPDATE SET ads_watched = daily_ad_progress.ads_watched + 1, updated_at = NOW()
       RETURNING ads_watched`,
      [uid]
    );

    const watched = progress.rows[0].ads_watched;
    if (watched > MAX_DAILY_ADS) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, message: "Daily limit reached (30/30 Ads)." });
    }

    // Award Balance
    const userRes = await client.query("SELECT balance FROM users WHERE telegram_id = $1 FOR UPDATE", [uid]);
    const before = Number(userRes.rows[0].balance);
    const after = before + AD_REWARD;

    // Grant 1 Free Spin for every 10 ads completed
    let addSpin = false;
    if (watched % 10 === 0) addSpin = true;

    await client.query(
      `UPDATE users 
       SET balance = $2, 
           total_earned = total_earned + $3, 
           spins_available = spins_available + $4,
           updated_at = NOW()
       WHERE telegram_id = $1`,
      [uid, after, AD_REWARD, addSpin ? 1 : 0]
    );

    // Log Ad Audit
    await client.query(
      "INSERT INTO ad_logs (telegram_id, reward, ip_address) VALUES ($1, $2, $3)",
      [uid, AD_REWARD, ip]
    );

    await client.query(
      `INSERT INTO transactions (telegram_id, type, amount, balance_before, balance_after, reference, description)
       VALUES ($1, 'ad_reward', $2, $3, $4, $5, 'Rewarded Ad Bonus')`,
      [uid, AD_REWARD, before, after, `ad_${Date.now()}`]
    );

    await client.query("COMMIT");
    res.json({
      ok: true,
      reward: AD_REWARD,
      balance: after,
      adsWatched: watched,
      spinEarned: addSpin,
      message: `+${AD_REWARD} ETB credited! (${watched}/30 ads)`
    });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ ok: false, message: err.message || "Failed to process ad credit." });
  } finally {
    client.release();
  }
});

/* 3. Spin & Win Lucky Wheel */
app.post("/api/spin/execute", authenticate, async (req, res) => {
  const uid = req.telegramUser.id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const uRes = await client.query("SELECT balance, spins_available FROM users WHERE telegram_id = $1 FOR UPDATE", [uid]);
    const spins = Number(uRes.rows[0].spins_available);

    if (spins <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, message: "No free spins available. Watch 10 ads to earn a spin!" });
    }

    const prizes = [0.20, 0.50, 1.00, 2.00, 5.00];
    const prize = prizes[Math.floor(Math.random() * prizes.length)];

    const before = Number(uRes.rows[0].balance);
    const after = before + prize;

    await client.query(
      `UPDATE users 
       SET balance = $2, total_earned = total_earned + $3, spins_available = spins_available - 1, updated_at = NOW() 
       WHERE telegram_id = $1`,
      [uid, after, prize]
    );

    await client.query(
      `INSERT INTO transactions (telegram_id, type, amount, balance_before, balance_after, reference, description)
       VALUES ($1, 'spin', $2, $3, $4, $5, 'Lucky Spin Reward')`,
      [uid, prize, before, after, `spin_${Date.now()}`]
    );

    await client.query("COMMIT");
    res.json({ ok: true, prize, balance: after });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ ok: false, message: "Spin execution error." });
  } finally {
    client.release();
  }
});

/* 4. Complete Dynamic Task (Self-Destruct on completion) */
app.post("/api/tasks/:id/complete", authenticate, async (req, res) => {
  const taskId = req.params.id;
  const uid = req.telegramUser.id;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const taskRes = await client.query("SELECT * FROM tasks WHERE id = $1 AND active = TRUE", [taskId]);
    if (taskRes.rowCount === 0) throw new Error("Task not found or expired.");

    const task = taskRes.rows[0];

    // If channel task, check membership live
    if (task.type === "channel" && task.channel_username) {
      const joined = await checkTelegramChannelMembership(uid, task.channel_username);
      if (!joined) throw new Error("Please join the channel before verifying.");
    }

    // Insert completion (removes task from UI on refresh)
    await client.query(
      `INSERT INTO task_completions (task_id, telegram_id, completed) VALUES ($1, $2, TRUE)
       ON CONFLICT (task_id, telegram_id) DO UPDATE SET completed = TRUE`,
      [taskId, uid]
    );

    const reward = Number(task.reward);
    const uRes = await client.query("SELECT balance FROM users WHERE telegram_id = $1 FOR UPDATE", [uid]);
    const before = Number(uRes.rows[0].balance);
    const after = before + reward;

    await client.query(
      "UPDATE users SET balance = $2, total_earned = total_earned + $3 WHERE telegram_id = $1",
      [uid, after, reward]
    );

    await client.query(
      `INSERT INTO transactions (telegram_id, type, amount, balance_before, balance_after, reference, description)
       VALUES ($1, 'task', $2, $3, $4, $5, $6)`,
      [uid, reward, before, after, `task_${taskId}`, task.title]
    );

    await client.query("COMMIT");
    res.json({ ok: true, reward, balance: after, message: `Task completed! +${reward} ETB` });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ ok: false, message: err.message });
  } finally {
    client.release();
  }
});

/* 5. Redeem Promo Code */
app.post("/api/promo/redeem", authenticate, async (req, res) => {
  const code = String(req.body.code || "").trim().toUpperCase();
  const uid = req.telegramUser.id;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const promoRes = await client.query("SELECT * FROM promo_codes WHERE code = $1 AND active = TRUE FOR UPDATE", [code]);
    if (promoRes.rowCount === 0) throw new Error("Invalid or expired promo code.");

    const promo = promoRes.rows[0];
    if (promo.max_uses && promo.used_count >= promo.max_uses) throw new Error("This promo code has reached its usage limit.");

    const usedCheck = await client.query("SELECT id FROM promo_redemptions WHERE code = $1 AND telegram_id = $2", [code, uid]);
    if (usedCheck.rowCount > 0) throw new Error("You have already claimed this promo code.");

    const reward = Number(promo.reward);
    const uRes = await client.query("SELECT balance FROM users WHERE telegram_id = $1 FOR UPDATE", [uid]);
    const before = Number(uRes.rows[0].balance);
    const after = before + reward;

    await client.query("UPDATE users SET balance = $2, total_earned = total_earned + $3 WHERE telegram_id = $1", [uid, after, reward]);
    await client.query("INSERT INTO promo_redemptions (code, telegram_id) VALUES ($1, $2)", [code, uid]);
    await client.query("UPDATE promo_codes SET used_count = used_count + 1 WHERE code = $1", [code]);

    await client.query(
      `INSERT INTO transactions (telegram_id, type, amount, balance_before, balance_after, reference, description)
       VALUES ($1, 'promo', $2, $3, $4, $5, $6)`,
      [uid, reward, before, after, `promo_${code}`, `Claimed Promo: ${code}`]
    );

    await client.query("COMMIT");
    res.json({ ok: true, reward, balance: after, message: `Promo applied! +${reward} ETB received.` });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ ok: false, message: err.message });
  } finally {
    client.release();
  }
});

/* 6. Strict Withdrawal Request with Fraud Score */
app.post("/api/withdraw", authenticate, async (req, res) => {
  const uid = req.telegramUser.id;
  const amount = Number(req.body.amount);
  const method = String(req.body.method || "").toLowerCase();
  const account = String(req.body.account || "").trim();
  const ip = req.clientIp;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Real-time Channel Verification check
    const isMember = await checkTelegramChannelMembership(uid, MANDATORY_CHANNEL);
    if (!isMember) throw new Error("Action blocked: You must be an active member of @proof_chnallel.");

    if (amount < MIN_WITHDRAW) throw new Error(`Minimum withdrawal is ${MIN_WITHDRAW} ETB.`);
    if (account.length < 6) throw new Error("Please provide a valid account or phone number.");

    // Check Qualified Referrals count (Must have Day 1 & Day 2 completed)
    const qualRes = await client.query(
      "SELECT COUNT(*)::int AS count FROM referrals WHERE referrer_id = $1 AND is_qualified = TRUE",
      [uid]
    );
    if (qualRes.rows[0].count < REQUIRED_QUALIFIED_REFS) {
      throw new Error(`You need at least ${REQUIRED_QUALIFIED_REFS} Qualified Referrals (2 full days of ads completed).`);
    }

    const uRes = await client.query("SELECT balance, username, first_name FROM users WHERE telegram_id = $1 FOR UPDATE", [uid]);
    const user = uRes.rows[0];
    const before = Number(user.balance);
    if (amount > before) throw new Error("Insufficient balance.");

    // Calculate Fraud Risk Score (IP Clustering check)
    let riskScore = 0;
    let riskReason = "Safe";
    const sameIpRefs = await client.query(
      "SELECT COUNT(*)::int AS count FROM users WHERE registration_ip = $1 AND referred_by = $2",
      [ip, uid]
    );
    if (sameIpRefs.rows[0].count > 3) {
      riskScore = 85;
      riskReason = `⚠️ High Risk: ${sameIpRefs.rows[0].count} referrals share the same IP address!`;
    }

    const after = before - amount;
    await client.query("UPDATE users SET balance = $2 WHERE telegram_id = $1", [uid, after]);

    const wId = crypto.randomUUID();
    await client.query(
      `INSERT INTO withdrawals (id, telegram_id, amount, method, account_number, status, risk_score, risk_reason)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)`,
      [wId, uid, amount, method, account, riskScore, riskReason]
    );

    await client.query(
      `INSERT INTO transactions (telegram_id, type, amount, balance_before, balance_after, reference, description)
       VALUES ($1, 'withdrawal_hold', $2, $3, $4, $5, 'Pending Withdrawal Hold')`,
      [uid, -amount, before, after, wId]
    );

    // Send Instant Telegram Notification to Admin
    const adminAlertMsg = `🔔 *New Payout Request on Adewa!*\n\n` +
      `👤 *User:* ${user.first_name || user.username || uid} (\`${uid}\`)\n` +
      `💰 *Amount:* ${amount} ETB\n` +
      `💳 *Method:* ${method.toUpperCase()} (${account})\n` +
      `🛡️ *Fraud Risk:* ${riskScore > 50 ? "⚠️ High Risk (" + riskReason + ")" : "✅ Clean"}\n\n` +
      `Review & approve in the Admin Panel.`;

    telegramBotCall("sendMessage", {
      chat_id: ADMIN_TELEGRAM_ID,
      text: adminAlertMsg,
      parse_mode: "Markdown"
    }).catch(() => {});

    await client.query("COMMIT");
    res.json({ ok: true, message: "Withdrawal submitted for admin review." });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ ok: false, message: err.message });
  } finally {
    client.release();
  }
});

/* =========================================================
   ADMIN PANEL SUITE (ID: 8845432223)
   ========================================================= */

app.get("/api/admin/overview", adminOnly, async (req, res) => {
  try {
    const pendingRes = await pool.query(
      `SELECT w.*, u.username, u.first_name 
       FROM withdrawals w 
       JOIN users u ON u.telegram_id = w.telegram_id 
       WHERE w.status = 'pending' 
       ORDER BY w.created_at DESC`
    );
    const usersCount = await pool.query("SELECT COUNT(*)::int AS count FROM users");

    res.json({
      ok: true,
      pendingCount: pendingRes.rowCount,
      totalUsers: usersCount.rows[0].count,
      requests: pendingRes.rows.map(r => ({
        id: r.id,
        telegramId: r.telegram_id,
        username: r.username || r.first_name,
        amount: Number(r.amount),
        method: r.method,
        account: r.account_number,
        status: r.status,
        riskScore: r.risk_score,
        riskReason: r.risk_reason
      }))
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/* Approve with Screenshot Upload & Telegram Broadcast Pipeline */
app.post("/api/admin/withdrawals/:id/approve-proof", adminOnly, upload.single("photo"), async (req, res) => {
  const wId = req.params.id;
  const note = req.body.note || "Transfer Completed";
  const file = req.file;

  if (!file) return res.status(400).json({ ok: false, message: "Transfer receipt photo is required." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const wRes = await client.query("SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE", [wId]);
    if (wRes.rowCount === 0) throw new Error("Withdrawal request not found.");

    const w = wRes.rows[0];
    if (w.status !== "pending") throw new Error("Withdrawal already processed.");

    // Update Withdrawal status to Paid
    await client.query(
      "UPDATE withdrawals SET status = 'paid', admin_note = $2, processed_at = NOW() WHERE id = $1",
      [wId, note]
    );
    await client.query(
      "UPDATE users SET total_withdrawn = total_withdrawn + $2 WHERE telegram_id = $1",
      [w.telegram_id, w.amount]
    );

    // Broadcast Receipt Screenshot to Proof Channel
    const caption = `✅ *NEW WITHDRAWAL PAID!*\n\n` +
      `💸 *Amount:* ${w.amount} ETB\n` +
      `🏦 *Method:* ${w.method.toUpperCase()}\n` +
      `👤 *User ID:* \`${String(w.telegram_id).slice(0, 4)}****\`\n` +
      `📅 *Date:* ${new Date().toLocaleString()}\n` +
      `📢 *Bot:* @${BOT_USERNAME}\n\n` +
      `⚡ *Earn real cash daily by watching ads on Adewa!*`;

    const formData = new FormData();
    formData.append("chat_id", PROOF_CHANNEL_ID);
    formData.append("caption", caption);
    formData.append("parse_mode", "Markdown");
    formData.append("photo", new Blob([file.buffer], { type: file.mimetype }), "proof.jpg");

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: "POST",
      body: formData
    });

    await client.query("COMMIT");
    res.json({ ok: true, message: "Approved & Broadcasted to Proof Channel!" });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ ok: false, message: err.message });
  } finally {
    client.release();
  }
});

/* Reject Withdrawal and Refund Balance */
app.post("/api/admin/withdrawals/:id/action", adminOnly, async (req, res) => {
  const { id } = req.params;
  const { action } = req.body;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const wRes = await client.query("SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE", [id]);
    if (wRes.rowCount === 0) throw new Error("Request not found.");

    const w = wRes.rows[0];
    if (action === "reject") {
      const uRes = await client.query("SELECT balance FROM users WHERE telegram_id = $1 FOR UPDATE", [w.telegram_id]);
      const before = Number(uRes.rows[0].balance);
      const after = before + Number(w.amount);

      await client.query("UPDATE users SET balance = $2 WHERE telegram_id = $1", [w.telegram_id, after]);
      await client.query("UPDATE withdrawals SET status = 'rejected', processed_at = NOW() WHERE id = $1", [id]);
      await client.query(
        `INSERT INTO transactions (telegram_id, type, amount, balance_before, balance_after, reference, description)
         VALUES ($1, 'withdrawal_refund', $2, $3, $4, $5, 'Refund for Rejected Withdrawal')`,
        [w.telegram_id, w.amount, before, after, id]
      );
    }

    await client.query("COMMIT");
    res.json({ ok: true, message: `Withdrawal successfully ${action}ed.` });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ ok: false, message: err.message });
  } finally {
    client.release();
  }
});

/* No-Code Task Publisher */
app.post("/api/admin/tasks/create", adminOnly, async (req, res) => {
  const { title, type, reward, url } = req.body;
  try {
    await pool.query(
      "INSERT INTO tasks (title, type, reward, url, active) VALUES ($1, $2, $3, $4, TRUE)",
      [title, type, reward, url || null]
    );
    res.json({ ok: true, message: "Task published." });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
});

/* Generate Promo Codes */
app.post("/api/admin/promo/create", adminOnly, async (req, res) => {
  const { code, reward, maxUses } = req.body;
  try {
    await pool.query(
      "INSERT INTO promo_codes (code, reward, max_uses) VALUES ($1, $2, $3)",
      [code.toUpperCase(), reward, maxUses || null]
    );
    res.json({ ok: true, message: `Promo code ${code} generated.` });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
});

/* Update Reward Configurations */
app.post("/api/admin/settings/update", adminOnly, async (req, res) => {
  const { referralReward, adReward } = req.body;
  try {
    if (referralReward) await pool.query("UPDATE settings SET value = $1 WHERE key = 'referral_reward'", [String(referralReward)]);
    if (adReward) await pool.query("UPDATE settings SET value = $1 WHERE key = 'ad_reward'", [String(adReward)]);
    res.json({ ok: true, message: "Settings updated." });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
});

/* =========================================================
   START SERVER
   ========================================================= */

app.listen(PORT, () => {
  console.log(`Adewa Core Engine online on port ${PORT}`);
});

module.exports = app;
