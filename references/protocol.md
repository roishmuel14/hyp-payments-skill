# HYP Pay protocol: every call we use, verified

Checked against the official docs in 11/2026 (developers.hyp.co.il/pay, the docs' MCP server where
available, and the docs' own markdown: append `.md` to any page URL, the full set is in
`https://developers.hyp.co.il/llms-full.txt`). Each fact carries a tag:

- `[LIVE]`: seen against the real HYP on a production terminal (which integration, and the month).
- `[DOC]`: written in HYP's docs, not yet run live by the integrations behind this skill.
- `[CONTRADICTS-DOC]`: reality differed from the docs; both sides are written. Reality wins.

The live integrations, all on Base44 in 2026: the **subscription app** (a monthly subscription with
merchant-managed tokens), the **checkout** (one-time payments with installments, coupons and HYP
invoices), the **small-payments app** (one-time payments with refunds from the app), plus lessons from
other live sites. HYP can change behaviour: re-check a `[LIVE]` fact on your own terminal.

Never write a parameter from memory: when something here is not enough, read the docs page.

## Contents

1. Transport and answers
2. Payment page: `APISign` / `SIGN`
3. The return redirect
4. `APISign` / `VERIFY`
5. `getToken`
6. Charge a token: `action=soft`
7. Cancel: `CancelTrans`
8. Refund: `zikoyAPI`
9. Payout (credit not linked to a charge): `soft` + `zPass`
10. Two-phase commit (J5) capture, postpone (`commitTrans`)
11. HYP-managed recurring (HK) and `HKStatus`
12. Invoices (Hyp Invoice, formerly EZcount)
13. Payment links (`payRequest`)
14. Test terminal and test cards
15. Status codes that matter
16. The code in `templates/base44/shared/hyp.ts`

## 1. Transport and answers

- One endpoint for everything: `GET https://pay.hyp.co.il/p/?<params>` `[DOC]` `[LIVE: subscription
  app]`. The older host `https://icom.yaad.net/p/` answers too: two live pages ran on it in 10/2026
  `[LIVE]`. In 08/2026 one host was down and a live site stopped taking payments; another checkout
  since tries the other host. The templates do that only for calls that move no money (SIGN, VERIFY,
  getToken, PrintHesh): a charge, cancel or refund is sent once, because a lost answer may hide a
  charge that happened.
- Hyp Pay has **no webhook and no API that looks up or lists transactions** (only Hyp Enterprise, a
  different product, has them): the browser's return plus VERIFY is the only signal. A buyer who pays
  and closes the tab never comes back; reconcile with the portal's transaction list (Excel/CSV export:
  Hebrew headers, no email column, a UTF-8 BOM) `[DOC: no such action in /pay]` `[LIVE: small-payments
  app, checkout]`. Docs answers sometimes mix in Hyp Enterprise (`doDeal`, XML): keep to `/pay/` pages.
- Credentials travel in the query: `Masof` (terminal, 10 digits), `PassP` (API password, not the
  portal password), and `KEY` (API key, only for `APISign`). Call only from the server, never log a
  URL you sent (mask `KEY` and `PassP`; the docs say the same), never log a `getToken` answer.
- The answer is a URL-encoded string (`Id=...&CCode=0&...`) with **HTTP 200 even on an error**:
  success is read only from `CCode`. An HTML answer is a system error on HYP's side `[LIVE: subscription
  app]`.
- Send `UTF8=True` and `UTF8out=True` on every call that carries Hebrew `[DOC: listed under soft]`
  `[LIVE: the subscription app and the checkout send them on SIGN too]`. Without `UTF8out`, HYP answers
  in windows-1255 (the docs' 3DS sample redirect carries `Info=%EC%EC%E0...`), which breaks
  `decodeURIComponent`.
- Amounts are decimal ILS with up to 2 fraction digits (`10`, `10.5`, `10.00`) everywhere in HYP Pay
  except `inputObj.originalAmount` (J5 capture), which is in agorot `[DOC]`.

## 2. Payment page: `APISign` / `SIGN`

Docs: /pay/getting-started/creating-a-payment-page, /pay/reference/actions.

Required: `action=APISign`, `What=SIGN`, `Masof`, `KEY`, `PassP`, `Amount` `[DOC]`. Always add
`Sign=True` (without it the redirect has no `Sign` to VERIFY) `[DOC]`.

Optional, by purpose `[DOC]`:

| Purpose | Parameters |
|---|---|
| Our reference | `Order` (string, comes back in the redirect), `Info` (a line in HYP's transaction list) |
| Customer | `ClientName`, `ClientLName`, `email`, `cell`, `street`, `city`, `UserId` (9-digit Israeli ID) |
| Currency | `Coin`: 1 ILS (default), 2 USD, 3 EUR, 4 GBP |
| Installments | `Tash` (max), `FixTash` (`True` = exactly `Tash`), `tashType` (1 regular, 6 credit with interest, usually 3 or more), `ShowEngTashText=True` with `PageLang=ENG`. **A page without `Tash` offers the terminal's default: up to 36 installments** `[LIVE: an event page and another site's terminal, 10/2026]`: a single payment sends `Tash=1&FixTash=True`. Below a minimum per payment HYP refuses installments (`403`; one checkout offers a single payment under 100 ILS) |
| Card check / hold | `J5=True` (authorization, `CCode` 700), `J5=J2` (details only, `CCode` 600), `Postpone=True` (`CCode` 800, finalize within 72 hours) |
| More redirect fields | `MoreData=True` (see section 3; required for J5 capture) |
| Recurring (HK) | `HK=True`, `freq` (months), `Tash` (charges, 999 = no end), `OnlyOnApprove=True`, `TashFirstPayment`, `FirstPaymentTash` |
| Invoice | `SendHesh=True` (needs `email`), `sendHeshSMS=True` (needs `cell`), `heshDesc`, `Pritim=True`, `EZ.lang`, `EZ.comment`, `EZ.description`, `EZ.vat`, `EZ.cc_emails`, `EZ.customer_crn` |
| Page | `PageLang` (`HEB` default, `ENG`), `tmp` (lowercase; template 1 to 15; some templates have no name fields, then send `ClientName`), `hideBtns=True` (hides the payment-method buttons) |
| Emails | `sendemail=True` = HYP's own payment confirmation email (we send `False`; the invoice is separate) |

Answer: every parameter echoed, `action` changed to `pay`, and `signature` added; no `KEY`, no `PassP`
(safe to hand to the browser). **The payment page URL is the host + `?` + the answer exactly as it
came** (no parsing, no re-encoding) `[DOC]` `[LIVE: subscription app, checkout]`. No `signature` =
failure: a short body like `CCode=902` (wrong `PassP`) or `904` (missing `What`) `[DOC]` `[LIVE: another
checkout]`. HYP's page fills name and email from the request `[LIVE: subscription app]`.

There is **no per-request return URL** in HYP Pay. The success and failure addresses are set on the
terminal (references/terminal-setup.md) `[DOC: the docs' answer, 11/2026]`. `[LIVE: small-payments
app, 10/2026]` a page signed with `successUrl` pointing at that app returned to the terminal's own link
(another site's page on the same terminal), where the payment could even pass VERIFY (same terminal);
the owner spotted it. Two other live checkouts send `successUrl`, `failureUrl`, `errorUrl`,
`pageTimeOut`: none is a documented HYP Pay parameter (`successUrl`/`errorUrl` belong to Hyp
Enterprise), and they "worked" only because they equalled the terminal's setting. Do not copy them.
Two sites on one terminal need one return endpoint that routes by `Order`, or two terminals. Untested:
whether a per-request URL is honored when the terminal stays on HYP's default success page.

The ID field: whether HYP's page shows it and requires it is a portal setting ("שדות למילוי": "מספר
ת.ז גלוי בדף - שדה חובה", next to the CVV field), within what the acquirer allows. Three ways seen:
- The subscription app sends no `UserId`; the page shows the required field and the typed ID comes
  back as `UserId` in the redirect (with `MoreData=True`) `[LIVE: subscription app, 10/2026]`.
- The small-payments app collects the card holder's ID on its own form (check digit validated in the
  browser and on the server), sends it as `UserId` so HYP's page arrives filled, and never stores or
  logs it. Cards without an Israeli ID cannot pay then. Whether the filled field can be edited on
  HYP's page was not checked `[LIVE: small-payments app, 11/2026]`.
- The checkout sends `UserId=000000000` (its own ID field was removed); what HYP's page does with a
  terminal that requires the ID was not checked.
The card company compares the ID with the card: `26` = wrong ID, `6` can mean a missing ID.

## 3. The return redirect

After the page, HYP sends the browser to the terminal's success address (or failure address, when one
is set) with a query `[DOC]`:

`Id` (HYP transaction id: keep it, every later call uses it as `TransId`), `CCode`, `Amount`, `ACode`
(approval number), `Order` (ours), `Fild1` (name), `Fild2` (email), `Fild3`, `Sign`.

With `MoreData=True` also `[DOC]`: `Bank`, `TransType` (`Internet-Secure`, `ApplePay`, `GooglePay`),
`Payments` (installments used), `UserId`, `Brand`, `Issuer`, `L4digit`, `street`, `city`, `zip`,
`cell`, `Coin`, `Tmonth`, `Tyear` (4 digits in the sample), `Hesh`, `UID` (needed for J5 capture),
`spType`, `bincard`; with 3DS also `ECI`; `errMsg` and `Info` appear in the docs' 3DS sample;
recurring adds `HKId`.

- `Brand` can be a number: the docs' own sample has `Brand=1&Issuer=1`, and a production terminal sent
  `Brand=1` `[LIVE: subscription app, 10/2026]`. HYP Pay documents no table for the numbers: show a
  brand only when it is a word.
- **Read the query raw.** `Sign` can be base64 with `+`. `URLSearchParams` (and any form decoder)
  turns `+` into a space, the signature changes, and VERIFY rejects a payment HYP really approved.
  This lost real payments on a live site (fixed there in 08/2026) and was fixed on the checkout in
  10/2026 `[LIVE]`. Send `window.location.search` to the server as `rawQuery`, parse it with
  `decodeURIComponent` per pair (keeps `+`), keep order and duplicates.
- Success codes in the redirect: `0` charge approved; `700` J5 authorization; `600` J2 details; `800`
  postponed `[DOC]`. With a custom failure address on the terminal, HYP sends 700 and 800 (non-zero) to
  the **failure** address even though they succeeded `[DOC]`. One page for both addresses avoids that.

## 4. `APISign` / `VERIFY`

Docs: /pay/security/transaction-validation.

`action=APISign`, `What=VERIFY`, `Masof`, `KEY`, `PassP`, then **every parameter of the redirect, in
the original order** `[DOC]`. Do not filter them: the checkout once kept only a fixed list of HYP
keys; a field HYP adds later would then break every VERIFY. Leave out only `action`, `What`, `KEY`,
`PassP`, `Masof` if a forged redirect carries them.

Answer: `CCode=0` = authentic; `200` = parameters missing; `902` = wrong `PassP` `[DOC]`. Requires
`Sign=True` on the page and the terminal setting "אימות על ידי חתימה בעמודי התשלום" `[DOC]`.

VERIFY proves the parameters are HYP's. It does not prove they are the ones you expected: still check
that `Order` is an open record of yours, bound to the caller where there is one, and that `Amount` is
the amount you priced.

## 5. `getToken`

Docs: /pay/common-use-cases/tokenization.

`action=getToken`, `Masof`, `PassP`, `TransId` (= the redirect's `Id`), `allowFalse=True` (needed when
the transaction is not an approved charge: J5 700, J2 600, cancelled) `[DOC]` `[LIVE: subscription app,
after J5]`.

Answer: `Id`, `CCode`, `Token` (always 19 digits, **the last 4 are the card's**), `Tokef` (**YYMM**),
`Fild1..3` `[DOC]` `[LIVE]`. Codes: `901` no token permission on the terminal (HYP support turns it
on), `902` wrong `PassP`, `910` not a valid transaction and no `allowFalse` `[DOC]`.

A token is per merchant and per terminal; it carries only the card number (no expiry, no CVV, no ID):
store `Token`, `Tokef` and the `UserId` from the redirect (only if the terminal asks for an ID)
together, server-only `[DOC]`.

Digital wallets: the wallet's card number is a single-use token that the docs say cannot be used for
recurring payments (digital wallets page), while the tokenization page says tokens "also work" with
Apple Pay/Google Pay in two-phase commits `[DOC, unclear]`. bit supports neither J5 nor recurring
`[DOC]`. Not tested: whether a card-check page should hide the wallet buttons (`hideBtns=True`).

## 6. Charge a token: `action=soft`

Docs: /pay/reference/actions (Charge a saved token), /pay/advanced-features/recurring-payments.

Required `[DOC]`: `action=soft`, `Masof`, `PassP`, `ClientName`, `Info`, `Token=True`, `CC` (the
token), `Amount`, `Tmonth` (MM) and `Tyear` (YY) split from `Tokef`, `UserId` (the saved 9-digit ID, or
`000000000` when the terminal does not require one).
Optional: `ClientLName`, `email`, `cell`, `phone`, `street`, `city`, `zip`, `Coin`, `Tash`, `tashType`,
`TashFirstPayment`, `tOwner`, `J5`, `Postpone`, `sendemail`, `MoreData`, `UTF8`, `UTF8out`,
`Fild1..3`; invoice: `SendHesh=True` with `email` and `heshDesc`.

Answer: `Id`, `CCode`, `Amount`, `ACode`, `Fild1..3`, `Hesh` `[DOC]`. Codes: `0` charged, `6` CVV
(or a missing ID), `401` name missing, `402` `Info` missing, `447` bad card number or no `Token=True`,
`901` no permission, `902` wrong `PassP`, `997` invalid token `[DOC]`.

- **The terminal must not require CVV for token charges.** The subscription app's production terminal
  did: the first token charge answered `CCode=6` with a valid ID (10/2026). HYP removed the requirement
  on the terminal, and the same charge passed with `CCode=0` (11/2026) `[LIVE]`. The documented
  alternative is two terminals of the same business ID: A (with CVV) makes the token, B (no CVV)
  charges it with `tOwner=<A>` `[DOC]`; `tOwner` itself switches nothing off.
- `Hesh`: the docs call it "the type of invoice" in the soft answer and "the invoice number" in the
  redirect; samples show `Hesh=EZ` and `Hesh=47`. The subscription app's live charge returned no
  invoice number, because the invoice module was not set up `[LIVE]`. Store it as text; do not build
  logic on it.
- One call = one charge. HYP has no idempotency key here: the protection against a double charge is
  ours (claim the Payment row before the call, never retry an unanswered call).

## 7. Cancel: `CancelTrans`

Docs: /pay/common-use-cases/cancellations.

`action=CancelTrans`, `Masof`, `PassP`, `TransId` (the charge's `Id`) `[DOC]`. Works only before HYP
transmits the transaction to the card company, which the docs put at 22:00 Israel time on the same
business day; the whole amount, no card-company fee `[DOC]`. `920` = already transmitted or no such
transaction: refund instead `[DOC]`.

Answer `[DOC]`: `TransId=...&CCode=0&Hesh=EZ&ReversalStatus=777`.
`[CONTRADICTS-DOC]` A production terminal answered `CCode=0` with `ReversalStatus=125` to a cancel the
portal then showed as "עסקה בוטלה" (998) (subscription app, 11/2026). The code first demanded 777 and
left the row "unknown". **Cancelled = `CCode=0`**; keep `ReversalStatus` for reference only.

## 8. Refund: `zikoyAPI`

Docs: /pay/common-use-cases/refunds.

`action=zikoyAPI`, `Masof`, `PassP`, `TransId` (the original charge's `Id`), `Amount` (all or part)
`[DOC]`. A new credit transaction linked to the charge, with its own `Id`: answer
`Id=...&CCode=0&ACode=...&HeshASM=EZ` `[DOC]`. `33` = more than the original `[DOC]`. The docs do not
say whether 33 counts earlier partial refunds: count them yourself and never send more than is left.

`[LIVE: small-payments app, 10/2026]` a full refund of a 0.50 ILS charge (verified in the morning)
passed the same afternoon with `PassP` only: the refund is its own transaction, shown in the portal as
its own row, "זיכוי עסקה מספר: <the charge>", minus 0.50 ILS, source API. Nothing was asked from HYP
for it. `[CONTRADICTS-DOC]` the docs say a refund needs a transmitted, settled charge. On the charge
day a cancel is still better (no fee, the charge disappears); a refund the same day is the way to give
back part of it.

**No `zPass` for a refund**: `zPass` belongs to payouts (section 9) `[DOC]`. If HYP ever answers `901`,
ask HYP support to allow refunds through the API (never seen). A refund made in the portal is
invisible to the app (the order stays "paid"): refund from the app, or fix the row by hand.
Not seen live yet: a partial refund, a refund after transmission, 33.

## 9. Payout (credit not linked to a charge): `soft` + `zPass`

Docs: /pay/advanced-features/payouts. `action=soft` with `zPass` (a "credit password" from HYP
support: phone `*6488` extension 3, or WhatsApp 073-2345000; it is sent to the terminal owner's
mobile), `Amount` (positive), `CC` (token), `Tmonth`, `Tyear`, `Token=True`, `UserId`, `ClientName`,
`Info` `[DOC]`. Only to a card used before on the terminal. `901` can also mean a wrong `zPass`.
None of the live integrations needs it: a refund of a purchase is `zikoyAPI`.

## 10. Two-phase commit (J5) capture, postpone (`commitTrans`)

- J5 capture `[DOC]`: `action=soft` + the token fields + `AuthNum` (the J5 `ACode`),
  `inputObj.originalAmount` (agorot), `inputObj.originalUid` (the redirect's `UID`, needs
  `MoreData=True`), `inputObj.authorizationCodeManpik=7`, `Amount` (same or less). The docs say a J5
  hold usually lasts about 5 days; J5 needs the issuer's pre-approval and may not support every card.
- The subscription app uses J5 only to **check** a card (1 ILS, never captured, released by itself).
  It does not capture: the monthly charge is a new `soft` charge of the token.
- Postpone `[DOC]`: page with `Postpone=True` (redirect `CCode=800`), then within 72 hours
  `action=commitTrans&Masof&PassP&TransId` (answer `Id`, `CCode=0`, `HeshASM`). Not used so far.

## 11. HYP-managed recurring (HK) and `HKStatus`

Docs: /pay/advanced-features/recurring-payments `[DOC]`, never run by the live integrations.

- Page: `HK=True`, `Amount` (fixed per cycle), `freq` (months), `Tash` (number of charges, 999 = until
  stopped), `OnlyOnApprove=True` (recommended: the agreement starts only if the first payment is
  approved), optional `TashFirstPayment` (a different first amount) and `FirstPaymentTash`.
- The redirect adds `HKId`: store it.
- Stop: `action=HKStatus&Masof&PassP&HKId&NewStat=1` (2 = resume). Answer `HKId=...&CCode=0`; `905`
  bad `NewStat`, `906` no such agreement.
- What the docs do not offer: a future start date (the first charge is the page's own payment), a
  variable amount, or a documented notification to us for each later charge. Agreements are visible
  and manageable in the HYP portal.

## 12. Invoices (Hyp Invoice, formerly EZcount)

Docs: /pay/invoicing/basic-invoicing `[DOC]`.

- The docs say invoicing is on by default on every terminal; when active, HYP issues a document
  **automatically for every successful transaction, including refunds, cancellations and payouts**.
  `[CONTRADICTS-DOC]` on both terminals checked it was not usable: one portal showed "המערכת כבר פעילה
  בחשבונכם... להשלים כמה הגדרות" with a "להשלמת ההגדרה" button and "יש להגדיר מספור גבוה מהמסמך
  האחרון שהופק עבור כל סוגי המסמכים" (10/2026); another terminal showed only "הרשמה למערכת
  החשבוניות" (10/2026). With the module not set up, `SendHesh=True` silently does nothing and no
  invoice number comes back `[LIVE: subscription app, 11/2026]`. Check the portal; never assume the
  module works.
- `SendHesh=True` emails the document to `email`; without it nothing is sent to the customer.
  `sendHeshSMS=True` sends a link to `cell` (needs an SMS package).
- `heshDesc` is printed on the document ("Details"): keep it a readable line, never tracking data.
  The checkout once carried JSON tracking data in it: HYP cut it at 250 characters, the JSON broke,
  and it showed on receipts; it moved to the order record `[LIVE: checkout, per its code history]`.
- `Pritim=True` turns `heshDesc` into items `[code~description~quantity~price_including_vat]...`
  whose total must equal `Amount` exactly, or the transaction fails with `400`. One plain line
  (`heshDesc` without `Pritim`) avoids that failure mode (the subscription app's choice).
- `EZ.lang` (`he`/`en`), `EZ.comment`, `EZ.description`, `EZ.email_text`, `EZ.vat` (`0` for VAT-exempt),
  `EZ.cc_emails` (up to 10), `EZ.customer_crn` (business number; required by law above 5,000 ILS).
- Default document type: portal, הגדרות, "הגדרת מסמך ברירת מחדל": "קבלה / חשבונית מס" (default) or
  "קבלה". A VAT-exempt business (עוסק פטור) issues "קבלה".
- A link to download the PDF: `APISign`, `What=SIGN`, `ACTION=PrintHesh`, `type=EZCOUNT`, `TransId`
  (or `asm`); the answer appended to the base URL is the link.
- Cash or check (no card): `action=soft&TransType=Cash` (or `Check`, `Multi`) records it and issues the
  document; no money moves.
- If the project issues documents elsewhere (for example Morning or Invoice4u), HYP's module must stay
  off (and `SendHesh=False`) or every payment gets two documents: the checkout sent two documents to
  every buyer for about two months in mid 2026, until the second system was removed `[LIVE]`. The
  small-payments app keeps HYP's off and issues receipts from its own invoicing system.

## 13. Payment links (`payRequest`)

Docs: /pay/common-use-cases/send-payment-links `[DOC]`. `action=payRequest&iCommand=CREATE` with
`Masof`, `PassP`, `Amount`, `Coin`, `Info`, `UserId`, `ClientName`, `ClientLName`, `email`, `cell`
answers `payRequestId` and `paymentURL`; `iCommand=LIST` lists them, `iCommand=DELETE&PayRequest=<id>`
cancels one (`250` not found). An option when the customer pays outside the site (WhatsApp, SMS).

## 14. Test terminal and test cards

Docs: /pay/getting-started/testing-environments `[DOC]`.

- A test terminal's number always starts with `00100`. Same URL as production.
- HYP's published success card: `5253360311315452`, expiry `12/29`, CVV `493`, ID `890108558`; keep
  amounts low (about 10 ILS): many developers share it. HYP's published failure card:
  `4580458045804580`, any valid expiry, CVV `123`, any ID.
- **Test cards do not work on a production terminal**, and on a production terminal every charge is
  real money. There is no public test terminal: a test terminal (`00100...`) comes from ipos@hyp.co.il
  per merchant, with its own portal account. No live integration behind this skill used one: the
  subscription app ran every check with the owner's own card at 1 ILS, the small-payments app at 0.50
  ILS (an admin-only test price kept as a secret, `PAYMENT_TEST_AGOROT=50`, with a `PAYMENT_MODE`
  switch off/admin/on), a human pressing each money action and cancelling or refunding each test
  charge `[LIVE]`.
- Apple Pay, bit and 3DS work only on production terminals (the Apple Pay button shows on test).

## 15. Status codes that matter

Full table: /pay/reference/response-status-codes. The customer and admin wording (Hebrew and English)
is in `templates/src/lib/billing-i18n.js`; the mapping to our reason codes is `reasonFor` and
`reverseReasonFor` in `hyp.ts`.

| Code | Meaning | Our reason |
|---|---|---|
| 0 | approved | |
| 1, 2, 5 | blocked, stolen, forged card | `card_blocked` |
| 3 | call the card company | `card_call_issuer` |
| 4 | not approved | `card_declined` |
| 6 | wrong CVV (or a missing Israeli ID) | `card_cvv_or_id` |
| 26 | wrong ID | `card_cvv_or_id` |
| 9, 999 | communication error | `hyp_unreachable` |
| 15, 416, 429, 447, 997 | card or expiry not valid, bad number, bad token | `card_invalid` |
| 33 | refund larger than the charge | `refund_too_much` |
| 200 | VERIFY: parameters missing | `billing_unavailable` (or `verify_failed` in VERIFY) |
| 250 | transaction or link not found | `billing_unavailable` / `refund_not_found` |
| 300 to 322 | no acquirer permission (322 = no J5 permission) | `billing_unavailable` |
| 400 | `Pritim` items do not add up to `Amount` | `billing_unavailable` |
| 401, 402 | name / `Info` missing (soft); also "too many / too few installments" | `card_declined` / `billing_unavailable` |
| 600 | J2 details received | success code of J2 |
| 700 | J5 authorization | success code of J5 |
| 800 | postponed | success code of Postpone |
| 901 | no permission for this action (or wrong `zPass`) | `billing_unavailable` / `refund_not_permitted` |
| 902 | authentication error (wrong `PassP`) | `billing_unavailable` / `refund_not_permitted` |
| 904 | missing `What` | `billing_unavailable` |
| 905, 906 | HK: bad `NewStat`, no such agreement | |
| 910 | not a valid transaction for a token (no `allowFalse`) | `billing_unavailable` |
| 920 | cannot cancel: transmitted or not found | `cancel_not_possible` |
| 998 | transaction cancelled | `card_check_cancelled` |

`[CONTRADICTS-DOC]` The docs describe 600 as card details that were checked and found valid, without
checking the credit frame. On the subscription app's production terminal a **wrong CVV passed with
600**, and the portal's transaction details said "בדיקת CVV: לא הוכנס" and "בדיקת ת.ז: לא הוכנס"
(10/2026). J2 checks nothing; use J5 to really check a card.

The checkout's older code table followed Shva's old numbers (33, 36, 38, 39, 57, 58, 59, 111), which
mean other things in HYP's own table; it was replaced in 10/2026. Even the docs' MCP answered once
(10/2026) with the old meanings (33 = defective card, 36 = expired): read the status codes page
itself, never a summary. Never seen live by any of the integrations: 901, 920, 33, 403, a `Pritim`
400.

## 16. The code in `templates/base44/shared/hyp.ts`

| Function | Call |
|---|---|
| `signPage(cfg, input)` | SIGN: a card check (`cardCheck: true`, J5 1 ILS), a one-time payment (amount, installments, invoice), or HK recurring |
| `parseQuery(raw)` / `pick` | the raw redirect, `+` kept |
| `verifyRedirect(cfg, pairs)` | VERIFY with every parameter in order |
| `getToken(cfg, transId)` | token and `Tokef`, `allowFalse=True` |
| `chargeToken(cfg, input)` | `soft` token charge (+ invoice, + `tOwner`) |
| `cancelTrans` / `refundTrans` | `CancelTrans` / `zikoyAPI` |
| `hkStatus(cfg, hkId, 1 or 2)` | stop or resume an HK agreement |
| `invoiceLink(cfg, transId)` | a signed PDF link (`PrintHesh`) |
| `reasonFor` / `reverseReasonFor` | `CCode` to our reason codes |
