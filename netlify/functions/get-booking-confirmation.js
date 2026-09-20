'use strict';

/**
 * /api/get-booking-confirmation?session_id=cs_...
 * Called by ConfirmationPage.tsx after Stripe redirects back.
 *
 * Response keys are UNCHANGED from the previous version, so the existing
 * ConfirmationPage.tsx keeps working. Two additions it can ignore safely:
 *   - status  ("paid")
 *   - addOns on each child (clothingQty / clothingSize / bottleQty / meals)
 *
 * Security: only returns data once Stripe confirms the session was paid.
 */

const Stripe = require('stripe');
const {
  COL,
  ROLE_PARTICIPANT,
  ROLE_JOINER,
  getSheet,
  getAllRows,
  findBookingRows,
  sumRowTotals,
  toNumber,
  reply,
  corsHeaders,
} = require('../lib/common');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const METHODS = 'GET, OPTIONS';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(METHODS), body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return reply(405, { error: 'Method not allowed' }, METHODS);
  }

  const { session_id: sessionId } = event.queryStringParameters || {};
  if (!sessionId) {
    return reply(400, { error: 'Missing session_id' }, METHODS);
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== 'paid') {
      return reply(402, { error: 'Payment not completed for this session' }, METHODS);
    }

    const bookingId = session.metadata && session.metadata.bookingId;
    if (!bookingId) {
      return reply(404, { error: 'No booking found' }, METHODS);
    }

    const sheets = await getSheet();
    const allRows = await getAllRows(sheets);
    const matches = findBookingRows(allRows, bookingId);

    if (matches.length === 0) {
      return reply(404, { error: 'No booking found' }, METHODS);
    }

    const rows = matches.map((m) => m.data);
    const first = rows[0];

    const participantRows = rows.filter((r) => (r[COL.role] || ROLE_PARTICIPANT) === ROLE_PARTICIPANT);
    const joinerRows = rows.filter((r) => r[COL.role] === ROLE_JOINER);

    return reply(
      200,
      {
        bookingReference: first[COL.bookingReference],
        status: first[COL.status],
        language: first[COL.language] || 'en',
        parentName: first[COL.parentName],
        email: first[COL.email],
        camp: first[COL.camp],
        venue: first[COL.venue],
        dateRange: first[COL.campDateRange],
        startDate: first[COL.startDate],
        endDate: first[COL.endDate],
        ageRange: first[COL.ageRange],
        dropOffTime: (session.metadata && session.metadata.dropOffTime) || '',
        pickUpTime: (session.metadata && session.metadata.pickUpTime) || '',
        // Column P is per person now, so the order total is the sum of the
        // rows — or Stripe's charged amount, which is authoritative.
        total:
          typeof session.amount_total === 'number'
            ? session.amount_total / 100
            : sumRowTotals(rows),
        children: participantRows.map((row) => ({
          firstName: row[COL.firstName],
          lastName: row[COL.lastName],
          price: toNumber(row[COL.bookingTotal], 0),
          clothingQty: Number(row[COL.clothingQty]) || 0,
          clothingSize: row[COL.clothingSize] || '',
          bottleQty: Number(row[COL.bottleQty]) || 0,
          meals: row[COL.meals] === 'Yes',
        })),
        tripGuests: joinerRows.map((row) => ({
          firstName: row[COL.firstName],
          lastName: row[COL.lastName],
          price: toNumber(row[COL.bookingTotal], 0),
        })),
      },
      METHODS
    );
  } catch (err) {
    console.error('[get-booking-confirmation] failed:', err);
    return reply(500, { error: 'Could not retrieve booking' }, METHODS);
  }
};
