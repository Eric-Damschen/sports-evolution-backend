// netlify/functions/create-booking.js
//
// Self-contained on purpose: no shared module to misplace.
// Shared by BOTH Booking_form.tsx and Trip_Booking_form.tsx.
//
// 1. Checks capacity (camp and trip, independently)
// 2. Writes one "pending" row per child and per trip guest
// 3. Re-reads to confirm nobody else took the last spot first
// 4. Creates the Stripe Checkout Session
//
// No email is sent here — only stripe-webhook.js emails the customer.

const { google } = require("googleapis")
const Stripe = require("stripe")
const { randomUUID } = require("crypto")

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

/* ---------------- Sheet layout (A..Y) ---------------- */

const COL = {
    bookingId: 0, createdAt: 1, camp: 2, firstName: 3, lastName: 4, dob: 5,
    club: 6, allergies: 7, clothingQty: 8, clothingSize: 9, bottleQty: 10,
    meals: 11, parentName: 12, email: 13, phone: 14, bookingTotal: 15,
    status: 16, language: 17, role: 18,
    venue: 19, campDateRange: 20, ageRange: 21,
    bookingReference: 22, startDate: 23, endDate: 24,
    position: 25,
    discountCode: 26,
    referral: 27,
}
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Bookings"
// Z = Position, AA = Discount code, AB = How did you hear about us.
// Headers: Z1 "Position", AA1 "Discount code", AB1 "Heard about us".
const LAST_COLUMN = "AB"

// ★ Minimum age on the first camp day. Same value as MIN_AGE in the forms.
const MIN_AGE = 7

// "How did you hear about us?" — form key → English text for the Sheet.
// Short names for staff; the form shows friendlier wording per language.
const REFERRAL_LABELS = {
    friends: "Friends/family",
    club: "Club or coach",
    instagram: "Instagram",
    facebook: "Facebook",
    tiktok: "TikTok",
    metaAd: "Meta ad",
    internet: "Internet search",
    returning: "Came before",
    other: "Other",
}
const REFERRAL_OTHER_MAX = 60

function referralText(referral) {
    const source = referral && typeof referral.source === "string" ? referral.source : ""
    if (!Object.prototype.hasOwnProperty.call(REFERRAL_LABELS, source)) return ""
    if (source !== "other") return REFERRAL_LABELS[source]
    // Free text: single line, no control characters, capped; a leading = + - @
    // is neutralised so the Sheet never treats it as a formula.
    const other = String((referral && referral.other) || "")
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, REFERRAL_OTHER_MAX)
        .replace(/^[=+\-@]+/, "")
        .trim()
    return other ? `Other: ${other}` : "Other"
}

// One clean line of text for Stripe metadata.
function metaText(value, max) {
    return String(value || "")
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
}

// Multi-line text (paragraph fields): keeps line breaks, drops other
// control characters, collapses spaces.
// The camp page address, only when it's on our own website (SITE_URL host,
// with or without www). Anything else becomes "".
function campPageUrl(value) {
    try {
        const u = new URL(String(value || ""))
        const site = new URL(process.env.SITE_URL || "https://www.sportsevolution.lu")
        const bare = (h) => h.replace(/^www\./, "").toLowerCase()
        if (u.protocol !== "https:" || bare(u.hostname) !== bare(site.hostname)) return ""
        return (u.origin + u.pathname).slice(0, 400)
    } catch (e) {
        return ""
    }
}

function metaMultiline(value, max) {
    return String(value || "")
        .replace(/\r\n?/g, "\n")
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, max)
}

// "Good to know" for Stripe metadata: max 1500 chars in 500-char parts.
function goodToKnowParts(value) {
    const text = metaMultiline(value, 1500)
    const parts = {}
    for (let i = 0; i * 500 < text.length; i++) {
        parts[`goodToKnow${i + 1}`] = text.slice(i * 500, (i + 1) * 500)
    }
    return parts
}

function todayISOLuxembourg() {
    // en-CA formats as YYYY-MM-DD
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Luxembourg",
        year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date())
}

// Age in whole years on refISO. null when dob is not a real YYYY-MM-DD date.
function ageOn(dob, refISO) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dob || ""))
    const r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(refISO || ""))
    if (!m || !r) return null
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
    const check = new Date(Date.UTC(y, mo - 1, d))
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
        return null
    }
    const ry = Number(r[1]), rmo = Number(r[2]), rd = Number(r[3])
    let age = ry - y
    if (rmo < mo || (rmo === mo && rd < d)) age -= 1
    return age
}
const DATA_RANGE = `${SHEET_TAB}!A:${LAST_COLUMN}`
const STATUS_COLUMN_LETTER = "Q"

const ROLE_PARTICIPANT = "Participant"
const ROLE_JOINER = "Joiner"

// How long a checkout holds the seat.
const PENDING_HOLD_MINUTES = Number(process.env.PENDING_HOLD_MINUTES || 30)

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}

function json(statusCode, body) {
    return {
        statusCode,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        body: JSON.stringify(body),
    }
}

/* ---------------- Google Sheets ---------------- */

async function getSheet() {
    const auth = new google.auth.JWT(
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        null,
        (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
        ["https://www.googleapis.com/auth/spreadsheets"]
    )
    return google.sheets({ version: "v4", auth })
}

// Every row, with its real sheet row number (row 1 is the header).
async function getAllRows(sheets) {
    const result = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: DATA_RANGE,
    })
    const rows = result.data.values || []
    return rows.map((data, i) => ({ rowNumber: i + 1, data }))
}

/* ---------------- Capacity ---------------- */

// A partial refund keeps the seat; a full refund, an expired checkout or a
// lost race all give it back.
function holdsASeat(row) {
    const status = String(row[COL.status] || "").trim().toLowerCase()
    if (status === "paid") return true
    if (status === "partially refunded") return true
    if (status !== "pending") return false

    const created = Date.parse(row[COL.createdAt])
    if (isNaN(created)) return true
    return Date.now() - created < PENDING_HOLD_MINUTES * 60 * 1000
}

// beforeRowNumber counts only rows ABOVE it — seats claimed before ours landed.
function countBookedSpots(allRows, camp, role, beforeRowNumber) {
    const want = String(camp || "").trim().toLowerCase()
    const limit = typeof beforeRowNumber === "number" ? beforeRowNumber : Infinity
    let count = 0

    for (const { rowNumber, data } of allRows) {
        if (rowNumber >= limit) continue
        if (String(data[COL.camp] || "").trim().toLowerCase() !== want) continue
        if (!holdsASeat(data)) continue
        if ((data[COL.role] || ROLE_PARTICIPANT) === role) count += 1
    }
    return count
}

/* ---------------- Discount codes ---------------- */
// Codes live in the private "Discount codes" tab of the Sheet, row 1 = headers:
//   A Code | B Percent off | C Active | D Valid until | E Max uses
//   SUMMER10 | 10 | Yes | 2027-08-31 | 50
// - Percent off: 10 or 10% (a percentage of the camp fees, after the
//   multichild discount), or FREE = one camp ticket free. With FREE, the
//   other children in the booking pay as normal; add-ons and trip tickets
//   are always paid.
// - Active: "Yes" or a ticked checkbox. Anything else, blank included, = off.
// - Valid until (optional): last day the code works. Write it as 2027-08-31;
//   31/08/2027 and 31.08.2027 also work. Blank = no end date.
// - Max uses (optional): how many bookings may use it. Blank or 0 = unlimited.
// Any doubt (bad date, bad percent, tab missing) = the code is refused.

const DISCOUNT_TAB = process.env.DISCOUNT_SHEET_TAB || "Discount codes"
const DISCOUNT_CODE_COL = 26 // Bookings column AA

function normaliseCode(value) {
    return String(value || "").trim().toUpperCase()
}

function parsePercent(value) {
    const n = parseFloat(String(value || "").replace("%", "").replace(",", ".").trim())
    return isFinite(n) && n > 0 && n <= 100 ? n : 0
}

// -> "YYYY-MM-DD", "" when blank, null when unreadable
function parseSheetDate(value) {
    const s = String(value || "").trim()
    if (!s) return ""
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
    let y, mo, d
    if (m) {
        y = +m[1]; mo = +m[2]; d = +m[3]
    } else {
        m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/)
        if (!m) return null
        const a = +m[1], b = +m[2]
        y = +m[3]
        if (a > 12) { d = a; mo = b } else if (b > 12) { d = b; mo = a } else { d = a; mo = b }
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`
}

function todayInLuxembourg() {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Luxembourg",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date())
}

// Returns { code, percent, freeTicket } when usable, otherwise null.
// bookingRows = Bookings rows as { rowNumber, data }, used to count uses.
async function lookupDiscount(sheets, rawCode, bookingRows) {
    const code = normaliseCode(rawCode)
    if (!code) return null

    let values
    try {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
            range: `'${DISCOUNT_TAB.replace(/'/g, "''")}'!A2:E`,
        })
        values = res.data.values || []
    } catch (err) {
        console.error(`[discount] could not read the "${DISCOUNT_TAB}" tab:`, err.message)
        return null
    }

    const row = values.find((r) => normaliseCode(r[0]) === code)
    if (!row) return null

    const freeTicket = /^\s*free/i.test(String(row[1] || ""))
    const percent = freeTicket ? 0 : parsePercent(row[1])
    if (!freeTicket && !percent) {
        console.error(`[discount] ${code}: "${row[1]}" is neither FREE nor a number between 0 and 100`)
        return null
    }

    const active = String(row[2] || "").trim().toLowerCase()
    if (!["yes", "true", "x", "1"].includes(active)) return null

    const validUntil = parseSheetDate(row[3])
    if (validUntil === null) {
        console.error(`[discount] ${code}: unreadable date "${row[3]}" — write it as 2027-08-31`)
        return null
    }
    if (validUntil && todayInLuxembourg() > validUntil) return null

    const maxUses = parseInt(String(row[4] || "").trim(), 10)
    if (maxUses > 0) {
        const used = new Set()
        for (const { data } of bookingRows || []) {
            if (normaliseCode(data[DISCOUNT_CODE_COL]) === code && holdsASeat(data)) used.add(data[0])
        }
        if (used.size >= maxUses) return null
    }

    return { code, percent, freeTicket }
}

/* ---------------- Helpers ---------------- */

function toNumber(value, fallback = 0) {
    const n = Number(String(value).replace(",", "."))
    return isFinite(n) ? n : fallback
}

const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

function makeBookingReference(allRows) {
    const year = new Date().getFullYear()
    const taken = new Set(
        allRows.map((r) => String(r.data[COL.bookingReference] || "").trim())
    )
    for (let attempt = 0; attempt < 10; attempt += 1) {
        let suffix = ""
        for (let i = 0; i < 5; i += 1) {
            suffix += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)]
        }
        const ref = `SE-${year}-${suffix}`
        if (!taken.has(ref)) return ref
    }
    return `SE-${year}-${Date.now().toString(36).toUpperCase()}`
}

// Column P holds each person's own price. Works in integer cents and puts any
// rounding remainder on the first row, so the column sums to exactly what
// Stripe charged.
function allocatePersonAmounts(people, orderTotal) {
    const targetCents = Math.round(toNumber(orderTotal, 0) * 100)
    if (!people.length) return []

    const provided = people.map((p) => toNumber(p && p.lineTotal, NaN))
    const allProvided = provided.every((n) => isFinite(n) && n >= 0)

    let cents
    if (allProvided) {
        cents = provided.map((n) => Math.round(n * 100))
    } else {
        const even = Math.floor(targetCents / people.length)
        cents = people.map(() => even)
    }

    cents[0] += targetCents - cents.reduce((a, b) => a + b, 0)
    return cents.map((c) => c / 100)
}

// ★ New rows are inserted with INSERT_ROWS, and Google Sheets gives an
// inserted row the formatting of the row above it — so the first booking
// under the header copied its blue fill and bold text, and every booking
// after copied that. This resets a booking's own rows to plain white.
// Only fill, bold and text colour are touched: number or date formats you
// set on a column are kept.
async function resetRowFormatting(sheets, rowNumbers) {
    if (!rowNumbers.length) return

    const meta = await sheets.spreadsheets.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        fields: "sheets.properties(sheetId,title)",
    })
    const tab = (meta.data.sheets || []).find((t) => t.properties.title === SHEET_TAB)
    if (!tab) return

    const first = Math.min(...rowNumbers)
    const last = Math.max(...rowNumbers)

    await sheets.spreadsheets.batchUpdate({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        requestBody: {
            requests: [
                {
                    repeatCell: {
                        range: {
                            sheetId: tab.properties.sheetId,
                            startRowIndex: first - 1, // 0-based
                            endRowIndex: last,        // exclusive
                        },
                        cell: {
                            userEnteredFormat: {
                                backgroundColor: { red: 1, green: 1, blue: 1 },
                                textFormat: {
                                    bold: false,
                                    foregroundColor: { red: 0, green: 0, blue: 0 },
                                },
                            },
                        },
                        fields:
                            "userEnteredFormat(backgroundColor,textFormat(bold,foregroundColor))",
                    },
                },
            ],
        },
    })
}

async function setStatusForRows(sheets, rowNumbers, status) {
    if (!rowNumbers.length) return 0
    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        requestBody: {
            valueInputOption: "RAW",
            data: rowNumbers.map((rowNumber) => ({
                range: `${SHEET_TAB}!${STATUS_COLUMN_LETTER}${rowNumber}`,
                values: [[status]],
            })),
        },
    })
    return rowNumbers.length
}

// ★ Stripe Checkout in the same language as the booking. "auto" would follow
// the customer's BROWSER, which is often not the language they were reading
// the site in — a German-speaking parent with an English browser would get an
// English checkout after booking in German.
const STRIPE_LOCALES = { en: "en", fr: "fr", de: "de", pt: "pt" }

function stripeLocale(language) {
    const code = String(language || "").trim().toLowerCase().slice(0, 2)
    return STRIPE_LOCALES[code] || "auto"
}

/* ---------------- Handler ---------------- */

const MAX_TOTAL_EUR = toNumber(process.env.MAX_BOOKING_TOTAL_EUR, 5000)
const CONFIRMATION_PATH = process.env.CONFIRMATION_PATH || "/confirmation-page"

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" }
    }
    if (event.httpMethod !== "POST") {
        return json(405, { error: "Method not allowed" })
    }

    try {
        const {
            camp, campTitle, location, dateRange, startDate, endDate, ageRange,
            dropOffTime, pickUpTime, children, tripGuests, contact, total,
            addOnsIncluded, totalSpots, tripTotalSpots, language,
            campStartISO, campEndISO, consents, discountCode, referral,
            sport, venueAddress, goodToKnow, pageUrl,
        } = JSON.parse(event.body || "{}")

        // ★ A booking has camp children, trip guests, or both. Trip tickets
        // only (Trip_Booking_form) = no children and at least one guest.
        const guestList = Array.isArray(tripGuests) ? tripGuests : []
        if (!camp || !Array.isArray(children) || !contact) {
            return json(400, { error: "Missing camp, children, or contact details" })
        }
        if (children.length === 0 && guestList.length === 0) {
            return json(400, { error: "Missing camp, children, or contact details" })
        }
        if (guestList.some((g) => !g || !String(g.firstName || "").trim() || !String(g.lastName || "").trim())) {
            return json(400, { error: "Missing trip guest name" })
        }
        const tripOnly = children.length === 0
        if (!contact.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(contact.email))) {
            return json(400, { error: "A valid contact email is required" })
        }

        const amount = toNumber(total, NaN)
        // €0 is allowed only for a booking made free by a FREE code — checked
        // below, once the code has been looked up.
        if (!isFinite(amount) || amount < 0 || amount > MAX_TOTAL_EUR) {
            return json(400, { error: "Invalid booking total" })
        }

        // ★ The two required declarations (Terms; photos and videos) are
        // checked here too, not only in the form, so a booking can never be
        // created without them.
        // Trip tickets only: no child takes part, so only the Terms apply.
        if (!consents || consents.terms !== true || (!tripOnly && consents.photosWhatsapp !== true)) {
            return json(400, { error: "consentRequired" })
        }

        // ★ Every child must be at least MIN_AGE on the first camp day (today
        // if the camp date is missing). Checked here, not only in the form.
        const ageRefISO = /^\d{4}-\d{2}-\d{2}$/.test(String(campStartISO || ""))
            ? String(campStartISO)
            : todayISOLuxembourg()
        for (const child of children) {
            // Club is required ("/" when the child has none).
            if (!child || !String(child.club || "").trim()) {
                return json(400, { error: "missingClub" })
            }
            const age = ageOn(child && child.dob, ageRefISO)
            if (age === null) {
                return json(400, { error: "invalidDateOfBirth" })
            }
            if (age < MIN_AGE) {
                return json(400, { error: "childTooYoung", minAge: MIN_AGE })
            }
        }

        const heardAboutUs = referralText(referral)

        const guests = guestList
        const bookingId = randomUUID()
        const sheets = await getSheet()
        const allRows = await getAllRows(sheets)

        // ★ A discount code is checked again here, against the Sheet, so an
        // expired, inactive, used-up or made-up code never gets through.
        let appliedCode = ""
        let freeTicketCode = false
        // Codes only apply to camp fees, so a trip-only booking ignores them
        // (and never uses up a limited code).
        if (!tripOnly && normaliseCode(discountCode)) {
            const found = await lookupDiscount(sheets, discountCode, allRows)
            if (!found) {
                return json(400, { error: "invalidDiscountCode" })
            }
            appliedCode = found.code
            freeTicketCode = found.freeTicket === true
        }
        if (amount === 0 && !freeTicketCode) {
            return json(400, { error: "Invalid booking total" })
        }

        /* --- 1. Early capacity check (friendly, not the real guard) --- */

        if (totalSpots) {
            const remaining =
                Number(totalSpots) - countBookedSpots(allRows, camp, ROLE_PARTICIPANT)
            if (children.length > remaining) {
                return json(409, {
                    error: "notEnoughSpots",
                    remaining: Math.max(0, remaining),
                })
            }
        }
        if (tripTotalSpots && guests.length > 0) {
            const remaining =
                Number(tripTotalSpots) - countBookedSpots(allRows, camp, ROLE_JOINER)
            if (guests.length > remaining) {
                return json(409, {
                    error: "notEnoughTripSpots",
                    remaining: Math.max(0, remaining),
                })
            }
        }

        /* --- 2. Build the rows --- */

        const bookingReference = makeBookingReference(allRows)
        const createdAt = new Date().toISOString()

        // Add-ons past their deadline are not charged, so they must not be
        // recorded either.
        const addOnsCount = addOnsIncluded !== false

        const personAmounts = allocatePersonAmounts([...children, ...guests], amount)
        const childAmounts = personAmounts.slice(0, children.length)
        const guestAmounts = personAmounts.slice(children.length)

        const participantRows = children.map((child, i) => [
            bookingId, createdAt, camp,
            child.firstName || "", child.lastName || "", child.dob || "",
            child.club || "", child.allergies || "",
            (addOnsCount && child.addOns && child.addOns.clothingQty) || 0,
            (addOnsCount && child.addOns && child.addOns.clothingSize) || "",
            (addOnsCount && child.addOns && child.addOns.bottleQty) || 0,
            addOnsCount && child.addOns && child.addOns.meals ? "Yes" : "No",
            contact.parentName || "", contact.email || "", contact.phone || "",
            childAmounts[i], "pending", language || "en",
            ROLE_PARTICIPANT,
            location || "", dateRange || "", ageRange || "",
            bookingReference, startDate || "", endDate || "",
            child.position || "",
            appliedCode,
            heardAboutUs,
        ])

        const joinerRows = guests.map((guest, i) => [
            bookingId, createdAt, camp,
            guest.firstName || "", guest.lastName || "", "",
            "", "",
            0, "", 0, "No",
            contact.parentName || "", contact.email || "", contact.phone || "",
            guestAmounts[i], "pending", language || "en",
            ROLE_JOINER,
            location || "", dateRange || "", ageRange || "",
            bookingReference, startDate || "", endDate || "",
            // ★ Column Z ("Position" for children) holds the trip ticket
            // type for trip guests: Adult or Child.
            String(guest.ticketType || "").trim().toLowerCase() === "child" ? "Child" : "Adult",
            appliedCode,
            heardAboutUs,
        ])

        /* --- 3. Claim the seats, then verify we won the race --- */
        // Sheets has no locks. Write first, then re-read: if someone else's
        // rows landed above ours, we lost, release ours and return 409.
        // Append assigns row numbers in order, so exactly one request wins.

        const appendRes = await sheets.spreadsheets.values.append({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
            range: DATA_RANGE,
            valueInputOption: "RAW", // not USER_ENTERED: "+352..." must stay text
            insertDataOption: "INSERT_ROWS",
            requestBody: { values: [...participantRows, ...joinerRows] },
        })

        const updatedRange =
            (appendRes.data && appendRes.data.updates && appendRes.data.updates.updatedRange) || ""

        // ★ Our rows are found by Booking ID, never by the row numbers the
        // append reported. The cleanup job deletes abandoned rows, which moves
        // every row beneath them up — a row number from a second ago may
        // already point at someone else's booking.
        function findOurRows(rows) {
            return rows
                .filter((r) => r.data[COL.bookingId] === bookingId)
                .map((r) => r.rowNumber)
        }

        async function releaseSeats() {
            try {
                const fresh = await getAllRows(sheets)
                await setStatusForRows(sheets, findOurRows(fresh), "released")
            } catch (e) {
                console.error("[create-booking] could not release rows:", e.message)
            }
        }

        const afterRows = await getAllRows(sheets)
        const ourRowNumbers = findOurRows(afterRows)
        const firstRow = ourRowNumbers.length ? Math.min(...ourRowNumbers) : null

        if (firstRow !== null) {

            if (totalSpots) {
                const takenBefore = countBookedSpots(afterRows, camp, ROLE_PARTICIPANT, firstRow)
                const remaining = Number(totalSpots) - takenBefore
                if (children.length > remaining) {
                    await releaseSeats()
                    console.log(`[create-booking] lost camp race for "${camp}" at row ${firstRow}`)
                    return json(409, {
                        error: "notEnoughSpots",
                        remaining: Math.max(0, remaining),
                    })
                }
            }

            if (tripTotalSpots && guests.length > 0) {
                const takenBefore = countBookedSpots(afterRows, camp, ROLE_JOINER, firstRow)
                const remaining = Number(tripTotalSpots) - takenBefore
                if (guests.length > remaining) {
                    await releaseSeats()
                    console.log(`[create-booking] lost trip race for "${camp}" at row ${firstRow}`)
                    return json(409, {
                        error: "notEnoughTripSpots",
                        remaining: Math.max(0, remaining),
                    })
                }
            }
        } else {
            console.error(
                `[create-booking] booking ${bookingId} not found after append ` +
                `(range "${updatedRange}") — capacity verified only before the write`
            )
        }

        // Purely cosmetic, so it never blocks or fails the booking. Runs in
        // parallel with the Stripe call below. The cleanup job never deletes
        // rows younger than 2 minutes, so these row numbers can't shift.
        const formatting = resetRowFormatting(sheets, ourRowNumbers).catch((e) =>
            console.error("[create-booking] could not reset row formatting:", e.message)
        )

        /* --- 4. Stripe Checkout --- */

        const siteUrl = (process.env.SITE_URL || "https://www.sportsevolution.lu").replace(/\/$/, "")

        // Stripe rejects expires_at unless it is MORE than 30 minutes ahead,
        // so a plain 30-minute hold fails by a fraction of a second. One extra
        // minute of slack keeps it valid.
        const expiryMinutes = Math.max(PENDING_HOLD_MINUTES, 31)
        const expiresAt = Math.floor(Date.now() / 1000) + expiryMinutes * 60

        const metadata = {
            bookingId,
            bookingReference,
            discountCode: appliedCode,
            dropOffTime: dropOffTime || "",
            pickUpTime: pickUpTime || "",
            // ISO dates (YYYY-MM-DD) ride along so the confirmation email and
            // page can build "add to calendar" links without re-parsing a
            // human date like "20 October 2026".
            campStartISO: campStartISO || "",
            campEndISO: campEndISO || "",
            // ★ For the "Camps" tab and the camp-info email (7 days before).
            // Stripe caps metadata values at 500 characters.
            sport: metaText(sport, 40),
            location: metaText(location, 120),
            venueAddress: metaMultiline(venueAddress, 300),
            // "Good to know" from the camp page, line breaks kept, in up to
            // three 500-character parts (Stripe's limit per value).
            ...goodToKnowParts(goodToKnow),
            // ★ The camp page (only our own website), for the "share with
            // friends" link on the confirmation page.
            pageUrl: campPageUrl(pageUrl),
        }

        let session
        try {
            session = await stripe.checkout.sessions.create({
                mode: "payment",
                // Cards only. Setting this explicitly overrides whatever is
                // switched on in the Stripe Dashboard, so Bancontact, iDEAL,
                // SEPA and the rest never appear at checkout.
                payment_method_types: ["card"],
                customer_email: contact.email,
                client_reference_id: bookingReference,
                expires_at: expiresAt,
                line_items: [
                    {
                        price_data: {
                            currency: "eur",
                            product_data: { name: `${camp} — ${bookingReference}` },
                            unit_amount: Math.round(amount * 100),
                        },
                        quantity: 1,
                    },
                ],
                metadata,
                // Refunds arrive as charge events, so the PaymentIntent needs
                // the booking id too. A €0 booking (FREE code) has no payment
                // and so no PaymentIntent: Stripe completes it as a no-cost
                // order and the webhook confirms it like any other booking.
                ...(amount > 0
                    ? { payment_intent_data: { metadata: { bookingId, bookingReference } } }
                    : {}),
                success_url: `${siteUrl}${CONFIRMATION_PATH}?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: siteUrl,
                locale: stripeLocale(language),
            })
        } catch (stripeErr) {
            // Seats are already claimed — hand them straight back.
            await releaseSeats()
            throw stripeErr
        }

        console.log(
            `[create-booking] ${bookingReference} — "${camp}", ` +
            `${participantRows.length} participant(s), ${joinerRows.length} joiner(s), ` +
            `€${amount}, session ${session.id}`
        )

        await formatting

        // ★ The confirmation link is returned too, so the booking form can send
        // the parent there itself if Stripe's own redirect never happens
        // (in-app browsers and some wallet flows on phones can drop it).
        return json(200, {
            checkoutUrl: session.url,
            bookingReference,
            sessionId: session.id,
            confirmationUrl: `${siteUrl}${CONFIRMATION_PATH}?session_id=${session.id}`,
        })
    } catch (err) {
        // The message is returned as well as logged, so a failing booking can
        // be diagnosed from the browser console during setup.
        console.error("[create-booking] failed:", err)
        return json(500, {
            error: "Could not create booking",
            message: err && err.message,
        })
    }
}
