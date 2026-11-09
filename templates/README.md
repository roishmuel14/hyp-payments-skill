# HYP templates: what to copy, what to adapt

Generalized from two live integrations on production terminals: a monthly subscription with
merchant-managed tokens (card check, token charge and cancel ran live in 10/2026 and 11/2026), and a
one-time checkout with installments, coupons and HYP invoices (live with real buyers). The layout
mirrors a Base44 hybrid app (hand-written frontend plus Deno backend functions), so the tree copies
into the project root as is. On another stack, keep `hyp.ts` and the rules, and replace the records
layer (see SKILL.md, "בלי Base44").

## The map

| File | Shape | Status |
|---|---|---|
| `base44/shared/hyp.ts` | all | the HYP protocol. Card check, VERIFY, getToken, token charge, cancel: verified live; a full same-day refund: live. Partial refund, HKStatus, invoice link, installments on the page: `[DOC-ONLY]`. Money-free calls fall back to the second host; a single-payment page sends `Tash=1&FixTash=True` |
| `base44/shared/billing.ts` | all | records: account lock, `chargePayment` and `reversePayment` claims, card summary, settings |
| `base44/shared/customer.ts` | all | **adapt**: who pays (default: the User), names and email for HYP, notification and status hooks |
| `base44/shared/products.ts` | one-time | **adapt**: the server-side price, coupons, and `fulfill` (what a paid order unlocks) |
| `base44/shared/subscription.ts` | subscription | the daily run's logic for one account, trial and cancel helpers. `[DESIGN]`: tested against the fakes only |
| `base44/shared/common.ts` | all | Israel day, the 422 contract, the signed-in user. Keep the project's own if it has one |
| `base44/functions/createCardSession`, `confirmCard` | subscription | the J5 card check and the token (`confirmCard` also charges a past_due account at once with the new card) |
| `base44/functions/getMyBilling` | subscription, one-time | the customer's own card, status and payments |
| `base44/functions/adminCharge` | subscription | the admin's card summary and test charge |
| `base44/functions/adminRefundPayment` | refunds | cancel (same day) or refund (all or part), admin only |
| `base44/functions/createPayment`, `confirmPayment` | one-time | the payment page and its idempotent close; open to anonymous buyers |
| `base44/functions/runBilling` + `base44/workflows/Daily billing.jsonc` | subscription | the daily run and its schedule (create the Workflow through the Apps API) |
| `base44/entities/BillingAccount.jsonc`, `Payment.jsonc` | all | admin-only RLS; Payment readable by its owner |
| `src/pages/BillingReturn.jsx` | all | the one return page for both flows (route it at the URL set on the terminal) |
| `src/components/billing/*.jsx`, `src/lib/billing*.js` | all | card line, payment list, admin panel, refund dialog, texts (he, en) |
| `tests/` | all | fake HYP (stubbed `fetch`), fake SDK (import map), `Deno.serve` captured per function, 15 tests; `break-checks.sh` |
| `scripts/sync-shared.mjs` | all | copies `base44/shared/*` into each function's `_shared/` |

Drop what the project does not use (a one-time shop needs no `subscription.ts`, `runBilling`,
`createCardSession` or `adminCharge`; then remove them from `scripts/sync-shared.mjs` and the tests).

## Adapt, in this order

1. `customer.ts`: `findOwnCustomer`, `getCustomer` (who pays and their HYP name and email), `notify`
   (the project's email or WhatsApp channel), `onSubscriptionChange` (for example hide an expired
   customer from the public site). Then rename "customer" in the admin texts only if the project has
   a better word.
2. `products.ts` (one-time): `quote` reads the real price, re-validates coupons on the server, and
   says how many installments the page offers and whether HYP issues the invoice; `fulfill` grants
   what was bought and must be safe to run again.
3. `billing.ts`: point `SETTINGS_ENTITY` at the project's settings entity (fields `monthly_price`,
   `trial_days`, `grace_days`, `card_required_at_signup`; one-time: `one_time_price`, `one_time_name`,
   `max_installments`, `invoices_enabled`).
4. The `info` and invoice lines (`INFO`, `TEST_INFO`, `CHARGE_INFO`): start them with the app's name.
5. Entities: merge into existing ones if the project already has a payments entity; keep the claim
   fields without a `default` (`refunded_amount`, `fulfilled_at`): the claims match a missing value as null.
6. Frontend: route `BillingReturn` at the return URL; pass the project's `t` and `language`, or
   `billingT(language)`; restyle with the project's design system or brand. The components expect
   shadcn/ui (`@/components/ui/alert-dialog`), lucide-react and Tailwind, as a Base44 app has.

## Run the tests

From the folder that holds `base44/`, `scripts/` and `tests/` (this `templates/` folder itself, or the
project root after copying), with Node and Deno installed:

```bash
node scripts/sync-shared.mjs && deno test --no-config --node-modules-dir=none --import-map=tests/import_map.json --allow-env --allow-read=. tests/
```

Expected on the untouched templates: `15 passed (54 steps)`. Then `bash tests/break-checks.sh`:
all 10 lines must say `caught` (it needs `python3`). When a project already has a
`tests/import_map.json` or `tests/fake-sdk.ts`, merge (the SDK version in the import map must match
the functions' import).

## Deploy order (details: references/testing-and-go-live.md)

`node scripts/sync-shared.mjs --check`, `base44 entities push` (a full sync: compare
`base44/entities/` across every local copy of the repo first), `base44 functions deploy <each>`, push
the frontend, Publish, then probe the published copy. The secrets are set by a human, one line each.
