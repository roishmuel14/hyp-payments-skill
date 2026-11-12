# Testing and go-live: the ladder

Climb in order; each rung needs the one before. Claude never moves real money: from rung 5 on, a human
(the developer or the business owner) presses every money action on the screen and Claude reads the
results, read-only (logs, rows without the token, the portal view-only).

## Contents

1. Unit tests with the fakes
2. Break checks
3. Screens with no backend
4. Deploy, Publish, read-only probes
5. Real money, pressed by a human
6. The leak check
7. Switching from a test terminal to production
8. Going live with a subscription
9. Closing the stage

## 1. Unit tests with the fakes

```bash
node scripts/sync-shared.mjs && deno test --no-config --node-modules-dir=none --import-map=tests/import_map.json --allow-env --allow-read=. tests/
```

How the harness works (`templates/tests/`):
- **Fake HYP**: `globalThis.fetch` is replaced; it answers every documented action like the docs
  (SIGN echoes and signs, VERIFY checks `Sign`, `Order`, `CCode` and `Amount` against what the fake
  "page" recorded, `getToken` needs `allowFalse=True` and the permission flag, `soft` checks the token
  and `Tmonth`/`Tyear`, `CancelTrans` answers 920 once a charge is "transmitted", `zikoyAPI` answers 33
  above the charge) plus switches for a silent HYP (timeout), a 901, a decline code, and the real
  production cancel answer (`ReversalStatus=125`).
- **Fake SDK** (`fake-sdk.ts`, mapped over `npm:@base44/sdk@0.8.52` by `import_map.json`): an
  in-memory store with `filter`, `list` (with skip), `get`, `create`, `update`, and `updateMany` as an
  atomic compare-and-set; `{ field: null }` matches a missing field and an `id` inside `$and` matches
  nothing, like the platform; `auth.me()` reads a URI-encoded `x-test-user` header.
- **Functions**: `Deno.serve` is stubbed before each `import` of an `entry.ts`, so every handler is
  captured and called with a real `Request`.
- What the 16 tests prove (59 steps): the card flow (J5 page with one payment, decline and wrong CVV
  save nothing, another customer's or a forged or expired redirect is refused, the `+` in `Sign`
  survives VERIFY, the token never leaves the server, reload answers without HYP, 901 is a clear "not
  available"); a test charge never runs twice (two clicks at once); cancel and refund (920 then refund,
  partial, more than left, stale screen, two clicks, HYP's 33 and 901, no answer, the production 125);
  one-time payments (server price, decline keeps the page open, forged redirect, unknown order, two
  tabs = one claim and one fulfillment, amount mismatch, signed-in owner, guest cancel, page limit,
  fulfillment retried once); the subscription run (not before the trial ends, reminders once, expiry
  without a card, one charge per period even twice or in parallel, tries on days 3 and 7 then expiry,
  a new card charges at once, an unknown answer stops the period, a dead run only moves dates, cancel
  at period end, trial extension, no card-expiring email on the charge day); the billing mode (unset
  or unknown = off and plans only, `test` charges only the listed customer 1 ILS, an anonymous
  `dry_run` is ignored, an admin's dry run in `live` acts on nobody, `live` charges the full price);
  `runBilling` ignores an anonymous body and a second run charges nothing;
  with one HYP host down, SIGN, VERIFY and getToken use the other while a charge goes to one host once
  and stays "unknown".
- What they do NOT prove: HYP's real answers, the platform's RLS, the Workflow schedule, the screens.

## 2. Break checks

`bash tests/break-checks.sh` breaks one money rule at a time in a throwaway copy (the charge claim,
the refund claim, the `+`, the paid-page claim, the amount check, the subscription lock, a period with
an unknown row, the token in the summary, a charge retried on the second host, a single-payment page
without `Tash`, billing that ignores `BILLING_MODE`, a test-mode charge at the full price, a
card-expiring email on the charge day, an anonymous `dry_run` obeyed) and expects the tests to fail.
All 14 lines must say `caught`.
Run it after adapting the templates: a rule the adapted tests no longer guard shows as `MISSED`.

## 3. Screens with no backend

Every touched screen at 375 px and 1440 px, in Hebrew and in English, with no horizontal scroll:
the return page (checking, card saved, paid, each failure reason, a guest buyer, a login detour), the
customer's billing tab, the admin panel (no card, card, expired card, test charge dialog, each payment
status, "לא ידוע", a declined attempt, the cancel dialog, a 920 that reopens as a refund, the refund
amount limit). Run Vite alone and answer every `/api/apps/**` call from fixtures in Playwright. Route
only the site's own origin.

## 4. Deploy, Publish, read-only probes

1. `node scripts/sync-shared.mjs --check`; the tests and break checks pass.
2. `git worktree list`, compare `base44/entities/` in every local copy, then `base44 entities push`;
   compare the live schemas with the files.
3. `base44 functions deploy <name>` for every billing function.
4. Push the frontend, confirm the sync reached Base44, Publish, then check that the live bundle has the
   new code.
5. Read-only probes on the live app, without money:
   - every billing function answers 401 without a user (and `adminCharge` / `adminRefundPayment` 403
     for a customer), also on the published copy (`Base44-Functions-Version: prod`). Not `runBilling`:
     it answers anyone, and in `test` or `live` an anonymous POST is a real run. Probe it only while
     `BILLING_MODE` is off, or as an admin with `{ dry_run: true }`;
   - before the secrets: the billing tab shows the old message and the admin panel "הסליקה עוד לא
     מחוברת" (`card_enabled: false`); after them: "הוספת כרטיס" appears;
   - the return page with made-up parameters is refused and writes nothing;
   - an anonymous read of `BillingAccount` and `Payment` returns `[]`.
6. A claim on prod: one throwaway Payment row with no transaction, claimed twice with `updateMany`
   (first 1, then 0), then deleted.

## 5. Real money, pressed by a human

Before each request to the user, one line: what is real (which terminal, whose card) and what is still
missing from the gate (references/terminal-setup.md section 6). Then a small table per step: what to
click, what should happen. Claude checks the logs (`CCode`, `Id`), the rows (never printing the token)
and asks the user for the portal view.

| Step | The human does | Expected |
|---|---|---|
| Card check, good card | "הוספת כרטיס", a real card | the site: "הכרטיס נשמר" with 4 digits and expiry; log `CCode=700`; portal: status 700, 1 ILS shown, "סה"כ סליקה" empty |
| Card check, wrong CVV | the same with a wrong CVV | "הכרטיס לא נשמר" with the CVV reason; log `CCode=6`; nothing saved. Run it again after every change HYP makes to the terminal: once the CVV requirement on token charges is removed, this passes with 700 and the card is saved (subscription app, 11/2026) |
| Token charge | admin, test charge of 1 ILS | "החיוב עבר"; `CCode=0`; a `succeeded` Payment; the portal shows it; an invoice if the module is on |
| Cancel the same day | admin, "ביטול העסקה" before 22:00 | `CCode=0` (`ReversalStatus` may be 125); portal "עסקה בוטלה" (998); the customer sees "בוטל" with the amount struck |
| Refund | a 1 ILS charge, then "זיכוי" (part, then the rest), the next day for "after transmission" | `CCode=0` with a new `Id`; the portal shows its own row "זיכוי עסקה מספר: <the charge>" with a minus amount; "זוכה חלקית" then "זוכה". A full same-day refund passed live (10/2026); partial and after-transmission not yet |
| One-time payment | buy at a test price that only admins get (for example a secret `PAYMENT_TEST_AGOROT=50` with a `PAYMENT_MODE` switch off/admin/on) | paid, fulfilled once, a reload answers again; cancel it the same day |
| A payment that never came back | pay, then close the tab before the return | the row stays `awaiting_payment`; the admin's report of open pages lists it; the portal shows the charge (no webhook in Hyp Pay) |
| Subscription run | `BILLING_MODE=test`, `BILLING_TEST_CUSTOMERS` = the test accounts only, their dates moved by hand to today; run the Workflow (or wait for 09:00) | one 1 ILS charge, dates moved; a second run charges nothing; cancel the charge the same day; then `BILLING_MODE` back to off. Passed live (subscription app, 11/2026), also an expired card through its tries to `expired`, a new card charged at once, a trial extension and a cancel |

Notes from the live runs:
- A wrong CVV under J2 passed (status 600, portal "בדיקת CVV: לא הוכנס"): that is why the card check
  is J5 (subscription app, 10/2026).
- The first token charge failed with `CCode=6` until HYP removed the CVV requirement on token charges
  (subscription app, about two weeks). Ask for it before step 3.
- After that change the J5 page stopped sending CVV and ID: a wrong CVV was saved with 700, and the portal
  showed "בדיקת CVV: לא הוכנס", "בדיקת ת.ז: לא הוכנס", "אופי עסקה: טלפונית" (subscription app, 11/2026).
  The decline screen could then no longer be reached with a wrong CVV.
- A cancel answered `ReversalStatus=125`, not the docs' 777 (subscription app, 11/2026): `CCode=0` is
  the contract.
- Where the evidence comes from: the rows (`BillingAccount` and `Payment`, safe fields only, through
  `base44 exec`) and the portal's transaction details. `base44 logs` showed the Workflow's runs
  (`--env preview`) but not a card save from the live site, and `--env prod` answered "No production
  logs found" (CLI 0.3.1, 11/2026).
- Every test charge is cancelled the same day, before HYP's nightly transmission (until about 22:00),
  so no fee and no refund are needed. Testing a refund after transmission needs a charge left
  overnight on purpose. A per-request `successUrl` was ignored live (10/2026): test the return on the
  terminal's own address.

## 6. The leak check

From a second, non-admin account (not your admin), in the browser's DevTools on the live site:
`BillingAccount` returns `[]`; `Payment` returns only that account's own rows; the field list of an own
row has no token, `Tokef` or ID number. An anonymous `curl` on the same entities returns `[]`.
**First read `User/me`** and stop unless it is the non-admin account you meant: the account signed in
to the browser changes when the user checks things themselves. In one project (11/2026) a probe that
assumed a customer ran as the admin, and a call meant to be refused (a subscription action on another
customer's id) really cancelled and extended a test customer (no money moved, undone the same minute).
Send only bodies a non-admin must be refused, and only after that check. Compare
row counts and field lists, not HTTP status: a denied read answers `200 []`. The return page with
another account's card session is refused (`session_mismatch`). With guest purchases: an anonymous
read of `Payment` still returns `[]` (guest rows are owned by `guest`). UI checks of a private Base44
app run in the user's own logged-in browser (for example Claude in Chrome), view-only.

## 7. Switching from a test terminal to production

1. The user replaces the three secrets (one line each, references/terminal-setup.md section 5).
2. Probe the published copy; Publish if a new name is not visible there.
3. On production the test cards stop working; every check is real money. Run section 5 again with a
   real card, a human pressing, each charge cancelled the same day.
4. Confirm on the production terminal again what HYP enabled on the test one (tokens, J5, no CVV on
   tokens, installments): permissions are per terminal.

## 8. Going live with a subscription

As done at a live launch (11/2026), in order:

1. The business owner's explicit go for `live`: from then on, every approved customer with a card is
   charged the full price the day after the trial.
2. Delete every test customer and every row tied to them (profiles, public rows, stats,
   `BillingAccount`, `Payment`, leads). Keep a local backup first, without tokens, outside the repo.
   Afterwards, as admin, 0 rows in every one of those entities, and the public site empty in every
   language.
3. `BILLING_MODE=live` (references/terminal-setup.md section 5). `BILLING_TEST_CUSTOMERS` may stay; live
   ignores it.
4. An admin's `runBilling` with `{ dry_run: true }` answers `mode: live` and plans nothing unexpected.
5. Any later end-to-end check on the live site with a test customer who saves a card: delete that
   customer and their rows before the trial ends, or the card is charged in full.
6. Record the launch date in the project's plan.

## 9. Closing the stage

- Check off the stage in the project's plan and record dates and transaction ids there (never
  tokens, never in this skill).
- The client's change log, if the project keeps one, in plain Hebrew: what the customer sees, that
  nothing is charged on a card check, what is still the client's decision (VAT, invoices).
- Anything new that HYP or the platform did: into this skill (SKILL.md, "עדכון הסקיל").
