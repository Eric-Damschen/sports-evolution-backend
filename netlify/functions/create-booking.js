// netlify/functions/create-booking.js
// Runs the moment the buyer clicks "Confirm & pay" in the Framer form.
//
// 1. Re-checks capacity (a second time — the panel value alone can't stop
//    two people booking the last spot at the same moment)
// 2. Writes ONE ROW PER CHILD to Google Sheets, all sharing the same Booking
//    ID, status = "pending" (see Bookings_template.csv for the exact layout)
// 3. Sends a "we've received your request" email
// 4. Creates a Stripe Checkout Session and returns its URL
//
// Env vars needed (Netlify: Site settings → Environment variables):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
//   GOOGLE_SHEET_ID
//   STRIPE_SECRET_KEY
//   RESEND_API_KEY
//   SITE_URL                  e.g. https://sportsevolution.lu (NO trailing slash)
//
// Reachable at /.netlify/functions/create-booking, or /api/create-booking
// if you keep the redirect in netlify.toml (recommended — see that file).

const { google } = require("googleapis")
const Stripe = require("stripe")
const { randomUUID } = require("crypto")

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

// ★ Column layout — must match Bookings_template.csv and the header row in
// your actual sheet exactly. One row = one child. Shared with
// camp-availability.js and stripe-webhook.js — keep all three in sync.
const COL = {
    bookingId: 0, createdAt: 1, camp: 2, firstName: 3, lastName: 4, dob: 5,
    club: 6, allergies: 7, clothingQty: 8, clothingSize: 9, bottleQty: 10,
    meals: 11, parentName: 12, email: 13, phone: 14, bookingTotal: 15,
    status: 16, language: 17,
}
const LAST_COLUMN = "R" // keep in sync with the last key in COL above

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

async function sendEmail(to, subject, html) {
    await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            from: "Sports Evolution <bookings@sportsevolution.lu>",
            to,
            subject,
            html,
        }),
    })
}

// ★ Shared with camp-availability.js — keep both in sync if you edit this.
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
        // Preflight request — browsers send this before the real POST
        // because it carries a JSON body. Must be answered or the POST never fires.
        return { statusCode: 200, headers: CORS_HEADERS, body: "" }
    }

    if (event.httpMethod !== "POST") {
        return {
            statusCode: 405,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "Method not allowed" }),
        }
    }

    try {
        const { camp, children, contact, total, totalSpots, language } = JSON.parse(event.body)
        const bookingId = randomUUID()
        const sheets = await getSheet()

        // --- 1. Re-check capacity, server-side ----------------------------------
        if (totalSpots) {
            const booked = await countBookedSpots(sheets, camp)
            const remaining = Number(totalSpots) - booked
            if (children.length > remaining) {
                return {
                    statusCode: 409,
                    headers: CORS_HEADERS,
                    body: JSON.stringify({
                        error: "notEnoughSpots",
                        remaining: Math.max(0, remaining),
                    }),
                }
            }
        }

        // --- 2. Write one pending row PER CHILD -----------------------------------
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

        // --- 3. Send the "request received" email -------------------------------
        await sendEmail(
            contact.email,
            `We've received your ${camp} camp booking`,
            `<p>Hi ${contact.parentName},</p>
             <p>We've received your booking request for <strong>${camp}</strong>
             (${children.length} ${children.length === 1 ? "child" : "children"}).</p>
             <p>Complete payment to secure the spot — total due: €${total}.</p>`
        )

        // --- 4. Create the Stripe Checkout session ------------------------------
        // NOTE: camp name is passed through encodeURIComponent() below because
        // camp names can contain spaces and parentheses (e.g. "Test (football)"),
        // which are not valid raw characters in a URL and cause Stripe to reject
        // the request with a "url_invalid" error on cancel_url.
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
            success_url: `${process.env.SITE_URL}/booking-confirmed?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.SITE_URL}/camps/${encodeURIComponent(camp.toLowerCase())}`,
        })

        return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({ checkoutUrl: session.url }),
        }
    } catch (err) {
        console.error(err)
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "Could not create booking" }),
        }
    }
}
