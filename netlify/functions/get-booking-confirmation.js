// netlify/functions/get-booking-confirmation.js
//
// Self-contained on purpose: no shared module to misplace.
// GET /api/get-booking-confirmation?session_id=cs_...
//
// Called by Confirmation_page.tsx after Stripe redirects back.
// Only returns data once Stripe confirms the session was paid.

const { google } = require("googleapis")
const Stripe = require("stripe")

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

const COL = {
    bookingId: 0, createdAt: 1, camp: 2, firstName: 3, lastName: 4, dob: 5,
    club: 6, allergies: 7, clothingQty: 8, clothingSize: 9, bottleQty: 10,
    meals: 11, parentName: 12, email: 13, phone: 14, bookingTotal: 15,
    status: 16, language: 17, role: 18,
    venue: 19, campDateRange: 20, ageRange: 21,
    bookingReference: 22, startDate: 23, endDate: 24,
}
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Bookings"
const DATA_RANGE = `${SHEET_TAB}!A:Y`

const ROLE_PARTICIPANT = "Participant"
const ROLE_JOINER = "Joiner"

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}

function json(statusCode, body) {
    return {
        statusCode,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        body: JSON.stringify(body),
    }
}

function toNumber(value, fallback = 0) {
    const n = Number(String(value).replace(",", "."))
    return isFinite(n) ? n : fallback
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

async function findBookingRows(sheets, bookingId) {
    const result = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: DATA_RANGE,
    })
    const rows = result.data.values || []
    return rows.filter((row) => row[COL.bookingId] === bookingId)
}

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" }
    }
    if (event.httpMethod !== "GET") {
        return json(405, { error: "Method not allowed" })
    }

    const { session_id } = event.queryStringParameters || {}
    if (!session_id) return json(400, { error: "Missing session_id" })

    try {
        const session = await stripe.checkout.sessions.retrieve(session_id)

        if (session.payment_status !== "paid") {
            return json(402, { error: "Payment not completed for this session" })
        }

        const bookingId = session.metadata && session.metadata.bookingId
        if (!bookingId) return json(404, { error: "No booking found" })

        const sheets = await getSheet()
        const rows = await findBookingRows(sheets, bookingId)
        if (!rows.length) return json(404, { error: "No booking found" })

        const first = rows[0]
        const participantRows = rows.filter(
            (r) => (r[COL.role] || ROLE_PARTICIPANT) === ROLE_PARTICIPANT
        )
        const joinerRows = rows.filter((r) => r[COL.role] === ROLE_JOINER)

        // Column P is per person now, so the order total is the sum of the
        // rows — or Stripe's charged amount, which is authoritative.
        const rowSum =
            rows.reduce(
                (acc, r) => acc + Math.round(toNumber(r[COL.bookingTotal], 0) * 100),
                0
            ) / 100

        return json(200, {
            bookingReference: first[COL.bookingReference],
            status: first[COL.status],
            language: first[COL.language] || "en",
            parentName: first[COL.parentName],
            email: first[COL.email],
            camp: first[COL.camp],
            venue: first[COL.venue],
            dateRange: first[COL.campDateRange],
            startDate: first[COL.startDate],
            endDate: first[COL.endDate],
            ageRange: first[COL.ageRange],
            dropOffTime: (session.metadata && session.metadata.dropOffTime) || "",
            pickUpTime: (session.metadata && session.metadata.pickUpTime) || "",
            // Used to build the "add to calendar" links.
            campStartISO: (session.metadata && session.metadata.campStartISO) || "",
            campEndISO: (session.metadata && session.metadata.campEndISO) || "",
            total:
                typeof session.amount_total === "number"
                    ? session.amount_total / 100
                    : rowSum,
            children: participantRows.map((row) => ({
                firstName: row[COL.firstName],
                lastName: row[COL.lastName],
                price: toNumber(row[COL.bookingTotal], 0),
                clothingQty: Number(row[COL.clothingQty]) || 0,
                clothingSize: row[COL.clothingSize] || "",
                bottleQty: Number(row[COL.bottleQty]) || 0,
                meals: row[COL.meals] === "Yes",
            })),
            tripGuests: joinerRows.map((row) => ({
                firstName: row[COL.firstName],
                lastName: row[COL.lastName],
                price: toNumber(row[COL.bookingTotal], 0),
            })),
        })
    } catch (err) {
        console.error("[get-booking-confirmation] failed:", err)
        return json(500, {
            error: "Could not retrieve booking",
            message: err && err.message,
        })
    }
}
