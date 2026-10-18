// netlify/functions/delete-medical-notes.js
//
// Self-contained on purpose: no shared module to misplace.
// Runs once a night (see netlify.toml).
//
// Empties "Allergies / notes" (Bookings column H) for every booking whose
// camp ended 3 months ago or more (end date in column Y, or the start date in
// column X when there is no end date). Names, booking and payment details
// stay, because they're needed for accounting. Nothing else is changed.
//
// The allergy notes exist only in this column: they're not in Stripe and not
// in any email, so emptying it removes them. Parents' email replies about
// health in the info@ mailbox must be deleted by hand.
//
// Netlify environment variable (optional):
//   MEDICAL_DELETE_DRY_RUN=true   only log what would be emptied

const { google } = require("googleapis")

const COL = { bookingId: 0, firstName: 3, lastName: 4, notes: 7, startDate: 23, endDate: 24 }
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Bookings"
const NOTES_LETTER = "H"
const MONTHS_AFTER = 3
const DRY_RUN = String(process.env.MEDICAL_DELETE_DRY_RUN || "").toLowerCase() === "true"

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

// "2026-11-30" + 3 months → "2027-02-28" (day capped at the month's length).
function addMonths(iso, months) {
    const [y, m, d] = iso.split("-").map(Number)
    const total = m - 1 + months
    const ty = y + Math.floor(total / 12)
    const tm = (total % 12) + 1
    const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate()
    return `${ty}-${String(tm).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`
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

const key = (r) => `${r[COL.bookingId] || ""}|${r[COL.firstName] || ""}|${r[COL.lastName] || ""}`

exports.handler = async () => {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID
    try {
        const sheets = await getSheets()
        const today = luxToday()
        const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET_TAB}!A:Y` })
        const rows = (res.data.values || []).slice(1)

        const due = new Set()
        for (const r of rows) {
            if (!r[COL.bookingId] || !String(r[COL.notes] || "").trim()) continue
            const lastDay = toISODate(r[COL.endDate]) || toISODate(r[COL.startDate])
            if (!lastDay) continue
            if (addMonths(lastDay, MONTHS_AFTER) <= today) due.add(key(r))
        }
        if (!due.size) {
            console.log("[medical] nothing to delete")
            return { statusCode: 200, body: JSON.stringify({ cleared: 0 }) }
        }

        // Rows can move (the cleanup job deletes rows), so they're matched
        // again by booking ID + child's name right before writing.
        const fresh = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET_TAB}!A:H` })
        const data = []
        ;(fresh.data.values || []).forEach((r, i) => {
            if (i === 0) return
            if (due.has(key(r)) && String(r[COL.notes] || "").trim()) {
                data.push({ range: `${SHEET_TAB}!${NOTES_LETTER}${i + 1}`, values: [[""]] })
            }
        })
        if (!data.length) {
            console.log("[medical] nothing to delete")
            return { statusCode: 200, body: JSON.stringify({ cleared: 0 }) }
        }
        if (DRY_RUN) {
            console.log(`[medical] DRY RUN — would empty Allergies / notes in ${data.length} row(s): ${data.map((d) => d.range).join(", ")}`)
            return { statusCode: 200, body: JSON.stringify({ wouldClear: data.length }) }
        }
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: { valueInputOption: "RAW", data },
        })
        console.log(`[medical] emptied Allergies / notes in ${data.length} row(s) (camps ended ${MONTHS_AFTER}+ months ago)`)
        return { statusCode: 200, body: JSON.stringify({ cleared: data.length }) }
    } catch (err) {
        console.error("[medical] run failed:", err)
        return { statusCode: 500, body: "failed" }
    }
}

// Exposed for tests only.
exports._internal = { addMonths, toISODate }
