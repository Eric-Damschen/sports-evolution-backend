// netlify/functions/camp-availability.js
// Called by the Framer form on page load to find out how many spots are
// left. GET /api/camp-availability?camp=Rodange%20(football)&capacity=48
//
// Same env vars as create-booking.js (Google service account + sheet ID).

const { google } = require("googleapis")

// ★ Must match create-booking.js and stripe-webhook.js exactly — one row = one child.
const COL = {
    bookingId: 0, createdAt: 1, camp: 2, firstName: 3, lastName: 4, dob: 5,
    club: 6, allergies: 7, clothingQty: 8, clothingSize: 9, bottleQty: 10,
    meals: 11, parentName: 12, email: 13, phone: 14, bookingTotal: 15,
    status: 16, language: 17,
}
const LAST_COLUMN = "R"

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

// ★ Identical to the copy in create-booking.js — keep both in sync if you edit this.
async function countBookedSpots(sheets, camp) {
    const result = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: `Bookings!A:${LAST_COLUMN}`,
    })
    const rows = result.data.values || []
    let booked = 0
    for (const row of rows) {
        const rowCamp = row[COL.camp]
        const status = row[COL.status]
        if (rowCamp === camp && (status === "pending" || status === "paid")) {
            booked += 1
        }
    }
    return booked
}

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" }
    }
    if (event.httpMethod !== "GET") {
        return {
            statusCode: 405,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "Method not allowed" }),
        }
    }

    const { camp, capacity } = event.queryStringParameters || {}
    if (!camp || !capacity) {
        return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "Missing camp or capacity query param" }),
        }
    }

    try {
        const sheets = await getSheet()
        const booked = await countBookedSpots(sheets, camp)
        const remaining = Math.max(0, Number(capacity) - booked)
        return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({ capacity: Number(capacity), booked, remaining }),
        }
    } catch (err) {
        console.error(err)
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "Could not check availability" }),
        }
    }
}
