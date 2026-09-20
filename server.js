
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");


/* =========================================================
   CONFIG
   ========================================================= */

const app = express();

const PORT =
    Number(process.env.PORT || 3000);

const BOT_TOKEN =
    process.env.BOT_TOKEN;

const BOT_USERNAME =
    process.env.BOT_USERNAME;

const ADMIN_SECRET =
    process.env.ADMIN_SECRET;

const DATABASE_URL =
    process.env.DATABASE_URL;

const MIN_WITHDRAW =
    Number(process.env.MIN_WITHDRAW || 100);

const MIN_REFERRALS =
    Number(process.env.MIN_REFERRALS || 5);

const MIN_ACCOUNT_AGE_DAYS =
    Number(
        process.env.MIN_ACCOUNT_AGE_DAYS || 5
    );

const REFERRAL_REWARD =
    Number(
        process.env.REFERRAL_REWARD || 5
    );

/* Seconds a user must wait before claiming a "visit" task */
const VISIT_MIN_SECONDS =
    Number(
        process.env.VISIT_MIN_SECONDS || 15
    );


const SPONSOR_CHANNELS =
    String(
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

        origin: function (
            origin,
            callback
        ) {

            /*
                Allow requests without Origin
                such as server-to-server tools.
            */

            if (!origin) {

                return callback(null, true);

            }


            const allowed = [

                process.env.FRONTEND_URL,

                "https://telegram.org",

                "https://web.telegram.org"

            ].filter(Boolean);


            if (
                allowed.includes(origin)
            ) {

                return callback(
                    null,
                    true
                );

            }


            /*
                GitHub Pages project URL.
            */

            if (
                origin.startsWith(
                    "https://abdulselamahemade608-prog.github.io"
                )
            ) {

                return callback(
                    null,
                    true
                );

            }


            return callback(
                new Error(
                    "CORS blocked."
                )
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

app.get(
    "/",
    (req, res) => {

        res.json({

            ok: true,

            service:
                "FulusApp Backend",

            version:
                "1.0.0",

            status:
                "online"

        });

    }
);


app.get(
    "/health",
    async (req, res) => {

        try {

            await pool.query(
                "SELECT 1"
            );

            res.json({

                ok: true,

                database:
                    "connected"

            });

        } catch (error) {

            console.error(error);

            res.status(500).json({

                ok: false,

                database:
                    "error"

            });

        }

    }
);


/* =========================================================
   TELEGRAM INIT DATA VALIDATION
   ========================================================= */

function validateTelegramInitData(
    initData
) {

    if (
        !initData ||
        !BOT_TOKEN
    ) {

        throw new Error(
            "Missing Telegram authentication."
        );

    }


    const params =
        new URLSearchParams(
            initData
        );


    const receivedHash =
        params.get("hash");


    if (!receivedHash) {

        throw new Error(
            "Telegram hash missing."
        );

    }


    params.delete("hash");


    const dataCheckString =
        [...params.entries()]
            .sort(
                ([a], [b]) =>
                    a.localeCompare(b)
            )
            .map(
                ([key, value]) =>
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


    /*
        Reject stale Mini App sessions.
        24 hours.
    */

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

        user =
            JSON.parse(userRaw);

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
            params.get("start_param") ||
            null

    };

}


/* =========================================================
   AUTH MIDDLEWARE
   ========================================================= */

async function authenticate(
    req,
    res,
    next
) {

    try {

        const initData =
            req.headers[
                "x-telegram-init-data"
            ];


        const auth =
            validateTelegramInitData(
                initData
            );


        const user =
            auth.user;


        await upsertUser(user, auth.startParam);


        req.telegramUser =
            user;


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

async function upsertUser(telegramUser, startParam = null) {

    const client =
        await pool.connect();


    try {

        await client.query(
            "BEGIN"
        );


        const existing =
            await client.query(
                `
                SELECT telegram_id
                FROM users
                WHERE telegram_id = $1
                FOR UPDATE
                `,
                [
                    telegramUser.id
                ]
            );


        if (
            existing.rowCount === 0
        ) {

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

                    telegramUser.username ||
                        null,

                    telegramUser.first_name ||
                        null,

                    telegramUser.last_name ||
                        null,

                    telegramUser.photo_url ||
                        null,

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

                    telegramUser.username ||
                        null,

                    telegramUser.first_name ||
                        null,

                    telegramUser.last_name ||
                        null,

                    telegramUser.photo_url ||
                        null

                ]
            );

        }


        await client.query(
            "COMMIT"
        );


    } catch (error) {

        await client.query(
            "ROLLBACK"
        );

        throw error;

    } finally {

        client.release();

    }

}


/* =========================================================
   REFERRAL CODE
   ========================================================= */

/* =========================================================
   REGISTER REFERRAL (called only for brand-new users)
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

    /* A user cannot refer themselves */
    if (String(referrerId) === String(newUserId)) {
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
            ON CONFLICT (referred_id) DO NOTHING
            RETURNING id
            `,
            [referrerId, newUserId]
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
        [newUserId, referrerId]
    );

    const before =
        Number(referrerResult.rows[0].balance);

    const after =
        before + REFERRAL_REWARD;

    await client.query(
        `
        UPDATE users
        SET
            balance = $2,
            total_earned = total_earned + $3,
            updated_at = NOW()
        WHERE telegram_id = $1
        `,
        [referrerId, after, REFERRAL_REWARD]
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
        VALUES ($1, 'referral', $2, $3, $4, $5, $6)
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


    if (
        result.rowCount === 0
    ) {

        return fallback;

    }


    return result.rows[0].value;

}


/* =========================================================
   TELEGRAM BOT API
   ========================================================= */

async function telegramApi(
    method,
    body
) {

    const response =
        await fetch(
            `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
            {

                method:
                    "POST",

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
   CHECK CHANNEL MEMBERSHIP
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

                    chat_id:
                        channel,

                    user_id:
                        telegramId

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


/* =========================================================
   CHECK ALL SPONSORS
   ========================================================= */

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
   USER API
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

                    ORDER BY t.sort_order ASC,
                             t.created_at ASC
                    `,
                    [telegramId]
                );


            const tasks =
                tasksResult.rows.map(
                    task => ({

                        id:
                            task.id,

                        title:
                            task.title,

                        description:
                            task.description,

                        icon:
                            task.icon,

                        type:
                            task.type,

                        reward:
                            Number(
                                task.reward
                            ),

                        target:
                            task.target,

                        url:
                            task.url,

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
                            Boolean(task.started)

                    })
                );


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


            const minWithdraw = MIN_WITHDRAW;


            const minReferrals = MIN_REFERRALS;


            const ageDays =
                Math.floor(
                    (
                        Date.now() -
                        new Date(
                            user.created_at
                        ).getTime()
                    ) /
                    86400000
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
                        `Account older than ${MIN_ACCOUNT_AGE_DAYS} days`,

                    completed:
                        ageDays >=
                        MIN_ACCOUNT_AGE_DAYS

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
                    user.streak,

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

                referralReward:
                    REFERRAL_REWARD,

                tasks,

                withdrawalRequirements:
                    requirements,

                paymentMethods: [

                    {
                        id:
                            "telebirr",

                        name:
                            "Telebirr"
                    },

                    {
                        id:
                            "cbe",

                        name:
                            "CBE"
                    },

                    {
                        id:
                            "awash",

                        name:
                            "Awash Bank"
                    }

                ],

                withdrawalHistory:
                    historyResult.rows.map(
                        item => ({

                            id:
                                item.id,

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

            await client.query(
                "BEGIN"
            );


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

                balance:
                    after,

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
   COMPLETE TASK
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

            await client.query(
                "BEGIN"
            );


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


            /*
                ONLY VERIFIABLE TASK TYPES
            */

            if (
                !["channel", "visit"].includes(
                    task.type
                )
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


            /*
                CHANNEL TASK
            */

            if (
                task.type ===
                "channel"
            ) {

                if (
                    !task.channel_username
                ) {

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


            /*
                VISIT TASK

                A visit task does NOT automatically
                grant money merely because the user
                clicked the button.

                It can open the URL, but a secure
                reward should be confirmed by a
                provider/callback.
            */

            if (
                task.type ===
                "visit"
            ) {

                const startedRow =
                    completionResult.rows[0];

                /* First tap: record the start time and open the link */

                if (!startedRow) {

                    await client.query(
                        `
                        INSERT INTO task_completions (
                            task_id,
                            telegram_id,
                            progress,
                            completed
                        )
                        VALUES ($1, $2, 0, FALSE)
                        ON CONFLICT (task_id, telegram_id)
                        DO NOTHING
                        `,
                        [taskId, telegramId]
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


                /* Second tap: must wait long enough */

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

                /* Enough time passed: fall through to the reward */

            }


            /*
                MANUAL / CHANNEL TASK
            */

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

                completed:
                    true,

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

            await client.query(
                "BEGIN"
            );


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
                    ) /
                    86400000
                );


            if (amount < MIN_WITHDRAW) {

                throw new Error(
                    `Minimum withdrawal is ${MIN_WITHDRAW} ETB.`
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
                MIN_REFERRALS
            ) {

                throw new Error(
                    `You need at least ${MIN_REFERRALS} referrals.`
                );

            }


            if (
                accountAge <
                MIN_ACCOUNT_AGE_DAYS
            ) {

                throw new Error(
                    `Your account must be at least ${MIN_ACCOUNT_AGE_DAYS} days old.`
                );

            }


            if (!sponsorJoined) {

                throw new Error(
                    "You must join the required Telegram channels."
                );

            }


            /*
                Reserve the withdrawal amount
                immediately.

                This prevents the same balance
                from being withdrawn twice.
            */

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

            await client.query(
                "BEGIN"
            );


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

            await client.query(
                "BEGIN"
            );


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


            /*
                Return reserved money.
            */

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
   ADMIN - CREATE TASK
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

                        description ||
                            null,

                        icon ||
                            "✦",

                        type,

                        Number(
                            reward || 0
                        ),

                        Number(
                            target || 1
                        ),

                        url ||
                            null,

                        channel_username ||
                            null,

                        Number(
                            sort_order || 0
                        )

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
   ADMIN - LIST USERS
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

function formatDate(
    date
) {

    if (!date) {

        return null;

    }


    const d =
        new Date(date);


    return d.toISOString()
        .slice(0, 10);

}


function getTodayUTC() {

    return new Date()
        .toISOString()
        .slice(0, 10);

}


function getYesterdayUTC() {

    const d =
        new Date();


    d.setUTCDate(
        d.getUTCDate() - 1
    );


    return d.toISOString()
        .slice(0, 10);

}


function isToday(
    date
) {

    if (!date) {

        return false;

    }


    return (
        formatDate(date) ===
        getTodayUTC()
    );

}


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

app.listen(
    PORT,
    () => {

        console.log(
            `FulusApp backend running on port ${PORT}`
        );

    }
);


/* Needed so Vercel can find the Express app */
module.exports = app;
