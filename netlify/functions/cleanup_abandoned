// netlify/functions/cleanup-abandoned.js
//
// Self-contained on purpose: no shared module to misplace.
// Runs on a schedule (see netlify.toml) and removes rows for bookings that
// were never paid, so the Sheet only keeps real bookings.
//
// WHY A SCHEDULED JOB, NOT A DELETE IN THE WEBHOOK
// Deleting a row moves every row beneath it up by one, and the other
// functions address rows by number. Two deletes running at once — easy when
// two abandoned checkouts expire in the same second — can remove the wrong
// rows, i.e. somebody's paid booking. So this job is the ONLY thing that ever
// deletes, and it steps aside while anyone is mid-checkout.
//
// What gets deleted:
//   expired   — Stripe expired the checkout (abandoned)
//   released  — lost the race for the last spot
//   pending   — older than STALE_PENDING_MINUTES AND Stripe confirms no
//               successful payment exists (covers a missed "expired" event)
//
// Never touched: paid, refunded, partially refunded, the header row, blank
// rows, or anything with a status it doesn't recognise.

const { google } = require("googleapis")
const Stripe = require("stripe")

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

const COL = {
    bookingId: 0, createdAt: 1, camp: 2, firstName: 3, lastName: 4,
    status: 16,
}
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Bookings"
const DATA_RANGE = `${SHEET_TAB}!A:Z`

// Skip the run while anyone could still be in checkout. Stripe sessions
// expire after 31 minutes, so 35 covers every live one with a margin.
const ACTIVE_CHECKOUT_MINUTES = Number(process.env.CLEANUP_ACTIVE_MINUTES || 35)

// A pending row this old should have been expired by Stripe. It's deleted
// only after Stripe confirms it was never paid.
const STALE_PENDING_MINUTES = Number(process.env.CLEANUP_STALE_PENDING_MINUTES || 120)

async function getSheets() {
    const auth = new google.auth.JWT(
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        null,
        (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
        ["https://www.googleapis.com/auth/spreadsheets"]
    )
    return google.sheets({ version: "v4", auth })
}

function ageMinutes(createdAt) {
    const t = Date.parse(createdAt)
    return isNaN(t) ? null : (Date.now() - t) / 60000
}

// Has this booking actually been paid, whatever the Sheet says?
// Uses the bookingId copied onto the PaymentIntent by create-booking.
// Any doubt — search unavailable, error, timeout — counts as "paid", so the
// job keeps the rows rather than risk deleting a real booking.
async function wasPaid(bookingId) {
    try {
        const res = await stripe.paymentIntents.search({
            query: `metadata['bookingId']:'${String(bookingId).replace(/'/g, "")}'`,
            limit: 10,
        })
        return res.data.some((pi) => pi.status === "succeeded" || pi.status === "processing")
    } catch (err) {
        console.error(`[cleanup] could not check Stripe for ${bookingId} — keeping it:`, err.message)
        return true
    }
}

// The numeric id of the tab, which row deletion needs (not the spreadsheet id).
async function getTabId(sheets) {
    const meta = await sheets.spreadsheets.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        fields: "sheets.properties(sheetId,title)",
    })
    const tab = (meta.data.sheets || []).find((s) => s.properties.title === SHEET_TAB)
    if (!tab) throw new Error(`Tab "${SHEET_TAB}" not found`)
    return tab.properties.sheetId
}

// [5,6,7,12,13] -> [[12,13],[5,7]] — contiguous runs, bottom-most first.
function toRunsDescending(rowNumbers) {
    const sorted = [...new Set(rowNumbers)].sort((a, b) => a - b)
    const runs = []
    for (const n of sorted) {
        const last = runs[runs.length - 1]
        if (last && n === last[1] + 1) last[1] = n
        else runs.push([n, n])
    }
    return runs.reverse()
}

exports.handler = async () => {
    try {
        const sheets = await getSheets()
        const result = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
            range: DATA_RANGE,
        })
        const values = result.data.values || []

        if (values.length <= 1) {
            console.log("[cleanup] sheet is empty — nothing to do")
            return { statusCode: 200, body: "nothing to do" }
        }

        // Row 1 is the header; rowNumber === index + 1.
        const rows = values
            .map((data, i) => ({ rowNumber: i + 1, data }))
            .slice(1)
            .filter((r) => String(r.data[COL.bookingId] || "").trim() !== "")

        /* --- Guard: step aside while anyone is mid-checkout --- */

        const busy = rows.find((r) => {
            const status = String(r.data[COL.status] || "").trim().toLowerCase()
            const age = ageMinutes(r.data[COL.createdAt])
            if (age === null) return false
            if (age < 2) return true // a booking is being written right now
            return status === "pending" && age < ACTIVE_CHECKOUT_MINUTES
        })

        if (busy) {
            console.log(
                `[cleanup] skipped — booking ${busy.data[COL.bookingId]} is in an active ` +
                "checkout. Will retry on the next run."
            )
            return { statusCode: 200, body: "skipped: active checkout" }
        }

        /* --- Decide what goes --- */

        const toDelete = []
        const stalePendingByBooking = new Map()

        for (const r of rows) {
            const status = String(r.data[COL.status] || "").trim().toLowerCase()

            if (status === "expired" || status === "released") {
                toDelete.push(r.rowNumber)
            } else if (status === "pending") {
                const age = ageMinutes(r.data[COL.createdAt])
                if (age !== null && age >= STALE_PENDING_MINUTES) {
                    const id = r.data[COL.bookingId]
                    if (!stalePendingByBooking.has(id)) stalePendingByBooking.set(id, [])
                    stalePendingByBooking.get(id).push(r.rowNumber)
                }
            }
            // paid / refunded / partially refunded / anything else: kept
        }

        // A stale pending row may be a payment whose webhook failed. Only
        // delete it once Stripe confirms nobody paid.
        for (const [bookingId, rowNumbers] of stalePendingByBooking) {
            if (await wasPaid(bookingId)) {
                console.warn(
                    `[cleanup] ${bookingId} is PAID in Stripe but still "pending" in the ` +
                    "Sheet — kept. Check the stripe-webhook logs for that payment."
                )
            } else {
                toDelete.push(...rowNumbers)
            }
        }

        if (!toDelete.length) {
            console.log("[cleanup] no abandoned rows")
            return { statusCode: 200, body: "nothing to delete" }
        }

        /* --- Delete, bottom-up, in one atomic batch --- */
        // Deleting the lowest rows first keeps the row numbers of the rows
        // above valid for the rest of the batch.

        const tabId = await getTabId(sheets)
        const runs = toRunsDescending(toDelete)

        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
            requestBody: {
                requests: runs.map(([first, last]) => ({
                    deleteDimension: {
                        range: {
                            sheetId: tabId,
                            dimension: "ROWS",
                            startIndex: first - 1, // 0-based
                            endIndex: last,        // exclusive
                        },
                    },
                })),
            },
        })

        console.log(`[cleanup] deleted ${toDelete.length} abandoned row(s) in ${runs.length} block(s)`)
        return { statusCode: 200, body: `deleted ${toDelete.length}` }
    } catch (err) {
        console.error("[cleanup] failed:", err)
        return { statusCode: 500, body: err && err.message }
    }
}
