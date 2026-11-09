# Subscriptions

Two ways to bill monthly with HYP. The interview (question 2) picks one per project.

| | Merchant-managed tokens (templates) | HYP-managed recurring (`HK=True`) |
|---|---|---|
| Who charges each month | our daily run (`runBilling`) | HYP |
| Free trial of any length, admin extensions | yes | no: the page's own payment is the first charge |
| Amount per cycle | anything (price changes, discounts) | fixed (`TashFirstPayment` can differ once) |
| Our records and emails per charge | yes, synchronous `CCode` | no documented notification per charge |
| Code | card check, token, daily run, retries | one page + `HKStatus` to stop |
| Status | built and tested against fakes; the card check, token charge and cancel ran live, the daily run not yet | `[DOC]` only |

A subscription project chose tokens (10/2026) for a trial whose length the admin sets and extends,
and for its own notifications. HK fits a plain fixed subscription that starts paying on sign-up.

## Contents

1. Merchant-managed: the lifecycle
2. The daily run, rule by rule
3. Dates
4. Customer and admin actions
5. What the customer and the public site see
6. HYP-managed recurring (HK)
7. Open points to settle on the first live run

## 1. Merchant-managed: the lifecycle

```
none --startTrial--> trial --(trial ends, card, charge OK)--> active --(each month, OK)--> active
                       |                                         |
                       | trial ends, no card                     | charge declined / card expired
                       v                                         v
                    expired <--(after the last try and grace)-- past_due --(new card, charge OK)--> active
                       ^                                         |
                       +--------(new card: charged at once)------+
active --(cancel_at_period_end, the period ends)--> cancelled
```

The card is collected with a J5 check (references/architecture.md flow B) when the interview says so:
at sign-up, or any time before the trial ends.

## 2. The daily run, rule by rule

`runBilling` runs once a day from the Workflow "Daily billing" (09:00 Israel time). It pages through
accounts in `trial`, `active` and `past_due` and calls `billAccount(base44, id, today, settings, cfg)`
one account at a time; an error on one account is logged and the run goes on.

For one account (`subscription.ts`):

1. Reminders before anything else: a trial without a card gets `trial_ending_no_card` 7 days and 1
   day before its last day; a card whose `Tokef` ends before the next charge gets `card_expiring` in
   the last 7 days. Each reminder goes once: its key is claimed on `last_notice` with `updateMany`.
2. Not due (`next_charge_on` after today): done.
3. Take the account lock; re-read; decide on the fresh read.
4. `cancel_at_period_end`: status `cancelled`, no charge.
5. A trial without a card on its first unpaid day: `expired` at once (no tries, no grace).
6. The period: `next_period_start` to one calendar month later minus a day (`addMonths` clamps 31/01
   to the end of February).
7. Payment rows of this period:
   - one `succeeded` or `partially_refunded`: a run died after HYP charged and before the dates moved:
     move the dates only;
   - one `processing`, `cancelling`, `refunding`, `cancelled` or `refunded`: **stop**, log, a person
     decides (HYP did not answer, or an admin gave the money back);
   - a `pending` row (created, never claimed: HYP was not called) is reused;
   - `failed` rows are earlier tries.
8. Tries: on day 0, 3 and 7 counted from the day the period fell due (`due_since`), counted in
   `failed_attempts`. A missing or expired card, or a blocked customer, counts as a failed try without
   calling HYP.
9. No valid `monthly_price` in the settings: nothing is charged, an error is logged.
10. The charge: a `pending` Payment (`kind: subscription`, `period_start`, `period_end`, `attempt`,
    `created_by: cron`), claimed, one `soft` call (references/architecture.md flow C).
11. Success: `active`, `paid_through` = the period's last day, `next_period_start` and
    `next_charge_on` = the next day, tries reset.
12. A decline: `past_due`, the next try's day, a `charge_failed` notice. After the last try, the
    account waits for the expiry day (`due_since` + max(grace days, 7)) and then becomes `expired`
    (the public site hides it through `onSubscriptionChange`; nothing is deleted).
13. No answer from HYP: the row stays `processing`; the account dates do not move; every later run
    stops at rule 7 until a person checks the portal and fixes the row.

Why the run is safe to repeat (a second Workflow run, a manual POST): every charge happens under the
account lock, after a fresh read, only for a due period without a paid or unknown row, and only after
the row claim. The tests prove "run twice the same day = one charge" and "two runs at once = one
charge".

## 3. Dates

- All business days are Israel days (`YYYY-MM-DD` from `israelToday()`), stored in explicit fields.
  Never derive them from `created_date`.
- `trial_ends_at` = the trial's last day; the first charge is the day after.
- The Workflow's cron is written in the Workflow's own timezone field (`Asia/Jerusalem`, `0 9 * * *`).
  Confirm the first real run's time in the Workflow's runs list (and `base44 logs --env preview`):
  Workflows do not run under `base44 dev`.

## 4. Customer and admin actions

The templates give helpers; the project wires them into its own function (customer or admin, as the
action needs):

| Action | Helper | Who |
|---|---|---|
| Start a trial | `startTrial(base44, account, today, days)` | server, at sign-up or at admin approval |
| Extend a trial | `extendTrial(base44, account, lastDay)`: moves `next_charge_on` | admin |
| Cancel / take back the cancel | `cancelAtPeriodEnd(base44, account, on)` | customer or admin |
| Replace the card | `createCardSession` + `confirmCard` (a past_due or expired account is charged at once: `retryWithNewCard` + `billAccount`) | customer |
| A free month | move `paid_through`, `next_period_start`, `next_charge_on` forward a month (not written as a helper) | admin |
| Retry now | `billAccount` with today after setting `next_charge_on` to today | admin |
| A test charge | `adminCharge` | admin (a human, real money) |

A cancel or refund of a subscription payment does not move `paid_through` back: that is the admin's
decision (for example a refund plus a cancel of the subscription).

## 5. What the customer and the public site see

- `getMyBilling`: status, trial end, price, the card summary, next charge, paid through, payments.
- Notices (`customer.ts notify`): trial ending without a card (7 days, 1 day), card expiring, charge
  failed (with the next try), expired, cancelled. Hebrew and English; copy the admin on failures.
  Base44 `SendEmail` reaches only the app's registered users; WhatsApp goes through an in-app agent.
- Public visibility (`onSubscriptionChange`): for example, a directory keeps a listing visible in
  `trial`, `active` and `past_due`, and hides `expired` and `cancelled` (never deletes).

## 6. HYP-managed recurring (HK)

All `[DOC]` (references/protocol.md section 11):

1. The page: `signPage(cfg, { order, amount, info, recurring: { months: 1, charges: 999 }, ... })`
   sends `HK=True`, `freq`, `Tash`, `OnlyOnApprove=True`. The customer sees on HYP's page that this is a
   recurring charge.
2. The redirect adds `HKId`: store it on the customer's record (server-only), with the first
   payment's `Id`.
3. Stop: `hkStatus(cfg, hkId, 1)`; resume: `hkStatus(cfg, hkId, 2)`. `906` = no such agreement.
4. Later charges happen at HYP: they show in the portal (and in HYP's invoices if the module is on),
   not in our records. A project that must know each charge reads the portal's reports; no API for
   that was checked.
5. Tests: VERIFY of the first redirect as in flow A; there is no token and no daily run.

## 7. Open points to settle on the first live run

Record the answers in the project's plan and in this skill (SKILL.md, "עדכון הסקיל"):

- The first real monthly charge on a production terminal through `runBilling`.
- The Workflow's real run time and invoker (`base44 logs --env preview` and the runs list).
- Whether HYP's duplicate-prevention setting ("מניעת עסקאות כפולות") interferes with a retry of the
  same amount on the same card.
- A token charge on a card whose `Tokef` passed: expect a decline; the run counts it as a failed try
  without calling HYP.
- What HYP Invoice issues for a cancel and a refund when the module is on (the docs say a document
  for every transaction, refunds and cancellations included).
