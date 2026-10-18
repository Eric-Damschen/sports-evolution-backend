// netlify/functions/waitlist.js
//
// Self-contained on purpose: no shared module to misplace.
// POST /api/waitlist — called by the booking forms when a camp is sold out.
//
// Writes one row per family to the "Waitlist" tab of the bookings sheet:
//   A Location | B First name | C Surname | D Number of children |
//   E Email | F Language | G Camp | H Signed up | I Status | J Offered at | K Camp page
// A–D are the columns you created; the code adds the headers E–K when they're
// missing. Status starts as "Waiting"; waitlist-offers.js changes it.
//
// The same email on the same camp updates the existing row instead of adding
// a second one. Only parent details are collected — no children's data.
// The team gets a short alert at ADMIN_NOTIFY_EMAIL (info@ by default).

const { google } = require("googleapis")

const TAB = "Waitlist"
const HEADER = ["Location", "First name", "Surname", "Number of children", "Email", "Language", "Camp", "Signed up", "Status", "Offered at", "Camp page"]
const W = { location: 0, first: 1, surname: 2, children: 3, email: 4, lang: 5, camp: 6, signedUp: 7, status: 8, offeredAt: 9, page: 10 }
const LAST = "K"
const MAX_ROWS = 2000 // safety cap against junk
const MAX_CHILDREN = 6
const LANGS = ["en", "fr", "de", "pt"]

const ALLOWED_ORIGINS = String(
    process.env.ALLOWED_ORIGINS || "https://www.sportsevolution.lu,https://sportsevolution.lu"
)
    .split(",")
    .map((s) => s.trim().replace(/\/$/, "").toLowerCase())
    .filter(Boolean)
const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || "info@sportsevolution.lu"

function headers(origin) {
    return {
        "Access-Control-Allow-Origin": origin || ALLOWED_ORIGINS[0] || "",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        Vary: "Origin",
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
    }
}

function json(statusCode, body, origin) {
    return { statusCode, headers: headers(origin), body: JSON.stringify(body) }
}

function oneLine(v, max) {
    return String(v === undefined || v === null ? "" : v)
        .replace(/[\u0000-\u001F\u007F]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
}

function esc(v) {
    return String(v === undefined || v === null ? "" : v)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function getSheets() {
    const auth = new google.auth.JWT(
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        null,
        (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
        ["https://www.googleapis.com/auth/spreadsheets"]
    )
    return google.sheets({ version: "v4", auth })
}

async function sendTeamAlert(row) {
    const to = ADMIN_NOTIFY_EMAIL.split(",").map((s) => s.trim()).filter(Boolean)
    if (!to.length || !process.env.RESEND_API_KEY) return
    const html =
        `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111;line-height:1.5">` +
        `<p><strong>New waiting list sign-up</strong></p>` +
        `<p>${esc(row[W.camp])}<br>${esc(row[W.first])} ${esc(row[W.surname])} · ${esc(row[W.email])}<br>` +
        `${esc(row[W.children])} ${Number(row[W.children]) === 1 ? "child" : "children"}</p>` +
        `<p style="color:#666">When a place opens up, the family gets an email automatically. See the "${TAB}" tab.</p></div>`
    const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            from: process.env.RESEND_FROM || "Sports Evolution <info@order.sportsevolution.lu>",
            to,
            subject: `Waiting list: ${row[W.camp]} · ${row[W.children]} ${Number(row[W.children]) === 1 ? "child" : "children"}`,
            html,
            reply_to: row[W.email],
        }),
    })
    if (!res.ok) throw new Error(`Resend rejected the alert — status ${res.status}: ${await res.text()}`)
}

exports.handler = async (event) => {
    const origin = String((event.headers && (event.headers.origin || event.headers.Origin)) || "")
        .replace(/\/$/, "")
        .toLowerCase()
    const allowed = ALLOWED_ORIGINS.includes(origin)

    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 204, headers: headers(allowed ? origin : ""), body: "" }
    }
    if (event.httpMethod !== "POST") return json(405, { error: "method" })
    if (!allowed) return json(403, { error: "not_allowed" })
    if (String(event.body || "").length > 5000) return json(413, { error: "too_large" }, origin)

    let body
    try {
        body = JSON.parse(event.body || "{}")
    } catch (e) {
        return json(400, { error: "invalid" }, origin)
    }

    const camp = oneLine(body.camp, 150)
    const location = oneLine(body.location, 120)
    const first = oneLine(body.firstName, 80)
    const surname = oneLine(body.surname, 80)
    const email = oneLine(body.email, 160).toLowerCase()
    const children = Number(body.children)
    const lang = LANGS.includes(String(body.lang || "").toLowerCase()) ? String(body.lang).toLowerCase() : "en"
    let page = oneLine(body.pageUrl, 300)
    try {
        const u = new URL(page)
        const okHost = ALLOWED_ORIGINS.some((o) => {
            try { return new URL(o).host === u.host } catch (e) { return false }
        })
        if (u.protocol !== "https:" || !okHost) page = ""
        else page = u.origin + u.pathname
    } catch (e) {
        page = ""
    }

    if (
        !camp || !first || !surname || !page ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ||
        !Number.isInteger(children) || children < 1 || children > MAX_CHILDREN ||
        body.consent !== true
    ) {
        return json(400, { error: "invalid" }, origin)
    }

    try {
        const sheets = getSheets()
        const spreadsheetId = process.env.GOOGLE_SHEET_ID
        let res
        try {
            res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${TAB}'!A:${LAST}` })
        } catch (err) {
            if (/Unable to parse range/i.test(String(err && err.message))) {
                console.error(`[waitlist] the "${TAB}" tab is missing — create it`)
                return json(503, { error: "not_configured" }, origin)
            }
            throw err
        }
        const rows = res.data.values || []

        // Headers E–K when missing (A–D are yours and stay as they are).
        const head = rows[0] || []
        const fix = []
        HEADER.forEach((h, i) => {
            if (!String(head[i] || "").trim()) fix.push({ range: `'${TAB}'!${String.fromCharCode(65 + i)}1`, values: [[h]] })
        })
        if (fix.length) {
            await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: "RAW", data: fix } })
        }

        const now = new Date().toISOString()
        const idx = rows.findIndex((r, i) => i > 0 &&
            String(r[W.camp] || "").trim() === camp &&
            String(r[W.email] || "").trim().toLowerCase() === email &&
            ["Waiting", "Offered"].includes(String(r[W.status] || "").trim()))

        if (idx > 0) {
            // Already on the list: update the details, keep the place in line.
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `'${TAB}'!A${idx + 1}:D${idx + 1}`,
                valueInputOption: "RAW",
                requestBody: { values: [[location, first, surname, children]] },
            })
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `'${TAB}'!F${idx + 1}`,
                valueInputOption: "RAW",
                requestBody: { values: [[lang]] },
            })
            return json(200, { ok: true, result: "updated" }, origin)
        }

        if (rows.length - 1 >= MAX_ROWS) {
            console.error(`[waitlist] "${TAB}" already has ${MAX_ROWS} rows — not adding`)
            return json(503, { error: "full" }, origin)
        }

        const row = new Array(HEADER.length).fill("")
        row[W.location] = location
        row[W.first] = first
        row[W.surname] = surname
        row[W.children] = children
        row[W.email] = email
        row[W.lang] = lang
        row[W.camp] = camp
        row[W.signedUp] = now
        row[W.status] = "Waiting"
        row[W.page] = page
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `'${TAB}'!A:${LAST}`,
            valueInputOption: "RAW",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values: [row] },
        })
        console.log(`[waitlist] added ${email} to "${camp}" (${children})`)
        try {
            await sendTeamAlert(row)
        } catch (err) {
            console.error("[waitlist] team alert failed:", err.message)
        }
        return json(200, { ok: true, result: "added" }, origin)
    } catch (err) {
        console.error("[waitlist] failed:", err)
        return json(500, { error: "server" }, origin)
    }
}
