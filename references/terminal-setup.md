# Terminal setup: the portal checklist and what to ask HYP

What the business owner (or the developer) does in the HYP portal and asks from HYP support, before a
single line of code can be tested. Claude never logs in and never types a password: the user signs in
themselves (terminal number, user, password) and, when a view-only look is needed, shows Claude the
signed-in page. Screen names below are the Hebrew labels, from HYP's docs and from live portals
(10/2026).

## Contents

1. What exists before HYP (the business side)
2. In the portal: settings the user changes
3. From HYP support: permissions only HYP turns on
4. The ready message to HYP support (Hebrew)
5. Secrets: one line per secret
6. Gate: what must be true before the first test

## 1. What exists before HYP

- An acquiring agreement with at least one card company (Isracard, Cal, Max) and an **internet**
  vendor number ("מספר ספק אינטרנטי"); several companies = several vendor numbers on one or more
  terminals `[DOC]`.
- A service agreement with HYP; HYP's operations team (ipos@hyp.co.il) creates the terminal and the
  portal account and emails the terminal number and credentials `[DOC]`.
- One terminal per environment by default: a test terminal (number starts with `00100`) and a
  production terminal. Some merchants receive only the production terminal and work on it directly.
- **Timing seen** on two terminals: about 9 to 13 days from the signed agreement to the "terminal
  ready" email. Plan two weeks.
- Seen in practice: Amex and Diners are added through Max; a business can open a sub-terminal
  ("תת מסוף") for a second line of business. Fees are per merchant: ask HYP and the card companies.
- Per acquirer: a permission for recurring/token charges may be separate (on another processor, a
  project needed a separate standing-order vendor number per acquirer; with HYP this was not needed
  so far).

## 2. In the portal: settings the user changes

Portal: `https://pay.hyp.co.il/p/?action=login` (terminal number, user, password). Signed-in pages are
`.../cgi-bin/yaadpay/yaadpay3ds.pl?d=s&CSRF=<per login>&action=Settings` (or `SettingsNew`,
`EZCountSettings`); a settings link without a live session shows "Masof Error", and HYP forces a
password renewal now and then ("תוקף הסיסמה שלך פג"): the user signs in, Claude never types a password.
**The menus differ per terminal package.** One terminal (10/2026): הגדרות holds only "דף תשלום ו-API"
and "מניעת עסקאות כפולות". Another (10/2026): ראשי, חיוב ידני, לינק לתשלום, דפי מכירה, הזמנות, כפתור
תשלום, הוראות קבע, פירוט עסקאות, הרשמה למערכת החשבוניות; and under settings: רשימת לקוחות, פירוט
הפקדות, דף תשלום ו-API, מניעת עסקאות כפולות, עסקה בטוחה 3DS, Bit, Apple Pay, Google Pay, PayPal, הגדרת
Shopify, מערכת התראות. The apps grid at the top: Pay, Invoice, Match. Portal users' permissions change
only through HYP's service center.

The page "דף תשלום ו-API" as read live on one terminal (10/2026): פרטי העסק; **אימות** (the API key
and "פרמטר אימות - PassP", each with "חשיפה", and "יצירת פרמטר מאובטח"); הגדרות דף תשלום (design:
"תבנית לקוח", "תבניות ישנות", "תבניות Hyp החדשות - מומלץ!", colors and button text; "הוספת תנאי שימוש -
לינק לתקנון"; **"שדות למילוי"**: the ID field and the CVV field, each "גלוי בדף - שדה חובה" or not);
**"הפנייה לאחר עסקה"** ("עסקה שהצליחה": "עמוד הצלחה של Hyp (ברירת מחדל)" or "לינק מותאם אישית";
"עסקה שנכשלה": "הצגת השגיאה בדף התשלום (ברירת מחדל)" or a link); אבטחה (Google reCAPTCHA: always or on
unusual activity); "שמירת הגדרות".

1. **API key and PassP**: הגדרות > "API-דף תשלום ו" (Payment Page and API) > section "אימות": copy
   the API key (`KEY`) and the API password (`PassP`; not the portal password) `[DOC]`.
2. **Return address**: same screen, section "הפנייה לאחר עסקה". Under "עסקה שהצליחה" choose "לינק
   מותאם אישית" and enter the return page (`https://<domain>/billing/return`). Under "עסקה שנכשלה"
   either keep "הצגת השגיאה בדף התשלום" (HYP's recommendation: the customer sees the decline and retries
   on HYP's page) or enter **the same** return page (our own decline message in Hebrew or English).
   Never a different page: a J5 card check (700) or a postponed transaction (800) is "not a standard
   immediate charge", and with a failure address set HYP sends those successes to the failure address
   `[DOC]`. Then "שמירת הגדרות" `[LIVE: two terminals, 10/2026]`. The address is per terminal, not per
   request (a per-request `successUrl` was ignored live): several sites on one terminal share it (one
   return endpoint that routes by `Order`, or separate terminals). The link may also point straight at
   a backend function: the Base44 functions gateway passes the GET query in and the function's 302 out
   `[LIVE: small-payments app, 10/2026]`.
3. **Signature on the payment page**: the docs say to make sure "אימות על ידי חתימה בעמודי התשלום" is
   on in "אימות" (usually on by default) `[DOC]`. A live read of that page on one terminal found no
   such switch (10/2026), while pages signed with `Sign=True` came back with `Sign` and VERIFY worked.
   So: if the switch is there, it is on; either way the proof is a real redirect that carries `Sign`
   and a VERIFY that answers 0.
4. **The ID field** ("שדות למילוי"): visible and required, or not, as the interview decided and the
   acquirer allows.
5. **Wallets and 3DS** (only if chosen in the interview): הגדרות > Google Pay / Apple Pay / Bit /
   "3DS עסקה בטוחה". Bit needs a sign-up form and a few days `[DOC]`; Apple Pay inside an iframe needs
   a domain verification file and the domain registered `[DOC]`; 3DS needs the MID and MCC from the
   card company, production terminals only `[DOC]`.
6. **Invoices** (only if HYP issues them): the apps grid (top bar) > "Invoice". The text "המערכת כבר
   פעילה בחשבונכם. כל מה שנשאר הוא להשלים כמה הגדרות" with a "להשלמת ההגדרה" button = available but
   not set up `[LIVE: one terminal]`; only a "הרשמה למערכת החשבוניות" link = not registered at all
   `[LIVE: another terminal]`. Finishing it is the business owner's decision, with the accountant:
   document type ("קבלה / חשבונית מס", or "קבלה" for a VAT-exempt business), and numbering above the
   last document the business already issued, for every document type. Default document type:
   הגדרות > "הגדרת מסמך ברירת מחדל" > "סוג מסמך ברירת מחדל" > "עדכון הגדרות ברירת מחדל" `[DOC]` (on one
   portal that link existed but did nothing; use the apps grid).
7. **"מניעת עסקאות כפולות"** (duplicate prevention) exists under הגדרות. Not examined yet: look at it
   before the first token charge of a repeated amount (two 1 ILS test charges, or a retry).
8. **Manual work in the portal**: transactions are under "פירוט עסקאות" (search by transaction
   number, amount, payer ID, name, description, approval number, last 4 digits, error code, IP); an
   earlier instruction for a manual cancel there was "ביטול עסקאות אשראי" next to "יצוא לאקסל" (not
   exercised). A cancelled deal shows status 998; a refund is its own row. A cancel or refund made in
   the portal is invisible to the app: fix the Payment row by hand, or act from the app.

## 3. From HYP support: permissions only HYP turns on

Ask for exactly what the chosen shape needs (the interview decides):

What happened so far: on one production terminal tokens and J5 worked on the first try with no request
(10/2026); the CVV requirement on token charges had to be removed by HYP (about two weeks from the
request); a refund through the API worked on another terminal with nothing asked (10/2026). Ask anyway
in the first message: a permission found missing during a real-money test costs days.

| Need | Without it | Who needs it |
|---|---|---|
| Tokens (`getToken`) | `getToken` answers `901` | subscriptions, saved cards |
| J5 (authorization without a charge) | the page answers `322` (no J5 permission from the acquirer) | card check at sign-up |
| **No CVV requirement on token charges (`soft` with `Token=True`)** | every automatic charge fails with `CCode 6` | subscriptions, any token charge. Blocked one subscription project for about two weeks, until HYP changed the terminal. [LIVE] Side effect seen 11/2026 on that terminal: after the change the J5 card-check page stopped sending CVV and ID too, so a wrong CVV is saved with 700 (portal: "בדיקת CVV: לא הוכנס", "בדיקת ת.ז: לא הוכנס", "אופי עסקה: טלפונית"). If the card check must still verify CVV, get that confirmed in writing, or use two terminals with `tOwner` |
| Installments up to N | the page cannot offer them (`903` = more than the terminal allows) | one-time payments with installments |
| HK recurring module | `HK=True` pages do nothing useful | HYP-managed subscriptions only |
| Refunds through the API (`zikoyAPI`) | `901` (only if HYP requires it; the docs list no permission) | refunds inside the system |
| The ID number policy | the page asks for an ID; token charges need the saved ID | decide: required or optional (the acquirer decides) |
| A credit password `zPass` | payouts answer `901` | only payouts (credits not linked to a charge). Not for refunds |

HYP support: phone `*6488` extension 3, WhatsApp `073-2345000` (both from HYP's docs), and the
support email linked in the portal's header (put the terminal number in the subject). Terminals and
test terminals: ipos@hyp.co.il (from HYP's docs). HYP's operations confirm terminal changes by email (for example
3DS and Apple Pay switched off on a terminal). Ask for a written answer, and record the date and the
person in the project's plan.

## 4. The ready message to HYP support (Hebrew)

The user sends it themselves (sending is theirs). Remove the lines the project does not need.

```
שלום,
אני מחבר את מסוף מספר <מספר מסוף> לאתר <דומיין> דרך ה-API של HYP Pay (APISign, getToken, action=soft).
אשמח שתפעילו במסוף:
1. הרשאת טוקנים (getToken).
2. עסקאות J5 (שריון בלי חיוב), לבדיקת כרטיס בהרשמה.
3. לבטל את חובת ה-CVV בעסקאות טוקן (soft) במסוף הזה, ולהשאיר אותה בדף התשלום: החיוב החודשי רץ בלי
   שהלקוח מקליד CVV. אשמח לאישור שאחרי השינוי דף התשלום (גם בעסקת J5) עדיין שולח את ה-CVV ואת תעודת
   הזהות לבדיקה של חברת האשראי. אם אי אפשר: מסוף נוסף לחיובים בלי CVV, באותו מספר עוסק, כדי לחייב עם tOwner.
4. תשלומים עד <מספר> בדף התשלום.
5. זיכוי דרך ה-API (zikoyAPI) על עסקאות שכבר שודרו.
ועוד שאלה: האם תעודת זהות היא שדה חובה במסוף הזה, ואפשר להפוך אותה לרשות?
תודה,
<שם>
```

## 5. Secrets: one line per secret

The user sets them, one copy-ready line each, and replaces only the text between the quotes. Never
ask the user to paste a secret into the chat: the value must not pass through the conversation. Fill
in the app id; keep the names exactly (the templates read `HYP_MASOF`, `HYP_PASSP`, `HYP_KEY`):

```bash
npx base44 secrets set HYP_MASOF='<מספר המסוף>' --app-id <your-app-id>
```

```bash
npx base44 secrets set HYP_PASSP='<הסיסמה מ"אימות">' --app-id <your-app-id>
```

```bash
npx base44 secrets set HYP_KEY='<מפתח ה-API מ"אימות">' --app-id <your-app-id>
```

At most one short line noting that the values land in the shell history (clear those lines on a
shared machine). On another stack, use its own secret store; the names stay the same. The names
drifted between apps before (one app called the key `HYP_API_KEY`): keep `HYP_KEY` in new projects.

A subscription adds two more (references/subscriptions.md section 8). They are not secret values, but
they decide whether real cards are charged: leave `BILLING_MODE` unset during the build (off), and
change it only on the business owner's explicit go for that mode (`test` for the live checks, `off`
after them, `live` at launch):

```bash
npx base44 secrets set BILLING_TEST_CUSTOMERS='<מזהי לקוחות הבדיקה, מופרדים בפסיק>' --app-id <your-app-id>
```

```bash
npx base44 secrets set BILLING_MODE='test' --app-id <your-app-id>
```

After setting them: a **new** secret name reached Base44's draft copy at once but the published copy
(what the live app runs) only after a Publish, in one measurement; another time it arrived within a
minute. A changed value of an existing name reached both copies within seconds `[LIVE: two apps,
10/2026; a third app's live site saw its three new HYP secrets without a Publish]`. So never predict:
probe the published copy (a call with the header `Base44-Functions-Version: prod`, or the live
screen's `card_enabled`) and Publish if it still answers "not set".

## 6. Gate: what must be true before the first test

- [ ] Terminal number, `KEY`, `PassP` in the secrets (and which terminal: test `00100...` or
      production).
- [ ] The success address on the terminal points to the deployed return page; the failure address is
      HYP's default or the same page.
- [ ] "אימות על ידי חתימה בעמודי התשלום" is on (or a real redirect carries `Sign` and VERIFY answers 0).
- [ ] For the chosen shape: tokens, J5, no CVV on token charges, installments, refunds: confirmed by
      HYP in writing.
- [ ] Invoices: decided (HYP's module set up with the accountant, another system, or none) and the
      other system's automatic documents off if there are two.
- [ ] The user knows which actions move real money and that only a human presses them.
