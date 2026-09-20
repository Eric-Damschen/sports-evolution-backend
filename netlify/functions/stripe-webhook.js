'use strict';

/**
 * /api/stripe-webhook
 * Stripe calls this directly the moment a payment succeeds.
 * This is the ONLY place that emails the customer.
 *
 * Changes vs the previous version:
 *   - idempotent: a repeated delivery no longer sends a second email
 *   - handles checkout.session.expired, releasing held seats
 *   - handles async_payment_succeeded (Bancontact / iDEAL / SEPA)
 *   - email in the booking's own language (EN / FR / DE / PT)
 *   - all interpolated values HTML-escaped
 *
 * Raw-body handling is unchanged — it was already correct.
 */

const Stripe = require('stripe');
const {
  COL,
  ROLE_PARTICIPANT,
  ROLE_JOINER,
  STATUS_PAID,
  STATUS_REFUNDED,
  STATUS_PARTIALLY_REFUNDED,
  getSheet,
  getAllRows,
  findBookingRows,
  setStatus,
  esc,
  sumRowTotals,
} = require('../lib/common');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * ★ The Netlify variable is named STRIPE_WEBHOOK_SECRET_KEY.
 * Earlier versions read STRIPE_WEBHOOK_SECRET, which does not exist — an empty
 * secret fails signature verification every single time, which is exactly the
 * persistent 400 this endpoint was returning. The fallback below only matters
 * if the variable is ever renamed.
 */
const WEBHOOK_SECRET =
  process.env.STRIPE_WEBHOOK_SECRET_KEY || process.env.STRIPE_WEBHOOK_SECRET || '';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];

  // Signature verification needs the EXACT original bytes. Some Netlify
  // deployments expose them as event.rawBody; others base64-encode event.body.
  let payload;
  if (event.rawBody) {
    payload = event.rawBody;
  } else if (event.isBase64Encoded) {
    payload = Buffer.from(event.body, 'base64');
  } else {
    payload = event.body;
  }

  if (!WEBHOOK_SECRET) {
    console.error(
      '[webhook] STRIPE_WEBHOOK_SECRET_KEY is not set in this deploy context — ' +
      'signature verification cannot succeed.'
    );
    return { statusCode: 400, body: 'Webhook secret not configured' };
  }

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(payload, sig, WEBHOOK_SECRET);
  } catch (err) {
    const secret = WEBHOOK_SECRET;
    console.error(
      `[webhook] signature verification FAILED: ${err.message} — ` +
      `hasRawBody: ${!!event.rawBody}, isBase64Encoded: ${!!event.isBase64Encoded}, ` +
      `bodyLength: ${event.body ? event.body.length : 0}, sigPresent: ${!!sig}, ` +
      `secretPrefix: ${secret.slice(0, 8)}, secretLength: ${secret.length}`
    );
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  console.log(`[webhook] verified ${stripeEvent.type} (${stripeEvent.id})`);

  try {
    if (
      stripeEvent.type === 'checkout.session.completed' ||
      stripeEvent.type === 'checkout.session.async_payment_succeeded'
    ) {
      await handlePaid(stripeEvent.data.object);
    } else if (stripeEvent.type === 'checkout.session.expired') {
      await handleExpired(stripeEvent.data.object);
    } else if (stripeEvent.type === 'charge.refunded') {
      await handleRefund(stripeEvent.data.object);
    }
  } catch (err) {
    // Swallowed on purpose: the payment succeeded, so Stripe must not retry.
    console.error('[webhook] processing failed (still returning 200):', err);
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

/* ------------------------------------------------------------------ */

async function handlePaid(session) {
  const metadata = session.metadata || {};
  const bookingId = metadata.bookingId;

  if (!bookingId) {
    console.error(`[webhook] session ${session.id} carries no bookingId — ignoring`);
    return;
  }

  if (session.payment_status && session.payment_status !== 'paid') {
    console.log(`[webhook] ${bookingId} not paid yet (${session.payment_status}) — skipping`);
    return;
  }

  const sheets = await getSheet();
  const allRows = await getAllRows(sheets);
  const matches = findBookingRows(allRows, bookingId);

  if (matches.length === 0) {
    console.error(`[webhook] no sheet rows for booking ${bookingId}`);
    return;
  }

  // Idempotency — Stripe retries, and duplicate endpoints double-fire.
  const statuses = matches.map((m) =>
    String(m.data[COL.status] || '').trim().toLowerCase()
  );

  // A refund already happened. A late redelivery of the original payment
  // event must not flip these rows back to "paid" and re-block the seats.
  if (
    statuses.some((s) => s === STATUS_REFUNDED || s === STATUS_PARTIALLY_REFUNDED)
  ) {
    console.log(`[webhook] ${bookingId} has been refunded — not re-marking paid`);
    return;
  }

  const alreadyPaid = statuses.every((s) => s === STATUS_PAID);
  if (alreadyPaid) {
    console.log(`[webhook] ${bookingId} already paid — not resending the email`);
    return;
  }

  const updated = await setStatus(sheets, matches, 'paid');
  console.log(`[webhook] ${bookingId}: ${updated} row(s) marked paid`);

  const buyerEmail =
    (matches[0] && matches[0].data[COL.email]) ||
    (session.customer_details && session.customer_details.email) ||
    session.customer_email ||
    null;

  if (!buyerEmail) {
    console.error(`[webhook] ${bookingId}: no buyer address from the Sheet or Stripe`);
    return;
  }

  const lang = String(matches[0].data[COL.language] || 'en').slice(0, 2).toLowerCase();
  const t = T[lang] || T.en;

  await sendEmail(
    buyerEmail,
    t.subject(matches[0].data[COL.bookingReference] || ''),
    buildConfirmationHtml(
      matches,
      metadata.dropOffTime,
      metadata.pickUpTime,
      t,
      typeof session.amount_total === 'number' ? session.amount_total / 100 : NaN
    )
  );

  console.log(`[webhook] ${bookingId}: confirmation sent to ${buyerEmail} (${lang})`);
}

async function handleExpired(session) {
  const bookingId = (session.metadata || {}).bookingId;
  if (!bookingId) return;

  const sheets = await getSheet();
  const allRows = await getAllRows(sheets);
  const matches = findBookingRows(allRows, bookingId);
  if (!matches.length) return;

  if (matches.some((m) => String(m.data[COL.status] || '').toLowerCase() === 'paid')) {
    console.log(`[webhook] expired event for already-paid ${bookingId} — ignoring`);
    return;
  }

  const updated = await setStatus(sheets, matches, 'expired');
  console.log(`[webhook] ${bookingId}: checkout abandoned, ${updated} seat(s) released`);
}

/**
 * A refund was issued in the Stripe dashboard (or via the API).
 *
 * Fires for partial refunds too, so the amount decides the outcome:
 *   full refund    -> Status "refunded", the place goes back on sale
 *   partial refund -> Status "partially refunded", the place stays held
 *
 * Column P is left as the amount originally charged. Stripe is the record of
 * what was actually sent back — the Sheet just needs to stop blocking a seat.
 */
async function handleRefund(charge) {
  const bookingId = await resolveBookingId(charge);

  if (!bookingId) {
    console.error(
      `[webhook] refund on charge ${charge.id} carries no bookingId and no ` +
      'matching Checkout Session — the Sheet was not changed'
    );
    return;
  }

  const refunded = (charge.amount_refunded || 0) / 100;
  const charged = (charge.amount || 0) / 100;
  const isFull = charge.refunded === true || charge.amount_refunded >= charge.amount;
  const target = isFull ? STATUS_REFUNDED : STATUS_PARTIALLY_REFUNDED;

  if (!charge.amount_refunded) {
    console.log(`[webhook] ${bookingId}: refund event with nothing refunded — ignoring`);
    return;
  }

  const sheets = await getSheet();
  const allRows = await getAllRows(sheets);
  const matches = findBookingRows(allRows, bookingId);

  if (!matches.length) {
    console.error(`[webhook] no sheet rows for refunded booking ${bookingId}`);
    return;
  }

  // Idempotency — Stripe redelivers, and each extra partial refund fires again.
  const already = matches.every(
    (m) => String(m.data[COL.status] || '').trim().toLowerCase() === target
  );
  if (already) {
    console.log(`[webhook] ${bookingId}: already marked "${target}" — nothing to do`);
    return;
  }

  const updated = await setStatus(sheets, matches, target);

  console.log(
    `[webhook] ${bookingId}: refunded €${refunded.toFixed(2)} of €${charged.toFixed(2)} — ` +
    `${updated} row(s) set to "${target}"${isFull ? ', seat(s) released' : ', seat(s) still held'}`
  );
}

/**
 * Finds the booking behind a charge.
 * Bookings made after payment_intent_data.metadata was added carry the id on
 * the charge itself; older ones are found by looking up the Checkout Session
 * that created the PaymentIntent.
 */
async function resolveBookingId(charge) {
  const fromCharge = (charge.metadata || {}).bookingId;
  if (fromCharge) return fromCharge;

  if (!charge.payment_intent) return null;

  try {
    const sessions = await stripe.checkout.sessions.list({
      payment_intent: charge.payment_intent,
      limit: 1,
    });
    const session = sessions.data && sessions.data[0];
    return (session && session.metadata && session.metadata.bookingId) || null;
  } catch (err) {
    console.error('[webhook] could not look up session for charge', charge.id, err.message);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Email                                                               */
/* ------------------------------------------------------------------ */

const T = {
  en: {
    subject: (ref) => `Payment confirmed — ${ref}`,
    hi: (n) => `Hi ${n},`,
    intro: 'Your payment has been received and your booking is confirmed.',
    reference: 'Booking reference', camp: 'Camp', dates: 'Dates', venue: 'Venue',
    ages: 'Ages', dropOff: 'Drop-off', pickUp: 'Pick-up', tickets: 'Tickets',
    total: 'Total paid', perChild: 'Details per child', tripTickets: 'Trip tickets',
    child: 'child', children: 'children', noAddOns: 'No add-ons',
    clothing: 'Clothing set', bottle: 'Drinking bottle', meals: 'Meals',
    size: 'size', outro: 'See you at camp!',
  },
  fr: {
    subject: (ref) => `Paiement confirmé — ${ref}`,
    hi: (n) => `Bonjour ${n},`,
    intro: 'Votre paiement a bien été reçu et votre réservation est confirmée.',
    reference: 'Référence de réservation', camp: 'Stage', dates: 'Dates', venue: 'Lieu',
    ages: 'Âges', dropOff: 'Dépose', pickUp: 'Reprise', tickets: 'Places',
    total: 'Montant payé', perChild: 'Détails par enfant', tripTickets: 'Billets déplacement',
    child: 'enfant', children: 'enfants', noAddOns: 'Aucun supplément',
    clothing: 'Ensemble vêtements', bottle: 'Gourde', meals: 'Repas',
    size: 'taille', outro: 'À bientôt au stage !',
  },
  de: {
    subject: (ref) => `Zahlung bestätigt — ${ref}`,
    hi: (n) => `Hallo ${n},`,
    intro: 'Ihre Zahlung ist eingegangen und Ihre Buchung ist bestätigt.',
    reference: 'Buchungsreferenz', camp: 'Camp', dates: 'Daten', venue: 'Ort',
    ages: 'Alter', dropOff: 'Bringen', pickUp: 'Abholen', tickets: 'Plätze',
    total: 'Bezahlter Betrag', perChild: 'Details pro Kind', tripTickets: 'Reisetickets',
    child: 'Kind', children: 'Kinder', noAddOns: 'Keine Extras',
    clothing: 'Kleidungsset', bottle: 'Trinkflasche', meals: 'Mahlzeiten',
    size: 'Größe', outro: 'Bis bald im Camp!',
  },
  pt: {
    subject: (ref) => `Pagamento confirmado — ${ref}`,
    hi: (n) => `Olá ${n},`,
    intro: 'O seu pagamento foi recebido e a sua reserva está confirmada.',
    reference: 'Referência da reserva', camp: 'Campo', dates: 'Datas', venue: 'Local',
    ages: 'Idades', dropOff: 'Entrega', pickUp: 'Recolha', tickets: 'Lugares',
    total: 'Total pago', perChild: 'Detalhes por criança', tripTickets: 'Bilhetes de viagem',
    child: 'criança', children: 'crianças', noAddOns: 'Sem extras',
    clothing: 'Conjunto de roupa', bottle: 'Garrafa', meals: 'Refeições',
    size: 'tamanho', outro: 'Até breve no campo!',
  },
};

function buildConfirmationHtml(matches, dropOffTime, pickUpTime, t, amountPaid) {
  const first = matches[0].data;

  // Column P now holds each person's own price, so the order total is the sum
  // of the rows. Stripe's charged amount wins when it's available.
  const orderTotal = Number.isFinite(amountPaid)
    ? amountPaid.toFixed(2)
    : sumRowTotals(matches.map((m) => m.data)).toFixed(2);

  const participants = matches.filter(
    (m) => (m.data[COL.role] || ROLE_PARTICIPANT) === ROLE_PARTICIPANT
  );
  const joiners = matches.filter((m) => m.data[COL.role] === ROLE_JOINER);

  const childLines = participants
    .map(({ data }) => {
      const name = `${data[COL.firstName]} ${data[COL.lastName]}`.trim();
      const addOns = [];

      const clothingQty = Number(data[COL.clothingQty]) || 0;
      if (clothingQty > 0) {
        const size = data[COL.clothingSize];
        addOns.push(
          `${esc(t.clothing)} ×${clothingQty}${size ? ` (${esc(t.size)} ${esc(size)})` : ''}`
        );
      }

      const bottleQty = Number(data[COL.bottleQty]) || 0;
      if (bottleQty > 0) addOns.push(`${esc(t.bottle)} ×${bottleQty}`);
      if (data[COL.meals] === 'Yes') addOns.push(esc(t.meals));

      const addOnsText = addOns.length ? addOns.join(', ') : esc(t.noAddOns);
      return `<li><strong>${esc(name)}</strong> — ${addOnsText}</li>`;
    })
    .join('');

  const joinerLines = joiners
    .map(({ data }) => `<li>${esc(`${data[COL.firstName]} ${data[COL.lastName]}`.trim())}</li>`)
    .join('');

  const joinerSection = joiners.length
    ? `<p><strong>${esc(t.tripTickets)} (${joiners.length}):</strong></p><ul>${joinerLines}</ul>`
    : '';

  const countWord = participants.length === 1 ? t.child : t.children;

  return `
    <p>${esc(t.hi(first[COL.parentName] || ''))}</p>
    <p>${esc(t.intro)}</p>
    <table cellpadding="6" style="border-collapse:collapse;">
      <tr><td><strong>${esc(t.reference)}</strong></td><td>${esc(first[COL.bookingReference])}</td></tr>
      <tr><td><strong>${esc(t.camp)}</strong></td><td>${esc(first[COL.camp])}</td></tr>
      <tr><td><strong>${esc(t.dates)}</strong></td><td>${esc(first[COL.campDateRange])}</td></tr>
      <tr><td><strong>${esc(t.venue)}</strong></td><td>${esc(first[COL.venue])}</td></tr>
      <tr><td><strong>${esc(t.ages)}</strong></td><td>${esc(first[COL.ageRange])}</td></tr>
      <tr><td><strong>${esc(t.dropOff)}</strong></td><td>${esc(dropOffTime || '')}</td></tr>
      <tr><td><strong>${esc(t.pickUp)}</strong></td><td>${esc(pickUpTime || '')}</td></tr>
      <tr><td><strong>${esc(t.tickets)}</strong></td><td>${participants.length} ${esc(countWord)}</td></tr>
      <tr><td><strong>${esc(t.total)}</strong></td><td>€${esc(orderTotal)}</td></tr>
    </table>
    <p><strong>${esc(t.perChild)}:</strong></p>
    <ul>${childLines}</ul>
    ${joinerSection}
    <p>${esc(t.outro)}</p>
  `;
}

async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not set — refusing to send with an empty bearer token');
  }

  const body = {
    from: process.env.RESEND_FROM || 'Sports Evolution <info@order.sportsevolution.lu>',
    to,
    subject,
    html,
  };

  if (process.env.RESEND_REPLY_TO) body.reply_to = process.env.RESEND_REPLY_TO;
  if (process.env.RESEND_BCC) body.bcc = process.env.RESEND_BCC;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  // fetch() does not throw on 4xx/5xx — read the body and throw so the real
  // reason (bad key, unverified domain, bad recipient) reaches the logs.
  const resText = await res.text();
  if (!res.ok) {
    throw new Error(`Resend rejected the email — status ${res.status}: ${resText}`);
  }
  return resText;
}
