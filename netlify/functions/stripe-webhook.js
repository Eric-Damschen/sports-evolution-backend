// /api/stripe-webhook.js
// Stripe calls this endpoint directly (not the buyer's browser) the moment
// a payment succeeds. Register this URL in the Stripe Dashboard under
// Developers → Webhooks, listening for "checkout.session.completed".
//
// Additional env var needed beyond create-booking.js:
//   STRIPE_WEBHOOK_SECRET   (shown when you create the webhook in Stripe)
//
// Note: unlike Vercel, Netlify already hands you the raw request body as
// event.body — no extra package is needed to read it for signature
// verification. The only wrinkle: if Netlify marked the body as
// base64-encoded, it needs decoding first — handled below.

const { google } = require("googleapis")
const Stripe = require("stripe")

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

// ★ Must match create-booking.js and camp-availability.js exactly — one row = one child.
const COL = {
    bookingId: 0, createdAt: 1, camp: 2, firstName: 3, lastName: 4, dob: 5,
    club: 6, allergies: 7, clothingQty: 8, clothingSize: 9, bottleQty: 10,
    meals: 11, parentName: 12, email: 13, phone: 14, bookingTotal: 15,
    status: 16, language: 17,
}
const STATUS_COLUMN_LETTER = "Q" // = COL.status, spelled out for the range string below

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
            from: "Sports Evolution <info@order.sportsevolution.lu>",
            to,
            subject,
            html,
        }),
    })
}

// ★ One booking can span several rows now (one per child), so this returns
// EVERY matching row number, not just the first one.
async function findRowsByBookingId(sheets, bookingId) {
    const result = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: "Bookings!A:A",
    })
    const rows = result.data.values || []
    const rowNumbers = []
    rows.forEach((row, i) => {
        if (row[COL.bookingId] === bookingId) rowNumbers.push(i + 1) // sheet rows are 1-indexed
    })
    return rowNumbers
}

exports.handler = async (event) => {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method not allowed" }
    }

    // --- Verify this really came from Stripe -----------------------------------
    const sig = event.headers["stripe-signature"]
    const payload = event.isBase64Encoded
        ? Buffer.from(event.body, "base64")
        : event.body

    let stripeEvent
    try {
        stripeEvent = stripe.webhooks.constructEvent(
            payload,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        )
    } catch (err) {
        console.error("Webhook signature verification failed:", err.message)
        return { statusCode: 400, body: `Webhook Error: ${err.message}` }
    }

    if (stripeEvent.type === "checkout.session.completed") {
        const session = stripeEvent.data.object
        const bookingId = session.metadata.bookingId
        const buyerEmail = session.customer_details?.email

        try {
            const sheets = await getSheet()
            const rowNumbers = await findRowsByBookingId(sheets, bookingId)

            await Promise.all(
                rowNumbers.map((rowNumber) =>
                    sheets.spreadsheets.values.update({
                        spreadsheetId: process.env.GOOGLE_SHEET_ID,
                        range: `Bookings!${STATUS_COLUMN_LETTER}${rowNumber}`,
                        valueInputOption: "USER_ENTERED",
                        requestBody: { values: [["paid"]] },
                    })
                )
            )

            if (buyerEmail) {
                await sendEmail(
                    buyerEmail,
                    "Payment confirmed — see you at camp!",
                    `<p>Your payment has been received. Your booking is confirmed.</p>`
                )
            }
        } catch (err) {
            // Log but still return 200 — Stripe will retry on non-2xx responses,
            // which could double-send emails. Alert yourself separately instead.
            console.error("Failed to update sheet / send email:", err)
        }
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) }
}
