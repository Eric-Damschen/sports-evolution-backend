// netlify/functions/send-camp-info.js
//
// Self-contained on purpose: no shared module to misplace.
// Runs on a schedule (see netlify.toml, every 15 minutes).
//
// Sends every paid booking ONE camp-info email (WhatsApp link, venue, times,
// children, what to bring) once the camp is 7 days away or less:
//   - bookings made earlier get it on the day 7 days before the camp,
//   - bookings made later (late joiners) get it within ~15 minutes of paying.
// It is the ONLY place this email is sent, so a booking can never get two.
//
// Reads:  "Overview" tab (filled by register-camp.js and stripe-webhook.js;
//         you add the WhatsApp link)
//         "Bookings" tab A:AC
// Writes: Bookings column AC "Info email sent" (timestamp), and missing camp
//         rows in "Overview" for bookings made before this feature existed.
//
// Emails are only sent between 07:00 and 21:00 Luxembourg time.
// No WhatsApp link yet → the email waits; info@ gets a daily reminder from
// 10 days before the camp until the link is added.
//
// Netlify environment variables (all optional):
//   CAMP_INFO_DRY_RUN=true   log what would be sent, send and write nothing
//   ADMIN_NOTIFY_EMAIL       who gets the "missing WhatsApp link" reminder
//   EMAIL_ASSET_BASE         where the logos live (default: this site's URL)

const { google } = require("googleapis")

const COL = {
    bookingId: 0, createdAt: 1, camp: 2, firstName: 3, lastName: 4,
    clothingQty: 8, clothingSize: 9, bottleQty: 10, meals: 11,
    parentName: 12, email: 13, status: 16, language: 17, role: 18,
    venue: 19, bookingReference: 22, startDate: 23, endDate: 24,
    infoSent: 28, // AC
}
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Bookings"
const BOOKINGS_RANGE = `${SHEET_TAB}!A:AC`
const INFO_SENT_LETTER = "AC"

// Merged camp rows from readCampList(): Overview A–F + hidden details.
const CAMP = { name: 0, link: 1, location: 2, sport: 3, start: 4, end: 5, dropOff: 6, pickUp: 7, address: 8, goodToKnow: 9 }

const ROLE_PARTICIPANT = "Participant"
const ROLE_JOINER = "Joiner"
const SENDABLE_STATUSES = ["paid", "partially refunded"]

const DAYS_BEFORE = 7          // send when the camp is this close or closer
const REMINDER_DAYS_BEFORE = 10 // start reminding about a missing link
const SEND_FROM_HOUR = 7       // Luxembourg time, inclusive
const SEND_UNTIL_HOUR = 21     // Luxembourg time, exclusive
const TIME_BUDGET_MS = 20000   // scheduled functions have ~30 s
const PAUSE_BETWEEN_EMAILS_MS = 600 // stays under Resend's rate limit

const DRY_RUN = String(process.env.CAMP_INFO_DRY_RUN || "").toLowerCase() === "true"
const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || "info@sportsevolution.lu"
const REPLY_TO = process.env.RESEND_REPLY_TO || "info@sportsevolution.lu"
const ASSET_BASE = String(process.env.EMAIL_ASSET_BASE || process.env.URL || "").replace(/\/$/, "")
// The long one-line logo, shown once at the bottom of the email.
const LOGO_FILE = String(process.env.EMAIL_LOGO_FILE || "email/se-logo-long.png").replace(/^\//, "")

/* ---------------- Small helpers ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function esc(value) {
    return String(value === undefined || value === null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
}

function quoteTab(name) {
    return `'${String(name).replace(/'/g, "''")}'`
}

// Luxembourg wall-clock now: { date: "YYYY-MM-DD", hour, minute }
function luxNow() {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Luxembourg",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date())
    const get = (t) => (parts.find((p) => p.type === t) || {}).value
    return {
        date: `${get("year")}-${get("month")}-${get("day")}`,
        hour: Number(get("hour")),
        minute: Number(get("minute")),
    }
}

const MONTHS = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
    august: 8, september: 9, october: 10, november: 11, december: 12,
}

// Accepts "2026-12-28", "28/12/2026", "28.12.2026" or "28 December 2026".
// Returns "YYYY-MM-DD" or "" when unsure.
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

// Whole days from a to b (both "YYYY-MM-DD").
function daysBetween(a, b) {
    return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)
}

// "Mamer (football) · December 2026" → "football"
function sportKeyFromCamp(camp) {
    const m = /\(([^)]+)\)/.exec(String(camp || ""))
    return m ? m[1].trim().toLowerCase() : ""
}

// Only real WhatsApp invite links are ever put in an email.
function validWhatsAppLink(value) {
    const s = String(value || "").trim()
    return /^https:\/\/(chat\.whatsapp\.com|wa\.me|whatsapp\.com)\/\S+$/i.test(s) ? s : ""
}

/* ---------------- Sheets ---------------- */

async function getSheets() {
    const auth = new google.auth.JWT(
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        null,
        (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
        ["https://www.googleapis.com/auth/spreadsheets"]
    )
    return google.sheets({ version: "v4", auth })
}

// The "Info email sent" column (AC) must exist, or the timestamp can't be
// written and the same email would go out again every run.
async function infoColumnExists(sheets) {
    const meta = await sheets.spreadsheets.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        fields: "sheets.properties(title,gridProperties.columnCount)",
    })
    const tab = (meta.data.sheets || []).find((t) => t.properties.title === SHEET_TAB)
    const count = tab && tab.properties.gridProperties && tab.properties.gridProperties.columnCount
    return Number(count) >= COL.infoSent + 1
}

/* ---------- Camp list: "Overview" tab + hidden "Camp details" tab ----------
 * Same block in register-camp.js, stripe-webhook.js, send-camp-info.js and
 * update-overview.js (each function is self-contained on purpose).
 *
 * "Overview" (visible):  Camp | WhatsApp link | Location | Sport |
 *                        Start date | End date | Participants | Revenue
 *   B (WhatsApp link) is yours — the code never writes it.
 *   G/H are recalculated from the Bookings tab (paid + partially refunded).
 * "Camp details" (hidden): Camp | Drop-off | Pick-up | Venue address | Good to know
 *   used by the camp-info email; kept up to date from the website.
 */
const CAMPS_TAB = process.env.CAMPS_TAB || "Overview"
const DETAILS_TAB = process.env.CAMP_DETAILS_TAB || "Camp details"
const CAMPS_HEADER = ["Camp", "WhatsApp link", "Location", "Sport", "Start date", "End date", "Participants", "Revenue"]
const DETAILS_HEADER = ["Camp", "Drop-off", "Pick-up", "Venue address", "Good to know"]
const CAMP_LIST_COLS = { location: 2, sport: 3, start: 4, end: 5 }
const CAMP_DETAIL_COLS = { dropOff: 1, pickUp: 2, address: 3, goodToKnow: 4 }
const STATS_COLS = { participants: 6, revenue: 7 }

function campTabRange(tab, range) {
    return `'${String(tab).replace(/'/g, "''")}'!${range}`
}

function campColLetter(i) {
    return String.fromCharCode(65 + i)
}

function luxTodayISO() {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Luxembourg", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date())
}

// Creates the two tabs when missing (create = true) and upgrades an older
// Overview layout (with drop-off/pick-up/address/good-to-know in G–J).
async function ensureCampTabs(sheets, create = true) {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(sheetId,title)" })
    const tabs = (meta.data.sheets || []).map((t) => t.properties)
    let overview = tabs.find((t) => t.title === CAMPS_TAB)
    const details = tabs.find((t) => t.title === DETAILS_TAB)
    if (!overview && !create) return false

    const addTab = async (title, hidden) => {
        try {
            const res = await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: { requests: [{ addSheet: { properties: { title, hidden, gridProperties: { frozenRowCount: 1 } } } }] },
            })
            return res.data.replies[0].addSheet.properties.sheetId
        } catch (err) {
            if (/already exists/i.test(String(err && err.message))) return null
            throw err
        }
    }
    const formatOverview = async (sheetId) => {
        if (sheetId === null || sheetId === undefined) return
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
                requests: [
                    {
                        repeatCell: {
                            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: CAMPS_HEADER.length },
                            cell: { userEnteredFormat: { textFormat: { bold: true } } },
                            fields: "userEnteredFormat.textFormat.bold",
                        },
                    },
                    {
                        repeatCell: {
                            range: { sheetId, startRowIndex: 1, startColumnIndex: STATS_COLS.revenue, endColumnIndex: STATS_COLS.revenue + 1 },
                            cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "[$€]#,##0.00" } } },
                            fields: "userEnteredFormat.numberFormat",
                        },
                    },
                ],
            },
        })
    }
    const writeHeader = (tab, header) =>
        sheets.spreadsheets.values.update({
            spreadsheetId,
            range: campTabRange(tab, `A1:${campColLetter(header.length - 1)}1`),
            valueInputOption: "RAW",
            requestBody: { values: [header] },
        })

    if (!overview) {
        const id = await addTab(CAMPS_TAB, false)
        await writeHeader(CAMPS_TAB, CAMPS_HEADER)
        await formatOverview(id)
    } else {
        const head = await sheets.spreadsheets.values.get({ spreadsheetId, range: campTabRange(CAMPS_TAB, "A1:J1") })
        const current = ((head.data.values || [])[0] || []).map((v) => String(v || "").trim())
        if (current.join("|") !== CAMPS_HEADER.join("|")) {
            // Older layout: G–J held times, address and Good to know. Those now
            // live in the hidden tab and come back from the website.
            await sheets.spreadsheets.values.clear({ spreadsheetId, range: campTabRange(CAMPS_TAB, "G1:J") })
            await writeHeader(CAMPS_TAB, CAMPS_HEADER)
            await formatOverview(overview.sheetId)
            console.log(`[camps] upgraded the "${CAMPS_TAB}" tab to the new columns`)
        }
    }
    if (!details) {
        await addTab(DETAILS_TAB, true)
        await writeHeader(DETAILS_TAB, DETAILS_HEADER)
    }
    return true
}

// Adds the camp or refreshes it. Only non-empty values that changed are
// written. Never writes the WhatsApp link or the Participants/Revenue columns.
async function upsertCamp(sheets, campKey, info) {
    const key = String(campKey || "").trim()
    if (!key) return
    const lastDay = String(info.end || info.start || "")
    if (/^\d{4}-\d{2}-\d{2}$/.test(lastDay) && lastDay < luxTodayISO()) return // ended
    const spreadsheetId = process.env.GOOGLE_SHEET_ID
    await ensureCampTabs(sheets, true)

    const upsert = async (tab, width, cols, newRow) => {
        const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: campTabRange(tab, `A:${campColLetter(width - 1)}`) })
        const rows = res.data.values || []
        const idx = rows.findIndex((r, i) => i > 0 && String(r[0] || "").trim() === key)
        if (idx === -1) {
            const row = newRow()
            for (const [field, col] of Object.entries(cols)) row[col] = String(info[field] || "")
            await sheets.spreadsheets.values.append({
                spreadsheetId,
                range: campTabRange(tab, `A:${campColLetter(width - 1)}`),
                valueInputOption: "RAW",
                insertDataOption: "INSERT_ROWS",
                requestBody: { values: [row] },
            })
            return "added"
        }
        const current = rows[idx]
        const data = []
        for (const [field, col] of Object.entries(cols)) {
            const value = String(info[field] || "")
            if (value && value !== String(current[col] || "")) {
                data.push({ range: campTabRange(tab, `${campColLetter(col)}${idx + 1}`), values: [[value]] })
            }
        }
        if (data.length) {
            await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: "RAW", data } })
        }
        return data.length ? "updated" : "unchanged"
    }

    const listResult = await upsert(CAMPS_TAB, CAMPS_HEADER.length, CAMP_LIST_COLS, () => {
        const row = new Array(CAMPS_HEADER.length).fill("")
        row[0] = key
        row[STATS_COLS.participants] = 0
        row[STATS_COLS.revenue] = 0
        return row
    })
    await upsert(DETAILS_TAB, DETAILS_HEADER.length, CAMP_DETAIL_COLS, () => {
        const row = new Array(DETAILS_HEADER.length).fill("")
        row[0] = key
        return row
    })
    return listResult
}

// Participants (children) and revenue (column P) per camp, from the Bookings
// rows. Counted: "paid" and "partially refunded".
function campStatsFromBookings(bookingRows) {
    const stats = new Map()
    for (const r of bookingRows) {
        const name = String(r[2] || "").trim() // C = camp
        if (!name || !r[0]) continue
        const status = String(r[16] || "").trim().toLowerCase() // Q = status
        if (status !== "paid" && status !== "partially refunded") continue
        const s = stats.get(name) || { participants: 0, revenue: 0 }
        if (r[18] !== "Joiner") s.participants += 1 // S = role
        const p = Number(String(r[15] === undefined || r[15] === null ? "" : r[15]).replace(",", ".")) // P = price
        if (isFinite(p)) s.revenue += p
        stats.set(name, s)
    }
    for (const s of stats.values()) s.revenue = Math.round(s.revenue * 100) / 100
    return stats
}

// Writes Participants/Revenue into the Overview rows whose numbers changed.
async function writeCampStats(sheets, stats) {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID
    let res
    try {
        res = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: campTabRange(CAMPS_TAB, "A:H"),
            valueRenderOption: "UNFORMATTED_VALUE",
        })
    } catch (err) {
        if (/Unable to parse range/i.test(String(err && err.message))) return 0 // no Overview yet
        throw err
    }
    const rows = res.data.values || []
    const data = []
    rows.forEach((r, i) => {
        if (i === 0) return
        const name = String(r[0] || "").trim()
        if (!name) return
        const s = stats.get(name) || { participants: 0, revenue: 0 }
        const curP = r[STATS_COLS.participants], curR = r[STATS_COLS.revenue]
        if (String(curP) !== String(s.participants) || String(curR) !== String(s.revenue)) {
            data.push({
                range: campTabRange(CAMPS_TAB, `${campColLetter(STATS_COLS.participants)}${i + 1}:${campColLetter(STATS_COLS.revenue)}${i + 1}`),
                values: [[s.participants, s.revenue]],
            })
        }
    })
    if (data.length) {
        await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: "RAW", data } })
    }
    return data.length
}

// Overview rows merged with their hidden details, by camp name:
// [name, link, location, sport, start, end, dropOff, pickUp, address, goodToKnow]
async function readCampList(sheets) {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID
    const get = async (range) => {
        try {
            const res = await sheets.spreadsheets.values.get({ spreadsheetId, range })
            return (res.data.values || []).slice(1)
        } catch (err) {
            if (/Unable to parse range/i.test(String(err && err.message))) return []
            throw err
        }
    }
    const list = await get(campTabRange(CAMPS_TAB, "A:F"))
    const details = await get(campTabRange(DETAILS_TAB, "A:E"))
    const detailByName = new Map()
    for (const d of details) {
        const name = String(d[0] || "").trim()
        if (name && !detailByName.has(name)) detailByName.set(name, d)
    }
    return list.map((r) => {
        const d = detailByName.get(String(r[0] || "").trim()) || []
        const row = []
        for (let i = 0; i < 6; i++) row[i] = r[i] === undefined ? "" : r[i]
        row[6] = d[1] || ""
        row[7] = d[2] || ""
        row[8] = d[3] || ""
        row[9] = d[4] || ""
        return row
    })
}
/* ---------- end of camp list block ---------- */

async function readCamps(sheets) {
    const rows = await readCampList(sheets)
    const byName = new Map()
    for (const r of rows) {
        const name = String(r[CAMP.name] || "").trim()
        if (!name) continue
        const existing = byName.get(name)
        // If a camp ever appears twice, the row with a link wins.
        if (!existing || (!validWhatsAppLink(existing[CAMP.link]) && validWhatsAppLink(r[CAMP.link]))) {
            byName.set(name, r)
        }
    }
    return byName
}

// Rows are found by Booking ID right before writing: the cleanup job deletes
// rows, so row numbers read earlier may have shifted.
async function markInfoSent(sheets, bookingId, stamp) {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET_TAB}!A:A` })
    const ids = res.data.values || []
    const data = []
    ids.forEach((r, i) => {
        if (r[0] === bookingId) {
            data.push({ range: `${SHEET_TAB}!${INFO_SENT_LETTER}${i + 1}`, values: [[stamp]] })
        }
    })
    if (!data.length) return 0
    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: "RAW", data },
    })
    return data.length
}

/* ---------------- Email texts ---------------- */

const T = {
    en: {
        locale: "en-GB",
        subject: (loc) => `${loc} camp: everything you need to know`,
        hi: (n) => `Hi ${n},`,
        heading: (day) => `Your camp starts on ${day}.`,
        intro: "Here is everything you need for the camp.",
        waTitle: "Join the camp WhatsApp group",
        waText: "For parents only. We share updates, photos and videos here during the camp.",
        waButton: "Join the WhatsApp group",
        details: "Camp details", camp: "Camp", sport: "Sport", dates: "Dates",
        venue: "Venue", map: "Open in Google Maps", dropOff: "Drop-off",
        pickUp: "Pick-up", until: (t) => `until ${t}`, booking: "Booking",
        children: "Your children", tripGuests: "Trip guests",
        clothing: (size) => `Clothing set${size ? ` (size ${size})` : ""}`,
        bottle: "Drinking bottle", lunchIncluded: "Lunch included", packLunch: "Please pack a lunch",
        bring: "What to bring",
        healthTitle: "Anything new?",
        healthText: "If your child's allergies or health have changed since you booked, reply to this email before the camp starts.",
        questions: "Questions? Just reply to this email or write to",
        outro: "See you at the camp!",
        signOff: "Kind regards,", team: "Your Sports Evolution Team",
        sports: { football: "Football", basketball: "Basketball", volleyball: "Volleyball" },
    },
    fr: {
        locale: "fr-FR",
        subject: (loc) => `Stage à ${loc} : toutes les infos`,
        hi: (n) => `Bonjour ${n},`,
        heading: (day) => `Votre stage commence le ${day}.`,
        intro: "Voici tout ce dont vous avez besoin pour le stage.",
        waTitle: "Rejoignez le groupe WhatsApp du stage",
        waText: "Réservé aux parents. Nous y partageons les infos, photos et vidéos pendant le stage.",
        waButton: "Rejoindre le groupe WhatsApp",
        details: "Infos du stage", camp: "Stage", sport: "Sport", dates: "Dates",
        venue: "Lieu", map: "Ouvrir dans Google Maps", dropOff: "Dépose",
        pickUp: "Reprise", until: (t) => `jusqu'à ${t}`, booking: "Réservation",
        children: "Vos enfants", tripGuests: "Accompagnateurs",
        clothing: (size) => `Tenue${size ? ` (taille ${size})` : ""}`,
        bottle: "Gourde", lunchIncluded: "Déjeuner inclus", packLunch: "Prévoir un déjeuner",
        bring: "À apporter",
        healthTitle: "Du nouveau ?",
        healthText: "Si les allergies ou la santé de votre enfant ont changé depuis la réservation, répondez à cet e-mail avant le début du stage.",
        questions: "Des questions ? Répondez simplement à cet e-mail ou écrivez à",
        outro: "À bientôt au stage !",
        signOff: "Cordialement,", team: "Votre équipe Sports Evolution",
        sports: { football: "Football", basketball: "Basketball", volleyball: "Volleyball" },
    },
    de: {
        locale: "de-DE",
        subject: (loc) => `Camp in ${loc}: alle Infos`,
        hi: (n) => `Hallo ${n},`,
        heading: (day) => `Ihr Camp beginnt am ${day}.`,
        intro: "Hier finden Sie alles, was Sie für das Camp brauchen.",
        waTitle: "Treten Sie der WhatsApp-Gruppe des Camps bei",
        waText: "Nur für Eltern. Hier teilen wir während des Camps Neuigkeiten, Fotos und Videos.",
        waButton: "Der WhatsApp-Gruppe beitreten",
        details: "Camp-Details", camp: "Camp", sport: "Sport", dates: "Daten",
        venue: "Ort", map: "In Google Maps öffnen", dropOff: "Bringen",
        pickUp: "Abholen", until: (t) => `bis ${t}`, booking: "Buchung",
        children: "Ihre Kinder", tripGuests: "Mitreisende",
        clothing: (size) => `Kleidungsset${size ? ` (Größe ${size})` : ""}`,
        bottle: "Trinkflasche", lunchIncluded: "Mittagessen inklusive", packLunch: "Bitte Mittagessen mitgeben",
        bring: "Mitbringen",
        healthTitle: "Etwas Neues?",
        healthText: "Wenn sich Allergien oder die Gesundheit Ihres Kindes seit der Buchung geändert haben, antworten Sie bitte vor Campbeginn auf diese E-Mail.",
        questions: "Fragen? Antworten Sie einfach auf diese E-Mail oder schreiben Sie an",
        outro: "Bis bald im Camp!",
        signOff: "Mit freundlichen Grüßen,", team: "Ihr Sports Evolution Team",
        sports: { football: "Fußball", basketball: "Basketball", volleyball: "Volleyball" },
    },
    pt: {
        locale: "pt-PT",
        subject: (loc) => `Campo em ${loc}: toda a informação`,
        hi: (n) => `Olá ${n},`,
        heading: (day) => `O seu campo começa a ${day}.`,
        headingDay: (iso) => `${fmtDay(iso, "pt-PT", { day: "numeric", month: "long" })} (${fmtDay(iso, "pt-PT", { weekday: "long" })})`,
        intro: "Aqui está tudo o que precisa para o campo.",
        waTitle: "Junte-se ao grupo de WhatsApp do campo",
        waText: "Só para pais. Partilhamos aqui novidades, fotografias e vídeos durante o campo.",
        waButton: "Entrar no grupo de WhatsApp",
        details: "Detalhes do campo", camp: "Campo", sport: "Desporto", dates: "Datas",
        venue: "Local", map: "Abrir no Google Maps", dropOff: "Entrega",
        pickUp: "Recolha", until: (t) => `até às ${t}`, booking: "Reserva",
        children: "Os seus filhos", tripGuests: "Acompanhantes",
        clothing: (size) => `Conjunto de roupa${size ? ` (tamanho ${size})` : ""}`,
        bottle: "Garrafa", lunchIncluded: "Almoço incluído", packLunch: "Traga almoço",
        bring: "O que trazer",
        healthTitle: "Alguma novidade?",
        healthText: "Se as alergias ou a saúde do seu filho mudaram desde a reserva, responda a este e-mail antes do início do campo.",
        questions: "Dúvidas? Responda a este e-mail ou escreva para",
        outro: "Até breve no campo!",
        signOff: "Com os melhores cumprimentos,", team: "A sua equipa Sports Evolution",
        sports: { football: "Futebol", basketball: "Basquetebol", volleyball: "Voleibol" },
    },
}

function fmtDay(iso, locale, opts) {
    return new Intl.DateTimeFormat(locale, { timeZone: "UTC", ...opts }).format(new Date(`${iso}T00:00:00Z`))
}

// Weekday and date are formatted separately and joined with a space, so no
// locale adds its own comma ("Thu, 31 December").
function wd(iso, locale) {
    return fmtDay(iso, locale, { weekday: "short" })
}

// "Mon 28 – Thu 31 December 2026" (month only once when it is the same)
function fmtRange(startISO, endISO, locale) {
    const full = (iso) => `${wd(iso, locale)} ${fmtDay(iso, locale, { day: "numeric", month: "long", year: "numeric" })}`
    if (!endISO || endISO === startISO) return full(startISO)
    const sameMonth = startISO.slice(0, 7) === endISO.slice(0, 7)
    const a = sameMonth
        ? `${wd(startISO, locale)} ${fmtDay(startISO, locale, { day: "numeric" })}${locale.startsWith("de") ? "." : ""}`
        : `${wd(startISO, locale)} ${fmtDay(startISO, locale, { day: "numeric", month: "long" })}`
    return `${a} – ${full(endISO)}`
}

/* ---------------- Email HTML ---------------- */

const C = {
    page: "#F2EFEA", card: "#FBFAF8", box: "#F7F4EF", border: "#E6E0D8",
    text: "#12110F", muted: "#5E5B57", amberBg: "#FBF0DC", amberBorder: "#FADDA9",
    amberText: "#8A5C0A", whatsapp: "#25D366", whatsappText: "#0B1F14",
}
const FONT = "'IBM Plex Sans',Arial,Helvetica,sans-serif"
const FONT_HEAD = "'Space Grotesk',Arial,Helvetica,sans-serif"

function label(text) {
    return `<p style="margin:0 0 8px;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;font-weight:bold;color:${C.text};">${esc(text)}</p>`
}

function detailRow(name, valueHtml, last) {
    const line = last ? "" : `border-bottom:1px solid ${C.border};`
    return `<tr><td style="padding:12px 16px;color:${C.muted};width:92px;vertical-align:top;${line}">${esc(name)}</td>` +
        `<td style="padding:12px 16px 12px 0;vertical-align:top;${line}">${valueHtml}</td></tr>`
}

function buildEmail({ t, parentName, campRow, link, startISO, endISO, participants, guests, reference, location, sportKey }) {
    const sportName = t.sports[sportKey] || ""
    const address = String(campRow[CAMP.address] || "").trim()
    const dropOff = String(campRow[CAMP.dropOff] || "").trim()
    const pickUp = String(campRow[CAMP.pickUp] || "").trim()

    // Paragraph field: one line per address line; the map search gets them
    // joined with commas.
    const addressLines = address.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const venueHtml = addressLines.length
        ? `${addressLines.map(esc).join("<br>")}<br><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addressLines.join(", "))}" style="color:${C.text};font-weight:bold;">${esc(t.map)}</a>`
        : esc(location)

    const rows = [
        [t.camp, `<strong>${esc(location)}</strong>`],
        ...(sportName ? [[t.sport, esc(sportName)]] : []),
        [t.dates, esc(fmtRange(startISO, endISO, t.locale))],
        [t.venue, venueHtml],
        ...(dropOff ? [[t.dropOff, esc(dropOff)]] : []),
        ...(pickUp ? [[t.pickUp, esc(t.until(pickUp))]] : []),
        ...(reference ? [[t.booking, esc(reference)]] : []),
    ]
    const detailsHtml = rows.map(([k, v], i) => detailRow(k, v, i === rows.length - 1)).join("")

    const childCards = participants.map((d) => {
        const bits = []
        const qty = Number(d[COL.clothingQty]) || 0
        if (qty > 0) bits.push(`${t.clothing(d[COL.clothingSize] || "")}${qty > 1 ? ` ×${qty}` : ""}`)
        const bottles = Number(d[COL.bottleQty]) || 0
        if (bottles > 0) bits.push(`${t.bottle}${bottles > 1 ? ` ×${bottles}` : ""}`)
        bits.push(d[COL.meals] === "Yes" ? t.lunchIncluded : t.packLunch)
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.box};border:1px solid ${C.border};border-radius:4px;margin:0 0 10px;">` +
            `<tr><td style="padding:14px 16px;"><strong>${esc(`${d[COL.firstName] || ""} ${d[COL.lastName] || ""}`.trim())}</strong><br>` +
            `<span style="color:${C.muted};font-size:14px;">${esc(bits.join(" · "))}</span></td></tr></table>`
    }).join("")

    const guestsHtml = guests.length
        ? `<p style="margin:6px 0 0;color:${C.muted};font-size:14px;"><strong style="color:${C.text};">${esc(t.tripGuests)}:</strong> ${esc(guests.map((d) => `${d[COL.firstName] || ""} ${d[COL.lastName] || ""}`.trim()).join(", "))}</p>`
        : ""

    // "What to bring" = the camp page's "Good to know" text, word for word.
    const goodToKnow = String(campRow[CAMP.goodToKnow] || "")
        .split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const bringHtml = goodToKnow.length
        ? `<tr><td style="padding:28px 28px 0;">${label(t.bring)}${goodToKnow.map((l) => `<p style="margin:0 0 8px;">${esc(l)}</p>`).join("")}</td></tr>`
        : ""

    const logo = ASSET_BASE
        ? `<img src="${esc(ASSET_BASE)}/${esc(LOGO_FILE)}" width="200" height="15" alt="Sports Evolution" style="display:block;border:0;width:200px;height:auto;margin-top:24px;">`
        : ""

    const startDay = t.headingDay
        ? t.headingDay(startISO)
        : fmtDay(startISO, t.locale, { weekday: "long", day: "numeric", month: "long" })

    return `<!doctype html><html lang="${esc(t.locale.slice(0, 2))}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:${C.page};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${C.card};border:1px solid ${C.border};border-radius:4px;font-family:${FONT};color:${C.text};font-size:15px;line-height:1.55;">
<tr><td style="padding:28px 28px 0;">
<p style="margin:0 0 14px;">${esc(t.hi(parentName))}</p>
<h1 style="margin:0 0 10px;font-family:${FONT_HEAD};font-size:28px;line-height:1.2;font-weight:bold;letter-spacing:-0.01em;color:${C.text};">${esc(t.heading(startDay))}</h1>
<p style="margin:0;color:${C.muted};">${esc(t.intro)}</p>
</td></tr>
<tr><td style="padding:24px 28px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.box};border:1px solid ${C.border};border-radius:4px;"><tr><td style="padding:20px 24px;">
<p style="margin:0 0 4px;font-family:${FONT_HEAD};font-size:17px;font-weight:bold;">${esc(t.waTitle)}</p>
<p style="margin:0 0 16px;color:${C.muted};font-size:14px;">${esc(t.waText)}</p>
${link
    ? `<a href="${esc(link)}" style="display:inline-block;background:${C.whatsapp};color:${C.whatsappText};text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:999px;">${esc(t.waButton)}</a>`
    : `<p style="margin:0;color:${C.muted};font-size:13px;font-style:italic;">Test email — the camp's WhatsApp button appears here.</p>`}
</td></tr></table>
</td></tr>
<tr><td style="padding:28px 28px 0;">${label(t.details)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.box};border:1px solid ${C.border};border-radius:4px;font-size:15px;">${detailsHtml}</table>
</td></tr>
<tr><td style="padding:28px 28px 0;">${label(t.children)}${childCards}${guestsHtml}</td></tr>
${bringHtml}
<tr><td style="padding:24px 28px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.amberBg};border:1px solid ${C.amberBorder};border-radius:4px;"><tr><td style="padding:12px 16px;font-size:14px;color:${C.amberText};">
<strong>${esc(t.healthTitle)}</strong> ${esc(t.healthText)}
</td></tr></table>
</td></tr>
<tr><td style="padding:24px 28px 28px;">
<p style="margin:0 0 16px;">${esc(t.questions)} <a href="mailto:info@sportsevolution.lu" style="color:${C.text};">info@sportsevolution.lu</a>.</p>
<p style="margin:0 0 16px;">${esc(t.outro)}</p>
<p style="margin:0;">${esc(t.signOff)}<br><strong>${esc(t.team)}</strong></p>
${logo}
</td></tr>
</table>
</td></tr></table>
</body></html>`
}

/* ---------------- Sending ---------------- */

async function sendEmail(to, subject, html, replyTo) {
    if (!process.env.RESEND_API_KEY) {
        throw new Error("RESEND_API_KEY is not set — refusing to send with an empty token")
    }
    const body = {
        from: process.env.RESEND_FROM || "Sports Evolution <info@order.sportsevolution.lu>",
        to,
        subject,
        html,
        reply_to: replyTo,
    }
    const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`Resend rejected the email — status ${res.status}: ${text}`)
    return text
}

async function sendMissingLinkReminder(missing) {
    const to = ADMIN_NOTIFY_EMAIL.split(",").map((s) => s.trim()).filter(Boolean)
    if (!to.length || !missing.length) return
    const items = missing
        .map((m) => `<li><strong>${esc(m.camp)}</strong> — starts ${esc(m.start)}, ${m.families} ${m.families === 1 ? "family" : "families"} waiting${m.invalid ? " (the link in the tab is not a WhatsApp invite link)" : ""}</li>`)
        .join("")
    const html =
        `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111;line-height:1.5">` +
        `<p><strong>WhatsApp link missing</strong></p>` +
        `<p>The camp-info email is waiting for these camps. Paste the group's invite link (https://chat.whatsapp.com/…) in column B of the "${esc(CAMPS_TAB)}" tab. The emails go out within 15 minutes.</p>` +
        `<ul>${items}</ul></div>`
    await sendEmail(to, `WhatsApp link missing for ${missing.length} camp${missing.length === 1 ? "" : "s"}`, html, REPLY_TO)
}

/* ---------------- Main ---------------- */

exports.handler = async () => {
    const started = Date.now()
    const now = luxNow()

    try {
        const sheets = await getSheets()
        if (!(await infoColumnExists(sheets))) {
            console.error(`[camp-info] column ${INFO_SENT_LETTER} ("Info email sent") is missing in "${SHEET_TAB}" — add it; nothing is sent until then`)
            return { statusCode: 200, body: "missing info column" }
        }
        const bookingsRes = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
            range: BOOKINGS_RANGE,
        })
        const rows = (bookingsRes.data.values || []).slice(1)

        // Group rows by booking.
        const bookings = new Map()
        for (const r of rows) {
            const id = r[COL.bookingId]
            if (!id) continue
            if (!bookings.has(id)) bookings.set(id, [])
            bookings.get(id).push(r)
        }

        let camps = await readCamps(sheets)

        // Camps booked before this feature existed have no row yet: add one
        // from the booking rows (dates from columns X/Y). The webhook fills
        // drop-off, pick-up and address with the next paid booking.
        const toAdd = new Map()
        for (const group of bookings.values()) {
            const first = group[0]
            const name = String(first[COL.camp] || "").trim()
            if (!name || camps.has(name) || toAdd.has(name)) continue
            if (!SENDABLE_STATUSES.includes(String(first[COL.status] || "").toLowerCase())) continue
            const lastDay = toISODate(first[COL.endDate]) || toISODate(first[COL.startDate])
            if (!lastDay || lastDay < now.date) continue // ended or unknown — nothing to send
            toAdd.set(name, {
                location: first[COL.venue] || "",
                sport: sportKeyFromCamp(name),
                start: toISODate(first[COL.startDate]),
                end: toISODate(first[COL.endDate]),
            })
        }
        if (toAdd.size && !DRY_RUN) {
            for (const [name, info] of toAdd) await upsertCamp(sheets, name, info)
            console.log(`[camp-info] added ${toAdd.size} camp row(s): ${[...toAdd.keys()].join(" | ")}`)
            camps = await readCamps(sheets)
        }

        // Decide what is due.
        const due = []
        const missing = new Map() // camp → { start, families, invalid }
        for (const [bookingId, group] of bookings) {
            const participants = group.filter((r) => (r[COL.role] || ROLE_PARTICIPANT) === ROLE_PARTICIPANT)
            const guests = group.filter((r) => r[COL.role] === ROLE_JOINER)
            const first = participants[0] || group[0]
            const status = String(first[COL.status] || "").toLowerCase()
            if (!SENDABLE_STATUSES.includes(status)) continue
            if (group.some((r) => String(r[COL.infoSent] || "").trim())) continue // already sent
            const email = String(first[COL.email] || "").trim()
            if (!email) continue

            const name = String(first[COL.camp] || "").trim()
            const campRow = camps.get(name)
            if (!campRow) continue
            const startISO = toISODate(campRow[CAMP.start])
            if (!startISO) continue
            const endISO = toISODate(campRow[CAMP.end])
            const daysToStart = daysBetween(now.date, startISO)
            if (daysToStart < 0) continue // camp has started — no point any more

            const link = validWhatsAppLink(campRow[CAMP.link])
            if (!link) {
                if (daysToStart <= REMINDER_DAYS_BEFORE) {
                    const m = missing.get(name) || { camp: name, start: startISO, families: 0, invalid: !!String(campRow[CAMP.link] || "").trim() }
                    m.families += 1
                    missing.set(name, m)
                }
                continue
            }
            if (daysToStart > DAYS_BEFORE) continue

            due.push({ bookingId, first, participants, guests, campRow, link, startISO, endISO, email, name })
        }

        // Daily reminder about missing links, in the 08:00 run only.
        if (missing.size && now.hour === 8 && now.minute < 15) {
            if (DRY_RUN) {
                console.log(`[camp-info] DRY RUN — would remind about missing links: ${[...missing.keys()].join(" | ")}`)
            } else {
                try {
                    await sendMissingLinkReminder([...missing.values()])
                    console.log(`[camp-info] missing-link reminder sent (${missing.size} camp(s))`)
                } catch (err) {
                    console.error("[camp-info] missing-link reminder failed:", err.message)
                }
            }
        }

        if (now.hour < SEND_FROM_HOUR || now.hour >= SEND_UNTIL_HOUR) {
            if (due.length) console.log(`[camp-info] ${due.length} email(s) due — waiting for ${SEND_FROM_HOUR}:00 Luxembourg time`)
            return { statusCode: 200, body: "outside sending hours" }
        }

        let sent = 0
        for (const b of due) {
            if (Date.now() - started > TIME_BUDGET_MS) {
                console.log(`[camp-info] time budget used — ${due.length - sent} left for the next run`)
                break
            }
            const lang = String(b.first[COL.language] || "en").slice(0, 2).toLowerCase()
            const t = T[lang] || T.en
            const location = String(b.campRow[CAMP.location] || b.first[COL.venue] || "").trim()
            const sportKey = String(b.campRow[CAMP.sport] || sportKeyFromCamp(b.name)).toLowerCase()
            const html = buildEmail({
                t,
                parentName: b.first[COL.parentName] || "",
                campRow: b.campRow,
                link: b.link,
                startISO: b.startISO,
                endISO: b.endISO,
                participants: b.participants,
                guests: b.guests,
                reference: b.first[COL.bookingReference] || "",
                location,
                sportKey,
            })
            const subject = t.subject(location || b.name)

            if (DRY_RUN) {
                console.log(`[camp-info] DRY RUN — would send "${subject}" to ${b.email} (${b.bookingId})`)
                sent++
                continue
            }
            try {
                await sendEmail(b.email, subject, html, REPLY_TO)
            } catch (err) {
                // Not sent, not marked → retried in the next run.
                console.error(`[camp-info] ${b.bookingId}: sending failed:`, err.message)
                await sleep(PAUSE_BETWEEN_EMAILS_MS)
                continue
            }
            sent++
            let marked = 0
            try {
                marked = await markInfoSent(sheets, b.bookingId, new Date().toISOString())
            } catch (err) {
                console.error(`[camp-info] ${b.bookingId}: sent but could not be marked:`, err.message)
            }
            if (!marked) {
                // Stop here so a sheet problem can never turn into a stream of
                // repeated emails. The next run retries.
                console.error(`[camp-info] ${b.bookingId}: email sent but not marked — stopping this run`)
                break
            }
            console.log(`[camp-info] sent to ${b.email} (${b.bookingId}, ${lang}), ${marked} row(s) marked`)
            await sleep(PAUSE_BETWEEN_EMAILS_MS)
        }

        console.log(`[camp-info] done — ${sent} sent, ${due.length - sent} pending, ${missing.size} camp(s) without link`)
        return { statusCode: 200, body: JSON.stringify({ sent, due: due.length, missingLinks: missing.size }) }
    } catch (err) {
        console.error("[camp-info] run failed:", err)
        return { statusCode: 500, body: "failed" }
    }
}

// Exposed for tests only.
exports._internal = { sendEmail, CAMP, COL, buildEmail, toISODate, daysBetween, validWhatsAppLink, fmtRange, T, CAMP }
