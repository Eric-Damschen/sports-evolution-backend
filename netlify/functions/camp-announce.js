// netlify/functions/camp-announce.js
//
// Tell families at OTHER locations about one camp, once.
// Example: the Mamer football camp for families signed up in Strassen and
// Kehlen (football).
//
// It doesn't send anything itself. It writes the camp into column K
// ("Also announce") of the matching rows in the "Camp alerts" tab, and
// camp-alerts-send.js (every 15 minutes, 10:00–19:00) then sends each family
// one "New camp near you" email, with an unsubscribe link, and records the
// camp in column J so it's never sent twice.
//
// Open in the browser (same key as the test emails, TEST_EMAIL_KEY):
//   /api/camp-announce?key=KEY&camp=Mamer&to=Strassen,Kehlen&sport=football
//       → preview only: who would get the email (nothing is written)
//   ...&go=1
//       → writes column K for those families; emails follow from 10:00
//
//   camp   the camp's name as in Overview column A, or just its location
//          ("Mamer") when there is only one upcoming camp there
//   to     the families' locations (column D), separated by commas
//   sport  optional: only families with this sport in column E
//          (families with an empty sport are always included)
//
// Only rows with Status "Active" are used. Families already told about the
// camp (J) or already queued (K) are skipped, and so are families at the
// camp's own location and sport, who get the normal alert anyway.

const { google } = require("googleapis")
const alerts = require("./camp-alerts.js")._internal

const A = alerts.A
const TAB = alerts.TAB
const CAMPS_TAB = process.env.CAMPS_TAB || "Overview"

const norm = (v) => String(v === undefined || v === null ? "" : v).trim()
const lower = (v) => norm(v).toLowerCase()

function esc(value) {
    return String(value === undefined || value === null ? "" : value)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function page(status, html) {
    return {
        statusCode: status,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:Arial,sans-serif;padding:24px;max-width:640px;line-height:1.5">${html}</body>`,
    }
}

function todayLux() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Luxembourg", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
}

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
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range })
    return res.data.values || []
}

exports.handler = async (event) => {
    const q = event.queryStringParameters || {}
    const expected = String(process.env.TEST_EMAIL_KEY || "")
    if (!expected) return page(404, "Switched off: TEST_EMAIL_KEY is not set in Netlify.")
    if (String(q.key || "") !== expected) return page(403, "Wrong or missing key.")

    const campParam = norm(q.camp)
    const toList = norm(q.to).split(",").map(lower).filter(Boolean)
    const sportFilter = lower(q.sport)
    const go = String(q.go || "") === "1"
    if (!campParam || !toList.length) {
        return page(400, "Add <strong>camp</strong> and <strong>to</strong>, e.g. <code>&amp;camp=Mamer&amp;to=Strassen,Kehlen&amp;sport=football</code>")
    }

    try {
        const sheets = getSheets()

        // The camp: exact name, or the only upcoming camp at that location.
        const today = todayLux()
        const upcoming = (await read(sheets, `'${CAMPS_TAB}'!A:F`)).slice(1)
            .filter((r) => norm(r[0]) && /^\d{4}-\d{2}-\d{2}$/.test(norm(r[4])) && norm(r[4]) > today)
        let matches = upcoming.filter((r) => lower(r[0]) === lower(campParam))
        if (!matches.length) matches = upcoming.filter((r) => lower(r[2]) === lower(campParam))
        if (matches.length !== 1) {
            const list = upcoming.map((r) => `<li>${esc(r[0])}</li>`).join("") || "<li>none</li>"
            return page(400, matches.length
                ? `More than one upcoming camp matches "${esc(campParam)}". Use the full name from Overview column A:<ul>${list}</ul>`
                : `No upcoming camp matches "${esc(campParam)}". Upcoming camps in Overview:<ul>${list}</ul>`)
        }
        const camp = matches[0]
        const key = norm(camp[0])
        const parts = alerts.campParts(key)
        const campLocation = lower(camp[2]) || parts.location
        const campSport = lower(camp[3]) || parts.sport

        await alerts.ensureTab(sheets) // adds the "Also announce" header in K1
        const rows = await read(sheets, `'${TAB}'!A:K`)

        const picked = []
        const skipped = { notActive: 0, alreadyTold: 0, alreadyQueued: 0, getsNormalAlert: 0 }
        const seen = new Set()
        rows.forEach((r, i) => {
            if (i === 0) return
            if (!toList.includes(lower(r[A.location]))) return
            if (sportFilter && norm(r[A.sport]) && lower(r[A.sport]) !== sportFilter) return
            if (norm(r[A.status]) !== "Active" || !norm(r[A.email])) { skipped.notActive++; return }
            const sameLocation = lower(r[A.location]) === campLocation
            const sportOk = !norm(r[A.sport]) || lower(r[A.sport]) === campSport
            if (sameLocation && sportOk) { skipped.getsNormalAlert++; return }
            if (norm(r[A.notified]).split("\n").map(norm).includes(key)) { skipped.alreadyTold++; return }
            const queued = norm(r[A.announce]).split("\n").map(norm).filter(Boolean)
            if (queued.includes(key)) { skipped.alreadyQueued++; return }
            // One email per family, even if they have several rows.
            const email = lower(r[A.email])
            const duplicate = seen.has(email)
            seen.add(email)
            picked.push({ rowNumber: i + 1, row: r, queued, duplicate })
        })

        const families = picked.filter((p) => !p.duplicate).length
        const perLocation = {}
        for (const p of picked) if (!p.duplicate) perLocation[norm(p.row[A.location])] = (perLocation[norm(p.row[A.location])] || 0) + 1
        const summary =
            `<p><strong>Camp:</strong> ${esc(key)}<br><strong>Families:</strong> ${families}` +
            ` (${Object.entries(perLocation).map(([l, n]) => `${esc(l)} ${n}`).join(", ") || "none"})</p>` +
            `<p style="color:#666">Skipped: ${skipped.alreadyTold} already told, ${skipped.alreadyQueued} already queued, ` +
            `${skipped.getsNormalAlert} get the normal alert, ${skipped.notActive} not Active.</p>`

        if (!go) {
            const list = picked.filter((p) => !p.duplicate)
                .map((p) => `<li>${esc(p.row[A.first])} ${esc(p.row[A.surname])} · ${esc(p.row[A.location])} · ${esc(p.row[A.email])}</li>`).join("")
            return page(200,
                `<h2>Preview (nothing written yet)</h2>${summary}` +
                (families ? `<p>To queue the emails, open the same link with <code>&amp;go=1</code> at the end. ` +
                `They go out between 10:00 and 19:00, about 25 every 15 minutes.</p><ol>${list}</ol>` : ""))
        }

        // Write K (the camp added on a new line). Every row of a family is
        // marked; camp-alerts-send.js still sends that family only one email.
        if (picked.length) {
            await sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: process.env.GOOGLE_SHEET_ID,
                requestBody: {
                    valueInputOption: "RAW",
                    data: picked.map((p) => ({
                        range: `'${TAB}'!K${p.rowNumber}`,
                        values: [[[...p.queued, key].join("\n")]],
                    })),
                },
            })
        }
        console.log(`[camp-announce] "${key}" queued for ${families} famil${families === 1 ? "y" : "ies"} in ${toList.join(", ")}`)
        return page(200, `<h2>Done</h2>${summary}<p>The emails go out between 10:00 and 19:00, about 25 every 15 minutes. ` +
            `Each family's column J shows the camp once their email has gone.</p>`)
    } catch (err) {
        console.error("[camp-announce] failed:", err)
        return page(500, "Something went wrong. Check the Netlify function log for camp-announce.")
    }
}
