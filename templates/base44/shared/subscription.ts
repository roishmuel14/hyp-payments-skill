// The monthly subscription with merchant-managed tokens: what the daily run (runBilling) does with
// one BillingAccount, and the small helpers a project's own actions call (start or extend a trial,
// cancel at the end of the paid period).
// [DESIGN] The engine it was generalized from (same rules) ran on a production terminal in test
// mode in 11/2026 (1 ILS charges, each cancelled the same day) and was then switched to live. This
// generalized copy is tested against the fakes only.
//
// Money rules, all enforced here:
// - Nothing is charged, written or emailed unless the BILLING_MODE secret says so (off by default;
//   test = only the listed customers, 1 ILS; live = everyone at the full price).
// - One money action per customer at a time (the account lock), and every decision on a fresh read
//   under the lock.
// - At most one paid charge per period: a period that already has a paid row only moves the dates.
// - A row that HYP never answered (processing) or that a person cancelled or refunded stops the
//   period until a person decides. Nothing is retried on a guess.
// - Tries on days 0, 3 and 7 after the period falls due, past_due meanwhile, expired after the
//   grace days. A trial that ends without a card expires at once.
import { addDays, addMonths } from './common.ts';
import { getCustomer, notify, onSubscriptionChange } from './customer.ts';
import { type HypConfig, chargeToken, tokefExpired } from './hyp.ts';
import { type BillingSettings, chargePayment, lockAccount, unlockAccount } from './billing.ts';

// The day of each try, counted from the day the period fell due.
export const RETRY_DAYS = [0, 3, 7];
// Reminders before a trial ends while there is no card, in days left.
const TRIAL_REMINDERS = [7, 1];
// The line in HYP's transaction list and on the invoice. Put the app's name first.
const CHARGE_INFO = 'מנוי חודשי';

export type BillResult = 'not_due' | 'charged' | 'declined' | 'unknown' | 'expired' | 'cancelled' | 'locked' | 'skipped' | 'off';

export const BILLABLE = ['trial', 'active', 'past_due'];

// ---------- The billing mode ----------

export type BillingMode = { mode: 'off' | 'test' | 'live'; testCustomers: string[] };

// BILLING_MODE (off | test | live; anything else is off) and BILLING_TEST_CUSTOMERS (customer ids,
// comma separated), both secrets, never the request. off: the daily run only counts what is due.
// test: only the listed customers, every charge TEST_CHARGE_AMOUNT (cancel each one the same day).
// live: everyone, the full price. Keep it off through the build, run the live checks in test, and
// switch to live on launch day, after the test data is deleted.
export function billingMode(): BillingMode {
  const raw = (Deno.env.get('BILLING_MODE') || '').trim().toLowerCase();
  const testCustomers = (Deno.env.get('BILLING_TEST_CUSTOMERS') || '')
    .split(/[\s,]+/)
    .filter((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id));
  return { mode: raw === 'live' || raw === 'test' ? raw : 'off', testCustomers };
}

// Whether billing may write, charge or email for this customer in this mode.
export function mayBill(mode: BillingMode, customerId: string): boolean {
  return mode.mode === 'live' || (mode.mode === 'test' && mode.testCustomers.includes(customerId));
}

export const TEST_CHARGE_AMOUNT = 1;

// Whole days from `from` to `to` (both YYYY-MM-DD).
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// The first day of the period that is (or will be) charged next.
// deno-lint-ignore no-explicit-any
function periodStart(account: any): string {
  return account.next_period_start || (account.paid_through ? addDays(account.paid_through, 1) : account.next_charge_on);
}

// Sends one reminder once: the key is claimed with updateMany on the last key sent.
// deno-lint-ignore no-explicit-any
async function remindOnce(base44: any, account: any, key: string, kind: string, data: Record<string, unknown>): Promise<void> {
  if (account.last_notice === key) return;
  const res = await base44.asServiceRole.entities.BillingAccount.updateMany(
    { id: account.id, last_notice: account.last_notice ?? null },
    { $set: { last_notice: key } },
  );
  if (res?.updated === 1) await notify(base44, await getCustomer(base44, account.customer_id), kind, data);
}

// deno-lint-ignore no-explicit-any
async function setStatus(base44: any, account: any, set: Record<string, unknown>): Promise<void> {
  await base44.asServiceRole.entities.BillingAccount.update(account.id, set);
  if (set.subscription_status && set.subscription_status !== account.subscription_status) {
    await onSubscriptionChange(base44, account.customer_id, String(set.subscription_status));
  }
}

// One account, on `today` (the Israel day). Safe to call any number of times a day. Does nothing
// at all ('off') for a customer the mode does not cover.
// deno-lint-ignore no-explicit-any
export async function billAccount(base44: any, accountId: string, today: string, settings: BillingSettings, cfg: HypConfig, mode: BillingMode): Promise<BillResult> {
  const BillingAccount = base44.asServiceRole.entities.BillingAccount;
  const Payment = base44.asServiceRole.entities.Payment;
  let account = await BillingAccount.get(accountId);
  if (!BILLABLE.includes(account?.subscription_status)) return 'skipped';
  if (!mayBill(mode, account.customer_id)) return 'off';

  if (account.subscription_status === 'trial' && !account.token && account.trial_ends_at) {
    const left = daysBetween(today, account.trial_ends_at);
    if (TRIAL_REMINDERS.includes(left)) {
      await remindOnce(base44, account, `trial-${left}:${account.trial_ends_at}`, 'trial_ending_no_card', { trial_ends_at: account.trial_ends_at });
    }
  }
  // In the 7 days before the charge, not on the day itself: that day's try fails without HYP, and
  // its charge_failed notice already says the card expired (two emails otherwise; seen live, 11/2026).
  if (account.token && account.next_charge_on && !account.cancel_at_period_end && tokefExpired(account.tokef, account.next_charge_on)) {
    const left = daysBetween(today, account.next_charge_on);
    if (left >= 1 && left <= 7) await remindOnce(base44, account, `card-expiring:${account.tokef}`, 'card_expiring', { next_charge_on: account.next_charge_on });
  }
  if (!account.next_charge_on || account.next_charge_on > today) return 'not_due';

  const lockId = await lockAccount(base44, account);
  if (!lockId) return 'locked';
  try {
    account = await BillingAccount.get(accountId);
    if (!BILLABLE.includes(account.subscription_status)) return 'skipped';
    if (!account.next_charge_on || account.next_charge_on > today) return 'not_due';
    const customer = await getCustomer(base44, account.customer_id);

    // The customer cancelled: the paid period is over, nothing more is charged.
    if (account.cancel_at_period_end) {
      await setStatus(base44, account, { subscription_status: 'cancelled', next_charge_on: null });
      await notify(base44, customer, 'cancelled', { paid_through: account.paid_through || '' });
      return 'cancelled';
    }
    // A trial that ends without a card expires at once (no tries, no grace).
    if (account.subscription_status === 'trial' && !account.token) {
      await setStatus(base44, account, { subscription_status: 'expired', next_charge_on: null });
      await notify(base44, customer, 'expired', { reason: 'no_card' });
      return 'expired';
    }

    const start = periodStart(account);
    const end = addDays(addMonths(start, 1), -1);
    const rows = ((await Payment.filter({ customer_id: account.customer_id, period_start: start }, 'created_date', 50)) ?? [])
      // deno-lint-ignore no-explicit-any
      .filter((r: any) => r.kind === 'subscription');
    // deno-lint-ignore no-explicit-any
    const paid = rows.find((r: any) => ['succeeded', 'partially_refunded'].includes(r.status));
    if (paid) {
      // A run died after HYP charged and before the dates moved: move them now, charge nothing.
      await markPaid(base44, account, end);
      return 'charged';
    }
    // deno-lint-ignore no-explicit-any
    const open = rows.filter((r: any) => !['failed', 'pending'].includes(r.status));
    if (open.length) {
      console.error('billAccount: a charge of this period has no answer from HYP, or was cancelled or refunded: a person decides', account.id, start, open.map((r: { status: string }) => r.status).join(','));
      return 'unknown';
    }

    const dueSince = account.due_since || account.next_charge_on;
    const attempt = (Number(account.failed_attempts) || 0) + 1;
    const expiryDay = addDays(dueSince, Math.max(settings.grace_days, RETRY_DAYS[RETRY_DAYS.length - 1]));
    if (attempt > RETRY_DAYS.length) {
      if (today < expiryDay) {
        await BillingAccount.update(account.id, { next_charge_on: expiryDay });
        return 'skipped';
      }
      await setStatus(base44, account, { subscription_status: 'expired', next_charge_on: null });
      await notify(base44, customer, 'expired', { reason: 'unpaid' });
      return 'expired';
    }

    // No usable card counts as a failed try, without calling HYP.
    let reason = '';
    if (!account.token || !account.tokef) reason = 'no_card';
    else if (tokefExpired(account.tokef, today)) reason = 'card_expired';
    else if (!customer || customer.blocked) reason = 'bad_status';
    if (!reason) {
      if (settings.monthly_price === null) {
        console.error('billAccount: no valid monthly_price in the settings: nothing charged', account.id);
        return 'skipped';
      }
      // deno-lint-ignore no-explicit-any
      const pending = rows.find((r: any) => r.status === 'pending');
      const payment = pending ?? await Payment.create({
        customer_id: account.customer_id,
        owner_user_id: account.owner_user_id || customer!.owner_user_id || '',
        kind: 'subscription',
        description: CHARGE_INFO,
        amount: mode.mode === 'test' ? TEST_CHARGE_AMOUNT : settings.monthly_price,
        status: 'pending',
        period_start: start,
        period_end: end,
        attempt,
        created_by: 'cron',
      });
      const outcome = await chargePayment(base44, payment, () => chargeToken(cfg, {
        token: account.token,
        tokef: account.tokef,
        idNumber: account.card_id_number || '',
        amount: Number(payment.amount),
        firstName: customer!.first_name,
        lastName: customer!.last_name,
        email: customer!.email,
        info: CHARGE_INFO,
        invoiceDescription: CHARGE_INFO,
      }));
      if (outcome.ok) {
        await markPaid(base44, account, end);
        return 'charged';
      }
      if (outcome.reason === 'charge_unknown' || outcome.reason === 'already_charged') return 'unknown';
      reason = outcome.reason;
    }

    // A failed try: past_due, the next try (or the expiry day), and a notice.
    const next = attempt < RETRY_DAYS.length ? addDays(dueSince, RETRY_DAYS[attempt]) : expiryDay;
    const expireNow = attempt >= RETRY_DAYS.length && today >= expiryDay;
    await setStatus(base44, account, {
      subscription_status: expireNow ? 'expired' : 'past_due',
      due_since: dueSince,
      failed_attempts: attempt,
      next_charge_on: expireNow ? null : next,
    });
    await notify(base44, customer, expireNow ? 'expired' : 'charge_failed', { reason, attempt, next_try: expireNow ? '' : next });
    return expireNow ? 'expired' : 'declined';
  } finally {
    await unlockAccount(base44, account.id, lockId);
  }
}

// A paid period: active, the dates move a month, the tries start over.
// deno-lint-ignore no-explicit-any
async function markPaid(base44: any, account: any, periodEnd: string): Promise<void> {
  await setStatus(base44, account, {
    subscription_status: 'active',
    paid_through: periodEnd,
    next_period_start: addDays(periodEnd, 1),
    next_charge_on: addDays(periodEnd, 1),
    failed_attempts: 0,
    due_since: null,
  });
}

// ---------- Helpers for the project's own actions ----------

// Starts a free trial of `days` days from `today` (a project may start it when an admin approves the
// account, not at sign-up). The first charge is the day after the trial's last day.
// deno-lint-ignore no-explicit-any
export async function startTrial(base44: any, account: any, today: string, days: number): Promise<void> {
  const last = addDays(today, Math.max(0, days) - 1);
  await setStatus(base44, account, {
    subscription_status: 'trial',
    trial_ends_at: last,
    next_period_start: addDays(last, 1),
    next_charge_on: addDays(last, 1),
    failed_attempts: 0,
    due_since: null,
  });
}

// An admin moves the trial's last day; the first charge moves with it.
// deno-lint-ignore no-explicit-any
export async function extendTrial(base44: any, account: any, lastDay: string): Promise<void> {
  if (account.subscription_status !== 'trial') throw new Error('extendTrial: the account is not in a trial');
  await base44.asServiceRole.entities.BillingAccount.update(account.id, { trial_ends_at: lastDay, next_period_start: addDays(lastDay, 1), next_charge_on: addDays(lastDay, 1) });
}

// The customer cancels (on = true) or takes the cancel back (false). No refund: the paid period
// runs to its end, and the daily run ends the subscription on the day it would have charged.
// deno-lint-ignore no-explicit-any
export async function cancelAtPeriodEnd(base44: any, account: any, on: boolean): Promise<void> {
  await base44.asServiceRole.entities.BillingAccount.update(account.id, { cancel_at_period_end: on });
}

// A new card on a past_due or expired account makes it due today with fresh tries (confirmCard
// then calls billAccount at once). past_due keeps its period (the customer kept the service);
// an expired account starts a new period today, as past_due until the charge passes.
// deno-lint-ignore no-explicit-any
export async function retryWithNewCard(base44: any, account: any, today: string): Promise<boolean> {
  if (!['past_due', 'expired'].includes(account.subscription_status)) return false;
  const set: Record<string, unknown> = { next_charge_on: today, failed_attempts: 0, due_since: today };
  if (account.subscription_status === 'expired') Object.assign(set, { subscription_status: 'past_due', next_period_start: today });
  await setStatus(base44, account, set);
  return true;
}
