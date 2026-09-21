// netlify/functions/create-booking.js
//
// Self-contained on purpose: no shared module to misplace.
// Shared by BOTH Booking_form.tsx and Trip_Booking_form.tsx.
//
// 1. Checks capacity (camp and trip, independently)
// 2. Writes one "pending" row per child and per trip guest
// 3. Re-reads to confirm nobody else took the last spot first
// 4. Creates the Stripe Checkout Session
//
// No email is sent here — only stripe-webhook.js emails the customer.

const { google } = require("googleapis")
const Stripe = require("stripe")
const { randomUUID } = require("crypto")

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

/* ---------------- Sheet layout (A..Y) ---------------- */

const COL = {
    bookingId: 0, createdAt: 1, camp: 2, firstName: 3, lastName: 4, dob: 5,
    club: 6, allergies: 7, clothingQty: 8, clothingSize: 9, bottleQty: 10,
    meals: 11, parentName: 12, email: 13, phone: 14, bookingTotal: 15,
    status: 16, language: 17, role: 18,
    venue: 19, campDateRange: 20, ageRange: 21,
    bookingReference: 22, startDate: 23, endDate: 24,
    position: 25,
}
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Bookings"
// Z = Position. Add the header "Position" in Z1 of the Sheet.
const LAST_COLUMN = "Z"
const DATA_RANGE = `${SHEET_TAB}!A:${LAST_COLUMN}`
const STATUS_COLUMN_LETTER = "Q"

const ROLE_PARTICIPANT = "Participant"
const ROLE_JOINER = "Joiner"

// How long a checkout holds the seat.
const PENDING_HOLD_MINUTES = Number(process.env.PENDING_HOLD_MINUTES || 30)

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}

function json(statusCode, body) {
    return {
        statusCode,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        body: JSON.stringify(body),
    }
}

/* ---------------- Google Sheets ---------------- */

async function getSheet() {
    const auth = new google.auth.JWT(
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        null,
        (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
        ["https://www.googleapis.com/auth/spreadsheets"]
    )
    return google.sheets({ version: "v4", auth })
}

// Every row, with its real sheet row number (row 1 is the header).
async function getAllRows(sheets) {
    const result = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: DATA_RANGE,
    })
    const rows = result.data.values || []
    return rows.map((data, i) => ({ rowNumber: i + 1, data }))
}

/* ---------------- Capacity ---------------- */

// A partial refund keeps the seat; a full refund, an expired checkout or a
// lost race all give it back.
function holdsASeat(row) {
    const status = String(row[COL.status] || "").trim().toLowerCase()
    if (status === "paid") return true
    if (status === "partially refunded") return true
    if (status !== "pending") return false

    const created = Date.parse(row[COL.createdAt])
    if (isNaN(created)) return true
    return Date.now() - created < PENDING_HOLD_MINUTES * 60 * 1000
}

// beforeRowNumber counts only rows ABOVE it — seats claimed before ours landed.
function countBookedSpots(allRows, camp, role, beforeRowNumber) {
    const want = String(camp || "").trim().toLowerCase()
    const limit = typeof beforeRowNumber === "number" ? beforeRowNumber : Infinity
    let count = 0

    for (const { rowNumber, data } of allRows) {
        if (rowNumber >= limit) continue
        if (String(data[COL.camp] || "").trim().toLowerCase() !== want) continue
        if (!holdsASeat(data)) continue
        if ((data[COL.role] || ROLE_PARTICIPANT) === role) count += 1
    }
    return count
}

/* ---------------- Helpers ---------------- */

function toNumber(value, fallback = 0) {
    const n = Number(String(value).replace(",", "."))
    return isFinite(n) ? n : fallback
}

const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

function makeBookingReference(allRows) {
    const year = new Date().getFullYear()
    const taken = new Set(
        allRows.map((r) => String(r.data[COL.bookingReference] || "").trim())
    )
    for (let attempt = 0; attempt < 10; attempt += 1) {
        let suffix = ""
        for (let i = 0; i < 5; i += 1) {
            suffix += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)]
        }
        const ref = `SE-${year}-${suffix}`
        if (!taken.has(ref)) return ref
    }
    return `SE-${year}-${Date.now().toString(36).toUpperCase()}`
}

// Column P holds each person's own price. Works in integer cents and puts any
// rounding remainder on the first row, so the column sums to exactly what
// Stripe charged.
function allocatePersonAmounts(people, orderTotal) {
    const targetCents = Math.round(toNumber(orderTotal, 0) * 100)
    if (!people.length) return []

    const provided = people.map((p) => toNumber(p && p.lineTotal, NaN))
    const allProvided = provided.every((n) => isFinite(n) && n >= 0)

    let cents
    if (allProvided) {
        cents = provided.map((n) => Math.round(n * 100))
    } else {
        const even = Math.floor(targetCents / people.length)
        cents = people.map(() => even)
    }

    cents[0] += targetCents - cents.reduce((a, b) => a + b, 0)
    return cents.map((c) => c / 100)
}

// ★ New rows are inserted with INSERT_ROWS, and Google Sheets gives an
// inserted row the formatting of the row above it — so the first booking
// under the header copied its blue fill and bold text, and every booking
// after copied that. This resets a booking's own rows to plain white.
// Only fill, bold and text colour are touched: number or date formats you
// set on a column are kept.
async function resetRowFormatting(sheets, rowNumbers) {
    if (!rowNumbers.length) return

    const meta = await sheets.spreadsheets.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        fields: "sheets.properties(sheetId,title)",
    })
    const tab = (meta.data.sheets || []).find((t) => t.properties.title === SHEET_TAB)
    if (!tab) return

    const first = Math.min(...rowNumbers)
    const last = Math.max(...rowNumbers)

    await sheets.spreadsheets.batchUpdate({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        requestBody: {
            requests: [
                {
                    repeatCell: {
                        range: {
                            sheetId: tab.properties.sheetId,
                            startRowIndex: first - 1, // 0-based
                            endRowIndex: last,        // exclusive
                        },
                        cell: {
                            userEnteredFormat: {
                                backgroundColor: { red: 1, green: 1, blue: 1 },
                                textFormat: {
                                    bold: false,
                                    foregroundColor: { red: 0, green: 0, blue: 0 },
                                },
                            },
                        },
                        fields:
                            "userEnteredFormat(backgroundColor,textFormat(bold,foregroundColor))",
                    },
                },
            ],
        },
    })
}

async function setStatusForRows(sheets, rowNumbers, status) {
    if (!rowNumbers.length) return 0
    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        requestBody: {
            valueInputOption: "RAW",
            data: rowNumbers.map((rowNumber) => ({
                range: `${SHEET_TAB}!${STATUS_COLUMN_LETTER}${rowNumber}`,
                values: [[status]],
            })),
        },
    })
    return rowNumbers.length
}

/* ---------------- Handler ---------------- */

const MAX_TOTAL_EUR = toNumber(process.env.MAX_BOOKING_TOTAL_EUR, 5000)
const CONFIRMATION_PATH = process.env.CONFIRMATION_PATH || "/confirmation-page"

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" }
    }
    if (event.httpMethod !== "POST") {
        return json(405, { error: "Method not allowed" })
    }

    try {
        const {
            camp, campTitle, location, dateRange, startDate, endDate, ageRange,
            dropOffTime, pickUpTime, children, tripGuests, contact, total,
            addOnsIncluded, totalSpots, tripTotalSpots, language,
            campStartISO, campEndISO,
        } = JSON.parse(event.body || "{}")

        if (!camp || !Array.isArray(children) || children.length === 0 || !contact) {
            return json(400, { error: "Missing camp, children, or contact details" })
        }
        if (!contact.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(contact.email))) {
            return json(400, { error: "A valid contact email is required" })
        }

        const amount = toNumber(total, NaN)
        if (!isFinite(amount) || amount <= 0 || amount > MAX_TOTAL_EUR) {
            return json(400, { error: "Invalid booking total" })
        }

        const guests = Array.isArray(tripGuests) ? tripGuests : []
        const bookingId = randomUUID()
        const sheets = await getSheet()
        const allRows = await getAllRows(sheets)

        /* --- 1. Early capacity check (friendly, not the real guard) --- */

        if (totalSpots) {
            const remaining =
                Number(totalSpots) - countBookedSpots(allRows, camp, ROLE_PARTICIPANT)
            if (children.length > remaining) {
                return json(409, {
                    error: "notEnoughSpots",
                    remaining: Math.max(0, remaining),
                })
            }
        }
        if (tripTotalSpots && guests.length > 0) {
            const remaining =
                Number(tripTotalSpots) - countBookedSpots(allRows, camp, ROLE_JOINER)
            if (guests.length > remaining) {
                return json(409, {
                    error: "notEnoughTripSpots",
                    remaining: Math.max(0, remaining),
                })
            }
        }

        /* --- 2. Build the rows --- */

        const bookingReference = makeBookingReference(allRows)
        const createdAt = new Date().toISOString()

        // Add-ons past their deadline are not charged, so they must not be
        // recorded either.
        const addOnsCount = addOnsIncluded !== false

        const personAmounts = allocatePersonAmounts([...children, ...guests], amount)
        const childAmounts = personAmounts.slice(0, children.length)
        const guestAmounts = personAmounts.slice(children.length)

        const participantRows = children.map((child, i) => [
            bookingId, createdAt, camp,
            child.firstName || "", child.lastName || "", child.dob || "",
            child.club || "", child.allergies || "",
            (addOnsCount && child.addOns && child.addOns.clothingQty) || 0,
            (addOnsCount && child.addOns && child.addOns.clothingSize) || "",
            (addOnsCount && child.addOns && child.addOns.bottleQty) || 0,
            addOnsCount && child.addOns && child.addOns.meals ? "Yes" : "No",
            contact.parentName || "", contact.email || "", contact.phone || "",
            childAmounts[i], "pending", language || "en",
            ROLE_PARTICIPANT,
            location || "", dateRange || "", ageRange || "",
            bookingReference, startDate || "", endDate || "",
            child.position || "",
        ])

        const joinerRows = guests.map((guest, i) => [
            bookingId, createdAt, camp,
            guest.firstName || "", guest.lastName || "", "",
            "", "",
            0, "", 0, "No",
            contact.parentName || "", contact.email || "", contact.phone || "",
            guestAmounts[i], "pending", language || "en",
            ROLE_JOINER,
            location || "", dateRange || "", ageRange || "",
            bookingReference, startDate || "", endDate || "",
            "",
        ])

        /* --- 3. Claim the seats, then verify we won the race --- */
        // Sheets has no locks. Write first, then re-read: if someone else's
        // rows landed above ours, we lost, release ours and return 409.
        // Append assigns row numbers in order, so exactly one request wins.

        const appendRes = await sheets.spreadsheets.values.append({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
            range: DATA_RANGE,
            valueInputOption: "RAW", // not USER_ENTERED: "+352..." must stay text
            insertDataOption: "INSERT_ROWS",
            requestBody: { values: [...participantRows, ...joinerRows] },
        })

        const updatedRange =
            (appendRes.data && appendRes.data.updates && appendRes.data.updates.updatedRange) || ""

        // ★ Our rows are found by Booking ID, never by the row numbers the
        // append reported. The cleanup job deletes abandoned rows, which moves
        // every row beneath them up — a row number from a second ago may
        // already point at someone else's booking.
        function findOurRows(rows) {
            return rows
                .filter((r) => r.data[COL.bookingId] === bookingId)
                .map((r) => r.rowNumber)
        }

        async function releaseSeats() {
            try {
                const fresh = await getAllRows(sheets)
                await setStatusForRows(sheets, findOurRows(fresh), "released")
            } catch (e) {
                console.error("[create-booking] could not release rows:", e.message)
            }
        }

        const afterRows = await getAllRows(sheets)
        const ourRowNumbers = findOurRows(afterRows)
        const firstRow = ourRowNumbers.length ? Math.min(...ourRowNumbers) : null

        if (firstRow !== null) {

            if (totalSpots) {
                const takenBefore = countBookedSpots(afterRows, camp, ROLE_PARTICIPANT, firstRow)
                const remaining = Number(totalSpots) - takenBefore
                if (children.length > remaining) {
                    await releaseSeats()
                    console.log(`[create-booking] lost camp race for "${camp}" at row ${firstRow}`)
                    return json(409, {
                        error: "notEnoughSpots",
                        remaining: Math.max(0, remaining),
                    })
                }
            }

            if (tripTotalSpots && guests.length > 0) {
                const takenBefore = countBookedSpots(afterRows, camp, ROLE_JOINER, firstRow)
                const remaining = Number(tripTotalSpots) - takenBefore
                if (guests.length > remaining) {
                    await releaseSeats()
                    console.log(`[create-booking] lost trip race for "${camp}" at row ${firstRow}`)
                    return json(409, {
                        error: "notEnoughTripSpots",
                        remaining: Math.max(0, remaining),
                    })
                }
            }
        } else {
            console.error(
                `[create-booking] booking ${bookingId} not found after append ` +
                `(range "${updatedRange}") — capacity verified only before the write`
            )
        }

        // Purely cosmetic, so it never blocks or fails the booking. Runs in
        // parallel with the Stripe call below. The cleanup job never deletes
        // rows younger than 2 minutes, so these row numbers can't shift.
        const formatting = resetRowFormatting(sheets, ourRowNumbers).catch((e) =>
            console.error("[create-booking] could not reset row formatting:", e.message)
        )

        /* --- 4. Stripe Checkout --- */

        const siteUrl = (process.env.SITE_URL || "https://www.sportsevolution.lu").replace(/\/$/, "")

        // Stripe rejects expires_at unless it is MORE than 30 minutes ahead,
        // so a plain 30-minute hold fails by a fraction of a second. One extra
        // minute of slack keeps it valid.
        const expiryMinutes = Math.max(PENDING_HOLD_MINUTES, 31)
        const expiresAt = Math.floor(Date.now() / 1000) + expiryMinutes * 60

        const metadata = {
            bookingId,
            bookingReference,
            dropOffTime: dropOffTime || "",
            pickUpTime: pickUpTime || "",
            // ISO dates (YYYY-MM-DD) ride along so the confirmation email and
            // page can build "add to calendar" links without re-parsing a
            // human date like "20 October 2026".
            campStartISO: campStartISO || "",
            campEndISO: campEndISO || "",
        }

        let session
        try {
            session = await stripe.checkout.sessions.create({
                mode: "payment",
                // Cards only. Setting this explicitly overrides whatever is
                // switched on in the Stripe Dashboard, so Bancontact, iDEAL,
                // SEPA and the rest never appear at checkout.
                payment_method_types: ["card"],
                customer_email: contact.email,
                client_reference_id: bookingReference,
                expires_at: expiresAt,
                line_items: [
                    {
                        price_data: {
                            currency: "eur",
                            product_data: { name: `${camp} — ${bookingReference}` },
                            unit_amount: Math.round(amount * 100),
                        },
                        quantity: 1,
                    },
                ],
                metadata,
                // Refunds arrive as charge events, so the PaymentIntent needs
                // the booking id too.
                payment_intent_data: {
                    metadata: { bookingId, bookingReference },
                },
                success_url: `${siteUrl}${CONFIRMATION_PATH}?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: siteUrl,
                locale: "auto",
            })
        } catch (stripeErr) {
            // Seats are already claimed — hand them straight back.
            await releaseSeats()
            throw stripeErr
        }

        console.log(
            `[create-booking] ${bookingReference} — "${camp}", ` +
            `${participantRows.length} participant(s), ${joinerRows.length} joiner(s), ` +
            `€${amount}, session ${session.id}`
        )

        await formatting

        return json(200, { checkoutUrl: session.url, bookingReference })
    } catch (err) {
        // The message is returned as well as logged, so a failing booking can
        // be diagnosed from the browser console during setup.
        console.error("[create-booking] failed:", err)
        return json(500, {
            error: "Could not create booking",
            message: err && err.message,
        })
    }
}
