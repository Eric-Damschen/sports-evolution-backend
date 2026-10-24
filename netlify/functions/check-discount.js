// netlify/functions/check-discount.js
//
// Self-contained on purpose: no shared module to misplace.
// GET /api/check-discount?code=SUMMER10
//   -> { valid: true, code: "SUMMER10", percent: 10, freeTicket: false }
//   -> { valid: true, code: "GIFT1", percent: 0, freeTicket: true }
//   -> { valid: false }   (unknown, inactive, expired or used up)
//
// Called by the booking forms when a parent presses "Apply". The codes stay in
// the private Sheet; only the one code the parent typed is ever answered for.
// create-booking checks the code again when the booking is made.

const { google } = require("googleapis")

const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Bookings"
const PENDING_HOLD_MINUTES = Number(process.env.PENDING_HOLD_MINUTES || 30)
const COL = { createdAt: 1, status: 16 }

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}

function json(statusCode, body) {
    return {
        statusCode,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS },
        body: JSON.stringify(body),
    }
}

async function getSheet() {
    const auth = new google.auth.JWT(
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        null,
        (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
        ["https://www.googleapis.com/auth/spreadsheets"]
    )
    return google.sheets({ version: "v4", auth })
}

// Same rule as create-booking: a booking counts while paid, partially
// refunded, or in a checkout younger than the hold.
function holdsASeat(row) {
    const status = String(row[COL.status] || "").trim().toLowerCase()
    if (status === "paid" || status === "partially refunded") return true
    if (status !== "pending") return false
    const created = Date.parse(row[COL.createdAt])
    if (isNaN(created)) return true
    return Date.now() - created < PENDING_HOLD_MINUTES * 60 * 1000
}

/* ---------------- Discount codes ---------------- */
// Codes live in the private "Discount codes" tab of the Sheet, row 1 = headers:
//   A Code | B Percent off | C Active | D Valid until | E Max uses
//   SUMMER10 | 10 | Yes | 2027-08-31 | 50
// - Percent off: 10 or 10% (a percentage of the camp fees, after the
//   multichild discount), or FREE = one camp ticket free. With FREE, the
//   other children in the booking pay as normal; add-ons and trip tickets
//   are paid, unless the code adds them:
//     FREE + lunch + clothing   → child 1's ticket, lunch and one clothing
//                                 set free (bottle: add "+ bottle")
//   The words may be in any order and case; "meals" works for lunch.
// - Active: "Yes" or a ticked checkbox. Anything else, blank included, = off.
// - Valid until (optional): last day the code works. Write it as 2027-08-31;
//   31/08/2027 and 31.08.2027 also work. Blank = no end date.
// - Max uses (optional): how many bookings may use it. Blank or 0 = unlimited.
// Any doubt (bad date, bad percent, tab missing) = the code is refused.

const DISCOUNT_TAB = process.env.DISCOUNT_SHEET_TAB || "Discount codes"
const DISCOUNT_CODE_COL = 26 // Bookings column AA

function normaliseCode(value) {
    return String(value || "").trim().toUpperCase()
}

function parsePercent(value) {
    const n = parseFloat(String(value || "").replace("%", "").replace(",", ".").trim())
    return isFinite(n) && n > 0 && n <= 100 ? n : 0
}

// -> "YYYY-MM-DD", "" when blank, null when unreadable
function parseSheetDate(value) {
    const s = String(value || "").trim()
    if (!s) return ""
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
    let y, mo, d
    if (m) {
        y = +m[1]; mo = +m[2]; d = +m[3]
    } else {
        m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/)
        if (!m) return null
        const a = +m[1], b = +m[2]
        y = +m[3]
        if (a > 12) { d = a; mo = b } else if (b > 12) { d = b; mo = a } else { d = a; mo = b }
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`
}

function todayInLuxembourg() {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Luxembourg",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date())
}

// Returns { code, percent, freeTicket } when usable, otherwise null.
// bookingRows = Bookings rows as { rowNumber, data }, used to count uses.
async function lookupDiscount(sheets, rawCode, bookingRows) {
    const code = normaliseCode(rawCode)
    if (!code) return null

    let values
    try {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
            range: `'${DISCOUNT_TAB.replace(/'/g, "''")}'!A2:E`,
        })
        values = res.data.values || []
    } catch (err) {
        console.error(`[discount] could not read the "${DISCOUNT_TAB}" tab:`, err.message)
        return null
    }

    const row = values.find((r) => normaliseCode(r[0]) === code)
    if (!row) return null

    const freeTicket = /^\s*free/i.test(String(row[1] || ""))
    const percent = freeTicket ? 0 : parsePercent(row[1])
    if (!freeTicket && !percent) {
        console.error(`[discount] ${code}: "${row[1]}" is neither FREE nor a number between 0 and 100`)
        return null
    }

    const active = String(row[2] || "").trim().toLowerCase()
    if (!["yes", "true", "x", "1"].includes(active)) return null

    const validUntil = parseSheetDate(row[3])
    if (validUntil === null) {
        console.error(`[discount] ${code}: unreadable date "${row[3]}" — write it as 2027-08-31`)
        return null
    }
    if (validUntil && todayInLuxembourg() > validUntil) return null

    const maxUses = parseInt(String(row[4] || "").trim(), 10)
    if (maxUses > 0) {
        const used = new Set()
        for (const { data } of bookingRows || []) {
            if (normaliseCode(data[DISCOUNT_CODE_COL]) === code && holdsASeat(data)) used.add(data[0])
        }
        if (used.size >= maxUses) return null
    }

    // FREE + lunch / clothing / bottle: those add-ons of child 1 are free too.
    const words = String(row[1] || "").toLowerCase()
    return {
        code, percent, freeTicket,
        freeMeals: freeTicket && /lunch|meal/.test(words),
        freeClothing: freeTicket && /cloth|kit/.test(words),
        freeBottle: freeTicket && /bottle/.test(words),
    }
}

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" }
    }
    if (event.httpMethod !== "GET") {
        return json(405, { error: "Method not allowed" })
    }

    const code = normaliseCode((event.queryStringParameters || {}).code)
    if (!code || code.length > 40) return json(200, { valid: false })

    try {
        const sheets = await getSheet()
        const result = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
            range: `${SHEET_TAB}!A:AA`,
        })
        const bookingRows = (result.data.values || []).map((data, i) => ({ rowNumber: i + 1, data }))

        const found = await lookupDiscount(sheets, code, bookingRows)
        if (!found) return json(200, { valid: false })
        return json(200, {
            valid: true,
            code: found.code,
            percent: found.percent,
            freeTicket: found.freeTicket,
            freeMeals: found.freeMeals,
            freeClothing: found.freeClothing,
            freeBottle: found.freeBottle,
        })
    } catch (err) {
        console.error("[check-discount] failed:", err)
        return json(500, { error: "Could not check the code", message: err && err.message })
    }
}
