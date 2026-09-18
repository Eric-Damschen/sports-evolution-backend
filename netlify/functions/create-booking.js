// /api/create-booking.js
// Runs the moment the buyer clicks "Confirm & pay" in the Framer form.
//
// ★ SECURITY: the client (the browser) NEVER decides the price or the
// capacity limit here. Both are looked up server-side from a "Camps" tab in
// the same Google Sheet, which only you can edit. Whatever "total" or
// "totalSpots" the request body contains is ignored for anything that
// actually matters — it exists only for logging/debugging.
//
// 1. Looks up this camp's real price + capacity from the "Camps" tab
// 2. Re-checks capacity against the REAL limit, not a client-supplied one
// 3. Computes the REAL total server-side (ticket + tiered clothing + bottles + meals)
// 4. Writes one pending row per child to "Bookings", using the real total
// 5. Sends a "we've received your request" email
// 6. Creates a Stripe Checkout Session for the REAL amount and returns its URL
//
// Env vars needed:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
//   GOOGLE_SHEET_ID
//   STRIPE_SECRET_KEY
//   RESEND_API_KEY
//   SITE_URL                  e.g. https://sportsevolution.lu  (no trailing slash)

const { google } = require("googleapis")
const Stripe = require("stripe")
const { randomUUID } = require("crypto")

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

// ★ Bookings tab column layout — one row per child. Shared with
// camp-availability.js — keep both in sync.
const COL = {
    bookingId: 0, createdAt: 1, camp: 2, firstName: 3, lastName: 4, dob: 5,
    club: 6, allergies: 7, clothingQty: 8, clothingSize: 9, bottleQty: 10,
    meals: 11, parentName: 12, email: 13, phone: 14, bookingTotal: 15,
    status: 16, language: 17,
}
const LAST_COLUMN = "R"

// ★ Camps tab column layout — one row per camp, the price/capacity source
// of truth. Import Camps_template.csv to set this tab up. Edit any cell any
// time — no deploy needed, it's read fresh on every booking.
const CAMPS_COL = {
    campKey: 0, fee: 1, capacity: 2, clothingPrice: 3,
    clothingDiscountPercent: 4, bottlePrice: 5, mealsPrice: 6,
}

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
            from: "Sports Evolution <order@sportsevolution.lu>",
            to,
            subject,
            html,
        }),
    })
}

// ★ Looks up this camp's real price + capacity. Throws if the camp isn't in
// the Camps tab — deliberately fails the booking rather than falling back to
// trusting the client, since a missing row means we don't actually know the
// real price.
async function getCampPricing(sheets, campKey) {
    const result = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: "Camps!A:G",
    })
    const rows = result.data.values || []
    const row = rows.find((r) => r[CAMPS_COL.campKey] === campKey)
    if (!row) {
        throw new Error(`No pricing row found in the Camps tab for "${campKey}"`)
    }
    return {
        fee: Number(row[CAMPS_COL.fee]) || 0,
        capacity: Number(row[CAMPS_COL.capacity]) || 0,
        clothingPrice: Number(row[CAMPS_COL.clothingPrice]) || 0,
        clothingDiscountPercent: Number(row[CAMPS_COL.clothingDiscountPercent]) || 0,
        bottlePrice: Number(row[CAMPS_COL.bottlePrice]) || 0,
        mealsPrice: Number(row[CAMPS_COL.mealsPrice]) || 0,
    }
}

// ★ Must match the identical function in BookingForm.tsx exactly — 1st set
// full price, every additional set gets discountPercent off.
function clothingSetCost(qty, unitPrice, discountPercent) {
    if (qty <= 0) return 0
    const discountedUnit = unitPrice * (1 - discountPercent / 100)
    const total = unitPrice + discountedUnit * (qty - 1)
    return Math.round(total * 100) / 100
}

// ★ The REAL total, computed entirely server-side from the Camps tab's
// prices and the shape of what was ordered (how many children, how many
// clothing sets each, etc.) — never from the client's claimed "total".
function computeRealTotal(children, pricing) {
    let total = pricing.fee * children.length
    for (const child of children) {
        const addOns = child.addOns || {}
        total += clothingSetCost(addOns.clothingQty || 0, pricing.clothingPrice, pricing.clothingDiscountPercent)
        total += (addOns.bottleQty || 0) * pricing.bottlePrice
        if (addOns.meals) total += pricing.mealsPrice
    }
    return Math.round(total * 100) / 100
}

// ★ Shared with camp-availability.js — keep both in sync.
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

// ★ Encodes the camp name safely for use in a URL path — "Rodange
// (football)" has spaces and parentheses, which break an unencoded URL.
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
        const { camp, children, contact, language } = JSON.parse(event.body)

        if (!camp || !Array.isArray(children) || children.length === 0 || !contact) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "Missing camp, children, or contact details" }),
            }
        }

        const bookingId = randomUUID()
        const sheets = await getSheet()

        // --- 1. Real pricing + capacity, looked up server-side --------------------
        const pricing = await getCampPricing(sheets, camp)

        // --- 2. Re-check capacity against the REAL limit ---------------------------
        const booked = await countBookedSpots(sheets, camp)
        const remaining = pricing.capacity - booked
        if (children.length > remaining) {
            return {
                statusCode: 409,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "notEnoughSpots", remaining: Math.max(0, remaining) }),
            }
        }

        // --- 3. The REAL total, computed here, not trusted from the client --------
        const total = computeRealTotal(children, pricing)

        // --- 4. Write one pending row PER CHILD, using the real total -------------
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

        // --- 5. Create the Stripe Checkout session, for the REAL amount -----------
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
            cancel_url: `${process.env.SITE_URL}/camps/${campSlug(camp)}`,
        })

        // --- 6. Email — sent only after the Stripe session exists, so we never
        // tell someone "received" if creating their payment link then fails.
        await sendEmail(
            contact.email,
            `We've received your ${camp} camp booking`,
            `<p>Hi ${contact.parentName},</p>
             <p>We've received your booking request for <strong>${camp}</strong>
             (${children.length} ${children.length === 1 ? "child" : "children"}).</p>
             <p>Complete payment to secure the spot — total due: €${total}.</p>`
        )

        return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ checkoutUrl: session.url }) }
    } catch (err) {
        console.error(err)
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: "Could not create booking" }) }
    }
}
