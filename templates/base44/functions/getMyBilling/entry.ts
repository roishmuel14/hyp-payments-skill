import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { currentUser, fail, israelToday, serverError, unauthorized } from './_shared/common.ts';
import { findOwnCustomer } from './_shared/customer.ts';
import { hypConfig } from './_shared/hyp.ts';
import { cardSummary, findBillingAccount, getBillingSettings, listPayments } from './_shared/billing.ts';

// The caller's own billing, for the personal area: subscription status, trial, price, the saved
// card (last 4 digits and expiry only) and the payment history. BillingAccount is never read by the
// browser; this is the only view of it a customer gets.
// `card_enabled` is false until the HYP terminal is set up, so the page can hide "add a card".
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await currentUser(base44);
    if (!user) return unauthorized();

    const customer = await findOwnCustomer(base44, user);
    if (!customer) return fail([{ code: 'no_customer', message: 'לא נמצא חשבון לחיוב' }]);

    const [settings, account, payments] = await Promise.all([
      getBillingSettings(base44),
      findBillingAccount(base44, customer.id),
      listPayments(base44, customer.id),
    ]);
    return Response.json({
      subscription_status: account?.subscription_status || 'none',
      trial_ends_at: account?.trial_ends_at || '',
      cancel_at_period_end: account?.cancel_at_period_end === true,
      price: settings.monthly_price,
      card_enabled: hypConfig() !== null,
      card: cardSummary(account, israelToday()),
      next_charge_on: account?.next_charge_on || '',
      paid_through: account?.paid_through || '',
      payments,
    });
  } catch (error) {
    return serverError(error);
  }
});
