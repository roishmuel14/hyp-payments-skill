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
8. Closing the stage

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
- What the 15 tests prove (54 steps): the card flow (J5 page with one payment, decline and wrong CVV
  save nothing, another customer's or a forged or expired redirect is refused, the `+` in `Sign`
  survives VERIFY, the token never leaves the server, reload answers without HYP, 901 is a clear "not
  available"); a test charge never runs twice (two clicks at once); cancel and refund (920 then refund,
  partial, more than left, stale screen, two clicks, HYP's 33 and 901, no answer, the production 125);
  one-time payments (server price, decline keeps the page open, forged redirect, unknown order, two
  tabs = one claim and one fulfillment, amount mismatch, signed-in owner, guest cancel, page limit,
  fulfillment retried once); the subscription run (not before the trial ends, reminders once, expiry
  without a card, one charge per period even twice or in parallel, tries on days 3 and 7 then expiry,
  a new card charges at once, an unknown answer stops the period, a dead run only moves dates, cancel
  at period end, trial extension); `runBilling` ignores its body and a second run charges nothing;
  with one HYP host down, SIGN, VERIFY and getToken use the other while a charge goes to one host once
  and stays "unknown".
- What they do NOT prove: HYP's real answers, the platform's RLS, the Workflow schedule, the screens.

## 2. Break checks

`bash tests/break-checks.sh` breaks one money rule at a time in a throwaway copy (the charge claim,
the refund claim, the `+`, the paid-page claim, the amount check, the subscription lock, a period with
an unknown row, the token in the summary, a charge retried on the second host, a single-payment page
without `Tash`) and expects the tests to fail. All 10 lines must say `caught`.
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
     for a customer), also on the published copy (`Base44-Functions-Version: prod`);
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
| Card check, wrong CVV | the same with a wrong CVV | "הכרטיס לא נשמר" with the CVV reason; log `CCode=6`; nothing saved |
| Token charge | admin, test charge of 1 ILS | "החיוב עבר"; `CCode=0`; a `succeeded` Payment; the portal shows it; an invoice if the module is on |
| Cancel the same day | admin, "ביטול העסקה" before 22:00 | `CCode=0` (`ReversalStatus` may be 125); portal "עסקה בוטלה" (998); the customer sees "בוטל" with the amount struck |
| Refund | a 1 ILS charge, then "זיכוי" (part, then the rest), the next day for "after transmission" | `CCode=0` with a new `Id`; the portal shows its own row "זיכוי עסקה מספר: <the charge>" with a minus amount; "זוכה חלקית" then "זוכה". A full same-day refund passed live (10/2026); partial and after-transmission not yet |
| One-time payment | buy at a test price that only admins get (for example a secret `PAYMENT_TEST_AGOROT=50` with a `PAYMENT_MODE` switch off/admin/on) | paid, fulfilled once, a reload answers again; cancel it the same day |
| A payment that never came back | pay, then close the tab before the return | the row stays `awaiting_payment`; the admin's report of open pages lists it; the portal shows the charge (no webhook in Hyp Pay) |
| Subscription run | a test account due today; run the Workflow now | one charge, dates moved; a second run charges nothing; cancel the charge the same day |

Notes from the live runs:
- A wrong CVV under J2 passed (status 600, portal "בדיקת CVV: לא הוכנס"): that is why the card check
  is J5 (subscription app, 10/2026).
- The first token charge failed with `CCode=6` until HYP removed the CVV requirement on token charges
  (subscription app, about two weeks). Ask for it before step 3.
- A cancel answered `ReversalStatus=125`, not the docs' 777 (subscription app, 11/2026): `CCode=0` is
  the contract.
- Every test charge is cancelled the same day, before HYP's nightly transmission (until about 22:00),
  so no fee and no refund are needed. Testing a refund after transmission needs a charge left
  overnight on purpose. A per-request `successUrl` was ignored live (10/2026): test the return on the
  terminal's own address.

## 6. The leak check

From a second, non-admin account (not your admin), in the browser's DevTools on the live site:
`BillingAccount` returns `[]`; `Payment` returns only that account's own rows; the field list of an own
row has no token, `Tokef` or ID number. An anonymous `curl` on the same entities returns `[]`. Compare
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

## 8. Closing the stage

- Check off the stage in the project's plan and record dates and transaction ids there (never
  tokens, never in this skill).
- The client's change log, if the project keeps one, in plain Hebrew: what the customer sees, that
  nothing is charged on a card check, what is still the client's decision (VAT, invoices).
- Anything new that HYP or the platform did: into this skill (SKILL.md, "עדכון הסקיל").
