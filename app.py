# ============================================================
# ADEWA - app.py
# Flask + PostgreSQL + Telegram Bot API
# ============================================================

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
# APP
# ============================================================

app = Flask(__name__)


# ============================================================
# ENVIRONMENT VARIABLES
# ============================================================

BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()

DATABASE_URL = os.getenv("DATABASE_URL", "").strip()

ADMIN_ID = int(
    os.getenv(
        "ADMIN_ID",
        "8845432223"
    )
)

PROOF_CHANNEL = os.getenv(
    "PROOF_CHANNEL",
    "@proof_chnallel"
).strip()

BOT_USERNAME = os.getenv(
    "BOT_USERNAME",
    ""
).strip().lstrip("@")

WEBAPP_URL = os.getenv(
    "WEBAPP_URL",
    ""
).strip()

WEBHOOK_SECRET = os.getenv(
    "WEBHOOK_SECRET",
    ""
).strip()

DATABASE_SSLMODE = os.getenv(
    "DATABASE_SSLMODE",
    "require"
)

CHANNEL_CACHE_SECONDS = int(
    os.getenv(
        "CHANNEL_CACHE_SECONDS",
        "600"
    )
)

AD_MIN_SECONDS = int(
    os.getenv(
        "AD_MIN_SECONDS",
        "5"
    )
)

AD_COOLDOWN_SECONDS = int(
    os.getenv(
        "AD_COOLDOWN_SECONDS",
        "20"
    )
)

AD_SESSION_TIMEOUT = int(
    os.getenv(
        "AD_SESSION_TIMEOUT",
        "1800"
    )
)

ADDIS_TIMEZONE = ZoneInfo(
    "Africa/Addis_Ababa"
)

DB_READY = False


# ============================================================
# DEFAULT SETTINGS
# ============================================================

DEFAULT_SETTINGS = {

    # Ads
    "ad_reward": "0.50",

    # Referrals
    "referral_reward": "1.00",
    "referral_required": "10",

    # Withdrawal
    "withdrawal_enabled": "true",
    "withdrawal_cooldown_hours": "48",
    "min_withdraw": "1.00",

    # Spin
    "spin_price": "2.00",
    "spin_spins": "10",

    # Daily ads
    "daily_limit_1": "10",
    "daily_limit_2": "15",
    "daily_limit_3": "20",
}


# ============================================================
# DATABASE
# ============================================================

def db():
    if not DATABASE_URL:
        raise RuntimeError(
            "DATABASE_URL is missing"
        )

    return psycopg2.connect(
        DATABASE_URL,
        sslmode=DATABASE_SSLMODE
    )


def init_database():

    global DB_READY

    if DB_READY:
        return

    connection = db()

    try:

        cursor = connection.cursor()

        # ----------------------------------------------------
        # USERS
        # ----------------------------------------------------

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (

                id BIGSERIAL PRIMARY KEY,

                telegram_id BIGINT
                    UNIQUE NOT NULL,

                username TEXT,

                first_name TEXT,

                last_name TEXT,

                balance NUMERIC(18,2)
                    NOT NULL DEFAULT 0,

                streak INTEGER
                    NOT NULL DEFAULT 0,

                last_streak_date DATE,

                spins INTEGER
                    NOT NULL DEFAULT 0,

                created_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW(),

                updated_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW()
            );
        """)

        # ----------------------------------------------------
        # SETTINGS
        # ----------------------------------------------------

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS settings (

                key TEXT PRIMARY KEY,

                value TEXT NOT NULL
            );
        """)

        # ----------------------------------------------------
        # MEMBERSHIP CACHE
        # ----------------------------------------------------

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS membership_cache (

                telegram_id BIGINT NOT NULL,

                channel_id TEXT NOT NULL,

                is_member BOOLEAN
                    NOT NULL DEFAULT FALSE,

                checked_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW(),

                PRIMARY KEY (
                    telegram_id,
                    channel_id
                )
            );
        """)

        # ----------------------------------------------------
        # DAILY STATS
        # ----------------------------------------------------

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS daily_stats (

                telegram_id BIGINT NOT NULL,

                day DATE NOT NULL,

                ads_watched INTEGER
                    NOT NULL DEFAULT 0,

                target INTEGER
                    NOT NULL,

                completed BOOLEAN
                    NOT NULL DEFAULT FALSE,

                completed_at TIMESTAMPTZ,

                PRIMARY KEY (
                    telegram_id,
                    day
                )
            );
        """)

        # ----------------------------------------------------
        # AD SESSIONS
        # ----------------------------------------------------

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS ad_sessions (

                id TEXT PRIMARY KEY,

                telegram_id BIGINT NOT NULL,

                started_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW(),

                completed_at TIMESTAMPTZ,

                status TEXT
                    NOT NULL DEFAULT 'started',

                reward NUMERIC(18,2)
                    NOT NULL DEFAULT 0
            );
        """)

        # ----------------------------------------------------
        # REFERRALS
        # ----------------------------------------------------

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS referrals (

                id BIGSERIAL PRIMARY KEY,

                inviter_id BIGINT NOT NULL,

                referred_id BIGINT
                    UNIQUE NOT NULL,

                created_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW(),

                qualified BOOLEAN
                    NOT NULL DEFAULT FALSE,

                qualified_at TIMESTAMPTZ
            );
        """)

        # ----------------------------------------------------
        # TASKS
        # ----------------------------------------------------

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS tasks (

                id BIGSERIAL PRIMARY KEY,

                title TEXT NOT NULL,

                task_type TEXT NOT NULL,

                url TEXT,

                channel_id TEXT,

                reward NUMERIC(18,2)
                    NOT NULL DEFAULT 0,

                max_users INTEGER,

                completed_count INTEGER
                    NOT NULL DEFAULT 0,

                active BOOLEAN
                    NOT NULL DEFAULT TRUE,

                persistent BOOLEAN
                    NOT NULL DEFAULT FALSE,

                created_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW()
            );
        """)

        # ----------------------------------------------------
        # TASK COMPLETIONS
        # ----------------------------------------------------

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS task_completions (

                id BIGSERIAL PRIMARY KEY,

                task_id BIGINT NOT NULL
                    REFERENCES tasks(id)
                    ON DELETE CASCADE,

                telegram_id BIGINT NOT NULL,

                status TEXT
                    NOT NULL DEFAULT 'completed',

                proof_file_id TEXT,

                created_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW(),

                reviewed_at TIMESTAMPTZ,

                UNIQUE (
                    task_id,
                    telegram_id
                )
            );
        """)

        # ----------------------------------------------------
        # WITHDRAWALS
        # ----------------------------------------------------

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS withdrawals (

                id BIGSERIAL PRIMARY KEY,

                telegram_id BIGINT NOT NULL,

                amount NUMERIC(18,2)
                    NOT NULL,

                telebirr_name TEXT NOT NULL,

                telebirr_number TEXT NOT NULL,

                status TEXT
                    NOT NULL DEFAULT 'pending',

                requested_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW(),

                reviewed_at TIMESTAMPTZ,

                completed_at TIMESTAMPTZ,

                proof_message_id BIGINT,

                admin_note TEXT
            );
        """)

        # ----------------------------------------------------
        # ADMIN PROOF QUEUE
        # ----------------------------------------------------

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS admin_proof_queue (

                admin_id BIGINT PRIMARY KEY,

                withdrawal_id BIGINT NOT NULL
            );
        """)

        # ----------------------------------------------------
        # SPIN TRANSACTIONS
        # ----------------------------------------------------

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS spin_transactions (

                id BIGSERIAL PRIMARY KEY,

                telegram_id BIGINT NOT NULL,

                reward NUMERIC(18,2)
                    NOT NULL DEFAULT 0,

                created_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW()
            );
        """)

        # ----------------------------------------------------
        # DEFAULT SETTINGS
        # ----------------------------------------------------

        for key, value in DEFAULT_SETTINGS.items():

            cursor.execute("""
                INSERT INTO settings(
                    key,
                    value
                )
                VALUES(%s, %s)

                ON CONFLICT(key)
                DO NOTHING
            """, (
                key,
                value
            ))

        connection.commit()

        DB_READY = True

    finally:

        connection.close()


def ensure_database():

    if not DB_READY:
        init_database()


# ============================================================
# SETTINGS
# ============================================================

def get_setting(
    key,
    default=None
):

    ensure_database()

    connection = db()

    try:

        cursor = connection.cursor()

        cursor.execute("""
            SELECT value
            FROM settings
            WHERE key=%s
        """, (key,))

        row = cursor.fetchone()

        if not row:
            return default

        return row[0]

    finally:

        connection.close()


def set_setting(
    key,
    value
):

    ensure_database()

    connection = db()

    try:

        cursor = connection.cursor()

        cursor.execute("""
            INSERT INTO settings(
                key,
                value
            )
            VALUES(%s, %s)

            ON CONFLICT(key)

            DO UPDATE SET
                value=EXCLUDED.value
        """, (
            key,
            str(value)
        ))

        connection.commit()

    finally:

        connection.close()


def get_float(
    key,
    default
):

    try:

        return float(
            get_setting(
                key,
                str(default)
            )
        )

    except Exception:

        return default


def get_int(
    key,
    default
):

    try:

        return int(
            get_setting(
                key,
                str(default)
            )
        )

    except Exception:

        return default


def get_bool(
    key,
    default=False
):

    value = str(
        get_setting(
            key,
            "true"
            if default
            else "false"
        )
    ).lower()

    return value in (
        "true",
        "1",
        "yes",
        "on"
    )


# ============================================================
# TELEGRAM API
# ============================================================

def telegram(
    method,
    data=None
):

    if not BOT_TOKEN:

        raise RuntimeError(
            "BOT_TOKEN is missing"
        )

    url = (
        "https://api.telegram.org/"
        f"bot{BOT_TOKEN}/{method}"
    )

    response = requests.post(
        url,
        json=data or {},
        timeout=20
    )

    result = response.json()

    if not result.get("ok"):

        raise RuntimeError(
            result.get(
                "description",
                "Telegram API error"
            )
        )

    return result.get(
        "result"
    )


def send_message(
    chat_id,
    text,
    keyboard=None
):

    data = {
        "chat_id": chat_id,
        "text": text
    }

    if keyboard:
        data["reply_markup"] = keyboard

    return telegram(
        "sendMessage",
        data
    )


# ============================================================
# TELEGRAM MINI APP AUTH
# ============================================================

def verify_init_data(
    init_data
):

    if not init_data:
        return None

    if not BOT_TOKEN:
        return None

    try:

        data = dict(
            parse_qsl(
                init_data,
                keep_blank_values=True
            )
        )

        received_hash = data.pop(
            "hash",
            None
        )

        if not received_hash:
            return None

        data_check_string = "\n".join(
            f"{key}={value}"
            for key, value
            in sorted(data.items())
        )

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
            data.get(
                "auth_date",
                "0"
            )
        )

        if auth_date:

            now = int(
                datetime.now(
                    timezone.utc
                ).timestamp()
            )

            # 24-hour maximum age
            if now - auth_date > 86400:
                return None

        telegram_user = data.get(
            "user"
        )

        if not telegram_user:
            return None

        return json.loads(
            telegram_user
        )

    except Exception:

        return None


def authenticated_user():

    init_data = request.headers.get(
        "X-Telegram-Init-Data",
        ""
    )

    return verify_init_data(
        init_data
    )


# ============================================================
# USER
# ============================================================

def save_user(
    telegram_user
):

    telegram_id = int(
        telegram_user["id"]
    )

    username = telegram_user.get(
        "username"
    )

    first_name = telegram_user.get(
        "first_name"
    )

    last_name = telegram_user.get(
        "last_name"
    )

    connection = db()

    try:

        cursor = connection.cursor(
            cursor_factory=RealDictCursor
        )

        cursor.execute("""
            INSERT INTO users(
                telegram_id,
                username,
                first_name,
                last_name
            )

            VALUES(
                %s,
                %s,
                %s,
                %s
            )

            ON CONFLICT(telegram_id)

            DO UPDATE SET

                username=
                    EXCLUDED.username,

                first_name=
                    EXCLUDED.first_name,

                last_name=
                    EXCLUDED.last_name,

                updated_at=
                    NOW()

            RETURNING *
        """, (
            telegram_id,
            username,
            first_name,
            last_name
        ))

        user = cursor.fetchone()

        connection.commit()

        return user

    finally:

        connection.close()


def require_user(function):

    @wraps(function)
    def wrapper(*args, **kwargs):

        try:

            ensure_database()

            telegram_user = authenticated_user()

            if not telegram_user:

                return jsonify({
                    "ok": False,
                    "error":
                        "Invalid Telegram authentication"
                }), 401

            user = save_user(
                telegram_user
            )

            g.telegram_id = int(
                telegram_user["id"]
            )

            g.user = user

            return function(
                *args,
                **kwargs
            )

        except Exception as error:

            print(
                "API ERROR:",
                error
            )

            return jsonify({
                "ok": False,
                "error": str(error)
            }), 500

    return wrapper


# ============================================================
# CHANNEL CONFIG
# ============================================================

def required_channels():

    channels = []

    for number in range(1, 6):

        channel_id = get_setting(
            f"channel_{number}_id",
            os.getenv(
                f"CHANNEL_{number}_ID",
                ""
            ).strip()
        )

        channel_url = get_setting(
            f"channel_{number}_url",
            os.getenv(
                f"CHANNEL_{number}_URL",
                ""
            ).strip()
        )

        channel_title = get_setting(
            f"channel_{number}_title",
            os.getenv(
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


# ============================================================
# CHANNEL MEMBERSHIP
# ============================================================

def channel_member(
    telegram_id,
    channel,
    force=False
):

    channel_id = str(
        channel["id"]
    )

    connection = db()

    try:

        cursor = connection.cursor(
            cursor_factory=RealDictCursor
        )

        # ----------------------------------------------------
        # CACHE
        # ----------------------------------------------------

        if not force:

            cursor.execute("""
                SELECT
                    is_member,
                    checked_at

                FROM membership_cache

                WHERE telegram_id=%s
                  AND channel_id=%s
            """, (
                telegram_id,
                channel_id
            ))

            cached = cursor.fetchone()

            if cached:

                age = (
                    datetime.now(
                        timezone.utc
                    )
                    - cached["checked_at"]
                ).total_seconds()

                if age < CHANNEL_CACHE_SECONDS:

                    return bool(
                        cached["is_member"]
                    )

        # ----------------------------------------------------
        # LIVE CHECK
        # ----------------------------------------------------

        result = telegram(
            "getChatMember",
            {
                "chat_id":
                    channel_id,

                "user_id":
                    telegram_id
            }
        )

        status = result.get(
            "status"
        )

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

        cursor.execute("""
            INSERT INTO membership_cache(
                telegram_id,
                channel_id,
                is_member,
                checked_at
            )

            VALUES(
                %s,
                %s,
                %s,
                NOW()
            )

            ON CONFLICT(
                telegram_id,
                channel_id
            )

            DO UPDATE SET

                is_member=
                    EXCLUDED.is_member,

                checked_at=
                    NOW()
        """, (
            telegram_id,
            channel_id,
            is_member
        ))

        connection.commit()

        return is_member

    finally:

        connection.close()


def check_all_channels(
    telegram_id,
    force=False
):

    channels = required_channels()

    if len(channels) < 5:

        return {

            "all_joined": False,

            "error":
                "Five channels are not configured",

            "channels": []
        }

    result = []

    all_joined = True

    for channel in channels:

        try:

            joined = channel_member(
                telegram_id,
                channel,
                force
            )

        except Exception as error:

            print(
                "Channel check error:",
                error
            )

            joined = False

        result.append({

            "number":
                channel["number"],

            "id":
                channel["id"],

            "title":
                channel["title"],

            "url":
                channel["url"],

            "joined":
                joined
        })

        if not joined:
            all_joined = False

    return {

        "all_joined":
            all_joined,

        "channels":
            result
    }


# ============================================================
# LEVEL / DAILY ADS
# ============================================================

def user_level(
    streak
):

    if streak >= 14:
        return 3

    if streak >= 7:
        return 2

    return 1


def daily_limit(
    streak
):

    level = user_level(
        streak
    )

    return get_int(
        f"daily_limit_{level}",
        10
        if level == 1
        else 15
        if level == 2
        else 20
    )


def addis_today():

    return datetime.now(
        ADDIS_TIMEZONE
    ).date()


def daily_row(
    connection,
    telegram_id,
    day,
    target
):

    cursor = connection.cursor(
        cursor_factory=RealDictCursor
    )

    cursor.execute("""
        INSERT INTO daily_stats(
            telegram_id,
            day,
            target
        )

        VALUES(
            %s,
            %s,
            %s
        )

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

    cursor.execute("""
        SELECT *
        FROM daily_stats

        WHERE telegram_id=%s
          AND day=%s

        FOR UPDATE
    """, (
        telegram_id,
        day
    ))

    return cursor.fetchone()


def update_streak(
    connection,
    telegram_id,
    today
):

    cursor = connection.cursor(
        cursor_factory=RealDictCursor
    )

    cursor.execute("""
        SELECT
            streak,
            last_streak_date

        FROM users

        WHERE telegram_id=%s

        FOR UPDATE
    """, (
        telegram_id,
    ))

    user = cursor.fetchone()

    streak = user["streak"] or 0

    last_date = (
        user["last_streak_date"]
    )

    if last_date == today:

        new_streak = streak

    elif (
        last_date
        and last_date ==
        today - timedelta(days=1)
    ):

        new_streak = streak + 1

    else:

        new_streak = 1

    cursor.execute("""
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
# HOME
# ============================================================

@app.get("/api/me")
@require_user
def me():

    connection = db()

    try:

        cursor = connection.cursor(
            cursor_factory=RealDictCursor
        )

        cursor.execute("""
            SELECT *
            FROM users
            WHERE telegram_id=%s
        """, (
            g.telegram_id,
        ))

        user = cursor.fetchone()

        today = addis_today()

        limit = daily_limit(
            user["streak"]
        )

        cursor.execute("""
            SELECT ads_watched
            FROM daily_stats

            WHERE telegram_id=%s
              AND day=%s
        """, (
            g.telegram_id,
            today
        ))

        stat = cursor.fetchone()

        ads_watched = (
            stat["ads_watched"]
            if stat
            else 0
        )

        cursor.execute("""
            SELECT COUNT(*)
            FROM referrals

            WHERE inviter_id=%s
              AND qualified=TRUE
        """, (
            g.telegram_id,
        ))

        qualified_referrals = (
            cursor.fetchone()[0]
        )

        return jsonify({

            "ok": True,

            "user": {

                "telegramId":
                    g.telegram_id,

                "username":
                    user["username"],

                "firstName":
                    user["first_name"],

                "lastName":
                    user["last_name"],

                "balance":
                    float(user["balance"]),

                "streak":
                    user["streak"],

                "level":
                    user_level(
                        user["streak"]
                    ),

                "adsWatched":
                    ads_watched,

                "adsLimit":
                    limit,

                "adsRemaining":
                    max(
                        0,
                        limit - ads_watched
                    ),

                "spins":
                    user["spins"],

                "qualifiedReferrals":
                    qualified_referrals
            },

            "settings": {

                "adReward":
                    get_float(
                        "ad_reward",
                        0.50
                    ),

                "referralRequired":
                    get_int(
                        "referral_required",
                        10
                    ),

                "withdrawalEnabled":
                    get_bool(
                        "withdrawal_enabled",
                        True
                    )
            }
        })

    finally:

        connection.close()


# ============================================================
# FRONTEND CONFIG
# ============================================================

@app.get("/api/config")
@require_user
def config():

    return jsonify({

        "ok": True,

        "channels":
            required_channels(),

        "adReward":
            get_float(
                "ad_reward",
                0.50
            ),

        "referralRequired":
            get_int(
                "referral_required",
                10
            ),

        "withdrawalEnabled":
            get_bool(
                "withdrawal_enabled",
                True
            ),

        "withdrawalCooldown":
            get_int(
                "withdrawal_cooldown_hours",
                48
            ),

        "spinPrice":
            get_float(
                "spin_price",
                2
            ),

        "spinSpins":
            get_int(
                "spin_spins",
                10
            )
    })


# ============================================================
# CHANNEL CHECK API
# ============================================================

@app.post("/api/channels/check")
@require_user
def channels_check():

    body = request.get_json(
        silent=True
    ) or {}

    channel_id = str(
        body.get(
            "channelId",
            ""
        )
    )

    channel = next(
        (
            item
            for item in required_channels()
            if str(item["id"])
            == channel_id
        ),
        None
    )

    if not channel:

        return jsonify({

            "ok": False,

            "error":
                "Channel not found"
        }), 404

    joined = channel_member(
        g.telegram_id,
        channel,
        force=False
    )

    return jsonify({

        "ok": True,

        "channelId":
            channel_id,

        "joined":
            joined
    })


# ============================================================
# ADS - START
# ============================================================

@app.post("/api/ads/start")
@require_user
def ads_start():

    membership = check_all_channels(
        g.telegram_id,
        force=False
    )

    if not membership["all_joined"]:

        return jsonify({

            "ok": False,

            "error":
                "Join all required channels first",

            "channels":
                membership["channels"]
        }), 403

    connection = db()

    try:

        cursor = connection.cursor(
            cursor_factory=RealDictCursor
        )

        cursor.execute("""
            SELECT streak
            FROM users

            WHERE telegram_id=%s

            FOR UPDATE
        """, (
            g.telegram_id,
        ))

        user = cursor.fetchone()

        limit = daily_limit(
            user["streak"]
        )

        today = addis_today()

        stat = daily_row(
            connection,
            g.telegram_id,
            today,
            limit
        )

        if stat["ads_watched"] >= limit:

            connection.commit()

            return jsonify({

                "ok": False,

                "error":
                    "Daily ad limit reached",

                "adsWatched":
                    stat["ads_watched"],

                "adsLimit":
                    limit
            }), 400

        # ----------------------------------------------------
        # COOLDOWN
        # ----------------------------------------------------

        cursor.execute("""
            SELECT completed_at

            FROM ad_sessions

            WHERE telegram_id=%s
              AND status='completed'

            ORDER BY completed_at DESC

            LIMIT 1
        """, (
            g.telegram_id,
        ))

        last_ad = cursor.fetchone()

        if last_ad:

            elapsed = (
                datetime.now(
                    timezone.utc
                )
                - last_ad["completed_at"]
            ).total_seconds()

            if elapsed < AD_COOLDOWN_SECONDS:

                wait = int(
                    AD_COOLDOWN_SECONDS
                    - elapsed
                )

                connection.commit()

                return jsonify({

                    "ok": False,

                    "error":
                        f"Please wait {wait} seconds"
                }), 429

        session_id = str(
            uuid4()
        )

        cursor.execute("""
            INSERT INTO ad_sessions(
                id,
                telegram_id,
                status
            )

            VALUES(
                %s,
                %s,
                'started'
            )
        """, (
            session_id,
            g.telegram_id
        ))

        connection.commit()

        return jsonify({

            "ok": True,

            "sessionId":
                session_id,

            "minimumSeconds":
                AD_MIN_SECONDS
        })

    finally:

        connection.close()


# ============================================================
# ADS - COMPLETE
# ============================================================

@app.post("/api/ads/complete")
@require_user
def ads_complete():

    body = request.get_json(
        silent=True
    ) or {}

    session_id = str(
        body.get(
            "sessionId",
            ""
        )
    )

    if not session_id:

        return jsonify({

            "ok": False,

            "error":
                "Missing session ID"
        }), 400

    connection = db()

    try:

        cursor = connection.cursor(
            cursor_factory=RealDictCursor
        )

        cursor.execute("""
            SELECT *
            FROM ad_sessions

            WHERE id=%s
              AND telegram_id=%s

            FOR UPDATE
        """, (
            session_id,
            g.telegram_id
        ))

        session = cursor.fetchone()

        if not session:

            connection.rollback()

            return jsonify({

                "ok": False,

                "error":
                    "Invalid ad session"
            }), 400

        if session["status"] != "started":

            connection.rollback()

            return jsonify({

                "ok": False,

                "error":
                    "Ad session already used"
            }), 400

        elapsed = (
            datetime.now(
                timezone.utc
            )
            - session["started_at"]
        ).total_seconds()

        if elapsed < AD_MIN_SECONDS:

            connection.rollback()

            return jsonify({

                "ok": False,

                "error":
                    "Ad was not completed"
            }), 400

        if elapsed > AD_SESSION_TIMEOUT:

            connection.rollback()

            return jsonify({

                "ok": False,

                "error":
                    "Ad session expired"
            }), 400

        # ----------------------------------------------------
        # CHANNEL CHECK
        # ----------------------------------------------------

        membership = check_all_channels(
            g.telegram_id,
            force=False
        )

        if not membership["all_joined"]:

            connection.rollback()

            return jsonify({

                "ok": False,

                "error":
                    "Join all required channels first"
            }), 403

        # ----------------------------------------------------
        # DAILY LIMIT
        # ----------------------------------------------------

        cursor.execute("""
            SELECT streak
            FROM users

            WHERE telegram_id=%s

            FOR UPDATE
        """, (
            g.telegram_id,
        ))

        user = cursor.fetchone()

        target = daily_limit(
            user["streak"]
        )

        today = addis_today()

        stat = daily_row(
            connection,
            g.telegram_id,
            today,
            target
        )

        if stat["ads_watched"] >= target:

            connection.rollback()

            return jsonify({

                "ok": False,

                "error":
                    "Daily limit reached"
            }), 400

        reward = Decimal(
            str(
                get_float(
                    "ad_reward",
                    0.50
                )
            )
        )

        new_count = (
            stat["ads_watched"] + 1
        )

        day_completed = (
            new_count >= target
        )

        cursor.execute("""
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
            day_completed,
            day_completed,
            g.telegram_id,
            today
        ))

        cursor.execute("""
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

        if day_completed:

            streak = update_streak(
                connection,
                g.telegram_id,
                today
            )

        else:

            streak = user["streak"]

        cursor.execute("""
            UPDATE users

            SET
                balance=
                    balance+%s,

                updated_at=
                    NOW()

            WHERE telegram_id=%s

            RETURNING balance
        """, (
            reward,
            g.telegram_id
        ))

        balance = cursor.fetchone()[
            "balance"
        ]

        connection.commit()

        return jsonify({

            "ok": True,

            "reward":
                float(reward),

            "balance":
                float(balance),

            "adsWatched":
                new_count,

            "adsLimit":
                daily_limit(
                    streak
                ),

            "streak":
                streak,

            "level":
                user_level(
                    streak
                ),

            "dailyCompleted":
                day_completed
        })

    except Exception:

        connection.rollback()

        raise

    finally:

        connection.close()


# ============================================================
# TASKS
# ============================================================

@app.get("/api/tasks")
@require_user
def tasks():

    connection = db()

    try:

        cursor = connection.cursor(
            cursor_factory=RealDictCursor
        )

        cursor.execute("""
            SELECT
                t.id,
                t.title,
                t.task_type,
                t.url,
                t.channel_id,
                t.reward

            FROM tasks t

            WHERE t.active=TRUE

              AND (
                    t.max_users IS NULL

                    OR

                    t.completed_count
                    < t.max_users
              )

              AND NOT EXISTS(

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
        """, (
            g.telegram_id,
        ))

        rows = cursor.fetchall()

        return jsonify({

            "ok": True,

            "tasks": [

                {
                    "id":
                        row["id"],

                    "title":
                        row["title"],

                    "type":
                        row["task_type"],

                    "url":
                        row["url"],

                    "channelId":
                        row["channel_id"],

                    "reward":
                        float(row["reward"])
                }

                for row in rows
            ]
        })

    finally:

        connection.close()


@app.post("/api/tasks/complete")
@require_user
def complete_task():

    body = request.get_json(
        silent=True
    ) or {}

    task_id = body.get(
        "taskId"
    )

    if not task_id:

        return jsonify({

            "ok": False,

            "error":
                "Task ID required"
        }), 400

    connection = db()

    try:

        cursor = connection.cursor(
            cursor_factory=RealDictCursor
        )

        cursor.execute("""
            SELECT *
            FROM tasks

            WHERE id=%s
              AND active=TRUE

            FOR UPDATE
        """, (
            task_id,
        ))

        task = cursor.fetchone()

        if not task:

            connection.rollback()

            return jsonify({

                "ok": False,

                "error":
                    "Task unavailable"
            }), 404

        cursor.execute("""
            SELECT id
            FROM task_completions

            WHERE task_id=%s
              AND telegram_id=%s
        """, (
            task_id,
            g.telegram_id
        ))

        if cursor.fetchone():

            connection.rollback()

            return jsonify({

                "ok": False,

                "error":
                    "Task already completed"
            }), 400

        # ----------------------------------------------------
        # TELEGRAM TASK
        # ----------------------------------------------------

        if task["task_type"] in (
            "telegram",
            "channel"
        ):

            if not task["channel_id"]:

                connection.rollback()

                return jsonify({

                    "ok": False,

                    "error":
                        "Task channel missing"
                }), 400

            joined = channel_member(

                g.telegram_id,

                {
                    "id":
                        task["channel_id"],

                    "url":
                        task["url"] or "",

                    "title":
                        task["title"]
                },

                force=True
            )

            if not joined:

                connection.rollback()

                return jsonify({

                    "ok": False,

                    "error":
                        "Join the channel first"
                }), 403

            status = "completed"

        else:

            connection.rollback()

            return jsonify({

                "ok": False,

                "requiresProof":
                    True,

                "error":
                    "Screenshot proof required"
            }), 400

        reward = task["reward"]

        cursor.execute("""
            INSERT INTO task_completions(
                task_id,
                telegram_id,
                status
            )

            VALUES(
                %s,
                %s,
                %s
            )
        """, (
            task_id,
            g.telegram_id,
            status
        ))

        cursor.execute("""
            UPDATE tasks

            SET
                completed_count=
                    completed_count+1

            WHERE id=%s
        """, (
            task_id,
        ))

        if (
            task["max_users"] is not None

            and

            task["completed_count"] + 1
            >= task["max_users"]
        ):

            cursor.execute("""
                UPDATE tasks

                SET active=FALSE

                WHERE id=%s
            """, (
                task_id,
            ))

        cursor.execute("""
            UPDATE users

            SET
                balance=
                    balance+%s,

                updated_at=
                    NOW()

            WHERE telegram_id=%s

            RETURNING balance
        """, (
            reward,
            g.telegram_id
        ))

        balance = cursor.fetchone()[
            "balance"
        ]

        connection.commit()

        return jsonify({

            "ok": True,

            "reward":
                float(reward),

            "balance":
                float(balance)
        })

    except Exception:

        connection.rollback()

        raise

    finally:

        connection.close()


# ============================================================
# REFERRALS
# ============================================================

def create_referral(
    inviter_id,
    referred_id
):

    if inviter_id == referred_id:
        return False

    connection = db()

    try:

        cursor = connection.cursor()

        cursor.execute("""
            SELECT id
            FROM referrals

            WHERE referred_id=%s
        """, (
            referred_id,
        ))

        if cursor.fetchone():

            connection.commit()

            return False

        cursor.execute("""
            SELECT telegram_id
            FROM users

            WHERE telegram_id=%s
        """, (
            inviter_id,
        ))

        if not cursor.fetchone():

            connection.commit()

            return False

        cursor.execute("""
            INSERT INTO referrals(
                inviter_id,
                referred_id
            )

            VALUES(
                %s,
                %s
            )

            ON CONFLICT(
                referred_id
            )

            DO NOTHING
        """, (
            inviter_id,
            referred_id
        ))

        connection.commit()

        return True

    finally:

        connection.close()


@app.get("/api/referrals")
@require_user
def referral_list():

    connection = db()

    try:

        cursor = connection.cursor(
            cursor_factory=RealDictCursor
        )

        cursor.execute("""
            SELECT
                r.id,
                r.created_at,
                r.qualified,

                u.telegram_id,
                u.username,
                u.first_name

            FROM referrals r

            JOIN users u
              ON u.telegram_id=
                 r.referred_id

            WHERE r.inviter_id=%s

            ORDER BY r.created_at DESC
        """, (
            g.telegram_id,
        ))

        rows = cursor.fetchall()

        output = []

        for row in rows:

            cursor.execute("""
                SELECT COUNT(*)

                FROM daily_stats

                WHERE telegram_id=%s
                  AND day >= %s::date
                  AND completed=TRUE
            """, (
                row["telegram_id"],
                row["created_at"]
            ))

            days = min(
                2,
                cursor.fetchone()[0]
            )

            output.append({

                "id":
                    row["id"],

                "telegramId":
                    row["telegram_id"],

                "username":
                    row["username"],

                "name":
                    row["first_name"]
                    or "User",

                "day1":
                    days >= 1,

                "day2":
                    days >= 2,

                "progress":
                    int(
                        days / 2 * 100
                    ),

                "qualified":
                    row["qualified"]
            })

        cursor.execute("""
            SELECT COUNT(*)

            FROM referrals

            WHERE inviter_id=%s
              AND qualified=TRUE
        """, (
            g.telegram_id,
        ))

        qualified = cursor.fetchone()[0]

        referral_link = ""

        if BOT_USERNAME:

            referral_link = (
                "https://t.me/"
                + BOT_USERNAME
                + "?start=ref_"
                + str(g.telegram_id)
            )

        return jsonify({

            "ok": True,

            "qualified":
                qualified,

            "required":
                get_int(
                    "referral_required",
                    10
                ),

            "referralLink":
                referral_link,

            "referrals":
                output
        })

    finally:

        connection.close()


# ============================================================
# SPIN
# ============================================================

def spin_reward():

    roll = secrets.randbelow(
        10000
    )

    # 75% = 0
    if roll < 7500:

        return Decimal(
            "0.00"
        )

    # 18% = small reward
    if roll < 9300:

        return secrets.choice([

            Decimal("0.10"),
            Decimal("0.15"),
            Decimal("0.20"),
            Decimal("0.25"),
            Decimal("0.30")
        ])

    # 6.9% = medium reward
    if roll < 9990:

        return secrets.choice([

            Decimal("1.00"),
            Decimal("1.25"),
            Decimal("1.50"),
            Decimal("1.75"),
            Decimal("2.00"),
            Decimal("2.25"),
            Decimal("2.50")
        ])

    # 0.1% = large reward
    return secrets.choice([

        Decimal("15.00"),
        Decimal("17.50"),
        Decimal("20.00"),
        Decimal("22.50"),
        Decimal("25.00")
    ])


@app.post("/api/spin/buy")
@require_user
def spin_buy():

    price = Decimal(
        str(
            get_float(
                "spin_price",
                2
            )
        )
    )

    amount = get_int(
        "spin_spins",
        10
    )

    connection = db()

    try:

        cursor = connection.cursor(
            cursor_factory=RealDictCursor
        )

        cursor.execute("""
            SELECT
                balance,
                spins

            FROM users

            WHERE telegram_id=%s

            FOR UPDATE
        """, (
            g.telegram_id,
        ))

        user = cursor.fetchone()

        balance = Decimal(
            str(
                user["balance"]
            )
        )

        if balance < price:

            connection.rollback()

            return jsonify({

                "ok": False,

                "error":
                    "Insufficient balance"
            }), 400

        cursor.execute("""
            UPDATE users

            SET
                balance=
                    balance-%s,

                spins=
                    spins+%s,

                updated_at=
                    NOW()

            WHERE telegram_id=%s

            RETURNING balance, spins
        """, (
            price,
            amount,
            g.telegram_id
        ))

        updated = cursor.fetchone()

        connection.commit()

        return jsonify({

            "ok": True,

            "paid":
                float(price),

            "spinsAdded":
                amount,

            "balance":
                float(
                    updated["balance"]
                ),

            "spins":
                updated["spins"]
        })

    finally:

        connection.close()


@app.post("/api/spin/spin")
@require_user
def spin():

    connection = db()

    try:

        cursor = connection.cursor(
            cursor_factory=RealDictCursor
        )

        cursor.execute("""
            SELECT spins

            FROM users

            WHERE telegram_id=%s

            FOR UPDATE
        """, (
            g.telegram_id,
        ))

        user = cursor.fetchone()

        if user["spins"] <= 0:

            connection.rollback()

            return jsonify({

                "ok": False,

                "error":
                    "No spins available"
            }), 400

        reward = spin_reward()

        cursor.execute("""
            UPDATE users

            SET
                spins=
                    spins-1,

                balance=
                    balance+%s,

                updated_at=
                    NOW()

            WHERE telegram_id=%s

            RETURNING balance, spins
        """, (
            reward,
            g.telegram_id
        ))

        updated = cursor.fetchone()

        cursor.execute("""
            INSERT INTO spin_transactions(
                telegram_id,
                reward
            )

            VALUES(
                %s,
                %s
            )
        """, (
            g.telegram_id,
            reward
        ))

        connection.commit()

        return jsonify({

            "ok": True,

            "reward":
                float(reward),

            "balance":
                float(
                    updated["balance"]
                ),

            "spins":
                updated["spins"]
        })

    finally:

        connection.close()


# ============================================================
# WITHDRAWAL
# ============================================================

@app.post("/api/withdrawals")
@require_user
def withdrawal():

    body = request.get_json(
        silent=True
    ) or {}

    try:

        amount = Decimal(
            str(
                body.get(
                    "amount"
                )
            )
        )

    except Exception:

        return jsonify({

            "ok": False,

            "error":
                "Invalid amount"
        }), 400

    telebirr_name = str(
        body.get(
            "telebirrName",
            ""
        )
    ).strip()

    telebirr_number = str(
        body.get(
            "telebirrNumber",
            ""
        )
    ).strip()

    if amount <= 0:

        return jsonify({

            "ok": False,

            "error":
                "Invalid amount"
        }), 400

    if (
        not telebirr_name
        or not telebirr_number
    ):

        return jsonify({

            "ok": False,

            "error":
                "Telebirr information required"
        }), 400

    if not get_bool(
        "withdrawal_enabled",
        True
    ):

        return jsonify({

            "ok": False,

            "error":
                "Withdrawals are locked"
        }), 403

    minimum = Decimal(
        str(
            get_float(
                "min_withdraw",
                1
            )
        )
    )

    if amount < minimum:

        return jsonify({

            "ok": False,

            "error":
                f"Minimum withdrawal is "
                f"{minimum} ETB"
        }), 400

    # --------------------------------------------------------
    # FRESH/LIVE CHANNEL CHECK
    # --------------------------------------------------------

    membership = check_all_channels(
        g.telegram_id,
        force=True
    )

    if not membership["all_joined"]:

        return jsonify({

            "ok": False,

            "error":
                "Join all required channels",

            "channels":
                membership["channels"]
        }), 403

    connection = db()

    try:

        cursor = connection.cursor(
            cursor_factory=RealDictCursor
        )

        # ----------------------------------------------------
        # REFERRALS
        # ----------------------------------------------------

        cursor.execute("""
            SELECT COUNT(*)

            FROM referrals

            WHERE inviter_id=%s
              AND qualified=TRUE
        """, (
            g.telegram_id,
        ))

        qualified = cursor.fetchone()[0]

        required = get_int(
            "referral_required",
            10
        )

        if qualified < required:

            connection.rollback()

            return jsonify({

                "ok": False,

                "error":
                    "Qualified referral requirement not met",

                "qualified":
                    qualified,

                "required":
                    required
            }), 403

        # ----------------------------------------------------
        # COOLDOWN
        # ----------------------------------------------------

        cooldown = get_int(
            "withdrawal_cooldown_hours",
            48
        )

        cursor.execute("""
            SELECT requested_at

            FROM withdrawals

            WHERE telegram_id=%s

            ORDER BY requested_at DESC

            LIMIT 1
        """, (
            g.telegram_id,
        ))

        previous = cursor.fetchone()

        if previous:

            elapsed = (
                datetime.now(
                    timezone.utc
                )
                - previous["requested_at"]
            ).total_seconds()

            if elapsed < cooldown * 3600:

                remaining = int(
                    cooldown * 3600
                    - elapsed
                )

                connection.rollback()

                return jsonify({

                    "ok": False,

                    "error":
                        "Withdrawal cooldown active",

                    "remainingSeconds":
                        remaining
                }), 429

        # ----------------------------------------------------
        # BALANCE
        # ----------------------------------------------------

        cursor.execute("""
            SELECT balance

            FROM users

            WHERE telegram_id=%s

            FOR UPDATE
        """, (
            g.telegram_id,
        ))

        user = cursor.fetchone()

        balance = Decimal(
            str(
                user["balance"]
            )
        )

        if amount > balance:

            connection.rollback()

            return jsonify({

                "ok": False,

                "error":
                    "Insufficient balance"
            }), 400

        # Reserve money
        cursor.execute("""
            UPDATE users

            SET
                balance=
                    balance-%s,

                updated_at=
                    NOW()

            WHERE telegram_id=%s
        """, (
            amount,
            g.telegram_id
        ))

        cursor.execute("""
            INSERT INTO withdrawals(

                telegram_id,

                amount,

                telebirr_name,

                telebirr_number,

                status
            )

            VALUES(

                %s,
                %s,
                %s,
                %s,
                'pending'
            )

            RETURNING id
        """, (
            g.telegram_id,
            amount,
            telebirr_name,
            telebirr_number
        ))

        withdrawal_id = cursor.fetchone()[
            "id"
        ]

        connection.commit()

    except Exception:

        connection.rollback()

        raise

    finally:

        connection.close()

    # --------------------------------------------------------
    # ADMIN ALERT
    # --------------------------------------------------------

    keyboard = {

        "inline_keyboard": [

            [

                {
                    "text":
                        "Approve",

                    "callback_data":
                        f"wd:approve:{withdrawal_id}"
                },

                {
                    "text":
                        "Reject",

                    "callback_data":
                        f"wd:reject:{withdrawal_id}"
                }
            ]
        ]
    }

    try:

        send_message(

            ADMIN_ID,

            (
                "ADEWA WITHDRAWAL\n\n"

                f"ID: #{withdrawal_id}\n"

                f"User: {g.telegram_id}\n"

                f"Amount: {amount} ETB\n"

                f"Telebirr Name: "
                f"{telebirr_name}\n"

                f"Telebirr Number: "
                f"{telebirr_number}\n"

                f"Qualified Referrals: "
                f"{qualified}"
            ),

            keyboard
        )

    except Exception as error:

        print(
            "Admin notification error:",
            error
        )

    return jsonify({

        "ok": True,

        "withdrawalId":
            withdrawal_id,

        "status":
            "pending"
    })


# ============================================================
# TELEGRAM CALLBACKS
# ============================================================

def answer_callback(
    callback_id,
    text,
    alert=False
):

    telegram(
        "answerCallbackQuery",
        {
            "callback_query_id":
                callback_id,

            "text":
                text,

            "show_alert":
                alert
        }
    )


def handle_callback(
    callback
):

    callback_id = callback["id"]

    sender = callback.get(
        "from",
        {}
    )

    sender_id = int(
        sender.get(
            "id",
            0
        )
    )

    if sender_id != ADMIN_ID:

        answer_callback(
            callback_id,
            "Not authorized",
            True
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

        withdrawal_id = int(
            parts[2]
        )

    except Exception:

        return

    connection = db()

    try:

        cursor = connection.cursor(
            cursor_factory=RealDictCursor
        )

        cursor.execute("""
            SELECT *

            FROM withdrawals

            WHERE id=%s

            FOR UPDATE
        """, (
            withdrawal_id,
        ))

        withdrawal_row = cursor.fetchone()

        if not withdrawal_row:

            connection.rollback()

            answer_callback(
                callback_id,
                "Withdrawal not found",
                True
            )

            return

        if withdrawal_row["status"] != "pending":

            connection.rollback()

            answer_callback(
                callback_id,
                "Already processed",
                True
            )

            return

        # ----------------------------------------------------
        # REJECT
        # ----------------------------------------------------

        if action == "reject":

            cursor.execute("""
                UPDATE withdrawals

                SET
                    status='rejected',
                    reviewed_at=NOW()

                WHERE id=%s
            """, (
                withdrawal_id,
            ))

            # Refund
            cursor.execute("""
                UPDATE users

                SET
                    balance=
                        balance+%s,

                    updated_at=
                        NOW()

                WHERE telegram_id=%s
            """, (
                withdrawal_row["amount"],
                withdrawal_row["telegram_id"]
            ))

            connection.commit()

            try:

                send_message(

                    withdrawal_row[
                        "telegram_id"
                    ],

                    (
                        "Withdrawal rejected.\n\n"

                        f"Amount returned: "
                        f"{withdrawal_row['amount']} ETB"
                    )
                )

            except Exception:
                pass

            answer_callback(
                callback_id,
                "Withdrawal rejected"
            )

            return

        # ----------------------------------------------------
        # APPROVE
        # ----------------------------------------------------

        if action == "approve":

            cursor.execute("""
                UPDATE withdrawals

                SET
                    status='approved',
                    reviewed_at=NOW()

                WHERE id=%s
            """, (
                withdrawal_id,
            ))

            cursor.execute("""
                INSERT INTO admin_proof_queue(
                    admin_id,
                    withdrawal_id
                )

                VALUES(
                    %s,
                    %s
                )

                ON CONFLICT(admin_id)

                DO UPDATE SET
                    withdrawal_id=
                        EXCLUDED.withdrawal_id
            """, (
                ADMIN_ID,
                withdrawal_id
            ))

            connection.commit()

            try:

                send_message(

                    withdrawal_row[
                        "telegram_id"
                    ],

                    (
                        "Withdrawal approved.\n\n"

                        f"Amount: "
                        f"{withdrawal_row['amount']} ETB\n"

                        "Payment is being processed."
                    )
                )

            except Exception:
                pass

            send_message(

                ADMIN_ID,

                (
                    f"Withdrawal #{withdrawal_id} approved.\n\n"

                    "Now send the Telebirr payment "
                    "screenshot to this bot."
                )
            )

            answer_callback(
                callback_id,
                "Approved. Send payment proof."
            )

    finally:

        connection.close()


# ============================================================
# ADMIN PAYMENT PROOF
# ============================================================

def process_admin_photo(
    message
):

    sender_id = int(
        message.get(
            "from",
            {}
        ).get(
            "id",
            0
        )
    )

    if sender_id != ADMIN_ID:
        return

    connection = db()

    try:

        cursor = connection.cursor(
            cursor_factory=RealDictCursor
        )

        cursor.execute("""
            SELECT withdrawal_id

            FROM admin_proof_queue

            WHERE admin_id=%s
        """, (
            ADMIN_ID,
        ))

        queue = cursor.fetchone()

        if not queue:

            send_message(
                ADMIN_ID,
                "No payment proof is currently required."
            )

            return

        withdrawal_id = queue[
            "withdrawal_id"
        ]

        cursor.execute("""
            SELECT *

            FROM withdrawals

            WHERE id=%s
        """, (
            withdrawal_id,
        ))

        withdrawal_row = cursor.fetchone()

        if not withdrawal_row:

            return

        caption = (

            "ADEWA PAYMENT PROOF\n\n"

            f"Withdrawal: "
            f"#{withdrawal_id}\n"

            f"User ID: "
            f"{withdrawal_row['telegram_id']}\n"

            f"Amount: "
            f"{withdrawal_row['amount']} ETB\n"

            f"Telebirr Name: "
            f"{withdrawal_row['telebirr_name']}\n"

            f"Telebirr Number: "
            f"{withdrawal_row['telebirr_number']}\n"

            "Status: PAID"
        )

        copied = telegram(

            "copyMessage",

            {

                "chat_id":
                    PROOF_CHANNEL,

                "from_chat_id":
                    ADMIN_ID,

                "message_id":
                    message["message_id"],

                "caption":
                    caption
            }
        )

        proof_message_id = copied.get(
            "message_id"
        )

        cursor.execute("""
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

        cursor.execute("""
            DELETE FROM admin_proof_queue

            WHERE admin_id=%s
        """, (
            ADMIN_ID,
        ))

        connection.commit()

        send_message(

            withdrawal_row[
                "telegram_id"
            ],

            (
                "Payment completed.\n\n"

                f"Amount: "
                f"{withdrawal_row['amount']} ETB\n"

                "Payment proof has been posted."
            )
        )

        send_message(

            ADMIN_ID,

            (
                f"Withdrawal #{withdrawal_id} "
                "completed successfully."
            )
        )

    except Exception as error:

        connection.rollback()

        send_message(

            ADMIN_ID,

            (
                "Payment proof failed:\n"
                f"{error}"
            )
        )

    finally:

        connection.close()


# ============================================================
# ADMIN COMMANDS
# ============================================================

def admin_command(
    message
):

    sender_id = int(
        message.get(
            "from",
            {}
        ).get(
            "id",
            0
        )
    )

    if sender_id != ADMIN_ID:
        return False

    text = message.get(
        "text",
        ""
    ).strip()

    if not text.startswith("/"):
        return False

    parts = text.split()

    command = parts[0].split("@")[0].lower()

    # --------------------------------------------------------
    # LOCK
    # --------------------------------------------------------

    if command == "/withdraw_lock":

        set_setting(
            "withdrawal_enabled",
            "false"
        )

        send_message(
            ADMIN_ID,
            "Withdrawals LOCKED."
        )

        return True

    # --------------------------------------------------------
    # UNLOCK
    # --------------------------------------------------------

    if command == "/withdraw_unlock":

        set_setting(
            "withdrawal_enabled",
            "true"
        )

        send_message(
            ADMIN_ID,
            "Withdrawals OPEN."
        )

        return True

    # --------------------------------------------------------
    # AD REWARD
    # --------------------------------------------------------

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
            f"Ad reward = {parts[1]} ETB"
        )

        return True

    # --------------------------------------------------------
    # REFERRAL REWARD
    # --------------------------------------------------------

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
            f"Referral reward = {parts[1]} ETB"
        )

        return True

    # --------------------------------------------------------
    # REQUIRED REFERRALS
    # --------------------------------------------------------

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
            f"Required referrals = {parts[1]}"
        )

        return True

    # --------------------------------------------------------
    # MINIMUM WITHDRAW
    # --------------------------------------------------------

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
            f"Minimum withdrawal = {parts[1]} ETB"
        )

        return True

    # --------------------------------------------------------
    # DAILY LIMITS
    # --------------------------------------------------------

    if command == "/set_limits":

        if len(parts) < 4:

            send_message(
                ADMIN_ID,
                "Usage: /set_limits 10 15 20"
            )

            return True

        set_setting(
            "daily_limit_1",
            parts[1]
        )

        set_setting(
            "daily_limit_2",
            parts[2]
        )

        set_setting(
            "daily_limit_3",
            parts[3]
        )

        send_message(
            ADMIN_ID,
            (
                "Daily limits updated:\n\n"
                f"Level 1: {parts[1]}\n"
                f"Level 2: {parts[2]}\n"
                f"Level 3: {parts[3]}"
            )
        )

        return True

    # --------------------------------------------------------
    # SPIN
    # --------------------------------------------------------

    if command == "/set_spin":

        if len(parts) < 3:

            send_message(
                ADMIN_ID,
                "Usage: /set_spin 2 10"
            )

            return True

        set_setting(
            "spin_price",
            parts[1]
        )

        set_setting(
            "spin_spins",
            parts[2]
        )

        send_message(
            ADMIN_ID,
            (
                "Spin settings updated.\n\n"
                f"Price: {parts[1]} ETB\n"
                f"Spins: {parts[2]}"
            )
        )

        return True

    # --------------------------------------------------------
    # SET CHANNEL
    # --------------------------------------------------------

    if command == "/setchannel":

        if len(parts) < 4:

            send_message(

                ADMIN_ID,

                (
                    "Usage:\n\n"
                    "/setchannel 1 @channel "
                    "https://t.me/channel "
                    "Channel Title"
                )
            )

            return True

        number = parts[1]

        channel_id = parts[2]

        channel_url = parts[3]

        title = (
            " ".join(parts[4:])
            if len(parts) > 4
            else f"Channel {number}"
        )

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

    # --------------------------------------------------------
    # STATS
    # --------------------------------------------------------

    if command == "/stats":

        connection = db()

        try:

            cursor = connection.cursor()

            cursor.execute(
                "SELECT COUNT(*) FROM users"
            )

            users = cursor.fetchone()[0]

            cursor.execute("""
                SELECT COUNT(*)

                FROM referrals

                WHERE qualified=TRUE
            """)

            qualified = cursor.fetchone()[0]

            cursor.execute("""
                SELECT COALESCE(
                    SUM(amount),
                    0
                )

                FROM withdrawals

                WHERE status='paid'
            """)

            paid = cursor.fetchone()[0]

        finally:

            connection.close()

        send_message(

            ADMIN_ID,

            (
                "ADEWA STATISTICS\n\n"

                f"Users: {users}\n"

                f"Qualified referrals: "
                f"{qualified}\n"

                f"Paid withdrawals: "
                f"{paid} ETB"
            )
        )

        return True

    return False


# ============================================================
# /START + REFERRAL
# ============================================================

def handle_start(
    message
):

    telegram_user = message.get(
        "from",
        {}
    )

    telegram_id = int(
        telegram_user["id"]
    )

    save_user(
        telegram_user
    )

    text = message.get(
        "text",
        ""
    )

    parts = text.split(
        maxsplit=1
    )

    # --------------------------------------------------------
    # REFERRAL
    # --------------------------------------------------------

    if len(parts) > 1:

        parameter = parts[1].strip()

        if parameter.startswith(
            "ref_"
        ):

            try:

                inviter_id = int(
                    parameter[4:]
                )

                create_referral(
                    inviter_id,
                    telegram_id
                )

            except Exception:
                pass

    # --------------------------------------------------------
    # MINI APP BUTTON
    # --------------------------------------------------------

    keyboard = None

    if WEBAPP_URL:

        keyboard = {

            "inline_keyboard": [

                [

                    {
                        "text":
                            "Open Adewa",

                        "web_app": {
                            "url":
                                WEBAPP_URL
                        }
                    }
                ]
            ]
        }

    send_message(

        telegram_id,

        (
            "Welcome to Adewa.\n\n"

            "Open the Mini App to "
            "watch ads, complete tasks, "
            "refer users and withdraw."
        ),

        keyboard
    )


# ============================================================
# TELEGRAM WEBHOOK
# ============================================================

@app.post("/telegram/webhook")
def telegram_webhook():

    if WEBHOOK_SECRET:

        incoming_secret = request.headers.get(
            "X-Telegram-Bot-Api-Secret-Token",
            ""
        )

        if not hmac.compare_digest(
            incoming_secret,
            WEBHOOK_SECRET
        ):

            return jsonify({
                "ok": False
            }), 403

    update = request.get_json(
        silent=True
    ) or {}

    try:

        ensure_database()

        # ----------------------------------------------------
        # BUTTON
        # ----------------------------------------------------

        if "callback_query" in update:

            handle_callback(
                update["callback_query"]
            )

        # ----------------------------------------------------
        # MESSAGE
        # ----------------------------------------------------

        elif "message" in update:

            message = update["message"]

            sender_id = int(
                message.get(
                    "from",
                    {}
                ).get(
                    "id",
                    0
                )
            )

            # Admin payment proof
            if (
                sender_id == ADMIN_ID
                and message.get("photo")
            ):

                process_admin_photo(
                    message
                )

            elif message.get("text"):

                text = message["text"]

                if text.startswith(
                    "/start"
                ):

                    handle_start(
                        message
                    )

                elif sender_id == ADMIN_ID:

                    admin_command(
                        message
                    )

        return jsonify({
            "ok": True
        })

    except Exception as error:

        print(
            "Webhook error:",
            error
        )

        # Always return 200 to Telegram
        return jsonify({
            "ok": True
        })


# ============================================================
# HEALTH CHECK
# ============================================================

@app.get("/health")
def health():

    return jsonify({

        "ok": True,

        "service":
            "Adewa",

        "status":
            "online"
    })


# ============================================================
# LOCAL SERVER
# ============================================================

if __name__ == "__main__":

    ensure_database()

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
