-- =========================================================
-- 2. አዲሱ አስተማማኝና ጠንካራ የ ADEWA DATABASE (NEW RESTRUCTURED)
-- =========================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. USERS TABLE (ጥብቅ ደንበኞች መረጃ፣ IP፣ ቻናል ሁኔታ እና የማጭበርበር መከላከያ)
CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
    telegram_id BIGINT UNIQUE NOT NULL,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    photo_url TEXT,
    balance NUMERIC(18,2) NOT NULL DEFAULT 0.00 CHECK (balance >= 0),
    referral_code TEXT UNIQUE NOT NULL,
    referred_by BIGINT REFERENCES users(telegram_id) ON DELETE SET NULL,
    channel_joined BOOLEAN NOT NULL DEFAULT FALSE,
    registration_ip INET,
    last_ip INET,
    is_banned BOOLEAN NOT NULL DEFAULT FALSE,
    ban_reason TEXT,
    streak INTEGER NOT NULL DEFAULT 0,
    last_checkin_date DATE,
    spins_available INTEGER NOT NULL DEFAULT 0 CHECK (spins_available >= 0),
    total_earned NUMERIC(18,2) NOT NULL DEFAULT 0.00 CHECK (total_earned >= 0),
    total_withdrawn NUMERIC(18,2) NOT NULL DEFAULT 0.00 CHECK (total_withdrawn >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. DAILY AD PROGRESS (በቀን ከ 30 ማስታወቂያ በላይ እንዳይሰሩ እና 2 ሙሉ ቀን ቆጣሪ)
CREATE TABLE daily_ad_progress (
    id BIGSERIAL PRIMARY KEY,
    telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    ad_date DATE NOT NULL DEFAULT CURRENT_DATE,
    ads_watched INTEGER NOT NULL DEFAULT 0 CHECK (ads_watched <= 30),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (telegram_id, ad_date)
);

-- 3. AD LOGS (የማስታወቂያ ማጭበርበር እና Bot / Fast-Click መከላከያ የጊዜ ማረጋገጫ)
CREATE TABLE ad_logs (
    id BIGSERIAL PRIMARY KEY,
    telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    ad_type TEXT NOT NULL DEFAULT 'monetag_rewarded',
    reward NUMERIC(18,2) NOT NULL DEFAULT 0.50,
    ip_address INET,
    watched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. ACTIVE REFERRALS (የ 2 ቀናት 30/30 ማስታወቂያ እና የቻናል ጆይን ማረጋገጫ)
CREATE TABLE referrals (
    id BIGSERIAL PRIMARY KEY,
    referrer_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    referred_id BIGINT UNIQUE NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    is_qualified BOOLEAN NOT NULL DEFAULT FALSE,
    reward_paid BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    qualified_at TIMESTAMPTZ
);

-- 5. BALANCE TRANSACTIONS (የሂሳብ መዛባትን 100% የሚከላከል የኦዲት መዝገብ)
CREATE TABLE transactions (
    id BIGSERIAL PRIMARY KEY,
    telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    type TEXT NOT NULL, -- 'ad_reward', 'referral', 'promo', 'spin', 'withdrawal_hold', 'withdrawal_refund'
    amount NUMERIC(18,2) NOT NULL,
    balance_before NUMERIC(18,2) NOT NULL,
    balance_after NUMERIC(18,2) NOT NULL,
    reference TEXT,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. TASKS TABLE (በአድሚኑ ያለ ኮድ የሚጨመሩ እና የሚስተካከሉ ታስኮች)
CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    description TEXT,
    icon TEXT DEFAULT '✦',
    type TEXT NOT NULL, -- 'channel', 'visit', 'ad', 'survey'
    reward NUMERIC(18,2) NOT NULL DEFAULT 0.00 CHECK (reward >= 0),
    target INTEGER NOT NULL DEFAULT 1,
    url TEXT,
    channel_username TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. TASK COMPLETIONS (ተጠቃሚው አንዴ የሰራው ታስክ ተመልሶ እንዳይመጣ እና እንዳይደገም)
CREATE TABLE task_completions (
    id BIGSERIAL PRIMARY KEY,
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    progress INTEGER NOT NULL DEFAULT 1,
    completed BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(task_id, telegram_id)
);

-- 8. WITHDRAWALS TABLE (የማጭበርበር አመልካች / Risk Score የያዘ የክፍያ ጥያቄ)
CREATE TABLE withdrawals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    amount NUMERIC(18,2) NOT NULL CHECK (amount >= 100.00),
    method TEXT NOT NULL, -- 'telebirr', 'cbe', 'awash'
    account_number TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'paid', 'rejected'
    risk_score INTEGER NOT NULL DEFAULT 0, -- 0 to 100
    risk_reason TEXT,
    proof_image_url TEXT,
    admin_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

-- 9. PROMO CODES (የአጠቃቀም ገደብ እና የአገልግሎት ጊዜ መቆጣጠሪያ)
CREATE TABLE promo_codes (
    code VARCHAR(50) PRIMARY KEY,
    reward NUMERIC(18,2) NOT NULL CHECK (reward > 0),
    max_uses INTEGER DEFAULT NULL,
    used_count INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 10. PROMO REDEMPTIONS (አንድ ተጠቃሚ አንድን ኮድ ከአንዴ በላይ እንዳይጠቀም መቆጣጠሪያ)
CREATE TABLE promo_redemptions (
    id BIGSERIAL PRIMARY KEY,
    code VARCHAR(50) NOT NULL REFERENCES promo_codes(code) ON DELETE CASCADE,
    telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(code, telegram_id)
);

-- 11. SYSTEM SETTINGS
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================================
-- 3. ነባሪ ዋጋዎች (DEFAULT SYSTEM SETTINGS)
-- =========================================================

INSERT INTO settings(key, value) VALUES
('min_withdraw', '100'),
('min_qualified_referrals', '10'),
('referral_reward', '5'),
('ad_reward', '0.50'),
('max_daily_ads', '30'),
('mandatory_channel', '@proof_chnallel'),
('admin_telegram_id', '8845432223')
ON CONFLICT(key) DO NOTHING;

-- የመጀመሪያ ፕሮሞ ኮዶች
INSERT INTO promo_codes (code, reward, max_uses) VALUES 
('ADEWA2026', 10.00, 200),
('WELCOME', 5.00, NULL)
ON CONFLICT (code) DO NOTHING;

-- ግዴታ የሆነው ቻናል በ Tasks ሰንጠረዥ ውስጥ ቋሚ እንዲሆን
INSERT INTO tasks (id, title, description, icon, type, reward, channel_username, sort_order)
VALUES (
    gen_random_uuid(),
    'Join Official Adewa Channel',
    'Mandatory channel subscription required for withdrawals & updates',
    '📢',
    'channel',
    1.00,
    '@proof_chnallel',
    0
);

-- =========================================================
-- 4. ፈጣን ፍተሻ እና ከፍተኛ ደህንነት ማረጋገጫ (INDEXES)
-- =========================================================

CREATE INDEX idx_users_telegram ON users(telegram_id);
CREATE INDEX idx_users_ip ON users(registration_ip);
CREATE INDEX idx_daily_progress_lookup ON daily_ad_progress(telegram_id, ad_date);
CREATE INDEX idx_ad_logs_cooldown ON ad_logs(telegram_id, watched_at DESC);
CREATE INDEX idx_referrals_referrer ON referrals(referrer_id);
CREATE INDEX idx_referrals_qualified ON referrals(referrer_id, is_qualified);
CREATE INDEX idx_transactions_audit ON transactions(telegram_id, created_at DESC);
CREATE INDEX idx_withdrawals_status ON withdrawals(status);
CREATE INDEX idx_promo_active ON promo_codes(code, active);
