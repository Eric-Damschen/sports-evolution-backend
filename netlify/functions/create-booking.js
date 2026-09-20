// /api/create-booking.js
// Shared by BOTH BookingForm.tsx and TripBookingForm.tsx.
//
// ★ Column layout matches the ACTUAL live Sheet exactly: A–S is the
// original columns with Role at S (right after Language), and T–AA are the
// confirmation-page fields appended afterward. This was deliberately kept
// in this order — not the order originally planned — to match columns
// already in use rather than move anything around.
//
// 1. Re-checks capacity — camp spots against "totalSpots", trip spots
//    against "tripTotalSpots" (only if trip guests were sent)
// 2. Generates a short, human-friendly booking reference (e.g. SE-2026-A3F2)
// 3. Writes one row per PARTICIPANT (child) and one row per trip GUEST,
//    all sharing the same Booking ID — the "Role" column tells them apart
// 4. Creates a Stripe Checkout Session for the submitted total
//
// No email is sent from here — only stripe-webhook.js emails the customer.

const { google } = require("googleapis")
const Stripe = require("stripe")
const { randomUUID } = require("crypto")

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

// ★ Bookings tab column layout — shared with camp-availability.js,
// stripe-webhook.js, and get-booking-confirmation.js — keep all four in
// sync if you ever add/reorder a column.
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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
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

// ★ Counts booked spots for a camp, filtered by role. A blank role (rows
// written before this feature existed) is treated as "Participant".
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

function makeBookingReference(bookingId) {
    const year = new Date().getFullYear()
    const short = bookingId.replace(/-/g, "").slice(0, 4).toUpperCase()
    return `SE-${year}-${short}`
}

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" }
    }
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: "Method not allowed" }) }
    }

    try {
        const {
            camp, campTitle, location, dateRange, startDate, endDate, ageRange,
            dropOffTime, pickUpTime, children, tripGuests, contact, total,
            totalSpots, tripTotalSpots, language,
        } = JSON.parse(event.body)

        if (!camp || !Array.isArray(children) || children.length === 0 || !contact) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "Missing camp, children, or contact details" }),
            }
        }

        const guests = Array.isArray(tripGuests) ? tripGuests : []
        const bookingId = randomUUID()
        const bookingReference = makeBookingReference(bookingId)
        const sheets = await getSheet()

        // --- 1. Capacity checks — camp spots, and trip spots if requested ----------
        if (totalSpots) {
            const bookedParticipants = await countBookedSpots(sheets, camp, "Participant")
            const remaining = Number(totalSpots) - bookedParticipants
            if (children.length > remaining) {
                return {
                    statusCode: 409,
                    headers: CORS_HEADERS,
                    body: JSON.stringify({ error: "notEnoughSpots", remaining: Math.max(0, remaining) }),
                }
            }
        }
        if (tripTotalSpots && guests.length > 0) {
            const bookedJoiners = await countBookedSpots(sheets, camp, "Joiner")
            const tripRemaining = Number(tripTotalSpots) - bookedJoiners
            if (guests.length > tripRemaining) {
                return {
                    statusCode: 409,
                    headers: CORS_HEADERS,
                    body: JSON.stringify({ error: "notEnoughTripSpots", remaining: Math.max(0, tripRemaining) }),
                }
            }
        }

        // --- 2. Write one row per PARTICIPANT and one row per trip GUEST ----------
        // ★ Column order here MUST exactly match COL above: A..S then T..AA.
        const createdAt = new Date().toISOString()

        const participantRows = children.map((child) => [
            bookingId, createdAt, camp,                                  // A B C
            child.firstName, child.lastName, child.dob,                  // D E F
            child.club || "", child.allergies || "",                     // G H
            child.addOns?.clothingQty || 0, child.addOns?.clothingSize || "", // I J
            child.addOns?.bottleQty || 0, child.addOns?.meals ? "Yes" : "No", // K L
            contact.parentName, contact.email, contact.phone,            // M N O
            total, "pending", language || "en",                          // P Q R
            "Participant",                                                // S (role)
            location || "", dateRange || "", ageRange || "",              // T U V
            dropOffTime || "", pickUpTime || "", bookingReference,        // W X Y
            startDate || "", endDate || "",                                // Z AA
        ])

        const joinerRows = guests.map((guest) => [
            bookingId, createdAt, camp,
            guest.firstName, guest.lastName, "",      // no date of birth for a joiner
            "", "",                                    // no club, no allergies
            0, "", 0, "No",                              // no camp add-ons for a joiner
            contact.parentName, contact.email, contact.phone,
            total, "pending", language || "en",
            "Joiner",
            location || "", dateRange || "", ageRange || "",
            dropOffTime || "", pickUpTime || "", bookingReference,
            startDate || "", endDate || "",
        ])

        await sheets.spreadsheets.values.append({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
            range: `Bookings!A:${LAST_COLUMN}`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [...participantRows, ...joinerRows] },
        })

        // --- 3. Create the Stripe Checkout session, for the submitted total -------
        const session = await stripe.checkout.sessions.create({
            mode: "payment",
            payment_method_types: ["card"],
            customer_email: contact.email,
            line_items: [
                {
                    price_data: {
                        currency: "eur",
                        product_data: { name: `${camp} camp booking` },
                        unit_amount: Math.round(total * 100),
                    },
                    quantity: 1,
                },
            ],
            metadata: { bookingId },
            success_url: "https://www.sportsevolution.lu/confirmation-page?session_id={CHECKOUT_SESSION_ID}",
            cancel_url: `${process.env.SITE_URL}`,
        })

        return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ checkoutUrl: session.url }) }
    } catch (err) {
        console.error(err)
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: "Could not create booking" }) }
    }
}
