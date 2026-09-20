// /api/get-booking-confirmation.js
// Called by the confirmation page after Stripe redirects there.
//
// ★ Column layout matches the live Sheet. Drop-off/pick-up time come from
// the Stripe session's own metadata, not the Sheet — see create-booking.js.
//
// Security: only returns data once Stripe confirms the session was paid.

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
const LAST_COLUMN = "Y"

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
}

async function getSheet() {
    const auth = new google.auth.JWT(
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        null,
        process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, "\n"),
        ["https://www.googleapis.com/auth/spreadsheets"]
    )
    return google.sheets({ version: "v4", auth })
}

async function findBookingRows(sheets, bookingId) {
    const result = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: `Bookings!A:${LAST_COLUMN}`,
    })
    const rows = result.data.values || []
    return rows.filter((row) => row[COL.bookingId] === bookingId)
}

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" }
    }
    if (event.httpMethod !== "GET") {
        return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: "Method not allowed" }) }
    }

    const { session_id } = event.queryStringParameters || {}
    if (!session_id) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "Missing session_id" }) }
    }

    try {
        const session = await stripe.checkout.sessions.retrieve(session_id)
        if (session.payment_status !== "paid") {
            return { statusCode: 402, headers: CORS_HEADERS, body: JSON.stringify({ error: "Payment not completed for this session" }) }
        }

        const bookingId = session.metadata?.bookingId
        if (!bookingId) {
            return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: "No booking found" }) }
        }

        const sheets = await getSheet()
        const rows = await findBookingRows(sheets, bookingId)
        if (rows.length === 0) {
            return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: "No booking found" }) }
        }

        const first = rows[0]
        const participantRows = rows.filter((r) => (r[COL.role] || "Participant") === "Participant")
        const joinerRows = rows.filter((r) => r[COL.role] === "Joiner")

        return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                bookingReference: first[COL.bookingReference],
                parentName: first[COL.parentName],
                email: first[COL.email],
                camp: first[COL.camp],
                venue: first[COL.venue],
                dateRange: first[COL.campDateRange],
                startDate: first[COL.startDate],
                endDate: first[COL.endDate],
                ageRange: first[COL.ageRange],
                dropOffTime: session.metadata?.dropOffTime || "",
                pickUpTime: session.metadata?.pickUpTime || "",
                total: first[COL.bookingTotal],
                children: participantRows.map((row) => ({
                    firstName: row[COL.firstName],
                    lastName: row[COL.lastName],
                })),
                tripGuests: joinerRows.map((row) => ({
                    firstName: row[COL.firstName],
                    lastName: row[COL.lastName],
                })),
            }),
        }
    } catch (err) {
        console.error(err)
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: "Could not retrieve booking" }) }
    }
}
