-- =========================================================
-- FULUSAPP DATABASE
-- PostgreSQL
-- =========================================================


CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,

    telegram_id BIGINT UNIQUE NOT NULL,

    username TEXT,

    first_name TEXT,

    last_name TEXT,

    photo_url TEXT,

    balance NUMERIC(18,2) NOT NULL DEFAULT 0.00,

    referral_code TEXT UNIQUE NOT NULL,

    referred_by BIGINT REFERENCES users(telegram_id),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    last_checkin_date DATE,

    streak INTEGER NOT NULL DEFAULT 0,

    total_earned NUMERIC(18,2) NOT NULL DEFAULT 0.00,

    total_withdrawn NUMERIC(18,2) NOT NULL DEFAULT 0.00
);


-- =========================================================
-- BALANCE TRANSACTIONS
-- =========================================================

CREATE TABLE IF NOT EXISTS transactions (

    id BIGSERIAL PRIMARY KEY,

    telegram_id BIGINT NOT NULL
        REFERENCES users(telegram_id)
        ON DELETE CASCADE,

    type TEXT NOT NULL,

    amount NUMERIC(18,2) NOT NULL,

    balance_before NUMERIC(18,2) NOT NULL,

    balance_after NUMERIC(18,2) NOT NULL,

    reference TEXT,

    description TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- =========================================================
-- TASKS
-- =========================================================

CREATE TABLE IF NOT EXISTS tasks (

    id UUID PRIMARY KEY,

    title TEXT NOT NULL,

    description TEXT,

    icon TEXT DEFAULT '✦',

    type TEXT NOT NULL,

    reward NUMERIC(18,2) NOT NULL DEFAULT 0.00,

    target INTEGER NOT NULL DEFAULT 1,

    url TEXT,

    channel_username TEXT,

    active BOOLEAN NOT NULL DEFAULT TRUE,

    sort_order INTEGER NOT NULL DEFAULT 0,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- =========================================================
-- TASK COMPLETIONS
-- =========================================================

CREATE TABLE IF NOT EXISTS task_completions (

    id BIGSERIAL PRIMARY KEY,

    task_id UUID NOT NULL
        REFERENCES tasks(id)
        ON DELETE CASCADE,

    telegram_id BIGINT NOT NULL
        REFERENCES users(telegram_id)
        ON DELETE CASCADE,

    progress INTEGER NOT NULL DEFAULT 1,

    completed BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(task_id, telegram_id)
);


-- =========================================================
-- REFERRALS
-- =========================================================

CREATE TABLE IF NOT EXISTS referrals (

    id BIGSERIAL PRIMARY KEY,

    referrer_id BIGINT NOT NULL
        REFERENCES users(telegram_id)
        ON DELETE CASCADE,

    referred_id BIGINT UNIQUE NOT NULL
        REFERENCES users(telegram_id)
        ON DELETE CASCADE,

    reward_paid BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- =========================================================
-- WITHDRAWALS
-- =========================================================

CREATE TABLE IF NOT EXISTS withdrawals (

    id UUID PRIMARY KEY,

    telegram_id BIGINT NOT NULL
        REFERENCES users(telegram_id)
        ON DELETE CASCADE,

    amount NUMERIC(18,2) NOT NULL,

    method TEXT NOT NULL,

    account_number TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'pending',

    admin_note TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    processed_at TIMESTAMPTZ
);


-- =========================================================
-- SETTINGS
-- =========================================================

CREATE TABLE IF NOT EXISTS settings (

    key TEXT PRIMARY KEY,

    value TEXT NOT NULL,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- =========================================================
-- DEFAULT SETTINGS
-- =========================================================

INSERT INTO settings(key, value)
VALUES
    ('min_withdraw', '100'),
    ('min_referrals', '5'),
    ('min_account_age_days', '5'),
    ('referral_reward', '5'),
    ('checkin_day_1', '2'),
    ('checkin_day_2', '4'),
    ('checkin_day_3', '5'),
    ('checkin_day_4', '7'),
    ('checkin_day_5', '9'),
    ('checkin_day_6', '11'),
    ('checkin_day_7', '12')
ON CONFLICT(key) DO NOTHING;


-- =========================================================
-- INDEXES
-- =========================================================

CREATE INDEX IF NOT EXISTS idx_users_telegram
ON users(telegram_id);


CREATE INDEX IF NOT EXISTS idx_transactions_user
ON transactions(telegram_id);


CREATE INDEX IF NOT EXISTS idx_tasks_active
ON tasks(active);


CREATE INDEX IF NOT EXISTS idx_withdrawals_user
ON withdrawals(telegram_id);


CREATE INDEX IF NOT EXISTS idx_withdrawals_status
ON withdrawals(status);


CREATE INDEX IF NOT EXISTS idx_referrals_referrer
ON referrals(referrer_id);
