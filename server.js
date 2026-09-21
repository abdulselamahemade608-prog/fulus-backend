const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// CONFIGURATION & SECRETS
// ==========================================
const BOT_TOKEN = process.env.BOT_TOKEN || "YOUR_BOT_TOKEN_HERE";
const ADMIN_ID = 8845432223; // Fixed Admin Telegram ID
const PROOF_CHANNEL_ID = "@proof_chnallel"; 

// Data Store
const DB = {
  users: {},
  tasks: [
    { id: "task-1", title: "Join Discussion Group", description: "Chat with the community", reward: 0.50, icon: "💬", url: "https://t.me/proof_chnallel", type: "channel" },
    { id: "task-2", title: "Follow Twitter / X", description: "Stay updated with official news", reward: 0.50, icon: "🐦", url: "https://x.com", type: "visit" }
  ],
  promos: {
    "ADEWA2026": { reward: 2.0, claimedBy: [] }
  },
  withdrawals: [],
  settings: {
    min_withdraw: 100,
    referral_reward: 5,
    required_referrals: 1 // በነባሪ 1 ሰው (አድሚኑ ወደ 2፣ 5 መቀየር ይችላል)
  }
};

// ==========================================
// AUTHENTICATION MIDDLEWARE (Telegram initData)
// ==========================================
function authMiddleware(req, res, next) {
  const initData = req.headers["x-telegram-init-data"];
  
  // Local test ካለ dummy user እንስጠው
  if (!initData) {
    req.user = { id: 12345678, first_name: "Test User", username: "tester" };
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
      return res.status(401).json({ ok: false, message: "Invalid Telegram signature." });
    }

    const userData = JSON.parse(urlParams.get("user") || "{}");
    req.user = userData;
    initUser(userData.id, userData);
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, message: "Authentication failed." });
  }
}

// User Initialization
function initUser(id, raw) {
  if (!DB.users[id]) {
    DB.users[id] = {
      id: id,
      telegram_id: id,
      firstName: raw.first_name || "User",
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
// USER ENDPOINTS
// ==========================================

// 1. Get User Profile & State
app.get("/api/me", authMiddleware, (req, res) => {
  const user = DB.users[req.user.id];

  // እኩለ ሌሊት ሲያልፍ ማስታወቂያ reset ማድረጊያ
  const todayStr = new Date().toISOString().slice(0, 10);
  if (user.lastAdDate !== todayStr) {
    user.todayAds = 0;
    user.lastAdDate = todayStr;
  }

  // ተጠቃሚው የጋበዛቸው ሰዎች ዝርዝር
  const userReferrals = Object.values(DB.users).filter(u => u.referredBy === user.id);
  
  // ማስታወቂያ ማየት ሳያስፈልጋቸው በሙሉ ብቁ (Qualified) ሆነው ይቆጠራሉ
  const qualifiedCount = userReferrals.length;

  const userWithdrawals = DB.withdrawals.filter(w => w.telegram_id === user.id);

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
    referralsList: userReferrals.map(r => ({
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
    withdrawalHistory: userWithdrawals,
    isChannelJoined: user.isChannelJoined,
    settings: DB.settings
  });
});

// 2. Watch Ad Reward
app.post("/api/ads/reward", authMiddleware, (req, res) => {
  const user = DB.users[req.user.id];
  const now = Date.now();

  if (now - user.lastAdTimestamp < 20000) {
    return res.status(400).json({ ok: false, message: "Please wait 20s between ads." });
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

// 3. Task Verification
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

  res.json({ ok: true, message: `Task verified! +${task.reward} ETB` });
});

// 4. Lucky Wheel Spin
app.post("/api/wheel/spin", authMiddleware, (req, res) => {
  const user = DB.users[req.user.id];
  const reward = 0.50;
  user.balance += reward;
  res.json({ ok: true, message: `You won ${reward} ETB from the Wheel!` });
});

// 5. Promo Code Redeem
app.post("/api/promo/redeem", authMiddleware, (req, res) => {
  const user = DB.users[req.user.id];
  const { code } = req.body;

  const promo = DB.promos[code];
  if (!promo) return res.status(400).json({ ok: false, message: "Invalid promo code." });
  if (promo.claimedBy.includes(user.id)) {
    return res.status(400).json({ ok: false, message: "Code already claimed by you." });
  }

  promo.claimedBy.push(user.id);
  user.balance += promo.reward;

  res.json({ ok: true, message: `Redeemed! +${promo.reward} ETB added.` });
});

// 6. Request Withdrawal
app.post("/api/withdraw", authMiddleware, (req, res) => {
  const user = DB.users[req.user.id];
  const { amount, method, account } = req.body;

  const userReferrals = Object.values(DB.users).filter(u => u.referredBy === user.id);
  const qualifiedCount = userReferrals.length; // ማስታወቂያ ማየት አያስፈልግም
  const requiredRefs = DB.settings.required_referrals || 1;

  // 1. ሪፈራል ማረጋገጫ (አድሚኑ በሚወስነው መጠን መሰረት)
  if (qualifiedCount < requiredRefs) {
    return res.status(400).json({ 
      ok: false, 
      message: `You need at least ${requiredRefs} referral(s) to withdraw.` 
    });
  }

  // 2. የቻናል ማረጋገጫ
  if (!user.isChannelJoined) {
    return res.status(400).json({ ok: false, message: "You must join the official channel." });
  }

  // 3. የዝቅተኛ ብር መጠን ማረጋገጫ
  const minWithdraw = DB.settings.min_withdraw || 100;
  if (amount < minWithdraw) {
    return res.status(400).json({ ok: false, message: `Minimum withdrawal is ${minWithdraw} ETB.` });
  }

  if (user.balance < amount) {
    return res.status(400).json({ ok: false, message: "Insufficient account balance." });
  }

  user.balance -= amount;

  const record = {
    id: "wd_" + Date.now(),
    telegram_id: user.id,
    username: user.username || user.firstName,
    amount: amount,
    method: method,
    account_number: account,
    status: "pending",
    date: new Date().toISOString()
  };

  DB.withdrawals.unshift(record);

  res.json({ ok: true, message: "Withdrawal request submitted for review." });
});

// ==========================================
// ADMIN DASHBOARD & CONTROLS
// ==========================================

function adminOnly(req, res, next) {
  if (Number(req.user.id) !== ADMIN_ID) {
    return res.status(403).json({ ok: false, message: "Access denied. Admin only." });
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

  try {
    const caption = `✅ <b>Withdrawal Paid Successfully!</b>\n\n` +
      `👤 <b>User:</b> @${item.username || item.telegram_id}\n` +
      `💰 <b>Amount:</b> ${item.amount} ETB\n` +
      `💳 <b>Method:</b> ${item.method.toUpperCase()}\n` +
      `🧾 <b>Tx ID:</b> <code>${transactionId || "N/A"}</code>\n\n` +
      `🚀 Join @AdewaBot and start earning!`;

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: PROOF_CHANNEL_ID,
        photo: screenshotUrl,
        caption: caption,
        parse_mode: "HTML"
      })
    });
  } catch (err) {
    console.error("Telegram post error:", err);
  }

  res.json({ ok: true, message: "Approved and posted to proof channel!" });
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

// አድሚኑ ሚኒመም ዊዝድሮዋልን፣ ሪፈራል ሪዋርድን እና የሚያስፈልገውን የሰው ብዛት (1፣ 2፣ 5...) የሚቀይርበት
app.post("/api/admin/settings", authMiddleware, adminOnly, (req, res) => {
  const { referral_reward, min_withdraw, required_referrals } = req.body;
  if (referral_reward !== undefined) DB.settings.referral_reward = Number(referral_reward);
  if (min_withdraw !== undefined) DB.settings.min_withdraw = Number(min_withdraw);
  if (required_referrals !== undefined) DB.settings.required_referrals = Number(required_referrals);
  
  res.json({ ok: true, message: "Settings updated successfully." });
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
  res.json({ ok: true, message: "Task created." });
});

app.post("/api/admin/promo", authMiddleware, adminOnly, (req, res) => {
  const { code, reward } = req.body;
  DB.promos[code] = { reward: Number(reward || 1), claimedBy: [] };
  res.json({ ok: true, message: "Promo code created." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
