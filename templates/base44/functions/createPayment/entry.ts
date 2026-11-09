import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { type Reason, currentUser, fail, readBody, serverError } from './_shared/common.ts';
import { findOwnCustomer } from './_shared/customer.ts';
import { HypError, hypConfig, signPage } from './_shared/hyp.ts';
import { quote } from './_shared/products.ts';

// How long a payment page stays good, and how many open pages one email may hold at once (every
// page costs a HYP call and a row, and this route is open to anonymous buyers).
const PAGE_MINUTES = 60;
const MAX_OPEN_PAGES = 5;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (v: unknown, max = 60) => (typeof v === 'string' ? v.replace(/[\r\n\t]/g, ' ').trim().slice(0, max) : '');

// A one-time payment page, for a signed-in customer or an anonymous buyer:
//   { first_name, last_name, email, phone?, product?, coupon?, lang } -> { url, order_id }
// The price comes from products.ts (quote), never from the body. The Payment row is written BEFORE
// the page is signed, with a one-time order id that HYP returns as Order; confirmPayment accepts the
// redirect only for that row, and only once.
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await readBody(req);
    const lang = body.lang === 'en' ? 'en' : 'he';
    const firstName = clean(body.first_name);
    const lastName = clean(body.last_name);
    const email = clean(body.email, 120).toLowerCase();
    const phone = clean(body.phone, 20).replace(/[^\d+]/g, '');

    const reasons: Reason[] = [];
    if (!firstName) reasons.push({ code: 'required', field: 'first_name', message: 'חסר שם פרטי' });
    if (!lastName) reasons.push({ code: 'required', field: 'last_name', message: 'חסר שם משפחה' });
    if (!EMAIL_RE.test(email)) reasons.push({ code: 'invalid', field: 'email', message: 'כתובת המייל לא תקינה' });
    if (phone && phone.replace(/\D/g, '').length < 9) reasons.push({ code: 'invalid', field: 'phone', message: 'מספר הטלפון לא תקין' });
    const offer = await quote(base44, body);
    if (Array.isArray(offer)) reasons.push(...offer);
    if (reasons.length || Array.isArray(offer)) return fail(reasons);

    const cfg = hypConfig();
    if (!cfg) {
      console.error('createPayment: HYP secrets are not set');
      return fail([{ code: 'billing_unavailable', message: 'התשלום לא זמין כרגע' }]);
    }

    // A signed-in buyer's payments are theirs (Payment RLS reads owner_user_id). An anonymous buyer
    // is grouped by email for the admin, and the row's owner is the literal 'guest', never empty: an
    // empty owner could match an anonymous reader's empty user id in the read rule.
    const user = await currentUser(base44);
    const customer = user ? await findOwnCustomer(base44, user) : null;
    const customerId = customer?.id || `guest:${email}`;

    const Payment = base44.asServiceRole.entities.Payment;
    const open = (await Payment.filter({ buyer_email: email, status: 'awaiting_payment' }, '-created_date', 50)) ?? [];
    const live = open.filter((p: { page_expires_at?: string }) => Date.parse(p.page_expires_at || '') > Date.now());
    if (live.length >= MAX_OPEN_PAGES) return fail([{ code: 'too_many_pages', message: 'נפתחו יותר מדי דפי תשלום. נסו שוב בעוד שעה.' }]);

    // 'p' + 31 hex: the return page sends a 'p' order to confirmPayment and a 'k' one to confirmCard.
    const orderId = `p${crypto.randomUUID().replace(/-/g, '').slice(1)}`;
    const payment = await Payment.create({
      customer_id: customerId,
      owner_user_id: customer?.owner_user_id || 'guest',
      kind: 'one_time',
      description: offer.description,
      amount: offer.amount,
      status: 'awaiting_payment',
      order_id: orderId,
      page_expires_at: new Date(Date.now() + PAGE_MINUTES * 60_000).toISOString(),
      buyer_name: `${firstName} ${lastName}`.trim(),
      buyer_email: email,
      buyer_phone: phone,
    });

    try {
      const url = await signPage(cfg, {
        order: orderId,
        amount: offer.amount,
        info: offer.description,
        firstName,
        lastName,
        email,
        phone,
        lang,
        // The buyer picks 1 to max on HYP's page (FixTash=False).
        ...(offer.maxInstallments > 1 ? { installments: { max: offer.maxInstallments } } : {}),
        ...(offer.invoice ? { invoice: { description: offer.description, lang } } : {}),
      });
      return Response.json({ url, order_id: orderId });
    } catch (error) {
      if (error instanceof HypError) {
        console.error('createPayment:', error.message);
        await Payment.update(payment.id, { status: 'failed', error_code: error.reason, ccode: error.ccode });
        return fail([{ code: error.reason, message: 'לא ניתן לפתוח את דף התשלום' }]);
      }
      throw error;
    }
  } catch (error) {
    return serverError(error);
  }
});
