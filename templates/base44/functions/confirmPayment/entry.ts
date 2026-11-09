import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { fail, readBody, serverError } from './_shared/common.ts';
import { HypError, hypConfig, parseQuery, pick, reasonFor, verifyRedirect } from './_shared/hyp.ts';
import { paymentSummary } from './_shared/billing.ts';
import { fulfill } from './_shared/products.ts';

const MAX_QUERY = 4000;
// createPayment's order ids ('p' + 31 hex). Checked before any query: an empty value in a filter
// matches every row.
const ORDER_RE = /^p[0-9a-f]{31}$/;
const toAgorot = (ils: unknown) => Math.round((Number(ils) || 0) * 100);

// The return page sends HYP's redirect here exactly as it reached the browser (`rawQuery`, so the
// '+' in HYP's Sign survives). Open to anonymous buyers. Nothing from the browser is trusted:
// 1. the Order must be an open payment page we created (createPayment),
// 2. HYP confirms the parameters are authentic (APISign VERIFY),
// 3. the verified Amount must be the amount we priced,
// 4. the row is claimed with updateMany (compare-and-set), so two tabs or a reload close it once,
// 5. fulfillment (products.ts) runs once, and runs again on a reload if it failed halfway.
// Answers { payment, first } (first = this call closed the payment: fire analytics only then).
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await readBody(req);
    const raw = typeof body.rawQuery === 'string' ? body.rawQuery.replace(/^\?/, '') : '';
    if (!raw || raw.length > MAX_QUERY) return fail([{ code: 'missing_return', message: 'חסרים פרטים מחברת הסליקה' }]);
    const redirect = parseQuery(raw);
    const order = pick(redirect, 'Order');
    const transId = pick(redirect, 'Id');
    const ccode = pick(redirect, 'CCode');
    if (!order || !ccode) return fail([{ code: 'missing_return', message: 'חסרים פרטים מחברת הסליקה' }]);
    if (!ORDER_RE.test(order) || (transId && !/^\d{1,20}$/.test(transId))) {
      return fail([{ code: 'payment_not_found', message: 'התשלום לא נמצא' }]);
    }

    const Payment = base44.asServiceRole.entities.Payment;
    const [payment] = (await Payment.filter({ order_id: order }, 'created_date', 1)) ?? [];
    if (!payment || payment.kind !== 'one_time') return fail([{ code: 'payment_not_found', message: 'התשלום לא נמצא' }]);

    // A reload after success: answer again (and finish a fulfillment that failed), without HYP.
    if (payment.hyp_trans_id && payment.hyp_trans_id === transId && payment.status !== 'awaiting_payment') {
      await runFulfillment(base44, payment);
      return Response.json({ payment: paymentSummary(await Payment.get(payment.id)), first: false });
    }
    if (payment.status !== 'awaiting_payment') {
      return fail([{ code: 'already_paid', message: 'התשלום הזה כבר נסגר' }]);
    }
    // A declined card comes back with its code (only when the terminal sends failures to our page):
    // nothing is paid, and the row stays open so the buyer can try again on the same page.
    if (ccode !== '0') {
      await Payment.updateMany({ id: payment.id, status: 'awaiting_payment' }, { $set: { last_ccode: ccode } });
      console.log('confirmPayment: declined', payment.id, `CCode=${ccode}`);
      return fail([{ code: reasonFor(ccode), message: 'התשלום לא אושר' }]);
    }
    if (!transId) return fail([{ code: 'missing_return', message: 'חסרים פרטים מחברת הסליקה' }]);

    const cfg = hypConfig();
    if (!cfg) {
      console.error('confirmPayment: HYP secrets are not set');
      return fail([{ code: 'billing_unavailable', message: 'התשלום לא זמין כרגע' }]);
    }
    let verified = '';
    try {
      verified = await verifyRedirect(cfg, redirect);
    } catch (error) {
      if (error instanceof HypError) return fail([{ code: error.reason, message: 'לא ניתן לאמת את התשלום כרגע' }]);
      throw error;
    }
    if (verified !== '0') {
      console.error('confirmPayment: VERIFY rejected the redirect', payment.id, `CCode=${verified || 'none'}`);
      return fail([{ code: 'verify_failed', message: 'לא ניתן לאמת את התשובה מחברת הסליקה' }]);
    }

    // Money moved. A different amount than we priced means a page we did not sign this way: keep the
    // money visible for a refund, but do not fulfill.
    const paid = toAgorot(pick(redirect, 'Amount'));
    const mismatch = paid !== toAgorot(payment.amount);
    const claimId = crypto.randomUUID();
    const res = await Payment.updateMany(
      { id: payment.id, status: 'awaiting_payment' },
      {
        $set: {
          status: 'succeeded',
          claim_id: claimId,
          charged_at: new Date().toISOString(),
          hyp_trans_id: transId,
          ccode: '0',
          acode: pick(redirect, 'ACode'),
          invoice: pick(redirect, 'Hesh'),
          paid_amount: paid / 100,
          installments: Number(pick(redirect, 'Payments')) || 1,
          card_last4: pick(redirect, 'L4digit').slice(-4),
          error_code: mismatch ? 'amount_mismatch' : '',
        },
      },
    );
    const saved = await Payment.get(payment.id);
    if (res?.updated !== 1) {
      // Another tab closed it first with the same transaction: the same answer. Anything else is a
      // second HYP transaction on one order: look it up in the HYP portal.
      if (saved?.hyp_trans_id === transId) return Response.json({ payment: paymentSummary(saved), first: false });
      console.error('confirmPayment: a second verified transaction for one order', payment.id, `Id=${transId}`, `first Id=${saved?.hyp_trans_id}`);
      return fail([{ code: 'already_paid', message: 'התשלום הזה כבר נסגר' }]);
    }
    console.log('confirmPayment: paid', payment.id, `Id=${transId}`, `amount=${paid / 100}`);
    if (mismatch) {
      console.error('confirmPayment: paid amount differs from the price', payment.id, `paid=${paid / 100}`, `price=${payment.amount}`);
      return fail([{ code: 'amount_mismatch', message: 'הסכום ששולם לא תואם להזמנה. ניצור קשר.' }]);
    }
    await runFulfillment(base44, saved);
    return Response.json({ payment: paymentSummary(await Payment.get(payment.id)), first: true });
  } catch (error) {
    return serverError(error);
  }
});

// Claims the fulfillment ({fulfilled_at: null} matches a field the row never had), runs it, and
// gives the claim back if it throws, so the next reload tries again. Never for an amount mismatch.
// deno-lint-ignore no-explicit-any
async function runFulfillment(base44: any, payment: any): Promise<void> {
  if (payment.status !== 'succeeded' || payment.error_code === 'amount_mismatch') return;
  const Payment = base44.asServiceRole.entities.Payment;
  const at = new Date().toISOString();
  const claim = await Payment.updateMany({ id: payment.id, status: 'succeeded', fulfilled_at: null }, { $set: { fulfilled_at: at } });
  if (claim?.updated !== 1) return;
  try {
    await fulfill(base44, payment);
  } catch (error) {
    console.error('confirmPayment: fulfillment failed, the next reload retries it', payment.id, (error as Error).message);
    await Payment.updateMany({ id: payment.id, fulfilled_at: at }, { $set: { fulfilled_at: null } });
  }
}
