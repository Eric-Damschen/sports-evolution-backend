// netlify/functions/send-feedback-email.js
//
// Self-contained on purpose: no shared module to misplace.
// Runs on a schedule (see netlify.toml, every 15 minutes).
//
// Sends every paid booking ONE thank-you email the day after its camp ends,
// with five star links. A tap opens the feedback page on the website
// (FEEDBACK_PAGE_URL) with question 1 already filled in.
//   - one email per booking (not per child), in the booking language;
//   - from 10:00 to 20:00 Luxembourg time, starting the day after the last
//     camp day; camps that ended more than 7 days ago are skipped (so old
//     camps don't get an email when this feature is switched on);
//   - the timestamp in Bookings column AD makes it one email per booking.
//
// Reminder: families who haven't pressed "Send feedback" 3 days after the
// email get ONE reminder with the same stars (same hours). Who has answered is
// read from the "Camp feedback" spreadsheet (FEEDBACK_SHEET_ID, tab
// "Responses", status "Sent").
//
// Reads:  "Bookings" tab A:AE, "Camp feedback" → "Responses"
// Writes: Bookings column AD "Feedback email sent" (timestamp)
//         Bookings column AE "Feedback reminder sent" (timestamp)
//
// Netlify environment variables:
//   FEEDBACK_SECRET          required — long random text; signs the links
//   FEEDBACK_PAGE_URL        optional — default SITE_URL + "/feedback"
//   FEEDBACK_EMAIL_DRY_RUN   optional — "true": only log, send/write nothing

const { google } = require("googleapis")
const crypto = require("crypto")

const COL = {
    bookingId: 0, camp: 2, firstName: 3,
    clothingQty: 8, meals: 11, parentName: 12, email: 13, status: 16,
    language: 17, role: 18, venue: 19, startDate: 23, endDate: 24,
    feedbackSent: 29, // AD
    reminderSent: 30, // AE
}
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Bookings"
const BOOKINGS_RANGE = `${SHEET_TAB}!A:AD`
const BOOKINGS_RANGE_WITH_REMINDER = `${SHEET_TAB}!A:AE`
const FEEDBACK_SENT_LETTER = "AD"
const REMINDER_SENT_LETTER = "AE"
const REMINDER_AFTER_HOURS = 72  // 3 days after the feedback email
const REMINDER_UNTIL_DAYS = 10   // no reminder once the email is older than this

const ROLE_PARTICIPANT = "Participant"
const SENDABLE_STATUSES = ["paid", "partially refunded"]

const SEND_FROM_HOUR = 10      // Luxembourg time, inclusive
const SEND_UNTIL_HOUR = 20     // Luxembourg time, exclusive
const MAX_DAYS_AFTER = 7       // don't send for camps that ended longer ago
const TIME_BUDGET_MS = 20000   // scheduled functions have ~30 s
const PAUSE_BETWEEN_EMAILS_MS = 600

const DRY_RUN = String(process.env.FEEDBACK_EMAIL_DRY_RUN || "").toLowerCase() === "true"
const REPLY_TO = process.env.RESEND_REPLY_TO || "info@sportsevolution.lu"
const ASSET_BASE = String(process.env.EMAIL_ASSET_BASE || process.env.URL || "").replace(/\/$/, "")

// Web fonts for the emails (files in email/fonts/ of this repo). Apple Mail,
// iPhone Mail, Outlook for Mac/iOS and Samsung Mail show them; Gmail and
// Outlook for Windows show Arial instead. "@media screen" keeps Outlook for
// Windows from falling back to Times New Roman.
function emailFontCss(base) {
    if (!base) return ""
    const f = (family, weight, file) =>
        `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};src:url(${base}/email/fonts/${file}) format('woff2');}`
    return `<style>@media screen{${f("Space Grotesk", 700, "space-grotesk-700.woff2")}${f("IBM Plex Sans", 400, "ibm-plex-sans-400.woff2")}${f("IBM Plex Sans", 600, "ibm-plex-sans-600.woff2")}${f("IBM Plex Sans", 700, "ibm-plex-sans-700.woff2")}}</style>`
}
const LOGO_FILE = String(process.env.EMAIL_LOGO_FILE || "email/se-logo-long.png").replace(/^\//, "")
const FEEDBACK_PAGE_URL = String(
    process.env.FEEDBACK_PAGE_URL ||
    (process.env.SITE_URL ? `${String(process.env.SITE_URL).replace(/\/$/, "")}/feedback` : "")
)

/* ---------------- Small helpers ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function esc(value) {
    return String(value === undefined || value === null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
}

function luxNow() {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Luxembourg",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date())
    const get = (t) => (parts.find((p) => p.type === t) || {}).value
    return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) }
}

const MONTHS = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
    august: 8, september: 9, october: 10, november: 11, december: 12,
}

// Accepts "2026-12-28", "28/12/2026", "28.12.2026" or "28 December 2026".
function toISODate(value) {
    const s = String(value || "").trim()
    let y, m, d
    let r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
    if (r) { y = +r[1]; m = +r[2]; d = +r[3] }
    if (!r && (r = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s))) { d = +r[1]; m = +r[2]; y = +r[3] }
    if (!r && (r = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(s))) {
        d = +r[1]; m = MONTHS[r[2].toLowerCase()] || 0; y = +r[3]
    }
    if (!y || !m || !d) return ""
    const check = new Date(Date.UTC(y, m - 1, d))
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return ""
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
}

function daysBetween(a, b) {
    return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)
}

// Same token as in feedback.js: "<bookingId>.<signature>".
function feedbackToken(bookingId) {
    const sig = crypto
        .createHmac("sha256", String(process.env.FEEDBACK_SECRET || ""))
        .update(`feedback:${bookingId}`)
        .digest("base64url")
        .slice(0, 32)
    return `${bookingId}.${sig}`
}

function starUrl(bookingId, stars) {
    const sep = FEEDBACK_PAGE_URL.includes("?") ? "&" : "?"
    return `${FEEDBACK_PAGE_URL}${sep}t=${encodeURIComponent(feedbackToken(bookingId))}&fun=${stars}`
}

/* ---------------- Email texts ---------------- */

const T = {
    en: {
        subject: (loc) => `Thank you for the ${loc} camp! How did it go?`,
        hi: (n) => `Hi ${n},`,
        heading: "Thank you for an amazing camp week! 🎉",
        and: "and",
        intro: (names, loc) => `It was great to have ${names} with us in ${loc}. We hope the week was full of great memories.`,
        question: (one) => (one ? "How much did your child enjoy the camp?" : "How much did your children enjoy the camp?"),
        hint: "Tap a star. The feedback takes less than 1 minute.",
        low: "Not really", high: "Loved it!",
        star: (n) => `${n} ${n === 1 ? "star" : "stars"}`,
        alertsTitle: (loc) => `New camps in ${loc}`,
        alertsText: "Tick the box in the feedback form and we'll email you as soon as a new camp opens there.",
        outro: "Thank you for your trust. See you at the next camp!",
        reminderSubject: (loc) => `A minute for the ${loc} camp?`,
        reminderHeading: "Do you have a minute?",
        reminderIntro: (loc) => `Your feedback on the camp in ${loc} helps our coaches make every camp even better.`,
        signOff: "Kind regards,", team: "Your Sports Evolution Team",
    },
    fr: {
        subject: (loc) => `Merci pour le stage à ${loc} ! Comment ça s'est passé ?`,
        hi: (n) => `Bonjour ${n},`,
        heading: "Merci pour cette super semaine de stage ! 🎉",
        and: "et",
        intro: (names, loc, one) => `Nous étions ravis d'accueillir ${names} à ${loc}. Nous espérons que la semaine ${one ? "lui" : "leur"} a laissé plein de bons souvenirs.`,
        question: (one) => (one ? "À quel point votre enfant a-t-il apprécié le stage ?" : "À quel point vos enfants ont-ils apprécié le stage ?"),
        hint: "Touchez une étoile. Cela prend moins d'1 minute.",
        low: "Pas vraiment", high: "Adoré !",
        star: (n) => `${n} ${n === 1 ? "étoile" : "étoiles"}`,
        alertsTitle: (loc) => `Nouveaux stages à ${loc}`,
        alertsText: "Cochez la case dans le formulaire et nous vous écrirons dès qu'un nouveau stage y ouvre.",
        outro: "Merci pour votre confiance. À bientôt au prochain stage !",
        reminderSubject: (loc) => `Une minute pour le stage à ${loc} ?`,
        reminderHeading: "Vous avez une minute ?",
        reminderIntro: (loc) => `Votre avis sur le stage à ${loc} aide nos coachs à rendre chaque stage encore meilleur.`,
        signOff: "Cordialement,", team: "Votre équipe Sports Evolution",
    },
    de: {
        subject: (loc) => `Danke für das Camp in ${loc}! Wie war es?`,
        hi: (n) => `Hallo ${n},`,
        heading: "Danke für eine tolle Camp-Woche! 🎉",
        and: "und",
        intro: (names, loc) => `Es war schön, ${names} in ${loc} dabei zu haben. Wir hoffen, die Woche hat viele schöne Erinnerungen hinterlassen.`,
        question: (one) => (one ? "Wie viel Spaß hatte Ihr Kind im Camp?" : "Wie viel Spaß hatten Ihre Kinder im Camp?"),
        hint: "Tippen Sie auf einen Stern. Das Feedback dauert weniger als 1 Minute.",
        low: "Nicht wirklich", high: "Begeistert!",
        star: (n) => `${n} ${n === 1 ? "Stern" : "Sterne"}`,
        alertsTitle: (loc) => `Neue Camps in ${loc}`,
        alertsText: "Setzen Sie im Formular das Häkchen und wir schreiben Ihnen, sobald dort ein neues Camp öffnet.",
        outro: "Danke für Ihr Vertrauen. Bis zum nächsten Camp!",
        reminderSubject: (loc) => `Eine Minute für das Camp in ${loc}?`,
        reminderHeading: "Haben Sie eine Minute?",
        reminderIntro: (loc) => `Ihr Feedback zum Camp in ${loc} hilft unseren Trainern, jedes Camp noch besser zu machen.`,
        signOff: "Mit freundlichen Grüßen,", team: "Ihr Sports Evolution Team",
    },
    pt: {
        subject: (loc) => `Obrigado pelo campo em ${loc}! Como correu?`,
        hi: (n) => `Olá ${n},`,
        heading: "Obrigado por uma semana de campo fantástica! 🎉",
        and: "e",
        intro: (names, loc) => `Foi ótimo ter ${names} connosco em ${loc}. Esperamos que a semana tenha deixado muitas boas recordações.`,
        question: (one) => (one ? "Quanto é que o seu filho gostou do campo?" : "Quanto é que os seus filhos gostaram do campo?"),
        hint: "Toque numa estrela. O feedback demora menos de 1 minuto.",
        low: "Nem por isso", high: "Adorou!",
        star: (n) => `${n} ${n === 1 ? "estrela" : "estrelas"}`,
        alertsTitle: (loc) => `Novos campos em ${loc}`,
        alertsText: "Marque a caixa no formulário e enviamos-lhe um e-mail assim que abrir lá um novo campo.",
        outro: "Obrigado pela sua confiança. Até ao próximo campo!",
        reminderSubject: (loc) => `Um minuto para o campo em ${loc}?`,
        reminderHeading: "Tem um minuto?",
        reminderIntro: (loc) => `A sua opinião sobre o campo em ${loc} ajuda os nossos treinadores a tornar cada campo ainda melhor.`,
        signOff: "Com os melhores cumprimentos,", team: "A sua equipa Sports Evolution",
    },
}

function joinNames(names, and) {
    if (names.length <= 1) return names[0] || ""
    return `${names.slice(0, -1).join(", ")} ${and} ${names[names.length - 1]}`
}

/* ---------------- Email HTML ---------------- */

const C = {
    page: "#F2EFEA", card: "#FBFAF8", box: "#F7F4EF", border: "#E6E0D8",
    text: "#12110F", muted: "#5E5B57", yellow: "#F9B233",
    yellowBox: "#FBF0DC", yellowBorder: "#FADDA9", amber: "#8A5C0A",
}
const FONT = "'IBM Plex Sans',Arial,Helvetica,sans-serif"
const FONT_HEAD = "'Space Grotesk',Arial,Helvetica,sans-serif"

// starHref(n) returns the link of star n (1–5).
// reminder: true → the 3-day reminder (other heading and intro).
function buildEmail({ t, parentName, children, location, starHref, reminder = false }) {
    const one = children.length <= 1
    const names = joinNames(children, t.and)
    const stars = [1, 2, 3, 4, 5].map((n) =>
        `<td style="padding:0 3px;"><a href="${esc(starHref(n))}" aria-label="${esc(t.star(n))}" title="${esc(t.star(n))}" ` +
        `style="display:block;width:44px;height:44px;line-height:44px;text-align:center;background:#FFFFFF;border:1px solid ${C.border};border-radius:999px;font-size:24px;color:${C.yellow};text-decoration:none;">&#9733;</a></td>`
    ).join("")
    const logo = ASSET_BASE
        ? `<img src="${esc(ASSET_BASE)}/${esc(LOGO_FILE)}" width="200" height="15" alt="Sports Evolution" style="display:block;border:0;width:200px;height:auto;margin-top:24px;">`
        : ""
    const introText = reminder ? t.reminderIntro(location) : names ? t.intro(names, location, one) : ""
    const intro = introText ? `<p style="margin:0;color:${C.muted};">${esc(introText)}</p>` : ""

    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${emailFontCss(ASSET_BASE)}</head>
<body style="margin:0;padding:0;background:${C.page};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${C.card};border:1px solid ${C.border};border-radius:4px;font-family:${FONT};color:${C.text};font-size:15px;line-height:1.55;">
<tr><td style="padding:28px 28px 0;">
<p style="margin:0 0 14px;">${esc(t.hi(parentName))}</p>
<h1 style="margin:0 0 10px;font-family:${FONT_HEAD};font-size:28px;line-height:1.2;font-weight:bold;letter-spacing:-0.01em;color:${C.text};">${esc(reminder ? t.reminderHeading : t.heading)}</h1>
${intro}
</td></tr>
<tr><td style="padding:24px 28px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.box};border:1px solid ${C.border};border-radius:4px;"><tr><td align="center" style="padding:24px 16px 20px;">
<p style="margin:0 0 4px;font-family:${FONT_HEAD};font-size:18px;font-weight:bold;">${esc(t.question(one))}</p>
<p style="margin:0 0 16px;color:${C.muted};font-size:14px;">${esc(t.hint)}</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr>${stars}</tr><tr>
<td align="center" style="padding:6px 0 0;font-size:11px;color:${C.muted};">${esc(t.low)}</td><td></td><td></td><td></td>
<td align="center" style="padding:6px 0 0;font-size:11px;color:${C.muted};">${esc(t.high)}</td>
</tr></table>
</td></tr></table>
${location ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;background:${C.yellowBox};border:1px solid ${C.yellowBorder};border-radius:4px;"><tr><td style="padding:18px 20px;">
<p style="margin:0 0 4px;font-family:${FONT_HEAD};font-size:18px;font-weight:bold;color:${C.text};">${esc(t.alertsTitle(location))}</p>
<p style="margin:0;color:${C.amber};font-size:14px;">${esc(t.alertsText)}</p>
</td></tr></table>` : ""}
</td></tr>
<tr><td style="padding:24px 28px 28px;">
<p style="margin:0 0 16px;">${esc(t.outro)}</p>
<p style="margin:0;">${esc(t.signOff)}<br><strong>${esc(t.team)}</strong></p>
${logo}
</td></tr>
</table>
</td></tr></table>
</body></html>`
}

/* ---------------- Sheets & sending ---------------- */

async function getSheets() {
    const auth = new google.auth.JWT(
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        null,
        (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
        ["https://www.googleapis.com/auth/spreadsheets"]
    )
    return google.sheets({ version: "v4", auth })
}

// Column AD must exist, or the timestamp can't be written and the same
// email would go out again every run.
// Returns the number of columns of the Bookings tab.
async function bookingsColumnCount(sheets) {
    const meta = await sheets.spreadsheets.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        fields: "sheets.properties(title,gridProperties.columnCount)",
    })
    const tab = (meta.data.sheets || []).find((t) => t.properties.title === SHEET_TAB)
    const count = tab && tab.properties.gridProperties && tab.properties.gridProperties.columnCount
    return Number(count) || 0
}

// Booking IDs whose feedback was sent (status "Sent" in Responses). Returns
// null when the feedback spreadsheet can't be read — then no reminder goes
// out, so nobody who already answered is asked again.
async function answeredBookings(sheets) {
    if (!process.env.FEEDBACK_SHEET_ID) return null
    try {
        const meta = await sheets.spreadsheets.get({
            spreadsheetId: process.env.FEEDBACK_SHEET_ID,
            fields: "sheets.properties(title)",
        })
        const has = (meta.data.sheets || []).some((s) => s.properties.title === "Responses")
        if (!has) return new Set() // no feedback yet at all
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.FEEDBACK_SHEET_ID,
            range: "'Responses'!A:C",
        })
        const done = new Set()
        for (const r of (res.data.values || []).slice(1)) {
            if (String(r[0] || "") === "Sent" && r[2]) done.add(String(r[2]))
        }
        return done
    } catch (err) {
        console.error("[feedback-email] could not read the Camp feedback sheet — no reminders this run:", err.message)
        return null
    }
}

// Rows are found by Booking ID right before writing (the cleanup job deletes
// rows, so row numbers read earlier may have shifted).
async function markFeedbackSent(sheets, bookingId, stamp, letter = FEEDBACK_SENT_LETTER) {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET_TAB}!A:A` })
    const data = []
    ;(res.data.values || []).forEach((r, i) => {
        if (r[0] === bookingId) data.push({ range: `${SHEET_TAB}!${letter}${i + 1}`, values: [[stamp]] })
    })
    if (!data.length) return 0
    await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: "RAW", data } })
    return data.length
}

async function sendEmail(to, subject, html, replyTo) {
    if (!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set — refusing to send")
    const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            from: process.env.RESEND_FROM || "Sports Evolution <info@order.sportsevolution.lu>",
            to, subject, html, reply_to: replyTo,
        }),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`Resend rejected the email — status ${res.status}: ${text}`)
    return text
}

/* ---------------- Main ---------------- */

exports.handler = async () => {
    const started = Date.now()
    const now = luxNow()

    if (String(process.env.FEEDBACK_SECRET || "").length < 24) {
        console.error("[feedback-email] FEEDBACK_SECRET is missing or shorter than 24 characters — nothing is sent")
        return { statusCode: 200, body: "missing FEEDBACK_SECRET" }
    }
    if (!/^https:\/\//.test(FEEDBACK_PAGE_URL)) {
        console.error("[feedback-email] set FEEDBACK_PAGE_URL (or SITE_URL) to the https address of the feedback page — nothing is sent")
        return { statusCode: 200, body: "missing FEEDBACK_PAGE_URL" }
    }
    if (now.hour < SEND_FROM_HOUR || now.hour >= SEND_UNTIL_HOUR) {
        return { statusCode: 200, body: "outside sending hours" }
    }

    try {
        const sheets = await getSheets()
        const columns = await bookingsColumnCount(sheets)
        if (columns < COL.feedbackSent + 1) {
            console.error(`[feedback-email] column ${FEEDBACK_SENT_LETTER} ("Feedback email sent") is missing in "${SHEET_TAB}" — add it; nothing is sent until then`)
            return { statusCode: 200, body: "missing feedback column" }
        }
        const remindersOn = columns >= COL.reminderSent + 1
        if (!remindersOn) {
            console.error(`[feedback-email] column ${REMINDER_SENT_LETTER} ("Feedback reminder sent") is missing in "${SHEET_TAB}" — no reminders until it exists`)
        }
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
            range: remindersOn ? BOOKINGS_RANGE_WITH_REMINDER : BOOKINGS_RANGE,
        })
        const rows = (res.data.values || []).slice(1)

        const bookings = new Map()
        for (const r of rows) {
            const id = r[COL.bookingId]
            if (!id) continue
            if (!bookings.has(id)) bookings.set(id, [])
            bookings.get(id).push(r)
        }

        const due = []
        for (const [bookingId, group] of bookings) {
            const participants = group.filter((r) => (r[COL.role] || ROLE_PARTICIPANT) === ROLE_PARTICIPANT)
            const first = participants[0] || group[0]
            if (!SENDABLE_STATUSES.includes(String(first[COL.status] || "").toLowerCase())) continue
            if (group.some((r) => String(r[COL.feedbackSent] || "").trim())) continue // already sent
            const email = String(first[COL.email] || "").trim()
            if (!email) continue
            const lastDay = toISODate(first[COL.endDate]) || toISODate(first[COL.startDate])
            if (!lastDay) continue
            const daysAfter = daysBetween(lastDay, now.date)
            if (daysAfter < 1 || daysAfter > MAX_DAYS_AFTER) continue
            const children = [...new Set(participants.map((r) => String(r[COL.firstName] || "").trim()).filter(Boolean))]
            due.push({ bookingId, first, email, children })
        }

        let sent = 0
        let sheetProblem = false
        for (const b of due) {
            if (Date.now() - started > TIME_BUDGET_MS) {
                console.log(`[feedback-email] time budget used — ${due.length - sent} left for the next run`)
                break
            }
            const lang = String(b.first[COL.language] || "en").slice(0, 2).toLowerCase()
            const t = T[lang] || T.en
            const location = String(b.first[COL.venue] || "").trim() || String(b.first[COL.camp] || "").trim()
            const html = buildEmail({
                t,
                parentName: b.first[COL.parentName] || "",
                children: b.children,
                location,
                starHref: (n) => starUrl(b.bookingId, n),
            })
            const subject = t.subject(location)

            if (DRY_RUN) {
                console.log(`[feedback-email] DRY RUN — would send "${subject}" to ${b.email} (${b.bookingId})`)
                sent++
                continue
            }
            try {
                await sendEmail(b.email, subject, html, REPLY_TO)
            } catch (err) {
                console.error(`[feedback-email] ${b.bookingId}: sending failed:`, err.message)
                await sleep(PAUSE_BETWEEN_EMAILS_MS)
                continue
            }
            sent++
            let marked = 0
            try {
                marked = await markFeedbackSent(sheets, b.bookingId, new Date().toISOString())
            } catch (err) {
                console.error(`[feedback-email] ${b.bookingId}: sent but could not be marked:`, err.message)
            }
            if (!marked) {
                console.error(`[feedback-email] ${b.bookingId}: email sent but not marked — stopping this run`)
                sheetProblem = true
                break
            }
            console.log(`[feedback-email] sent to ${b.email} (${b.bookingId}, ${lang})`)
            await sleep(PAUSE_BETWEEN_EMAILS_MS)
        }

        // ---- Reminders (3 days later, once) ----
        let reminded = 0
        let remindersDue = 0
        const answered = remindersOn && !sheetProblem && Date.now() - started <= TIME_BUDGET_MS ? await answeredBookings(sheets) : null
        if (answered) {
            const nowMs = Date.now()
            const reminders = []
            for (const [bookingId, group] of bookings) {
                const participants = group.filter((r) => (r[COL.role] || ROLE_PARTICIPANT) === ROLE_PARTICIPANT)
                const first = participants[0] || group[0]
                if (!SENDABLE_STATUSES.includes(String(first[COL.status] || "").toLowerCase())) continue
                if (answered.has(bookingId)) continue
                if (group.some((r) => String(r[COL.reminderSent] || "").trim())) continue // already reminded
                const sentAt = Date.parse(String(group.map((r) => r[COL.feedbackSent] || "").find((v) => String(v).trim()) || ""))
                if (isNaN(sentAt)) continue
                const hours = (nowMs - sentAt) / 3600000
                if (hours < REMINDER_AFTER_HOURS || hours > REMINDER_UNTIL_DAYS * 24) continue
                const email = String(first[COL.email] || "").trim()
                if (!email) continue
                const children = [...new Set(participants.map((r) => String(r[COL.firstName] || "").trim()).filter(Boolean))]
                reminders.push({ bookingId, first, email, children })
            }
            remindersDue = reminders.length
            for (const b of reminders) {
                if (Date.now() - started > TIME_BUDGET_MS) {
                    console.log(`[feedback-email] time budget used — ${reminders.length - reminded} reminder(s) left for the next run`)
                    break
                }
                const lang = String(b.first[COL.language] || "en").slice(0, 2).toLowerCase()
                const t = T[lang] || T.en
                const location = String(b.first[COL.venue] || "").trim() || String(b.first[COL.camp] || "").trim()
                const html = buildEmail({
                    t,
                    parentName: b.first[COL.parentName] || "",
                    children: b.children,
                    location,
                    starHref: (n) => starUrl(b.bookingId, n),
                    reminder: true,
                })
                const subject = t.reminderSubject(location)
                if (DRY_RUN) {
                    console.log(`[feedback-email] DRY RUN — would send reminder "${subject}" to ${b.email} (${b.bookingId})`)
                    reminded++
                    continue
                }
                try {
                    await sendEmail(b.email, subject, html, REPLY_TO)
                } catch (err) {
                    console.error(`[feedback-email] ${b.bookingId}: reminder failed:`, err.message)
                    await sleep(PAUSE_BETWEEN_EMAILS_MS)
                    continue
                }
                reminded++
                let marked = 0
                try {
                    marked = await markFeedbackSent(sheets, b.bookingId, new Date().toISOString(), REMINDER_SENT_LETTER)
                } catch (err) {
                    console.error(`[feedback-email] ${b.bookingId}: reminder sent but could not be marked:`, err.message)
                }
                if (!marked) {
                    console.error(`[feedback-email] ${b.bookingId}: reminder sent but not marked — stopping this run`)
                    break
                }
                console.log(`[feedback-email] reminder sent to ${b.email} (${b.bookingId}, ${lang})`)
                await sleep(PAUSE_BETWEEN_EMAILS_MS)
            }
        }

        console.log(`[feedback-email] done — ${sent} sent, ${due.length - sent} pending, ${reminded} reminder(s) of ${remindersDue}`)
        return { statusCode: 200, body: JSON.stringify({ sent, due: due.length, reminded, remindersDue }) }
    } catch (err) {
        console.error("[feedback-email] run failed:", err)
        return { statusCode: 500, body: "failed" }
    }
}

// Used by send-test-emails.js and tests.
exports._internal = { buildEmail, T, feedbackToken, starUrl, sendEmail, toISODate, daysBetween, COL }
