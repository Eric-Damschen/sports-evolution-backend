// /api/camp-availability.js
// Called by BOTH BookingForm.tsx and TripBookingForm.tsx on page load.
// GET /api/camp-availability?camp=Rodange%20(football)&capacity=48
// TripBookingForm additionally passes &tripCapacity=20.
//
// ★ Column layout matches the actual live Sheet: Role sits at column S
// (index 18), right after Language — not at the end.

const { google } = require("googleapis")

const COL = {
    bookingId: 0, createdAt: 1, camp: 2, firstName: 3, lastName: 4, dob: 5,
    club: 6, allergies: 7, clothingQty: 8, clothingSize: 9, bottleQty: 10,
    meals: 11, parentName: 12, email: 13, phone: 14, bookingTotal: 15,
    status: 16, language: 17, role: 18,
    venue: 19, campDateRange: 20, ageRange: 21, dropOffTime: 22, pickUpTime: 23,
    bookingReference: 24, startDate: 25, endDate: 26,
}
const LAST_COLUMN = "AA"

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

async function countBookedSpots(sheets, camp, role) {
    const result = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: `Bookings!A:${LAST_COLUMN}`,
    })
    const rows = result.data.values || []
    let count = 0
    for (const row of rows) {
        const rowCamp = row[COL.camp]
        const status = row[COL.status]
        const rowRole = row[COL.role] || "Participant"
        if (rowCamp === camp && (status === "pending" || status === "paid") && rowRole === role) {
            count += 1
        }
    }
    return count
}

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" }
    }
    if (event.httpMethod !== "GET") {
        return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: "Method not allowed" }) }
    }

    const { camp, capacity, tripCapacity } = event.queryStringParameters || {}
    if (!camp || !capacity) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "Missing camp or capacity query param" }) }
    }

    try {
        const sheets = await getSheet()

        const booked = await countBookedSpots(sheets, camp, "Participant")
        const remaining = Math.max(0, Number(capacity) - booked)
        const responseBody = { capacity: Number(capacity), booked, remaining }

        if (tripCapacity) {
            const tripBooked = await countBookedSpots(sheets, camp, "Joiner")
            const tripRemaining = Math.max(0, Number(tripCapacity) - tripBooked)
            responseBody.tripCapacity = Number(tripCapacity)
            responseBody.tripBooked = tripBooked
            responseBody.tripRemaining = tripRemaining
        }

        return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(responseBody) }
    } catch (err) {
        console.error(err)
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: "Could not check availability" }) }
    }
}
