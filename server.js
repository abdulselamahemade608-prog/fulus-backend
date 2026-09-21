const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

// =========================================================
// CONFIGURATION & SECRETS
// =========================================================
const BOT_TOKEN = process.env.BOT_TOKEN || "YOUR_BOT_TOKEN_HERE";
const ADMIN_ID = 8845432223; // Fixed Admin Telegram ID
const PROOF_CHANNEL = "@proof_chnallel";

// ተጠቃሚው መከተል ያለባቸው 5ቱ ቻናሎች
const REQUIRED_CHANNELS = [
  "@proof_chnallel",
  "@proof_chnallel", // የራስህን ሌላ ቻናል እዚህ መተካት ትችላለህ
  "@proof_chnallel",
  "@proof_chnallel",
  "@proof_chnallel"
];

// In-Memory Database (ወደፊት ከ MongoDB/PostgreSQL ጋር ማገናኘት ትችላለህ)
const DB = {
  users: {},
  adSessions: {}, // Nonce & Token storage
  tasks: [
    {
      id: "tsk_1",
      title: "Subscribe to YouTube Channel",
      description: "Subscribe and send screenshot to the bot",
      url: "https://youtube.com",
      reward: 1.00,
      limit: 500,
      claimed: 0,
      active: true
    }
  ],
  withdrawals: [],
  settings: {
    min_withdraw: 100,
    withdraw_locked: false,
    daily_liquidity_cap: 3000,
    today_withdrawn: 0
  }
};

// =========================================================
// TELEGRAM AUTHENTICATION MIDDLEWARE
// =========================================================
function authMiddleware(req, res, next) {
  const initData = req.headers["x-telegram-init-data"];

  // Local/Postman test ለማድረግ initData ከሌለ dummy user ይሰጣል
  if (!initData) {
    req.user = { id: 8845432223, first_name: "Admin Tester", username: "admin" };
    initUser(req.user.id, req.user);
    return next();
  }

  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get("hash");
    urlParams.delete("hash");

    const dataCheckArr = [];
    Array.from(urlParams.keys()).sort().forEach(key => {
      dataCheckArr.push(`${key}=${urlParams.get(key)}`);
    });
    const dataCheckString = dataCheckArr.join("\n");

    const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

    if (calculatedHash !== hash) {
      return res.status(401).json({ ok: false, message: "Invalid signature" });
    }

    const userData = JSON.parse(urlParams.get("user") || "{}");
    req.user = userData;
    initUser(userData.id, userData);
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, message: "Auth failed" });
  }
}

// አዲስ ተጠቃሚ ሲገባ አካውንት መክፈቻ
function initUser(id, raw) {
  if (!DB.users[id]) {
    DB.users[id] = {
      id: id,
      telegram_id: id,
      firstName: raw.first_name || "User",
      username: raw.username || "",
      balance: 0.0,
      todayAds: 0,
      maxAdsDaily: 10, // በመጀመሪያ ሳምንት 10 ብቻ
      streak: 1,
      lastActiveDate: new Date().toISOString().slice(0, 10),
      streakBroken: false,
      streakBrokenDate: null,
      level: "Bronze", // Bronze (10), Silver (15), Gold (20)
      spinsRemaining: 0,
      lastWithdrawDate: null,
      completedTasks: []
    };
  }
}

// =========================================================
// 1. GATEKEEPER API: 5ቱን ቻናሎች ቴሌግራም ላይ ቼክ ማድረጊያ
// =========================================================
app.post("/api/channels/verify-all", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  let allJoined = true;

  // Bot API በመጠቀም አባል መሆኑን በቴሌግራም ሰርቨር ማረጋገጥ
  for (const channel of REQUIRED_CHANNELS) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${channel}&user_id=${userId}`);
      const data = await response.json();

      if (!data.ok || ["left", "kicked"].includes(data.result.status)) {
        allJoined = false;
        break;
      }
    } catch (e) {
      // ቦቱ በቻናሉ አድሚን ካልተደረገ ሊሳሳት ስለሚችል እንደ joined ይቆጥረዋል
      allJoined = true;
    }
  }

  res.json({ ok: true, allJoined: allJoined });
});

// =========================================================
// 2. USER PROFILE & STREAK HANDLING
// =========================================================
app.get("/api/me", authMiddleware, (req, res) => {
  const user = DB.users[req.user.id];
  const today = new Date().toISOString().slice(0, 10);

  // የቀን አቆጣጠር እና የስክሪፕት ስትሪክ ፍተሻ
  if (user.lastActiveDate !== today) {
    const lastDate = new Date(user.lastActiveDate);
    const currentDate = new Date(today);
    const diffDays = Math.round((currentDate - lastDate) / (1000 * 60 * 60 * 24));

    if (diffDays === 1) {
      // በየቀኑ ሲገባ ስትሪክ ይጨምራል
      user.streak += 1;
      // 7 ቀን ሙሉ ሳይሰበር ሲቆይ የ 5 ማስታወቂያ መጨመሪያና ሌቭል ማሳደጊያ
      if (user.streak % 7 === 0) {
        user.maxAdsDaily += 5;
        user.balance += 5.0; // ሳምንታዊ ቦነስ
        if (user.maxAdsDaily >= 20) user.level = "Gold";
        else if (user.maxAdsDaily >= 15) user.level = "Silver";
      }
    } else if (diffDays > 1) {
      // ከአንድ ቀን በላይ ካቋረጠ ስትሪኩ ይሰበራል
      user.streakBroken = true;
      user.streakBrokenDate = Date.now();
      user.streak = 1;
      user.maxAdsDaily = 10;
      user.level = "Bronze";
    }

    user.todayAds = 0;
    user.lastActiveDate = today;
  }

  // የ 24 ሰዓት የ Streak Freeze ጊዜ ካለፈ
  if (user.streakBroken && (Date.now() - user.streakBrokenDate > 24 * 60 * 60 * 1000)) {
    user.streakBroken = false;
  }

  res.json({
    ok: true,
    user: user,
    balance: user.balance,
    todayAds: user.todayAds,
    maxAdsDaily: user.maxAdsDaily,
    streak: user.streak,
    streakBroken: user.streakBroken,
    level: user.level,
    spins: user.spinsRemaining,
    tasks: DB.tasks.filter(t => t.active && !user.completedTasks.includes(t.id)),
    settings: DB.settings
  });
});

// ስትሪክን በ 1.50 ብር ማዳኛ
app.post("/api/streak/recover", authMiddleware, (req, res) => {
  const user = DB.users[req.user.id];
  if (user.balance < 1.50) {
    return res.status(400).json({ ok: false, message: "1.50 ETB balance required" });
  }

  user.balance -= 1.50;
  user.streakBroken = false;
  user.streak += 1;

  res.json({ ok: true, balance: user.balance, streak: user.streak });
});

// =========================================================
// 3. SECURE AD REWARD (SERVER NONCE / DURATION CHECK)
// =========================================================

// ማስታወቂያ ከመጀመሩ በፊት ጊዜያዊ Nonce ማመንጫ
app.post("/api/ads/start-session", authMiddleware, (req, res) => {
  const user = DB.users[req.user.id];
  if (user.todayAds >= user.maxAdsDaily) {
    return res.status(400).json({ ok: false, message: "Daily quota reached" });
  }

  const token = crypto.randomBytes(16).toString("hex");
  DB.adSessions[token] = {
    userId: user.id,
    startTime: Date.now()
  };

  res.json({ ok: true, sessionToken: token });
});

// ማስታወቂያው Monetag ላይ ሲያበቃ ክፍያውን ማረጋገጫ
app.post("/api/ads/verify-reward", authMiddleware, (req, res) => {
  const { sessionToken } = req.body;
  const session = DB.adSessions[sessionToken];

  if (!session || session.userId !== req.user.id) {
    return res.status(400).json({ ok: false, message: "Invalid ad token" });
  }

  // 15 ሰከንድ በታች ከሆነ ተጠቃሚው skip አድርጎታል ማለት ነው
  const duration = (Date.now() - session.startTime) / 1000;
  if (duration < 15) {
    delete DB.adSessions[sessionToken];
    return res.status(400).json({ ok: false, message: "Ad completed too quickly (fraud detected)" });
  }

  delete DB.adSessions[sessionToken]; // Token expire ይደረጋል (Replay Attack መከላከያ)

  const user = DB.users[req.user.id];
  user.todayAds += 1;
  user.balance += 0.50;

  res.json({ ok: true, balance: user.balance, todayAds: user.todayAds });
});

// =========================================================
// 4. SPIN & WIN (HOUSE EDGE & ANTI-LOSS ENGINE)
// =========================================================

// በ 2 ብር 10 ስፒን መግዣ
app.post("/api/spin/buy-pack", authMiddleware, (req, res) => {
  const user = DB.users[req.user.id];
  if (user.balance < 2.0) {
    return res.status(400).json({ ok: false, message: "2.00 ETB required" });
  }

  user.balance -= 2.0;
  user.spinsRemaining += 10;

  res.json({ ok: true, balance: user.balance, spins: user.spinsRemaining });
});

// ስፒኑን የማሽከርከር ሎጂክ (አንተ የማትከስርበት ቀመር)
app.post("/api/spin/execute", authMiddleware, (req, res) => {
  const user = DB.users[req.user.id];
  if (user.spinsRemaining <= 0) {
    return res.status(400).json({ ok: false, message: "No spins available" });
  }

  user.spinsRemaining -= 1;

  // Probability Weighting:
  // 75% = 0 ETB (ባዶ)
  // 18% = 0.20 ETB
  // 6%  = 1.00 ETB
  // 1%  = 15.00 ETB (Jackpot)
  const rand = Math.random() * 100;
  let reward = 0;

  if (rand < 75) {
    reward = 0;
  } else if (rand < 93) {
    reward = 0.20;
  } else if (rand < 99) {
    reward = 1.00;
  } else {
    reward = 15.00;
  }

  user.balance += reward;

  res.json({
    ok: true,
    won: reward,
    balance: user.balance,
    spinsRemaining: user.spinsRemaining
  });
});

// =========================================================
// 5. WITHDRAWAL TERMINAL (በ 2 ቀን አንዴ & LOCK CONTROL)
// =========================================================
app.post("/api/withdraw/request", authMiddleware, (req, res) => {
  // አድሚኑ ክፍያ ዘግቶት ከሆነ
  if (DB.settings.withdraw_locked) {
    return res.status(403).json({ ok: false, message: "Withdrawals are currently locked by Admin." });
  }

  const user = DB.users[req.user.id];
  const { amount, method, account } = req.body;
  const numAmount = Number(amount);

  if (numAmount < DB.settings.min_withdraw) {
    return res.status(400).json({ ok: false, message: `Minimum withdraw is ${DB.settings.min_withdraw} ETB` });
  }

  if (user.balance < numAmount) {
    return res.status(400).json({ ok: false, message: "Insufficient balance" });
  }

  // በ 2 ቀን አንዴ ብቻ የማውጣት ገደብ (2-Day Cooldown)
  if (user.lastWithdrawDate) {
    const diff = (Date.now() - user.lastWithdrawDate) / (1000 * 60 * 60 * 24);
    if (diff < 2) {
      return res.status(400).json({ ok: false, message: "You can only request withdrawal once every 2 days." });
    }
  }

  user.balance -= numAmount;
  user.lastWithdrawDate = Date.now();

  const txId = "WD_" + Date.now();
  const requestRecord = {
    id: txId,
    userId: user.id,
    username: user.username || user.firstName,
    amount: numAmount,
    method: method,
    account: account,
    status: "pending",
    timestamp: Date.now()
  };

  DB.withdrawals.unshift(requestRecord);

  // አድሚኑ ቴሌግራም ላይ እንዲያየው ማሳወቂያ መላክ
  try {
    const text = `🔔 <b>አዲስ የክፍያ ጥያቄ (Withdrawal Alert)</b>\n\n` +
      `👤 ተጠቃሚ: @${requestRecord.username} (ID: <code>${user.id}</code>)\n` +
      `💰 መጠን: <b>${numAmount} ETB</b>\n` +
      `💳 መንገድ: ${method.toUpperCase()} (${account})\n` +
      `⏳ ሁኔታ: Pending (2-Day Check Passed)`;

    fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: ADMIN_ID,
        text: text,
        parse_mode: "HTML"
      })
    });
  } catch (e) {}

  res.json({ ok: true, message: "Withdrawal request queued successfully" });
});

// =========================================================
// 6. ADMIN DASHBOARD & CONTROLS
// =========================================================
function adminOnly(req, res, next) {
  if (Number(req.user.id) !== ADMIN_ID) {
    return res.status(403).json({ ok: false, message: "Admin access required" });
  }
  next();
}

// ዊዝድሮዋል መቆለፊያ እና መክፈቻ (Toggle Lock)
app.post("/api/admin/toggle-withdraw-lock", authMiddleware, adminOnly, (req, res) => {
  DB.settings.withdraw_locked = !DB.settings.withdraw_locked;
  res.json({ ok: true, isLocked: DB.settings.withdraw_locked });
});

// በጀት ያለው የተገደበ ታስክ መፍጠሪያ (Max User Limit)
app.post("/api/admin/create-task", authMiddleware, adminOnly, (req, res) => {
  const { title, url, reward, limit } = req.body;
  const newTask = {
    id: "tsk_" + Date.now(),
    title: title,
    url: url,
    reward: Number(reward),
    limit: Number(limit) || 500,
    claimed: 0,
    active: true
  };
  DB.tasks.push(newTask);
  res.json({ ok: true, task: newTask });
});

// ክፍያ ሲጸድቅ ወደ @proof_chnallel በፎቶ ፖስት ማድረጊያ
app.post("/api/admin/approve-withdrawal", authMiddleware, adminOnly, async (req, res) => {
  const { withdrawalId, screenshotUrl, txCode } = req.body;
  const wd = DB.withdrawals.find(w => w.id === withdrawalId);

  if (!wd) return res.status(404).json({ ok: false, message: "Not found" });

  wd.status = "paid";

  // ወደ Proof Channel ፎቶውን መለጠፍ
  try {
    const caption = `✅ <b>ክፍያ ተፈጽሟል (Payment Confirmed)!</b>\n\n` +
      `👤 ተጠቃሚ: @${wd.username}\n` +
      `💰 መጠን: <b>${wd.amount} ETB</b>\n` +
      `💳 መንገድ: ${wd.method.toUpperCase()}\n` +
      `🧾 የትራንዛክሽን ቁጥር: <code>${txCode || "CBE-BIRR"}</code>\n\n` +
      `🚀 በ @AdewaBot ማስታወቂያ በማየት እርስዎም ተከፋይ ይሁኑ!`;

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: PROOF_CHANNEL,
        photo: screenshotUrl,
        caption: caption,
        parse_mode: "HTML"
      })
    });
  } catch (err) {
    console.error("Proof Channel error:", err);
  }

  res.json({ ok: true, message: "Approved and posted to proof channel" });
});

// ሰርቨሩን ማስነሻ
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Adewa Server live on port ${PORT}`);
});

module.exports = app;
