// netlify/functions/feedback.js
//
// Self-contained on purpose: no shared module to misplace.
//
// The feedback page on the website (Framer component Feedback_form.tsx) talks
// to this function:
//   GET  /api/feedback?t=<token>   → camp, parent and children for the page
//   POST /api/feedback             → saves the answers
//
// The token comes from the star links in the thank-you email
// (send-feedback-email.js): "<bookingId>.<signature>", signed with
// FEEDBACK_SECRET, so nobody can open or change another family's feedback.
// One feedback per booking.
//
// Saving:
//   - when the page opens from a star in the email, that rating is saved at
//     once (status "Started"), so it isn't lost if the parent stops there;
//   - "Send feedback" completes the same row (status "Sent"). After that the
//     feedback can't be changed any more.
//
// Writes to a separate Google spreadsheet (FEEDBACK_SHEET_ID):
//   "Responses" — one row per booking (created by the code)
//   "Summary"   — averages, counts, per-camp results and a chart (rewritten
//                 by the code after every sent feedback; don't type in it)
//
// The token "demo" shows sample data and saves nothing — for trying the page:
//   https://www.sportsevolution.lu/feedback?t=demo&fun=5   (&lang=fr|de|pt)
//
// Netlify environment variables:
//   FEEDBACK_SECRET            required — the same as for send-feedback-email
//   FEEDBACK_SHEET_ID          required — id of the feedback spreadsheet
//   FEEDBACK_ALLOWED_ORIGINS   optional — default: ALLOWED_ORIGINS, else
//                              https://www.sportsevolution.lu,https://sportsevolution.lu
//   FEEDBACK_OPEN_DAYS         optional — days after the camp the link works (60)

const { google } = require("googleapis")
const crypto = require("crypto")

/* ---------------- Settings ---------------- */

const BOOKINGS_TAB = process.env.GOOGLE_SHEET_TAB || "Bookings"
const B = {
    bookingId: 0, camp: 2, firstName: 3, clothingQty: 8, meals: 11,
    parentName: 12, status: 16, language: 17, role: 18, venue: 19,
    bookingReference: 22, startDate: 23, endDate: 24,
}
const ROLE_PARTICIPANT = "Participant"
const VALID_STATUSES = ["paid", "partially refunded"]

const RESPONSES_TAB = "Responses"
const SUMMARY_TAB = "Summary"
const HEADER = [
    "Status", "Last update", "Booking ID", "Booking reference", "Camp", "Location", "Sport",
    "Camp start", "Camp end", "Parent first name", "Children", "Language",
    "Fun", "Coaches", "Organisation", "Favourite moments", "Favourite (own words)",
    "Clothing set", "Lunch", "Next time", "Testimonial consent",
]
const R = {
    status: 0, updated: 1, bookingId: 2, reference: 3, camp: 4, location: 5, sport: 6,
    start: 7, end: 8, parent: 9, children: 10, language: 11,
    fun: 12, coaches: 13, organisation: 14, favourites: 15, favouriteText: 16,
    clothing: 17, lunch: 18, next: 19, consent: 20,
}
const LAST_LETTER = "U"
const STATUS_STARTED = "Started"
const STATUS_SENT = "Sent"

// Stored in English, whatever the page language.
const FAVOURITES = {
    matches: "Matches", tournament: "Tournament", friends: "New friends",
    coaches: "The coaches", skills: "New skills",
}
const NEXT = {
    easter: "Easter camp", summer: "Summer camp", autumnWinter: "Autumn / winter camp",
    academy: "Football Academy",
}
const SPORTS = { football: "Football", basketball: "Basketball", volleyball: "Volleyball" }
const LANGS = ["en", "fr", "de", "pt"]

const OPEN_DAYS = Number(process.env.FEEDBACK_OPEN_DAYS) > 0 ? Number(process.env.FEEDBACK_OPEN_DAYS) : 60
const MAX_BODY = 10000
const MAX_TEXT = 1000

const ALLOWED_ORIGINS = String(
    process.env.FEEDBACK_ALLOWED_ORIGINS ||
    process.env.ALLOWED_ORIGINS ||
    "https://www.sportsevolution.lu,https://sportsevolution.lu"
)
    .split(",")
    .map((s) => s.trim().replace(/\/$/, "").toLowerCase())
    .filter(Boolean)

/* ---------------- Helpers ---------------- */

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

function luxToday() {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Luxembourg", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date())
}

const MONTHS = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
    august: 8, september: 9, october: 10, november: 11, december: 12,
}

function toISODate(value) {
    const s = String(value || "").trim()
    let y, m, d
    let r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
    if (r) { y = +r[1]; m = +r[2]; d = +r[3] }
    if (!r && (r = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s))) { d = +r[1]; m = +r[2]; y = +r[3] }
    if (!r && (r = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(s))) {
        d = +r[1]; m = MONTHS[r[2].toLowerCase()] || 0; y = +r[3]
    }
    if (!y || !m || !d) return ""
    const check = new Date(Date.UTC(y, m - 1, d))
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return ""
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
}

function daysBetween(a, b) {
    return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)
}

function sportKeyFromCamp(camp) {
    const m = /\(([^)]+)\)/.exec(String(camp || ""))
    return m ? m[1].trim().toLowerCase() : ""
}

// Same signature as in send-feedback-email.js.
function signature(bookingId) {
    return crypto
        .createHmac("sha256", String(process.env.FEEDBACK_SECRET || ""))
        .update(`feedback:${bookingId}`)
        .digest("base64url")
        .slice(0, 32)
}

// Returns the booking ID, or "" when the token is not valid.
function verifyToken(token) {
    const s = String(token || "").trim()
    const dot = s.lastIndexOf(".")
    if (dot < 1 || s.length > 200) return ""
    const id = s.slice(0, dot)
    const given = Buffer.from(s.slice(dot + 1))
    const expected = Buffer.from(signature(id))
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return ""
    return id
}

function rating(v) {
    const n = Number(v)
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 0
}

function pickList(value, allowed) {
    if (!Array.isArray(value)) return null
    const out = []
    for (const k of value) {
        if (typeof k !== "string" || !Object.prototype.hasOwnProperty.call(allowed, k)) return null
        if (!out.includes(k)) out.push(k)
    }
    return out
}

function cleanText(v) {
    return String(v === undefined || v === null ? "" : v)
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
        .replace(/\r\n?/g, "\n")
        .trim()
        .slice(0, MAX_TEXT)
}

/* ---------------- Demo data ---------------- */

function demoBooking(lang) {
    return {
        bookingId: "demo", reference: "SE-DEMO", camp: "Mamer (football) · December 2026",
        location: "Mamer", sport: "football", start: "2026-12-28", end: "2026-12-31",
        parentName: "Anna Martin", children: ["Léa", "Tom"],
        lang: LANGS.includes(lang) ? lang : "en", hasClothing: true, hasLunch: true,
    }
}

/* ---------------- Google Sheets ---------------- */

function getSheets() {
    const auth = new google.auth.JWT(
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        null,
        (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
        ["https://www.googleapis.com/auth/spreadsheets"]
    )
    return google.sheets({ version: "v4", auth })
}

async function readBooking(sheets, bookingId) {
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: `${BOOKINGS_TAB}!A:Y`,
    })
    const group = (res.data.values || []).slice(1).filter((r) => r[B.bookingId] === bookingId)
    if (!group.length) return null
    const participants = group.filter((r) => (r[B.role] || ROLE_PARTICIPANT) === ROLE_PARTICIPANT)
    const first = participants[0] || group[0]
    if (!VALID_STATUSES.includes(String(first[B.status] || "").toLowerCase())) return null
    const camp = String(first[B.camp] || "").trim()
    const start = toISODate(first[B.startDate])
    const end = toISODate(first[B.endDate]) || start
    const lang = String(first[B.language] || "en").slice(0, 2).toLowerCase()
    return {
        bookingId,
        reference: String(first[B.bookingReference] || ""),
        camp,
        location: String(first[B.venue] || "").trim() || camp,
        sport: sportKeyFromCamp(camp),
        start, end,
        parentName: String(first[B.parentName] || "").trim(),
        children: [...new Set(participants.map((r) => String(r[B.firstName] || "").trim()).filter(Boolean))],
        lang: LANGS.includes(lang) ? lang : "en",
        hasClothing: participants.some((r) => Number(r[B.clothingQty]) > 0),
        hasLunch: participants.some((r) => String(r[B.meals] || "") === "Yes"),
    }
}

function tab(name, range) {
    return `'${name}'!${range}`
}

// Creates "Responses" and "Summary" (with its chart) when missing.
async function ensureTabs(sheets) {
    const spreadsheetId = process.env.FEEDBACK_SHEET_ID
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(sheetId,title),charts(chartId))" })
    const list = meta.data.sheets || []
    const find = (title) => list.find((s) => s.properties.title === title)

    const add = async (title) => {
        try {
            const r = await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: { requests: [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: title === RESPONSES_TAB ? 1 : 0 } } } }] },
            })
            return r.data.replies[0].addSheet.properties.sheetId
        } catch (err) {
            // Created at the same moment by another request.
            if (/already exists/i.test(String(err.message))) {
                const again = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(sheetId,title)" })
                const t = (again.data.sheets || []).find((s) => s.properties.title === title)
                if (t) return null
            }
            throw err
        }
    }

    if (!find(RESPONSES_TAB)) {
        const sheetId = await add(RESPONSES_TAB)
        if (sheetId !== null) {
            await sheets.spreadsheets.values.update({
                spreadsheetId, range: tab(RESPONSES_TAB, "A1"), valueInputOption: "RAW",
                requestBody: { values: [HEADER] },
            })
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: { requests: [{
                    repeatCell: {
                        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: HEADER.length },
                        cell: { userEnteredFormat: { textFormat: { bold: true } } },
                        fields: "userEnteredFormat.textFormat.bold",
                    },
                }] },
            })
        }
    }

    const summary = find(SUMMARY_TAB)
    if (!summary) {
        const sheetId = await add(SUMMARY_TAB)
        if (sheetId !== null) await addChart(sheets, sheetId)
    }
}

// Bar chart of the five average ratings (Summary!A4:B8). Never fatal: if it
// fails, the numbers are still written and the chart can be added by hand.
async function addChart(sheets, sheetId) {
    try {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: process.env.FEEDBACK_SHEET_ID,
            requestBody: { requests: [{
                addChart: { chart: {
                    spec: {
                        title: "Average rating (1–5)",
                        basicChart: {
                            chartType: "BAR",
                            legendPosition: "NO_LEGEND",
                            axis: [
                                { position: "BOTTOM_AXIS", viewWindowOptions: { viewWindowMode: "EXPLICIT", viewWindowMin: 0, viewWindowMax: 5 } },
                                { position: "LEFT_AXIS" },
                            ],
                            domains: [{ domain: { sourceRange: { sources: [{ sheetId, startRowIndex: 3, endRowIndex: 8, startColumnIndex: 0, endColumnIndex: 1 }] } } }],
                            series: [{
                                series: { sourceRange: { sources: [{ sheetId, startRowIndex: 3, endRowIndex: 8, startColumnIndex: 1, endColumnIndex: 2 }] } },
                                targetAxis: "BOTTOM_AXIS",
                                color: { red: 0.976, green: 0.698, blue: 0.2 },
                            }],
                            headerCount: 0,
                        },
                    },
                    position: { overlayPosition: { anchorCell: { sheetId, rowIndex: 2, columnIndex: 10 }, widthPixels: 520, heightPixels: 300 } },
                } },
            }] },
        })
    } catch (err) {
        console.error("[feedback] could not add the chart (add it by hand, see SETUP.md):", err.message)
    }
}

async function readResponses(sheets) {
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.FEEDBACK_SHEET_ID,
        range: tab(RESPONSES_TAB, `A:${LAST_LETTER}`),
        valueRenderOption: "UNFORMATTED_VALUE",
    })
    return res.data.values || []
}

function findRow(values, bookingId) {
    for (let i = 1; i < values.length; i++) {
        if (String(values[i][R.bookingId] || "") === bookingId) return i + 1 // 1-based sheet row
    }
    return 0
}

async function writeRow(sheets, values, row) {
    const spreadsheetId = process.env.FEEDBACK_SHEET_ID
    const existing = findRow(values, row[R.bookingId])
    if (existing) {
        await sheets.spreadsheets.values.update({
            spreadsheetId, range: tab(RESPONSES_TAB, `A${existing}:${LAST_LETTER}${existing}`),
            valueInputOption: "RAW", requestBody: { values: [row] },
        })
    } else {
        await sheets.spreadsheets.values.append({
            spreadsheetId, range: tab(RESPONSES_TAB, `A:${LAST_LETTER}`),
            valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: { values: [row] },
        })
    }
}

function baseRow(b, status) {
    const row = new Array(HEADER.length).fill("")
    row[R.status] = status
    row[R.updated] = new Date().toISOString()
    row[R.bookingId] = b.bookingId
    row[R.reference] = b.reference
    row[R.camp] = b.camp
    row[R.location] = b.location
    row[R.sport] = SPORTS[b.sport] || b.sport
    row[R.start] = b.start
    row[R.end] = b.end
    row[R.parent] = b.parentName.split(/\s+/)[0] || ""
    row[R.children] = b.children.join(", ")
    row[R.language] = b.lang
    return row
}

/* ---------------- Summary tab ---------------- */

function avg(list) {
    return list.length ? Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 100) / 100 : ""
}

async function writeSummary(sheets) {
    const spreadsheetId = process.env.FEEDBACK_SHEET_ID
    const rows = (await readResponses(sheets)).slice(1).filter((r) => r[R.bookingId])
    const nums = (r, k) => rating(r[k])
    const ratingKeys = [["Fun", R.fun], ["Coaches", R.coaches], ["Organisation", R.organisation], ["Clothing set", R.clothing], ["Lunch", R.lunch]]
    const sent = rows.filter((r) => r[R.status] === STATUS_SENT)
    const started = rows.filter((r) => r[R.status] === STATUS_STARTED)

    const count = (rowsIn, col, label) => rowsIn.filter((r) => String(r[col] || "").split(", ").includes(label)).length

    const grid = []
    const set = (r, c, v) => { while (grid.length <= r) grid.push([]); grid[r][c] = v }

    set(0, 0, "Camp feedback summary")
    set(0, 2, `Updated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`)

    set(2, 0, "Question"); set(2, 1, "Average (1–5)"); set(2, 2, "Answers")
    ratingKeys.forEach(([label, k], i) => {
        const list = rows.map((r) => nums(r, k)).filter(Boolean)
        set(3 + i, 0, label); set(3 + i, 1, avg(list)); set(3 + i, 2, list.length)
    })

    set(2, 4, "Favourite moment"); set(2, 5, "Times chosen")
    Object.values(FAVOURITES).forEach((label, i) => { set(3 + i, 4, label); set(3 + i, 5, count(sent, R.favourites, label)) })

    set(2, 7, "Next time"); set(2, 8, "Times chosen")
    Object.values(NEXT).forEach((label, i) => { set(3 + i, 7, label); set(3 + i, 8, count(sent, R.next, label)) })

    set(9, 0, "Feedback sent"); set(9, 1, sent.length)
    set(10, 0, "Star rating only (not finished)"); set(10, 1, started.length)
    set(11, 0, "Testimonial consent (Yes)"); set(11, 1, sent.filter((r) => r[R.consent] === "Yes").length)

    const head = ["Camp", "Location", "Camp end", "Feedback sent", "Fun", "Coaches", "Organisation", "Clothing set", "Lunch"]
    head.forEach((h, c) => set(13, c, h))
    const camps = new Map()
    for (const r of rows) {
        const key = String(r[R.camp] || "")
        if (!camps.has(key)) camps.set(key, { location: r[R.location] || "", end: String(r[R.end] || ""), rows: [] })
        camps.get(key).rows.push(r)
    }
    ;[...camps.entries()]
        .sort((a, b) => b[1].end.localeCompare(a[1].end) || a[0].localeCompare(b[0]))
        .forEach(([name, c], i) => {
            const line = [
                name, c.location, c.end, c.rows.filter((r) => r[R.status] === STATUS_SENT).length,
                ...ratingKeys.map(([, k]) => avg(c.rows.map((r) => nums(r, k)).filter(Boolean))),
            ]
            line.forEach((v, col) => set(14 + i, col, v))
        })

    const width = 9
    const values = grid.map((r) => Array.from({ length: width }, (_, c) => (r[c] === undefined ? "" : r[c])))
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: tab(SUMMARY_TAB, "A1:I2000") })
    await sheets.spreadsheets.values.update({
        spreadsheetId, range: tab(SUMMARY_TAB, "A1"), valueInputOption: "RAW", requestBody: { values },
    })
}

/* ---------------- Handler ---------------- */

exports.handler = async (event) => {
    const origin = String((event.headers && (event.headers.origin || event.headers.Origin)) || "")
        .replace(/\/$/, "")
        .toLowerCase()
    const allowed = ALLOWED_ORIGINS.includes(origin)

    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 204, headers: headers(allowed ? origin : ""), body: "" }
    }
    if (!allowed) return json(403, { error: "not_allowed" })
    if (event.httpMethod !== "GET" && event.httpMethod !== "POST") return json(405, { error: "method" }, origin)

    let body = {}
    let token = ""
    if (event.httpMethod === "GET") {
        token = String((event.queryStringParameters || {}).t || "")
    } else {
        if (String(event.body || "").length > MAX_BODY) return json(413, { error: "too_large" }, origin)
        try {
            body = JSON.parse(event.body || "{}")
        } catch (e) {
            return json(400, { error: "invalid" }, origin)
        }
        token = String(body.t || "")
    }

    const demo = token === "demo"
    if (!demo) {
        if (String(process.env.FEEDBACK_SECRET || "").length < 24 || !process.env.FEEDBACK_SHEET_ID) {
            console.error("[feedback] FEEDBACK_SECRET (24+ characters) and FEEDBACK_SHEET_ID must be set in Netlify")
            return json(503, { error: "not_configured" }, origin)
        }
    }
    const bookingId = demo ? "demo" : verifyToken(token)
    if (!bookingId) return json(404, { error: "invalid_link" }, origin)

    try {
        const sheets = demo ? null : getSheets()
        const booking = demo
            ? demoBooking(String((event.queryStringParameters || {}).lang || body.lang || "").toLowerCase())
            : await readBooking(sheets, bookingId)
        if (!booking) return json(404, { error: "invalid_link" }, origin)

        const today = luxToday()
        if (!demo) {
            const lastDay = booking.end || booking.start
            if (!lastDay || daysBetween(lastDay, today) < 0) return json(403, { error: "not_yet" }, origin)
            if (daysBetween(lastDay, today) > OPEN_DAYS) return json(410, { error: "closed" }, origin)
            await ensureTabs(sheets)
        }
        const responses = demo ? [] : await readResponses(sheets)
        const rowNo = findRow(responses, bookingId)
        const existing = rowNo ? responses[rowNo - 1] : null
        const submitted = !!existing && existing[R.status] === STATUS_SENT

        // ---- GET: what the page needs ----
        if (event.httpMethod === "GET") {
            return json(200, {
                ok: true,
                lang: booking.lang,
                parentName: booking.parentName,
                children: booking.children,
                location: booking.location,
                sport: booking.sport,
                startISO: booking.start,
                endISO: booking.end,
                hasClothing: booking.hasClothing,
                hasLunch: booking.hasLunch,
                submitted,
            }, origin)
        }

        // ---- POST ----
        if (submitted) return json(409, { error: "already_sent" }, origin)
        const a = body.answers && typeof body.answers === "object" ? body.answers : {}

        if (body.final !== true) {
            // Star from the email: save it right away.
            const fun = rating(a.fun)
            if (!fun) return json(400, { error: "invalid" }, origin)
            if (!demo) {
                const row = baseRow(booking, STATUS_STARTED)
                row[R.fun] = fun
                await writeRow(sheets, responses, row)
            }
            return json(200, { ok: true, saved: "started" }, origin)
        }

        const fun = rating(a.fun), coaches = rating(a.coaches), organisation = rating(a.organisation)
        const clothing = rating(a.clothing), lunch = rating(a.lunch)
        const favourites = pickList(a.favourites, FAVOURITES)
        const next = pickList(a.next, NEXT)
        const favouriteText = cleanText(a.favouriteText)
        const ok =
            fun && coaches && organisation &&
            favourites !== null && (favourites.length > 0 || favouriteText !== "") &&
            next !== null && next.length > 0 &&
            (booking.hasClothing ? clothing > 0 : !a.clothing) &&
            (booking.hasLunch ? lunch > 0 : !a.lunch) &&
            typeof a.consent === "boolean"
        if (!ok) return json(400, { error: "incomplete" }, origin)

        if (!demo) {
            const row = baseRow(booking, STATUS_SENT)
            row[R.fun] = fun
            row[R.coaches] = coaches
            row[R.organisation] = organisation
            row[R.favourites] = favourites.map((k) => FAVOURITES[k]).join(", ")
            row[R.favouriteText] = favouriteText
            row[R.clothing] = booking.hasClothing ? clothing : ""
            row[R.lunch] = booking.hasLunch ? lunch : ""
            row[R.next] = next.map((k) => NEXT[k]).join(", ")
            row[R.consent] = a.consent ? "Yes" : "No"
            await writeRow(sheets, responses, row)
            try {
                await writeSummary(sheets)
            } catch (err) {
                console.error("[feedback] saved, but the Summary tab could not be updated:", err.message)
            }
            console.log(`[feedback] feedback sent for booking ${bookingId}`)
        }
        return json(200, { ok: true, saved: "sent" }, origin)
    } catch (err) {
        console.error("[feedback] failed:", err)
        return json(500, { error: "server" }, origin)
    }
}

// Exposed for tests only.
exports._internal = { verifyToken, signature, writeSummary, ensureTabs, HEADER, R }
