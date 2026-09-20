// /api/stripe-webhook.js
// Stripe calls this endpoint directly the moment a payment succeeds.
//
// ★ Column layout matches the live Sheet. Drop-off/pick-up time are NOT in
// the Sheet — they're read from the Stripe session's own metadata instead
// (attached back in create-booking.js), since they're the same for every
// booking of a given camp rather than per-booking data.
//
// This is the ONLY place that emails the customer.
//
// Additional env var needed beyond create-booking.js:
//   STRIPE_WEBHOOK_SECRET

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
const STATUS_COLUMN_LETTER = "Q"

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
    if (!process.env.RESEND_API_KEY) {
        throw new Error("RESEND_API_KEY is not set — refusing to send with an empty bearer token")
    }
    const res = await fetch("https://api.resend.com/emails", {
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
    // ★ fetch() does not throw on 4xx/5xx — a rejected send (bad key,
    // unverified domain, malformed recipient) previously looked identical
    // to a successful one. Read the body either way and throw on failure
    // so the real reason shows up in the function logs.
    const resText = await res.text()
    if (!res.ok) {
        throw new Error(`Resend rejected the email — status ${res.status}: ${resText}`)
    }
    return resText
}

async function findBookingRows(sheets, bookingId) {
    const result = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: `Bookings!A:${LAST_COLUMN}`,
    })
    const rows = result.data.values || []
    const matches = []
    rows.forEach((row, i) => {
        if (row[COL.bookingId] === bookingId) {
            matches.push({ rowNumber: i + 1, data: row })
        }
    })
    return matches
}

// ★ dropOffTime/pickUpTime now come from Stripe's session metadata, passed
// in as arguments — not read from the Sheet row.
function buildConfirmationHtml(matches, dropOffTime, pickUpTime) {
    const first = matches[0].data
    const camp = first[COL.camp]
    const venue = first[COL.venue]
    const dateRange = first[COL.campDateRange]
    const ageRange = first[COL.ageRange]
    const reference = first[COL.bookingReference]
    const total = first[COL.bookingTotal]

    const participants = matches.filter((m) => (m.data[COL.role] || "Participant") === "Participant")
    const joiners = matches.filter((m) => m.data[COL.role] === "Joiner")

    const childLines = participants
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

    const joinerLines = joiners
        .map(({ data }) => `<li>${`${data[COL.firstName]} ${data[COL.lastName]}`.trim()}</li>`)
        .join("")

    const joinerSection =
        joiners.length > 0
            ? `<p><strong>Trip tickets (${joiners.length}):</strong></p><ul>${joinerLines}</ul>`
            : ""

    return `
        <p>Hi ${first[COL.parentName]},</p>
        <p>Your payment has been received and your booking is confirmed.</p>
        <table cellpadding="6" style="border-collapse:collapse;">
            <tr><td><strong>Booking reference</strong></td><td>${reference}</td></tr>
            <tr><td><strong>Camp</strong></td><td>${camp}</td></tr>
            <tr><td><strong>Dates</strong></td><td>${dateRange}</td></tr>
            <tr><td><strong>Venue</strong></td><td>${venue}</td></tr>
            <tr><td><strong>Ages</strong></td><td>${ageRange}</td></tr>
            <tr><td><strong>Drop-off</strong></td><td>${dropOffTime || ""}</td></tr>
            <tr><td><strong>Pick-up</strong></td><td>${pickUpTime || ""}</td></tr>
            <tr><td><strong>Tickets</strong></td><td>${participants.length} ${participants.length === 1 ? "child" : "children"}</td></tr>
            <tr><td><strong>Total paid</strong></td><td>€${total}</td></tr>
        </table>
        <p><strong>Details per child:</strong></p>
        <ul>${childLines}</ul>
        ${joinerSection}
        <p>See you at camp!</p>
    `
}

exports.handler = async (event) => {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method not allowed" }
    }

    const sig = event.headers["stripe-signature"]

    // ★ Netlify's Lambda-compatible runtime doesn't always hand back
    // event.body byte-for-byte identical to what Stripe actually sent —
    // some deployments expose the true raw body separately as
    // event.rawBody. Signature verification needs the EXACT original
    // bytes; a single character of difference fails it every time,
    // regardless of a correct secret. Prefer rawBody when present.
    let payload
    if (event.rawBody) {
        payload = event.rawBody
    } else if (event.isBase64Encoded) {
        payload = Buffer.from(event.body, "base64")
    } else {
        payload = event.body
    }

    console.log(
        `Webhook body debug — has rawBody: ${!!event.rawBody}, isBase64Encoded: ${event.isBase64Encoded}, ` +
        `body type: ${typeof event.body}, body length: ${event.body ? event.body.length : 0}, ` +
        `signature header present: ${!!sig}`
    )

    let stripeEvent
    try {
        stripeEvent = stripe.webhooks.constructEvent(payload, sig, process.env.STRIPE_WEBHOOK_SECRET)
    } catch (err) {
        console.error("Webhook signature verification failed:", err.message)
        return { statusCode: 400, body: `Webhook Error: ${err.message}` }
    }

    if (stripeEvent.type === "checkout.session.completed") {
        const session = stripeEvent.data.object
        const bookingId = session.metadata.bookingId
        const dropOffTime = session.metadata.dropOffTime
        const pickUpTime = session.metadata.pickUpTime

        try {
            const sheets = await getSheet()
            const matches = await findBookingRows(sheets, bookingId)

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

            // ★ Fallback chain for the buyer's address — session.customer_details
            // is only populated if Checkout was configured to collect it. Fall
            // back to session.customer_email, then to the email the booking
            // form itself already captured in the Sheet, so a Stripe-side gap
            // doesn't suppress an email the form already had a good address for.
            const buyerEmail =
                session.customer_details?.email ||
                session.customer_email ||
                (matches.length > 0 ? matches[0].data[COL.email] : null)

            console.log(`Webhook for booking ${bookingId}: found ${matches.length} row(s), buyerEmail = "${buyerEmail || ""}"`)

            if (matches.length === 0) {
                console.error(`Skipping email for booking ${bookingId}: no matching Sheet rows found for this booking ID.`)
            } else if (!buyerEmail) {
                console.error(`Skipping email for booking ${bookingId}: no buyer address from Stripe or the Sheet.`)
            } else {
                await sendEmail(
                    buyerEmail,
                    "Payment confirmed — see you at camp!",
                    buildConfirmationHtml(matches, dropOffTime, pickUpTime)
                )
                console.log(`Confirmation email sent to ${buyerEmail} for booking ${bookingId}`)
            }
        } catch (err) {
            console.error("Failed to update sheet / send email:", err)
        }
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) }
}
