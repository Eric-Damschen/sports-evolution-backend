'use strict';

/**
 * Shared helpers for all four Netlify functions.
 * esbuild bundles this into each function automatically (see netlify.toml).
 *
 * Column layout is identical to the previous version: A..S original columns
 * with Role at S, T..Y confirmation-page fields. Drop-off / pick-up time are
 * deliberately NOT stored here — they ride in the Stripe session metadata.
 */

const { google } = require('googleapis');

const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || 'Bookings';
const LAST_COLUMN = 'Y';
const DATA_RANGE = `${SHEET_TAB}!A:${LAST_COLUMN}`;
const STATUS_COLUMN_LETTER = 'Q';

const COL = {
  bookingId: 0, createdAt: 1, camp: 2, firstName: 3, lastName: 4, dob: 5,
  club: 6, allergies: 7, clothingQty: 8, clothingSize: 9, bottleQty: 10,
  meals: 11, parentName: 12, email: 13, phone: 14, bookingTotal: 15,
  status: 16, language: 17, role: 18,
  venue: 19, campDateRange: 20, ageRange: 21,
  bookingReference: 22, startDate: 23, endDate: 24,
};

const ROLE_PARTICIPANT = 'Participant';
const ROLE_JOINER = 'Joiner';

/**
 * How long an unpaid "pending" row keeps holding a seat.
 * Without this, every abandoned checkout eats a spot permanently.
 */
const PENDING_HOLD_MINUTES = Number(process.env.PENDING_HOLD_MINUTES || 30);

/* ------------------------------------------------------------------ */
/* Google Sheets                                                       */
/* ------------------------------------------------------------------ */

let cachedSheets = null;

async function getSheet() {
  if (cachedSheets) return cachedSheets;

  const key = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );

  cachedSheets = google.sheets({ version: 'v4', auth });
  return cachedSheets;
}

/**
 * Every row in the tab, raw arrays, with the real sheet row number attached.
 * Row 1 (the header) is included at index 0 so rowNumber === index + 1,
 * exactly as the previous version did.
 */
async function getAllRows(sheets) {
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: DATA_RANGE,
  });
  const rows = result.data.values || [];
  return rows.map((data, i) => ({ rowNumber: i + 1, data }));
}

/**
 * RAW, not USER_ENTERED.
 * USER_ENTERED makes Google parse every cell as if typed by hand, which turns
 * a "+352 621 ..." phone number into a broken formula and any note starting
 * with "=" into a formula too. RAW stores exactly what we send.
 */
/**
 * Appends rows and returns the range they landed in, e.g. "Bookings!A52:Y54".
 * Google assigns those row numbers, and append is atomic: two requests racing
 * each other get different, ordered blocks. That ordering is what makes the
 * capacity race fixable — see claimSeats() in create-booking.js.
 */
async function appendRows(sheets, values) {
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: DATA_RANGE,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });

  return (res.data && res.data.updates && res.data.updates.updatedRange) || '';
}

/** "Bookings!A52:Y54" -> [52, 53, 54]. Returns [] if the range can't be read. */
function parseAppendedRowNumbers(updatedRange) {
  const m = String(updatedRange || '').match(/![A-Z]+(\d+):[A-Z]+(\d+)$/);
  if (!m) return [];

  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];

  const out = [];
  for (let r = start; r <= end; r += 1) out.push(r);
  return out;
}

function findBookingRows(allRows, bookingId) {
  if (!bookingId) return [];
  return allRows.filter((r) => r.data[COL.bookingId] === bookingId);
}

async function setStatus(sheets, matches, status) {
  if (!matches.length) return 0;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: matches.map(({ rowNumber }) => ({
        range: `${SHEET_TAB}!${STATUS_COLUMN_LETTER}${rowNumber}`,
        values: [[status]],
      })),
    },
  });

  return matches.length;
}

/* ------------------------------------------------------------------ */
/* Capacity                                                            */
/* ------------------------------------------------------------------ */

const STATUS_PAID = 'paid';
const STATUS_PENDING = 'pending';
const STATUS_REFUNDED = 'refunded';
const STATUS_PARTIALLY_REFUNDED = 'partially refunded';

/**
 * Statuses that still occupy a place.
 *
 * A PARTIAL refund keeps the seat: refunding one add-on, or one child out of
 * three, doesn't mean the family stopped coming. A FULL refund releases it,
 * so the place goes straight back on sale.
 */
function holdsASeat(row) {
  const status = String(row[COL.status] || '').trim().toLowerCase();

  if (status === STATUS_PAID) return true;
  if (status === STATUS_PARTIALLY_REFUNDED) return true;

  // refunded / expired / released / cancelled all free the place
  if (status !== STATUS_PENDING) return false;

  const created = Date.parse(row[COL.createdAt]);
  if (Number.isNaN(created)) return true; // unknown age — keep the hold, be conservative
  return Date.now() - created < PENDING_HOLD_MINUTES * 60 * 1000;
}

/**
 * Seats taken for one camp, by role. Trimmed, case-insensitive camp match.
 *
 * `beforeRowNumber` counts only rows ABOVE that row — the seats that were
 * already claimed before our own rows landed. Omit it to count everything.
 */
function countBookedSpots(allRows, camp, role, beforeRowNumber) {
  const want = String(camp || '').trim().toLowerCase();
  const limit = Number.isFinite(beforeRowNumber) ? beforeRowNumber : Infinity;
  let count = 0;

  for (const { rowNumber, data } of allRows) {
    if (rowNumber >= limit) continue;
    if (String(data[COL.camp] || '').trim().toLowerCase() !== want) continue;
    if (!holdsASeat(data)) continue;
    const rowRole = data[COL.role] || ROLE_PARTICIPANT;
    if (rowRole === role) count += 1;
  }

  return count;
}

/* ------------------------------------------------------------------ */
/* Per-person pricing                                                  */
/* ------------------------------------------------------------------ */

/**
 * Splits the order total into one amount per person, for column P.
 *
 * The form sends each person's own price as `lineTotal` (camp fee plus that
 * child's add-ons, or the trip ticket price for a guest). Working in integer
 * cents and putting any rounding remainder on the first row guarantees the
 * column sums to exactly what Stripe charged — so column P can be summed for
 * revenue without double counting.
 *
 * If a cached older form submits without `lineTotal`, the total is split
 * evenly rather than dropped.
 */
function allocatePersonAmounts(people, orderTotal) {
  const targetCents = Math.round(toNumber(orderTotal, 0) * 100);
  if (!people.length) return [];

  const provided = people.map((p) => toNumber(p && p.lineTotal, NaN));
  const allProvided = provided.every((n) => Number.isFinite(n) && n >= 0);

  let cents;
  if (allProvided) {
    cents = provided.map((n) => Math.round(n * 100));
  } else {
    const even = Math.floor(targetCents / people.length);
    cents = people.map(() => even);
  }

  const drift = targetCents - cents.reduce((a, b) => a + b, 0);
  cents[0] += drift;

  return cents.map((c) => Math.round(c) / 100);
}

/** Sum of the per-person amounts in column P for a set of rows. */
function sumRowTotals(rows) {
  const cents = rows.reduce(
    (acc, row) => acc + Math.round(toNumber(row[COL.bookingTotal], 0) * 100),
    0
  );
  return cents / 100;
}

/* ------------------------------------------------------------------ */
/* Booking reference                                                   */
/* ------------------------------------------------------------------ */

// No 0/O/1/I — these get misread over the phone.
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Same SE-YYYY-XXXX shape as before, but drawn from a 32-char alphabet and
 * checked against references already in the sheet.
 * The old version used 4 hex chars of the UUID: only 65,536 possibilities,
 * which at 500 bookings gives an ~85% chance that two families collide.
 */
function makeBookingReference(allRows) {
  const year = new Date().getFullYear();
  const taken = new Set(
    (allRows || []).map((r) => String(r.data[COL.bookingReference] || '').trim()).filter(Boolean)
  );

  for (let attempt = 0; attempt < 10; attempt += 1) {
    let suffix = '';
    for (let i = 0; i < 5; i += 1) {
      suffix += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
    }
    const ref = `SE-${year}-${suffix}`;
    if (!taken.has(ref)) return ref;
  }

  // Astronomically unlikely; fall back to something guaranteed unique.
  return `SE-${year}-${Date.now().toString(36).toUpperCase()}`;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function corsHeaders(methods) {
  const configured = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    'Access-Control-Allow-Origin': configured.length ? configured[0] : '*',
    'Access-Control-Allow-Methods': methods || 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function reply(statusCode, body, methods) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(methods) },
    body: JSON.stringify(body),
  };
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toNumber(value, fallback = 0) {
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  SHEET_TAB,
  LAST_COLUMN,
  DATA_RANGE,
  STATUS_COLUMN_LETTER,
  COL,
  ROLE_PARTICIPANT,
  ROLE_JOINER,
  STATUS_PAID,
  STATUS_PENDING,
  STATUS_REFUNDED,
  STATUS_PARTIALLY_REFUNDED,
  PENDING_HOLD_MINUTES,
  getSheet,
  getAllRows,
  appendRows,
  parseAppendedRowNumbers,
  findBookingRows,
  setStatus,
  countBookedSpots,
  allocatePersonAmounts,
  sumRowTotals,
  makeBookingReference,
  corsHeaders,
  reply,
  esc,
  toNumber,
};
