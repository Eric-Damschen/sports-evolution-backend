// netlify/functions/stripe-webhook.js
//
// Self-contained on purpose: no shared module to misplace.
// Stripe calls this endpoint directly. It is the ONLY place that emails.
//
//   checkout.session.completed / async_payment_succeeded
//        -> Sheet rows go pending -> paid, confirmation email sent
//   checkout.session.expired   -> rows released, seats back on sale
//   charge.refunded            -> rows refunded / partially refunded
//
// Always returns 200 once the signature verifies, so Stripe never retries a
// payment that already went through. Failures show up in the Netlify logs.

const { google } = require("googleapis")
const Stripe = require("stripe")

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

// The Netlify variable is STRIPE_WEBHOOK_SECRET_KEY. Reading only the more
// common STRIPE_WEBHOOK_SECRET gives an empty secret, which fails signature
// verification every time and looks exactly like a wrong secret.
const WEBHOOK_SECRET =
    process.env.STRIPE_WEBHOOK_SECRET_KEY || process.env.STRIPE_WEBHOOK_SECRET || ""

const COL = {
    bookingId: 0, createdAt: 1, camp: 2, firstName: 3, lastName: 4, dob: 5,
    club: 6, allergies: 7, clothingQty: 8, clothingSize: 9, bottleQty: 10,
    meals: 11, parentName: 12, email: 13, phone: 14, bookingTotal: 15,
    status: 16, language: 17, role: 18,
    venue: 19, campDateRange: 20, ageRange: 21,
    bookingReference: 22, startDate: 23, endDate: 24,
    position: 25, discountCode: 26, referral: 27,
}
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Bookings"
const DATA_RANGE = `${SHEET_TAB}!A:AB`

// ★ Who gets the short "new booking" alert. Comma-separate for several.
const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || "info@sportsevolution.lu"
const STATUS_COLUMN_LETTER = "Q"

const ROLE_PARTICIPANT = "Participant"
const ROLE_JOINER = "Joiner"

/* ---------------- Sheets ---------------- */

async function getSheet() {
    const auth = new google.auth.JWT(
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        null,
        (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
        ["https://www.googleapis.com/auth/spreadsheets"]
    )
    return google.sheets({ version: "v4", auth })
}

// Row 1 is the header, so rowNumber === index + 1.
async function findBookingRows(sheets, bookingId) {
    const result = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: DATA_RANGE,
    })
    const rows = result.data.values || []
    const matches = []
    rows.forEach((row, i) => {
        if (row[COL.bookingId] === bookingId) matches.push({ rowNumber: i + 1, data: row })
    })
    return matches
}

async function setStatus(sheets, matches, status) {
    if (!matches.length) return 0
    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        requestBody: {
            valueInputOption: "RAW",
            data: matches.map(({ rowNumber }) => ({
                range: `${SHEET_TAB}!${STATUS_COLUMN_LETTER}${rowNumber}`,
                values: [[status]],
            })),
        },
    })
    return matches.length
}

function statusOf(match) {
    return String(match.data[COL.status] || "").trim().toLowerCase()
}

function toNumber(value, fallback = 0) {
    const n = Number(String(value).replace(",", "."))
    return isFinite(n) ? n : fallback
}

// Column P is per person, so the order total is the sum of the rows.
function sumRowTotals(matches) {
    const cents = matches.reduce(
        (acc, m) => acc + Math.round(toNumber(m.data[COL.bookingTotal], 0) * 100),
        0
    )
    return cents / 100
}

function esc(value) {
    return String(value === undefined || value === null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
}

/* ---------------- Handler ---------------- */

exports.handler = async (event) => {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method not allowed" }
    }

    const sig = event.headers["stripe-signature"] || event.headers["Stripe-Signature"]

    // Signature verification needs the EXACT bytes Stripe sent. Some Netlify
    // deployments expose them as event.rawBody, others base64-encode the body.
    let payload
    if (event.rawBody) {
        payload = event.rawBody
    } else if (event.isBase64Encoded) {
        payload = Buffer.from(event.body, "base64")
    } else {
        payload = event.body
    }

    if (!WEBHOOK_SECRET) {
        console.error("[webhook] STRIPE_WEBHOOK_SECRET_KEY is not set in this deploy context")
        return { statusCode: 400, body: "Webhook secret not configured" }
    }

    let stripeEvent
    try {
        stripeEvent = stripe.webhooks.constructEvent(payload, sig, WEBHOOK_SECRET)
    } catch (err) {
        console.error(
            `[webhook] signature verification FAILED: ${err.message} — ` +
            `hasRawBody: ${!!event.rawBody}, isBase64Encoded: ${!!event.isBase64Encoded}, ` +
            `bodyLength: ${event.body ? event.body.length : 0}, sigPresent: ${!!sig}, ` +
            `secretPrefix: ${WEBHOOK_SECRET.slice(0, 8)}, secretLength: ${WEBHOOK_SECRET.length}`
        )
        return { statusCode: 400, body: `Webhook Error: ${err.message}` }
    }

    console.log(`[webhook] verified ${stripeEvent.type} (${stripeEvent.id})`)

    try {
        if (
            stripeEvent.type === "checkout.session.completed" ||
            stripeEvent.type === "checkout.session.async_payment_succeeded"
        ) {
            await handlePaid(stripeEvent.data.object)
        } else if (stripeEvent.type === "checkout.session.expired") {
            await handleExpired(stripeEvent.data.object)
        } else if (stripeEvent.type === "charge.refunded") {
            await handleRefund(stripeEvent.data.object)
        }
    } catch (err) {
        // Swallowed on purpose: the payment succeeded, Stripe must not retry.
        console.error("[webhook] processing failed (still returning 200):", err)
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) }
}

/* ---------------- Paid ---------------- */

async function handlePaid(session) {
    const metadata = session.metadata || {}
    const bookingId = metadata.bookingId

    if (!bookingId) {
        console.error(`[webhook] session ${session.id} carries no bookingId — ignoring`)
        return
    }
    // "no_payment_required" = a €0 booking made free by a FREE code.
    if (
        session.payment_status &&
        session.payment_status !== "paid" &&
        session.payment_status !== "no_payment_required"
    ) {
        console.log(`[webhook] ${bookingId} not paid yet (${session.payment_status})`)
        return
    }

    const sheets = await getSheet()
    const matches = await findBookingRows(sheets, bookingId)

    if (!matches.length) {
        console.error(`[webhook] no sheet rows for booking ${bookingId}`)
        return
    }

    const statuses = matches.map(statusOf)

    // A refund already happened — a late redelivery must not undo it.
    if (statuses.some((s) => s === "refunded" || s === "partially refunded")) {
        console.log(`[webhook] ${bookingId} has been refunded — not re-marking paid`)
        return
    }
    // Stripe retries, and duplicate endpoints double-fire.
    if (statuses.every((s) => s === "paid")) {
        console.log(`[webhook] ${bookingId} already paid — not resending the email`)
        return
    }

    const updated = await setStatus(sheets, matches, "paid")
    console.log(`[webhook] ${bookingId}: ${updated} row(s) marked paid`)

    // ★ Short alert to the team. Sent once, only here (after the row flips to
    // paid), and a failure never blocks the parent's confirmation email.
    try {
        await sendAdminNotification(matches, session)
        console.log(`[webhook] ${bookingId}: team alert sent to ${ADMIN_NOTIFY_EMAIL}`)
    } catch (err) {
        console.error(`[webhook] ${bookingId}: team alert failed:`, err.message)
    }

    // ★ Adds this camp to the "Overview" tab (or refreshes it) and updates its
    // Participants and Revenue straight away. Never blocks the email.
    try {
        await upsertCamp(sheets, matches[0].data[COL.camp], {
            location: metadata.location || matches[0].data[COL.venue] || "",
            sport: metadata.sport || sportKeyFromCamp(matches[0].data[COL.camp]),
            start: metadata.campStartISO || "",
            end: metadata.campEndISO || "",
            dropOff: metadata.dropOffTime || "",
            pickUp: metadata.pickUpTime || "",
            address: metadata.venueAddress || "",
            goodToKnow: [metadata.goodToKnow1, metadata.goodToKnow2, metadata.goodToKnow3].filter(Boolean).join(""),
        })
    } catch (err) {
        console.error(`[webhook] ${bookingId}: Overview tab update failed:`, err.message)
    }
    try {
        const all = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
            range: `${SHEET_TAB}!A:S`,
            valueRenderOption: "UNFORMATTED_VALUE",
        })
        await writeCampStats(sheets, campStatsFromBookings((all.data.values || []).slice(1)))
    } catch (err) {
        console.error(`[webhook] ${bookingId}: Participants/Revenue update failed:`, err.message)
    }

    const buyerEmail =
        matches[0].data[COL.email] ||
        (session.customer_details && session.customer_details.email) ||
        session.customer_email ||
        null

    if (!buyerEmail) {
        console.error(`[webhook] ${bookingId}: no buyer address from the Sheet or Stripe`)
        return
    }

    const lang = String(matches[0].data[COL.language] || "en").slice(0, 2).toLowerCase()
    const t = T[lang] || T.en
    const amountPaid =
        typeof session.amount_total === "number" ? session.amount_total / 100 : NaN

    // Address and Good to know are rich text in Framer, so the form can't send
    // them; register-camp reads them from the camp page into "Camp details".
    let emailMeta = metadata
    if (!metadata.venueAddress) {
        try {
            const campName = String(matches[0].data[COL.camp] || "").trim()
            const row = (await readCampList(sheets)).find((r) => String(r[0] || "").trim() === campName)
            if (row && row[8]) emailMeta = { ...metadata, venueAddress: row[8] }
        } catch (err) {
            console.error(`[webhook] ${bookingId}: could not read Camp details:`, err.message)
        }
    }

    const calendarEvent = buildCalendarEvent(matches, emailMeta, t)

    await sendEmail(
        buyerEmail,
        t.subject(matches[0].data[COL.bookingReference] || ""),
        buildConfirmationHtml(
            matches,
            metadata.dropOffTime,
            metadata.pickUpTime,
            t,
            amountPaid,
            calendarEvent,
            emailMeta
        ),
        calendarEvent
    )

    console.log(`[webhook] ${bookingId}: confirmation sent to ${buyerEmail} (${lang})`)
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

// "Mamer (football) · December 2026" → "football"
function sportKeyFromCamp(camp) {
    const m = /\(([^)]+)\)/.exec(String(camp || ""))
    return m ? m[1].trim().toLowerCase() : ""
}

/* ---------------- Team alert ---------------- */

function formatEuro(n) {
    return isFinite(n) ? `€${n.toFixed(2)}` : "—"
}

function buildAdminNotification(matches, session) {
    const first = matches[0].data
    const ref = first[COL.bookingReference] || ""
    const participants = matches.filter(
        (m) => (m.data[COL.role] || ROLE_PARTICIPANT) === ROLE_PARTICIPANT
    )
    const guests = matches.filter((m) => m.data[COL.role] === ROLE_JOINER)
    const amountPaid =
        typeof session.amount_total === "number"
            ? session.amount_total / 100
            : sumRowTotals(matches)
    const n = participants.length
    const campName = first[COL.camp] || ""

    const subject =
        `New booking ${ref} · ${campName} · ` +
        `${n} ${n === 1 ? "child" : "children"} · ${formatEuro(amountPaid)}`

    const childLine = (m) => {
        const d = m.data
        const extras = []
        const qty = Number(d[COL.clothingQty]) || 0
        if (qty > 0) extras.push(`clothing ${qty}×${d[COL.clothingSize] || "?"}`)
        const bottles = Number(d[COL.bottleQty]) || 0
        if (bottles > 0) extras.push(`bottle ${bottles}`)
        if (d[COL.meals] === "Yes") extras.push("meals")
        return (
            `${esc(d[COL.firstName])} ${esc(d[COL.lastName])}` +
            (d[COL.club] ? ` · ${esc(d[COL.club])}` : "") +
            (extras.length ? ` · ${esc(extras.join(", "))}` : "")
        )
    }

    const rows = [
        ["Camp", esc(campName)],
        ["Dates", esc(first[COL.campDateRange] || "")],
        ["Children", participants.map(childLine).join("<br>")],
        ...(guests.length
            ? [["Trip guests", guests.map((m) => `${esc(m.data[COL.firstName])} ${esc(m.data[COL.lastName])}`).join("<br>")]]
            : []),
        ["Parent", `${esc(first[COL.parentName])}<br>${esc(first[COL.email])}<br>${esc(first[COL.phone])}`],
        ["Paid", esc(formatEuro(amountPaid))],
        ...(first[COL.discountCode] ? [["Code", esc(first[COL.discountCode])]] : []),
        ...(first[COL.referral] ? [["Heard via", esc(first[COL.referral])]] : []),
    ]

    const html =
        `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111;line-height:1.5">` +
        `<p style="margin:0 0 12px"><strong>New booking ${esc(ref)}</strong></p>` +
        `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse">` +
        rows
            .map(
                ([k, v]) =>
                    `<tr><td style="padding:4px 16px 4px 0;color:#666;vertical-align:top;white-space:nowrap">${k}</td>` +
                    `<td style="padding:4px 0;vertical-align:top">${v}</td></tr>`
            )
            .join("") +
        `</table>` +
        `<p style="margin:12px 0 0;color:#666">Full details in the Google Sheet.</p>` +
        `</div>`

    return { subject, html, replyTo: first[COL.email] || "" }
}

async function sendAdminNotification(matches, session) {
    const to = ADMIN_NOTIFY_EMAIL.split(",").map((s) => s.trim()).filter(Boolean)
    if (!to.length) return
    const { subject, html, replyTo } = buildAdminNotification(matches, session)
    await sendEmail(to, subject, html, null, { replyTo, skipBcc: true })
}

/* ---------------- Expired ---------------- */

async function handleExpired(session) {
    const bookingId = (session.metadata || {}).bookingId
    if (!bookingId) return

    const sheets = await getSheet()
    const matches = await findBookingRows(sheets, bookingId)
    if (!matches.length) return

    if (matches.some((m) => statusOf(m) === "paid")) {
        console.log(`[webhook] expired event for already-paid ${bookingId} — ignoring`)
        return
    }

    const updated = await setStatus(sheets, matches, "expired")
    console.log(`[webhook] ${bookingId}: checkout abandoned, ${updated} seat(s) released`)
}

/* ---------------- Refund ---------------- */

// Full refund   -> "refunded", the place goes back on sale
// Partial refund -> "partially refunded", the place stays held
async function handleRefund(charge) {
    const bookingId = await resolveBookingId(charge)

    if (!bookingId) {
        console.error(
            `[webhook] refund on charge ${charge.id} has no bookingId and no matching session`
        )
        return
    }
    if (!charge.amount_refunded) {
        console.log(`[webhook] ${bookingId}: refund event with nothing refunded — ignoring`)
        return
    }

    const isFull = charge.refunded === true || charge.amount_refunded >= charge.amount
    const target = isFull ? "refunded" : "partially refunded"

    const sheets = await getSheet()
    const matches = await findBookingRows(sheets, bookingId)

    if (!matches.length) {
        console.error(`[webhook] no sheet rows for refunded booking ${bookingId}`)
        return
    }
    if (matches.every((m) => statusOf(m) === target)) {
        console.log(`[webhook] ${bookingId}: already "${target}"`)
        return
    }

    const updated = await setStatus(sheets, matches, target)
    console.log(
        `[webhook] ${bookingId}: refunded €${(charge.amount_refunded / 100).toFixed(2)} ` +
        `of €${(charge.amount / 100).toFixed(2)} — ${updated} row(s) "${target}"`
    )
}

// Bookings made after payment_intent_data.metadata was added carry the id on
// the charge; older ones are found via the Checkout Session.
async function resolveBookingId(charge) {
    const fromCharge = (charge.metadata || {}).bookingId
    if (fromCharge) return fromCharge
    if (!charge.payment_intent) return null

    try {
        const sessions = await stripe.checkout.sessions.list({
            payment_intent: charge.payment_intent,
            limit: 1,
        })
        const session = sessions.data && sessions.data[0]
        return (session && session.metadata && session.metadata.bookingId) || null
    } catch (err) {
        console.error("[webhook] session lookup failed for charge", charge.id, err.message)
        return null
    }
}

/* ---------------- Calendar ---------------- */

// "2026-10-20" or "20 October 2026" -> "20261020"
function toCalendarDate(value) {
    if (!value) return ""
    const s = String(value).trim()

    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
    if (iso) return `${iso[1]}${iso[2]}${iso[3]}`

    const d = new Date(s)
    if (!isNaN(d.getTime())) {
        return (
            String(d.getFullYear()) +
            String(d.getMonth() + 1).padStart(2, "0") +
            String(d.getDate()).padStart(2, "0")
        )
    }
    return ""
}

// All-day events end on the day AFTER the last day.
function nextDay(yyyymmdd) {
    if (!/^\d{8}$/.test(yyyymmdd)) return ""
    const y = Number(yyyymmdd.slice(0, 4))
    const m = Number(yyyymmdd.slice(4, 6))
    const d = Number(yyyymmdd.slice(6, 8))
    const dt = new Date(Date.UTC(y, m - 1, d + 1))
    return (
        String(dt.getUTCFullYear()) +
        String(dt.getUTCMonth() + 1).padStart(2, "0") +
        String(dt.getUTCDate()).padStart(2, "0")
    )
}

// "Rodange (football) · October 2026" -> "Rodange"
function venueFromCamp(camp) {
    const m = String(camp || "").match(/^(.*?)\s\(/)
    return m ? m[1].trim() : String(camp || "")
}

// "Rodange (football) · October 2026" -> "Football"
function sportFromCamp(camp) {
    const m = String(camp || "").match(/\(([^)]*)\)/)
    if (!m) return ""
    const sport = m[1].trim()
    return sport ? sport.charAt(0).toUpperCase() + sport.slice(1) : ""
}

// RFC 5545 wants lines folded at 75 octets. Most clients cope without it,
// stricter ones do not.
function icsFold(line) {
    if (line.length <= 73) return line
    const parts = []
    let rest = line
    parts.push(rest.slice(0, 73))
    rest = rest.slice(73)
    while (rest.length > 72) {
        parts.push(" " + rest.slice(0, 72))
        rest = rest.slice(72)
    }
    if (rest.length) parts.push(" " + rest)
    return parts.join("\r\n")
}

function buildCalendarEvent(matches, metadata, t) {
    const first = matches[0].data

    const start = toCalendarDate(metadata.campStartISO || first[COL.startDate])
    if (!start) return null

    const lastDay =
        toCalendarDate(metadata.campEndISO || first[COL.endDate]) || start
    const end = nextDay(lastDay)
    const town = first[COL.venue] || venueFromCamp(first[COL.camp])
    // Full address (one line) when known, so calendar apps can map it.
    const address = String(metadata.venueAddress || "")
        .split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(", ")
    const location = address || town

    // Drop-off, pick-up and the good-to-know note only — no booking
    // reference, which belongs in the email body rather than in a calendar
    // entry the whole family may see.
    const details = [
        metadata.dropOffTime ? `${t.dropOff}: ${metadata.dropOffTime}` : "",
        metadata.pickUpTime
            ? `${t.pickUp}: ${t.until} ${metadata.pickUpTime}`
            : "",
        `${t.goodToKnow}: ${t.comingNext}`,
    ]
        .filter(Boolean)
        .join("\n")

    return {
        start,
        end,
        title: [sportFromCamp(first[COL.camp]) || first[COL.camp], town]
            .filter(Boolean)
            .join(" — "),
        details,
        location,
        reference: first[COL.bookingReference] || "",
    }
}

function googleCalendarUrl(ev) {
    const params = new URLSearchParams({
        action: "TEMPLATE",
        text: ev.title,
        dates: `${ev.start}/${ev.end}`,
        details: ev.details,
        location: ev.location,
    })
    return `https://calendar.google.com/calendar/render?${params.toString()}`
}

function icsEscape(s) {
    return String(s || "")
        .replace(/\\/g, "\\\\")
        .replace(/;/g, "\\;")
        .replace(/,/g, "\\,")
        .replace(/\n/g, "\\n")
}

// Apple Mail, Outlook and Gmail all offer "add to calendar" when an .ics is
// attached, so the invite travels with the email rather than as a link.
function buildIcs(ev) {
    const stamp = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, "")

    return [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Sports Evolution//Booking//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        `UID:${ev.reference || stamp}@sportsevolution.lu`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${ev.start}`,
        `DTEND;VALUE=DATE:${ev.end}`,
        `SUMMARY:${icsEscape(ev.title)}`,
        `LOCATION:${icsEscape(ev.location)}`,
        `DESCRIPTION:${icsEscape(ev.details)}`,
        "END:VEVENT",
        "END:VCALENDAR",
    ]
        .map(icsFold)
        .join("\r\n")
}

/* ---------------- Email ---------------- */

const T = {
    en: {
        subject: (ref) => `Payment confirmed — ${ref}`,
        headline: "Booking confirmed", sport: "Sport", map: "Open in Google Maps",
        sports: { football: "Football", basketball: "Basketball", volleyball: "Volleyball" },
        hi: (n) => `Hi ${n},`,
        intro: "Your payment has been received and your booking is confirmed.",
        reference: "Booking reference", camp: "Camp", dates: "Dates", venue: "Venue",
        ages: "Ages", dropOff: "Drop-off", pickUp: "Pick-up", tickets: "Tickets",
        total: "Total paid", perChild: "Details per child", tripTickets: "Trip tickets",
        child: "child", children: "children", noAddOns: "No add-ons",
        clothing: "Clothing set", bottle: "Drinking bottle", meals: "Meals",
        size: "size", outro: "Thank you for your trust. See you on the court!",
        addToCalendar: "Add this camp to your calendar",
        googleCalendar: "Add to Google Calendar",
        appleCalendar: "For Apple Calendar or Outlook, open the attached invite file.",
        until: "until",
        signOff: "Kind regards,", team: "Your Sports Evolution Team",
        goodToKnow: "Good to know",
        comingNext:
            "We will send you an email with all the necessary information one week before the start of the camp.",
    },
    fr: {
        subject: (ref) => `Paiement confirmé — ${ref}`,
        headline: "Réservation confirmée", sport: "Sport", map: "Ouvrir dans Google Maps",
        sports: { football: "Football", basketball: "Basketball", volleyball: "Volleyball" },
        hi: (n) => `Bonjour ${n},`,
        intro: "Votre paiement a bien été reçu et votre réservation est confirmée.",
        reference: "Référence de réservation", camp: "Stage", dates: "Dates", venue: "Lieu",
        ages: "Âges", dropOff: "Dépose", pickUp: "Reprise", tickets: "Places",
        total: "Montant payé", perChild: "Détails par enfant", tripTickets: "Billets sortie",
        child: "enfant", children: "enfants", noAddOns: "Aucun supplément",
        clothing: "Tenue", bottle: "Gourde", meals: "Repas",
        size: "taille", outro: "Merci pour votre confiance. À bientôt sur le terrain !",
        addToCalendar: "Ajoutez ce stage à votre agenda",
        googleCalendar: "Ajouter à Google Agenda",
        appleCalendar: "Pour Calendrier Apple ou Outlook, ouvrez le fichier d'invitation joint.",
        until: "jusqu'à",
        signOff: "Cordialement,", team: "Votre équipe Sports Evolution",
        goodToKnow: "Bon à savoir",
        comingNext:
            "Nous vous enverrons un e-mail avec toutes les informations nécessaires une semaine avant le début du stage.",
    },
    de: {
        subject: (ref) => `Zahlung bestätigt — ${ref}`,
        headline: "Buchung bestätigt", sport: "Sport", map: "In Google Maps öffnen",
        sports: { football: "Fußball", basketball: "Basketball", volleyball: "Volleyball" },
        hi: (n) => `Hallo ${n},`,
        intro: "Ihre Zahlung ist eingegangen und Ihre Buchung ist bestätigt.",
        reference: "Buchungsreferenz", camp: "Camp", dates: "Daten", venue: "Ort",
        ages: "Alter", dropOff: "Bringen", pickUp: "Abholen", tickets: "Plätze",
        total: "Bezahlter Betrag", perChild: "Details pro Kind", tripTickets: "Ausflugstickets",
        child: "Kind", children: "Kinder", noAddOns: "Keine Extras",
        clothing: "Kleidungsset", bottle: "Trinkflasche", meals: "Mahlzeiten",
        size: "Größe", outro: "Vielen Dank für Ihr Vertrauen. Wir sehen uns auf dem Platz!",
        addToCalendar: "Termin in Ihren Kalender eintragen",
        googleCalendar: "Zu Google Kalender hinzufügen",
        appleCalendar: "Für Apple Kalender oder Outlook öffnen Sie die angehängte Termindatei.",
        until: "bis",
        signOff: "Mit freundlichen Grüßen,", team: "Ihr Sports Evolution Team",
        goodToKnow: "Gut zu wissen",
        comingNext:
            "Eine Woche vor Campbeginn senden wir Ihnen eine E-Mail mit allen notwendigen Informationen.",
    },
    pt: {
        subject: (ref) => `Pagamento confirmado — ${ref}`,
        headline: "Reserva confirmada", sport: "Desporto", map: "Abrir no Google Maps",
        sports: { football: "Futebol", basketball: "Basquetebol", volleyball: "Voleibol" },
        hi: (n) => `Olá ${n},`,
        intro: "O seu pagamento foi recebido e a sua reserva está confirmada.",
        reference: "Referência da reserva", camp: "Campo", dates: "Datas", venue: "Local",
        ages: "Idades", dropOff: "Entrega", pickUp: "Recolha", tickets: "Lugares",
        total: "Total pago", perChild: "Detalhes por criança", tripTickets: "Bilhetes de excursão",
        child: "criança", children: "crianças", noAddOns: "Sem extras",
        clothing: "Conjunto de roupa", bottle: "Garrafa", meals: "Refeições",
        size: "tamanho", outro: "Obrigado pela sua confiança. Até breve no campo!",
        addToCalendar: "Adicione este campo ao seu calendário",
        googleCalendar: "Adicionar ao Google Calendar",
        appleCalendar: "Para o Calendário Apple ou Outlook, abra o ficheiro de convite em anexo.",
        until: "até",
        signOff: "Com os melhores cumprimentos,", team: "A sua equipa Sports Evolution",
        goodToKnow: "Bom saber",
        comingNext:
            "Enviaremos um e-mail com todas as informações necessárias uma semana antes do início do campo.",
    },
}

// ★ Same design as the camp-info email (send-camp-info.js): booking-form
// colours, one logo at the top, beige boxes, amber note.
const EMAIL = {
    page: "#F2EFEA", card: "#FBFAF8", box: "#F7F4EF", border: "#E6E0D8",
    text: "#12110F", muted: "#5E5B57", amberBg: "#FBF0DC", amberBorder: "#FADDA9",
    amberText: "#8A5C0A",
    font: "'IBM Plex Sans',Arial,Helvetica,sans-serif",
    head: "'Space Grotesk',Arial,Helvetica,sans-serif",
}
const EMAIL_ASSET_BASE = String(process.env.EMAIL_ASSET_BASE || process.env.URL || "").replace(/\/$/, "")
// The long one-line logo, shown once at the bottom of the email.
const EMAIL_LOGO_FILE = String(process.env.EMAIL_LOGO_FILE || "email/se-logo-long.png").replace(/^\//, "")

function emailLabel(text) {
    return `<p style="margin:0 0 8px;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;font-weight:bold;color:${EMAIL.text};">${esc(text)}</p>`
}

function emailRow(name, valueHtml, last) {
    const line = last ? "" : `border-bottom:1px solid ${EMAIL.border};`
    return `<tr><td style="padding:12px 16px;color:${EMAIL.muted};width:110px;vertical-align:top;${line}">${esc(name)}</td>` +
        `<td style="padding:12px 16px 12px 0;vertical-align:top;${line}">${valueHtml}</td></tr>`
}

function buildConfirmationHtml(matches, dropOffTime, pickUpTime, t, amountPaid, calendarEvent, metadata = {}) {
    const first = matches[0].data

    const orderTotal = isFinite(amountPaid)
        ? amountPaid.toFixed(2)
        : sumRowTotals(matches).toFixed(2)

    const participants = matches.filter(
        (m) => (m.data[COL.role] || ROLE_PARTICIPANT) === ROLE_PARTICIPANT
    )
    const joiners = matches.filter((m) => m.data[COL.role] === ROLE_JOINER)

    const childCards = participants
        .map(({ data }) => {
            const name = `${data[COL.firstName]} ${data[COL.lastName]}`.trim()
            const addOns = []
            const clothingQty = Number(data[COL.clothingQty]) || 0
            if (clothingQty > 0) {
                const size = data[COL.clothingSize]
                addOns.push(`${t.clothing} ×${clothingQty}${size ? ` (${t.size} ${size})` : ""}`)
            }
            const bottleQty = Number(data[COL.bottleQty]) || 0
            if (bottleQty > 0) addOns.push(`${t.bottle} ×${bottleQty}`)
            if (data[COL.meals] === "Yes") addOns.push(t.meals)
            const addOnsText = addOns.length ? addOns.join(" · ") : t.noAddOns
            return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${EMAIL.box};border:1px solid ${EMAIL.border};border-radius:4px;margin:0 0 10px;">` +
                `<tr><td style="padding:14px 16px;"><strong>${esc(name)}</strong><br>` +
                `<span style="color:${EMAIL.muted};font-size:14px;">${esc(addOnsText)}</span></td></tr></table>`
        })
        .join("")

    const joinerSection = joiners.length
        ? `<p style="margin:6px 0 0;color:${EMAIL.muted};font-size:14px;"><strong style="color:${EMAIL.text};">${esc(t.tripTickets)} (${joiners.length}):</strong> ` +
          `${esc(joiners.map(({ data }) => `${data[COL.firstName]} ${data[COL.lastName]}`.trim()).join(", "))}</p>`
        : ""

    const countWord = participants.length === 1 ? t.child : t.children
    const location = first[COL.venue] || venueFromCamp(first[COL.camp])
    const sportKey = String(metadata.sport || "").toLowerCase() ||
        (String(first[COL.camp] || "").match(/\(([^)]*)\)/) || [])[1] || ""
    const sportName = (t.sports && t.sports[String(sportKey).toLowerCase()]) || ""
    const address = String(metadata.venueAddress || "").trim()
    // Paragraph field: one line per address line; the map search gets them
    // joined with commas.
    const addressLines = address.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const venueHtml = addressLines.length
        ? `${addressLines.map(esc).join("<br>")}<br><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addressLines.join(", "))}" style="color:${EMAIL.text};font-weight:bold;">${esc(t.map)}</a>`
        : esc(location)

    const rows = [
        [t.reference, esc(first[COL.bookingReference])],
        [t.camp, `<strong>${esc(location)}</strong>`],
        ...(sportName ? [[t.sport, esc(sportName)]] : []),
        [t.dates, esc(first[COL.campDateRange])],
        [t.venue, venueHtml],
        ...(first[COL.ageRange] ? [[t.ages, esc(first[COL.ageRange])]] : []),
        ...(dropOffTime ? [[t.dropOff, esc(dropOffTime)]] : []),
        ...(pickUpTime ? [[t.pickUp, esc(`${t.until} ${pickUpTime}`)]] : []),
        [t.tickets, esc(`${participants.length} ${countWord}`)],
        [t.total, `<strong>€${esc(orderTotal)}</strong>`],
    ]
    const detailsHtml = rows.map(([k, v], i) => emailRow(k, v, i === rows.length - 1)).join("")

    // ★ Google link inline; Apple/Outlook use the attached .ics.
    const calendarSection = calendarEvent
        ? `<tr><td style="padding:28px 28px 0;">${emailLabel(t.addToCalendar)}
<a href="${esc(googleCalendarUrl(calendarEvent))}" style="display:inline-block;padding:10px 18px;border:1px solid ${EMAIL.border};background:${EMAIL.box};border-radius:999px;color:${EMAIL.text};text-decoration:none;font-weight:bold;">${esc(t.googleCalendar)}</a>
<p style="margin:8px 0 0;color:${EMAIL.muted};font-size:13px;">${esc(t.appleCalendar)}</p>
</td></tr>`
        : ""

    const logo = EMAIL_ASSET_BASE
        ? `<img src="${esc(EMAIL_ASSET_BASE)}/${esc(EMAIL_LOGO_FILE)}" width="200" height="15" alt="Sports Evolution" style="display:block;border:0;width:200px;height:auto;margin-top:24px;">`
        : ""

    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:${EMAIL.page};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${EMAIL.page};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${EMAIL.card};border:1px solid ${EMAIL.border};border-radius:4px;font-family:${EMAIL.font};color:${EMAIL.text};font-size:15px;line-height:1.55;">
<tr><td style="padding:28px 28px 0;">
<p style="margin:0 0 14px;">${esc(t.hi(first[COL.parentName] || ""))}</p>
<h1 style="margin:0 0 10px;font-family:${EMAIL.head};font-size:28px;line-height:1.2;font-weight:bold;letter-spacing:-0.01em;color:${EMAIL.text};">${esc(t.headline)}</h1>
<p style="margin:0;color:${EMAIL.muted};">${esc(t.intro)}</p>
</td></tr>
<tr><td style="padding:28px 28px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${EMAIL.box};border:1px solid ${EMAIL.border};border-radius:4px;font-size:15px;">${detailsHtml}</table>
</td></tr>
<tr><td style="padding:28px 28px 0;">${emailLabel(t.perChild)}${childCards}${joinerSection}</td></tr>
${calendarSection}
<tr><td style="padding:24px 28px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${EMAIL.amberBg};border:1px solid ${EMAIL.amberBorder};border-radius:4px;"><tr><td style="padding:12px 16px;font-size:14px;color:${EMAIL.amberText};">
<strong>${esc(t.goodToKnow)}:</strong> ${esc(t.comingNext)}
</td></tr></table>
</td></tr>
<tr><td style="padding:24px 28px 28px;">
<p style="margin:0 0 16px;">${esc(t.outro)}</p>
<p style="margin:0;">${esc(t.signOff)}<br><strong>${esc(t.team)}</strong></p>
${logo}
</td></tr>
</table>
</td></tr></table>
</body></html>`
}

async function sendEmail(to, subject, html, calendarEvent, options = {}) {
    if (!process.env.RESEND_API_KEY) {
        throw new Error("RESEND_API_KEY is not set — refusing to send with an empty token")
    }

    const body = {
        from: process.env.RESEND_FROM || "Sports Evolution <info@order.sportsevolution.lu>",
        to,
        subject,
        html,
    }
    if (options.replyTo) body.reply_to = options.replyTo
    else if (process.env.RESEND_REPLY_TO) body.reply_to = process.env.RESEND_REPLY_TO
    if (process.env.RESEND_BCC && !options.skipBcc) body.bcc = process.env.RESEND_BCC

    // ★ The .ics invite travels with the email. Apple Mail, Outlook and Gmail
    // all show an "add to calendar" control when they see one attached.
    if (calendarEvent) {
        body.attachments = [
            {
                filename: `${calendarEvent.reference || "camp"}.ics`,
                content: Buffer.from(buildIcs(calendarEvent), "utf8").toString("base64"),
            },
        ]
    }

    const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    })

    // fetch() does not throw on 4xx/5xx — read the body so the real reason
    // (bad key, unverified domain, bad recipient) reaches the logs.
    const resText = await res.text()
    if (!res.ok) {
        throw new Error(`Resend rejected the email — status ${res.status}: ${resText}`)
    }
    return resText
}

// Used by send-test-emails.js (same templates as the real emails).
exports._internal = { buildConfirmationHtml, buildCalendarEvent, sendEmail, T, COL }
