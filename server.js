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

const MIN_WITHDRAW = Number(process.env.MIN_WITHDRAW || 100);
const MIN_REFERRALS = Number(process.env.MIN_REFERRALS || 5);
const MIN_ACCOUNT_AGE_DAYS = Number(
    process.env.MIN_ACCOUNT_AGE_DAYS || 5
);

const REFERRAL_REWARD = Number(
    process.env.REFERRAL_REWARD || 5
);

const VISIT_MIN_SECONDS = Number(
    process.env.VISIT_MIN_SECONDS || 15
);

const SPONSOR_CHANNELS = String(
    process.env.SPONSOR_CHANNELS || ""
)
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);


/* =========================================================
DATABASE
========================================================= */

const pool = new Pool({
    connectionString: DATABASE_URL,

    ssl:
        process.env.NODE_ENV === "production"
            ? {
                rejectUnauthorized: false
            }
            : false
});


/* =========================================================
MIDDLEWARE
========================================================= */

app.use(
    cors({
        origin: function (origin, callback) {

            if (!origin) {
                return callback(null, true);
            }

            const allowed = [
                process.env.FRONTEND_URL,
                "https://telegram.org",
                "https://web.telegram.org"
            ].filter(Boolean);

            if (allowed.includes(origin)) {
                return callback(null, true);
            }

            if (
                origin.startsWith(
                    "https://abdulselamahemade608-prog.github.io"
                )
            ) {
                return callback(null, true);
            }

            return callback(
                new Error("CORS blocked.")
            );
        },

        credentials: false
    })
);

app.use(
    express.json({
        limit: "100kb"
    })
);


/* =========================================================
BASIC ROUTES
========================================================= */

app.get("/", (req, res) => {

    res.json({
        ok: true,
        service: "FulusApp Backend",
        version: "2.0.0",
        status: "online"
    });

});


app.get("/health", async (req, res) => {

    try {

        await pool.query("SELECT 1");

        res.json({
            ok: true,
            database: "connected"
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            ok: false,
            database: "error"
        });
    }

});


/* =========================================================
TELEGRAM INIT DATA VALIDATION
========================================================= */

function validateTelegramInitData(initData) {

    if (!initData || !BOT_TOKEN) {
        throw new Error(
            "Missing Telegram authentication."
        );
    }

    const params = new URLSearchParams(initData);

    const receivedHash = params.get("hash");

    if (!receivedHash) {
        throw new Error(
            "Telegram hash missing."
        );
    }

    params.delete("hash");

    const dataCheckString =
        [...params.entries()]
            .sort(([a], [b]) =>
                a.localeCompare(b)
            )
            .map(([key, value]) =>
                `${key}=${value}`
            )
            .join("\n");

    const secretKey =
        crypto
            .createHmac(
                "sha256",
                "WebAppData"
            )
            .update(BOT_TOKEN)
            .digest();

    const calculatedHash =
        crypto
            .createHmac(
                "sha256",
                secretKey
            )
            .update(dataCheckString)
            .digest("hex");

    const received =
        Buffer.from(
            receivedHash,
            "hex"
        );

    const calculated =
        Buffer.from(
            calculatedHash,
            "hex"
        );

    if (
        received.length !==
        calculated.length
    ) {
        throw new Error(
            "Invalid Telegram authentication."
        );
    }

    if (
        !crypto.timingSafeEqual(
            received,
            calculated
        )
    ) {
        throw new Error(
            "Invalid Telegram authentication."
        );
    }

    const authDate =
        Number(
            params.get("auth_date")
        );

    if (
        !authDate ||
        !Number.isFinite(authDate)
    ) {
        throw new Error(
            "Invalid Telegram auth date."
        );
    }

    const age =
        Math.floor(
            Date.now() / 1000
        ) - authDate;

    if (
        age > 86400 ||
        age < -60
    ) {
        throw new Error(
            "Telegram authentication expired."
        );
    }

    const userRaw =
        params.get("user");

    if (!userRaw) {
        throw new Error(
            "Telegram user missing."
        );
    }

    let user;

    try {

        user = JSON.parse(userRaw);

    } catch {

        throw new Error(
            "Invalid Telegram user."
        );
    }

    if (!user.id) {
        throw new Error(
            "Invalid Telegram user ID."
        );
    }

    return {
        user,
        startParam:
            params.get("start_param") || null
    };
}


/* =========================================================
AUTH MIDDLEWARE
========================================================= */

async function authenticate(req, res, next) {

    try {

        const initData =
            req.headers[
                "x-telegram-init-data"
            ];

        const auth =
            validateTelegramInitData(
                initData
            );

        await upsertUser(
            auth.user,
            auth.startParam
        );

        req.telegramUser =
            auth.user;

        req.startParam =
            auth.startParam;

        next();

    } catch (error) {

        console.error(
            "AUTH:",
            error.message
        );

        return res.status(401).json({
            ok: false,
            message:
                error.message ||
                "Authentication failed."
        });
    }
}


/* =========================================================
CREATE / UPDATE USER
========================================================= */

async function upsertUser(
    telegramUser,
    startParam = null
) {

    const client =
        await pool.connect();

    try {

        await client.query("BEGIN");

        const existing =
            await client.query(
                `
                SELECT telegram_id
                FROM users
                WHERE telegram_id = $1
                FOR UPDATE
                `,
                [telegramUser.id]
            );

        if (existing.rowCount === 0) {

            const referralCode =
                generateReferralCode(
                    telegramUser.id
                );

            await client.query(
                `
                INSERT INTO users (
                    telegram_id,
                    username,
                    first_name,
                    last_name,
                    photo_url,
                    referral_code
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6
                )
                `,
                [
                    telegramUser.id,
                    telegramUser.username || null,
                    telegramUser.first_name || null,
                    telegramUser.last_name || null,
                    telegramUser.photo_url || null,
                    referralCode
                ]
            );

            await registerReferral(
                client,
                telegramUser.id,
                startParam
            );

        } else {

            await client.query(
                `
                UPDATE users
                SET
                    username = $2,
                    first_name = $3,
                    last_name = $4,
                    photo_url = $5,
                    updated_at = NOW()
                WHERE telegram_id = $1
                `,
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


/* =========================================================
REFERRAL
========================================================= */

async function registerReferral(
    client,
    newUserId,
    startParam
) {

    if (
        !startParam ||
        !String(startParam).startsWith("ref_")
    ) {
        return;
    }

    const code =
        String(startParam)
            .slice(4)
            .trim()
            .toUpperCase();

    if (!/^[A-Z0-9]{10}$/.test(code)) {
        return;
    }

    const referrerResult =
        await client.query(
            `
            SELECT telegram_id, balance
            FROM users
            WHERE referral_code = $1
            FOR UPDATE
            `,
            [code]
        );

    if (referrerResult.rowCount === 0) {
        return;
    }

    const referrerId =
        referrerResult.rows[0].telegram_id;

    if (
        String(referrerId) ===
        String(newUserId)
    ) {
        return;
    }

    const inserted =
        await client.query(
            `
            INSERT INTO referrals (
                referrer_id,
                referred_id,
                reward_paid
            )
            VALUES ($1, $2, TRUE)
            ON CONFLICT (referred_id)
            DO NOTHING
            RETURNING id
            `,
            [
                referrerId,
                newUserId
            ]
        );

    if (inserted.rowCount === 0) {
        return;
    }

    await client.query(
        `
        UPDATE users
        SET referred_by = $2
        WHERE telegram_id = $1
        `,
        [
            newUserId,
            referrerId
        ]
    );

    const before =
        Number(
            referrerResult.rows[0].balance
        );

    const after =
        before + REFERRAL_REWARD;

    await client.query(
        `
        UPDATE users
        SET
            balance = $2,
            total_earned =
                total_earned + $3,
            updated_at = NOW()
        WHERE telegram_id = $1
        `,
        [
            referrerId,
            after,
            REFERRAL_REWARD
        ]
    );

    await client.query(
        `
        INSERT INTO transactions (
            telegram_id,
            type,
            amount,
            balance_before,
            balance_after,
            reference,
            description
        )
        VALUES (
            $1,
            'referral',
            $2,
            $3,
            $4,
            $5,
            $6
        )
        `,
        [
            referrerId,
            REFERRAL_REWARD,
            before,
            after,
            `referral_${newUserId}`,
            "Referral reward"
        ]
    );
}


function generateReferralCode(
    telegramId
) {

    const hash =
        crypto
            .createHash("sha256")
            .update(
                `${telegramId}:${BOT_TOKEN}`
            )
            .digest("hex");

    return hash
        .substring(0, 10)
        .toUpperCase();
}


/* =========================================================
GET SETTING
========================================================= */

async function getSetting(
    key,
    fallback
) {

    const result =
        await pool.query(
            `
            SELECT value
            FROM settings
            WHERE key = $1
            `,
            [key]
        );

    if (result.rowCount === 0) {
        return fallback;
    }

    return result.rows[0].value;
}


/* =========================================================
TELEGRAM API
========================================================= */

async function telegramApi(
    method,
    body
) {

    const response =
        await fetch(
            `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json"
                },

                body:
                    JSON.stringify(body)
            }
        );

    const data =
        await response.json();

    if (!data.ok) {

        throw new Error(
            data.description ||
            "Telegram API error."
        );
    }

    return data.result;
}


/* =========================================================
CHANNEL MEMBERSHIP
========================================================= */

async function checkChannelMembership(
    telegramId,
    channel
) {

    try {

        const member =
            await telegramApi(
                "getChatMember",
                {
                    chat_id: channel,
                    user_id: telegramId
                }
            );

        return [
            "creator",
            "administrator",
            "member"
        ].includes(
            member.status
        ) ||
        (
            member.status ===
            "restricted" &&
            member.is_member === true
        );

    } catch (error) {

        console.error(
            `Channel check failed ${channel}:`,
            error.message
        );

        return false;
    }
}


async function checkAllSponsors(
    telegramId
) {

    if (
        SPONSOR_CHANNELS.length === 0
    ) {
        return true;
    }

    for (
        const channel
        of SPONSOR_CHANNELS
    ) {

        const joined =
            await checkChannelMembership(
                telegramId,
                channel
            );

        if (!joined) {
            return false;
        }
    }

    return true;
}


/* =========================================================
TODAY EARNINGS
========================================================= */

async function getTodayEarned(
    telegramId
) {

    const result =
        await pool.query(
            `
            SELECT COALESCE(
                SUM(amount),
                0
            ) AS total
            FROM transactions
            WHERE telegram_id = $1
            AND amount > 0
            AND created_at >= CURRENT_DATE
            `,
            [telegramId]
        );

    return Number(
        result.rows[0].total
    );
}


/* =========================================================
DATE HELPERS
========================================================= */

function formatDate(date) {

    if (!date) {
        return null;
    }

    return new Date(date)
        .toISOString()
        .slice(0, 10);
}


function getTodayUTC() {

    return new Date()
        .toISOString()
        .slice(0, 10);
}


function getYesterdayUTC() {

    const d = new Date();

    d.setUTCDate(
        d.getUTCDate() - 1
    );

    return d
        .toISOString()
        .slice(0, 10);
}


function isToday(date) {

    if (!date) {
        return false;
    }

    return (
        formatDate(date) ===
        getTodayUTC()
    );
}


/* =========================================================
USER - ME
========================================================= */

app.get(
    "/api/me",
    authenticate,
    async (req, res) => {

        try {

            const telegramId =
                req.telegramUser.id;

            const userResult =
                await pool.query(
                    `
                    SELECT *
                    FROM users
                    WHERE telegram_id = $1
                    `,
                    [telegramId]
                );

            if (
                userResult.rowCount === 0
            ) {

                return res.status(404).json({
                    ok: false,
                    message:
                        "User not found."
                });
            }

            const user =
                userResult.rows[0];

            const tasksResult =
                await pool.query(
                    `
                    SELECT
                        t.*,
                        COALESCE(
                            tc.progress,
                            0
                        ) AS progress_current,

                        COALESCE(
                            tc.completed,
                            FALSE
                        ) AS completed,

                        (
                            tc.task_id IS NOT NULL
                            AND tc.completed = FALSE
                        ) AS started

                    FROM tasks t

                    LEFT JOIN task_completions tc
                    ON
                        tc.task_id = t.id
                    AND
                        tc.telegram_id = $1

                    WHERE t.active = TRUE

                    ORDER BY
                        t.sort_order ASC,
                        t.created_at ASC
                    `,
                    [telegramId]
                );

            const tasks =
                tasksResult.rows.map(task => ({
                    id: task.id,
                    title: task.title,
                    description: task.description,
                    icon: task.icon,
                    type: task.type,
                    reward: Number(task.reward),
                    target: Number(task.target),
                    url: task.url,

                    progress: {
                        current:
                            Number(
                                task.progress_current
                            ),

                        total:
                            Number(
                                task.target
                            )
                    },

                    completed:
                        task.completed,

                    started:
                        Boolean(
                            task.started
                        )
                }));

            const referralsResult =
                await pool.query(
                    `
                    SELECT COUNT(*)::int AS count
                    FROM referrals
                    WHERE referrer_id = $1
                    `,
                    [telegramId]
                );

            const historyResult =
                await pool.query(
                    `
                    SELECT
                        id,
                        amount,
                        method,
                        status,
                        created_at
                    FROM withdrawals
                    WHERE telegram_id = $1
                    ORDER BY created_at DESC
                    LIMIT 30
                    `,
                    [telegramId]
                );

            const sponsorJoined =
                await checkAllSponsors(
                    telegramId
                );

            const minWithdraw =
                Number(
                    await getSetting(
                        "min_withdraw",
                        MIN_WITHDRAW
                    )
                );

            const minReferrals =
                Number(
                    await getSetting(
                        "min_referrals",
                        MIN_REFERRALS
                    )
                );

            const minAge =
                Number(
                    await getSetting(
                        "min_account_age_days",
                        MIN_ACCOUNT_AGE_DAYS
                    )
                );

            const referralReward =
                Number(
                    await getSetting(
                        "referral_reward",
                        REFERRAL_REWARD
                    )
                );

            const ageDays =
                Math.floor(
                    (
                        Date.now() -
                        new Date(
                            user.created_at
                        ).getTime()
                    ) / 86400000
                );

            const requirements = [

                {
                    text:
                        `Minimum balance: ${minWithdraw} ETB`,

                    completed:
                        Number(
                            user.balance
                        ) >= minWithdraw
                },

                {
                    text:
                        `Invite at least ${minReferrals} friends`,

                    completed:
                        Number(
                            referralsResult.rows[0].count
                        ) >= minReferrals
                },

                {
                    text:
                        `Account older than ${minAge} days`,

                    completed:
                        ageDays >= minAge
                },

                {
                    text:
                        "Joined required Telegram channels",

                    completed:
                        sponsorJoined
                }
            ];

            res.json({

                ok: true,

                user: {

                    id:
                        user.telegram_id,

                    username:
                        user.username,

                    firstName:
                        user.first_name,

                    lastName:
                        user.last_name,

                    photoUrl:
                        user.photo_url,

                    botUsername:
                        BOT_USERNAME
                },

                balance:
                    Number(
                        user.balance
                    ),

                streak:
                    Number(
                        user.streak
                    ),

                streakDays: {

                    todayChecked:
                        isToday(
                            user.last_checkin_date
                        )
                },

                todayEarned:
                    await getTodayEarned(
                        telegramId
                    ),

                referrals:
                    Number(
                        referralsResult.rows[0].count
                    ),

                referralCode:
                    user.referral_code,

                referralReward,

                tasks,

                withdrawalRequirements:
                    requirements,

                paymentMethods: [

                    {
                        id: "telebirr",
                        name: "Telebirr"
                    },

                    {
                        id: "cbe",
                        name: "CBE"
                    },

                    {
                        id: "awash",
                        name: "Awash Bank"
                    }
                ],

                withdrawalHistory:
                    historyResult.rows.map(
                        item => ({
                            id: item.id,
                            amount:
                                Number(
                                    item.amount
                                ),
                            method:
                                item.method,
                            status:
                                item.status,
                            createdAt:
                                new Date(
                                    item.created_at
                                ).toLocaleString()
                        })
                    )
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                ok: false,
                message:
                    "Could not load account."
            });
        }
    }
);


/* =========================================================
DAILY CHECK-IN
========================================================= */

app.post(
    "/api/check-in",
    authenticate,
    async (req, res) => {

        const telegramId =
            req.telegramUser.id;

        const client =
            await pool.connect();

        try {

            await client.query("BEGIN");

            const result =
                await client.query(
                    `
                    SELECT *
                    FROM users
                    WHERE telegram_id = $1
                    FOR UPDATE
                    `,
                    [telegramId]
                );

            const user =
                result.rows[0];

            if (
                isToday(
                    user.last_checkin_date
                )
            ) {

                await client.query(
                    "ROLLBACK"
                );

                return res.status(400).json({
                    ok: false,
                    message:
                        "You already checked in today."
                });
            }

            const yesterday =
                getYesterdayUTC();

            const lastDate =
                user.last_checkin_date
                    ? formatDate(
                        user.last_checkin_date
                    )
                    : null;

            const isConsecutive =
                lastDate === yesterday;

            let streak =
                isConsecutive
                    ? Number(user.streak) + 1
                    : 1;

            if (streak > 7) {
                streak = 1;
            }

            const rewardKey =
                `checkin_day_${streak}`;

            const reward =
                Number(
                    await getSetting(
                        rewardKey,
                        0
                    )
                );

            const before =
                Number(
                    user.balance
                );

            const after =
                before + reward;

            await client.query(
                `
                UPDATE users
                SET
                    balance = $2,
                    streak = $3,
                    last_checkin_date = CURRENT_DATE,
                    total_earned =
                        total_earned + $4,
                    updated_at = NOW()
                WHERE telegram_id = $1
                `,
                [
                    telegramId,
                    after,
                    streak,
                    reward
                ]
            );

            await client.query(
                `
                INSERT INTO transactions (
                    telegram_id,
                    type,
                    amount,
                    balance_before,
                    balance_after,
                    reference,
                    description
                )
                VALUES (
                    $1,
                    'checkin',
                    $2,
                    $3,
                    $4,
                    $5,
                    $6
                )
                `,
                [
                    telegramId,
                    reward,
                    before,
                    after,
                    `checkin_${Date.now()}`,
                    `Daily check-in day ${streak}`
                ]
            );

            await client.query(
                "COMMIT"
            );

            res.json({
                ok: true,
                reward,
                streak,
                balance: after,
                message:
                    `You earned ${reward} ETB!`
            });

        } catch (error) {

            await client.query(
                "ROLLBACK"
            );

            console.error(error);

            res.status(500).json({
                ok: false,
                message:
                    "Check-in failed."
            });

        } finally {

            client.release();
        }
    }
);


/* =========================================================
TASK COMPLETE
========================================================= */

app.post(
    "/api/tasks/:id/complete",
    authenticate,
    async (req, res) => {

        const taskId =
            req.params.id;

        const telegramId =
            req.telegramUser.id;

        const client =
            await pool.connect();

        try {

            await client.query("BEGIN");

            const taskResult =
                await client.query(
                    `
                    SELECT *
                    FROM tasks
                    WHERE id = $1
                    AND active = TRUE
                    FOR UPDATE
                    `,
                    [taskId]
                );

            if (
                taskResult.rowCount === 0
            ) {

                await client.query(
                    "ROLLBACK"
                );

                return res.status(404).json({
                    ok: false,
                    message:
                        "Task not found."
                });
            }

            const task =
                taskResult.rows[0];

            const completionResult =
                await client.query(
                    `
                    SELECT *
                    FROM task_completions
                    WHERE task_id = $1
                    AND telegram_id = $2
                    FOR UPDATE
                    `,
                    [
                        taskId,
                        telegramId
                    ]
                );

            if (
                completionResult.rowCount > 0 &&
                completionResult.rows[0].completed
            ) {

                await client.query(
                    "ROLLBACK"
                );

                return res.status(400).json({
                    ok: false,
                    message:
                        "Task already completed."
                });
            }

            if (
                ![
                    "channel",
                    "visit"
                ].includes(task.type)
            ) {

                await client.query(
                    "ROLLBACK"
                );

                return res.status(400).json({
                    ok: false,
                    message:
                        "Unsupported task type."
                });
            }


            /* CHANNEL TASK */

            if (
                task.type === "channel"
            ) {

                if (!task.channel_username) {

                    throw new Error(
                        "Channel task is not configured."
                    );
                }

                const joined =
                    await checkChannelMembership(
                        telegramId,
                        task.channel_username
                    );

                if (!joined) {

                    await client.query(
                        "ROLLBACK"
                    );

                    return res.status(400).json({
                        ok: false,
                        message:
                            "Please join the required channel first."
                    });
                }
            }


            /* VISIT TASK */

            if (
                task.type === "visit"
            ) {

                const startedRow =
                    completionResult.rows[0];

                if (!startedRow) {

                    await client.query(
                        `
                        INSERT INTO task_completions (
                            task_id,
                            telegram_id,
                            progress,
                            completed
                        )
                        VALUES (
                            $1,
                            $2,
                            0,
                            FALSE
                        )
                        ON CONFLICT (
                            task_id,
                            telegram_id
                        )
                        DO NOTHING
                        `,
                        [
                            taskId,
                            telegramId
                        ]
                    );

                    await client.query(
                        "COMMIT"
                    );

                    return res.json({

                        ok: true,

                        completed: false,

                        url:
                            task.url || null,

                        message:
                            `Open the link, then come back after ${VISIT_MIN_SECONDS} seconds and tap Claim.`
                    });
                }

                const elapsed =
                    (
                        Date.now() -
                        new Date(
                            startedRow.created_at
                        ).getTime()
                    ) / 1000;

                if (
                    elapsed <
                    VISIT_MIN_SECONDS
                ) {

                    await client.query(
                        "ROLLBACK"
                    );

                    return res.status(400).json({

                        ok: false,

                        message:
                            `Please wait ${Math.ceil(VISIT_MIN_SECONDS - elapsed)} more seconds.`
                    });
                }
            }


            /* REWARD */

            const reward =
                Number(
                    task.reward
                );

            const userResult =
                await client.query(
                    `
                    SELECT balance
                    FROM users
                    WHERE telegram_id = $1
                    FOR UPDATE
                    `,
                    [telegramId]
                );

            const before =
                Number(
                    userResult.rows[0].balance
                );

            const after =
                before + reward;

            await client.query(
                `
                INSERT INTO task_completions (
                    task_id,
                    telegram_id,
                    progress,
                    completed
                )
                VALUES (
                    $1,
                    $2,
                    1,
                    TRUE
                )
                ON CONFLICT (
                    task_id,
                    telegram_id
                )
                DO UPDATE SET
                    progress = 1,
                    completed = TRUE,
                    updated_at = NOW()
                `,
                [
                    taskId,
                    telegramId
                ]
            );

            await client.query(
                `
                UPDATE users
                SET
                    balance = $2,
                    total_earned =
                        total_earned + $3,
                    updated_at = NOW()
                WHERE telegram_id = $1
                `,
                [
                    telegramId,
                    after,
                    reward
                ]
            );

            await client.query(
                `
                INSERT INTO transactions (
                    telegram_id,
                    type,
                    amount,
                    balance_before,
                    balance_after,
                    reference,
                    description
                )
                VALUES (
                    $1,
                    'task',
                    $2,
                    $3,
                    $4,
                    $5,
                    $6
                )
                `,
                [
                    telegramId,
                    reward,
                    before,
                    after,
                    `task_${task.id}`,
                    task.title
                ]
            );

            await client.query(
                "COMMIT"
            );

            res.json({
                ok: true,
                completed: true,
                reward,
                balance: after,
                message:
                    `You earned ${reward} ETB.`
            });

        } catch (error) {

            await client.query(
                "ROLLBACK"
            );

            console.error(error);

            res.status(500).json({
                ok: false,
                message:
                    error.message ||
                    "Task failed."
            });

        } finally {

            client.release();
        }
    }
);


/* =========================================================
WATCH ADS - LIST
========================================================= */

app.get(
    "/api/ads",
    authenticate,
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        title,
                        description,
                        icon,
                        url,
                        reward,
                        duration_seconds,
                        daily_limit,
                        sort_order
                    FROM ads
                    WHERE active = TRUE
                    ORDER BY
                        sort_order ASC,
                        created_at ASC
                    `
                );

            const ads = [];

            for (
                const ad
                of result.rows
            ) {

                const today =
                    await pool.query(
                        `
                        SELECT COUNT(*)::int AS count
                        FROM ad_completions
                        WHERE ad_id = $1
                        AND telegram_id = $2
                        AND completed = TRUE
                        AND created_at >= CURRENT_DATE
                        `,
                        [
                            ad.id,
                            req.telegramUser.id
                        ]
                    );

                const watched =
                    Number(
                        today.rows[0].count
                    );

                ads.push({

                    id: ad.id,

                    title: ad.title,

                    description:
                        ad.description,

                    icon: ad.icon,

                    url: ad.url,

                    reward:
                        Number(ad.reward),

                    durationSeconds:
                        Number(
                            ad.duration_seconds
                        ),

                    dailyLimit:
                        Number(
                            ad.daily_limit
                        ),

                    watchedToday:
                        watched,

                    available:
                        watched <
                        Number(
                            ad.daily_limit
                        )
                });
            }

            res.json({
                ok: true,
                ads
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                ok: false,
                message:
                    "Could not load ads."
            });
        }
    }
);


/* =========================================================
WATCH ADS - START
========================================================= */

app.post(
    "/api/ads/:id/start",
    authenticate,
    async (req, res) => {

        const adId =
            req.params.id;

        const telegramId =
            req.telegramUser.id;

        const client =
            await pool.connect();

        try {

            await client.query("BEGIN");

            const adResult =
                await client.query(
                    `
                    SELECT *
                    FROM ads
                    WHERE id = $1
                    AND active = TRUE
                    FOR UPDATE
                    `,
                    [adId]
                );

            if (
                adResult.rowCount === 0
            ) {

                throw new Error(
                    "Ad not found."
                );
            }

            const ad =
                adResult.rows[0];

            const countResult =
                await client.query(
                    `
                    SELECT COUNT(*)::int AS count
                    FROM ad_completions
                    WHERE ad_id = $1
                    AND telegram_id = $2
                    AND completed = TRUE
                    AND created_at >= CURRENT_DATE
                    `,
                    [
                        adId,
                        telegramId
                    ]
                );

            const watched =
                Number(
                    countResult.rows[0].count
                );

            if (
                watched >=
                Number(ad.daily_limit)
            ) {

                throw new Error(
                    "Daily limit reached for this ad."
                );
            }

            const existing =
                await client.query(
                    `
                    SELECT *
                    FROM ad_completions
                    WHERE ad_id = $1
                    AND telegram_id = $2
                    AND completed = FALSE
                    ORDER BY created_at DESC
                    LIMIT 1
                    FOR UPDATE
                    `,
                    [
                        adId,
                        telegramId
                    ]
                );

            if (
                existing.rowCount > 0
            ) {

                const row =
                    existing.rows[0];

                await client.query(
                    "COMMIT"
                );

                return res.json({

                    ok: true,

                    started: true,

                    completionId:
                        row.id,

                    url:
                        ad.url,

                    durationSeconds:
                        Number(
                            ad.duration_seconds
                        ),

                    message:
                        "Ad already started. Continue watching."
                });
            }

            const insert =
                await client.query(
                    `
                    INSERT INTO ad_completions (
                        ad_id,
                        telegram_id,
                        reward,
                        completed
                    )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        FALSE
                    )
                    RETURNING id
                    `,
                    [
                        adId,
                        telegramId,
                        ad.reward
                    ]
                );

            await client.query(
                "COMMIT"
            );

            res.json({

                ok: true,

                started: true,

                completionId:
                    insert.rows[0].id,

                url:
                    ad.url,

                durationSeconds:
                    Number(
                        ad.duration_seconds
                    ),

                message:
                    "Ad started."
            });

        } catch (error) {

            await client.query(
                "ROLLBACK"
            );

            res.status(400).json({
                ok: false,
                message:
                    error.message
            });

        } finally {

            client.release();
        }
    }
);


/* =========================================================
WATCH ADS - CLAIM
========================================================= */

app.post(
    "/api/ads/:id/claim",
    authenticate,
    async (req, res) => {

        const adId =
            req.params.id;

        const telegramId =
            req.telegramUser.id;

        const client =
            await pool.connect();

        try {

            await client.query("BEGIN");

            const result =
                await client.query(
                    `
                    SELECT
                        ac.*,
                        a.duration_seconds,
                        a.reward,
                        a.active
                    FROM ad_completions ac
                    JOIN ads a
                    ON a.id = ac.ad_id
                    WHERE ac.ad_id = $1
                    AND ac.telegram_id = $2
                    AND ac.completed = FALSE
                    ORDER BY ac.created_at DESC
                    LIMIT 1
                    FOR UPDATE
                    `,
                    [
                        adId,
                        telegramId
                    ]
                );

            if (
                result.rowCount === 0
            ) {

                throw new Error(
                    "No active ad session found."
                );
            }

            const row =
                result.rows[0];

            if (!row.active) {
                throw new Error(
                    "Ad is no longer active."
                );
            }

            const elapsed =
                (
                    Date.now() -
                    new Date(
                        row.started_at
                    ).getTime()
                ) / 1000;

            const duration =
                Number(
                    row.duration_seconds
                );

            if (
                elapsed < duration
            ) {

                throw new Error(
                    `Please watch for ${Math.ceil(duration - elapsed)} more seconds.`
                );
            }

            const countResult =
                await client.query(
                    `
                    SELECT COUNT(*)::int AS count
                    FROM ad_completions
                    WHERE ad_id = $1
                    AND telegram_id = $2
                    AND completed = TRUE
                    AND created_at >= CURRENT_DATE
                    `,
                    [
                        adId,
                        telegramId
                    ]
                );

            const watched =
                Number(
                    countResult.rows[0].count
                );

            const adLimitResult =
                await client.query(
                    `
                    SELECT daily_limit
                    FROM ads
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [adId]
                );

            const dailyLimit =
                Number(
                    adLimitResult.rows[0]
                        .daily_limit
                );

            if (
                watched >= dailyLimit
            ) {

                throw new Error(
                    "Daily ad limit reached."
                );
            }

            const userResult =
                await client.query(
                    `
                    SELECT balance
                    FROM users
                    WHERE telegram_id = $1
                    FOR UPDATE
                    `,
                    [telegramId]
                );

            const before =
                Number(
                    userResult.rows[0].balance
                );

            const reward =
                Number(row.reward);

            const after =
                before + reward;

            await client.query(
                `
                UPDATE ad_completions
                SET
                    completed = TRUE,
                    completed_at = NOW()
                WHERE id = $1
                `,
                [row.id]
            );

            await client.query(
                `
                UPDATE users
                SET
                    balance = $2,
                    total_earned =
                        total_earned + $3,
                    updated_at = NOW()
                WHERE telegram_id = $1
                `,
                [
                    telegramId,
                    after,
                    reward
                ]
            );

            await client.query(
                `
                INSERT INTO transactions (
                    telegram_id,
                    type,
                    amount,
                    balance_before,
                    balance_after,
                    reference,
                    description
                )
                VALUES (
                    $1,
                    'ad',
                    $2,
                    $3,
                    $4,
                    $5,
                    $6
                )
                `,
                [
                    telegramId,
                    reward,
                    before,
                    after,
                    `ad_${adId}`,
                    "Watch ad reward"
                ]
            );

            await client.query(
                "COMMIT"
            );

            res.json({

                ok: true,

                reward,

                balance:
                    after,

                message:
                    `You earned ${reward} ETB.`
            });

        } catch (error) {

            await client.query(
                "ROLLBACK"
            );

            res.status(400).json({
                ok: false,
                message:
                    error.message
            });

        } finally {

            client.release();
        }
    }
);


/* =========================================================
PROMO CODE - REDEEM
========================================================= */

app.post(
    "/api/promo/redeem",
    authenticate,
    async (req, res) => {

        const telegramId =
            req.telegramUser.id;

        const code =
            String(
                req.body.code || ""
            )
                .trim()
                .toUpperCase();

        if (!code) {

            return res.status(400).json({
                ok: false,
                message:
                    "Promo code is required."
            });
        }

        const client =
            await pool.connect();

        try {

            await client.query("BEGIN");

            const promoResult =
                await client.query(
                    `
                    SELECT *
                    FROM promo_codes
                    WHERE code = $1
                    AND active = TRUE
                    FOR UPDATE
                    `,
                    [code]
                );

            if (
                promoResult.rowCount === 0
            ) {

                throw new Error(
                    "Invalid or inactive promo code."
                );
            }

            const promo =
                promoResult.rows[0];

            if (
                promo.expires_at &&
                new Date(
                    promo.expires_at
                ).getTime() <= Date.now()
            ) {

                throw new Error(
                    "This promo code has expired."
                );
            }

            if (
                promo.usage_limit !== null &&
                Number(
                    promo.used_count
                ) >= Number(
                    promo.usage_limit
                )
            ) {

                throw new Error(
                    "This promo code has reached its usage limit."
                );
            }

            const used =
                await client.query(
                    `
                    SELECT id
                    FROM promo_code_uses
                    WHERE promo_code_id = $1
                    AND telegram_id = $2
                    FOR UPDATE
                    `,
                    [
                        promo.id,
                        telegramId
                    ]
                );

            if (used.rowCount > 0) {

                throw new Error(
                    "You already used this promo code."
                );
            }

            const userResult =
                await client.query(
                    `
                    SELECT balance
                    FROM users
                    WHERE telegram_id = $1
                    FOR UPDATE
                    `,
                    [telegramId]
                );

            const before =
                Number(
                    userResult.rows[0].balance
                );

            const reward =
                Number(
                    promo.reward
                );

            const after =
                before + reward;

            await client.query(
                `
                INSERT INTO promo_code_uses (
                    promo_code_id,
                    telegram_id,
                    reward
                )
                VALUES (
                    $1,
                    $2,
                    $3
                )
                `,
                [
                    promo.id,
                    telegramId,
                    reward
                ]
            );

            await client.query(
                `
                UPDATE promo_codes
                SET
                    used_count =
                        used_count + 1
                WHERE id = $1
                `,
                [promo.id]
            );

            await client.query(
                `
                UPDATE users
                SET
                    balance = $2,
                    total_earned =
                        total_earned + $3,
                    updated_at = NOW()
                WHERE telegram_id = $1
                `,
                [
                    telegramId,
                    after,
                    reward
                ]
            );

            await client.query(
                `
                INSERT INTO transactions (
                    telegram_id,
                    type,
                    amount,
                    balance_before,
                    balance_after,
                    reference,
                    description
                )
                VALUES (
                    $1,
                    'promo',
                    $2,
                    $3,
                    $4,
                    $5,
                    $6
                )
                `,
                [
                    telegramId,
                    reward,
                    before,
                    after,
                    `promo_${promo.id}`,
                    `Promo code ${code}`
                ]
            );

            await client.query(
                "COMMIT"
            );

            res.json({

                ok: true,

                reward,

                balance:
                    after,

                message:
                    `Promo code accepted. You earned ${reward} ETB.`
            });

        } catch (error) {

            await client.query(
                "ROLLBACK"
            );

            res.status(400).json({
                ok: false,
                message:
                    error.message
            });

        } finally {

            client.release();
        }
    }
);


/* =========================================================
SURVEYS - LIST
========================================================= */

app.get(
    "/api/surveys",
    authenticate,
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT
                        s.*,
                        EXISTS (
                            SELECT 1
                            FROM survey_completions sc
                            WHERE sc.survey_id = s.id
                            AND sc.telegram_id = $1
                        ) AS completed
                    FROM surveys s
                    WHERE s.active = TRUE
                    ORDER BY
                        s.sort_order ASC,
                        s.created_at ASC
                    `,
                    [
                        req.telegramUser.id
                    ]
                );

            const surveys = [];

            for (
                const survey
                of result.rows
            ) {

                const questions =
                    await pool.query(
                        `
                        SELECT
                            id,
                            question,
                            question_type,
                            sort_order
                        FROM survey_questions
                        WHERE survey_id = $1
                        ORDER BY sort_order ASC
                        `,
                        [survey.id]
                    );

                const questionList = [];

                for (
                    const question
                    of questions.rows
                ) {

                    const options =
                        await pool.query(
                            `
                            SELECT
                                id,
                                option_text,
                                sort_order
                            FROM survey_options
                            WHERE question_id = $1
                            ORDER BY sort_order ASC
                            `,
                            [question.id]
                        );

                    questionList.push({

                        id:
                            question.id,

                        question:
                            question.question,

                        type:
                            question.question_type,

                        options:
                            options.rows.map(
                                option => ({
                                    id:
                                        option.id,

                                    text:
                                        option.option_text
                                })
                            )
                    });
                }

                surveys.push({

                    id:
                        survey.id,

                    title:
                        survey.title,

                    description:
                        survey.description,

                    reward:
                        Number(
                            survey.reward
                        ),

                    completed:
                        survey.completed,

                    questions:
                        questionList
                });
            }

            res.json({
                ok: true,
                surveys
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                ok: false,
                message:
                    "Could not load surveys."
            });
        }
    }
);


/* =========================================================
SURVEY - SUBMIT
========================================================= */

app.post(
    "/api/surveys/:id/submit",
    authenticate,
    async (req, res) => {

        const surveyId =
            req.params.id;

        const telegramId =
            req.telegramUser.id;

        const answers =
            req.body.answers;

        if (
            !Array.isArray(answers) ||
            answers.length === 0
        ) {

            return res.status(400).json({
                ok: false,
                message:
                    "Survey answers are required."
            });
        }

        const client =
            await pool.connect();

        try {

            await client.query("BEGIN");

            const surveyResult =
                await client.query(
                    `
                    SELECT *
                    FROM surveys
                    WHERE id = $1
                    AND active = TRUE
                    FOR UPDATE
                    `,
                    [surveyId]
                );

            if (
                surveyResult.rowCount === 0
            ) {

                throw new Error(
                    "Survey not found."
                );
            }

            const survey =
                surveyResult.rows[0];

            const existing =
                await client.query(
                    `
                    SELECT id
                    FROM survey_completions
                    WHERE survey_id = $1
                    AND telegram_id = $2
                    FOR UPDATE
                    `,
                    [
                        surveyId,
                        telegramId
                    ]
                );

            if (existing.rowCount > 0) {

                throw new Error(
                    "You already completed this survey."
                );
            }

            const questions =
                await client.query(
                    `
                    SELECT id
                    FROM survey_questions
                    WHERE survey_id = $1
                    `,
                    [surveyId]
                );

            const validQuestions =
                new Set(
                    questions.rows.map(
                        q => String(q.id)
                    )
                );

            const submitted =
                new Set();

            for (
                const answer
                of answers
            ) {

                if (
                    !answer ||
                    !answer.questionId ||
                    !validQuestions.has(
                        String(
                            answer.questionId
                        )
                    )
                ) {
                    continue;
                }

                if (
                    submitted.has(
                        String(
                            answer.questionId
                        )
                    )
                ) {
                    continue;
                }

                const answerText =
                    String(
                        answer.answer ?? ""
                    ).trim();

                if (!answerText) {
                    continue;
                }

                submitted.add(
                    String(
                        answer.questionId
                    )
                );

                await client.query(
                    `
                    INSERT INTO survey_responses (
                        survey_id,
                        question_id,
                        telegram_id,
                        answer
                    )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4
                    )
                    `,
                    [
                        surveyId,
                        answer.questionId,
                        telegramId,
                        answerText
                    ]
                );
            }

            if (
                submitted.size !==
                validQuestions.size
            ) {

                throw new Error(
                    "Please answer all survey questions."
                );
            }

            const userResult =
                await client.query(
                    `
                    SELECT balance
                    FROM users
                    WHERE telegram_id = $1
                    FOR UPDATE
                    `,
                    [telegramId]
                );

            const before =
                Number(
                    userResult.rows[0].balance
                );

            const reward =
                Number(
                    survey.reward
                );

            const after =
                before + reward;

            await client.query(
                `
                INSERT INTO survey_completions (
                    survey_id,
                    telegram_id,
                    reward
                )
                VALUES (
                    $1,
                    $2,
                    $3
                )
                `,
                [
                    surveyId,
                    telegramId,
                    reward
                ]
            );

            await client.query(
                `
                UPDATE users
                SET
                    balance = $2,
                    total_earned =
                        total_earned + $3,
                    updated_at = NOW()
                WHERE telegram_id = $1
                `,
                [
                    telegramId,
                    after,
                    reward
                ]
            );

            await client.query(
                `
                INSERT INTO transactions (
                    telegram_id,
                    type,
                    amount,
                    balance_before,
                    balance_after,
                    reference,
                    description
                )
                VALUES (
                    $1,
                    'survey',
                    $2,
                    $3,
                    $4,
                    $5,
                    $6
                )
                `,
                [
                    telegramId,
                    reward,
                    before,
                    after,
                    `survey_${surveyId}`,
                    survey.title
                ]
            );

            await client.query(
                "COMMIT"
            );

            res.json({

                ok: true,

                reward,

                balance:
                    after,

                message:
                    `Survey completed. You earned ${reward} ETB.`
            });

        } catch (error) {

            await client.query(
                "ROLLBACK"
            );

            res.status(400).json({
                ok: false,
                message:
                    error.message
            });

        } finally {

            client.release();
        }
    }
);


/* =========================================================
WITHDRAWAL
========================================================= */

app.post(
    "/api/withdraw",
    authenticate,
    async (req, res) => {

        const telegramId =
            req.telegramUser.id;

        const amount =
            Number(
                req.body.amount
            );

        const method =
            String(
                req.body.method || ""
            ).toLowerCase();

        const account =
            String(
                req.body.account || ""
            ).trim();

        const allowedMethods = [
            "telebirr",
            "cbe",
            "awash"
        ];

        if (
            !Number.isFinite(amount) ||
            amount <= 0
        ) {

            return res.status(400).json({
                ok: false,
                message:
                    "Invalid withdrawal amount."
            });
        }

        if (
            !allowedMethods.includes(
                method
            )
        ) {

            return res.status(400).json({
                ok: false,
                message:
                    "Invalid payment method."
            });
        }

        if (
            !account ||
            account.length < 5
        ) {

            return res.status(400).json({
                ok: false,
                message:
                    "Invalid account number."
            });
        }

        const client =
            await pool.connect();

        try {

            await client.query("BEGIN");

            const userResult =
                await client.query(
                    `
                    SELECT *
                    FROM users
                    WHERE telegram_id = $1
                    FOR UPDATE
                    `,
                    [telegramId]
                );

            const user =
                userResult.rows[0];

            const referralsResult =
                await client.query(
                    `
                    SELECT COUNT(*)::int AS count
                    FROM referrals
                    WHERE referrer_id = $1
                    `,
                    [telegramId]
                );

            const referralCount =
                Number(
                    referralsResult.rows[0].count
                );

            const sponsorJoined =
                await checkAllSponsors(
                    telegramId
                );

            const accountAge =
                Math.floor(
                    (
                        Date.now() -
                        new Date(
                            user.created_at
                        ).getTime()
                    ) / 86400000
                );

            const minWithdraw =
                Number(
                    await getSetting(
                        "min_withdraw",
                        MIN_WITHDRAW
                    )
                );

            const minReferrals =
                Number(
                    await getSetting(
                        "min_referrals",
                        MIN_REFERRALS
                    )
                );

            const minAge =
                Number(
                    await getSetting(
                        "min_account_age_days",
                        MIN_ACCOUNT_AGE_DAYS
                    )
                );

            if (
                amount < minWithdraw
            ) {

                throw new Error(
                    `Minimum withdrawal is ${minWithdraw} ETB.`
                );
            }

            if (
                amount >
                Number(user.balance)
            ) {

                throw new Error(
                    "Insufficient balance."
                );
            }

            if (
                referralCount <
                minReferrals
            ) {

                throw new Error(
                    `You need at least ${minReferrals} referrals.`
                );
            }

            if (
                accountAge <
                minAge
            ) {

                throw new Error(
                    `Your account must be at least ${minAge} days old.`
                );
            }

            if (!sponsorJoined) {

                throw new Error(
                    "You must join the required Telegram channels."
                );
            }

            const before =
                Number(
                    user.balance
                );

            const after =
                before - amount;

            await client.query(
                `
                UPDATE users
                SET
                    balance = $2,
                    updated_at = NOW()
                WHERE telegram_id = $1
                `,
                [
                    telegramId,
                    after
                ]
            );

            const withdrawalId =
                crypto.randomUUID();

            await client.query(
                `
                INSERT INTO withdrawals (
                    id,
                    telegram_id,
                    amount,
                    method,
                    account_number,
                    status
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    'pending'
                )
                `,
                [
                    withdrawalId,
                    telegramId,
                    amount,
                    method,
                    account
                ]
            );

            await client.query(
                `
                INSERT INTO transactions (
                    telegram_id,
                    type,
                    amount,
                    balance_before,
                    balance_after,
                    reference,
                    description
                )
                VALUES (
                    $1,
                    'withdrawal_hold',
                    $2,
                    $3,
                    $4,
                    $5,
                    $6
                )
                `,
                [
                    telegramId,
                    -amount,
                    before,
                    after,
                    withdrawalId,
                    "Withdrawal request"
                ]
            );

            await client.query(
                "COMMIT"
            );

            res.json({

                ok: true,

                withdrawalId,

                balance:
                    after,

                status:
                    "pending",

                message:
                    "Withdrawal request submitted."
            });

        } catch (error) {

            await client.query(
                "ROLLBACK"
            );

            res.status(400).json({
                ok: false,
                message:
                    error.message
            });

        } finally {

            client.release();
        }
    }
);


/* =========================================================
ADMIN AUTH
========================================================= */

function adminAuth(
    req,
    res,
    next
) {

    const secret =
        req.headers[
            "x-admin-secret"
        ];

    if (
        !secret ||
        !ADMIN_SECRET ||
        secret !== ADMIN_SECRET
    ) {

        return res.status(403).json({
            ok: false,
            message:
                "Admin authorization required."
        });
    }

    next();
}


/* =========================================================
ADMIN - WITHDRAWALS
========================================================= */

app.get(
    "/admin/withdrawals",
    adminAuth,
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT
                        w.*,
                        u.username,
                        u.first_name
                    FROM withdrawals w
                    JOIN users u
                    ON
                        u.telegram_id =
                        w.telegram_id
                    ORDER BY
                        w.created_at DESC
                    LIMIT 100
                    `
                );

            res.json({
                ok: true,
                withdrawals:
                    result.rows
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                ok: false,
                message:
                    "Failed to load withdrawals."
            });
        }
    }
);


/* =========================================================
ADMIN - APPROVE WITHDRAWAL
========================================================= */

app.post(
    "/admin/withdrawals/:id/approve",
    adminAuth,
    async (req, res) => {

        const id =
            req.params.id;

        const note =
            String(
                req.body.note || ""
            );

        const client =
            await pool.connect();

        try {

            await client.query("BEGIN");

            const result =
                await client.query(
                    `
                    SELECT *
                    FROM withdrawals
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [id]
                );

            if (
                result.rowCount === 0
            ) {

                throw new Error(
                    "Withdrawal not found."
                );
            }

            const withdrawal =
                result.rows[0];

            if (
                withdrawal.status !==
                "pending"
            ) {

                throw new Error(
                    "Withdrawal already processed."
                );
            }

            await client.query(
                `
                UPDATE withdrawals
                SET
                    status = 'paid',
                    admin_note = $2,
                    processed_at = NOW()
                WHERE id = $1
                `,
                [
                    id,
                    note
                ]
            );

            await client.query(
                `
                UPDATE users
                SET
                    total_withdrawn =
                        total_withdrawn + $2,
                    updated_at = NOW()
                WHERE telegram_id = $1
                `,
                [
                    withdrawal.telegram_id,
                    withdrawal.amount
                ]
            );

            await client.query(
                "COMMIT"
            );

            res.json({
                ok: true,
                message:
                    "Withdrawal marked as paid."
            });

        } catch (error) {

            await client.query(
                "ROLLBACK"
            );

            res.status(400).json({
                ok: false,
                message:
                    error.message
            });

        } finally {

            client.release();
        }
    }
);


/* =========================================================
ADMIN - REJECT WITHDRAWAL
========================================================= */

app.post(
    "/admin/withdrawals/:id/reject",
    adminAuth,
    async (req, res) => {

        const id =
            req.params.id;

        const note =
            String(
                req.body.note ||
                "Withdrawal rejected."
            );

        const client =
            await pool.connect();

        try {

            await client.query("BEGIN");

            const result =
                await client.query(
                    `
                    SELECT *
                    FROM withdrawals
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [id]
                );

            if (
                result.rowCount === 0
            ) {

                throw new Error(
                    "Withdrawal not found."
                );
            }

            const withdrawal =
                result.rows[0];

            if (
                withdrawal.status !==
                "pending"
            ) {

                throw new Error(
                    "Withdrawal already processed."
                );
            }

            const userResult =
                await client.query(
                    `
                    SELECT balance
                    FROM users
                    WHERE telegram_id = $1
                    FOR UPDATE
                    `,
                    [
                        withdrawal.telegram_id
                    ]
                );

            const before =
                Number(
                    userResult.rows[0].balance
                );

            const after =
                before +
                Number(
                    withdrawal.amount
                );

            await client.query(
                `
                UPDATE users
                SET
                    balance = $2,
                    updated_at = NOW()
                WHERE telegram_id = $1
                `,
                [
                    withdrawal.telegram_id,
                    after
                ]
            );

            await client.query(
                `
                UPDATE withdrawals
                SET
                    status = 'rejected',
                    admin_note = $2,
                    processed_at = NOW()
                WHERE id = $1
                `,
                [
                    id,
                    note
                ]
            );

            await client.query(
                `
                INSERT INTO transactions (
                    telegram_id,
                    type,
                    amount,
                    balance_before,
                    balance_after,
                    reference,
                    description
                )
                VALUES (
                    $1,
                    'withdrawal_refund',
                    $2,
                    $3,
                    $4,
                    $5,
                    $6
                )
                `,
                [
                    withdrawal.telegram_id,
                    withdrawal.amount,
                    before,
                    after,
                    id,
                    "Rejected withdrawal refund"
                ]
            );

            await client.query(
                "COMMIT"
            );

            res.json({
                ok: true,
                message:
                    "Withdrawal rejected and balance refunded."
            });

        } catch (error) {

            await client.query(
                "ROLLBACK"
            );

            res.status(400).json({
                ok: false,
                message:
                    error.message
            });

        } finally {

            client.release();
        }
    }
);


/* =========================================================
ADMIN - TASKS
========================================================= */

app.post(
    "/admin/tasks",
    adminAuth,
    async (req, res) => {

        try {

            const {
                id,
                title,
                description,
                icon,
                type,
                reward,
                target,
                url,
                channel_username,
                sort_order
            } = req.body;

            if (
                !id ||
                !title ||
                !type
            ) {

                return res.status(400).json({
                    ok: false,
                    message:
                        "id, title and type are required."
                });
            }

            const result =
                await pool.query(
                    `
                    INSERT INTO tasks (
                        id,
                        title,
                        description,
                        icon,
                        type,
                        reward,
                        target,
                        url,
                        channel_username,
                        sort_order
                    )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        $6,
                        $7,
                        $8,
                        $9,
                        $10
                    )
                    RETURNING *
                    `,
                    [
                        id,
                        title,
                        description || null,
                        icon || "✦",
                        type,
                        Number(reward || 0),
                        Number(target || 1),
                        url || null,
                        channel_username || null,
                        Number(sort_order || 0)
                    ]
                );

            res.json({
                ok: true,
                task:
                    result.rows[0]
            });

        } catch (error) {

            console.error(error);

            res.status(400).json({
                ok: false,
                message:
                    error.message
            });
        }
    }
);


/* =========================================================
ADMIN - USERS
========================================================= */

app.get(
    "/admin/users",
    adminAuth,
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT
                        telegram_id,
                        username,
                        first_name,
                        balance,
                        total_earned,
                        total_withdrawn,
                        created_at,
                        streak
                    FROM users
                    ORDER BY created_at DESC
                    LIMIT 500
                    `
                );

            res.json({
                ok: true,
                users:
                    result.rows
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                ok: false,
                message:
                    "Failed to load users."
            });
        }
    }
);


/* =========================================================
ADMIN - ADS
========================================================= */

app.get(
    "/admin/ads",
    adminAuth,
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM ads
                    ORDER BY
                        sort_order ASC,
                        created_at DESC
                    `
                );

            res.json({
                ok: true,
                ads:
                    result.rows
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                ok: false,
                message:
                    "Failed to load ads."
            });
        }
    }
);


app.post(
    "/admin/ads",
    adminAuth,
    async (req, res) => {

        try {

            const {
                id,
                title,
                description,
                icon,
                url,
                reward,
                duration_seconds,
                daily_limit,
                sort_order
            } = req.body;

            const adId =
                id ||
                crypto.randomUUID();

            if (
                !title ||
                !url
            ) {

                return res.status(400).json({
                    ok: false,
                    message:
                        "title and url are required."
                });
            }

            const result =
                await pool.query(
                    `
                    INSERT INTO ads (
                        id,
                        title,
                        description,
                        icon,
                        url,
                        reward,
                        duration_seconds,
                        daily_limit,
                        sort_order
                    )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        $6,
                        $7,
                        $8,
                        $9
                    )
                    RETURNING *
                    `,
                    [
                        adId,
                        title,
                        description || null,
                        icon || "🎬",
                        url,
                        Number(reward || 0),
                        Math.max(
                            1,
                            Number(
                                duration_seconds || 15
                            )
                        ),
                        Math.max(
                            1,
                            Number(
                                daily_limit || 1
                            )
                        ),
                        Number(sort_order || 0)
                    ]
                );

            res.json({
                ok: true,
                ad:
                    result.rows[0]
            });

        } catch (error) {

            console.error(error);

            res.status(400).json({
                ok: false,
                message:
                    error.message
            });
        }
    }
);


app.patch(
    "/admin/ads/:id",
    adminAuth,
    async (req, res) => {

        try {

            const id =
                req.params.id;

            const {
                title,
                description,
                icon,
                url,
                reward,
                duration_seconds,
                daily_limit,
                active,
                sort_order
            } = req.body;

            const result =
                await pool.query(
                    `
                    UPDATE ads
                    SET
                        title = COALESCE($2, title),
                        description = COALESCE($3, description),
                        icon = COALESCE($4, icon),
                        url = COALESCE($5, url),
                        reward = COALESCE($6, reward),
                        duration_seconds = COALESCE($7, duration_seconds),
                        daily_limit = COALESCE($8, daily_limit),
                        active = COALESCE($9, active),
                        sort_order = COALESCE($10, sort_order)
                    WHERE id = $1
                    RETURNING *
                    `,
                    [
                        id,
                        title ?? null,
                        description ?? null,
                        icon ?? null,
                        url ?? null,
                        reward !== undefined
                            ? Number(reward)
                            : null,
                        duration_seconds !== undefined
                            ? Number(duration_seconds)
                            : null,
                        daily_limit !== undefined
                            ? Number(daily_limit)
                            : null,
                        active !== undefined
                            ? Boolean(active)
                            : null,
                        sort_order !== undefined
                            ? Number(sort_order)
                            : null
                    ]
                );

            if (
                result.rowCount === 0
            ) {

                return res.status(404).json({
                    ok: false,
                    message:
                        "Ad not found."
                });
            }

            res.json({
                ok: true,
                ad:
                    result.rows[0]
            });

        } catch (error) {

            console.error(error);

            res.status(400).json({
                ok: false,
                message:
                    error.message
            });
        }
    }
);


/* =========================================================
ADMIN - PROMO CODES
========================================================= */

app.get(
    "/admin/promo-codes",
    adminAuth,
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM promo_codes
                    ORDER BY created_at DESC
                    `
                );

            res.json({
                ok: true,
                promoCodes:
                    result.rows
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                ok: false,
                message:
                    "Failed to load promo codes."
            });
        }
    }
);


app.post(
    "/admin/promo-codes",
    adminAuth,
    async (req, res) => {

        try {

            const {
                code,
                reward,
                usage_limit,
                expires_at
            } = req.body;

            const cleanCode =
                String(
                    code || ""
                )
                    .trim()
                    .toUpperCase();

            if (
                !cleanCode ||
                !/^[A-Z0-9_-]{3,50}$/.test(
                    cleanCode
                )
            ) {

                return res.status(400).json({
                    ok: false,
                    message:
                        "Invalid promo code."
                });
            }

            const result =
                await pool.query(
                    `
                    INSERT INTO promo_codes (
                        code,
                        reward,
                        usage_limit,
                        expires_at
                    )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4
                    )
                    RETURNING *
                    `,
                    [
                        cleanCode,
                        Number(reward || 0),
                        usage_limit === null ||
                        usage_limit === undefined ||
                        usage_limit === ""
                            ? null
                            : Number(
                                usage_limit
                            ),
                        expires_at ||
                            null
                    ]
                );

            res.json({
                ok: true,
                promoCode:
                    result.rows[0]
            });

        } catch (error) {

            console.error(error);

            res.status(400).json({
                ok: false,
                message:
                    error.message
            });
        }
    }
);


app.patch(
    "/admin/promo-codes/:id",
    adminAuth,
    async (req, res) => {

        try {

            const id =
                req.params.id;

            const {
                reward,
                usage_limit,
                expires_at,
                active
            } = req.body;

            const result =
                await pool.query(
                    `
                    UPDATE promo_codes
                    SET
                        reward =
                            COALESCE(
                                $2,
                                reward
                            ),

                        usage_limit =
                            COALESCE(
                                $3,
                                usage_limit
                            ),

                        expires_at =
                            COALESCE(
                                $4,
                                expires_at
                            ),

                        active =
                            COALESCE(
                                $5,
                                active
                            )
                    WHERE id = $1
                    RETURNING *
                    `,
                    [
                        id,

                        reward !== undefined
                            ? Number(reward)
                            : null,

                        usage_limit !== undefined
                            ? Number(usage_limit)
                            : null,

                        expires_at !== undefined
                            ? expires_at
                            : null,

                        active !== undefined
                            ? Boolean(active)
                            : null
                    ]
                );

            if (
                result.rowCount === 0
            ) {

                return res.status(404).json({
                    ok: false,
                    message:
                        "Promo code not found."
                });
            }

            res.json({
                ok: true,
                promoCode:
                    result.rows[0]
            });

        } catch (error) {

            console.error(error);

            res.status(400).json({
                ok: false,
                message:
                    error.message
            });
        }
    }
);


/* =========================================================
ADMIN - SURVEYS
========================================================= */

app.get(
    "/admin/surveys",
    adminAuth,
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM surveys
                    ORDER BY
                        sort_order ASC,
                        created_at DESC
                    `
                );

            res.json({
                ok: true,
                surveys:
                    result.rows
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                ok: false,
                message:
                    "Failed to load surveys."
            });
        }
    }
);


/* =========================================================
ADMIN - CREATE SURVEY
========================================================= */

app.post(
    "/admin/surveys",
    adminAuth,
    async (req, res) => {

        const client =
            await pool.connect();

        try {

            const {
                id,
                title,
                description,
                reward,
                sort_order,
                questions
            } = req.body;

            if (
                !title ||
                !Array.isArray(questions) ||
                questions.length === 0
            ) {

                return res.status(400).json({
                    ok: false,
                    message:
                        "title and questions are required."
                });
            }

            const surveyId =
                id ||
                crypto.randomUUID();

            await client.query("BEGIN");

            const surveyResult =
                await client.query(
                    `
                    INSERT INTO surveys (
                        id,
                        title,
                        description,
                        reward,
                        sort_order
                    )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5
                    )
                    RETURNING *
                    `,
                    [
                        surveyId,
                        title,
                        description || null,
                        Number(reward || 0),
                        Number(sort_order || 0)
                    ]
                );

            for (
                let i = 0;
                i < questions.length;
                i++
            ) {

                const q =
                    questions[i];

                if (!q.question) {
                    continue;
                }

                const questionId =
                    q.id ||
                    crypto.randomUUID();

                const questionResult =
                    await client.query(
                        `
                        INSERT INTO survey_questions (
                            id,
                            survey_id,
                            question,
                            question_type,
                            sort_order
                        )
                        VALUES (
                            $1,
                            $2,
                            $3,
                            $4,
                            $5
                        )
                        RETURNING *
                        `,
                        [
                            questionId,
                            surveyId,
                            q.question,
                            q.question_type ||
                                q.type ||
                                "choice",
                            i
                        ]
                    );

                const options =
                    Array.isArray(
                        q.options
                    )
                        ? q.options
                        : [];

                for (
                    let j = 0;
                    j < options.length;
                    j++
                ) {

                    const option =
                        options[j];

                    const text =
                        typeof option === "string"
                            ? option
                            : option.text ||
                              option.option_text ||
                              "";

                    if (!text) {
                        continue;
                    }

                    await client.query(
                        `
                        INSERT INTO survey_options (
                            id,
                            question_id,
                            option_text,
                            sort_order
                        )
                        VALUES (
                            $1,
                            $2,
                            $3,
                            $4
                        )
                        `,
                        [
                            crypto.randomUUID(),
                            questionResult.rows[0].id,
                            text,
                            j
                        ]
                    );
                }
            }

            await client.query(
                "COMMIT"
            );

            res.json({
                ok: true,
                survey:
                    surveyResult.rows[0]
            });

        } catch (error) {

            await client.query(
                "ROLLBACK"
            );

            console.error(error);

            res.status(400).json({
                ok: false,
                message:
                    error.message
            });

        } finally {

            client.release();
        }
    }
);


/* =========================================================
ADMIN - SURVEY ACTIVATE / DEACTIVATE
========================================================= */

app.patch(
    "/admin/surveys/:id",
    adminAuth,
    async (req, res) => {

        try {

            const id =
                req.params.id;

            const {
                active,
                reward,
                title,
                description
            } = req.body;

            const result =
                await pool.query(
                    `
                    UPDATE surveys
                    SET
                        active =
                            COALESCE(
                                $2,
                                active
                            ),

                        reward =
                            COALESCE(
                                $3,
                                reward
                            ),

                        title =
                            COALESCE(
                                $4,
                                title
                            ),

                        description =
                            COALESCE(
                                $5,
                                description
                            )
                    WHERE id = $1
                    RETURNING *
                    `,
                    [
                        id,

                        active !== undefined
                            ? Boolean(active)
                            : null,

                        reward !== undefined
                            ? Number(reward)
                            : null,

                        title ?? null,

                        description ?? null
                    ]
                );

            if (
                result.rowCount === 0
            ) {

                return res.status(404).json({
                    ok: false,
                    message:
                        "Survey not found."
                });
            }

            res.json({
                ok: true,
                survey:
                    result.rows[0]
            });

        } catch (error) {

            console.error(error);

            res.status(400).json({
                ok: false,
                message:
                    error.message
            });
        }
    }
);


/* =========================================================
ADMIN - DASHBOARD STATS
========================================================= */

app.get(
    "/admin/stats",
    adminAuth,
    async (req, res) => {

        try {

            const users =
                await pool.query(
                    `
                    SELECT COUNT(*)::int AS count
                    FROM users
                    `
                );

            const balance =
                await pool.query(
                    `
                    SELECT COALESCE(
                        SUM(balance),
                        0
                    ) AS total
                    FROM users
                    `
                );

            const pending =
                await pool.query(
                    `
                    SELECT
                        COUNT(*)::int AS count,
                        COALESCE(
                            SUM(amount),
                            0
                        ) AS amount
                    FROM withdrawals
                    WHERE status = 'pending'
                    `
                );

            const paid =
                await pool.query(
                    `
                    SELECT COALESCE(
                        SUM(amount),
                        0
                    ) AS amount
                    FROM withdrawals
                    WHERE status = 'paid'
                    `
                );

            const tasks =
                await pool.query(
                    `
                    SELECT COUNT(*)::int AS count
                    FROM tasks
                    WHERE active = TRUE
                    `
                );

            const ads =
                await pool.query(
                    `
                    SELECT COUNT(*)::int AS count
                    FROM ads
                    WHERE active = TRUE
                    `
                );

            const surveys =
                await pool.query(
                    `
                    SELECT COUNT(*)::int AS count
                    FROM surveys
                    WHERE active = TRUE
                    `
                );

            res.json({

                ok: true,

                stats: {

                    users:
                        Number(
                            users.rows[0].count
                        ),

                    totalBalance:
                        Number(
                            balance.rows[0].total
                        ),

                    pendingWithdrawals:
                        Number(
                            pending.rows[0].count
                        ),

                    pendingWithdrawalAmount:
                        Number(
                            pending.rows[0].amount
                        ),

                    paidWithdrawalAmount:
                        Number(
                            paid.rows[0].amount
                        ),

                    activeTasks:
                        Number(
                            tasks.rows[0].count
                        ),

                    activeAds:
                        Number(
                            ads.rows[0].count
                        ),

                    activeSurveys:
                        Number(
                            surveys.rows[0].count
                        )
                }
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                ok: false,
                message:
                    "Failed to load dashboard statistics."
            });
        }
    }
);


/* =========================================================
ERROR HANDLER
========================================================= */

app.use(
    (
        error,
        req,
        res,
        next
    ) => {

        console.error(
            "SERVER ERROR:",
            error
        );

        res.status(500).json({
            ok: false,
            message:
                "Internal server error."
        });
    }
);


/* =========================================================
START SERVER
========================================================= */

if (
    require.main === module
) {

    app.listen(
        PORT,
        () => {

            console.log(
                `FulusApp backend running on port ${PORT}`
            );
        }
    );
}


/* =========================================================
VERCEL EXPORT
========================================================= */

module.exports = app;
