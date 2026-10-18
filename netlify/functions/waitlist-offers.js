// netlify/functions/waitlist-offers.js
//
// Self-contained on purpose: no shared module to misplace.
// Runs on a schedule (see netlify.toml, every 15 minutes).
//
// Offers free places to families on the "Waitlist" tab, in sign-up order:
//   - free places = group size ("Camp details" column F, sent by the camp
//     page) − places taken in Bookings (paid, partially refunded, or in
//     checkout) − places already offered and still within their 12 hours;
//   - a family is offered a place when all its children fit; a larger family
//     that doesn't fit yet keeps its turn while a smaller one may be offered;
//   - the email says: 12 hours to book, place not reserved (first come,
//     first served), with a "Book now" button to the camp page;
//   - offers go out between 08:00 and 20:00 Luxembourg time.
//
// Status (column I): Waiting → Offered (J = time) → Booked | Expired.
// "Booked" when that email books the camp; "Expired" after 12 hours (the
// next family is then offered the place); "Closed" once the camp has
// started.

const { google } = require("googleapis")

const TAB = "Waitlist"
const W = { location: 0, first: 1, surname: 2, children: 3, email: 4, lang: 5, camp: 6, signedUp: 7, status: 8, offeredAt: 9, page: 10 }
const B = { createdAt: 1, camp: 2, email: 13, status: 16, role: 18, startDate: 23 }
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Bookings"
const CAMPS_TAB = process.env.CAMPS_TAB || "Overview"
const DETAILS_TAB = process.env.CAMP_DETAILS_TAB || "Camp details"

const OFFER_HOURS = 12
const SEND_FROM_HOUR = 8   // Luxembourg time, inclusive
const SEND_UNTIL_HOUR = 20 // Luxembourg time, exclusive
const PENDING_HOLD_MINUTES = Number(process.env.PENDING_HOLD_MINUTES || 30)
const TIME_BUDGET_MS = 20000
const PAUSE_BETWEEN_EMAILS_MS = 600

const DRY_RUN = String(process.env.WAITLIST_DRY_RUN || "").toLowerCase() === "true"
const REPLY_TO = process.env.RESEND_REPLY_TO || "info@sportsevolution.lu"
const ASSET_BASE = String(process.env.EMAIL_ASSET_BASE || process.env.URL || "").replace(/\/$/, "")
const LOGO_FILE = String(process.env.EMAIL_LOGO_FILE || "email/se-logo-long.png").replace(/^\//, "")

/* ---------------- Helpers ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function esc(value) {
    return String(value === undefined || value === null ? "" : value)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function luxNow() {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Luxembourg",
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date())
    const get = (t) => (parts.find((p) => p.type === t) || {}).value
    return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) }
}

const MONTHS = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
    august: 8, september: 9, october: 10, november: 11, december: 12,
}

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

function holdsASeat(row) {
    const status = String(row[B.status] || "").trim().toLowerCase()
    if (status === "paid" || status === "partially refunded") return true
    if (status !== "pending") return false
    const created = Date.parse(row[B.createdAt])
    if (isNaN(created)) return true
    return Date.now() - created < PENDING_HOLD_MINUTES * 60 * 1000
}

const norm = (v) => String(v || "").trim()
const normEmail = (v) => String(v || "").trim().toLowerCase()

/* ---------------- Email ---------------- */

const LOCALES = { en: "en-GB", fr: "fr-FR", de: "de-DE", pt: "pt-PT" }

// "Sunday 18 October, 20:15" in the family's language, Luxembourg time.
function deadlineText(ms, lang) {
    const loc = LOCALES[lang] || LOCALES.en
    const d = new Date(ms)
    const f = (o) => new Intl.DateTimeFormat(loc, { timeZone: "Europe/Luxembourg", ...o }).format(d)
    const wd = f({ weekday: "long" })
    const day = f({ day: "numeric" }).replace(/\D/g, "")
    const month = f({ month: "long" })
    const time = f({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    if (lang === "fr") return `${wd} ${day} ${month} à ${time}`
    if (lang === "de") return `${wd}, ${day}. ${month}, ${time} Uhr`
    if (lang === "pt") return `${wd}, ${day} de ${month}, às ${time}`
    return `${wd} ${day} ${month}, ${time}`
}

const T = {
    en: {
        subject: (loc, n) => `${n === 1 ? "A place is" : `${n} places are`} free at the ${loc} camp`,
        hi: (n) => `Hi ${n},`,
        heading: "Good news from the waiting list!",
        intro: (loc, n) => `${n === 1 ? "A place has" : `${n} places have`} opened up at the ${loc} camp.`,
        deadline: (when, n) => `You have 12 hours to book: until ${when}. After that, we offer ${n === 1 ? "the place" : "the places"} to the next family on the waiting list.`,
        notHeld: (n) => (n === 1 ? "The place isn't reserved for you: if someone else books it first, it's gone." : "The places aren't reserved for you: if someone else books them first, they're gone."),
        button: "Book now",
        outro: "See you at the camp!",
        signOff: "Kind regards,", team: "Your Sports Evolution Team",
    },
    fr: {
        subject: (loc, n) => `${n === 1 ? "Une place s'est libérée" : `${n} places se sont libérées`} au stage à ${loc}`,
        hi: (n) => `Bonjour ${n},`,
        heading: "Bonne nouvelle de la liste d'attente !",
        intro: (loc, n) => `${n === 1 ? "Une place s'est libérée" : `${n} places se sont libérées`} au stage à ${loc}.`,
        deadline: (when, n) => `Vous avez 12 heures pour réserver : jusqu'au ${when}. Ensuite, nous proposons ${n === 1 ? "la place" : "les places"} à la famille suivante sur la liste d'attente.`,
        notHeld: (n) => (n === 1 ? "La place n'est pas réservée pour vous : si quelqu'un la réserve avant vous, elle n'est plus disponible." : "Les places ne sont pas réservées pour vous : si quelqu'un les réserve avant vous, elles ne sont plus disponibles."),
        button: "Réserver",
        outro: "À bientôt au stage !",
        signOff: "Cordialement,", team: "Votre équipe Sports Evolution",
    },
    de: {
        subject: (loc, n) => `${n === 1 ? "Ein Platz ist" : `${n} Plätze sind`} frei im Camp in ${loc}`,
        hi: (n) => `Hallo ${n},`,
        heading: "Gute Nachricht von der Warteliste!",
        intro: (loc, n) => `${n === 1 ? "Ein Platz ist" : `${n} Plätze sind`} im Camp in ${loc} frei geworden.`,
        deadline: (when, n) => `Sie haben 12 Stunden Zeit zum Buchen: bis ${when}. Danach bieten wir ${n === 1 ? "den Platz" : "die Plätze"} der nächsten Familie auf der Warteliste an.`,
        notHeld: (n) => (n === 1 ? "Der Platz ist nicht für Sie reserviert: Bucht ihn jemand anderes zuerst, ist er weg." : "Die Plätze sind nicht für Sie reserviert: Bucht sie jemand anderes zuerst, sind sie weg."),
        button: "Jetzt buchen",
        outro: "Bis bald im Camp!",
        signOff: "Mit freundlichen Grüßen,", team: "Ihr Sports Evolution Team",
    },
    pt: {
        subject: (loc, n) => `${n === 1 ? "Há uma vaga" : `Há ${n} vagas`} no campo em ${loc}`,
        hi: (n) => `Olá ${n},`,
        heading: "Boas notícias da lista de espera!",
        intro: (loc, n) => `${n === 1 ? "Abriu uma vaga" : `Abriram ${n} vagas`} no campo em ${loc}.`,
        deadline: (when, n) => `Tem 12 horas para reservar: até ${when}. Depois disso, oferecemos ${n === 1 ? "a vaga" : "as vagas"} à próxima família da lista de espera.`,
        notHeld: (n) => (n === 1 ? "A vaga não fica reservada para si: se outra pessoa reservar primeiro, deixa de estar disponível." : "As vagas não ficam reservadas para si: se outra pessoa reservar primeiro, deixam de estar disponíveis."),
        button: "Reservar agora",
        outro: "Até breve no campo!",
        signOff: "Com os melhores cumprimentos,", team: "A sua equipa Sports Evolution",
    },
}

const C = { page: "#F2EFEA", card: "#FBFAF8", box: "#F7F4EF", border: "#E6E0D8", text: "#12110F", muted: "#5E5B57", yellow: "#F9B233" }
const FONT = "'IBM Plex Sans',Arial,Helvetica,sans-serif"
const FONT_HEAD = "'Space Grotesk',Arial,Helvetica,sans-serif"

// Web fonts for the email (files in email/fonts/ of this repo); see the
// other email functions.
function emailFontCss(base) {
    if (!base) return ""
    const f = (family, weight, file) =>
        `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};src:url(${base}/email/fonts/${file}) format('woff2');}`
    return `<style>@media screen{${f("Space Grotesk", 700, "space-grotesk-700.woff2")}${f("IBM Plex Sans", 400, "ibm-plex-sans-400.woff2")}${f("IBM Plex Sans", 600, "ibm-plex-sans-600.woff2")}${f("IBM Plex Sans", 700, "ibm-plex-sans-700.woff2")}}</style>`
}

function buildOfferEmail({ t, name, location, children, deadline, link }) {
    const logo = ASSET_BASE
        ? `<img src="${esc(ASSET_BASE)}/${esc(LOGO_FILE)}" width="200" height="15" alt="Sports Evolution" style="display:block;border:0;width:200px;height:auto;margin-top:24px;">`
        : ""
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${emailFontCss(ASSET_BASE)}</head>
<body style="margin:0;padding:0;background:${C.page};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${C.card};border:1px solid ${C.border};border-radius:4px;font-family:${FONT};color:${C.text};font-size:15px;line-height:1.55;">
<tr><td style="padding:28px 28px 0;">
<p style="margin:0 0 14px;">${esc(t.hi(name))}</p>
<h1 style="margin:0 0 10px;font-family:${FONT_HEAD};font-size:28px;line-height:1.2;font-weight:bold;letter-spacing:-0.01em;color:${C.text};">${esc(t.heading)}</h1>
<p style="margin:0;color:${C.muted};">${esc(t.intro(location, children))}</p>
</td></tr>
<tr><td style="padding:24px 28px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.box};border:1px solid ${C.border};border-radius:4px;"><tr><td style="padding:20px 24px;">
<p style="margin:0 0 8px;"><strong>${esc(t.deadline(deadline, children))}</strong></p>
<p style="margin:0 0 18px;color:${C.muted};font-size:14px;">${esc(t.notHeld(children))}</p>
<a href="${esc(link)}" style="display:inline-block;background:${C.yellow};color:${C.text};font-family:${FONT_HEAD};font-weight:bold;font-size:16px;text-decoration:none;padding:14px 28px;border-radius:999px;">${esc(t.button)}</a>
</td></tr></table>
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

async function sendEmail(to, subject, html) {
    if (!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set — refusing to send")
    const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            from: process.env.RESEND_FROM || "Sports Evolution <info@order.sportsevolution.lu>",
            to, subject, html, reply_to: REPLY_TO,
        }),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`Resend rejected the email — status ${res.status}: ${text}`)
    return text
}

/* ---------------- Sheets ---------------- */

function getSheets() {
    const auth = new google.auth.JWT(
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        null,
        (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
        ["https://www.googleapis.com/auth/spreadsheets"]
    )
    return google.sheets({ version: "v4", auth })
}

async function read(sheets, range) {
    try {
        const res = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range })
        return res.data.values || []
    } catch (err) {
        if (/Unable to parse range/i.test(String(err && err.message))) return null // tab missing
        throw err
    }
}

const sameRow = (r, ref) =>
    norm(r[W.camp]) === norm(ref[W.camp]) && normEmail(r[W.email]) === normEmail(ref[W.email]) && norm(r[W.signedUp]) === norm(ref[W.signedUp])

// Writes status (I) and offered-at (J) for one waitlist row, found again
// right before writing (someone may have edited the tab meanwhile).
async function writeStatus(sheets, ref, status, offeredAt) {
    const rows = (await read(sheets, `'${TAB}'!A:K`)) || []
    const idx = rows.findIndex((r, i) => i > 0 && sameRow(r, ref))
    if (idx < 1) return false
    const values = offeredAt === undefined ? [[status]] : [[status, offeredAt]]
    await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: `'${TAB}'!I${idx + 1}:${offeredAt === undefined ? "I" : "J"}${idx + 1}`,
        valueInputOption: "RAW",
        requestBody: { values },
    })
    return true
}

/* ---------------- Main ---------------- */

exports.handler = async () => {
    const started = Date.now()
    const now = luxNow()
    try {
        const sheets = getSheets()
        const list = await read(sheets, `'${TAB}'!A:K`)
        if (!list) {
            console.log(`[waitlist] no "${TAB}" tab — nothing to do`)
            return { statusCode: 200, body: "no tab" }
        }
        const entries = list.slice(1).filter((r) => ["Waiting", "Offered"].includes(norm(r[W.status])) && norm(r[W.camp]))
        if (!entries.length) return { statusCode: 200, body: JSON.stringify({ offered: 0 }) }

        const bookings = ((await read(sheets, `${SHEET_TAB}!A:Y`)) || []).slice(1)
        const details = ((await read(sheets, `'${DETAILS_TAB}'!A:F`)) || []).slice(1)
        const overview = ((await read(sheets, `'${CAMPS_TAB}'!A:F`)) || []).slice(1)

        const byCamp = new Map()
        for (const e of entries) {
            const k = norm(e[W.camp])
            if (!byCamp.has(k)) byCamp.set(k, [])
            byCamp.get(k).push(e)
        }

        let offered = 0
        let changed = 0
        let stop = false
        for (const [camp, rows] of byCamp) {
            if (stop) break
            const campBookings = bookings.filter((b) => norm(b[B.camp]) === camp)
            const start =
                campBookings.map((b) => toISODate(b[B.startDate])).find(Boolean) ||
                toISODate((overview.find((o) => norm(o[0]) === camp) || [])[4])

            // Camp started (or over): the waiting list is closed.
            if (start && start <= now.date) {
                for (const r of rows) {
                    if (DRY_RUN) { console.log(`[waitlist] DRY RUN — would close ${r[W.email]} (${camp})`); continue }
                    if (await writeStatus(sheets, r, "Closed")) changed++
                }
                continue
            }

            // Booked / expired.
            const booked = (r, sinceIso) => {
                const since = Date.parse(sinceIso)
                return campBookings.some((b) =>
                    normEmail(b[B.email]) === normEmail(r[W.email]) && holdsASeat(b) &&
                    (isNaN(since) || Date.parse(b[B.createdAt]) >= since - 60000))
            }
            const active = []
            for (const r of rows) {
                const status = norm(r[W.status])
                const since = status === "Offered" ? r[W.offeredAt] : r[W.signedUp]
                let next = ""
                if (booked(r, since)) next = "Booked"
                else if (status === "Offered") {
                    const at = Date.parse(r[W.offeredAt])
                    if (isNaN(at) || Date.now() - at >= OFFER_HOURS * 3600000) next = "Expired"
                }
                if (next) {
                    if (DRY_RUN) console.log(`[waitlist] DRY RUN — would mark ${r[W.email]} ${next} (${camp})`)
                    else if (await writeStatus(sheets, r, next)) changed++
                } else {
                    active.push(r)
                }
            }

            const size = Number((details.find((d) => norm(d[0]) === camp) || [])[5])
            if (!Number.isInteger(size) || size < 1) {
                console.log(`[waitlist] "${camp}": group size unknown — open the camp page on the website once`)
                continue
            }
            const taken = campBookings.filter((b) => (b[B.role] || "Participant") === "Participant" && holdsASeat(b)).length
            const heldByOffers = active
                .filter((r) => norm(r[W.status]) === "Offered")
                .reduce((s, r) => s + (Number(r[W.children]) || 1), 0)
            let free = size - taken - heldByOffers
            if (free <= 0) continue
            if (now.hour < SEND_FROM_HOUR || now.hour >= SEND_UNTIL_HOUR) {
                console.log(`[waitlist] "${camp}": ${free} place(s) free — offers wait for ${SEND_FROM_HOUR}:00`)
                continue
            }

            const waiting = active
                .filter((r) => norm(r[W.status]) === "Waiting")
                .sort((a, b) => norm(a[W.signedUp]).localeCompare(norm(b[W.signedUp])))
            for (const r of waiting) {
                if (free <= 0) break
                if (Date.now() - started > TIME_BUDGET_MS) { stop = true; break }
                const n = Number(r[W.children]) || 1
                if (n > free) continue // keeps its turn; a smaller family may fit
                const link = norm(r[W.page])
                const email = norm(r[W.email])
                if (!/^https:\/\//.test(link) || !email) continue
                const lang = ["en", "fr", "de", "pt"].includes(norm(r[W.lang])) ? norm(r[W.lang]) : "en"
                const t = T[lang]
                const location = norm(r[W.location]) || camp.replace(/\s*\(.*$/, "")
                const offeredAt = new Date()
                const html = buildOfferEmail({
                    t,
                    name: `${norm(r[W.first])} ${norm(r[W.surname])}`.trim(),
                    location,
                    children: n,
                    deadline: deadlineText(offeredAt.getTime() + OFFER_HOURS * 3600000, lang),
                    link,
                })
                const subject = t.subject(location, n)
                if (DRY_RUN) {
                    console.log(`[waitlist] DRY RUN — would offer "${subject}" to ${email}`)
                    free -= n
                    continue
                }
                try {
                    await sendEmail([email], subject, html)
                } catch (err) {
                    console.error(`[waitlist] offer to ${email} failed:`, err.message)
                    await sleep(PAUSE_BETWEEN_EMAILS_MS)
                    continue
                }
                free -= n
                offered++
                let marked = false
                try {
                    marked = await writeStatus(sheets, r, "Offered", offeredAt.toISOString())
                } catch (err) {
                    console.error(`[waitlist] offer sent to ${email} but not marked:`, err.message)
                }
                if (!marked) {
                    console.error(`[waitlist] offer sent to ${email} but not marked — stopping this run`)
                    stop = true
                    break
                }
                console.log(`[waitlist] offered ${n} place(s) at "${camp}" to ${email} (${lang})`)
                await sleep(PAUSE_BETWEEN_EMAILS_MS)
            }
        }

        console.log(`[waitlist] done — ${offered} offer(s) sent, ${changed} status change(s)`)
        return { statusCode: 200, body: JSON.stringify({ offered, changed }) }
    } catch (err) {
        console.error("[waitlist] run failed:", err)
        return { statusCode: 500, body: "failed" }
    }
}

// Used by send-test-emails.js and tests.
exports._internal = { buildOfferEmail, deadlineText, T, sendEmail }
