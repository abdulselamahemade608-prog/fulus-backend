const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// CONFIGURATION & CONSTANTS
// ==========================================
const BOT_TOKEN = process.env.BOT_TOKEN || "YOUR_BOT_TOKEN_HERE";
const ADMIN_ID = 8845432223; // Fixed Admin ID ከ index.html ጋር እኩል
const PROOF_CHANNEL = "@proof_chnallel";

// In-Memory Database Simulation
const DB = {
  users: {},
  tasks: [
    { 
      id: "task-1", 
      title: "Join Discussion Group", 
      description: "Chat with the community", 
      reward: 0.50, 
      icon: "💬", 
      url: "https://t.me/proof_chnallel", 
      type: "channel" 
    },
    { 
      id: "task-2", 
      title: "Follow Our Updates", 
      description: "Stay tuned for new offers", 
      reward: 0.50, 
      icon: "📢", 
      url: "https://t.me/proof_chnallel", 
      type: "visit" 
    }
  ],
  promos: {
    "ADEWA2026": { reward: 2.0, claimedBy: [] }
  },
  withdrawals: [],
  settings: {
    min_withdraw: 100,
    referral_reward: 5
  }
};

// ==========================================
// AUTHENTICATION (Telegram WebApp initData)
// ==========================================
function authMiddleware(req, res, next) {
  const initData = req.headers["x-telegram-init-data"];

  // ብራውዘር ላይ ለሙከራ እንዲመች (initData ከሌለ)
  if (!initData) {
    req.user = { id: 12345678, first_name: "Demo", username: "demouser" };
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
      return res.status(401).json({ ok: false, message: "Unauthorized request." });
    }

    const userData = JSON.parse(urlParams.get("user") || "{}");
    req.user = userData;
    initUser(userData.id, userData);
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, message: "Authentication failed." });
  }
}

function initUser(id, raw) {
  if (!DB.users[id]) {
    DB.users[id] = {
      id: id,
      telegram_id: id,
      firstName: raw.first_name || "Member",
      username: raw.username || "",
      balance: 0.0,
      todayAds: 0,
      lastAdDate: new Date().toISOString().slice(0, 10),
      lastAdTimestamp: 0,
      referralCode: "ref_" + id,
      referredBy: null,
      completedTasks: [],
      isChannelJoined: false,
      botUsername: "AdewaBot"
    };
  }
}

// ==========================================
// USER API ROUTES
// ==========================================

// 1. Get Current User Status (/api/me)
app.get("/api/me", authMiddleware, (req, res) => {
  const user = DB.users[req.user.id];
  const todayStr = new Date().toISOString().slice(0, 10);

  // የቀን አቆጣጠር ሪሴት (እኩለ ሌሊት ሲያልፍ)
  if (user.lastAdDate !== todayStr) {
    user.todayAds = 0;
    user.lastAdDate = todayStr;
  }

  // ተጠቃሚው የጋበዛቸው ሰዎች
  const myReferrals = Object.values(DB.users).filter(u => u.referredBy === user.id);
  
  // ብቁ የሆነ ሪፈራል ቼክ (30 ማስታወቂያ ያየ እና ቻናል የገባ)
  const qualifiedCount = myReferrals.filter(r => r.todayAds >= 30 && r.isChannelJoined).length;
  const myWithdrawals = DB.withdrawals.filter(w => w.telegram_id === user.id);

  res.json({
    ok: true,
    user: {
      id: user.id,
      firstName: user.firstName,
      username: user.username,
      referralCode: user.referralCode,
      botUsername: user.botUsername
    },
    balance: user.balance,
    todayAds: user.todayAds,
    maxAdsDaily: 30,
    adReward: 0.50,
    referralReward: DB.settings.referral_reward,
    referralsList: myReferrals.map(r => ({
      telegramId: r.id,
      firstName: r.firstName,
      username: r.username,
      day1Ads: r.todayAds,
      day2Ads: 30,
      channelJoined: r.isChannelJoined
    })),
    qualifiedReferralsCount: qualifiedCount,
    tasks: DB.tasks.map(t => ({
      ...t,
      completed: user.completedTasks.includes(t.id)
    })),
    withdrawalHistory: myWithdrawals,
    isChannelJoined: user.isChannelJoined,
    settings: DB.settings
  });
});

// 2. Watch Ad Reward (/api/ads/reward)
app.post("/api/ads/reward", authMiddleware, (req, res) => {
  const user = DB.users[req.user.id];
  const now = Date.now();

  // 20 ሰከንድ Cooldown ማረጋገጫ
  if (now - user.lastAdTimestamp < 20000) {
    return res.status(400).json({ ok: false, message: "Please wait for cooldown." });
  }

  if (user.todayAds >= 30) {
    return res.status(400).json({ ok: false, message: "Daily limit reached (30/30)." });
  }

  user.todayAds += 1;
  user.balance += 0.50;
  user.lastAdTimestamp = now;

  res.json({
    ok: true,
    balance: user.balance,
    todayAds: user.todayAds
  });
});

// 3. Task Verification (/api/tasks/:id/verify)
app.post("/api/tasks/:id/verify", authMiddleware, (req, res) => {
  const user = DB.users[req.user.id];
  const taskId = req.params.id;

  if (taskId === "mandatory-channel") {
    user.isChannelJoined = true;
    user.balance += 1.0;
    return res.json({ ok: true, message: "Channel verified! +1.00 ETB" });
  }

  const task = DB.tasks.find(t => t.id === taskId);
  if (!task) return res.status(404).json({ ok: false, message: "Task not found." });

  if (!user.completedTasks.includes(taskId)) {
    user.completedTasks.push(taskId);
    user.balance += Number(task.reward || 0);
  }

  res.json({ ok: true, message: `Task completed! +${task.reward} ETB` });
});

// 4. Lucky Wheel Spin (/api/wheel/spin)
app.post("/api/wheel/spin", authMiddleware, (req, res) => {
  const user = DB.users[req.user.id];
  const reward = 0.50;
  user.balance += reward;
  res.json({ ok: true, message: `Lucky spin won ${reward} ETB!` });
});

// 5. Promo Code (/api/promo/redeem)
app.post("/api/promo/redeem", authMiddleware, (req, res) => {
  const user = DB.users[req.user.id];
  const { code } = req.body;

  const promo = DB.promos[code];
  if (!promo) return res.status(400).json({ ok: false, message: "Invalid promo code." });
  if (promo.claimedBy.includes(user.id)) {
    return res.status(400).json({ ok: false, message: "You already claimed this code." });
  }

  promo.claimedBy.push(user.id);
  user.balance += promo.reward;

  res.json({ ok: true, message: `Promo redeemed! +${promo.reward} ETB` });
});

// 6. Request Withdrawal (/api/withdraw) - ወደ 1 ሰው የተስተካከለው
app.post("/api/withdraw", authMiddleware, (req, res) => {
  const user = DB.users[req.user.id];
  const { amount, method, account } = req.body;

  const myReferrals = Object.values(DB.users).filter(u => u.referredBy === user.id);
  const qualifiedCount = myReferrals.filter(r => r.todayAds >= 30 && r.isChannelJoined).length;

  // 1 ሰው ብቻ ቼክ ያደርጋል
  if (qualifiedCount < 1) {
    return res.status(400).json({ ok: false, message: "You must have at least 1 qualified referral." });
  }

  if (!user.isChannelJoined) {
    return res.status(400).json({ ok: false, message: "Please join the official channel first." });
  }

  const minWithdraw = DB.settings.min_withdraw || 100;
  if (amount < minWithdraw) {
    return res.status(400).json({ ok: false, message: `Minimum withdrawal is ${minWithdraw} ETB.` });
  }

  if (user.balance < amount) {
    return res.status(400).json({ ok: false, message: "Insufficient balance." });
  }

  user.balance -= amount;

  const withdrawalEntry = {
    id: "wd_" + Date.now(),
    telegram_id: user.id,
    username: user.username || user.firstName,
    amount: amount,
    method: method,
    account_number: account,
    status: "pending",
    date: new Date().toISOString()
  };

  DB.withdrawals.unshift(withdrawalEntry);
  res.json({ ok: true, message: "Withdrawal request submitted." });
});

// ==========================================
// ADMIN ROUTES (/api/admin/...)
// ==========================================

function adminOnly(req, res, next) {
  if (Number(req.user.id) !== ADMIN_ID) {
    return res.status(403).json({ ok: false, message: "Admin authorization required." });
  }
  next();
}

app.get("/api/admin/dashboard", authMiddleware, adminOnly, (req, res) => {
  res.json({
    ok: true,
    pendingWithdrawals: DB.withdrawals.filter(w => w.status === "pending")
  });
});

app.post("/api/admin/withdrawals/:id/approve-with-proof", authMiddleware, adminOnly, async (req, res) => {
  const item = DB.withdrawals.find(w => w.id === req.params.id);
  if (!item) return res.status(404).json({ ok: false, message: "Request not found." });

  const { screenshotUrl, transactionId } = req.body;
  item.status = "paid";

  // ወደ ቴሌግራም ቻናል ፖስት ማድረጊያ
  try {
    const caption = `✅ <b>Withdrawal Approved!</b>\n\n` +
      `👤 <b>User:</b> @${item.username || item.telegram_id}\n` +
      `💰 <b>Amount:</b> ${item.amount} ETB\n` +
      `💳 <b>Method:</b> ${item.method.toUpperCase()}\n` +
      `🧾 <b>Tx ID:</b> <code>${transactionId || "N/A"}</code>\n\n` +
      `🚀 Join @AdewaBot to earn!`;

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
  } catch (e) {
    console.error("Telegram post failed:", e);
  }

  res.json({ ok: true, message: "Approved and posted to proof channel." });
});

app.post("/api/admin/withdrawals/:id/reject", authMiddleware, adminOnly, (req, res) => {
  const item = DB.withdrawals.find(w => w.id === req.params.id);
  if (!item) return res.status(404).json({ ok: false, message: "Request not found." });

  item.status = "rejected";
  if (DB.users[item.telegram_id]) {
    DB.users[item.telegram_id].balance += item.amount;
  }

  res.json({ ok: true, message: "Withdrawal rejected and refunded." });
});

app.post("/api/admin/settings", authMiddleware, adminOnly, (req, res) => {
  const { referral_reward, min_withdraw } = req.body;
  if (referral_reward) DB.settings.referral_reward = Number(referral_reward);
  if (min_withdraw) DB.settings.min_withdraw = Number(min_withdraw);
  res.json({ ok: true, message: "Settings saved." });
});

app.post("/api/admin/tasks", authMiddleware, adminOnly, (req, res) => {
  const { title, url, reward } = req.body;
  DB.tasks.push({
    id: "task_" + Date.now(),
    title,
    url,
    reward: Number(reward || 0.5),
    icon: "📌",
    type: "visit"
  });
  res.json({ ok: true, message: "Task published." });
});

app.post("/api/admin/promo", authMiddleware, adminOnly, (req, res) => {
  const { code, reward } = req.body;
  DB.promos[code] = { reward: Number(reward || 1), claimedBy: [] };
  res.json({ ok: true, message: "Promo generated." });
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

module.exports = app;
