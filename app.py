import os
import json
import hmac
import hashlib
import secrets
import requests
from uuid import uuid4
from decimal import Decimal
from functools import wraps
from datetime import datetime, timezone, timedelta
from urllib.parse import parse_qsl
from zoneinfo import ZoneInfo

import psycopg2
from psycopg2.extras import RealDictCursor
from flask import Flask, request, jsonify, g


# ============================================================
# ADEWA - SERVER
# Flask + PostgreSQL + Telegram Bot API
# ============================================================

app = Flask(__name__)

# ------------------------------------------------------------
# ENVIRONMENT
# ------------------------------------------------------------

BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()

ADMIN_ID = int(os.getenv("ADMIN_ID", "8845432223"))
PROOF_CHANNEL = os.getenv("PROOF_CHANNEL", "@proof_chnallel")

BOT_USERNAME = os.getenv("BOT_USERNAME", "").strip().lstrip("@")
WEBAPP_URL = os.getenv("WEBAPP_URL", "").strip()

WEBHOOK_SECRET = os.getenv("WEBHOOK_SECRET", "").strip()

CHANNEL_CACHE_TTL = int(
    os.getenv("CHANNEL_CACHE_TTL_SECONDS", "600")
)

AD_MIN_SECONDS = int(
    os.getenv("AD_MIN_SECONDS", "5")
)

AD_SESSION_TIMEOUT_MINUTES = int(
    os.getenv("AD_SESSION_TIMEOUT_MINUTES", "30")
)

AD_COOLDOWN_SECONDS = int(
    os.getenv("AD_COOLDOWN_SECONDS", "20")
)

DB_SSLMODE = os.getenv("DATABASE_SSLMODE", "require")

DB_READY = False

ADDIS_TIMEZONE = ZoneInfo("Africa/Addis_Ababa")


# ============================================================
# DEFAULT SETTINGS
# ============================================================

DEFAULT_SETTINGS = {
    "ad_reward": "0.50",
    "referral_reward": "1.00",
    "referral_required": "10",

    "withdrawal_enabled": "true",
    "withdrawal_cooldown_hours": "48",
    "min_withdraw": "1.00",

    "spin_price": "2.00",
    "spin_spins": "10",

    "daily_limit_level_1": "10",
    "daily_limit_level_2": "15",
    "daily_limit_level_3": "20",
}


# ============================================================
# DATABASE
# ============================================================

def get_db():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is not configured")

    return psycopg2.connect(
        DATABASE_URL,
        sslmode=DB_SSLMODE
    )


def init_db():
    global DB_READY

    conn = get_db()

    try:
        cur = conn.cursor()

        cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id BIGSERIAL PRIMARY KEY,
            telegram_id BIGINT UNIQUE NOT NULL,
            username TEXT,
            first_name TEXT,
            last_name TEXT,
            balance NUMERIC(18,2) NOT NULL DEFAULT 0,
            streak INTEGER NOT NULL DEFAULT 0,
            last_streak_date DATE,
            spins INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        """)

        cur.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """)

        cur.execute("""
        CREATE TABLE IF NOT EXISTS membership_cache (
            telegram_id BIGINT NOT NULL,
            channel_id TEXT NOT NULL,
            is_member BOOLEAN NOT NULL DEFAULT FALSE,
            checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (telegram_id, channel_id)
        );
        """)

        cur.execute("""
        CREATE TABLE IF NOT EXISTS daily_stats (
            telegram_id BIGINT NOT NULL,
            day DATE NOT NULL,
            ads_watched INTEGER NOT NULL DEFAULT 0,
            target INTEGER NOT NULL,
            completed BOOLEAN NOT NULL DEFAULT FALSE,
            completed_at TIMESTAMPTZ,
            PRIMARY KEY (telegram_id, day)
        );
        """)

        cur.execute("""
        CREATE TABLE IF NOT EXISTS ad_sessions (
            id TEXT PRIMARY KEY,
            telegram_id BIGINT NOT NULL,
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at TIMESTAMPTZ,
            status TEXT NOT NULL DEFAULT 'started',
            reward NUMERIC(18,2) NOT NULL DEFAULT 0
        );
        """)

        cur.execute("""
        CREATE TABLE IF NOT EXISTS referrals (
            id BIGSERIAL PRIMARY KEY,
            inviter_id BIGINT NOT NULL,
            referred_id BIGINT UNIQUE NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            qualified BOOLEAN NOT NULL DEFAULT FALSE,
            qualified_at TIMESTAMPTZ
        );
        """)

        cur.execute("""
        CREATE TABLE IF NOT EXISTS tasks (
            id BIGSERIAL PRIMARY KEY,
            title TEXT NOT NULL,
            task_type TEXT NOT NULL,
            url TEXT,
            channel_id TEXT,
            reward NUMERIC(18,2) NOT NULL DEFAULT 0,
            max_users INTEGER,
            completed_count INTEGER NOT NULL DEFAULT 0,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            persistent BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        """)

        cur.execute("""
        CREATE TABLE IF NOT EXISTS task_completions (
            id BIGSERIAL PRIMARY KEY,
            task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            telegram_id BIGINT NOT NULL,
            status TEXT NOT NULL DEFAULT 'completed',
            proof_file_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            reviewed_at TIMESTAMPTZ,
            UNIQUE(task_id, telegram_id)
        );
        """)

        cur.execute("""
        CREATE TABLE IF NOT EXISTS withdrawals (
            id BIGSERIAL PRIMARY KEY,
            telegram_id BIGINT NOT NULL,
            amount NUMERIC(18,2) NOT NULL,
            telebirr_name TEXT NOT NULL,
            telebirr_number TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            reviewed_at TIMESTAMPTZ,
            completed_at TIMESTAMPTZ,
            proof_message_id BIGINT,
            admin_note TEXT
        );
        """)

        cur.execute("""
        CREATE TABLE IF NOT EXISTS admin_proof_queue (
            admin_id BIGINT PRIMARY KEY,
            withdrawal_id BIGINT NOT NULL
        );
        """)

        cur.execute("""
        CREATE TABLE IF NOT EXISTS spin_transactions (
            id BIGSERIAL PRIMARY KEY,
            telegram_id BIGINT NOT NULL,
            reward NUMERIC(18,2) NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        """)

        # Default settings
        for key, value in DEFAULT_SETTINGS.items():
            cur.execute("""
                INSERT INTO settings(key, value)
                VALUES (%s, %s)
                ON CONFLICT(key) DO NOTHING
            """, (key, value))

        conn.commit()
        DB_READY = True

    finally:
        conn.close()


def ensure_db():
    global DB_READY

    if not DB_READY:
        init_db()


# ============================================================
# SETTINGS
# ============================================================

def get_setting(key, default=None):
    ensure_db()

    conn = get_db()

    try:
        cur = conn.cursor()

        cur.execute(
            "SELECT value FROM settings WHERE key=%s",
            (key,)
        )

        row = cur.fetchone()

        if not row:
            return default

        return row[0]

    finally:
        conn.close()


def set_setting(key, value):
    ensure_db()

    conn = get_db()

    try:
        cur = conn.cursor()

        cur.execute("""
            INSERT INTO settings(key, value)
            VALUES (%s, %s)
            ON CONFLICT(key)
            DO UPDATE SET value=EXCLUDED.value
        """, (key, str(value)))

        conn.commit()

    finally:
        conn.close()


def setting_float(key, default=0):
    try:
        return float(get_setting(key, str(default)))
    except Exception:
        return default


def setting_int(key, default=0):
    try:
        return int(get_setting(key, str(default)))
    except Exception:
        return default


def setting_bool(key, default=False):
    value = str(
        get_setting(key, "true" if default else "false")
    ).lower()

    return value in ("1", "true", "yes", "on")


# ============================================================
# TELEGRAM API
# ============================================================

def telegram_api(method, data=None):
    if not BOT_TOKEN:
        raise RuntimeError("BOT_TOKEN is not configured")

    url = f"https://api.telegram.org/bot{BOT_TOKEN}/{method}"

    response = requests.post(
        url,
        json=data or {},
        timeout=20
    )

    result = response.json()

    if not result.get("ok"):
        raise RuntimeError(
            result.get("description", "Telegram API error")
        )

    return result.get("result")


def send_message(chat_id, text, reply_markup=None):
    data = {
        "chat_id": chat_id,
        "text": text
    }

    if reply_markup:
        data["reply_markup"] = reply_markup

    return telegram_api("sendMessage", data)


# ============================================================
# TELEGRAM MINI APP AUTH
# ============================================================

def verify_telegram_init_data(init_data):
    if not BOT_TOKEN or not init_data:
        return None

    try:
        parsed = dict(
            parse_qsl(
                init_data,
                keep_blank_values=True
            )
        )

        received_hash = parsed.pop("hash", None)

        if not received_hash:
            return None

        data_check_string = "\n".join(
            f"{key}={value}"
            for key, value in sorted(parsed.items())
        )

        # Telegram Mini App validation
        secret_key = hmac.new(
            b"WebAppData",
            BOT_TOKEN.encode(),
            hashlib.sha256
        ).digest()

        calculated_hash = hmac.new(
            secret_key,
            data_check_string.encode(),
            hashlib.sha256
        ).hexdigest()

        if not hmac.compare_digest(
            calculated_hash,
            received_hash
        ):
            return None

        auth_date = int(
            parsed.get("auth_date", "0")
        )

        # Reject very old Mini App sessions.
        if auth_date:
            now = int(datetime.now(timezone.utc).timestamp())

            if now - auth_date > 86400:
                return None

        user_data = parsed.get("user")

        if not user_data:
            return None

        return json.loads(user_data)

    except Exception:
        return None


def get_authenticated_user():
    init_data = request.headers.get(
        "X-Telegram-Init-Data",
        ""
    )

    telegram_user = verify_telegram_init_data(
        init_data
    )

    if not telegram_user:
        return None

    return telegram_user


# ============================================================
# USER
# ============================================================

def upsert_user(telegram_user):
    ensure_db()

    telegram_id = int(
        telegram_user["id"]
    )

    username = telegram_user.get("username")
    first_name = telegram_user.get("first_name")
    last_name = telegram_user.get("last_name")

    conn = get_db()

    try:
        cur = conn.cursor(
            cursor_factory=RealDictCursor
        )

        cur.execute("""
            INSERT INTO users(
                telegram_id,
                username,
                first_name,
                last_name
            )
            VALUES(%s, %s, %s, %s)

            ON CONFLICT(telegram_id)
            DO UPDATE SET
                username=EXCLUDED.username,
                first_name=EXCLUDED.first_name,
                last_name=EXCLUDED.last_name,
                updated_at=NOW()

            RETURNING *
        """, (
            telegram_id,
            username,
            first_name,
            last_name
        ))

        user = cur.fetchone()

        conn.commit()

        return user

    finally:
        conn.close()


def require_user(func):

    @wraps(func)
    def wrapper(*args, **kwargs):

        try:
            ensure_db()

            telegram_user = get_authenticated_user()

            if not telegram_user:
                return jsonify({
                    "ok": False,
                    "error": "Telegram authentication failed"
                }), 401

            user = upsert_user(
                telegram_user
            )

            g.telegram_id = int(
                telegram_user["id"]
            )

            g.user = user

            return func(*args, **kwargs)

        except Exception as e:

            return jsonify({
                "ok": False,
                "error": str(e)
            }), 500

    return wrapper


# ============================================================
# REQUIRED CHANNELS
# ============================================================

def get_required_channels():

    channels = []

    for number in range(1, 6):

        db_id = get_setting(
            f"channel_{number}_id",
            None
        )

        db_url = get_setting(
            f"channel_{number}_url",
            None
        )

        db_title = get_setting(
            f"channel_{number}_title",
            None
        )

        channel_id = (
            db_id
            or os.getenv(
                f"CHANNEL_{number}_ID",
                ""
            ).strip()
        )

        channel_url = (
            db_url
            or os.getenv(
                f"CHANNEL_{number}_URL",
                ""
            ).strip()
        )

        channel_title = (
            db_title
            or os.getenv(
                f"CHANNEL_{number}_TITLE",
                f"Channel {number}"
            ).strip()
        )

        if channel_id:

            channels.append({
                "number": number,
                "id": channel_id,
                "url": channel_url,
                "title": channel_title
            })

    return channels


def check_channel_membership(
    telegram_id,
    channel,
    force=False
):

    channel_id = str(channel["id"])

    conn = get_db()

    try:
        cur = conn.cursor(
            cursor_factory=RealDictCursor
        )

        # Cache lookup
        if not force:

            cur.execute("""
                SELECT is_member, checked_at
                FROM membership_cache
                WHERE telegram_id=%s
                  AND channel_id=%s
            """, (
                telegram_id,
                channel_id
            ))

            cached = cur.fetchone()

            if cached:

                checked_at = cached["checked_at"]

                age = (
                    datetime.now(timezone.utc)
                    - checked_at
                ).total_seconds()

                if age < CHANNEL_CACHE_TTL:

                    return bool(
                        cached["is_member"]
                    )

        # LIVE Telegram check
        result = telegram_api(
            "getChatMember",
            {
                "chat_id": channel_id,
                "user_id": telegram_id
            }
        )

        status = result.get("status")

        is_member = (
            status in (
                "creator",
                "administrator",
                "member"
            )
            or (
                status == "restricted"
                and result.get(
                    "is_member",
                    False
                )
            )
        )

        cur.execute("""
            INSERT INTO membership_cache(
                telegram_id,
                channel_id,
                is_member,
                checked_at
            )
            VALUES(%s, %s, %s, NOW())

            ON CONFLICT(
                telegram_id,
                channel_id
            )

            DO UPDATE SET
                is_member=EXCLUDED.is_member,
                checked_at=NOW()
        """, (
            telegram_id,
            channel_id,
            is_member
        ))

        conn.commit()

        return is_member

    finally:
        conn.close()


def check_all_channels(
    telegram_id,
    force=False
):

    channels = get_required_channels()

    if len(channels) < 5:

        return {
            "all_joined": False,
            "error": "Five required channels are not configured",
            "channels": []
        }

    result = []

    all_joined = True

    for channel in channels:

        try:

            joined = check_channel_membership(
                telegram_id,
                channel,
                force=force
            )

        except Exception as e:

            joined = False

        result.append({
            "number": channel["number"],
            "id": channel["id"],
            "title": channel["title"],
            "url": channel["url"],
            "joined": joined
        })

        if not joined:
            all_joined = False

    return {
        "all_joined": all_joined,
        "channels": result
    }


# ============================================================
# DAILY ADS / LEVEL
# ============================================================

def get_level(streak):

    if streak >= 14:
        return 3

    if streak >= 7:
        return 2

    return 1


def get_daily_limit(streak):

    level = get_level(streak)

    if level == 3:
        return setting_int(
            "daily_limit_level_3",
            20
        )

    if level == 2:
        return setting_int(
            "daily_limit_level_2",
            15
        )

    return setting_int(
        "daily_limit_level_1",
        10
    )


def today_addis():

    return datetime.now(
        ADDIS_TIMEZONE
    ).date()


def ensure_daily_stat(
    conn,
    telegram_id,
    day,
    target
):

    cur = conn.cursor(
        cursor_factory=RealDictCursor
    )

    cur.execute("""
        INSERT INTO daily_stats(
            telegram_id,
            day,
            target
        )
        VALUES(%s, %s, %s)

        ON CONFLICT(
            telegram_id,
            day
        )
        DO NOTHING
    """, (
        telegram_id,
        day,
        target
    ))

    cur.execute("""
        SELECT *
        FROM daily_stats
        WHERE telegram_id=%s
          AND day=%s
        FOR UPDATE
    """, (
        telegram_id,
        day
    ))

    return cur.fetchone()


def update_streak(
    conn,
    telegram_id,
    today
):

    cur = conn.cursor(
        cursor_factory=RealDictCursor
    )

    cur.execute("""
        SELECT streak, last_streak_date
        FROM users
        WHERE telegram_id=%s
        FOR UPDATE
    """, (telegram_id,))

    user = cur.fetchone()

    old_streak = user["streak"] or 0
    last_date = user["last_streak_date"]

    if last_date == today:

        new_streak = old_streak

    elif (
        last_date
        and last_date == today - timedelta(days=1)
    ):

        new_streak = old_streak + 1

    else:

        new_streak = 1

    cur.execute("""
        UPDATE users
        SET
            streak=%s,
            last_streak_date=%s,
            updated_at=NOW()
        WHERE telegram_id=%s
    """, (
        new_streak,
        today,
        telegram_id
    ))

    return new_streak


# ============================================================
# REFERRAL
# ============================================================

def create_referral(
    inviter_id,
    referred_id
):

    if inviter_id == referred_id:
        return False

    conn = get_db()

    try:

        cur = conn.cursor()

        cur.execute("""
            SELECT id
            FROM referrals
            WHERE referred_id=%s
        """, (referred_id,))

        if cur.fetchone():
            conn.commit()
            return False

        cur.execute("""
            SELECT telegram_id
            FROM users
            WHERE telegram_id=%s
        """, (inviter_id,))

        if not cur.fetchone():
            conn.commit()
            return False

        cur.execute("""
            INSERT INTO referrals(
                inviter_id,
                referred_id
            )
            VALUES(%s, %s)
            ON CONFLICT(referred_id)
            DO NOTHING
        """, (
            inviter_id,
            referred_id
        ))

        conn.commit()

        return True

    finally:
        conn.close()


def referral_is_qualified(
    referred_id,
    referral_created_at
):

    conn = get_db()

    try:

        cur = conn.cursor(
            cursor_factory=RealDictCursor
        )

        created_day = (
            referral_created_at
            .astimezone(ADDIS_TIMEZONE)
            .date()
        )

        cur.execute("""
            SELECT day
            FROM daily_stats
            WHERE telegram_id=%s
              AND day >= %s
              AND completed=TRUE
            ORDER BY day ASC
        """, (
            referred_id,
            created_day
        ))

        rows = cur.fetchall()

        completed_days = {
            row["day"]
            for row in rows
        }

        # Two consecutive completed days
        has_two_days = False

        for day in completed_days:

            if (
                day + timedelta(days=1)
                in completed_days
            ):
                has_two_days = True
                break

        if not has_two_days:
            return False

    finally:
        conn.close()

    # Required channel check.
    channels = check_all_channels(
        referred_id,
        force=False
    )

    return channels["all_joined"]


def refresh_referral_qualification(
    referred_id
):

    conn = get_db()

    try:

        cur = conn.cursor(
            cursor_factory=RealDictCursor
        )

        cur.execute("""
            SELECT *
            FROM referrals
            WHERE referred_id=%s
        """, (referred_id,))

        referral = cur.fetchone()

    finally:
        conn.close()

    if not referral:
        return False

    if referral["qualified"]:
        return True

    qualified = referral_is_qualified(
        referred_id,
        referral["created_at"]
    )

    if not qualified:
        return False

    conn = get_db()

    try:

        cur = conn.cursor()

        cur.execute("""
            UPDATE referrals
            SET
                qualified=TRUE,
                qualified_at=NOW()
            WHERE referred_id=%s
        """, (referred_id,))

        conn.commit()

    finally:
        conn.close()

    # Optional referral reward.
    reward = Decimal(
        str(
            setting_float(
                "referral_reward",
                1
            )
        )
    )

    if reward > 0:

        conn = get_db()

        try:

            cur = conn.cursor(
                cursor_factory=RealDictCursor
            )

            cur.execute("""
                SELECT inviter_id
                FROM referrals
                WHERE referred_id=%s
            """, (referred_id,))

            row = cur.fetchone()

            if row:

                cur.execute("""
                    SELECT COUNT(*)
                    FROM referrals
                    WHERE inviter_id=%s
                      AND qualified=TRUE
                """, (row["inviter_id"],))

                count = cur.fetchone()[0]

                # Reward only when it becomes the first
                # qualification event for this referral.
                # The referral row was just changed above.
                cur.execute("""
                    SELECT COUNT(*)
                    FROM referrals
                    WHERE inviter_id=%s
                      AND qualified=TRUE
                      AND referred_id=%s
                """, (
                    row["inviter_id"],
                    referred_id
                ))

                if cur.fetchone()[0] == 1:

                    cur.execute("""
                        UPDATE users
                        SET
                            balance=balance+%s,
                            updated_at=NOW()
                        WHERE telegram_id=%s
                    """, (
                        reward,
                        row["inviter_id"]
                    ))

            conn.commit()

        finally:
            conn.close()

    return True


# ============================================================
# HOME / ME
# ============================================================

@app.get("/api/me")
@require_user
def api_me():

    conn = get_db()

    try:

        cur = conn.cursor(
            cursor_factory=RealDictCursor
        )

        cur.execute("""
            SELECT *
            FROM users
            WHERE telegram_id=%s
        """, (g.telegram_id,))

        user = cur.fetchone()

        today = today_addis()

        target = get_daily_limit(
            user["streak"]
        )

        cur.execute("""
            SELECT ads_watched
            FROM daily_stats
            WHERE telegram_id=%s
              AND day=%s
        """, (
            g.telegram_id,
            today
        ))

        stat = cur.fetchone()

        ads_watched = (
            stat["ads_watched"]
            if stat
            else 0
        )

        cur.execute("""
            SELECT COUNT(*)
            FROM referrals
            WHERE inviter_id=%s
              AND qualified=TRUE
        """, (g.telegram_id,))

        qualified_referrals = cur.fetchone()[0]

        cur.execute("""
            SELECT requested_at
            FROM withdrawals
            WHERE telegram_id=%s
            ORDER BY requested_at DESC
            LIMIT 1
        """, (g.telegram_id,))

        last_withdrawal = cur.fetchone()

        level = get_level(
            user["streak"]
        )

        return jsonify({
            "ok": True,
            "user": {
                "telegramId": g.telegram_id,
                "username": user["username"],
                "firstName": user["first_name"],
                "lastName": user["last_name"],
                "balance": float(user["balance"]),
                "streak": user["streak"],
                "level": level,
                "adsWatched": ads_watched,
                "adsLimit": target,
                "adsRemaining": max(
                    0,
                    target - ads_watched
                ),
                "spins": user["spins"],
                "qualifiedReferrals":
                    qualified_referrals
            },
            "settings": {
                "adReward": setting_float(
                    "ad_reward",
                    0.5
                ),
                "referralRequired":
                    setting_int(
                        "referral_required",
                        10
                    ),
                "withdrawalEnabled":
                    setting_bool(
                        "withdrawal_enabled",
                        True
                    ),
                "withdrawalCooldownHours":
                    setting_int(
                        "withdrawal_cooldown_hours",
                        48
                    )
            },
            "lastWithdrawalAt":
                (
                    last_withdrawal[
                        "requested_at"
                    ].isoformat()
                    if last_withdrawal
                    else None
                )
        })

    finally:
        conn.close()


# ============================================================
# CONFIG FOR FRONTEND
# ============================================================

@app.get("/api/config")
@require_user
def api_config():

    return jsonify({
        "ok": True,

        "channels":
            get_required_channels(),

        "adReward":
            setting_float(
                "ad_reward",
                0.50
            ),

        "referralRequired":
            setting_int(
                "referral_required",
                10
            ),

        "withdrawalEnabled":
            setting_bool(
                "withdrawal_enabled",
                True
            ),

        "withdrawalCooldownHours":
            setting_int(
                "withdrawal_cooldown_hours",
                48
            ),

        "spinPrice":
            setting_float(
                "spin_price",
                2
            ),

        "spinSpins":
            setting_int(
                "spin_spins",
                10
            )
    })


# ============================================================
# CHANNEL CHECK
# ============================================================

@app.post("/api/channels/check")
@require_user
def api_channel_check():

    body = request.get_json(
        silent=True
    ) or {}

    channel_id = str(
        body.get("channelId", "")
    )

    channels = get_required_channels()

    channel = next(
        (
            c for c in channels
            if str(c["id"]) == channel_id
        ),
        None
    )

    if not channel:

        return jsonify({
            "ok": False,
            "error": "Unknown channel"
        }), 400

    joined = check_channel_membership(
        g.telegram_id,
        channel,
        force=False
    )

    return jsonify({
        "ok": True,
        "channelId": channel_id,
        "joined": joined
    })


# ============================================================
# WATCH AD - START
# ============================================================

@app.post("/api/ads/start")
@require_user
def api_ads_start():

    membership = check_all_channels(
        g.telegram_id,
        force=False
    )

    if not membership["all_joined"]:

        return jsonify({
            "ok": False,
            "error": "Join all required channels first",
            "channels": membership["channels"]
        }), 403

    conn = get_db()

    try:

        cur = conn.cursor(
            cursor_factory=RealDictCursor
        )

        cur.execute("""
            SELECT streak
            FROM users
            WHERE telegram_id=%s
            FOR UPDATE
        """, (g.telegram_id,))

        user = cur.fetchone()

        limit = get_daily_limit(
            user["streak"]
        )

        today = today_addis()

        stat = ensure_daily_stat(
            conn,
            g.telegram_id,
            today,
            limit
        )

        if stat["ads_watched"] >= limit:

            conn.commit()

            return jsonify({
                "ok": False,
                "error": "Daily ad limit reached",
                "adsWatched":
                    stat["ads_watched"],
                "adsLimit": limit
            }), 400

        # Cooldown
        cur.execute("""
            SELECT completed_at
            FROM ad_sessions
            WHERE telegram_id=%s
              AND status='completed'
            ORDER BY completed_at DESC
            LIMIT 1
        """, (g.telegram_id,))

        last_ad = cur.fetchone()

        if last_ad and last_ad["completed_at"]:

            elapsed = (
                datetime.now(timezone.utc)
                - last_ad["completed_at"]
            ).total_seconds()

            if elapsed < AD_COOLDOWN_SECONDS:

                wait = int(
                    AD_COOLDOWN_SECONDS
                    - elapsed
                )

                conn.commit()

                return jsonify({
                    "ok": False,
                    "error":
                        f"Please wait {wait} seconds"
                }), 429

        session_id = str(uuid4())

        cur.execute("""
            INSERT INTO ad_sessions(
                id,
                telegram_id,
                started_at,
                status
            )
            VALUES(%s, %s, NOW(), 'started')
        """, (
            session_id,
            g.telegram_id
        ))

        conn.commit()

        return jsonify({
            "ok": True,
            "sessionId": session_id,
            "minimumSeconds":
                AD_MIN_SECONDS
        })

    finally:
        conn.close()


# ============================================================
# WATCH AD - COMPLETE
# ============================================================

@app.post("/api/ads/complete")
@require_user
def api_ads_complete():

    body = request.get_json(
        silent=True
    ) or {}

    session_id = str(
        body.get("sessionId", "")
    )

    if not session_id:

        return jsonify({
            "ok": False,
            "error": "Missing ad session"
        }), 400

    conn = get_db()

    try:

        cur = conn.cursor(
            cursor_factory=RealDictCursor
        )

        cur.execute("""
            SELECT *
            FROM ad_sessions
            WHERE id=%s
              AND telegram_id=%s
            FOR UPDATE
        """, (
            session_id,
            g.telegram_id
        ))

        session = cur.fetchone()

        if not session:

            conn.rollback()

            return jsonify({
                "ok": False,
                "error": "Invalid ad session"
            }), 400

        if session["status"] != "started":

            conn.rollback()

            return jsonify({
                "ok": False,
                "error": "Ad session already used"
            }), 400

        age = (
            datetime.now(timezone.utc)
            - session["started_at"]
        ).total_seconds()

        if age < AD_MIN_SECONDS:

            conn.rollback()

            return jsonify({
                "ok": False,
                "error":
                    "Ad was not open long enough"
            }), 400

        if age > (
            AD_SESSION_TIMEOUT_MINUTES * 60
        ):

            conn.rollback()

            return jsonify({
                "ok": False,
                "error": "Ad session expired"
            }), 400

        # Live check before giving money.
        membership = check_all_channels(
            g.telegram_id,
            force=False
        )

        if not membership["all_joined"]:

            conn.rollback()

            return jsonify({
                "ok": False,
                "error":
                    "Join all required channels first"
            }), 403

        cur.execute("""
            SELECT streak
            FROM users
            WHERE telegram_id=%s
            FOR UPDATE
        """, (g.telegram_id,))

        user = cur.fetchone()

        today = today_addis()

        target = get_daily_limit(
            user["streak"]
        )

        stat = ensure_daily_stat(
            conn,
            g.telegram_id,
            today,
            target
        )

        if stat["ads_watched"] >= target:

            conn.rollback()

            return jsonify({
                "ok": False,
                "error": "Daily limit reached"
            }), 400

        reward = Decimal(
            str(
                setting_float(
                    "ad_reward",
                    0.50
                )
            )
        )

        new_count = (
            stat["ads_watched"] + 1
        )

        completed_day = (
            new_count >= target
        )

        cur.execute("""
            UPDATE daily_stats
            SET
                ads_watched=%s,
                completed=%s,
                completed_at=
                    CASE
                        WHEN %s
                        THEN NOW()
                        ELSE completed_at
                    END
            WHERE telegram_id=%s
              AND day=%s
        """, (
            new_count,
            completed_day,
            completed_day,
            g.telegram_id,
            today
        ))

        cur.execute("""
            UPDATE ad_sessions
            SET
                status='completed',
                completed_at=NOW(),
                reward=%s
            WHERE id=%s
        """, (
            reward,
            session_id
        ))

        if completed_day:

            new_streak = update_streak(
                conn,
                g.telegram_id,
                today
            )

        else:

            new_streak = user["streak"]

        cur.execute("""
            UPDATE users
            SET
                balance=balance+%s,
                updated_at=NOW()
            WHERE telegram_id=%s
            RETURNING balance
        """, (
            reward,
            g.telegram_id
        ))

        balance = cur.fetchone()["balance"]

        conn.commit()

    except Exception:

        conn.rollback()
        raise

    finally:
        conn.close()

    # Check whether this user became
    # a qualified referral.
    try:
        refresh_referral_qualification(
            g.telegram_id
        )
    except Exception:
        pass

    return jsonify({
        "ok": True,
        "reward": float(reward),
        "balance": float(balance),
        "adsWatched": new_count,
        "adsLimit":
            get_daily_limit(new_streak),
        "streak": new_streak,
        "level":
            get_level(new_streak),
        "dailyCompleted":
            completed_day
    })


# ============================================================
# TASKS
# ============================================================

@app.get("/api/tasks")
@require_user
def api_tasks():

    conn = get_db()

    try:

        cur = conn.cursor(
            cursor_factory=RealDictCursor
        )

        cur.execute("""
            SELECT
                t.id,
                t.title,
                t.task_type,
                t.url,
                t.channel_id,
                t.reward,
                t.max_users,
                t.completed_count
            FROM tasks t
            WHERE t.active=TRUE
              AND (
                  t.max_users IS NULL
                  OR t.completed_count < t.max_users
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM task_completions tc
                  WHERE tc.task_id=t.id
                    AND tc.telegram_id=%s
                    AND tc.status IN(
                        'completed',
                        'approved'
                    )
              )
            ORDER BY t.id DESC
        """, (g.telegram_id,))

        rows = cur.fetchall()

        return jsonify({
            "ok": True,
            "tasks": [
                {
                    "id": row["id"],
                    "title": row["title"],
                    "type": row["task_type"],
                    "url": row["url"],
                    "channelId": row["channel_id"],
                    "reward":
                        float(row["reward"])
                }
                for row in rows
            ]
        })

    finally:
        conn.close()


@app.post("/api/tasks/complete")
@require_user
def api_task_complete():

    body = request.get_json(
        silent=True
    ) or {}

    task_id = body.get("taskId")

    if not task_id:

        return jsonify({
            "ok": False,
            "error": "Missing task ID"
        }), 400

    conn = get_db()

    try:

        cur = conn.cursor(
            cursor_factory=RealDictCursor
        )

        cur.execute("""
            SELECT *
            FROM tasks
            WHERE id=%s
              AND active=TRUE
            FOR UPDATE
        """, (task_id,))

        task = cur.fetchone()

        if not task:

            conn.rollback()

            return jsonify({
                "ok": False,
                "error": "Task unavailable"
            }), 404

        cur.execute("""
            SELECT id
            FROM task_completions
            WHERE task_id=%s
              AND telegram_id=%s
        """, (
            task_id,
            g.telegram_id
        ))

        if cur.fetchone():

            conn.rollback()

            return jsonify({
                "ok": False,
                "error": "Task already submitted"
            }), 400

        # Telegram join task
        if task["task_type"] in (
            "telegram",
            "channel"
        ):

            if not task["channel_id"]:

                conn.rollback()

                return jsonify({
                    "ok": False,
                    "error":
                        "Task channel is not configured"
                }), 400

            channel = {
                "id": task["channel_id"],
                "url": task["url"] or "",
                "title": task["title"]
            }

            joined = check_channel_membership(
                g.telegram_id,
                channel,
                force=True
            )

            if not joined:

                conn.rollback()

                return jsonify({
                    "ok": False,
                    "error":
                        "You have not joined the channel"
                }), 403

            completion_status = "completed"

        else:

            # Social/website tasks need screenshot
            # proof. The frontend should upload proof
            # through a separate endpoint.
            conn.rollback()

            return jsonify({
                "ok": False,
                "requiresProof": True,
                "error":
                    "This task requires screenshot proof"
            }), 400

        reward = task["reward"]

        cur.execute("""
            INSERT INTO task_completions(
                task_id,
                telegram_id,
                status
            )
            VALUES(%s, %s, %s)
        """, (
            task_id,
            g.telegram_id,
            completion_status
        ))

        cur.execute("""
            UPDATE tasks
            SET
                completed_count=
                    completed_count+1
            WHERE id=%s
        """, (task_id,))

        if (
            task["max_users"] is not None
            and (
                task["completed_count"] + 1
                >= task["max_users"]
            )
        ):

            cur.execute("""
                UPDATE tasks
                SET active=FALSE
                WHERE id=%s
            """, (task_id,))

        cur.execute("""
            UPDATE users
            SET
                balance=balance+%s,
                updated_at=NOW()
            WHERE telegram_id=%s
            RETURNING balance
        """, (
            reward,
            g.telegram_id
        ))

        balance = cur.fetchone()["balance"]

        conn.commit()

        return jsonify({
            "ok": True,
            "reward": float(reward),
            "balance": float(balance)
        })

    except Exception:

        conn.rollback()
        raise

    finally:
        conn.close()


# ============================================================
# REFERRALS
# ============================================================

@app.get("/api/referrals")
@require_user
def api_referrals():

    conn = get_db()

    try:

        cur = conn.cursor(
            cursor_factory=RealDictCursor
        )

        cur.execute("""
            SELECT
                r.id,
                r.created_at,
                r.qualified,
                u.telegram_id,
                u.username,
                u.first_name
            FROM referrals r
            JOIN users u
              ON u.telegram_id=r.referred_id
            WHERE r.inviter_id=%s
            ORDER BY r.created_at DESC
        """, (g.telegram_id,))

        referrals = cur.fetchall()

        result = []

        for referral in referrals:

            cur.execute("""
                SELECT COUNT(*)
                FROM daily_stats
                WHERE telegram_id=%s
                  AND day >= %s::date
                  AND completed=TRUE
            """, (
                referral["telegram_id"],
                referral["created_at"]
            ))

            completed_days = min(
                2,
                cur.fetchone()[0]
            )

            progress = int(
                completed_days / 2 * 100
            )

            result.append({
                "id": referral["id"],
                "telegramId":
                    referral["telegram_id"],
                "username":
                    referral["username"],
                "name":
                    referral["first_name"]
                    or "User",
                "day1":
                    completed_days >= 1,
                "day2":
                    completed_days >= 2,
                "progress":
                    progress,
                "qualified":
                    referral["qualified"]
            })

        cur.execute("""
            SELECT COUNT(*)
            FROM referrals
            WHERE inviter_id=%s
              AND qualified=TRUE
        """, (g.telegram_id,))

        qualified = cur.fetchone()[0]

        referral_link = ""

        if BOT_USERNAME:

            referral_link = (
                f"https://t.me/"
                f"{BOT_USERNAME}"
                f"?start=ref_{g.telegram_id}"
            )

        return jsonify({
            "ok": True,
            "qualified": qualified,
            "required":
                setting_int(
                    "referral_required",
                    10
                ),
            "referralLink":
                referral_link,
            "referrals": result
        })

    finally:
        conn.close()


# ============================================================
# SPIN
# ============================================================

def generate_spin_reward():

    # Server-side probability.
    #
    # 75.0% -> 0
    # 18.0% -> 0.10 - 0.30
    # 6.9%  -> 1.00 - 2.50
    # 0.1%  -> 15 - 25
    #
    # Maximum reward = 25 ETB.

    roll = secrets.randbelow(10000)

    if roll < 7500:

        return Decimal("0.00")

    if roll < 9300:

        values = [
            Decimal("0.10"),
            Decimal("0.15"),
            Decimal("0.20"),
            Decimal("0.25"),
            Decimal("0.30")
        ]

        return secrets.choice(values)

    if roll < 9990:

        values = [
            Decimal("1.00"),
            Decimal("1.25"),
            Decimal("1.50"),
            Decimal("1.75"),
            Decimal("2.00"),
            Decimal("2.25"),
            Decimal("2.50")
        ]

        return secrets.choice(values)

    values = [
        Decimal("15.00"),
        Decimal("17.50"),
        Decimal("20.00"),
        Decimal("22.50"),
        Decimal("25.00")
    ]

    return secrets.choice(values)


@app.post("/api/spin/buy")
@require_user
def api_spin_buy():

    price = Decimal(
        str(
            setting_float(
                "spin_price",
                2
            )
        )
    )

    spins_to_add = setting_int(
        "spin_spins",
        10
    )

    conn = get_db()

    try:

        cur = conn.cursor(
            cursor_factory=RealDictCursor
        )

        cur.execute("""
            SELECT balance, spins
            FROM users
            WHERE telegram_id=%s
            FOR UPDATE
        """, (g.telegram_id,))

        user = cur.fetchone()

        if Decimal(user["balance"]) < price:

            conn.rollback()

            return jsonify({
                "ok": False,
                "error": "Insufficient balance"
            }), 400

        cur.execute("""
            UPDATE users
            SET
                balance=balance-%s,
                spins=spins+%s,
                updated_at=NOW()
            WHERE telegram_id=%s
            RETURNING balance, spins
        """, (
            price,
            spins_to_add,
            g.telegram_id
        ))

        updated = cur.fetchone()

        conn.commit()

        return jsonify({
            "ok": True,
            "paid": float(price),
            "spinsAdded": spins_to_add,
            "balance":
                float(updated["balance"]),
            "spins":
                updated["spins"]
        })

    finally:
        conn.close()


@app.post("/api/spin/spin")
@require_user
def api_spin():

    conn = get_db()

    try:

        cur = conn.cursor(
            cursor_factory=RealDictCursor
        )

        cur.execute("""
            SELECT spins
            FROM users
            WHERE telegram_id=%s
            FOR UPDATE
        """, (g.telegram_id,))

        user = cur.fetchone()

        if user["spins"] <= 0:

            conn.rollback()

            return jsonify({
                "ok": False,
                "error": "No spins available"
            }), 400

        reward = generate_spin_reward()

        cur.execute("""
            UPDATE users
            SET
                spins=spins-1,
                balance=balance+%s,
                updated_at=NOW()
            WHERE telegram_id=%s
            RETURNING balance, spins
        """, (
            reward,
            g.telegram_id
        ))

        updated = cur.fetchone()

        cur.execute("""
            INSERT INTO spin_transactions(
                telegram_id,
                reward
            )
            VALUES(%s, %s)
        """, (
            g.telegram_id,
            reward
        ))

        conn.commit()

        return jsonify({
            "ok": True,
            "reward": float(reward),
            "balance":
                float(updated["balance"]),
            "spins":
                updated["spins"]
        })

    finally:
        conn.close()


# ============================================================
# WITHDRAW
# ============================================================

@app.post("/api/withdrawals")
@require_user
def api_withdrawal():

    body = request.get_json(
        silent=True
    ) or {}

    try:
        amount = Decimal(
            str(body.get("amount"))
        )
    except Exception:

        return jsonify({
            "ok": False,
            "error": "Invalid amount"
        }), 400

    telebirr_name = str(
        body.get("telebirrName", "")
    ).strip()

    telebirr_number = str(
        body.get("telebirrNumber", "")
    ).strip()

    if amount <= 0:

        return jsonify({
            "ok": False,
            "error": "Invalid amount"
        }), 400

    if not telebirr_name or not telebirr_number:

        return jsonify({
            "ok": False,
            "error":
                "Telebirr information is required"
        }), 400

    if not setting_bool(
        "withdrawal_enabled",
        True
    ):

        return jsonify({
            "ok": False,
            "error": "Withdrawals are locked"
        }), 403

    min_withdraw = Decimal(
        str(
            setting_float(
                "min_withdraw",
                1
            )
        )
    )

    if amount < min_withdraw:

        return jsonify({
            "ok": False,
            "error":
                f"Minimum withdrawal is "
                f"{min_withdraw} ETB"
        }), 400

    # IMPORTANT:
    # Fresh live membership check.
    membership = check_all_channels(
        g.telegram_id,
        force=True
    )

    if not membership["all_joined"]:

        return jsonify({
            "ok": False,
            "error":
                "You must join all required channels",
            "channels":
                membership["channels"]
        }), 403

    conn = get_db()

    try:

        cur = conn.cursor(
            cursor_factory=RealDictCursor
        )

        # Qualified referral requirement
        cur.execute("""
            SELECT COUNT(*)
            FROM referrals
            WHERE inviter_id=%s
              AND qualified=TRUE
        """, (g.telegram_id,))

        qualified = cur.fetchone()[0]

        required = setting_int(
            "referral_required",
            10
        )

        if qualified < required:

            conn.rollback()

            return jsonify({
                "ok": False,
                "error":
                    "Not enough qualified referrals",
                "qualified": qualified,
                "required": required
            }), 403

        # 48-hour cooldown
        cooldown_hours = setting_int(
            "withdrawal_cooldown_hours",
            48
        )

        cur.execute("""
            SELECT requested_at
            FROM withdrawals
            WHERE telegram_id=%s
            ORDER BY requested_at DESC
            LIMIT 1
        """, (g.telegram_id,))

        last = cur.fetchone()

        if last:

            elapsed = (
                datetime.now(timezone.utc)
                - last["requested_at"]
            ).total_seconds()

            if elapsed < cooldown_hours * 3600:

                remaining = int(
                    cooldown_hours * 3600
                    - elapsed
                )

                hours = remaining // 3600

                conn.rollback()

                return jsonify({
                    "ok": False,
                    "error":
                        "Withdrawal cooldown active",
                    "remainingHours":
                        hours
                }), 429

        # Lock balance row.
        cur.execute("""
            SELECT balance
            FROM users
            WHERE telegram_id=%s
            FOR UPDATE
        """, (g.telegram_id,))

        user = cur.fetchone()

        balance = Decimal(
            str(user["balance"])
        )

        if amount > balance:

            conn.rollback()

            return jsonify({
                "ok": False,
                "error": "Insufficient balance"
            }), 400

        # Reserve the money.
        cur.execute("""
            UPDATE users
            SET
                balance=balance-%s,
                updated_at=NOW()
            WHERE telegram_id=%s
        """, (
            amount,
            g.telegram_id
        ))

        cur.execute("""
            INSERT INTO withdrawals(
                telegram_id,
                amount,
                telebirr_name,
                telebirr_number,
                status
            )
            VALUES(%s, %s, %s, %s, 'pending')
            RETURNING id, requested_at
        """, (
            g.telegram_id,
            amount,
            telebirr_name,
            telebirr_number
        ))

        withdrawal = cur.fetchone()

        conn.commit()

    except Exception:

        conn.rollback()
        raise

    finally:
        conn.close()

    # Admin notification
    try:

        keyboard = {
            "inline_keyboard": [
                [
                    {
                        "text": "Approve",
                        "callback_data":
                            f"wd:approve:"
                            f"{withdrawal['id']}"
                    },
                    {
                        "text": "Reject",
                        "callback_data":
                            f"wd:reject:"
                            f"{withdrawal['id']}"
                    }
                ]
            ]
        }

        send_message(
            ADMIN_ID,
            (
                "ADEWA WITHDRAWAL REQUEST\n\n"
                f"Withdrawal ID: #{withdrawal['id']}\n"
                f"User ID: {g.telegram_id}\n"
                f"Amount: {amount} ETB\n"
                f"Telebirr Name: {telebirr_name}\n"
                f"Telebirr Number: {telebirr_number}\n"
                f"Qualified Referrals: {qualified}\n\n"
                "Choose an action:"
            ),
            keyboard
        )

    except Exception as e:

        print(
            "Admin notification failed:",
            e
        )

    return jsonify({
        "ok": True,
        "withdrawalId":
            withdrawal["id"],
        "status": "pending",
        "message":
            "Withdrawal request submitted"
    })


# ============================================================
# HEALTH
# ============================================================

@app.get("/health")
def health():

    return jsonify({
        "ok": True,
        "service": "Adewa backend"
    })


# ============================================================
# TELEGRAM BOT WEBHOOK
# ============================================================

def check_webhook_secret():

    if not WEBHOOK_SECRET:
        return True

    received = request.headers.get(
        "X-Telegram-Bot-Api-Secret-Token",
        ""
    )

    return hmac.compare_digest(
        received,
        WEBHOOK_SECRET
    )


def handle_callback_query(callback):

    callback_id = callback["id"]

    from_user = callback.get(
        "from",
        {}
    )

    admin_id = int(
        from_user.get("id", 0)
    )

    if admin_id != ADMIN_ID:

        telegram_api(
            "answerCallbackQuery",
            {
                "callback_query_id":
                    callback_id,
                "text":
                    "Not authorized",
                "show_alert": True
            }
        )

        return

    data = callback.get(
        "data",
        ""
    )

    parts = data.split(":")

    if len(parts) != 3:
        return

    if parts[0] != "wd":
        return

    action = parts[1]

    try:
        withdrawal_id = int(parts[2])
    except Exception:
        return

    conn = get_db()

    try:

        cur = conn.cursor(
            cursor_factory=RealDictCursor
        )

        cur.execute("""
            SELECT *
            FROM withdrawals
            WHERE id=%s
            FOR UPDATE
        """, (withdrawal_id,))

        withdrawal = cur.fetchone()

        if not withdrawal:

            conn.rollback()

            telegram_api(
                "answerCallbackQuery",
                {
                    "callback_query_id":
                        callback_id,
                    "text":
                        "Withdrawal not found",
                    "show_alert": True
                }
            )

            return

        if withdrawal["status"] != "pending":

            conn.rollback()

            telegram_api(
                "answerCallbackQuery",
                {
                    "callback_query_id":
                        callback_id,
                    "text":
                        "This withdrawal was already processed",
                    "show_alert": True
                }
            )

            return

        if action == "reject":

            cur.execute("""
                UPDATE withdrawals
                SET
                    status='rejected',
                    reviewed_at=NOW()
                WHERE id=%s
            """, (withdrawal_id,))

            # Refund reserved balance.
            cur.execute("""
                UPDATE users
                SET
                    balance=balance+%s,
                    updated_at=NOW()
                WHERE telegram_id=%s
            """, (
                withdrawal["amount"],
                withdrawal["telegram_id"]
            ))

            conn.commit()

            try:

                send_message(
                    withdrawal["telegram_id"],
                    (
                        "Your withdrawal request was rejected.\n\n"
                        f"Amount: {withdrawal['amount']} ETB\n"
                        "The amount has been returned to your balance."
                    )
                )

            except Exception:
                pass

            telegram_api(
                "answerCallbackQuery",
                {
                    "callback_query_id":
                        callback_id,
                    "text":
                        "Withdrawal rejected"
                }
            )

            return

        if action == "approve":

            cur.execute("""
                UPDATE withdrawals
                SET
                    status='approved',
                    reviewed_at=NOW()
                WHERE id=%s
            """, (withdrawal_id,))

            cur.execute("""
                INSERT INTO admin_proof_queue(
                    admin_id,
                    withdrawal_id
                )
                VALUES(%s, %s)

                ON CONFLICT(admin_id)
                DO UPDATE SET
                    withdrawal_id=
                        EXCLUDED.withdrawal_id
            """, (
                ADMIN_ID,
                withdrawal_id
            ))

            conn.commit()

            try:

                send_message(
                    withdrawal["telegram_id"],
                    (
                        "Your withdrawal has been approved.\n\n"
                        f"Amount: {withdrawal['amount']} ETB\n"
                        "Payment proof is being processed."
                    )
                )

            except Exception:
                pass

            send_message(
                ADMIN_ID,
                (
                    f"Withdrawal #{withdrawal_id} approved.\n\n"
                    "Now send the Telebirr payment screenshot "
                    "here in this bot chat.\n\n"
                    "The screenshot will be posted to the proof channel."
                )
            )

            telegram_api(
                "answerCallbackQuery",
                {
                    "callback_query_id":
                        callback_id,
                    "text":
                        "Approved. Send payment screenshot."
                }
            )

    finally:
        conn.close()


def handle_admin_photo(message):

    admin_id = int(
        message["from"]["id"]
    )

    if admin_id != ADMIN_ID:
        return

    conn = get_db()

    try:

        cur = conn.cursor(
            cursor_factory=RealDictCursor
        )

        cur.execute("""
            SELECT withdrawal_id
            FROM admin_proof_queue
            WHERE admin_id=%s
        """, (ADMIN_ID,))

        queue = cur.fetchone()

        if not queue:

            send_message(
                ADMIN_ID,
                "No withdrawal is waiting for payment proof."
            )

            return

        withdrawal_id = queue["withdrawal_id"]

        cur.execute("""
            SELECT *
            FROM withdrawals
            WHERE id=%s
        """, (withdrawal_id,))

        withdrawal = cur.fetchone()

        if not withdrawal:

            cur.execute("""
                DELETE FROM admin_proof_queue
                WHERE admin_id=%s
            """, (ADMIN_ID,))

            conn.commit()

            return

        photos = message.get(
            "photo",
            []
        )

        if not photos:
            return

        caption = (
            "ADEWA PAYMENT PROOF\n\n"
            f"Withdrawal: #{withdrawal_id}\n"
            f"User ID: {withdrawal['telegram_id']}\n"
            f"Amount: {withdrawal['amount']} ETB\n"
            f"Telebirr Name: {withdrawal['telebirr_name']}\n"
            f"Telebirr Number: {withdrawal['telebirr_number']}\n"
            "Status: PAID"
        )

        copied = telegram_api(
            "copyMessage",
            {
                "chat_id": PROOF_CHANNEL,
                "from_chat_id": ADMIN_ID,
                "message_id": message["message_id"],
                "caption": caption
            }
        )

        proof_message_id = copied.get(
            "message_id"
        )

        cur.execute("""
            UPDATE withdrawals
            SET
                status='paid',
                completed_at=NOW(),
                proof_message_id=%s
            WHERE id=%s
        """, (
            proof_message_id,
            withdrawal_id
        ))

        cur.execute("""
            DELETE FROM admin_proof_queue
            WHERE admin_id=%s
        """, (ADMIN_ID,))

        conn.commit()

        send_message(
            withdrawal["telegram_id"],
            (
                "Payment completed.\n\n"
                f"Amount: {withdrawal['amount']} ETB\n"
                "Your payment proof has been posted."
            )
        )

        send_message(
            ADMIN_ID,
            (
                f"Withdrawal #{withdrawal_id} completed successfully.\n"
                "Proof posted to the proof channel."
            )
        )

    except Exception as e:

        conn.rollback()

        send_message(
            ADMIN_ID,
            f"Could not process proof:\n{e}"
        )

    finally:
        conn.close()


# ============================================================
# ADMIN COMMANDS
# ============================================================

def handle_admin_command(message):

    admin_id = int(
        message["from"]["id"]
    )

    if admin_id != ADMIN_ID:
        return False

    text = (
        message.get("text", "")
        .strip()
    )

    if not text.startswith("/"):
        return False

    parts = text.split()

    command = parts[0].split("@")[0].lower()

    if command == "/withdraw_lock":

        set_setting(
            "withdrawal_enabled",
            "false"
        )

        send_message(
            ADMIN_ID,
            "Withdrawals are now LOCKED."
        )

        return True

    if command == "/withdraw_unlock":

        set_setting(
            "withdrawal_enabled",
            "true"
        )

        send_message(
            ADMIN_ID,
            "Withdrawals are now OPEN."
        )

        return True

    if command == "/set_ad_reward":

        if len(parts) < 2:
            send_message(
                ADMIN_ID,
                "Usage: /set_ad_reward 0.50"
            )
            return True

        set_setting(
            "ad_reward",
            parts[1]
        )

        send_message(
            ADMIN_ID,
            f"Ad reward set to {parts[1]} ETB."
        )

        return True

    if command == "/set_ref_reward":

        if len(parts) < 2:
            send_message(
                ADMIN_ID,
                "Usage: /set_ref_reward 1"
            )
            return True

        set_setting(
            "referral_reward",
            parts[1]
        )

        send_message(
            ADMIN_ID,
            f"Referral reward set to {parts[1]} ETB."
        )

        return True

    if command == "/set_ref_required":

        if len(parts) < 2:
            send_message(
                ADMIN_ID,
                "Usage: /set_ref_required 10"
            )
            return True

        set_setting(
            "referral_required",
            parts[1]
        )

        send_message(
            ADMIN_ID,
            f"Qualified referral requirement: {parts[1]}"
        )

        return True

    if command == "/set_min_withdraw":

        if len(parts) < 2:
            send_message(
                ADMIN_ID,
                "Usage: /set_min_withdraw 10"
            )
            return True

        set_setting(
            "min_withdraw",
            parts[1]
        )

        send_message(
            ADMIN_ID,
            f"Minimum withdrawal: {parts[1]} ETB"
        )

        return True

    if command == "/set_withdraw_cooldown":

        if len(parts) < 2:
            send_message(
                ADMIN_ID,
                "Usage: /set_withdraw_cooldown 48"
            )
            return True

        set_setting(
            "withdrawal_cooldown_hours",
            parts[1]
        )

        send_message(
            ADMIN_ID,
            f"Withdrawal cooldown: {parts[1]} hours"
        )

        return True

    if command == "/set_spin_price":

        if len(parts) < 2:
            send_message(
                ADMIN_ID,
                "Usage: /set_spin_price 2"
            )
            return True

        set_setting(
            "spin_price",
            parts[1]
        )

        send_message(
            ADMIN_ID,
            f"Spin price: {parts[1]} ETB"
        )

        return True

    if command == "/set_spin_spins":

        if len(parts) < 2:
            send_message(
                ADMIN_ID,
                "Usage: /set_spin_spins 10"
            )
            return True

        set_setting(
            "spin_spins",
            parts[1]
        )

        send_message(
            ADMIN_ID,
            f"Spins per purchase: {parts[1]}"
        )

        return True

    if command == "/setchannel":

        if len(parts) < 4:

            send_message(
                ADMIN_ID,
                (
                    "Usage:\n"
                    "/setchannel 1 @channel "
                    "https://t.me/channel Title"
                )
            )

            return True

        number = parts[1]

        channel_id = parts[2]
        channel_url = parts[3]

        title = " ".join(parts[4:]) \
            if len(parts) > 4 \
            else f"Channel {number}"

        set_setting(
            f"channel_{number}_id",
            channel_id
        )

        set_setting(
            f"channel_{number}_url",
            channel_url
        )

        set_setting(
            f"channel_{number}_title",
            title
        )

        send_message(
            ADMIN_ID,
            (
                f"Channel {number} updated.\n\n"
                f"ID: {channel_id}\n"
                f"URL: {channel_url}\n"
                f"Title: {title}"
            )
        )

        return True

    if command == "/stats":

        conn = get_db()

        try:

            cur = conn.cursor()

            cur.execute(
                "SELECT COUNT(*) FROM users"
            )

            users = cur.fetchone()[0]

            cur.execute("""
                SELECT COUNT(*)
                FROM referrals
                WHERE qualified=TRUE
            """)

            qualified = cur.fetchone()[0]

            cur.execute("""
                SELECT COALESCE(
                    SUM(amount),
                    0
                )
                FROM withdrawals
                WHERE status='paid'
            """)

            paid = cur.fetchone()[0]

        finally:
            conn.close()

        send_message(
            ADMIN_ID,
            (
                "ADEWA STATISTICS\n\n"
                f"Users: {users}\n"
                f"Qualified referrals: {qualified}\n"
                f"Paid withdrawals: {paid} ETB"
            )
        )

        return True

    return False


def handle_start(message):

    user = message.get(
        "from",
        {}
    )

    telegram_id = int(
        user.get("id")
    )

    upsert_user(user)

    text = message.get(
        "text",
        ""
    )

    parts = text.split(maxsplit=1)

    if len(parts) > 1:

        start_parameter = parts[1].strip()

        if start_parameter.startswith(
            "ref_"
        ):

            try:

                inviter_id = int(
                    start_parameter[4:]
                )

                create_referral(
                    inviter_id,
                    telegram_id
                )

            except Exception:
                pass

    keyboard = None

    if WEBAPP_URL:

        keyboard = {
            "inline_keyboard": [
                [
                    {
                        "text": "Open Adewa",
                        "web_app": {
                            "url": WEBAPP_URL
                        }
                    }
                ]
            ]
        }

    send_message(
        telegram_id,
        (
            "Welcome to Adewa.\n\n"
            "Open the Mini App to watch ads, "
            "complete tasks, earn rewards and withdraw."
        ),
        keyboard
    )


@app.post("/telegram/webhook")
def telegram_webhook():

    if not check_webhook_secret():

        return jsonify({
            "ok": False,
            "error": "Unauthorized"
        }), 403

    update = request.get_json(
        silent=True
    ) or {}

    try:

        ensure_db()

        if "callback_query" in update:

            handle_callback_query(
                update["callback_query"]
            )

        elif "message" in update:

            message = update["message"]

            sender = message.get(
                "from",
                {}
            )

            sender_id = int(
                sender.get("id", 0)
            )

            # Admin payment proof
            if (
                sender_id == ADMIN_ID
                and message.get("photo")
            ):

                handle_admin_photo(
                    message
                )

            elif message.get("text"):

                text = message["text"]

                if text.startswith("/start"):

                    handle_start(
                        message
                    )

                elif sender_id == ADMIN_ID:

                    handle_admin_command(
                        message
                    )

        return jsonify({
            "ok": True
        })

    except Exception as e:

        print(
            "Webhook error:",
            e
        )

        return jsonify({
            "ok": True
        })


# ============================================================
# VERCEL ENTRY
# ============================================================

if __name__ == "__main__":

    ensure_db()

    app.run(
        host="0.0.0.0",
        port=int(
            os.getenv(
                "PORT",
                "5000"
            )
        ),
        debug=False
  )
