// netlify/functions/camp-availability.js
//
// Self-contained on purpose: no shared module to misplace.
// GET /api/camp-availability?camp=NAME&capacity=48&tripCapacity=20
//
// Called by BOTH Booking_form.tsx and Trip_Booking_form.tsx on page load.
// Response keys are unchanged: { capacity, booked, remaining } plus
// { tripCapacity, tripBooked, tripRemaining } when tripCapacity is sent.

const { google } = require("googleapis")

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

const PENDING_HOLD_MINUTES = Number(process.env.PENDING_HOLD_MINUTES || 30)

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}

function json(statusCode, body, extraHeaders) {
    return {
        statusCode,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            ...CORS_HEADERS,
            ...(extraHeaders || {}),
        },
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

function holdsASeat(row) {
    const status = String(row[COL.status] || "").trim().toLowerCase()
    if (status === "paid") return true
    if (status === "partially refunded") return true
    if (status !== "pending") return false

    const created = Date.parse(row[COL.createdAt])
    if (isNaN(created)) return true
    return Date.now() - created < PENDING_HOLD_MINUTES * 60 * 1000
}

async function countBookedSpots(sheets, camp, role) {
    const result = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: DATA_RANGE,
    })
    const rows = result.data.values || []
    const want = String(camp || "").trim().toLowerCase()
    let count = 0

    for (const row of rows) {
        if (String(row[COL.camp] || "").trim().toLowerCase() !== want) continue
        if (!holdsASeat(row)) continue
        if ((row[COL.role] || ROLE_PARTICIPANT) === role) count += 1
    }
    return count
}

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" }
    }
    if (event.httpMethod !== "GET") {
        return json(405, { error: "Method not allowed" })
    }

    const { camp, capacity, tripCapacity } = event.queryStringParameters || {}
    if (!camp || !capacity) {
        return json(400, { error: "Missing camp or capacity query param" })
    }

    try {
        const sheets = await getSheet()

        const booked = await countBookedSpots(sheets, camp, ROLE_PARTICIPANT)
        const remaining = Math.max(0, Number(capacity) - booked)
        const body = { capacity: Number(capacity), booked, remaining }

        if (tripCapacity) {
            const tripBooked = await countBookedSpots(sheets, camp, ROLE_JOINER)
            body.tripCapacity = Number(tripCapacity)
            body.tripBooked = tripBooked
            body.tripRemaining = Math.max(0, Number(tripCapacity) - tripBooked)
        }

        return json(200, body)
    } catch (err) {
        console.error("[camp-availability] failed:", err)
        return json(500, {
            error: "Could not check availability",
            message: err && err.message,
        })
    }
}
