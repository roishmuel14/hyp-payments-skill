// The second file to adapt per project, for one-time payments only: what is sold, at what price,
// and what happens once HYP's answer is verified. The price is decided here, on the server, from
// the project's own records: an amount, a coupon or a discount sent by the browser is never trusted.
// A live checkout (one-time payments with installments, coupons and HYP invoices) is the model: it
// re-validates the coupon on the server and grants access only after VERIFY.
// No imports except type-only ones, so every function folder can carry its own copy.
import type { Reason } from './common.ts';

export type Quote = {
  // ILS including VAT: exactly what the card is charged.
  amount: number;
  // What was bought, in Hebrew: the line in HYP's transaction list, the admin's list and the invoice.
  description: string;
  // 1 = a single payment. More needs the terminal's approval for installments.
  maxInstallments: number;
  // true = HYP Invoice issues the document and emails it (the terminal's invoice module must be set up).
  invoice: boolean;
};

// Where the default product lives: the first row of the project's settings entity.
const SETTINGS_ENTITY = 'Settings';
const MIN_FOR_INSTALLMENTS = 100;

// The price of what the body asks for, or the reasons it cannot be sold. Default: one product from
// the settings row (one_time_price, one_time_name, max_installments, invoices_enabled). Coupons are
// refused until the project implements them here (look the code up, check it is active, for this
// product and not used up, then compute the price on the server).
// deno-lint-ignore no-explicit-any
export async function quote(base44: any, body: Record<string, unknown>): Promise<Quote | Reason[]> {
  if (body.coupon) return [{ code: 'coupon_invalid', message: 'הקופון אינו תקף', field: 'coupon' }];
  const rows = (await base44.asServiceRole.entities[SETTINGS_ENTITY].list('created_date', 1)) ?? [];
  const price = Number(rows[0]?.one_time_price);
  if (!Number.isFinite(price) || price <= 0 || price > 100000) {
    return [{ code: 'billing_unavailable', message: 'המכירה עוד לא מוגדרת' }];
  }
  const max = Number(rows[0]?.max_installments);
  const amount = Math.round(price * 100) / 100;
  return {
    amount,
    description: String(rows[0]?.one_time_name || 'רכישה').slice(0, 100),
    // HYP refuses installments below a minimum per payment (CCode 403); one live checkout offers a
    // single payment under 100 ILS. Not seen live: adjust with the terminal's real minimum.
    maxInstallments: Number.isInteger(max) && max >= 1 && max <= 36 && amount >= MIN_FOR_INSTALLMENTS ? max : 1,
    invoice: rows[0]?.invoices_enabled === true,
  };
}

// Runs once per paid order, after VERIFY and the claim (confirmPayment). Grant access, issue a
// ticket, send the buyer an email. It must be safe to run again after a crash halfway: confirmPayment
// retries it on the next reload until it returns without throwing.
// deno-lint-ignore no-explicit-any
export async function fulfill(_base44: any, payment: any): Promise<void> {
  await Promise.resolve();
  console.log('fulfill: nothing to do yet for', payment.id, payment.description);
}
