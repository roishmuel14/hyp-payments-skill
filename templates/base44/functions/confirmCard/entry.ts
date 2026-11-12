import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { currentUser, fail, israelToday, readBody, serverError, unauthorized } from './_shared/common.ts';
import { findOwnCustomer } from './_shared/customer.ts';
import { CARD_CHECK_OK, HypError, getToken, hypConfig, parseQuery, pick, reasonFor, verifyRedirect } from './_shared/hyp.ts';
import { brandName, cardSummary, findBillingAccount, getBillingSettings } from './_shared/billing.ts';
import { billAccount, billingMode, mayBill, retryWithNewCard } from './_shared/subscription.ts';

const MAX_QUERY = 4000;
// createCardSession's session ids ('k' + 31 hex). Checked before any query: an empty value in a
// filter matches every row.
const SESSION_RE = /^k[0-9a-f]{31}$/;

// The /billing/return page sends HYP's redirect here, exactly as it reached the browser
// (`rawQuery`, so the '+' in HYP's Sign survives). Nothing from the browser is trusted:
// 1. the Order must be the caller's own open card session (no other customer's, not an old one),
// 2. HYP confirms the parameters are authentic (APISign VERIFY),
// 3. the token is fetched from HYP server to server (getToken) and stored on the BillingAccount.
// 4. a past_due or expired subscription is charged at once with the new card (subscription.ts).
// Answers only a safe summary: { card: { last4, brand, exp, expired }, charge? }.
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await currentUser(base44);
    if (!user) return unauthorized();

    const body = await readBody(req);
    const raw = typeof body.rawQuery === 'string' ? body.rawQuery.replace(/^\?/, '') : '';
    if (!raw || raw.length > MAX_QUERY) return fail([{ code: 'missing_return', message: 'חסרים פרטים מחברת הסליקה' }]);
    const redirect = parseQuery(raw);
    const order = pick(redirect, 'Order');
    const transId = pick(redirect, 'Id');
    const ccode = pick(redirect, 'CCode');
    if (!order || !transId || !ccode) return fail([{ code: 'missing_return', message: 'חסרים פרטים מחברת הסליקה' }]);
    if (!SESSION_RE.test(order) || !/^\d{1,20}$/.test(transId)) {
      return fail([{ code: 'session_mismatch', message: 'בדיקת הכרטיס לא נמצאה' }]);
    }

    const customer = await findOwnCustomer(base44, user);
    if (!customer) return fail([{ code: 'no_customer', message: 'לא נמצא חשבון לחיוב' }]);
    const account = await findBillingAccount(base44, customer.id);
    if (!account) return fail([{ code: 'session_mismatch', message: 'בדיקת הכרטיס לא נמצאה' }]);

    const today = israelToday();
    // A reload of the return page after success: answer again, without calling HYP.
    if (account.confirmed_session_id === order && account.card_trans_id === transId && account.token) {
      return Response.json({ card: cardSummary(account, today), already: true });
    }
    if (!account.session_id || account.session_id !== order) {
      return fail([{ code: 'session_mismatch', message: 'בדיקת הכרטיס לא נמצאה' }]);
    }
    if (!account.session_expires_at || Date.parse(account.session_expires_at) < Date.now()) {
      return fail([{ code: 'session_expired', message: 'פג הזמן לבדיקת הכרטיס' }]);
    }
    // A declined card comes back with its code; there is nothing to save.
    if (!CARD_CHECK_OK.includes(ccode)) {
      console.log('confirmCard: card check declined', customer.id, `CCode=${ccode}`);
      return fail([{ code: reasonFor(ccode), message: 'הכרטיס לא אושר' }]);
    }

    const cfg = hypConfig();
    if (!cfg) {
      console.error('confirmCard: HYP secrets are not set');
      return fail([{ code: 'billing_unavailable', message: 'שמירת כרטיס לא זמינה כרגע' }]);
    }

    let token: string;
    let tokef: string;
    try {
      const verified = await verifyRedirect(cfg, redirect);
      if (verified !== '0') {
        console.error('confirmCard: VERIFY rejected the redirect', customer.id, `CCode=${verified || 'none'}`);
        return fail([{ code: 'verify_failed', message: 'לא ניתן לאמת את התשובה מחברת הסליקה' }]);
      }
      ({ token, tokef } = await getToken(cfg, transId));
    } catch (error) {
      if (error instanceof HypError) {
        console.error('confirmCard:', error.message);
        return fail([{ code: error.reason, message: 'הכרטיס לא נשמר' }]);
      }
      throw error;
    }

    // The ID number comes back only when the terminal asks for it; keep it only then.
    const idNumber = pick(redirect, 'UserId');
    const brand = brandName(pick(redirect, 'Brand'));
    // Compare-and-set on the session: two tabs confirming the same redirect save it once.
    const BillingAccount = base44.asServiceRole.entities.BillingAccount;
    const res = await BillingAccount.updateMany(
      { id: account.id, session_id: order },
      {
        $set: {
          token,
          tokef,
          card_last4: token.slice(-4),
          card_brand: brand,
          card_id_number: /^\d{9}$/.test(idNumber) && idNumber !== '000000000' ? idNumber : '',
          card_trans_id: transId,
          card_saved_at: new Date().toISOString(),
          session_id: null,
          session_expires_at: null,
          confirmed_session_id: order,
        },
      },
    );
    const saved = await BillingAccount.get(account.id);
    if (res?.updated !== 1 && saved?.confirmed_session_id !== order) {
      return fail([{ code: 'session_mismatch', message: 'בדיקת הכרטיס לא נמצאה' }]);
    }
    // 700 is the expected answer (a J5 authorization the card company checked). 600 means the card
    // was not checked at all; 0 means HYP charged the 1 ILS, which has to be cancelled in the portal.
    console.log('confirmCard: card saved', customer.id, `CCode=${ccode}`, `Id=${transId}`);
    if (ccode === '0') console.warn('confirmCard: the card check came back as an approved charge: cancel it in the HYP portal', customer.id, `Id=${transId}`);
    if (ccode === '600') console.warn('confirmCard: the card was saved without a card company check (J2 answer to a J5 request)', customer.id, `Id=${transId}`);

    // A customer who was behind on payments is charged now with the new card, not at the next run,
    // when the billing mode covers them (BILLING_MODE; off: the card is only saved).
    let charge = '';
    const mode = billingMode();
    if (mayBill(mode, customer.id) && await retryWithNewCard(base44, saved, today)) {
      try {
        charge = await billAccount(base44, saved.id, today, await getBillingSettings(base44), cfg, mode);
      } catch (error) {
        console.error('confirmCard: the charge with the new card failed to run', customer.id, (error as Error).message);
        charge = 'unknown';
      }
    }
    return Response.json({ card: cardSummary(await BillingAccount.get(account.id), today), ...(charge ? { charge } : {}) });
  } catch (error) {
    return serverError(error);
  }
});
