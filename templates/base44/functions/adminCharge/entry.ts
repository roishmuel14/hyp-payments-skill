import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { type Reason, currentUser, fail, forbidden, israelToday, readBody, serverError, unauthorized } from './_shared/common.ts';
import { getCustomer } from './_shared/customer.ts';
import { chargeToken, hypConfig, tokefExpired } from './_shared/hyp.ts';
import {
  adminPaymentSummary,
  cardSummary,
  chargePayment,
  findBillingAccount,
  listPayments,
  lockAccount,
  unlockAccount,
} from './_shared/billing.ts';

const MAX_AMOUNT = 5000;

// The line in HYP's transaction list and on the invoice. Put the app's name first.
const TEST_INFO = 'חיוב בדיקה';

// Admin only. One charge of a customer's saved card, end to end, for testing the terminal:
//   { customer_id, action: 'summary' }          -> { card, payments, card_enabled } (no charge)
//   { customer_id, action: 'charge', amount }   -> { payment } or 422 with the decline reason
// Only one money action of a customer runs at a time (the account lock), and the Payment row is written
// BEFORE HYP is called and claimed with updateMany, so a double click or a retried request never
// charges twice. HYP issues and emails the invoice (SendHesh). The summary also says, per payment,
// whether it can be cancelled or refunded now (adminRefundPayment does both).
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await currentUser(base44);
    if (!user) return unauthorized();
    if (user.role !== 'admin') return forbidden();

    const body = await readBody(req);
    const customerId = typeof body.customer_id === 'string' ? body.customer_id.trim() : '';
    const action = body.action;
    if (!customerId || !['summary', 'charge'].includes(action as string)) {
      return fail([{ code: 'invalid_body', message: 'בקשה לא תקינה' }]);
    }

    const customer = await getCustomer(base44, customerId);
    if (!customer) return fail([{ code: 'not_found', message: 'הלקוח לא נמצא' }]);

    const cfg = hypConfig();
    const account = await findBillingAccount(base44, customer.id);
    const today = israelToday();

    if (action === 'summary') {
      return Response.json({
        card_enabled: cfg !== null,
        card: cardSummary(account, today),
        payments: await listPayments(base44, customer.id, 10, (p) => adminPaymentSummary(p, today)),
      });
    }

    const amount = Number(body.amount);
    const reasons: Reason[] = [];
    const agorot = Math.round(amount * 100);
    if (!Number.isFinite(amount) || amount < 1 || amount > MAX_AMOUNT || Math.abs(agorot - amount * 100) > 1e-6) {
      reasons.push({ code: 'bad_amount', message: `הסכום צריך להיות בין 1 ל-${MAX_AMOUNT} ש"ח` });
    }
    if (!cfg) reasons.push({ code: 'billing_unavailable', message: 'הסליקה עוד לא מחוברת' });
    if (!account?.token || !account?.tokef) reasons.push({ code: 'no_card', message: 'ללקוח אין כרטיס שמור' });
    else if (tokefExpired(account.tokef, today)) reasons.push({ code: 'card_expired', message: 'תוקף הכרטיס עבר' });
    if (reasons.length) return fail(reasons);

    const lockId = await lockAccount(base44, account);
    if (!lockId) return fail([{ code: 'charge_in_progress', message: 'פעולה אחרת על התשלומים של הלקוח הזה רצה עכשיו' }]);
    try {
      const payment = await base44.asServiceRole.entities.Payment.create({
        customer_id: customer.id,
        owner_user_id: customer.owner_user_id || '',
        kind: 'test',
        description: TEST_INFO,
        amount: agorot / 100,
        status: 'pending',
        created_by: user.id,
      });

      const outcome = await chargePayment(base44, payment, () => chargeToken(cfg!, {
        token: account.token,
        tokef: account.tokef,
        idNumber: account.card_id_number || '',
        amount: agorot / 100,
        firstName: customer.first_name,
        lastName: customer.last_name,
        email: customer.email,
        info: TEST_INFO,
        invoiceDescription: TEST_INFO,
      }));
      if (!outcome.ok) return fail([{ code: outcome.reason, message: 'החיוב לא עבר' }]);
      return Response.json({ payment: outcome.payment });
    } finally {
      await unlockAccount(base44, account.id, lockId);
    }
  } catch (error) {
    return serverError(error);
  }
});
