// /api/stripe-webhook.js
// Stripe calls this endpoint directly (not the buyer's browser) the moment
// a payment succeeds. Register this URL in the Stripe Dashboard under
// Developers → Webhooks, listening for "checkout.session.completed".
//
// This is the ONLY place that emails the customer — a detailed payment
// confirmation, built from the actual booking rows in the Sheet (camp,
// how many tickets, each child's add-ons).
//
// Additional env var needed beyond create-booking.js:
//   STRIPE_WEBHOOK_SECRET   (shown when you create the webhook in Stripe)

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

// ★ One booking can span several rows (one per child). This now returns
// each matching row's NUMBER (to update its status) together with its full
// DATA (to build a real, detailed confirmation email) — not just the row
// numbers like before.
async function findBookingRows(sheets, bookingId) {
    const result = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: "Bookings!A:R",
    })
    const rows = result.data.values || []
    const matches = []
    rows.forEach((row, i) => {
        if (row[COL.bookingId] === bookingId) {
            matches.push({ rowNumber: i + 1, data: row }) // sheet rows are 1-indexed
        }
    })
    return matches
}

// ★ Builds the "here's what you booked" section of the email from the
// actual row data — camp name, ticket count, and each child's add-ons.
function buildConfirmationHtml(matches) {
    const first = matches[0].data
    const camp = first[COL.camp]
    const total = first[COL.bookingTotal]
    const ticketCount = matches.length

    const childLines = matches
        .map(({ data }) => {
            const name = `${data[COL.firstName]} ${data[COL.lastName]}`.trim()
            const addOns = []
            const clothingQty = Number(data[COL.clothingQty]) || 0
            if (clothingQty > 0) {
                const size = data[COL.clothingSize]
                addOns.push(`Clothing set ×${clothingQty}${size ? ` (size ${size})` : ""}`)
            }
            const bottleQty = Number(data[COL.bottleQty]) || 0
            if (bottleQty > 0) addOns.push(`Drinking bottle ×${bottleQty}`)
            if (data[COL.meals] === "Yes") addOns.push("Meals")
            const addOnsText = addOns.length > 0 ? addOns.join(", ") : "No add-ons"
            return `<li><strong>${name}</strong> — ${addOnsText}</li>`
        })
        .join("")

    return `
        <p>Hi ${first[COL.parentName]},</p>
        <p>Your payment has been received and your booking is confirmed.</p>
        <table cellpadding="6" style="border-collapse:collapse;">
            <tr><td><strong>Camp</strong></td><td>${camp}</td></tr>
            <tr><td><strong>Tickets</strong></td><td>${ticketCount} ${ticketCount === 1 ? "child" : "children"}</td></tr>
            <tr><td><strong>Total paid</strong></td><td>€${total}</td></tr>
        </table>
        <p><strong>Details per child:</strong></p>
        <ul>${childLines}</ul>
        <p>See you at camp!</p>
    `
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
            const matches = await findBookingRows(sheets, bookingId)

            // Flip every row for this booking to "paid", all together.
            await Promise.all(
                matches.map(({ rowNumber }) =>
                    sheets.spreadsheets.values.update({
                        spreadsheetId: process.env.GOOGLE_SHEET_ID,
                        range: `Bookings!${STATUS_COLUMN_LETTER}${rowNumber}`,
                        valueInputOption: "USER_ENTERED",
                        requestBody: { values: [["paid"]] },
                    })
                )
            )

            if (buyerEmail && matches.length > 0) {
                await sendEmail(
                    buyerEmail,
                    "Payment confirmed — see you at camp!",
                    buildConfirmationHtml(matches)
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
