// /api/create-booking.js
// Runs the moment the buyer clicks "Confirm & pay" in the Framer form.
//
// The checkout amount and capacity limit are taken directly from what the
// booking form sends — no separate pricing list, no Camps tab lookup.
//
// 1. Re-checks capacity against the client-supplied group size
// 2. Writes one pending row per child to "Bookings"
// 3. Creates a Stripe Checkout Session for the submitted total
//
// No email is sent from here — only stripe-webhook.js emails the customer,
// once payment is actually confirmed.

const { google } = require("googleapis")
const Stripe = require("stripe")
const { randomUUID } = require("crypto")

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

// ★ Bookings tab column layout — one row per child. Shared with
// camp-availability.js and stripe-webhook.js — keep all three in sync.
const COL = {
    bookingId: 0, createdAt: 1, camp: 2, firstName: 3, lastName: 4, dob: 5,
    club: 6, allergies: 7, clothingQty: 8, clothingSize: 9, bottleQty: 10,
    meals: 11, parentName: 12, email: 13, phone: 14, bookingTotal: 15,
    status: 16, language: 17,
}
const LAST_COLUMN = "R"

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

function campSlug(camp) {
    return encodeURIComponent(camp.toLowerCase().replace(/\s+/g, "-"))
}

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" }
    }
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: "Method not allowed" }) }
    }

    try {
        const { camp, children, contact, total, totalSpots, language } = JSON.parse(event.body)

        if (!camp || !Array.isArray(children) || children.length === 0 || !contact) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "Missing camp, children, or contact details" }),
            }
        }

        const bookingId = randomUUID()
        const sheets = await getSheet()

        // --- 1. Capacity check, against the group size the form sent --------------
        if (totalSpots) {
            const booked = await countBookedSpots(sheets, camp)
            const remaining = Number(totalSpots) - booked
            if (children.length > remaining) {
                return {
                    statusCode: 409,
                    headers: CORS_HEADERS,
                    body: JSON.stringify({ error: "notEnoughSpots", remaining: Math.max(0, remaining) }),
                }
            }
        }

        // --- 2. Write one pending row PER CHILD, using the submitted total --------
        const createdAt = new Date().toISOString()
        const rows = children.map((child) => [
            bookingId,
            createdAt,
            camp,
            child.firstName,
            child.lastName,
            child.dob,
            child.club || "",
            child.allergies || "",
            child.addOns?.clothingQty || 0,
            child.addOns?.clothingSize || "",
            child.addOns?.bottleQty || 0,
            child.addOns?.meals ? "Yes" : "No",
            contact.parentName,
            contact.email,
            contact.phone,
            total,
            "pending",
            language || "en",
        ])

        await sheets.spreadsheets.values.append({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
            range: `Bookings!A:${LAST_COLUMN}`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: rows },
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
            // ★ Temporary — redirects to the main site until the real
            // confirmation page exists. Once it does, change back to:
            // `${process.env.SITE_URL}/booking-confirmed?session_id={CHECKOUT_SESSION_ID}`
            success_url: `${process.env.SITE_URL}`,
            cancel_url: `${process.env.SITE_URL}`,
        })

        return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ checkoutUrl: session.url }) }
    } catch (err) {
        console.error(err)
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: "Could not create booking" }) }
    }
}
