# The discovery interview

Ask the user once, at the start, in one short round (AskUserQuestion takes up to 4 questions per call:
two calls at most). Every question offers a default, so "ברירת מחדל" (default) is a full answer. Ask
only what the project's spec, plan or code does not already answer, and write every answer into the
project's plan or decisions file before building. The questions are in Hebrew, ready to ask; the notes
after each say what the answer changes in the build.

## Round 1: the shape (blocks everything)

**1. מה המערכת גובה?**
- תשלום חד פעמי (קורס, כרטיס לאירוע, מוצר) **(ברירת מחדל כשאין מנוי)**
- מנוי חודשי
- שניהם
- Changes: one-time = `createPayment`, `confirmPayment`, `products.ts`. Subscription = card check,
  token, `subscription.ts`, `runBilling`. Both = both, on one terminal, one return page (`k`/`p`
  orders).

**2. (מנוי) מי מנהל את החיוב החודשי?**
- **אנחנו, עם טוקן** (ברירת מחדל): המערכת שומרת קוד במקום הכרטיס ומחייבת כל חודש בעצמה.
- HYP (הוראת קבע של HYP): HYP מחייבים בעצמם כל חודש, סכום קבוע.
- Why tokens by default: HYP's recurring (`HK=True`) has no future start date (the first charge is
  the page itself, so a free trial of any length is impossible), no variable amount, no admin trial
  extension, and no documented notification to us for each charge, so our records and our emails
  cannot follow it. HK fits a fixed subscription that starts paying today, with nothing to sync: then
  it is less code (no token, no daily run), and stopping is `HKStatus`.
- A live subscription project (11/2026) stayed with the token charge and did not ask HYP about a
  standing order. `HK=True` would break the trial the admin sets and extends, a price change, and our
  feedback on each charge; HYP's other standing-order product (Hyp Enterprise, formerly CreditGuard) is
  a different interface opened through HYP's sales, so a new integration, not a switch. Reopen it only
  if HYP or a card company demands it.

**3. (מנוי) ניסיון חינם, ומתי לוקחים כרטיס?**
- **כרטיס חובה כבר בהרשמה, נבדק ב-J5, חיוב ראשון בסוף הניסיון** (ברירת מחדל)
- כרטיס רק בסוף הניסיון (תזכורות 7 ימים ויום לפני, ובלי כרטיס: פג)
- בלי ניסיון: חיוב ראשון מיד
- How many days, and when does the trial start (at sign-up, or when an admin approves the account)?
  Trial extension by an admin: yes by default (it moves the first charge).
- The card check is J5: a 1 ILS authorization the card company really checks (CVV, credit, ID where
  the issuer supports it) and releases by itself after about 5 days. Never J2 (it checks nothing).
- With a free trial, ask also: **לממש את כללי Visa לניסיון חינם?** Default: **no** (a live
  subscription project decided not to build them in 11/2026; it had the cancel on the site and the
  7-day reminder only for a customer with no card). Visa's rules for free trials and introductory
  offers `[DOC: Visa, announced 06/2019, in force since 18/04/2020, worldwide]`: express consent at
  enrollment; a confirmation (email) after it with the terms and a way to cancel; a reminder at least
  7 days before the first charge (and before a price change), with a link to cancel online; a receipt
  with the trial's details; the first charge identified as coming from a trial; and simple online
  cancellation. Estimated at half a day of work. Say yes when the acquirer or HYP asks, or the volume
  makes chargebacks a real risk. Read the current rules before building: [Visa's flier](https://usa.visa.com/content/dam/VCOM/global/support-legal/documents/visa-new-subscription-rules-flier.pdf)
  and the Visa Core Rules (summaries disagree on whether the 7 days count to the first charge or to
  the trial's end). Not legal advice.

**4. ביטול וזיכוי: מתוך המערכת או ידנית בפורטל של HYP?**
- **מתוך המערכת, רק אדמין** (ברירת מחדל): ביטול באותו יום עד 22:00 (בלי עמלה), זיכוי מלא או חלקי
  אחרי זה.
- ידנית בפורטל: המערכת רק מציגה תשלומים.
- Changes: `adminRefundPayment`, `RefundDialog`, the Payment refund fields. Nothing ever gives money
  back by itself. A subscription refund does not end the period by itself: the admin decides.

## Round 2: the details (each has a default; ask together)

**5. תשלומים (רק בתשלום חד פעמי):** עד כמה? (ברירת מחדל: 1, תשלום אחד). More than 1 needs the
terminal's approval for installments; the buyer picks 1 to N on HYP's page (`Tash`, `FixTash=False`).
One payment is sent as `Tash=1&FixTash=True`: a page with no `Tash` offered up to 36 installments (the
terminal's default, seen live). HYP refuses installments under a minimum per payment (403; one live
checkout offers a single payment under 100 ILS). bit charges in full regardless.

**6. חשבוניות:** מי מוציא אותן?
- **HYP Invoice** (ברירת מחדל אם המודול זמין): נשלחת במייל אוטומטית בכל תשלום. Needs the module set up
  in the portal with the accountant: document type and numbering that continues the business's
  documents. A VAT-exempt business issues "קבלה".
- מערכת אחרת (למשל Morning או Invoice4u): then HYP's module stays off, or every payment gets two
  documents.
- בלי חשבוניות מהמערכת.

**7. תעודת זהות:** איך? (ברירת מחדל: HYP מבקשים אותה בדף.)
- HYP's page asks for it: the portal's "שדות למילוי" makes the field visible and required; the
  redirect returns it as `UserId`; for subscriptions it is stored server-only and sent with every
  token charge (the subscription app).
- Our own form collects it (check digit in the browser and on the server) and sends it as `UserId`,
  so HYP's page arrives filled; never stored or logged; cards without an Israeli ID cannot pay
  (the small-payments app, 11/2026).
- Not required (if the acquirer allows): `UserId=000000000`.
The card company compares the ID with the card (`26` = wrong ID).

**8. מסוף בדיקות או ישר לייצור?**
- **מסוף בדיקות קודם** (ברירת מחדל): number starts with `00100`, HYP's test cards work.
- ישר למסוף הייצור: every test is real money with the owner's own card, a human presses each money
  action, each test charge is cancelled the same day. Test cards do not work there.

**9. המחיר כולל מע"מ?** The charged amount is the source of truth: whatever the price page says, the
`Amount` sent to HYP is what the card pays, so the setting holds the final amount including VAT. Make
the price page and the terms match it (one project's terms said "בתוספת מע"מ" while the setting was
the charged amount: an open client decision). Whether VAT applies at all is the client's business
status, not ours to guess.

**10. אמצעי תשלום נוספים:** Bit, Apple Pay, Google Pay, 3DS? (ברירת מחדל: רק כרטיס אשראי.) Each is a
portal setting and production-only; bit: up to 5,000 ILS, ILS only, no installments, no J5, no
recurring; wallets give single-use card numbers, so they cannot feed a subscription. On an iPhone,
Google Pay on HYP's page asks for the Google account password and buyers gave up (a live site,
10/2026): one checkout shows iPhone buyers a hint to pay by card or Apple Pay. 3DS shifts chargeback
liability (needs the MID and MCC from the card company). No integration behind this skill ran bit or
3DS live yet.

**11. מסוף אחד לכמה מוצרים או אתרים?** One terminal = one return address (a per-request return URL
was ignored live: a payment of one site came back to another site's page on the same terminal,
10/2026), one portal, one set of reports. Several sites on one terminal share one return endpoint that
routes by `Order` and never trusts an `Order` it did not create; otherwise one terminal per site. A
second line of business can get a sub-terminal ("תת מסוף"). Separate businesses (different business
IDs) = separate terminals.

**12. מי מורשה ללחוץ על פעולות כסף?** (ברירת מחדל: רק אדמין, ובזמן הבדיקות רק האדם האחראי.) Test
charges, cancels and refunds are admin-only in the functions. During the build, real money moves only
when a human presses: Claude reads the results, read-only.

## After the interview

1. Write the answers into the project's plan. A new HYP account takes time: plan about two weeks
   until the terminal works.
2. Build the request list for HYP (references/terminal-setup.md section 4) from answers 2 to 7.
3. Mark what is missing (terminal number, keys, permissions) as "אין" in the project's open questions
   and keep the payment button hidden until the gate in terminal-setup.md section 6 passes:
   `card_enabled` stays false while the secrets are missing, so the live site shows nothing broken.
