// netlify/functions/register-camp.js
//
// Self-contained on purpose: no shared module to misplace.
// POST /api/register-camp — called by the booking form when a camp page loads.
//
// Keeps the "Overview" tab of the Google Sheet in step with the camps that are
// online: adds a row the first time a camp page is opened on the live website
// and refreshes location, sport and dates whenever they change in Framer.
// Drop-off, pick-up, address and "Good to know" go to the hidden "Camp
// details" tab (used by the camp-info email). Column B (WhatsApp link) and
// the Participants/Revenue columns are never written here.
//
// Only requests from the live website are accepted (ALLOWED_ORIGINS), only
// camps that have not ended, and only plain, length-capped values. Writes
// happen only when something actually changed.

const { google } = require("googleapis")

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

/* ---------- Address and Good to know from the published camp page ----------
 * Both are rich text in the Framer CMS, which code components can't receive.
 * The published page has them as HTML (in English — the translation tool only
 * works in the visitor's browser): the "Address" label and the "Good to know"
 * heading, each followed by its rich-text block.
 */
function decodeEntities(s) {
    return s
        .replace(/&nbsp;/g, " ")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
}

function richTextToPlain(html) {
    return decodeEntities(
        String(html || "")
            .replace(/<br\b[^>]*>/gi, "\n")
            .replace(/<li\b[^>]*>/gi, "• ")
            .replace(/<\/(p|li|h[1-6]|ul|ol|div|blockquote)>/gi, "\n")
            .replace(/<[^>]+>/g, "")
    )
        .split("\n")
        .map((l) => l.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join("\n")
}

// Text of the first rich-text block that follows the label.
function richTextAfter(html, labelRe) {
    const m = labelRe.exec(html)
    if (!m) return ""
    const rest = html.slice(m.index + m[0].length)
    const at = rest.indexOf('data-framer-component-type="RichTextContainer"')
    if (at < 0 || at > 4000) return "" // must sit right after the label
    const start = rest.indexOf(">", at) + 1
    const tags = /<\/?div\b[^>]*>/gi
    tags.lastIndex = start
    let depth = 1
    let t
    while ((t = tags.exec(rest))) {
        if (t[0][1] === "/") {
            depth -= 1
            if (depth === 0) return richTextToPlain(rest.slice(start, t.index))
        } else {
            depth += 1
        }
    }
    return ""
}

async function readCampPage(pageUrl) {
    let url
    try {
        url = new URL(String(pageUrl || ""))
    } catch (e) {
        return {}
    }
    const allowedHosts = ALLOWED_ORIGINS.map((o) => {
        try { return new URL(o).hostname } catch (e) { return "" }
    })
    if (url.protocol !== "https:" || !allowedHosts.includes(url.hostname)) return {}
    url.search = ""
    url.hash = ""
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)
    try {
        const res = await fetch(url.toString(), { signal: controller.signal, redirect: "follow" })
        if (!res.ok) return {}
        const html = await res.text()
        if (html.length > 5000000) return {}
        return {
            address: richTextAfter(html, />\s*Address\s*<\/p>/i),
            goodToKnow: richTextAfter(html, />\s*Good to know\s*<\/h[1-6]>/i),
        }
    } catch (err) {
        console.error(`[register-camp] could not read ${url}:`, err.message)
        return {}
    } finally {
        clearTimeout(timer)
    }
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

/* ---------- Camp list: "Overview" tab + hidden "Camp details" tab ----------
 * Same block in register-camp.js, stripe-webhook.js, send-camp-info.js and
 * update-overview.js (each function is self-contained on purpose).
 *
 * "Overview" (visible):  Camp | WhatsApp link | Location | Sport |
 *                        Start date | End date | Participants | Revenue
 *   B (WhatsApp link) is yours — the code never writes it.
 *   G/H are recalculated from the Bookings tab (paid + partially refunded).
 * "Camp details" (hidden): Camp | Drop-off | Pick-up | Venue address | Good to know
 *   used by the camp-info email; kept up to date from the website.
 */
const CAMPS_TAB = process.env.CAMPS_TAB || "Overview"
const DETAILS_TAB = process.env.CAMP_DETAILS_TAB || "Camp details"
const CAMPS_HEADER = ["Camp", "WhatsApp link", "Location", "Sport", "Start date", "End date", "Participants", "Revenue"]
const DETAILS_HEADER = ["Camp", "Drop-off", "Pick-up", "Venue address", "Good to know"]
const CAMP_LIST_COLS = { location: 2, sport: 3, start: 4, end: 5 }
const CAMP_DETAIL_COLS = { dropOff: 1, pickUp: 2, address: 3, goodToKnow: 4 }
const STATS_COLS = { participants: 6, revenue: 7 }

function campTabRange(tab, range) {
    return `'${String(tab).replace(/'/g, "''")}'!${range}`
}

function campColLetter(i) {
    return String.fromCharCode(65 + i)
}

function luxTodayISO() {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Luxembourg", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date())
}

// Creates the two tabs when missing (create = true) and upgrades an older
// Overview layout (with drop-off/pick-up/address/good-to-know in G–J).
async function ensureCampTabs(sheets, create = true) {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(sheetId,title)" })
    const tabs = (meta.data.sheets || []).map((t) => t.properties)
    let overview = tabs.find((t) => t.title === CAMPS_TAB)
    const details = tabs.find((t) => t.title === DETAILS_TAB)
    if (!overview && !create) return false

    const addTab = async (title, hidden) => {
        try {
            const res = await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: { requests: [{ addSheet: { properties: { title, hidden, gridProperties: { frozenRowCount: 1 } } } }] },
            })
            return res.data.replies[0].addSheet.properties.sheetId
        } catch (err) {
            if (/already exists/i.test(String(err && err.message))) return null
            throw err
        }
    }
    const formatOverview = async (sheetId) => {
        if (sheetId === null || sheetId === undefined) return
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
                requests: [
                    {
                        repeatCell: {
                            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: CAMPS_HEADER.length },
                            cell: { userEnteredFormat: { textFormat: { bold: true } } },
                            fields: "userEnteredFormat.textFormat.bold",
                        },
                    },
                    {
                        repeatCell: {
                            range: { sheetId, startRowIndex: 1, startColumnIndex: STATS_COLS.revenue, endColumnIndex: STATS_COLS.revenue + 1 },
                            cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "[$€]#,##0.00" } } },
                            fields: "userEnteredFormat.numberFormat",
                        },
                    },
                ],
            },
        })
    }
    const writeHeader = (tab, header) =>
        sheets.spreadsheets.values.update({
            spreadsheetId,
            range: campTabRange(tab, `A1:${campColLetter(header.length - 1)}1`),
            valueInputOption: "RAW",
            requestBody: { values: [header] },
        })

    if (!overview) {
        const id = await addTab(CAMPS_TAB, false)
        await writeHeader(CAMPS_TAB, CAMPS_HEADER)
        await formatOverview(id)
    } else {
        const head = await sheets.spreadsheets.values.get({ spreadsheetId, range: campTabRange(CAMPS_TAB, "A1:J1") })
        const current = ((head.data.values || [])[0] || []).map((v) => String(v || "").trim())
        if (current.join("|") !== CAMPS_HEADER.join("|")) {
            // Older layout: G–J held times, address and Good to know. Those now
            // live in the hidden tab and come back from the website.
            await sheets.spreadsheets.values.clear({ spreadsheetId, range: campTabRange(CAMPS_TAB, "G1:J") })
            await writeHeader(CAMPS_TAB, CAMPS_HEADER)
            await formatOverview(overview.sheetId)
            console.log(`[camps] upgraded the "${CAMPS_TAB}" tab to the new columns`)
        }
    }
    if (!details) {
        await addTab(DETAILS_TAB, true)
        await writeHeader(DETAILS_TAB, DETAILS_HEADER)
    }
    return true
}

// Adds the camp or refreshes it. Only non-empty values that changed are
// written. Never writes the WhatsApp link or the Participants/Revenue columns.
async function upsertCamp(sheets, campKey, info) {
    const key = String(campKey || "").trim()
    if (!key) return
    const lastDay = String(info.end || info.start || "")
    if (/^\d{4}-\d{2}-\d{2}$/.test(lastDay) && lastDay < luxTodayISO()) return // ended
    const spreadsheetId = process.env.GOOGLE_SHEET_ID
    await ensureCampTabs(sheets, true)

    const upsert = async (tab, width, cols, newRow) => {
        const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: campTabRange(tab, `A:${campColLetter(width - 1)}`) })
        const rows = res.data.values || []
        const idx = rows.findIndex((r, i) => i > 0 && String(r[0] || "").trim() === key)
        if (idx === -1) {
            const row = newRow()
            for (const [field, col] of Object.entries(cols)) row[col] = String(info[field] || "")
            await sheets.spreadsheets.values.append({
                spreadsheetId,
                range: campTabRange(tab, `A:${campColLetter(width - 1)}`),
                valueInputOption: "RAW",
                insertDataOption: "INSERT_ROWS",
                requestBody: { values: [row] },
            })
            return "added"
        }
        const current = rows[idx]
        const data = []
        for (const [field, col] of Object.entries(cols)) {
            const value = String(info[field] || "")
            if (value && value !== String(current[col] || "")) {
                data.push({ range: campTabRange(tab, `${campColLetter(col)}${idx + 1}`), values: [[value]] })
            }
        }
        if (data.length) {
            await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: "RAW", data } })
        }
        return data.length ? "updated" : "unchanged"
    }

    const listResult = await upsert(CAMPS_TAB, CAMPS_HEADER.length, CAMP_LIST_COLS, () => {
        const row = new Array(CAMPS_HEADER.length).fill("")
        row[0] = key
        row[STATS_COLS.participants] = 0
        row[STATS_COLS.revenue] = 0
        return row
    })
    await upsert(DETAILS_TAB, DETAILS_HEADER.length, CAMP_DETAIL_COLS, () => {
        const row = new Array(DETAILS_HEADER.length).fill("")
        row[0] = key
        return row
    })
    return listResult
}

// Participants (children) and revenue (column P) per camp, from the Bookings
// rows. Counted: "paid" and "partially refunded".
function campStatsFromBookings(bookingRows) {
    const stats = new Map()
    for (const r of bookingRows) {
        const name = String(r[2] || "").trim() // C = camp
        if (!name || !r[0]) continue
        const status = String(r[16] || "").trim().toLowerCase() // Q = status
        if (status !== "paid" && status !== "partially refunded") continue
        const s = stats.get(name) || { participants: 0, revenue: 0 }
        if (r[18] !== "Joiner") s.participants += 1 // S = role
        const p = Number(String(r[15] === undefined || r[15] === null ? "" : r[15]).replace(",", ".")) // P = price
        if (isFinite(p)) s.revenue += p
        stats.set(name, s)
    }
    for (const s of stats.values()) s.revenue = Math.round(s.revenue * 100) / 100
    return stats
}

// Writes Participants/Revenue into the Overview rows whose numbers changed.
async function writeCampStats(sheets, stats) {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID
    let res
    try {
        res = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: campTabRange(CAMPS_TAB, "A:H"),
            valueRenderOption: "UNFORMATTED_VALUE",
        })
    } catch (err) {
        if (/Unable to parse range/i.test(String(err && err.message))) return 0 // no Overview yet
        throw err
    }
    const rows = res.data.values || []
    const data = []
    rows.forEach((r, i) => {
        if (i === 0) return
        const name = String(r[0] || "").trim()
        if (!name) return
        const s = stats.get(name) || { participants: 0, revenue: 0 }
        const curP = r[STATS_COLS.participants], curR = r[STATS_COLS.revenue]
        if (String(curP) !== String(s.participants) || String(curR) !== String(s.revenue)) {
            data.push({
                range: campTabRange(CAMPS_TAB, `${campColLetter(STATS_COLS.participants)}${i + 1}:${campColLetter(STATS_COLS.revenue)}${i + 1}`),
                values: [[s.participants, s.revenue]],
            })
        }
    })
    if (data.length) {
        await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: "RAW", data } })
    }
    return data.length
}

// Overview rows merged with their hidden details, by camp name:
// [name, link, location, sport, start, end, dropOff, pickUp, address, goodToKnow]
async function readCampList(sheets) {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID
    const get = async (range) => {
        try {
            const res = await sheets.spreadsheets.values.get({ spreadsheetId, range })
            return (res.data.values || []).slice(1)
        } catch (err) {
            if (/Unable to parse range/i.test(String(err && err.message))) return []
            throw err
        }
    }
    const list = await get(campTabRange(CAMPS_TAB, "A:F"))
    const details = await get(campTabRange(DETAILS_TAB, "A:E"))
    const detailByName = new Map()
    for (const d of details) {
        const name = String(d[0] || "").trim()
        if (name && !detailByName.has(name)) detailByName.set(name, d)
    }
    return list.map((r) => {
        const d = detailByName.get(String(r[0] || "").trim()) || []
        const row = []
        for (let i = 0; i < 6; i++) row[i] = r[i] === undefined ? "" : r[i]
        row[6] = d[1] || ""
        row[7] = d[2] || ""
        row[8] = d[3] || ""
        row[9] = d[4] || ""
        return row
    })
}
/* ---------- end of camp list block ---------- */

// "Camp details" column F = group size (read by waitlist-offers.js) and
// column G = the camp page (read by camp-alerts-send.js). Only this function
// writes F and G; the shared block above only uses A–E.
function ownPageUrl(value) {
    try {
        const u = new URL(String(value || ""))
        const ok = ALLOWED_ORIGINS.some((o) => {
            try { return new URL(o).host === u.host } catch (e) { return false }
        })
        return u.protocol === "https:" && ok ? (u.origin + u.pathname).slice(0, 300) : ""
    } catch (e) {
        return ""
    }
}

async function writeCampExtras(sheets, campKey, size, page) {
    if (!size && !page) return
    const spreadsheetId = process.env.GOOGLE_SHEET_ID
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: campTabRange(DETAILS_TAB, "A:G") })
    const rows = res.data.values || []
    const idx = rows.findIndex((r, i) => i > 0 && String(r[0] || "").trim() === String(campKey).trim())
    if (idx === -1) return // ended camp (not added)
    const head = rows[0] || []
    const data = []
    if (String(head[5] || "").trim() !== "Group size") data.push({ range: campTabRange(DETAILS_TAB, "F1"), values: [["Group size"]] })
    if (String(head[6] || "").trim() !== "Camp page") data.push({ range: campTabRange(DETAILS_TAB, "G1"), values: [["Camp page"]] })
    if (size && String(rows[idx][5] || "") !== String(size)) {
        data.push({ range: campTabRange(DETAILS_TAB, `F${idx + 1}`), values: [[size]] })
    }
    if (page && String(rows[idx][6] || "") !== page) {
        data.push({ range: campTabRange(DETAILS_TAB, `G${idx + 1}`), values: [[page]] })
    }
    if (data.length) {
        await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: "RAW", data } })
    }
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

    const sizeNum = Number(body.groupSize)
    const groupSize = Number.isInteger(sizeNum) && sizeNum >= 1 && sizeNum <= 500 ? sizeNum : 0

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

    // Rich-text fields can't reach the form: take them from the page.
    if (!info.address || !info.goodToKnow) {
        const page = await readCampPage(body.pageUrl)
        if (!info.address && page.address) info.address = multiLine(page.address, 300)
        if (!info.goodToKnow && page.goodToKnow) info.goodToKnow = multiLine(page.goodToKnow, 1500)
    }

    try {
        const sheets = await getSheets()
        // Safety cap against junk rows.
        const existing = await sheets.spreadsheets.values
            .get({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: campTabRange(CAMPS_TAB, "A:A") })
            .then((r) => r.data.values || [])
            .catch(() => [])
        const known = existing.some((r, i) => i > 0 && String(r[0] || "").trim() === camp)
        if (!known && existing.length - 1 >= MAX_CAMP_ROWS) {
            console.error(`[register-camp] "${CAMPS_TAB}" already has ${MAX_CAMP_ROWS} rows — not adding "${camp}"`)
            return json(200, { ok: true, skipped: "full" }, origin)
        }
        const result = await upsertCamp(sheets, camp, info)
        if (result && result !== "unchanged") console.log(`[register-camp] ${result} "${camp}"`)
        // Group size (waiting list) and camp page (camp alerts) in
        // "Camp details" columns F and G.
        try {
            await writeCampExtras(sheets, camp, groupSize, ownPageUrl(body.pageUrl))
        } catch (err) {
            console.error(`[register-camp] could not write group size / page of "${camp}":`, err.message)
        }
        return json(200, { ok: true, result }, origin)
    } catch (err) {
        console.error("[register-camp] failed:", err)
        return json(500, { error: "Could not register camp" }, origin)
    }
}

// Exposed for tests only.
exports._internal = { richTextAfter, richTextToPlain }
