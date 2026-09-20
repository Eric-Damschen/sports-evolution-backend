'use strict';

/**
 * /api/create-booking
 * Shared by BOTH BookingForm.tsx and TripBookingForm.tsx.
 *
 * Payload contract is UNCHANGED from the previous version — the Framer
 * components do not need editing:
 *   { camp, campTitle, location, dateRange, startDate, endDate, ageRange,
 *     dropOffTime, pickUpTime, children[], tripGuests[], contact,
 *     total, totalSpots, tripTotalSpots, language }
 *   children[]: { firstName, lastName, dob, club, allergies,
 *                 addOns: { clothingQty, clothingSize, bottleQty, meals } }
 *
 * 1. Checks capacity — camp against totalSpots, trip against tripTotalSpots
 * 2. Generates a collision-checked booking reference
 * 3. Writes one row per participant and one per trip guest, all sharing a Booking ID
 * 4. Creates a Stripe Checkout Session for the submitted total
 *
 * No email is sent here — only stripe-webhook.js emails the customer.
 */

const Stripe = require('stripe');
const { randomUUID } = require('crypto');
const {
  COL,
  ROLE_PARTICIPANT,
  ROLE_JOINER,
  getSheet,
  getAllRows,
  appendRows,
  parseAppendedRowNumbers,
  setStatus,
  countBookedSpots,
  allocatePersonAmounts,
  makeBookingReference,
  reply,
  corsHeaders,
  toNumber,
  PENDING_HOLD_MINUTES,
} = require('../lib/common');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const METHODS = 'POST, OPTIONS';
const MAX_TOTAL_EUR = toNumber(process.env.MAX_BOOKING_TOTAL_EUR, 5000);
const CONFIRMATION_PATH = process.env.CONFIRMATION_PATH || '/confirmation-page';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(METHODS), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return reply(405, { error: 'Method not allowed' }, METHODS);
  }

  try {
    const {
      camp, location, dateRange, startDate, endDate, ageRange,
      dropOffTime, pickUpTime, children, tripGuests, contact, total, addOnsIncluded,
      totalSpots, tripTotalSpots, language,
    } = JSON.parse(event.body || '{}');

    if (!camp || !Array.isArray(children) || children.length === 0 || !contact) {
      return reply(400, { error: 'Missing camp, children, or contact details' }, METHODS);
    }

    if (!contact.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(contact.email))) {
      return reply(400, { error: 'A valid contact email is required' }, METHODS);
    }

    // Pricing is trusted from the form by design. Bounds only — no price list.
    const amount = toNumber(total, NaN);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_TOTAL_EUR) {
      return reply(400, { error: 'Invalid booking total' }, METHODS);
    }

    const guests = Array.isArray(tripGuests) ? tripGuests : [];
    const bookingId = randomUUID();
    const sheets = await getSheet();

    // One read serves capacity checks AND reference uniqueness.
    const allRows = await getAllRows(sheets);

    /* --- 1. Early capacity check ------------------------------------- */
    // Fast, friendly rejection when the camp is clearly full. This is NOT the
    // real guard — two requests can pass it at the same moment. Step 3 is.

    if (totalSpots) {
      const booked = countBookedSpots(allRows, camp, ROLE_PARTICIPANT);
      const remaining = Number(totalSpots) - booked;
      if (children.length > remaining) {
        return reply(409, { error: 'notEnoughSpots', remaining: Math.max(0, remaining) }, METHODS);
      }
    }

    if (tripTotalSpots && guests.length > 0) {
      const booked = countBookedSpots(allRows, camp, ROLE_JOINER);
      const remaining = Number(tripTotalSpots) - booked;
      if (guests.length > remaining) {
        return reply(409, { error: 'notEnoughTripSpots', remaining: Math.max(0, remaining) }, METHODS);
      }
    }

    /* --- 2. Rows ----------------------------------------------------- */

    const bookingReference = makeBookingReference(allRows);
    const createdAt = new Date().toISOString();

    // The form sends addOnsIncluded: false once the add-ons deadline has passed,
    // and then leaves them out of the total. Recording them anyway would put
    // items on the packing list that nobody paid for, so they are zeroed here.
    const addOnsCount = addOnsIncluded !== false;

    // Column P holds THIS PERSON'S price — the camp fee plus that child's own
    // add-ons, or the trip ticket price for a guest — not the order total.
    // The amounts are reconciled to sum to exactly what Stripe charges, so
    // column P can be summed directly for revenue.
    const personAmounts = allocatePersonAmounts([...children, ...guests], amount);
    const childAmounts = personAmounts.slice(0, children.length);
    const guestAmounts = personAmounts.slice(children.length);

    const participantRows = children.map((child, i) => [
      bookingId, createdAt, camp,
      child.firstName || '', child.lastName || '', child.dob || '',
      child.club || '', child.allergies || '',
      (addOnsCount && child.addOns && child.addOns.clothingQty) || 0,
      (addOnsCount && child.addOns && child.addOns.clothingSize) || '',
      (addOnsCount && child.addOns && child.addOns.bottleQty) || 0,
      addOnsCount && child.addOns && child.addOns.meals ? 'Yes' : 'No',
      contact.parentName || '', contact.email || '', contact.phone || '',
      childAmounts[i], 'pending', language || 'en',
      ROLE_PARTICIPANT,
      location || '', dateRange || '', ageRange || '',
      bookingReference, startDate || '', endDate || '',
    ]);

    const joinerRows = guests.map((guest, i) => [
      bookingId, createdAt, camp,
      guest.firstName || '', guest.lastName || '', '',
      '', '',
      0, '', 0, 'No',
      contact.parentName || '', contact.email || '', contact.phone || '',
      guestAmounts[i], 'pending', language || 'en',
      ROLE_JOINER,
      location || '', dateRange || '', ageRange || '',
      bookingReference, startDate || '', endDate || '',
    ]);

    /* --- 3. Claim the seats, then verify we actually won -------------- */
    //
    // Google Sheets has no locks, so "check then write" can let two buyers
    // take the same last spot. Instead: write first, then re-read and see
    // whether anyone else's rows landed ABOVE ours.
    //
    // Append is atomic and assigns row numbers in order, so of two racing
    // requests exactly one lands first. The later one sees the earlier one's
    // rows above its own, releases its rows and returns a clean 409. No
    // Stripe session is ever created for the loser.

    const updatedRange = await appendRows(sheets, [...participantRows, ...joinerRows]);
    const ourRowNumbers = parseAppendedRowNumbers(updatedRange);
    const ourRows = ourRowNumbers.map((rowNumber) => ({ rowNumber }));
    const firstRow = ourRowNumbers.length ? ourRowNumbers[0] : null;

    async function releaseSeats() {
      try {
        if (ourRows.length) await setStatus(sheets, ourRows, 'released');
      } catch (releaseErr) {
        console.error('[create-booking] could not release rows', releaseErr);
      }
    }

    if (firstRow !== null) {
      const afterRows = await getAllRows(sheets);

      if (totalSpots) {
        const takenBefore = countBookedSpots(afterRows, camp, ROLE_PARTICIPANT, firstRow);
        const remaining = Number(totalSpots) - takenBefore;
        if (children.length > remaining) {
          await releaseSeats();
          console.log(
            `[create-booking] lost the camp race for "${camp}" — ` +
            `${takenBefore} seat(s) claimed above row ${firstRow}, released ${ourRows.length} row(s)`
          );
          return reply(
            409,
            { error: 'notEnoughSpots', remaining: Math.max(0, remaining) },
            METHODS
          );
        }
      }

      if (tripTotalSpots && guests.length > 0) {
        const takenBefore = countBookedSpots(afterRows, camp, ROLE_JOINER, firstRow);
        const remaining = Number(tripTotalSpots) - takenBefore;
        if (guests.length > remaining) {
          await releaseSeats();
          console.log(
            `[create-booking] lost the trip race for "${camp}" — released ${ourRows.length} row(s)`
          );
          return reply(
            409,
            { error: 'notEnoughTripSpots', remaining: Math.max(0, remaining) },
            METHODS
          );
        }
      }
    } else {
      console.error(
        '[create-booking] could not read back the appended range — ' +
        `capacity was verified only before the write. Range was: "${updatedRange}"`
      );
    }

    /* --- 4. Stripe Checkout ------------------------------------------ */

    const siteUrl = (process.env.SITE_URL || 'https://www.sportsevolution.lu').replace(/\/$/, '');

    // The seat is held for PENDING_HOLD_MINUTES. Expiring the Stripe session on
    // roughly the same clock keeps the two in step: when it expires, Stripe
    // fires checkout.session.expired and the webhook frees the seat at once.
    //
    // Stripe requires expires_at to be AT LEAST 30 minutes in the future, and
    // it is checked when Stripe receives the request — so asking for exactly
    // 30 minutes fails by the few seconds the round trip takes. The 2-minute
    // margin below clears that. The Sheet's hold stays the real authority.
    const holdMinutes = Math.max(PENDING_HOLD_MINUTES, 30) + 2;
    const expiresAt = Math.floor(Date.now() / 1000) + holdMinutes * 60;

    let session;
    try {
      session = await stripe.checkout.sessions.create({
      mode: 'payment',
      // payment_method_types intentionally omitted: the Stripe Dashboard then
      // decides which methods to offer (Bancontact, iDEAL, Apple Pay, cards).
      customer_email: contact.email,
      client_reference_id: bookingReference,
      expires_at: expiresAt,
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: { name: `${camp} — ${bookingReference}` },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      metadata: {
        bookingId,
        bookingReference,
        dropOffTime: dropOffTime || '',
        pickUpTime: pickUpTime || '',
      },
      // Refunds arrive as charge events, not session events. Copying the
      // metadata onto the PaymentIntent means the charge carries bookingId
      // too, so a refund can find its rows without a lookup.
      payment_intent_data: {
        metadata: { bookingId, bookingReference },
      },
      success_url: `${siteUrl}${CONFIRMATION_PATH}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: siteUrl,
      locale: 'auto',
      });
    } catch (stripeErr) {
      // The seats are already claimed in the Sheet. If Stripe refuses, hand
      // them straight back rather than leaving a 30-minute ghost hold.
      await releaseSeats();
      throw stripeErr;
    }

    console.log(
      `[create-booking] ${bookingReference} — camp "${camp}", ` +
      `${participantRows.length} participant(s), ${joinerRows.length} joiner(s), ` +
      `€${amount} total, held ${PENDING_HOLD_MINUTES} min, session ${session.id}`
    );

    return reply(200, { checkoutUrl: session.url, bookingReference }, METHODS);
  } catch (err) {
    console.error('[create-booking] failed:', err);
    // The real reason is returned so it shows up in the browser console and in
    // the Netlify function log. The customer still only sees the friendly
    // message the form renders.
    return reply(
      500,
      { error: 'Could not create booking', message: err && err.message },
      METHODS
    );
  }
};
