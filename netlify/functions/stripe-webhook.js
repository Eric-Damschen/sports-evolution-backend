// netlify/functions/stripe-webhook.js
//
// Self-contained on purpose: no shared module to misplace.
// Stripe calls this endpoint directly. It is the ONLY place that emails.
//
//   checkout.session.completed / async_payment_succeeded
//        -> Sheet rows go pending -> paid, confirmation email sent
//   checkout.session.expired   -> rows released, seats back on sale
//   charge.refunded            -> rows refunded / partially refunded
//
// Always returns 200 once the signature verifies, so Stripe never retries a
// payment that already went through. Failures show up in the Netlify logs.

const { google } = require("googleapis")
const Stripe = require("stripe")

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

// The Netlify variable is STRIPE_WEBHOOK_SECRET_KEY. Reading only the more
// common STRIPE_WEBHOOK_SECRET gives an empty secret, which fails signature
// verification every time and looks exactly like a wrong secret.
const WEBHOOK_SECRET =
    process.env.STRIPE_WEBHOOK_SECRET_KEY || process.env.STRIPE_WEBHOOK_SECRET || ""

const COL = {
    bookingId: 0, createdAt: 1, camp: 2, firstName: 3, lastName: 4, dob: 5,
    club: 6, allergies: 7, clothingQty: 8, clothingSize: 9, bottleQty: 10,
    meals: 11, parentName: 12, email: 13, phone: 14, bookingTotal: 15,
    status: 16, language: 17, role: 18,
    venue: 19, campDateRange: 20, ageRange: 21,
    bookingReference: 22, startDate: 23, endDate: 24,
}
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Bookings"
const DATA_RANGE = `${SHEET_TAB}!A:Y`
const STATUS_COLUMN_LETTER = "Q"

const ROLE_PARTICIPANT = "Participant"
const ROLE_JOINER = "Joiner"

/* ---------------- Sheets ---------------- */

async function getSheet() {
    const auth = new google.auth.JWT(
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        null,
        (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
        ["https://www.googleapis.com/auth/spreadsheets"]
    )
    return google.sheets({ version: "v4", auth })
}

// Row 1 is the header, so rowNumber === index + 1.
async function findBookingRows(sheets, bookingId) {
    const result = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: DATA_RANGE,
    })
    const rows = result.data.values || []
    const matches = []
    rows.forEach((row, i) => {
        if (row[COL.bookingId] === bookingId) matches.push({ rowNumber: i + 1, data: row })
    })
    return matches
}

async function setStatus(sheets, matches, status) {
    if (!matches.length) return 0
    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        requestBody: {
            valueInputOption: "RAW",
            data: matches.map(({ rowNumber }) => ({
                range: `${SHEET_TAB}!${STATUS_COLUMN_LETTER}${rowNumber}`,
                values: [[status]],
            })),
        },
    })
    return matches.length
}

function statusOf(match) {
    return String(match.data[COL.status] || "").trim().toLowerCase()
}

function toNumber(value, fallback = 0) {
    const n = Number(String(value).replace(",", "."))
    return isFinite(n) ? n : fallback
}

// Column P is per person, so the order total is the sum of the rows.
function sumRowTotals(matches) {
    const cents = matches.reduce(
        (acc, m) => acc + Math.round(toNumber(m.data[COL.bookingTotal], 0) * 100),
        0
    )
    return cents / 100
}

function esc(value) {
    return String(value === undefined || value === null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
}

/* ---------------- Handler ---------------- */

exports.handler = async (event) => {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method not allowed" }
    }

    const sig = event.headers["stripe-signature"] || event.headers["Stripe-Signature"]

    // Signature verification needs the EXACT bytes Stripe sent. Some Netlify
    // deployments expose them as event.rawBody, others base64-encode the body.
    let payload
    if (event.rawBody) {
        payload = event.rawBody
    } else if (event.isBase64Encoded) {
        payload = Buffer.from(event.body, "base64")
    } else {
        payload = event.body
    }

    if (!WEBHOOK_SECRET) {
        console.error("[webhook] STRIPE_WEBHOOK_SECRET_KEY is not set in this deploy context")
        return { statusCode: 400, body: "Webhook secret not configured" }
    }

    let stripeEvent
    try {
        stripeEvent = stripe.webhooks.constructEvent(payload, sig, WEBHOOK_SECRET)
    } catch (err) {
        console.error(
            `[webhook] signature verification FAILED: ${err.message} — ` +
            `hasRawBody: ${!!event.rawBody}, isBase64Encoded: ${!!event.isBase64Encoded}, ` +
            `bodyLength: ${event.body ? event.body.length : 0}, sigPresent: ${!!sig}, ` +
            `secretPrefix: ${WEBHOOK_SECRET.slice(0, 8)}, secretLength: ${WEBHOOK_SECRET.length}`
        )
        return { statusCode: 400, body: `Webhook Error: ${err.message}` }
    }

    console.log(`[webhook] verified ${stripeEvent.type} (${stripeEvent.id})`)

    try {
        if (
            stripeEvent.type === "checkout.session.completed" ||
            stripeEvent.type === "checkout.session.async_payment_succeeded"
        ) {
            await handlePaid(stripeEvent.data.object)
        } else if (stripeEvent.type === "checkout.session.expired") {
            await handleExpired(stripeEvent.data.object)
        } else if (stripeEvent.type === "charge.refunded") {
            await handleRefund(stripeEvent.data.object)
        }
    } catch (err) {
        // Swallowed on purpose: the payment succeeded, Stripe must not retry.
        console.error("[webhook] processing failed (still returning 200):", err)
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) }
}

/* ---------------- Paid ---------------- */

async function handlePaid(session) {
    const metadata = session.metadata || {}
    const bookingId = metadata.bookingId

    if (!bookingId) {
        console.error(`[webhook] session ${session.id} carries no bookingId — ignoring`)
        return
    }
    if (session.payment_status && session.payment_status !== "paid") {
        console.log(`[webhook] ${bookingId} not paid yet (${session.payment_status})`)
        return
    }

    const sheets = await getSheet()
    const matches = await findBookingRows(sheets, bookingId)

    if (!matches.length) {
        console.error(`[webhook] no sheet rows for booking ${bookingId}`)
        return
    }

    const statuses = matches.map(statusOf)

    // A refund already happened — a late redelivery must not undo it.
    if (statuses.some((s) => s === "refunded" || s === "partially refunded")) {
        console.log(`[webhook] ${bookingId} has been refunded — not re-marking paid`)
        return
    }
    // Stripe retries, and duplicate endpoints double-fire.
    if (statuses.every((s) => s === "paid")) {
        console.log(`[webhook] ${bookingId} already paid — not resending the email`)
        return
    }

    const updated = await setStatus(sheets, matches, "paid")
    console.log(`[webhook] ${bookingId}: ${updated} row(s) marked paid`)

    const buyerEmail =
        matches[0].data[COL.email] ||
        (session.customer_details && session.customer_details.email) ||
        session.customer_email ||
        null

    if (!buyerEmail) {
        console.error(`[webhook] ${bookingId}: no buyer address from the Sheet or Stripe`)
        return
    }

    const lang = String(matches[0].data[COL.language] || "en").slice(0, 2).toLowerCase()
    const t = T[lang] || T.en
    const amountPaid =
        typeof session.amount_total === "number" ? session.amount_total / 100 : NaN

    const calendarEvent = buildCalendarEvent(matches, metadata, t)

    await sendEmail(
        buyerEmail,
        t.subject(matches[0].data[COL.bookingReference] || ""),
        buildConfirmationHtml(
            matches,
            metadata.dropOffTime,
            metadata.pickUpTime,
            t,
            amountPaid,
            calendarEvent
        ),
        calendarEvent
    )

    console.log(`[webhook] ${bookingId}: confirmation sent to ${buyerEmail} (${lang})`)
}

/* ---------------- Expired ---------------- */

async function handleExpired(session) {
    const bookingId = (session.metadata || {}).bookingId
    if (!bookingId) return

    const sheets = await getSheet()
    const matches = await findBookingRows(sheets, bookingId)
    if (!matches.length) return

    if (matches.some((m) => statusOf(m) === "paid")) {
        console.log(`[webhook] expired event for already-paid ${bookingId} — ignoring`)
        return
    }

    const updated = await setStatus(sheets, matches, "expired")
    console.log(`[webhook] ${bookingId}: checkout abandoned, ${updated} seat(s) released`)
}

/* ---------------- Refund ---------------- */

// Full refund   -> "refunded", the place goes back on sale
// Partial refund -> "partially refunded", the place stays held
async function handleRefund(charge) {
    const bookingId = await resolveBookingId(charge)

    if (!bookingId) {
        console.error(
            `[webhook] refund on charge ${charge.id} has no bookingId and no matching session`
        )
        return
    }
    if (!charge.amount_refunded) {
        console.log(`[webhook] ${bookingId}: refund event with nothing refunded — ignoring`)
        return
    }

    const isFull = charge.refunded === true || charge.amount_refunded >= charge.amount
    const target = isFull ? "refunded" : "partially refunded"

    const sheets = await getSheet()
    const matches = await findBookingRows(sheets, bookingId)

    if (!matches.length) {
        console.error(`[webhook] no sheet rows for refunded booking ${bookingId}`)
        return
    }
    if (matches.every((m) => statusOf(m) === target)) {
        console.log(`[webhook] ${bookingId}: already "${target}"`)
        return
    }

    const updated = await setStatus(sheets, matches, target)
    console.log(
        `[webhook] ${bookingId}: refunded €${(charge.amount_refunded / 100).toFixed(2)} ` +
        `of €${(charge.amount / 100).toFixed(2)} — ${updated} row(s) "${target}"`
    )
}

// Bookings made after payment_intent_data.metadata was added carry the id on
// the charge; older ones are found via the Checkout Session.
async function resolveBookingId(charge) {
    const fromCharge = (charge.metadata || {}).bookingId
    if (fromCharge) return fromCharge
    if (!charge.payment_intent) return null

    try {
        const sessions = await stripe.checkout.sessions.list({
            payment_intent: charge.payment_intent,
            limit: 1,
        })
        const session = sessions.data && sessions.data[0]
        return (session && session.metadata && session.metadata.bookingId) || null
    } catch (err) {
        console.error("[webhook] session lookup failed for charge", charge.id, err.message)
        return null
    }
}

/* ---------------- Calendar ---------------- */

// "2026-10-20" or "20 October 2026" -> "20261020"
function toCalendarDate(value) {
    if (!value) return ""
    const s = String(value).trim()

    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
    if (iso) return `${iso[1]}${iso[2]}${iso[3]}`

    const d = new Date(s)
    if (!isNaN(d.getTime())) {
        return (
            String(d.getFullYear()) +
            String(d.getMonth() + 1).padStart(2, "0") +
            String(d.getDate()).padStart(2, "0")
        )
    }
    return ""
}

// All-day events end on the day AFTER the last day.
function nextDay(yyyymmdd) {
    if (!/^\d{8}$/.test(yyyymmdd)) return ""
    const y = Number(yyyymmdd.slice(0, 4))
    const m = Number(yyyymmdd.slice(4, 6))
    const d = Number(yyyymmdd.slice(6, 8))
    const dt = new Date(Date.UTC(y, m - 1, d + 1))
    return (
        String(dt.getUTCFullYear()) +
        String(dt.getUTCMonth() + 1).padStart(2, "0") +
        String(dt.getUTCDate()).padStart(2, "0")
    )
}

// "Rodange (football) · October 2026" -> "Rodange"
function venueFromCamp(camp) {
    const m = String(camp || "").match(/^(.*?)\s\(/)
    return m ? m[1].trim() : String(camp || "")
}

// "Rodange (football) · October 2026" -> "Football"
function sportFromCamp(camp) {
    const m = String(camp || "").match(/\(([^)]*)\)/)
    if (!m) return ""
    const sport = m[1].trim()
    return sport ? sport.charAt(0).toUpperCase() + sport.slice(1) : ""
}

// RFC 5545 wants lines folded at 75 octets. Most clients cope without it,
// stricter ones do not.
function icsFold(line) {
    if (line.length <= 73) return line
    const parts = []
    let rest = line
    parts.push(rest.slice(0, 73))
    rest = rest.slice(73)
    while (rest.length > 72) {
        parts.push(" " + rest.slice(0, 72))
        rest = rest.slice(72)
    }
    if (rest.length) parts.push(" " + rest)
    return parts.join("\r\n")
}

function buildCalendarEvent(matches, metadata, t) {
    const first = matches[0].data

    const start = toCalendarDate(metadata.campStartISO || first[COL.startDate])
    if (!start) return null

    const lastDay =
        toCalendarDate(metadata.campEndISO || first[COL.endDate]) || start
    const end = nextDay(lastDay)
    const location = first[COL.venue] || venueFromCamp(first[COL.camp])

    // Drop-off, pick-up and the good-to-know note only — no booking
    // reference, which belongs in the email body rather than in a calendar
    // entry the whole family may see.
    const details = [
        metadata.dropOffTime ? `${t.dropOff}: ${metadata.dropOffTime}` : "",
        metadata.pickUpTime
            ? `${t.pickUp}: ${t.until} ${metadata.pickUpTime}`
            : "",
        `${t.goodToKnow}: ${t.comingNext}`,
    ]
        .filter(Boolean)
        .join("\n")

    return {
        start,
        end,
        title: [sportFromCamp(first[COL.camp]) || first[COL.camp], location]
            .filter(Boolean)
            .join(" — "),
        details,
        location,
        reference: first[COL.bookingReference] || "",
    }
}

function googleCalendarUrl(ev) {
    const params = new URLSearchParams({
        action: "TEMPLATE",
        text: ev.title,
        dates: `${ev.start}/${ev.end}`,
        details: ev.details,
        location: ev.location,
    })
    return `https://calendar.google.com/calendar/render?${params.toString()}`
}

function icsEscape(s) {
    return String(s || "")
        .replace(/\\/g, "\\\\")
        .replace(/;/g, "\\;")
        .replace(/,/g, "\\,")
        .replace(/\n/g, "\\n")
}

// Apple Mail, Outlook and Gmail all offer "add to calendar" when an .ics is
// attached, so the invite travels with the email rather than as a link.
function buildIcs(ev) {
    const stamp = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, "")

    return [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Sports Evolution//Booking//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        `UID:${ev.reference || stamp}@sportsevolution.lu`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${ev.start}`,
        `DTEND;VALUE=DATE:${ev.end}`,
        `SUMMARY:${icsEscape(ev.title)}`,
        `LOCATION:${icsEscape(ev.location)}`,
        `DESCRIPTION:${icsEscape(ev.details)}`,
        "END:VEVENT",
        "END:VCALENDAR",
    ]
        .map(icsFold)
        .join("\r\n")
}

/* ---------------- Email ---------------- */

const T = {
    en: {
        subject: (ref) => `Payment confirmed — ${ref}`,
        hi: (n) => `Hi ${n},`,
        intro: "Your payment has been received and your booking is confirmed.",
        reference: "Booking reference", camp: "Camp", dates: "Dates", venue: "Venue",
        ages: "Ages", dropOff: "Drop-off", pickUp: "Pick-up", tickets: "Tickets",
        total: "Total paid", perChild: "Details per child", tripTickets: "Trip tickets",
        child: "child", children: "children", noAddOns: "No add-ons",
        clothing: "Clothing set", bottle: "Drinking bottle", meals: "Meals",
        size: "size", outro: "Thank you for your trust. See you on the court!",
        addToCalendar: "Add this camp to your calendar",
        googleCalendar: "Add to Google Calendar",
        appleCalendar: "For Apple Calendar or Outlook, open the attached invite file.",
        until: "until",
        signOff: "Kind regards,", team: "Your Sports Evolution Team",
        goodToKnow: "Good to know",
        comingNext:
            "We will send you an email with all the necessary information one week before the start of the camp.",
    },
    fr: {
        subject: (ref) => `Paiement confirmé — ${ref}`,
        hi: (n) => `Bonjour ${n},`,
        intro: "Votre paiement a bien été reçu et votre réservation est confirmée.",
        reference: "Référence de réservation", camp: "Stage", dates: "Dates", venue: "Lieu",
        ages: "Âges", dropOff: "Dépose", pickUp: "Reprise", tickets: "Places",
        total: "Montant payé", perChild: "Détails par enfant", tripTickets: "Billets sortie",
        child: "enfant", children: "enfants", noAddOns: "Aucun supplément",
        clothing: "Tenue", bottle: "Gourde", meals: "Repas",
        size: "taille", outro: "Merci pour votre confiance. À bientôt sur le terrain !",
        addToCalendar: "Ajoutez ce stage à votre agenda",
        googleCalendar: "Ajouter à Google Agenda",
        appleCalendar: "Pour Calendrier Apple ou Outlook, ouvrez le fichier d'invitation joint.",
        until: "jusqu'à",
        signOff: "Cordialement,", team: "Votre équipe Sports Evolution",
        goodToKnow: "Bon à savoir",
        comingNext:
            "Nous vous enverrons un e-mail avec toutes les informations nécessaires une semaine avant le début du stage.",
    },
    de: {
        subject: (ref) => `Zahlung bestätigt — ${ref}`,
        hi: (n) => `Hallo ${n},`,
        intro: "Ihre Zahlung ist eingegangen und Ihre Buchung ist bestätigt.",
        reference: "Buchungsreferenz", camp: "Camp", dates: "Daten", venue: "Ort",
        ages: "Alter", dropOff: "Bringen", pickUp: "Abholen", tickets: "Plätze",
        total: "Bezahlter Betrag", perChild: "Details pro Kind", tripTickets: "Ausflugstickets",
        child: "Kind", children: "Kinder", noAddOns: "Keine Extras",
        clothing: "Kleidungsset", bottle: "Trinkflasche", meals: "Mahlzeiten",
        size: "Größe", outro: "Vielen Dank für Ihr Vertrauen. Wir sehen uns auf dem Platz!",
        addToCalendar: "Termin in Ihren Kalender eintragen",
        googleCalendar: "Zu Google Kalender hinzufügen",
        appleCalendar: "Für Apple Kalender oder Outlook öffnen Sie die angehängte Termindatei.",
        until: "bis",
        signOff: "Mit freundlichen Grüßen,", team: "Ihr Sports Evolution Team",
        goodToKnow: "Gut zu wissen",
        comingNext:
            "Eine Woche vor Campbeginn senden wir Ihnen eine E-Mail mit allen notwendigen Informationen.",
    },
    pt: {
        subject: (ref) => `Pagamento confirmado — ${ref}`,
        hi: (n) => `Olá ${n},`,
        intro: "O seu pagamento foi recebido e a sua reserva está confirmada.",
        reference: "Referência da reserva", camp: "Campo", dates: "Datas", venue: "Local",
        ages: "Idades", dropOff: "Entrega", pickUp: "Recolha", tickets: "Lugares",
        total: "Total pago", perChild: "Detalhes por criança", tripTickets: "Bilhetes de excursão",
        child: "criança", children: "crianças", noAddOns: "Sem extras",
        clothing: "Conjunto de roupa", bottle: "Garrafa", meals: "Refeições",
        size: "tamanho", outro: "Obrigado pela sua confiança. Até breve no campo!",
        addToCalendar: "Adicione este campo ao seu calendário",
        googleCalendar: "Adicionar ao Google Calendar",
        appleCalendar: "Para o Calendário Apple ou Outlook, abra o ficheiro de convite em anexo.",
        until: "até",
        signOff: "Com os melhores cumprimentos,", team: "A sua equipa Sports Evolution",
        goodToKnow: "Bom saber",
        comingNext:
            "Enviaremos um e-mail com todas as informações necessárias uma semana antes do início do campo.",
    },
}

function buildConfirmationHtml(matches, dropOffTime, pickUpTime, t, amountPaid, calendarEvent) {
    const first = matches[0].data

    const orderTotal = isFinite(amountPaid)
        ? amountPaid.toFixed(2)
        : sumRowTotals(matches).toFixed(2)

    const participants = matches.filter(
        (m) => (m.data[COL.role] || ROLE_PARTICIPANT) === ROLE_PARTICIPANT
    )
    const joiners = matches.filter((m) => m.data[COL.role] === ROLE_JOINER)

    const childLines = participants
        .map(({ data }) => {
            const name = `${data[COL.firstName]} ${data[COL.lastName]}`.trim()
            const addOns = []

            const clothingQty = Number(data[COL.clothingQty]) || 0
            if (clothingQty > 0) {
                const size = data[COL.clothingSize]
                addOns.push(
                    `${esc(t.clothing)} ×${clothingQty}${size ? ` (${esc(t.size)} ${esc(size)})` : ""}`
                )
            }
            const bottleQty = Number(data[COL.bottleQty]) || 0
            if (bottleQty > 0) addOns.push(`${esc(t.bottle)} ×${bottleQty}`)
            if (data[COL.meals] === "Yes") addOns.push(esc(t.meals))

            const addOnsText = addOns.length ? addOns.join(", ") : esc(t.noAddOns)
            return `<li><strong>${esc(name)}</strong> — ${addOnsText}</li>`
        })
        .join("")

    const joinerLines = joiners
        .map(({ data }) => `<li>${esc(`${data[COL.firstName]} ${data[COL.lastName]}`.trim())}</li>`)
        .join("")

    const joinerSection = joiners.length
        ? `<p><strong>${esc(t.tripTickets)} (${joiners.length}):</strong></p><ul>${joinerLines}</ul>`
        : ""

    const countWord = participants.length === 1 ? t.child : t.children

    // ★ Google link inline; Apple/Outlook use the attached .ics.
    const calendarSection = calendarEvent
        ? `
        <p style="margin-top:22px;"><strong>${esc(t.addToCalendar)}</strong></p>
        <p style="margin:6px 0;">
            <a href="${esc(googleCalendarUrl(calendarEvent))}"
               style="display:inline-block;padding:10px 18px;border:1px solid #E6E0D8;border-radius:999px;color:#12110F;text-decoration:none;font-weight:600;">
                ${esc(t.googleCalendar)}
            </a>
        </p>
        <p style="margin:6px 0;color:#6b7280;font-size:13px;">${esc(t.appleCalendar)}</p>
    `
        : ""

    return `
        <p>${esc(t.hi(first[COL.parentName] || ""))}</p>
        <p>${esc(t.intro)}</p>
        <table cellpadding="6" style="border-collapse:collapse;">
            <tr><td><strong>${esc(t.reference)}</strong></td><td>${esc(first[COL.bookingReference])}</td></tr>
            <tr><td><strong>${esc(t.camp)}</strong></td><td>${esc(first[COL.camp])}</td></tr>
            <tr><td><strong>${esc(t.dates)}</strong></td><td>${esc(first[COL.campDateRange])}</td></tr>
            <tr><td><strong>${esc(t.venue)}</strong></td><td>${esc(first[COL.venue])}</td></tr>
            <tr><td><strong>${esc(t.ages)}</strong></td><td>${esc(first[COL.ageRange])}</td></tr>
            <tr><td><strong>${esc(t.dropOff)}</strong></td><td>${esc(dropOffTime || "")}</td></tr>
            <tr><td><strong>${esc(t.pickUp)}</strong></td><td>${esc(pickUpTime ? `${t.until} ${pickUpTime}` : "")}</td></tr>
            <tr><td><strong>${esc(t.tickets)}</strong></td><td>${participants.length} ${esc(countWord)}</td></tr>
            <tr><td><strong>${esc(t.total)}</strong></td><td>€${esc(orderTotal)}</td></tr>
        </table>
        <p><strong>${esc(t.perChild)}:</strong></p>
        <ul>${childLines}</ul>
        ${joinerSection}
        ${calendarSection}
        <p>${esc(t.outro)}</p>
        <p style="margin-top:22px;">
            ${esc(t.signOff)}<br>
            <strong>${esc(t.team)}</strong>
        </p>
    `
}

async function sendEmail(to, subject, html, calendarEvent) {
    if (!process.env.RESEND_API_KEY) {
        throw new Error("RESEND_API_KEY is not set — refusing to send with an empty token")
    }

    const body = {
        from: process.env.RESEND_FROM || "Sports Evolution <info@order.sportsevolution.lu>",
        to,
        subject,
        html,
    }
    if (process.env.RESEND_REPLY_TO) body.reply_to = process.env.RESEND_REPLY_TO
    if (process.env.RESEND_BCC) body.bcc = process.env.RESEND_BCC

    // ★ The .ics invite travels with the email. Apple Mail, Outlook and Gmail
    // all show an "add to calendar" control when they see one attached.
    if (calendarEvent) {
        body.attachments = [
            {
                filename: `${calendarEvent.reference || "camp"}.ics`,
                content: Buffer.from(buildIcs(calendarEvent), "utf8").toString("base64"),
            },
        ]
    }

    const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    })

    // fetch() does not throw on 4xx/5xx — read the body so the real reason
    // (bad key, unverified domain, bad recipient) reaches the logs.
    const resText = await res.text()
    if (!res.ok) {
        throw new Error(`Resend rejected the email — status ${res.status}: ${resText}`)
    }
    return resText
}
