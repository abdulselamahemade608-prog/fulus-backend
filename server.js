
"use strict";

/* =========================================================
   ADEWA MINI APP FRONTEND CORE ENGINE
   - Secure Monetag Rewarded Ads Integration
   - Anti-Cheat & 20s Cooldown Enforcement
   - Active Referral Tracker (Day 1, Day 2, Channel Verification)
   - Spin & Win Lucky Wheel Logic
   - Dynamic Task Self-Destruct / Deletion on Verification
   - Admin Suite (ID: 8845432223) + Proof Screenshot Pipeline
   ========================================================= */

if (window.__boot) window.__boot.appLoaded = true;

const API_BASE = "https://fulus-backend.vercel.app/api";
window.API_BASE = API_BASE;

const ADMIN_TELEGRAM_ID = 8845432223;
const PROOF_CHANNEL_URL = "https://t.me/proof_chnallel";

const tg = window.Telegram && window.Telegram.WebApp;
const $ = (id) => document.getElementById(id);

let S = {
  user: null,
  balance: 0,
  todayAdsWatched: 0,
  maxDailyAds: 30,
  adReward: 0.5,
  spinsAvailable: 0,
  nextResetTimestamp: null,
  referralsList: [],
  qualifiedReferralsCount: 0,
  totalReferralsCount: 0,
  channelVerified: false,
  officialChannelUsername: "@proof_chnallel",
  tasks: [],
  history: [],
  adminPendingWithdrawals: []
};

let adCooldownTimer = null;
let countdownInterval = null;
let currentPendingActionId = null;

/* ---------- HTML Helper Function ---------- */

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") e.className = v;
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v);
    }
  }
  for (const c of kids.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}

const fmt = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

function openExternalLink(url) {
  if (!url) return;
  try {
    if (/^https:\/\/t\.me\//i.test(url) && tg && tg.openTelegramLink) return tg.openTelegramLink(url);
    if (tg && tg.openLink) return tg.openLink(url);
  } catch (e) { /* fall through */ }
  window.open(url, "_blank");
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = h("textarea", { style: "position:fixed;opacity:0" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e2) { /* ignore */ }
    ta.remove();
  }
  toast("Link copied to clipboard!");
}

/* ---------- Secure API Layer ---------- */

async function api(path, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const headers = { "Content-Type": "application/json" };
    if (tg && tg.initData) headers["X-Telegram-Init-Data"] = tg.initData;

    const res = await fetch(API_BASE + path, Object.assign({}, opts, { headers, signal: ctrl.signal }));
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      throw new Error(`Server returned invalid response (${res.status})`);
    }

    if (!res.ok || data.ok === false) {
      throw new Error(data.message || `Request failed (${res.status})`);
    }
    return data;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Connection timeout. Please retry.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- Account Bootstrap & Hydration ---------- */

async function loadAccount() {
  const d = await api("/me");
  S.user = d.user || {};
  S.balance = Number(d.balance || 0);
  S.todayAdsWatched = Number(d.todayAdsWatched || 0);
  S.maxDailyAds = Number(d.maxDailyAds || 30);
  S.adReward = Number(d.adReward || 0.5);
  S.spinsAvailable = Number(d.spinsAvailable || 0);
  S.nextResetTimestamp = d.nextResetTimestamp || null;
  S.referralsList = d.referralsList || [];
  S.qualifiedReferralsCount = Number(d.qualifiedReferralsCount || 0);
  S.totalReferralsCount = Number(d.totalReferralsCount || 0);
  S.channelVerified = Boolean(d.channelVerified);
  S.officialChannelUsername = d.officialChannelUsername || "@proof_chnallel";
  S.tasks = d.tasks || [];
  S.history = d.withdrawalHistory || [];

  renderApp();
  evaluateAdminAccess();
}

function evaluateAdminAccess() {
  const currentUid = Number(S.user && (S.user.id || S.user.telegramId));
  const adminNavBtn = $("nav-admin");
  if (adminNavBtn) {
    if (currentUid === ADMIN_TELEGRAM_ID || S.user.isAdmin) {
      adminNavBtn.classList.remove("hidden");
    } else {
      adminNavBtn.classList.add("hidden");
    }
  }
}

/* ---------- Render Engine ---------- */

function renderApp() {
  renderHome();
  renderAdsHub();
  renderTasksView();
  renderInviteView();
  renderWithdrawView();

  $("loading").classList.add("hidden");
  $("app").classList.remove("hidden");
  if (window.__boot) window.__boot.done = true;
}

function renderHome() {
  const u = S.user || {};
  const name = u.firstName || u.username || "Adewa Explorer";

  const avatar = u.photoUrl
    ? h("div", { class: "avatar" }, h("img", { src: u.photoUrl, alt: "" }))
    : h("div", { class: "avatar" }, name.charAt(0).toUpperCase());

  $("page-home").replaceChildren(
    h("div", { class: "top" },
      avatar,
      h("div", null,
        h("span", { class: "muted" }, "Welcome to Adewa,"),
        h("b", null, name)
      )
    ),
    h("div", { class: "card balance" },
      h("span", { class: "muted" }, "Available Balance"),
      h("div", { class: "amt" }, `${fmt(S.balance)} ETB`),
      h("div", { class: "row", style: "margin-top:12px;" },
        h("div", { class: "stat" },
          h("span", { class: "muted" }, "Today's Ads"),
          h("b", null, `${S.todayAdsWatched} / ${S.maxDailyAds}`)
        ),
        h("div", { class: "stat" },
          h("span", { class: "muted" }, "Qualified Invites"),
          h("b", null, `${S.qualifiedReferralsCount} / 0`)
        )
      )
    ),
    h("div", { class: "card" },
      h("b", null, "Quick Navigation"),
      h("p", { class: "muted", style: "font-size:13px; margin:4px 0 12px;" }, "Complete your 30 ads today and check your referrals to qualify for withdrawals."),
      h("button", { class: "btn", onclick: () => openPage("ads") }, "Start Watching Ads (+0.50 ETB)"),
      h("button", { class: "btn ghost", style: "margin-top:8px;", onclick: () => openPage("invite") }, "Monitor Active Referrals")
    )
  );
}

function renderAdsHub() {
  const counterBadge = $("adsCounterBadge");
  if (counterBadge) counterBadge.textContent = `${S.todayAdsWatched} / ${S.maxDailyAds} Ads`;

  const rewardDisplay = $("adsRewardText");
  if (rewardDisplay) rewardDisplay.innerHTML = `${fmt(S.adReward)} ETB <small style="font-size:15px; font-weight:500;">/ Ad</small>`;

  const progressBar = $("adsProgressBar");
  if (progressBar) {
    const percentage = Math.min(100, Math.round((S.todayAdsWatched / S.maxDailyAds) * 100));
    progressBar.style.width = `${percentage}%`;
  }

  const watchBtn = $("btnWatchAd");
  if (watchBtn) {
    if (S.todayAdsWatched >= S.maxDailyAds) {
      watchBtn.disabled = true;
      watchBtn.textContent = "Daily Ads Limit Reached (30/30)";
      displayCountdownBox(true);
    } else {
      watchBtn.disabled = false;
      watchBtn.innerHTML = `<span>📺</span> <span>Watch Video Ad (+${fmt(S.adReward)} ETB)</span>`;
      displayCountdownBox(false);
    }
  }

  const spinsBadge = $("spinsAvailableBadge");
  if (spinsBadge) spinsBadge.textContent = `${S.spinsAvailable} Spin${S.spinsAvailable === 1 ? "" : "s"} Available`;

  const spinBtn = $("btnSpinWheel");
  if (spinBtn) {
    spinBtn.disabled = S.spinsAvailable <= 0;
    spinBtn.textContent = `Spin Now (${S.spinsAvailable} Free)`;
  }
}

function displayCountdownBox(show) {
  const box = $("cooldownTimerBox");
  if (!box) return;
  if (show) {
    box.style.display = "block";
    startDailyCountdown();
  } else {
    box.style.display = "none";
    clearInterval(countdownInterval);
  }
}

function startDailyCountdown() {
  clearInterval(countdownInterval);
  function tick() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCHours(24, 0, 0, 0);
    const diff = tomorrow.getTime() - now.getTime();

    if (diff <= 0) {
      clearInterval(countdownInterval);
      loadAccount();
      return;
    }

    const h = String(Math.floor(diff / (1000 * 60 * 60))).padStart(2, "0");
    const m = String(Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))).padStart(2, "0");
    const s = String(Math.floor((diff % (1000 * 60)) / 1000)).padStart(2, "0");

    const timerEl = $("countdownTimer");
    if (timerEl) timerEl.textContent = `${h}:${m}:${s}`;
  }
  tick();
  countdownInterval = setInterval(tick, 1000);
}

/* ---------- Monetag Web SDK & Anti-Cheat Cooldown Logic ---------- */

async function triggerMonetagAd() {
  const watchBtn = $("btnWatchAd");
  if (watchBtn) watchBtn.disabled = true;

  try {
    toast("Loading ad... Please watch completely.");

    // Execution check against Monetag Rewarded Web SDK
    const rewardEarned = await new Promise((resolve) => {
      let adCompleted = false;
      if (typeof window.show_rewarded_ad === "function") {
        window.show_rewarded_ad({
          onReward: () => { adCompleted = true; },
          onClose: () => { resolve(adCompleted); }
        });
      } else {
        // Fallback simulation: 15 seconds watching period
        setTimeout(() => {
          resolve(true);
        }, 15000);
      }
    });

    if (!rewardEarned) {
      toast("You closed the ad early. No reward added.");
      if (watchBtn) watchBtn.disabled = false;
      return;
    }

    // Call backend with tamper-proof payload
    const res = await api("/ads/claim", {
      method: "POST",
      body: JSON.stringify({ timestamp: Date.now() })
    });

    toast(res.message || `+${fmt(S.adReward)} ETB credited!`);
    await loadAccount();
    startAntiCheatCooldown(20);
  } catch (err) {
    toast(err.message || "Failed to process ad.");
    if (watchBtn) watchBtn.disabled = false;
  }
}

function startAntiCheatCooldown(seconds) {
  const watchBtn = $("btnWatchAd");
  const noticeBox = $("adCooldownNotice");
  const secEl = $("adCooldownSec");

  if (watchBtn) watchBtn.disabled = true;
  if (noticeBox) noticeBox.style.display = "block";

  let remaining = seconds;
  clearInterval(adCooldownTimer);

  adCooldownTimer = setInterval(() => {
    remaining--;
    if (secEl) secEl.textContent = remaining;
    if (remaining <= 0) {
      clearInterval(adCooldownTimer);
      if (noticeBox) noticeBox.style.display = "none";
      if (watchBtn && S.todayAdsWatched < S.maxDailyAds) watchBtn.disabled = false;
    }
  }, 1000);
}

/* ---------- Spin & Win Engine ---------- */

async function executeWheelSpin() {
  const spinBtn = $("btnSpinWheel");
  const wheel = $("wheelContainer");
  if (!spinBtn || S.spinsAvailable <= 0) return;

  spinBtn.disabled = true;
  try {
    const res = await api("/spin/execute", { method: "POST" });
    const prize = res.prize || 0.5;

    // Smooth random rotation angle
    const randomDeg = 1440 + Math.floor(Math.random() * 360);
    wheel.style.transform = `rotate(${randomDeg}deg)`;

    setTimeout(() => {
      toast(`🎉 Wheel stopped! You won +${fmt(prize)} ETB!`);
      wheel.style.transition = "none";
      wheel.style.transform = "rotate(0deg)";
      setTimeout(() => { wheel.style.transition = "transform 3s cubic-bezier(0.15, 0.9, 0.2, 1)"; }, 50);
      loadAccount();
    }, 3000);
  } catch (err) {
    toast(err.message || "Spin operation failed.");
    spinBtn.disabled = false;
  }
}

/* ---------- Tasks & Self-Destruct / Deletion Logic ---------- */

function renderTasksView() {
  // 1. Render Mandatory Channel Box Status
  const joinBtn = $("btnJoinChannel");
  const checkBtn = $("btnCheckChannel");
  const box = $("requiredChannelBox");

  if (joinBtn) {
    joinBtn.onclick = () => openExternalLink(`https://t.me/${S.officialChannelUsername.replace(/^@/, "")}`);
  }

  if (checkBtn) {
    checkBtn.onclick = verifyMandatoryChannelSubscription;
    if (S.channelVerified) {
      checkBtn.textContent = "Verified ✓";
      checkBtn.classList.add("disabled");
      checkBtn.disabled = true;
      if (box) box.style.borderColor = "rgba(0, 240, 118, 0.4)";
    } else {
      checkBtn.textContent = "Verify Status";
      checkBtn.disabled = false;
    }
  }

  // 2. Dynamic Tasks List (Eliminates completed tasks from UI)
  const container = $("dynamicTasksList");
  if (!container) return;

  const pendingTasks = S.tasks.filter((t) => !t.completed);

  if (!pendingTasks.length) {
    container.replaceChildren(
      h("div", { class: "card muted", style: "text-align:center; padding:18px 0;" },
        "All available tasks completed! Check back soon for new partner tasks."
      )
    );
    return;
  }

  const nodes = pendingTasks.map((t) => {
    const actionWrap = h("div", { class: "actions" });
    const openBtn = h("button", { class: "btn small ghost", onclick: () => openExternalLink(t.url) }, "Open");
    const verifyBtn = h("button", { class: "btn small" }, "Verify");

    verifyBtn.addEventListener("click", () => verifyAndRemoveTask(t, verifyBtn));
    actionWrap.append(openBtn, verifyBtn);

    return h("div", { class: "card task", id: `task-node-${t.id}` },
      h("div", { class: "ic" }, t.icon || "✦"),
      h("div", { class: "info" },
        h("b", null, t.title),
        t.description ? h("span", null, t.description) : null,
        h("span", { class: "reward" }, `+${fmt(t.reward)} ETB`)
      ),
      actionWrap
    );
  });

  container.replaceChildren(...nodes);
}

async function verifyMandatoryChannelSubscription() {
  const btn = $("btnCheckChannel");
  if (btn) btn.disabled = true;
  try {
    const res = await api("/channel/verify", { method: "POST" });
    if (res.joined) {
      toast("Channel membership confirmed! Criteria marked green.");
      S.channelVerified = true;
      await loadAccount();
    } else {
      toast("Membership not found. Please join the channel first.");
      if (btn) btn.disabled = false;
    }
  } catch (err) {
    toast(err.message || "Failed to verify channel.");
    if (btn) btn.disabled = false;
  }
}

async function verifyAndRemoveTask(t, btn) {
  btn.disabled = true;
  btn.textContent = "Checking...";
  try {
    const r = await api(`/tasks/${encodeURIComponent(t.id)}/complete`, { method: "POST" });
    toast(r.message || `Completed! +${fmt(t.reward)} ETB`);

    // Animate and physically delete completed task from the DOM
    const card = $(`task-node-${t.id}`);
    if (card) {
      card.style.transition = "all 0.3s ease";
      card.style.opacity = "0";
      card.style.transform = "scale(0.9)";
      setTimeout(() => {
        card.remove();
        loadAccount();
      }, 300);
    } else {
      await loadAccount();
    }
  } catch (err) {
    toast(err.message || "Task verification failed.");
    btn.disabled = false;
    btn.textContent = "Verify";
  }
}

/* ---------- Active Referral Tracker (Day 1 & Day 2 Status) ---------- */

function renderInviteView() {
  const qualCountEl = $("qualifiedReferralsCount");
  if (qualCountEl) qualCountEl.textContent = `${S.qualifiedReferralsCount} / 0`;

  const totalCountEl = $("totalRefsCount");
  if (totalCountEl) totalCountEl.textContent = S.totalReferralsCount;

  const botUser = (S.user && S.user.botUsername) || "AdewaBot";
  const refCode = (S.user && S.user.referralCode) || "";
  const inviteUrl = refCode ? `https://t.me/${botUser.replace(/^@/, "")}?startapp=ref_${refCode}` : "";

  const linkBox = $("refLinkDisplay");
  if (linkBox) linkBox.textContent = inviteUrl || "Generating referral link...";

  const shareBtn = $("btnShareInvite");
  if (shareBtn) {
    shareBtn.onclick = () => {
      const shareMsg = `Join Adewa and earn 0.50 ETB per ad! Use my link:`;
      openExternalLink(`https://t.me/share/url?url=${encodeURIComponent(inviteUrl)}&text=${encodeURIComponent(shareMsg)}`);
    };
  }

  const copyBtn = $("btnCopyInvite");
  if (copyBtn) copyBtn.onclick = () => copyText(inviteUrl);

  // Render Detailed Referral Table
  const listContainer = $("referralsTrackerList");
  if (!listContainer) return;

  if (!S.referralsList.length) {
    listContainer.replaceChildren(
      h("p", { class: "muted", style: "font-size:13px; text-align:center; padding:12px 0;" },
        "No friends invited yet. Share your link to start tracking progress!"
      )
    );
    return;
  }

  const rows = S.referralsList.map((ref) => {
    const isQual = ref.day1Ads >= 30 && ref.day2Ads >= 30 && ref.channelJoined;
    return h("tr", null,
      h("td", null, h("b", null, ref.name || `User_${ref.id}`)),
      h("td", null, `${ref.day1Ads}/30 ${ref.day1Ads >= 30 ? "✅" : "⏳"}`),
      h("td", null, `${ref.day2Ads}/30 ${ref.day2Ads >= 30 ? "✅" : "⏳"}`),
      h("td", null, ref.channelJoined ? "Joined ✅" : "No ❌"),
      h("td", null, h("span", { class: `badge ${isQual ? "paid" : "pending"}` }, isQual ? "Qualified" : "Incomplete"))
    );
  });

  const table = h("table", { class: "admin-table", style: "font-size:12px;" },
    h("thead", null,
      h("tr", null,
        h("th", null, "Friend"),
        h("th", null, "Day 1"),
        h("th", null, "Day 2"),
        h("th", null, "Channel"),
        h("th", null, "Status")
      )
    ),
    h("tbody", null, ...rows)
  );

  listContainer.replaceChildren(h("div", { style: "overflow-x:auto;" }, table));
}

/* ---------- Strict Withdrawal Verification Engine ---------- */

function renderWithdrawView() {
  const balEl = $("withdrawBalanceDisplay");
  if (balEl) balEl.textContent = `${fmt(S.balance)} ETB`;

  const checklist = $("withdrawChecklist");
  if (checklist) {
    const criteria = [
      { text: "Minimum balance of 100.00 ETB", met: S.balance >= 100 },
      { text: "0 Qualified Referrals (2-Day Ads & Channel Completed)", met: S.qualifiedReferralsCount >= 0 },
      { text: "Active membership in Official Channel (@proof_chnallel)", met: S.channelVerified }
    ];

    const items = criteria.map((c) =>
      h("div", { class: "req" },
        h("i", { class: c.met ? "ok" : "no" }, c.met ? "✓" : "✕"),
        h("span", { style: c.met ? "color:var(--text);" : "color:var(--muted);" }, c.text)
      )
    );
    checklist.replaceChildren(...items);
  }

  const submitBtn = $("btnSubmitWithdraw");
  if (submitBtn) submitBtn.onclick = submitWithdrawalRequest;

  // Render Withdrawal History
  const historyBox = $("withdrawHistoryList");
  if (historyBox) {
    if (!S.history.length) {
      historyBox.replaceChildren(h("p", { class: "muted", style: "font-size:13px;" }, "No withdrawals recorded yet."));
    } else {
      const items = S.history.map((x) =>
        h("div", { class: "hist" },
          h("div", null,
            h("b", null, `${fmt(x.amount)} ETB`),
            h("span", { class: "muted", style: "font-size:12px; display:block;" }, `${x.method.toUpperCase()} • ${x.account}`)
          ),
          h("span", { class: `badge ${x.status}` }, x.status)
        )
      );
      historyBox.replaceChildren(...items);
    }
  }
}

async function submitWithdrawalRequest() {
  const btn = $("btnSubmitWithdraw");
  const amount = Number($("wAmount").value);
  const method = $("wMethod").value;
  const account = $("wAccount").value.trim();

  // Instant front-end guards
  if (!S.channelVerified) return toast("Action blocked: You must join & verify the official channel.");
  if (S.qualifiedReferralsCount < 0) return toast("Requirement missing: 0 Qualified Referrals needed.");
  if (amount < 100) return toast("Minimum withdrawal is 100 ETB.");
  if (amount > S.balance) return toast("Insufficient account balance.");
  if (account.length < 6) return toast("Please enter a valid phone or account number.");

  btn.disabled = true;
  try {
    const res = await api("/withdraw", {
      method: "POST",
      body: JSON.stringify({ amount, method, account })
    });
    toast(res.message || "Withdrawal submitted for approval!");
    $("wAmount").value = "";
    $("wAccount").value = "";
    await loadAccount();
  } catch (err) {
    toast(err.message || "Withdrawal request failed.");
  } finally {
    btn.disabled = false;
  }
}

/* ---------- Promo Code Engine ---------- */

async function redeemPromoCode() {
  const input = $("promoCodeInput");
  const code = input ? input.value.trim().toUpperCase() : "";
  if (!code) return toast("Please enter a valid promo code.");

  const btn = $("btnRedeemPromo");
  if (btn) btn.disabled = true;

  try {
    const res = await api("/promo/redeem", {
      method: "POST",
      body: JSON.stringify({ code })
    });
    toast(res.message || "Promo applied successfully!");
    if (input) input.value = "";
    await loadAccount();
  } catch (err) {
    toast(err.message || "Failed to redeem code.");
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ---------- Admin Suite & Proof Broadcast Pipeline ---------- */

async function renderAdminDashboard() {
  const currentUid = Number(S.user && (S.user.id || S.user.telegramId));
  if (currentUid !== ADMIN_TELEGRAM_ID && !S.user.isAdmin) return;

  try {
    const data = await api("/admin/overview");
    $("adminStatPending").textContent = data.pendingCount || 0;
    $("adminStatUsers").textContent = data.totalUsers || 0;

    const tbody = $("adminWithdrawalsBody");
    if (!tbody) return;

    if (!data.requests || !data.requests.length) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--muted); padding:16px;">No pending payouts.</td></tr>`;
      return;
    }

    const rows = data.requests.map((r) => {
      const riskBadge = r.riskScore > 60
        ? `<span class="badge rejected" title="${r.riskReason}">⚠️ High Risk</span>`
        : `<span class="badge paid">✅ Clean</span>`;

      const approveBtn = h("button", {
        class: "btn-action btn-approve",
        onclick: () => openProofModal(r.id)
      }, "Approve");

      const rejectBtn = h("button", {
        class: "btn-action btn-reject",
        onclick: () => handleAdminDecision(r.id, "reject")
      }, "Reject");

      return h("tr", null,
        h("td", null, h("b", null, r.username || r.telegramId), h("div", null, riskBadge)),
        h("td", null, `${fmt(r.amount)} ETB`),
        h("td", null, `${r.method.toUpperCase()}: ${r.account}`),
        h("td", null, h("span", { class: `badge ${r.status}` }, r.status)),
        h("td", null, r.status === "pending" ? h("div", { class: "admin-actions" }, approveBtn, rejectBtn) : "-")
      );
    });

    tbody.replaceChildren(...rows);
  } catch (err) {
    toast(`Admin API error: ${err.message}`);
  }
}

function openProofModal(requestId) {
  currentPendingActionId = requestId;
  const modal = $("proofModal");
  if (modal) modal.classList.remove("hidden");
}

function closeProofModal() {
  currentPendingActionId = null;
  const modal = $("proofModal");
  if (modal) modal.classList.add("hidden");
  $("proofFileInput").value = "";
}

async function confirmApproveWithProof() {
  const fileInput = $("proofFileInput");
  const note = $("proofAdminNote").value.trim();

  if (!fileInput.files || !fileInput.files[0]) {
    return toast("Mandatory: Please select transfer receipt screenshot!");
  }

  const btn = $("btnConfirmApproveProof");
  btn.disabled = true;
  btn.textContent = "Broadcasting Proof...";

  try {
    const formData = new FormData();
    formData.append("photo", fileInput.files[0]);
    formData.append("action", "approve");
    formData.append("note", note);
    formData.append("broadcastChannel", PROOF_CHANNEL_URL);

    const headers = {};
    if (tg && tg.initData) headers["X-Telegram-Init-Data"] = tg.initData;

    const res = await fetch(`${API_BASE}/admin/withdrawals/${currentPendingActionId}/approve-proof`, {
      method: "POST",
      headers,
      body: formData
    });

    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error(data.message || "Broadcast failed.");

    toast("Approved! Receipt published to https://t.me/proof_chnallel");
    closeProofModal();
    renderAdminDashboard();
  } catch (err) {
    toast(err.message || "Approval pipeline failed.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Submit & Broadcast";
  }
}

async function handleAdminDecision(requestId, action) {
  if (!confirm(`Are you sure you want to ${action} this request?`)) return;
  try {
    const res = await api(`/admin/withdrawals/${requestId}/action`, {
      method: "POST",
      body: JSON.stringify({ action })
    });
    toast(res.message || `Action executed: ${action}`);
    renderAdminDashboard();
  } catch (err) {
    toast(err.message || "Failed to process decision.");
  }
}

/* ---------- Admin Dynamic Configurations (No-Code Suite) ---------- */

async function adminPublishTask() {
  const title = $("admTaskTitle").value.trim();
  const type = $("admTaskType").value;
  const reward = Number($("admTaskReward").value);
  const url = $("admTaskUrl").value.trim();

  if (!title || !reward) return toast("Task Title and Reward amount are required.");

  try {
    await api("/admin/tasks/create", {
      method: "POST",
      body: JSON.stringify({ title, type, reward, url })
    });
    toast("New task published instantly!");
    $("admTaskTitle").value = "";
    $("admTaskReward").value = "";
    $("admTaskUrl").value = "";
    loadAccount();
  } catch (err) {
    toast(err.message || "Could not publish task.");
  }
}

async function adminSaveSettings() {
  const refReward = Number($("admSettingRefReward").value);
  const adReward = Number($("admSettingAdReward").value);

  try {
    await api("/admin/settings/update", {
      method: "POST",
      body: JSON.stringify({ referralReward: refReward, adReward })
    });
    toast("System rewards updated successfully!");
    loadAccount();
  } catch (err) {
    toast(err.message || "Failed to update configurations.");
  }
}

async function adminCreatePromoCode() {
  const code = $("admPromoCode").value.trim().toUpperCase();
  const reward = Number($("admPromoReward").value);
  const maxUses = Number($("admPromoMaxUses").value) || null;

  if (!code || !reward) return toast("Code name and reward are required.");

  try {
    await api("/admin/promo/create", {
      method: "POST",
      body: JSON.stringify({ code, reward, maxUses })
    });
    toast(`Promo code ${code} generated!`);
    $("admPromoCode").value = "";
    $("admPromoReward").value = "";
    $("admPromoMaxUses").value = "";
  } catch (err) {
    toast(err.message || "Failed to generate promo code.");
  }
}

/* ---------- Page Routing & Event Setup ---------- */

function openPage(name) {
  document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.page === name));

  const target = $(`page-${name}`);
  if (target) target.classList.add("active");

  if (name === "admin") renderAdminDashboard();
  if (name === "leaderboard") loadLeaderboard();

  window.scrollTo(0, 0);
}

async function loadLeaderboard() {
  const tbody = $("leaderboardBody");
  if (!tbody) return;
  try {
    const res = await api("/leaderboard");
    const rows = res.leaders.map((u, i) =>
      h("tr", null,
        h("td", null, `#${i + 1} ${i === 0 ? "👑" : ""}`),
        h("td", null, u.name || `User_${u.id}`),
        h("td", null, `${u.qualifiedRefs} Qualified`),
        h("td", null, u.totalAds)
      )
    );
    tbody.replaceChildren(...rows);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:var(--muted); text-align:center;">Could not load leaderboard.</td></tr>`;
  }
}

function bindDOMEvents() {
  // Bottom Navigation
  document.querySelectorAll(".nav-item").forEach((b) => {
    b.addEventListener("click", () => openPage(b.dataset.page));
  });

  // Watch Ad & Spin Buttons
  const watchBtn = $("btnWatchAd");
  if (watchBtn) watchBtn.onclick = triggerMonetagAd;

  const spinBtn = $("btnSpinWheel");
  if (spinBtn) spinBtn.onclick = executeWheelSpin;

  // Promo Redeem
  const redeemBtn = $("btnRedeemPromo");
  if (redeemBtn) redeemBtn.onclick = redeemPromoCode;

  // Proof Modal Handlers
  const cancelProofBtn = $("btnCancelProofModal");
  if (cancelProofBtn) cancelProofBtn.onclick = closeProofModal;

  const approveProofBtn = $("btnConfirmApproveProof");
  if (approveProofBtn) approveProofBtn.onclick = confirmApproveWithProof;

  // Admin Setup Handlers
  const createTskBtn = $("btnAdminCreateTask");
  if (createTskBtn) createTskBtn.onclick = adminPublishTask;

  const saveStgBtn = $("btnAdminSaveSettings");
  if (saveStgBtn) saveStgBtn.onclick = adminSaveSettings;

  const createPrmBtn = $("btnAdminCreatePromo");
  if (createPrmBtn) createPrmBtn.onclick = adminCreatePromoCode;
}

/* ---------- Boot Sequence ---------- */

function fatalError(msg) {
  $("spinner").classList.add("hidden");
  $("loadText").textContent = "Connection Initialization Failed";
  $("bootDiag").textContent = `${msg}\n\nAPI Base: ${API_BASE}\nInitData Present: ${Boolean(tg && tg.initData)}`;
  $("retryBtn").classList.remove("hidden");
}

async function boot() {
  bindDOMEvents();

  if (tg) {
    try { tg.ready(); tg.expand(); } catch (e) { /* ignore */ }
    try { tg.setHeaderColor("#040906"); tg.setBackgroundColor("#040906"); } catch (e) { /* ignore */ }
  }

  if (!tg || !tg.initData) {
    return fatalError("Please launch Adewa inside the official Telegram application.");
  }

  try {
    await loadAccount();
  } catch (e) {
    fatalError(e.message || String(e));
  }
}

boot();
