'use strict';

/**
 * /api/camp-availability?camp=NAME&capacity=30&tripCapacity=40
 * Called by BOTH BookingForm.tsx and TripBookingForm.tsx on page load.
 *
 * Query params and response keys are UNCHANGED from the previous version:
 *   { capacity, booked, remaining }
 *   plus { tripCapacity, tripBooked, tripRemaining } when tripCapacity is sent.
 *
 * Only real difference: abandoned "pending" rows older than PENDING_HOLD_MINUTES
 * no longer count against capacity.
 */

const {
  ROLE_PARTICIPANT,
  ROLE_JOINER,
  getSheet,
  getAllRows,
  countBookedSpots,
  reply,
  corsHeaders,
} = require('../lib/common');

const METHODS = 'GET, OPTIONS';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(METHODS), body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return reply(405, { error: 'Method not allowed' }, METHODS);
  }

  const { camp, capacity, tripCapacity } = event.queryStringParameters || {};
  if (!camp || !capacity) {
    return reply(400, { error: 'Missing camp or capacity query param' }, METHODS);
  }

  try {
    const sheets = await getSheet();
    const allRows = await getAllRows(sheets);

    const booked = countBookedSpots(allRows, camp, ROLE_PARTICIPANT);
    const remaining = Math.max(0, Number(capacity) - booked);

    const responseBody = { capacity: Number(capacity), booked, remaining };

    if (tripCapacity) {
      const tripBooked = countBookedSpots(allRows, camp, ROLE_JOINER);
      responseBody.tripCapacity = Number(tripCapacity);
      responseBody.tripBooked = tripBooked;
      responseBody.tripRemaining = Math.max(0, Number(tripCapacity) - tripBooked);
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...corsHeaders(METHODS),
      },
      body: JSON.stringify(responseBody),
    };
  } catch (err) {
    console.error('[camp-availability] failed:', err);
    return reply(500, { error: 'Could not check availability' }, METHODS);
  }
};
