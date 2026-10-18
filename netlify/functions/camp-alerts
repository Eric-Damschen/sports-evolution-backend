// netlify/functions/camp-alerts.js
//
// "New camp at this location" alerts: sign-up and unsubscribe.
//
//   POST /api/camp-alerts            sign-up (booking forms, camp pages)
//   GET  /api/camp-alerts?u=<code>   unsubscribe link in every alert email
//   POST /api/camp-alerts?u=<code>   one-click unsubscribe (email apps)
//
// The feedback page signs families up through feedback.js, which uses the
// subscribe() function below.
//
// "Camp alerts" tab of the bookings sheet (created by the code if missing):
//   A Email | B First name | C Surname | D Location | E Sport | F Language |
//   G Source | H Signed up | I Status | J Camps notified
// One row per email + location + sport. Status "Active" or "Unsubscribed".
// J lists the camps this family has been told about. At sign-up it already
// holds the camps that are online at that moment, so only camps that open
// later trigger an email (camp-alerts-send.js).
//
// The unsubscribe code is signed with FEEDBACK_SECRET (already set for the
// feedback links), so nobody can unsubscribe someone else.

const { google } = require("googleapis")
const crypto = require("crypto")

const TAB = "Camp alerts"
const HEADER = ["Email", "First name", "Surname", "Location", "Sport", "Language", "Source", "Signed up", "Status", "Camps notified"]
const A = { email: 0, first: 1, surname: 2, location: 3, sport: 4, lang: 5, source: 6, signedUp: 7, status: 8, notified: 9 }
const CAMPS_TAB = process.env.CAMPS_TAB || "Overview"
const SPORTS = ["football", "basketball", "volleyball"]
const LANGS = ["en", "fr", "de", "pt"]
const SOURCES = ["Booking", "Feedback", "Website"]
const MAX_ROWS = 5000

const ALLOWED_ORIGINS = String(
    process.env.ALLOWED_ORIGINS || "https://www.sportsevolution.lu,https://sportsevolution.lu"
)
    .split(",")
    .map((s) => s.trim().replace(/\/$/, "").toLowerCase())
    .filter(Boolean)

/* ---------------- Helpers ---------------- */

const norm = (v) => String(v === undefined || v === null ? "" : v).trim()
const lower = (v) => norm(v).toLowerCase()

function oneLine(v, max) {
    return norm(v).replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").slice(0, max)
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

// "Mamer (football) · December 2026" → { location: "mamer", sport: "football" }
function campParts(key) {
    const m = /^(.*?)\s*\(([^)]+)\)/.exec(norm(key))
    return m ? { location: lower(m[1]), sport: lower(m[2]) } : { location: "", sport: "" }
}

function signature(email) {
    return crypto
        .createHmac("sha256", String(process.env.FEEDBACK_SECRET || ""))
        .update(`alerts:${lower(email)}`)
        .digest("base64url")
        .slice(0, 32)
}

function unsubscribeCode(email) {
    return `${Buffer.from(lower(email)).toString("base64url")}.${signature(email)}`
}

// Returns the email, or "" when the code isn't valid.
function emailFromCode(code) {
    const s = norm(code)
    const dot = s.lastIndexOf(".")
    if (dot < 1 || s.length > 400) return ""
    let email = ""
    try {
        email = Buffer.from(s.slice(0, dot), "base64url").toString("utf8")
    } catch (e) {
        return ""
    }
    const given = Buffer.from(s.slice(dot + 1))
    const expected = Buffer.from(signature(email))
    if (!email || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return ""
    return email
}

function unsubscribeUrl(email) {
    const base = String(process.env.URL || "https://sports-evolution-backend.netlify.app").replace(/\/$/, "")
    return `${base}/api/camp-alerts?u=${encodeURIComponent(unsubscribeCode(email))}`
}

/* ---------------- Sheet ---------------- */

async function ensureTab(sheets) {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(title)" })
    const exists = (meta.data.sheets || []).some((s) => s.properties.title === TAB)
    if (!exists) {
        try {
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: { requests: [{ addSheet: { properties: { title: TAB, gridProperties: { frozenRowCount: 1 } } } }] },
            })
        } catch (err) {
            if (!/already exists/i.test(String(err.message))) throw err
        }
    }
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${TAB}'!A1:J1` })
    const head = (res.data.values || [])[0] || []
    if (HEADER.some((h, i) => norm(head[i]) !== h)) {
        await sheets.spreadsheets.values.update({
            spreadsheetId, range: `'${TAB}'!A1:J1`, valueInputOption: "RAW", requestBody: { values: [HEADER] },
        })
    }
}

async function readRows(sheets) {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: `'${TAB}'!A:J` })
    return res.data.values || []
}

// Camp keys that are online now for this location + sport ("" sport = any).
async function currentCamps(sheets, location, sport) {
    try {
        const res = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: `'${CAMPS_TAB}'!A:A` })
        return (res.data.values || []).slice(1).map((r) => norm(r[0])).filter((k) => {
            const p = campParts(k)
            return k && p.location === lower(location) && (!sport || p.sport === lower(sport))
        })
    } catch (err) {
        return []
    }
}

// Adds or re-activates an alert. info: { email, firstName, surname,
// location, sport, lang, source }. Returns "added" | "updated" | "invalid".
async function subscribe(sheets, info) {
    const email = lower(info.email).slice(0, 160)
    const location = oneLine(info.location, 120)
    const sport = SPORTS.includes(lower(info.sport)) ? lower(info.sport) : ""
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || !location) return "invalid"
    const row = new Array(HEADER.length).fill("")
    row[A.email] = email
    row[A.first] = oneLine(info.firstName, 80)
    row[A.surname] = oneLine(info.surname, 80)
    row[A.location] = location
    row[A.sport] = sport
    row[A.lang] = LANGS.includes(lower(info.lang)) ? lower(info.lang) : "en"
    row[A.source] = SOURCES.includes(info.source) ? info.source : "Website"
    row[A.signedUp] = new Date().toISOString()
    row[A.status] = "Active"

    await ensureTab(sheets)
    const rows = await readRows(sheets)
    const known = await currentCamps(sheets, location, sport)
    const spreadsheetId = process.env.GOOGLE_SHEET_ID
    const idx = rows.findIndex((r, i) => i > 0 && lower(r[A.email]) === email &&
        lower(r[A.location]) === lower(location) && lower(r[A.sport]) === sport)

    if (idx > 0) {
        const old = rows[idx]
        const notified = new Set(norm(old[A.notified]).split("\n").map(norm).filter(Boolean))
        known.forEach((k) => notified.add(k))
        row[A.first] = row[A.first] || norm(old[A.first])
        row[A.surname] = row[A.surname] || norm(old[A.surname])
        row[A.source] = norm(old[A.source]) || row[A.source]
        row[A.signedUp] = norm(old[A.signedUp]) || row[A.signedUp]
        row[A.location] = norm(old[A.location]) || row[A.location]
        row[A.notified] = [...notified].join("\n")
        await sheets.spreadsheets.values.update({
            spreadsheetId, range: `'${TAB}'!A${idx + 1}:J${idx + 1}`, valueInputOption: "RAW", requestBody: { values: [row] },
        })
        return "updated"
    }
    if (rows.length - 1 >= MAX_ROWS) {
        console.error(`[camp-alerts] "${TAB}" already has ${MAX_ROWS} rows — not adding`)
        return "invalid"
    }
    row[A.notified] = known.join("\n")
    await sheets.spreadsheets.values.append({
        spreadsheetId, range: `'${TAB}'!A:J`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: { values: [row] },
    })
    return "added"
}

async function unsubscribe(sheets, email) {
    const rows = await readRows(sheets)
    const data = []
    rows.forEach((r, i) => {
        if (i > 0 && lower(r[A.email]) === lower(email) && norm(r[A.status]) !== "Unsubscribed") {
            data.push({ range: `'${TAB}'!I${i + 1}`, values: [["Unsubscribed"]] })
        }
    })
    if (data.length) {
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: process.env.GOOGLE_SHEET_ID, requestBody: { valueInputOption: "RAW", data },
        })
    }
    return data.length
}

/* ---------------- Responses ---------------- */

function headers(origin) {
    return {
        "Access-Control-Allow-Origin": origin || ALLOWED_ORIGINS[0] || "",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        Vary: "Origin",
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
    }
}

function json(statusCode, body, origin) {
    return { statusCode, headers: headers(origin), body: JSON.stringify(body) }
}

const DONE = {
    en: ["You're unsubscribed", "You won't receive any more emails about new camps. You can sign up again on our website at any time."],
    fr: ["Vous êtes désinscrit", "Vous ne recevrez plus d'e-mails sur les nouveaux stages. Vous pouvez vous réinscrire à tout moment sur notre site."],
    de: ["Sie sind abgemeldet", "Sie erhalten keine E-Mails mehr zu neuen Camps. Sie können sich jederzeit auf unserer Website wieder anmelden."],
    pt: ["Subscrição cancelada", "Não vai receber mais e-mails sobre novos campos. Pode voltar a inscrever-se no nosso site a qualquer momento."],
}

function page(status, lang, ok) {
    const [title, text] = ok ? DONE[lang] || DONE.en : ["Link not valid", "This unsubscribe link doesn't work. Please write to info@sportsevolution.lu and we'll remove you."]
    return {
        statusCode: status,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>` +
            `<body style="margin:0;background:#FBFAF8;font-family:Arial,Helvetica,sans-serif;color:#12110F;">` +
            `<div style="max-width:480px;margin:0 auto;padding:72px 20px;text-align:center;">` +
            `<h1 style="font-size:26px;margin:0 0 12px;">${title}</h1><p style="color:#5E5B57;line-height:1.5;margin:0 0 24px;">${text}</p>` +
            `<a href="https://www.sportsevolution.lu" style="display:inline-block;background:#F9B233;color:#12110F;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:999px;">sportsevolution.lu</a>` +
            `</div></body></html>`,
    }
}

/* ---------------- Handler ---------------- */

exports.handler = async (event) => {
    const q = event.queryStringParameters || {}
    const origin = lower((event.headers && (event.headers.origin || event.headers.Origin)) || "").replace(/\/$/, "")
    const allowed = ALLOWED_ORIGINS.includes(origin)

    if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: headers(allowed ? origin : ""), body: "" }

    // Unsubscribe (link or one-click). No origin check: comes from email apps.
    if (q.u !== undefined && (event.httpMethod === "GET" || event.httpMethod === "POST")) {
        if (String(process.env.FEEDBACK_SECRET || "").length < 24) return page(503, "en", false)
        const email = emailFromCode(q.u)
        if (!email) return page(400, "en", false)
        try {
            const sheets = getSheets()
            const rows = await readRows(sheets).catch(() => [])
            const own = rows.find((r, i) => i > 0 && lower(r[A.email]) === lower(email))
            const lang = own && LANGS.includes(lower(own[A.lang])) ? lower(own[A.lang]) : "en"
            const n = rows.length ? await unsubscribe(sheets, email) : 0
            console.log(`[camp-alerts] unsubscribed ${email} (${n} row(s))`)
            return page(200, lang, true)
        } catch (err) {
            console.error("[camp-alerts] unsubscribe failed:", err)
            return page(500, "en", false)
        }
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
    if (body.consent !== true) return json(400, { error: "invalid" }, origin)
    const source = body.source === "Booking" ? "Booking" : "Website"

    try {
        const result = await subscribe(getSheets(), {
            email: body.email,
            firstName: body.firstName,
            surname: body.surname,
            location: body.location,
            sport: body.sport,
            lang: body.lang,
            source,
        })
        if (result === "invalid") return json(400, { error: "invalid" }, origin)
        console.log(`[camp-alerts] ${result} ${lower(body.email)} for ${norm(body.location)} (${source})`)
        return json(200, { ok: true, result }, origin)
    } catch (err) {
        console.error("[camp-alerts] sign-up failed:", err)
        return json(500, { error: "server" }, origin)
    }
}

// Used by feedback.js, camp-alerts-send.js and tests.
exports._internal = { subscribe, unsubscribe, unsubscribeUrl, unsubscribeCode, emailFromCode, campParts, TAB, A, HEADER }
