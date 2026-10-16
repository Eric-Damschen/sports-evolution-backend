# Sports Evolution — booking backend setup

## Repository layout

```
netlify.toml
package.json
netlify/functions/
    create-booking.js
    camp-availability.js
    stripe-webhook.js
    get-booking-confirmation.js
    cleanup-abandoned.js
    check-discount.js
    send-camp-info.js
    update-overview.js
    register-camp.js
    send-test-emails.js
email/
    se-logo-long.png (logo at the bottom of the confirmation and camp-info emails)
```

Every function is self-contained. **Delete `netlify/lib/` and `public/` from the
repo** if they're still there from an earlier version.

A `404 GET /` in the Netlify logs is expected — there is no homepage here.

---

## Netlify environment variables

Required (already set):

| Variable | |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | service account address |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | from the JSON key file |
| `GOOGLE_SHEET_ID` | the id between `/d/` and `/edit` in the Sheet URL |
| `STRIPE_SECRET_KEY` | `sk_test_…` while testing, `sk_live_…` when live |
| `STRIPE_WEBHOOK_SECRET_KEY` | `whsec_…` of the exact webhook endpoint in use |
| `RESEND_API_KEY` | `re_…` |
| `SITE_URL` | e.g. `https://www.sportsevolution.lu` — no trailing slash |

Optional:

| Variable | Default | |
|---|---|---|
| `RESEND_BCC` | — | a copy of every confirmation email to you |
| `EMAIL_LOGO_FILE` | `email/se-logo-long.png` | path of the email logo in this repo, if yours has another name |
| `TEST_EMAIL_KEY` | — | any word; switches on `/api/send-test-emails?key=…` (sends both emails to info@). Remove it afterwards |
| `ALLOWED_ORIGINS` | `https://www.sportsevolution.lu,https://sportsevolution.lu` | websites allowed to report camps to `register-camp` |
| `CAMP_INFO_DRY_RUN` | — | `true` = the camp-info job only logs what it would send |
| `ADMIN_NOTIFY_EMAIL` | `info@sportsevolution.lu` | short "new booking" alert after each successful payment (comma-separate several addresses) |
| `RESEND_REPLY_TO` | — | where parents' replies go |
| `CONFIRMATION_PATH` | `/confirmation-page` | the Framer page Stripe returns to |
| `PENDING_HOLD_MINUTES` | `30` | how long a checkout holds a seat |

**Netlify only picks up a changed variable on the next deploy.** After editing
one, trigger a redeploy.

---

## Google Sheet

- Tab named `Bookings`, headers in **row 1**, columns A–AB.
- **Z1 = `Position`**, **AA1 = `Discount code`**, **AB1 = `Heard about us`**.
- Shared with the service account address as **Editor**.
- **AC1 = `Info email sent`** — the camp-info job writes a timestamp here. The column must exist (insert it after AB); until it does, the job sends nothing.
- Never insert, delete or reorder columns A–AC. Add new columns after AC.
- Column AB holds the answer to "How did you hear about us?": `Friends/family`, `Club or coach`, `Instagram`, `Facebook`, `TikTok`, `Meta ad`, `Internet search`, `Came before`, or `Other: <their words>` (always in English).

### Minimum age

Each child must be at least **7** on the first camp day. The form blocks younger children and `create-booking` rejects them again on the server (`MIN_AGE` in `create-booking.js`, `MIN_AGE` in both forms — change all three together).

### Status values in column Q

| Status | Meaning | Seat |
|---|---|---|
| `pending` | in checkout | held for 30 min |
| `paid` | paid | held |
| `partially refunded` | some money returned | held |
| `refunded` | fully refunded | released |
| `expired` | checkout abandoned | released, row deleted by cleanup |
| `released` | lost the race for the last spot | released, row deleted by cleanup |

Column P holds each person's own price, so `SUMIF(Q:Q,"paid",P:P)` is revenue.

---

## Discount codes

A second tab named exactly **`Discount codes`**, headers in row 1:

| Code | Percent off | Active | Valid until | Max uses |
|---|---|---|---|---|
| SUMMER10 | 10 | Yes | 2027-08-31 | 50 |
| GIFT-7K3Q | FREE | Yes | | 1 |

- **Percent off**: 10 or 10%, taken off the camp fees after the multichild discount. Add-ons and trip tickets are never discounted.
- **FREE** in the Percent off column makes one camp ticket free (the first child's camp fee, after the multichild discount). Other children, add-ons and trip tickets are still paid. If the total ends up €0, the parent still goes through Stripe Checkout without entering a card; the webhook, email, sheet and confirmation page work as usual (Stripe shows it as "no payment required").
- A €0 booking is only accepted with a valid FREE code. Use **Max uses = 1** for single-use gift codes.
- **Active**: `Yes` (or a ticked checkbox). Anything else, blank included, switches the code off.
- **Valid until** (optional): last day the code works. Write dates as `2027-08-31`.
- **Max uses** (optional): number of bookings that may use it. Blank = unlimited. Paid bookings and open checkouts count; refunded and abandoned ones don't.
- Codes are checked on the server and never appear in the page. Make them hard to guess (e.g. `SE-SUMMER-7K3`).
- The code used is stored in column AA of each booking row and in the Stripe payment's metadata.

## Camp-info email (7 days before)

`send-camp-info` runs every 15 minutes and sends each paid booking one email
with the WhatsApp link, venue, times, children and what to bring:

- bookings made earlier get it 7 days before the camp;
- late joiners get it within 15 minutes of paying;
- only between 07:00 and 21:00 Luxembourg time; nothing once the camp has started;
- in the booking language; the timestamp in column AC makes it one email per booking.

**"Overview" tab (camp list)** — created automatically as soon as the first
camp page is opened on the live website. Columns: Camp | WhatsApp link |
Location | Sport | Start date | End date | Participants | Revenue.
Each camp page's booking form reports its camp (`register-camp`), so every
online camp gets a row, refreshed whenever you change it in Framer.
**You only paste the WhatsApp invite link (`https://chat.whatsapp.com/…`) in
column B** — the code never writes there. Participants (children, paid and
partially refunded) and Revenue (column P) update right after each payment
and are rechecked every 15 minutes (refunds included). Rows of camps that have
ended are removed the day after their last day.

**"Camp details" tab (hidden)** — drop-off, pick-up, venue address and Good to
know per camp, used by the camp-info email. Filled by the code; leave it as is.

Without a valid link the camp-info email waits, and info@ gets a reminder at
08:00 each day from 10 days before the camp.

Venue address and "What to bring": both are rich text in the Framer CMS,
which code components can't receive. `register-camp` therefore reads them from
the published camp page: the rich text right after the **Address** label and
the **Good to know** heading (keep those two labels on the camp template).
Line breaks are kept. "What to bring" shows the Good to know text word for
word. If the form's own Venue address / Good to know fields are filled, those
win.

Camp start date: if the booking form's **Camp start date** isn't connected, the
form uses the day and month shown on the page (this year, or next year once
this year's camp is over). The camp's name — and so the place counting — stays
as it was.

## Test emails

Set `TEST_EMAIL_KEY` in Netlify (any word), redeploy, then open
`https://<your-site>.netlify.app/api/send-test-emails?key=<that word>`.
One test confirmation and one test camp-info email go to info@ (no WhatsApp
link, sample family, real camp details). Remove the variable afterwards.

## Year tabs

`update-overview` runs every 15 minutes and only reads the Bookings tab.
**2026, 2027, …** — a year's tab is created at the first purchase for a camp
of that year (year of the first camp day) and rewritten whenever something
changes (don't type in it). One row per camp of that year — upcoming, running
and finished — with status, participants, joiners, revenue, clothing sets and
sizes, bottles, lunches, discount codes, how families heard about us and
refunded bookings, plus a total row. Finished camps without any booking are
left out.

Counted: "paid" and "partially refunded". Revenue = column P; partial refunds
are not subtracted.

## Cleanup job

`cleanup-abandoned` runs every 15 minutes and deletes `expired` and `released`
rows, plus `pending` rows older than 2 hours that Stripe confirms were never
paid. It waits while anyone is mid-checkout, and never touches paid or refunded
rows. It is the only thing that deletes rows.

Scheduled functions only run on the **production** deploy. Netlify → Functions →
`cleanup-abandoned` → **Run now** triggers it by hand.

---

## Stripe

See the full walkthrough in the chat. In short:

1. One webhook endpoint → `https://<your-netlify-site>/api/stripe-webhook`
2. Events: `checkout.session.completed`, `checkout.session.expired`, `charge.refunded`
3. Payload style: **Snapshot**
4. Its signing secret → `STRIPE_WEBHOOK_SECRET_KEY` → redeploy
5. No other endpoints pointing at the same URL

Test and live mode are separate: separate keys, separate endpoint, separate
secret.

---

## Framer

- Booking and trip forms: Submit endpoint →
  `https://<your-netlify-site>/api/create-booking`, Availability check URL →
  `https://<your-netlify-site>/api/camp-availability`. Full URLs, not `/api/…`.
- **Pick-up time → `16:00`** on every camp page.
- Confirmation page: endpoint →
  `https://<your-netlify-site>/api/get-booking-confirmation`; on the phone
  breakpoint set **Height → Fit**.
- Publish the Framer site after pasting.

---

## Test checklist

1. `https://<your-netlify-site>/api/camp-availability?camp=test&capacity=10`
   returns JSON counts.
2. Book with test card `4242 4242 4242 4242`, any future expiry, any CVC.
3. Rows appear as `pending`, white background, position in column Z.
4. Stripe webhook delivery shows **200**.
5. Status flips to `paid`.
6. Confirmation email arrives with the calendar invite attached.
7. Confirmation page shows the booking, and both calendar buttons work.
8. Refund the test payment in Stripe → row becomes `refunded`.
9. Start a checkout and abandon it → about 31 min later the row becomes
   `expired`, and the next cleanup run deletes it.
