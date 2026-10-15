// netlify/functions/update-overview.js
//
// Self-contained on purpose: no shared module to misplace.
// Runs on a schedule (see netlify.toml, every 15 minutes). It only READS the
// Bookings tab.
//
//   "Overview"  (the camp list, filled by register-camp.js and the webhook)
//               rows of camps that have ended are removed the day after their
//               last day; duplicate rows of the same camp are merged.
//
//   "2026", "2027", …  one tab per year, created at the first purchase for a
//               camp of that year. One row per camp of the year (upcoming,
//               running and finished) with status, participants, joiners,
//               revenue, add-ons, discount codes, how families heard about us
//               and refunds, plus a total row. Kept up to date all year.
//
// Counted: bookings with status "paid" or "partially refunded".
// Revenue = column P (what each person paid); partial refunds are not
// subtracted. Camp dates come from the "Camps" tab, or from columns X/Y.
// These tabs are rewritten by the code — don't type in them.

const { google } = require("googleapis")

const COL = {
    bookingId: 0, camp: 2, clothingQty: 8, clothingSize: 9, bottleQty: 10,
    meals: 11, bookingTotal: 15, status: 16, role: 18, venue: 19,
    startDate: 23, endDate: 24, discountCode: 26, referral: 27,
}
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Bookings"
const CAMPS_TAB = process.env.CAMPS_TAB || "Overview"
const CAMP = { name: 0, link: 1, location: 2, sport: 3, start: 4, end: 5 }

const COUNTED = ["paid", "partially refunded"]
const ROLE_JOINER = "Joiner"

const YEAR_HEADER = [
    "Camp", "Sport", "Start date", "End date", "Status", "Participants", "Joiners (trip)",
    "Revenue", "Clothing sets", "Clothing sizes", "Drinking bottles", "Lunches",
    "Discount codes", "Heard about us", "Refunded bookings",
]
const SPORTS = { football: "Football", basketball: "Basketball", volleyball: "Volleyball" }

/* ---------------- Helpers ---------------- */

function quoteTab(name) {
    return `'${String(name).replace(/'/g, "''")}'`
}

function colLetter(n) {
    let s = ""
    for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
    return s
}

function toNumber(value) {
    const n = Number(String(value === undefined || value === null ? "" : value).replace(",", "."))
    return isFinite(n) ? n : 0
}

function money(n) {
    return Math.round(n * 100) / 100
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

// Accepts "2026-12-28", "28/12/2026", "28.12.2026" or "28 December 2026".
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

// "2026-12-28" → "28/12/2026"
function displayDate(iso) {
    return iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : ""
}

function sportKeyFromCamp(camp) {
    const m = /\(([^)]+)\)/.exec(String(camp || ""))
    return m ? m[1].trim().toLowerCase() : ""
}

function locationFromCamp(camp) {
    const m = /^(.*?)\s\(/.exec(String(camp || ""))
    return m ? m[1].trim() : String(camp || "")
}

// { M: 3, S: 2 } → "M ×3 · S ×2" (largest first)
function tally(map) {
    return Object.entries(map)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([k, n]) => `${k} ×${n}`)
        .join(" · ")
}

/* ---------------- Sheets ---------------- */

async function getSheets() {
    const auth = new google.auth.JWT(
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        null,
        (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
        ["https://www.googleapis.com/auth/spreadsheets"]
    )
    return google.sheets({ version: "v4", auth })
}

async function readRange(sheets, range, unformatted) {
    try {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
            range,
            ...(unformatted ? { valueRenderOption: "UNFORMATTED_VALUE" } : {}),
        })
        return res.data.values || []
    } catch (err) {
        if (/Unable to parse range/i.test(String(err && err.message))) return null // tab missing
        throw err
    }
}

// Creates the tab (bold, frozen header, € column) if it doesn't exist.
async function ensureTab(sheets, existingTitles, title, header, moneyCol) {
    if (existingTitles.has(title)) return
    const spreadsheetId = process.env.GOOGLE_SHEET_ID
    let sheetId
    try {
        const res = await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: { requests: [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }] },
        })
        sheetId = res.data.replies[0].addSheet.properties.sheetId
    } catch (err) {
        if (/already exists/i.test(String(err && err.message))) { existingTitles.add(title); return }
        throw err
    }
    existingTitles.add(title)
    await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
            requests: [
                {
                    repeatCell: {
                        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: header.length },
                        cell: { userEnteredFormat: { textFormat: { bold: true } } },
                        fields: "userEnteredFormat.textFormat.bold",
                    },
                },
                {
                    repeatCell: {
                        range: { sheetId, startRowIndex: 1, startColumnIndex: moneyCol, endColumnIndex: moneyCol + 1 },
                        cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "[$€]#,##0.00" } } },
                        fields: "userEnteredFormat.numberFormat",
                    },
                },
            ],
        },
    })
    console.log(`[overview] created the "${title}" tab`)
}

// Rewrites a tab only when its content changed.
async function writeTable(sheets, title, header, rows) {
    const last = colLetter(header.length - 1)
    const table = [header, ...rows]
    const current = (await readRange(sheets, `${quoteTab(title)}!A1:${last}`, true)) || []
    const norm = (t) => JSON.stringify(t.map((r) => header.map((_, i) => (r[i] === undefined || r[i] === null ? "" : String(r[i])))))
    if (norm(current) === norm(table)) return false
    const spreadsheetId = process.env.GOOGLE_SHEET_ID
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${quoteTab(title)}!A1:${last}` })
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${quoteTab(title)}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: table },
    })
    return true
}

/* ---------------- Summaries ---------------- */

function summarise(bookingRows, campRows) {
    const camps = new Map()
    const get = (name) => {
        if (!camps.has(name)) {
            camps.set(name, {
                name, participants: 0, joiners: 0, revenue: 0, clothing: 0, sizes: {},
                bottles: 0, lunches: 0, codes: {}, heard: {}, refunded: new Set(),
                counted: new Set(), seen: new Set(), start: "", end: "",
                location: "", sport: "",
            })
        }
        return camps.get(name)
    }

    for (const r of bookingRows) {
        const name = String(r[COL.camp] || "").trim()
        if (!name || !r[COL.bookingId]) continue
        const status = String(r[COL.status] || "").trim().toLowerCase()
        const c = get(name)
        if (!c.start) c.start = toISODate(r[COL.startDate])
        if (!c.end) c.end = toISODate(r[COL.endDate])
        if (!c.location) c.location = String(r[COL.venue] || "").trim()

        if (status === "refunded") { c.refunded.add(r[COL.bookingId]); continue }
        if (!COUNTED.includes(status)) continue

        c.counted.add(r[COL.bookingId])
        c.revenue += toNumber(r[COL.bookingTotal])
        if (r[COL.role] === ROLE_JOINER) { c.joiners += 1; continue }
        c.participants += 1
        const qty = toNumber(r[COL.clothingQty])
        if (qty > 0) {
            c.clothing += qty
            const size = String(r[COL.clothingSize] || "?").trim() || "?"
            c.sizes[size] = (c.sizes[size] || 0) + qty
        }
        c.bottles += toNumber(r[COL.bottleQty])
        if (r[COL.meals] === "Yes") c.lunches += 1

        // Once per booking: discount code and "heard about us".
        if (!c.seen.has(r[COL.bookingId])) {
            c.seen.add(r[COL.bookingId])
            const code = String(r[COL.discountCode] || "").trim()
            if (code) c.codes[code] = (c.codes[code] || 0) + 1
            const heard = String(r[COL.referral] || "").trim()
            if (heard) c.heard[heard] = (c.heard[heard] || 0) + 1
        }
    }

    // The Overview tab (kept up to date from the website) wins for dates and
    // names, and adds camps that have no booking yet.
    for (const row of campRows) {
        const name = String(row[CAMP.name] || "").trim()
        if (!name) continue
        const c = get(name)
        c.start = toISODate(row[CAMP.start]) || c.start
        c.end = toISODate(row[CAMP.end]) || c.end
        c.location = String(row[CAMP.location] || "").trim() || c.location
        c.sport = String(row[CAMP.sport] || "").trim().toLowerCase()
    }
    for (const c of camps.values()) {
        if (!c.sport) c.sport = sportKeyFromCamp(c.name)
        if (!c.location) c.location = locationFromCamp(c.name)
        c.revenue = money(c.revenue)
    }
    return [...camps.values()]
}

function byDateThenName(a, b) {
    return (a.start || "9999").localeCompare(b.start || "9999") || a.name.localeCompare(b.name)
}

/* ---------------- Main ---------------- */

// Removes rows of ended camps and duplicate rows from the Overview tab.
// Duplicates (two page loads at the same moment) keep the row with a link.
async function tidyCampList(sheets, sheetId, campRows, today) {
    if (sheetId === undefined) return 0
    const remove = []
    const kept = new Map() // name → index of kept row
    campRows.forEach((row, i) => {
        const name = String(row[CAMP.name] || "").trim()
        if (!name) return
        const last = toISODate(row[CAMP.end]) || toISODate(row[CAMP.start])
        if (last && last < today) { remove.push(i); return }
        if (!kept.has(name)) { kept.set(name, i); return }
        const j = kept.get(name)
        const hasLink = (r) => String(r[CAMP.link] || "").trim() !== ""
        if (!hasLink(campRows[j]) && hasLink(row)) { remove.push(j); kept.set(name, i) } else remove.push(i)
    })
    if (!remove.length) return 0
    // campRows excludes the header: data row i is sheet row i + 1 (0-based).
    const requests = [...new Set(remove)]
        .sort((x, y) => y - x)
        .map((i) => ({ deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: i + 1, endIndex: i + 2 } } }))
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: process.env.GOOGLE_SHEET_ID, requestBody: { requests } })
    return requests.length
}

exports.handler = async () => {
    try {
        const sheets = await getSheets()
        const today = luxToday()

        const meta = await sheets.spreadsheets.get({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
            fields: "sheets.properties(sheetId,title)",
        })
        const tabs = (meta.data.sheets || []).map((t) => t.properties)
        const titles = new Set(tabs.map((t) => t.title))
        const campsTab = tabs.find((t) => t.title === CAMPS_TAB)

        const bookings = ((await readRange(sheets, `${quoteTab(SHEET_TAB)}!A:AB`, true)) || []).slice(1)
        let campRows = campsTab ? ((await readRange(sheets, `${quoteTab(CAMPS_TAB)}!A:F`, false)) || []).slice(1) : []

        const removed = await tidyCampList(sheets, campsTab && campsTab.sheetId, campRows, today)
        if (removed) {
            campRows = ((await readRange(sheets, `${quoteTab(CAMPS_TAB)}!A:F`, false)) || []).slice(1)
            console.log(`[overview] removed ${removed} ended or duplicate camp row(s) from "${CAMPS_TAB}"`)
        }

        const camps = summarise(bookings, campRows)

        const statusOf = (c) => {
            const last = c.end || c.start
            if (last && last < today) return "Finished"
            if (c.start && c.start <= today) return "Running"
            return "Upcoming"
        }

        // Year of the first camp day; a year tab exists once that year has a purchase.
        const byYear = new Map()
        for (const c of camps) {
            const year = (c.start || c.end).slice(0, 4)
            if (!year) continue
            if (!byYear.has(year)) byYear.set(year, [])
            byYear.get(year).push(c)
        }
        const yearsChanged = []
        const yearsShown = []
        for (const [year, all] of [...byYear].sort((a, b) => a[0].localeCompare(b[0]))) {
            if (!all.some((c) => c.counted.size > 0)) continue // no purchase that year yet
            // Finished camps without any booking are left out; upcoming ones stay.
            const list = all
                .filter((c) => c.counted.size > 0 || c.refunded.size > 0 || statusOf(c) !== "Finished")
                .sort(byDateThenName)
            const rows = list.map((c) => [
                c.location, SPORTS[c.sport] || c.sport, displayDate(c.start), displayDate(c.end), statusOf(c),
                c.participants, c.joiners, c.revenue, c.clothing, tally(c.sizes),
                c.bottles, c.lunches, tally(c.codes), tally(c.heard), c.refunded.size,
            ])
            const sum = (i) => rows.reduce((s, r) => s + (Number(r[i]) || 0), 0)
            rows.push([
                "Total", "", "", "", "", sum(5), sum(6), money(sum(7)), sum(8), "",
                sum(10), sum(11), "", "", sum(14),
            ])
            await ensureTab(sheets, titles, year, YEAR_HEADER, 7)
            if (await writeTable(sheets, year, YEAR_HEADER, rows)) yearsChanged.push(year)
            yearsShown.push(year)
        }

        console.log(
            `[overview] year tabs: ${yearsShown.join(", ") || "none yet"}` +
            `${yearsChanged.length ? ` (updated ${yearsChanged.join(", ")})` : ""}`
        )
        return { statusCode: 200, body: "ok" }
    } catch (err) {
        console.error("[overview] run failed:", err)
        return { statusCode: 500, body: "failed" }
    }
}

// Exposed for tests only.
exports._internal = { summarise, toISODate, tally, colLetter }
