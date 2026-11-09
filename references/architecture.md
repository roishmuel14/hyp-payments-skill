# Architecture and security

Two rules carry everything: **the code never moves money by mistake, and never loses a charge that
already happened.** Every pattern below exists because a live integration needed it.

## Contents

1. The server is the boundary
2. Data model
3. Flow A: one-time payment page
4. Flow B: card check and token (subscriptions)
5. Flow C: token charge
6. Flow D: cancel and refund
7. Claims, locks and "unknown"
8. The return page
9. Logging and secrets
10. Base44 traps that touch payments

## 1. The server is the boundary

- Every HYP call is made by a backend function. `KEY` and `PassP` live in the platform's secrets and
  never reach the browser; the payment page URL HYP signs carries no credentials (a test asserts it).
- The browser never sends an amount, a discount, an installment count beyond what is allowed, a
  customer id or a payment status that the server trusts. The price comes from the server
  (`products.ts quote`, `getBillingSettings`); a coupon is re-validated on the server (the live
  checkout does this); the customer comes from the signed-in user (`findOwnCustomer`), never from the
  body.
- The card token, `Tokef` and the cardholder's ID number live only in `BillingAccount`, whose RLS is
  admin-only for every operation, and leave the server only as a summary: last 4 digits, the brand
  when it is a word, the expiry as MM/YY (`cardSummary`). Not even the admin's browser gets the token.
- `Payment` is readable by its owner (`owner_user_id`) and admins; written only by functions. A guest
  row's owner is the literal `guest`, never empty, so an anonymous reader's empty user id can never
  match it.
- Admin actions check `user.role === 'admin'` in the function (403 otherwise); the screen hiding a
  button is not a control.
- A scheduled route (`runBilling`) is reachable without a user: it reads nothing from the body, and
  every run is idempotent, so a stray call can only do what is already due.
- Errors follow one contract: `422 { error, reasons: [{ code, message }] }`, every code translated in
  the frontend (`billing-i18n.js`). The server's Hebrew `message` is never shown as is.

## 2. Data model

`BillingAccount` (one per customer, server-only): `customer_id`, `owner_user_id`, `token`, `tokef`,
`card_last4`, `card_brand`, `card_id_number`, `card_trans_id`, `card_saved_at`; the one-time card
session (`session_id`, `session_expires_at`, `confirmed_session_id`); the lock (`charge_lock`,
`charge_lock_at`); subscription state (`subscription_status`, `trial_ends_at`, `next_period_start`,
`next_charge_on`, `paid_through`, `due_since`, `failed_attempts`, `cancel_at_period_end`,
`last_notice`).

`Payment` (one per HYP transaction attempt): `customer_id` (`guest:<email>` for an anonymous buyer),
`owner_user_id`, `kind` (`one_time`, `test`, `subscription`), `description`, `amount` (ILS incl. VAT),
`status`, the claim (`claim_id`, `claimed_at`), HYP's answer (`hyp_trans_id`, `ccode`, `acode`,
`invoice`, `charged_at`, `error_code`); one-time fields (`order_id`, `page_expires_at`, `buyer_*`,
`paid_amount`, `installments`, `card_last4`, `last_ccode`, `fulfilled_at`); subscription fields
(`period_start`, `period_end`, `attempt`); money back (`refunded_amount`, `refunds[]`, `cancelled_at`,
`refunded_at`, `refund_claim_id`, `refund_claimed_at`).

Statuses: `awaiting_payment` (page open) | `pending` (token charge created) → `processing` (claimed,
sent) → `succeeded` | `failed`; then `cancelling` → `cancelled`, `refunding` → `refunded` |
`partially_refunded`. `processing`, `cancelling`, `refunding` with no answer = **unknown**: checked in
the HYP portal and fixed by hand, never retried automatically.

The subscription status lives on `BillingAccount` in the templates (one project kept it on its own
customer record instead, to have one source next to its public listing). Pick one place;
`onSubscriptionChange` mirrors it.

## 3. Flow A: one-time payment page

```
browser                    createPayment (server)                 HYP
  | form: name, email ------> quote() on the server
  |                          Payment row: awaiting_payment, order p...
  |                          SIGN (Amount, Order, Tash?, SendHesh?) -> signature
  | <------ { url } ---------
  | ---------------------------- pays on HYP's page --------------->
  | <---- redirect to the terminal's return URL (?Id&CCode&Amount&Order&...&Sign)
BillingReturn: rawQuery -> confirmPayment (server)
                             Order is ours and open? (shape checked first)
                             CCode 0? VERIFY (every param, in order) -> 0
                             Amount == our price?
                             claim: updateMany {id, status: awaiting_payment} -> succeeded
                             fulfill() once (claim on fulfilled_at)
  | <-- { payment, first } -- (first = fire the purchase pixel now; a reload answers false)
```

- The Payment row is written before the page is signed: no money without a trace on our side.
- A declined try keeps the page open (`last_ccode`), so the buyer can retry on the same page.
- A reload, a second tab or a back button: the claim lets one call close the row; the others answer
  the same result with `first: false` (no second CAPI/pixel event: the live checkout's Meta dedup uses
  the order id as `event_id` on both sides).
- An amount that differs from the price after a valid VERIFY: money moved, so the row becomes
  `succeeded` with `error_code: amount_mismatch` (visible for a refund) and nothing is fulfilled.
- Fulfillment that throws gives its claim back; the next reload retries it. Make `fulfill` safe to run
  twice anyway (check before granting).
- Limits for an open route: shape checks before any query, at most 5 open pages per email.
- **The return may never come.** Hyp Pay has no webhook and no API that finds a transaction: a buyer
  who pays and closes the tab leaves the row `awaiting_payment` while the money moved. One live app's
  answer: an hourly email to the admin of pages that went to HYP and did not come back, and an admin
  action that marks one paid with the transaction number from the portal (after looking it up). The
  live checkout sends one recovery email to abandoned checkouts (rows open 2 to 48 hours) from an
  hourly Workflow. Build one of these for every one-time flow.
- A 100% coupon never visits HYP: an amount-0 row created only after the coupon was validated on the
  server, finalized on the server with the coupon checked again. `createPayment` refuses a zero
  amount; add that path in the project if it sells free orders.
- Analytics: the live checkout sends Meta CAPI only on the first verification, with the order id as
  `event_id`, and the page fires its pixel with the same id (`first: true`). "1 browser + 2 server"
  events per sale in Meta is normal (Meta mirrors the browser event).

## 4. Flow B: card check and token (subscriptions)

```
customer (signed in) -> createCardSession: BillingAccount.session_id = k..., expires in 60 min
                        SIGN with J5=True, Amount=1 (Order = session id) -> page URL
HYP page: card, CVV, ID -> card company authorizes 1 ILS (CCode 700) or declines (6, 4, ...)
redirect -> BillingReturn (login detour keeps the raw query) -> confirmCard:
   the Order is THIS user's open session, not expired (else session_mismatch / session_expired)
   CCode in 700 / 600 / 0 (else the decline reason; nothing saved, no HYP call)
   VERIFY -> 0, getToken(Id, allowFalse=True) -> Token (19 digits), Tokef (YYMM)
   compare-and-set on session_id: save token, tokef, last4, brand (if a word), ID (if not 000000000)
   answer { card: { last4, brand, exp, expired } }
```

- The 1 ILS is never captured: J5 holds it for about 5 days and lets it go. HYP's page still shows
  "לתשלום ₪1.00" (for J2 too) while nothing is charged; the portal's "סה"כ סליקה" stays empty
  `[LIVE: subscription app, 10/2026]`. Tell the customer on the page before the button.
- A reload after success answers again from `confirmed_session_id` without calling HYP.
- `CCode` 0 on a card check means HYP charged the 1 ILS: logged as a warning, cancel it in the portal.
  600 means J2 (no check): logged as a warning.

## 5. Flow C: token charge

`adminCharge` (test) and `billAccount` (subscription) share one path:

1. Take the account lock (`lockAccount`: `updateMany` compare-and-set on the value read; a lock older
   than 15 minutes belongs to a dead run and is taken over the same way).
2. Re-read under the lock and decide on that read.
3. Create the Payment row (`pending`), then `chargePayment`: claim it (`pending` → `processing` with a
   random `claim_id`) **before** calling HYP. A second claim updates 0 rows and sends nothing.
4. One `soft` call. `CCode=0` → `succeeded`; another code → `failed` with the reason; no answer
   (network error, timeout, HTML) → stays `processing` = unknown.
5. Every later write matches the claim (`status: processing, claim_id`). Release the lock in `finally`.

## 6. Flow D: cancel and refund

`adminRefundPayment` with `{ customer_id, payment_id, action, amount?, expected_refunded, note }`:

1. Admin only. `expected_refunded` is what the admin's screen showed: if the row changed since (a
   double click, a retried request, a second admin), nothing is sent (`payment_changed`).
2. The customer's account lock (when there is an account: a charge and a refund never run at once).
3. Re-read; refuse an in-flight row (`refund_unknown`), compute what is left in agorot.
4. Cancel: only a `succeeded` charge with nothing given back; always the whole amount. Refund: up to
   what is left (we count earlier refunds ourselves; HYP's 33 is a second guard). A full refund on the
   charge day passed live (the small-payments app, 10/2026), against the docs; the templates still
   offer a cancel that day (no fee) and a refund after a 920 or from the next day. A project that needs
   a partial refund on the charge day can offer a refund then too.
5. `reversePayment` claims the row on its exact `status` and `refunded_amount` (to
   `cancelling`/`refunding`, the attempt appended to `refunds[]`) before HYP is called.
6. `CCode=0` → `cancelled` / `refunded` / `partially_refunded` (`refunded_amount` grows); a code →
   back to the previous status, the attempt `declined` with its reason; no answer or no `CCode` →
   stays in flight = unknown.
7. What the admin is offered (`reverseOffer`): a cancel on the Israel day of the charge while nothing
   was given back and HYP did not answer 920; a refund otherwise or right after a 920 (the dialog
   reopens as a refund of the whole amount). The server does not check the day: HYP decides.
8. The customer sees "בוטל", "זוכה", "זוכה חלקית: X ₪" or "בטיפול", never the attempts.

## 7. Claims, locks and "unknown"

- **Claim = `updateMany(filter, { $set })` that wins only when `updated === 1`.** Verified on a
  production Base44 app with a throwaway row (11/2026): a second claim updates 0; `{ field: null }`
  matches a field the row never had; a number in the filter matches exactly; arrays of objects in
  `$set` are stored as given `[LIVE]`. So claim fields have **no schema default**.
- **Keep `id` at the top level of the filter**: an `id` inside `$and` matches nothing, in `filter` and
  `updateMany` alike (verified 10/2026; a whole stage of compare-and-sets was silently lost). The fake
  SDK copies this behaviour.
- **Validate shapes before any filter**: an empty string in a filter matches every row (a cleared
  token `''` matched every row of a table in another app, 07/2026). Session ids and order ids have a
  fixed shape (`k`/`p` + 31 hex), checked first.
- **Unknown is not failed.** No answer from HYP means the card may have been charged. The row stays
  `processing` / `cancelling` / `refunding`, the admin sees "לא ידוע" in red with "check the HYP
  portal", the buttons refuse it (`refund_unknown`), and the daily run stops that period. A person
  looks the transaction up in the portal and fixes the row by hand (`base44 exec`, `updateMany` on the
  exact in-flight status and claim id).
- One money action per customer at a time (the account lock), one claim per row, decisions on a fresh
  read under the lock, and nothing retried on a guess.

## 8. The return page

- One page for the terminal's success address (and its failure address, if one is set: never a
  different page, because J5 700 and Postpone 800 would land there), for both flows; the `Order`
  prefix picks the server function (`k` card, `p` payment). A per-request return URL does not exist
  (ignored live, 10/2026), so two sites on one terminal need this routing or two terminals.
- Alternative seen live (the small-payments app, 10/2026): the success link points straight at a
  backend function; the Base44 functions gateway passes the GET query in and the function's 302 out.
  The function must read `req.url`'s raw query (the same `+` rule), then redirect to a result page.
- Take `window.location.search` raw, store it in sessionStorage, remove it from the address bar, and
  send it as `rawQuery`. Never rebuild it with `URLSearchParams` (the `+` in `Sign`).
- A card flow needs a signed-in customer: a visitor goes to log in and comes back; the stored query
  survives the detour.
- The page only reports. "לא בוצע חיוב" is shown only when it is true: a card check (never captured)
  or a declined card. After a VERIFY failure or no answer the money may have moved.

## 9. Logging and secrets

- Never log a URL sent to HYP (it carries `PassP` and `KEY`). Network errors can quote the URL: the
  templates strip the query from the message (a test asserts `PassP` never appears).
- Never log a `getToken` answer, a token, `Tokef` or an ID number. Log the customer id, the HYP `Id`
  and the `CCode`: enough to find the transaction in the portal.
- Secrets: `HYP_MASOF`, `HYP_PASSP`, `HYP_KEY` via `base44 secrets` (or the stack's secret store), set
  by a human (terminal-setup.md section 5). `hypConfig()` returns null until all three exist, and the
  screens then hide the payment button (`card_enabled: false`) instead of failing at HYP.

## 10. Base44 traps that touch payments

Platform details live in the Base44 docs; the ones that matter for money:

- Every function has a draft copy and a published copy; the live app runs the published copy
  (`Base44-Functions-Version: prod`). `base44 functions deploy` changes the draft only: Publish after
  every function change the site calls, then probe the published copy. Anonymous routes (the return
  flow for guests) serve the last published snapshot.
- New secret names may reach the published copy only after a Publish (one measurement each way):
  probe, never predict.
- Shared code: functions deploy without a bundler, so `base44/shared/*.ts` is copied into each
  function's `_shared/` by `scripts/sync-shared.mjs` (run `--check` before every deploy). No
  `function.jsonc` next to a function (it breaks the shared imports).
- Schedules: apps created after July 2026 are on Workflows and reject `function.jsonc` crons with 409.
  Create the Workflow through the Apps API (`POST /api/apps/<id>/workflows`, validate first); the sync
  mirrors it to `base44/workflows/`. The Workflow invokes the function with its args at the top level
  of the body; `runBilling` ignores the body anyway. Workflows do not run under `base44 dev`.
- `base44 entities push` is a full sync: it deletes every live entity your checkout lacks. Compare
  `base44/entities/` across every local copy of the repo (branches, `git worktree list`) first.
- `base44 dev` forwards `updateMany`, `aggregate` and cursor pages to PRODUCTION: never run a claim or
  a charge flow against the local backend with production data. Prove claims with the unit tests and
  one throwaway row on prod.
- Never filter by `created_date` / `updated_date` on the server (it returns zero rows): use explicit
  day fields (`next_charge_on`, `period_start`) in Israel time (`israelToday`).
