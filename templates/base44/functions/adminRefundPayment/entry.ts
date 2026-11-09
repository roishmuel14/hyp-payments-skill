import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { currentUser, fail, forbidden, readBody, serverError, unauthorized } from './_shared/common.ts';
import { cancelTrans, hypConfig, refundTrans } from './_shared/hyp.ts';
import { findBillingAccount, leftAgorot, lockAccount, reversePayment, unlockAccount } from './_shared/billing.ts';

const NOTE_MAX = 200;

// Admin only. Money back on one payment of a customer, from the admin's payments list:
//   { customer_id, payment_id, action: 'cancel', expected_refunded, note? }
//       HYP CancelTrans of the whole charge. Works until HYP transmits it (the same day, until about 22:00).
//   { customer_id, payment_id, action: 'refund', amount, expected_refunded, note? }
//       HYP zikoyAPI of all or part of what is left. Works after the charge was transmitted.
// -> { payment }, or 422 with the reason (cancel_not_possible: already transmitted, refund instead).
// `expected_refunded` is the refunded amount the admin's screen showed: when the row changed since
// (a double click, a retried request, a second admin), nothing is sent. The customer's money actions
// run one at a time (the account lock), and the row is claimed with updateMany before HYP is called
// (billing.ts, reversePayment), so money never goes back twice.
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await currentUser(base44);
    if (!user) return unauthorized();
    if (user.role !== 'admin') return forbidden();

    const body = await readBody(req);
    const customerId = typeof body.customer_id === 'string' ? body.customer_id.trim() : '';
    const paymentId = typeof body.payment_id === 'string' ? body.payment_id.trim() : '';
    const action = body.action;
    const expected = Number(body.expected_refunded);
    if (!customerId || !paymentId || !['cancel', 'refund'].includes(action as string) || !Number.isFinite(expected) || expected < 0) {
      return fail([{ code: 'invalid_body', message: 'בקשה לא תקינה' }]);
    }
    const note = typeof body.note === 'string' ? body.note.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX) : '';

    const cfg = hypConfig();
    if (!cfg) return fail([{ code: 'billing_unavailable', message: 'הסליקה עוד לא מחוברת' }]);
    const first = await getPayment(base44, paymentId);
    if (!first || first.customer_id !== customerId) return fail([{ code: 'payment_not_found', message: 'התשלום לא נמצא' }]);

    // A customer with a saved card has a BillingAccount; its lock keeps a charge and a refund of the
    // same customer from running at once. A one-time buyer without an account has only the row claim.
    const account = await findBillingAccount(base44, customerId);
    let lockId: string | null = null;
    if (account) {
      lockId = await lockAccount(base44, account);
      if (!lockId) return fail([{ code: 'charge_in_progress', message: 'פעולה אחרת על התשלומים של הלקוח הזה רצה עכשיו' }]);
    }
    try {
      // Decide on the row as it is now, under the lock.
      const payment = await getPayment(base44, paymentId);
      if (!payment) return fail([{ code: 'payment_not_found', message: 'התשלום לא נמצא' }]);
      if (Math.round(expected * 100) !== Math.round((Number(payment.refunded_amount) || 0) * 100)) {
        return fail([{ code: 'payment_changed', message: 'התשלום השתנה מאז שהמסך נטען' }]);
      }
      if (payment.status === 'cancelling' || payment.status === 'refunding') {
        return fail([{ code: 'refund_unknown', message: 'ניסיון קודם לא קיבל תשובה מ-HYP: לבדוק בפורטל' }]);
      }
      const left = leftAgorot(payment);
      if (!left) return fail([{ code: 'not_refundable', message: 'אי אפשר לבטל או לזכות את התשלום הזה' }]);

      let agorot = left;
      if (action === 'cancel') {
        // Only a charge nothing was given back on: CancelTrans always undoes the whole charge.
        if (payment.status !== 'succeeded' || (Number(payment.refunded_amount) || 0) > 0) {
          return fail([{ code: 'not_refundable', message: 'אפשר לבטל רק עסקה שלא זוכתה' }]);
        }
      } else {
        const amount = Number(body.amount);
        agorot = Math.round(amount * 100);
        if (!Number.isFinite(amount) || agorot < 1 || Math.abs(agorot - amount * 100) > 1e-6) {
          return fail([{ code: 'bad_refund_amount', message: 'סכום הזיכוי לא תקין' }]);
        }
        if (agorot > left) return fail([{ code: 'refund_too_much', message: `אפשר לזכות עד ${left / 100} ש"ח` }]);
      }

      const transId = String(payment.hyp_trans_id);
      const outcome = await reversePayment(
        base44,
        payment,
        { kind: action as 'cancel' | 'refund', agorot, note, by: user.id },
        () => (action === 'cancel' ? cancelTrans(cfg, transId) : refundTrans(cfg, transId, agorot / 100)),
      );
      if (!outcome.ok) return fail([{ code: outcome.reason, message: action === 'cancel' ? 'הביטול לא עבר' : 'הזיכוי לא עבר' }]);
      return Response.json({ payment: outcome.payment });
    } finally {
      if (account && lockId) await unlockAccount(base44, account.id, lockId);
    }
  } catch (error) {
    return serverError(error);
  }
});

// deno-lint-ignore no-explicit-any
async function getPayment(base44: any, id: string): Promise<any | null> {
  try {
    return await base44.asServiceRole.entities.Payment.get(id);
  } catch (_) {
    return null;
  }
}
