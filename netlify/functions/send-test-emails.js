// netlify/functions/send-test-emails.js
//
// Sends test emails, built with the exact templates of the real emails, to
// ADMIN_NOTIFY_EMAIL (info@sportsevolution.lu). Never to anyone else.
//
//   /api/send-test-emails?key=YOUR_KEY                     all three emails
//   /api/send-test-emails?key=YOUR_KEY&type=confirmation   booking confirmation
//   /api/send-test-emails?key=YOUR_KEY&type=info           camp-info email (7 days before)
//   /api/send-test-emails?key=YOUR_KEY&type=feedback       feedback email (day after the camp)
//   /api/send-test-emails?key=YOUR_KEY&type=reminder       feedback reminder (3 days later)
//   /api/send-test-emails?key=YOUR_KEY&type=refund         refund email (partial refund example)
//   /api/send-test-emails?key=YOUR_KEY&type=waitlist       waiting-list offer (12 hours to book)
//   add &lang=fr, &lang=de or &lang=pt for another language (default: en)
//
// Sample family (fake names), real camp details from the "Overview" /
// "Camp details" tabs when available. The camp-info test has no WhatsApp
// link. The feedback test's stars open the feedback page in demo mode
// (nothing is saved).
//
// Switched off unless the Netlify variable TEST_EMAIL_KEY is set, and the
// key in the link must match it. Remove the variable to switch it off again.

const webhook = require("./stripe-webhook.js")._internal
const campInfo = require("./send-camp-info.js")._internal
const feedbackMail = require("./send-feedback-email.js")._internal
const waitlistMail = require("./waitlist-offers.js")._internal
const { google } = require("googleapis")

const TO = String(process.env.ADMIN_NOTIFY_EMAIL || "info@sportsevolution.lu")
    .split(",").map((s) => s.trim()).filter(Boolean)
const REPLY_TO = process.env.RESEND_REPLY_TO || "info@sportsevolution.lu"
const TYPES = ["confirmation", "info", "feedback", "reminder", "refund", "waitlist"]
const DEFAULT_TYPES = ["confirmation", "info", "feedback"] // sent when no type is given
const LANGS = ["en", "fr", "de", "pt"]
const LOCALES = { en: "en-GB", fr: "fr-FR", de: "de-DE", pt: "pt-PT" }

function page(status, message) {
    return {
        statusCode: status,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:Arial,sans-serif;padding:24px;max-width:560px">${message}</body>`,
    }
}

function esc(v) {
    return String(v === undefined || v === null ? "" : v)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

// First upcoming camp from the Overview + Camp details tabs; falls back to
// the Mamer camp as published on the website.
async function sampleCamp() {
    const fallback = {
        name: "Mamer (football) · December", location: "Mamer", sport: "football",
        start: "2026-12-28", end: "2026-12-31", dropOff: "08:30", pickUp: "16:00",
        address: "Hall Sportif Nicolas Frantz\n1, rue de Bertrange\nL-8216 Mamer",
        goodToKnow: "This camp will take place inside a sports hall. Therfore, please bring indoor football shoes and your waterbottle with you. You can fill it up at the spot.",
    }
    try {
        const auth = new google.auth.JWT(
            process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, null,
            (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
            ["https://www.googleapis.com/auth/spreadsheets"]
        )
        const sheets = google.sheets({ version: "v4", auth })
        const get = async (range) => {
            try {
                const r = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range })
                return (r.data.values || []).slice(1)
            } catch (e) { return [] }
        }
        const list = await get("'Overview'!A:F")
        const details = await get("'Camp details'!A:E")
        const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Luxembourg", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
        const row = list
            .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(String(r[4] || "")) && String(r[5] || r[4]) >= today && !/^TEST\b/.test(String(r[0] || "")))
            .sort((a, b) => String(a[4]).localeCompare(String(b[4])))[0]
        if (!row) return fallback
        const d = details.find((x) => String(x[0] || "").trim() === String(row[0]).trim()) || []
        return {
            name: row[0], location: row[2] || fallback.location, sport: row[3] || "football",
            start: row[4], end: row[5] || row[4],
            dropOff: d[1] || fallback.dropOff, pickUp: d[2] || fallback.pickUp,
            address: d[3] || "", goodToKnow: d[4] || "",
        }
    } catch (err) {
        return fallback
    }
}

function rangeText(camp, lang) {
    const f = (iso, o) => new Intl.DateTimeFormat(LOCALES[lang], { timeZone: "UTC", ...o }).format(new Date(`${iso}T00:00:00Z`))
    return camp.start.slice(0, 7) === camp.end.slice(0, 7)
        ? `${f(camp.start, { day: "numeric" })}–${f(camp.end, { day: "numeric", month: "long", year: "numeric" })}`
        : `${f(camp.start, { day: "numeric", month: "long" })} – ${f(camp.end, { day: "numeric", month: "long", year: "numeric" })}`
}

async function sendConfirmation(camp, lang) {
    const C = webhook.COL
    const range = rangeText(camp, lang)
    const row = (first, last, extra) => {
        const r = new Array(28).fill("")
        Object.assign(r, {
            [C.camp]: camp.name, [C.firstName]: first, [C.lastName]: last,
            [C.parentName]: "Anna Martin", [C.email]: TO[0], [C.status]: "paid",
            [C.language]: lang, [C.role]: "Participant", [C.venue]: camp.location,
            [C.campDateRange]: range, [C.ageRange]: "8–15", [C.bookingReference]: "SE-TEST-0001",
        }, extra)
        return { data: r }
    }
    const matches = [
        row("Léa", "Martin", { [C.clothingQty]: 1, [C.clothingSize]: "M", [C.bottleQty]: 1, [C.meals]: "Yes" }),
        row("Tom", "Martin", { [C.clothingQty]: 1, [C.clothingSize]: "S" }),
    ]
    const meta = {
        campStartISO: camp.start, campEndISO: camp.end, dropOffTime: camp.dropOff,
        pickUpTime: camp.pickUp, sport: camp.sport, location: camp.location, venueAddress: camp.address,
    }
    const t = webhook.T[lang] || webhook.T.en
    const calendarEvent = webhook.buildCalendarEvent(matches, meta, t)
    const html = webhook.buildConfirmationHtml(matches, meta.dropOffTime, meta.pickUpTime, t, 410.05, calendarEvent, meta)
    await webhook.sendEmail(TO, `[TEST] ${t.subject("SE-TEST-0001")}`, html, calendarEvent, { skipBcc: true })
}

async function sendInfo(camp, lang) {
    const K = campInfo.COL, P = campInfo.CAMP
    const child = (first, last, extra) => {
        const r = new Array(29).fill("")
        Object.assign(r, { [K.firstName]: first, [K.lastName]: last }, extra)
        return r
    }
    const campRow = []
    campRow[P.name] = camp.name; campRow[P.link] = ""; campRow[P.location] = camp.location
    campRow[P.sport] = camp.sport; campRow[P.start] = camp.start; campRow[P.end] = camp.end
    campRow[P.dropOff] = camp.dropOff; campRow[P.pickUp] = camp.pickUp
    campRow[P.address] = camp.address; campRow[P.goodToKnow] = camp.goodToKnow
    const t = campInfo.T[lang] || campInfo.T.en
    const html = campInfo.buildEmail({
        t,
        parentName: "Anna Martin",
        campRow,
        link: "",
        startISO: camp.start,
        endISO: camp.end,
        participants: [
            child("Léa", "Martin", { [K.clothingQty]: 1, [K.clothingSize]: "M", [K.bottleQty]: 1, [K.meals]: "Yes" }),
            child("Tom", "Martin", { [K.clothingQty]: 1, [K.clothingSize]: "S", [K.meals]: "No" }),
        ],
        guests: [],
        reference: "SE-TEST-0001",
        location: camp.location,
        sportKey: String(camp.sport).toLowerCase(),
    })
    await campInfo.sendEmail(TO, `[TEST] ${t.subject(camp.location)}`, html, REPLY_TO)
}

async function sendReminder(camp, lang) {
    const pageUrl = String(process.env.FEEDBACK_PAGE_URL ||
        (process.env.SITE_URL ? `${String(process.env.SITE_URL).replace(/\/$/, "")}/feedback` : "https://www.sportsevolution.lu/feedback"))
    const sep = pageUrl.includes("?") ? "&" : "?"
    const t = feedbackMail.T[lang] || feedbackMail.T.en
    const html = feedbackMail.buildEmail({
        t,
        parentName: "Anna Martin",
        children: ["Léa", "Tom"],
        location: camp.location,
        starHref: (n) => `${pageUrl}${sep}t=demo&fun=${n}${lang === "en" ? "" : `&lang=${lang}`}`,
        reminder: true,
    })
    await campInfo.sendEmail(TO, `[TEST] ${t.reminderSubject(camp.location)}`, html, REPLY_TO)
}

async function sendRefund(camp, lang) {
    const C = webhook.COL
    const first = new Array(28).fill("")
    Object.assign(first, {
        [C.camp]: camp.name, [C.parentName]: "Anna Martin", [C.email]: TO[0], [C.language]: lang,
        [C.venue]: camp.location, [C.campDateRange]: rangeText(camp, lang), [C.bookingReference]: "SE-TEST-0001",
    })
    const t = webhook.T[lang] || webhook.T.en
    const r = webhook.REFUND_T[lang] || webhook.REFUND_T.en
    // Example: €25.90 (one clothing set) refunded from a €410.05 booking.
    const html = webhook.buildRefundHtml({ first, t, r, refundCents: 2590, charge: { amount: 41005, amount_refunded: 2590 }, isFull: false })
    await webhook.sendEmail(TO, `[TEST] ${r.subject("SE-TEST-0001")}`, html, null, { skipBcc: true, replyTo: REPLY_TO })
}

async function sendWaitlist(camp, lang) {
    const t = waitlistMail.T[lang] || waitlistMail.T.en
    const page = String(process.env.SITE_URL || "https://www.sportsevolution.lu").replace(/\/$/, "") + "/camps"
    const html = waitlistMail.buildOfferEmail({
        t,
        name: "Anna Martin",
        location: camp.location,
        children: 2,
        deadline: waitlistMail.deadlineText(Date.now() + 12 * 3600000, lang),
        link: page,
    })
    await waitlistMail.sendEmail(TO, `[TEST] ${t.subject(camp.location, 2)}`, html)
}

async function sendFeedback(camp, lang) {
    const pageUrl = String(process.env.FEEDBACK_PAGE_URL ||
        (process.env.SITE_URL ? `${String(process.env.SITE_URL).replace(/\/$/, "")}/feedback` : "https://www.sportsevolution.lu/feedback"))
    const sep = pageUrl.includes("?") ? "&" : "?"
    const t = feedbackMail.T[lang] || feedbackMail.T.en
    const html = feedbackMail.buildEmail({
        t,
        parentName: "Anna Martin",
        children: ["Léa", "Tom"],
        location: camp.location,
        // Demo mode: the page shows sample data and saves nothing.
        starHref: (n) => `${pageUrl}${sep}t=demo&fun=${n}${lang === "en" ? "" : `&lang=${lang}`}`,
    })
    await campInfo.sendEmail(TO, `[TEST] ${t.subject(camp.location)}`, html, REPLY_TO)
}

const NAMES = { confirmation: "confirmation", info: "camp info", feedback: "feedback", reminder: "feedback reminder", refund: "refund", waitlist: "waiting-list offer" }

exports.handler = async (event) => {
    const q = event.queryStringParameters || {}
    const expected = String(process.env.TEST_EMAIL_KEY || "")
    if (!expected) return page(404, "Test emails are switched off (TEST_EMAIL_KEY is not set in Netlify).")
    if (String(q.key || "") !== expected) return page(403, "Wrong or missing key.")

    const type = String(q.type || "all").toLowerCase()
    if (type !== "all" && !TYPES.includes(type)) {
        return page(400, "Unknown type. Use <strong>confirmation</strong>, <strong>info</strong>, <strong>feedback</strong>, <strong>reminder</strong>, <strong>refund</strong>, <strong>waitlist</strong>, or leave it out for the first three.")
    }
    const lang = LANGS.includes(String(q.lang || "").toLowerCase()) ? String(q.lang).toLowerCase() : "en"
    const which = type === "all" ? DEFAULT_TYPES : [type]

    const camp = await sampleCamp()
    const sent = []
    const failed = []
    for (const w of which) {
        try {
            if (w === "confirmation") await sendConfirmation(camp, lang)
            if (w === "info") await sendInfo(camp, lang)
            if (w === "feedback") await sendFeedback(camp, lang)
            if (w === "reminder") await sendReminder(camp, lang)
            if (w === "refund") await sendRefund(camp, lang)
            if (w === "waitlist") await sendWaitlist(camp, lang)
            sent.push(NAMES[w])
        } catch (err) {
            console.error(`[test-emails] ${w} failed:`, err)
            failed.push(`${NAMES[w]}: ${err.message}`)
        }
    }

    console.log(`[test-emails] sent: ${sent.join(", ") || "none"} (${lang}) to ${TO.join(", ")} — camp: ${camp.name}`)
    const okHtml = sent.length
        ? `<h2>Sent ✓</h2><p>${esc(sent.join(", "))} test email${sent.length > 1 ? "s" : ""} (${esc(lang.toUpperCase())}) went to <strong>${esc(TO.join(", "))}</strong>.</p><p>Camp used: ${esc(camp.name)}${camp.address ? "" : " — no address in the Camp details tab yet, so only the town is shown"}.</p>`
        : ""
    const failHtml = failed.length ? `<h2>Not sent</h2><ul>${failed.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""
    return page(failed.length && !sent.length ? 500 : 200, okHtml + failHtml)
}
