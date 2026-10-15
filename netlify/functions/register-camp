// netlify/functions/register-camp.js
//
// Self-contained on purpose: no shared module to misplace.
// POST /api/register-camp — called by the booking form when a camp page loads.
//
// Keeps the "Overview" tab of the Google Sheet in step with the camps that are
// online: adds a row the first time a camp page is opened on the live website
// and refreshes location, sport, dates, times, address and "Good to know"
// whenever they change in Framer. Column B (WhatsApp link) is never written.
//
// Only requests from the live website are accepted (ALLOWED_ORIGINS), only
// camps that have not ended, and only plain, length-capped values. Writes
// happen only when something actually changed.

const { google } = require("googleapis")

const CAMPS_TAB = process.env.CAMPS_TAB || "Overview"
const CAMPS_HEADER = [
    "Camp", "WhatsApp link", "Location", "Sport", "Start date",
    "End date", "Drop-off", "Pick-up", "Venue address", "Good to know",
]
const CAMP_AUTO_COLS = { location: 2, sport: 3, start: 4, end: 5, dropOff: 6, pickUp: 7, address: 8, goodToKnow: 9 }
const SPORTS = ["football", "basketball", "volleyball"]
const MAX_CAMP_ROWS = 300 // a safety cap against junk rows

const ALLOWED_ORIGINS = String(
    process.env.ALLOWED_ORIGINS || "https://www.sportsevolution.lu,https://sportsevolution.lu"
)
    .split(",")
    .map((s) => s.trim().replace(/\/$/, "").toLowerCase())
    .filter(Boolean)

function corsHeaders(origin) {
    return {
        "Access-Control-Allow-Origin": origin || ALLOWED_ORIGINS[0] || "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        Vary: "Origin",
    }
}

function json(statusCode, body, origin) {
    return {
        statusCode,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
        body: JSON.stringify(body),
    }
}

function quoteTab(name) {
    return `'${String(name).replace(/'/g, "''")}'`
}

function oneLine(value, max) {
    return String(value || "")
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
}

function multiLine(value, max) {
    return String(value || "")
        .replace(/\r\n?/g, "\n")
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, max)
}

function isoDate(value) {
    const r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""))
    if (!r) return ""
    const y = +r[1], m = +r[2], d = +r[3]
    const check = new Date(Date.UTC(y, m - 1, d))
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return ""
    return r[0]
}

function time(value) {
    const s = String(value || "").trim()
    return /^\d{1,2}[:.h]\d{2}$/.test(s) ? s : ""
}

function luxToday() {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Luxembourg", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date())
}

function daysBetween(a, b) {
    return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)
}

async function getSheets() {
    const auth = new google.auth.JWT(
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        null,
        (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
        ["https://www.googleapis.com/auth/spreadsheets"]
    )
    return google.sheets({ version: "v4", auth })
}

async function ensureCampsTab(sheets) {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties.title" })
    if ((meta.data.sheets || []).some((t) => t.properties.title === CAMPS_TAB)) return
    try {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
                requests: [{ addSheet: { properties: { title: CAMPS_TAB, gridProperties: { frozenRowCount: 1 } } } }],
            },
        })
    } catch (err) {
        if (!/already exists/i.test(String(err && err.message))) throw err
    }
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${quoteTab(CAMPS_TAB)}!A1:J1`,
        valueInputOption: "RAW",
        requestBody: { values: [CAMPS_HEADER] },
    })
}

exports.handler = async (event) => {
    const origin = String((event.headers && (event.headers.origin || event.headers.Origin)) || "")
        .replace(/\/$/, "")
        .toLowerCase()
    const allowed = ALLOWED_ORIGINS.includes(origin)

    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 204, headers: corsHeaders(allowed ? origin : ""), body: "" }
    }
    if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" })
    if (!allowed) return json(403, { error: "Not allowed" })

    let body
    try {
        body = JSON.parse(event.body || "{}")
    } catch (e) {
        return json(400, { error: "Invalid JSON" }, origin)
    }

    const camp = oneLine(body.camp, 150)
    const sport = String(body.sport || "").toLowerCase()
    const start = isoDate(body.campStartISO)
    const end = isoDate(body.campEndISO) || start
    if (!camp || !start || !SPORTS.includes(sport) || end < start) {
        return json(400, { error: "Invalid camp" }, origin)
    }

    // Only camps that haven't ended, and not absurdly far ahead.
    const today = luxToday()
    if (end < today) return json(200, { ok: true, skipped: "ended" }, origin)
    if (daysBetween(today, start) > 730) return json(400, { error: "Invalid camp" }, origin)

    const info = {
        location: oneLine(body.location, 120),
        sport,
        start,
        end,
        dropOff: time(body.dropOffTime),
        pickUp: time(body.pickUpTime),
        address: multiLine(body.venueAddress, 300),
        goodToKnow: multiLine(body.goodToKnow, 1500),
    }

    try {
        const sheets = await getSheets()
        const spreadsheetId = process.env.GOOGLE_SHEET_ID
        await ensureCampsTab(sheets)

        const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${quoteTab(CAMPS_TAB)}!A:J` })
        const rows = res.data.values || []
        const idx = rows.findIndex((r, i) => i > 0 && String(r[0] || "").trim() === camp)

        if (idx === -1) {
            if (rows.length - 1 >= MAX_CAMP_ROWS) {
                console.error(`[register-camp] "${CAMPS_TAB}" already has ${MAX_CAMP_ROWS} rows — not adding "${camp}"`)
                return json(200, { ok: true, skipped: "full" }, origin)
            }
            const row = new Array(CAMPS_HEADER.length).fill("")
            row[0] = camp
            for (const [field, col] of Object.entries(CAMP_AUTO_COLS)) row[col] = info[field] || ""
            await sheets.spreadsheets.values.append({
                spreadsheetId,
                range: `${quoteTab(CAMPS_TAB)}!A:J`,
                valueInputOption: "RAW",
                insertDataOption: "INSERT_ROWS",
                requestBody: { values: [row] },
            })
            console.log(`[register-camp] added "${camp}"`)
            return json(200, { ok: true, added: true }, origin)
        }

        // Existing camp: write only the columns whose value changed.
        // Column B (WhatsApp link) is never touched.
        const current = rows[idx]
        const data = []
        for (const [field, col] of Object.entries(CAMP_AUTO_COLS)) {
            const value = String(info[field] || "")
            if (value && value !== String(current[col] || "")) {
                data.push({
                    range: `${quoteTab(CAMPS_TAB)}!${String.fromCharCode(65 + col)}${idx + 1}`,
                    values: [[value]],
                })
            }
        }
        if (data.length) {
            await sheets.spreadsheets.values.batchUpdate({
                spreadsheetId,
                requestBody: { valueInputOption: "RAW", data },
            })
            console.log(`[register-camp] updated "${camp}" (${data.length} field(s))`)
        }
        return json(200, { ok: true, updated: data.length }, origin)
    } catch (err) {
        console.error("[register-camp] failed:", err)
        return json(500, { error: "Could not register camp" }, origin)
    }
}
