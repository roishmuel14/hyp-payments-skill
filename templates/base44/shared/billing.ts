// Billing records: the customer's BillingAccount (card token, server only), Payment rows and the
// billing settings. The HYP protocol is in hyp.ts and the customer lookup in customer.ts; hyp.ts,
// common.ts and customer.ts go with every consumer of this file (see scripts/sync-shared.mjs).
import { israelToday } from './common.ts';
import type { Customer } from './customer.ts';
import { type ReverseResult, reasonFor, reverseReasonFor, tokefExpired } from './hyp.ts';

// ---------- Settings ----------

// Where the price and the subscription rules live: the first row of the project's settings
// entity. Point SETTINGS_ENTITY at the project's own one. The charged amount includes VAT: it is
// the source of truth for what the card pays, whatever the price page says.
const SETTINGS_ENTITY = 'Settings';

// monthly_price is null until an admin sets a valid one: nothing is charged without it.
export type BillingSettings = { monthly_price: number | null; trial_days: number; grace_days: number; card_required_at_signup: boolean };

// deno-lint-ignore no-explicit-any
export async function getBillingSettings(base44: any): Promise<BillingSettings> {
  const rows = (await base44.asServiceRole.entities[SETTINGS_ENTITY].list('created_date', 1)) ?? [];
  const price = Number(rows[0]?.monthly_price);
  const trial = Number(rows[0]?.trial_days);
  const grace = Number(rows[0]?.grace_days);
  return {
    monthly_price: Number.isFinite(price) && price > 0 && price <= 10000 ? Math.round(price * 100) / 100 : null,
    trial_days: Number.isInteger(trial) && trial >= 0 && trial <= 365 ? trial : 30,
    grace_days: Number.isInteger(grace) && grace >= 0 && grace <= 60 ? grace : 7,
    card_required_at_signup: rows[0]?.card_required_at_signup === true,
  };
}

// ---------- Billing account ----------

// One account per customer. If two requests ever created two rows at once, every caller still
// works on the same one: the oldest. An empty id is refused: an empty value in a filter matches
// every row.
// deno-lint-ignore no-explicit-any
export async function findBillingAccount(base44: any, customerId: string): Promise<any | null> {
  if (!customerId) return null;
  const rows = await base44.asServiceRole.entities.BillingAccount.filter({ customer_id: customerId }, 'created_date', 1);
  return rows?.[0] ?? null;
}

// deno-lint-ignore no-explicit-any
export async function ensureBillingAccount(base44: any, customer: Customer): Promise<any> {
  const existing = await findBillingAccount(base44, customer.id);
  if (existing) return existing;
  await base44.asServiceRole.entities.BillingAccount.create({
    customer_id: customer.id,
    owner_user_id: customer.owner_user_id || '',
    failed_attempts: 0,
  });
  // Read back instead of trusting create(): a parallel create resolves to the same oldest row.
  return await findBillingAccount(base44, customer.id);
}

// One money action per customer at a time: the run that charges takes the account's lock with
// updateMany (compare-and-set on the value it read), and only the run holding it charges.
// A lock older than LOCK_MINUTES belongs to a run that died (functions run for minutes at most)
// and is taken over the same way, on its exact old value.
const LOCK_MINUTES = 15;

// deno-lint-ignore no-explicit-any
export async function lockAccount(base44: any, account: any): Promise<string | null> {
  const current = account.charge_lock || null;
  const stale = current && !(Date.parse(account.charge_lock_at || '') > Date.now() - LOCK_MINUTES * 60_000);
  if (current && !stale) return null;
  const lockId = crypto.randomUUID();
  const res = await base44.asServiceRole.entities.BillingAccount.updateMany(
    { id: account.id, charge_lock: current },
    { $set: { charge_lock: lockId, charge_lock_at: new Date().toISOString() } },
  );
  return res?.updated === 1 ? lockId : null;
}

// deno-lint-ignore no-explicit-any
export async function unlockAccount(base44: any, accountId: string, lockId: string): Promise<void> {
  await base44.asServiceRole.entities.BillingAccount.updateMany(
    { id: accountId, charge_lock: lockId },
    { $set: { charge_lock: null, charge_lock_at: null } },
  );
}

export type CardSummary = { last4: string; brand: string; exp: string; expired: boolean };

// HYP's Brand can come back as a number (the production terminal sent "1" on 25/10/2026), and
// HYP Pay documents no table for those numbers: show a brand only when it is a name.
export function brandName(raw: unknown): string {
  const value = String(raw ?? '').trim();
  return /[A-Za-z\u0590-\u05FF]/.test(value) ? value.slice(0, 30) : '';
}

// What may leave the server about a card: never the token, its expiry string or the ID number.
// deno-lint-ignore no-explicit-any
export function cardSummary(account: any, today: string): CardSummary | null {
  if (!account?.token || !account?.tokef) return null;
  const tokef = String(account.tokef);
  return {
    last4: account.card_last4 || String(account.token).slice(-4),
    brand: brandName(account.card_brand),
    exp: `${tokef.slice(2, 4)}/${tokef.slice(0, 2)}`,
    expired: tokefExpired(tokef, today),
  };
}

// ---------- Payments ----------

// What the customer (and the admin) sees of a payment.
// deno-lint-ignore no-explicit-any
export function paymentSummary(p: any) {
  return {
    id: p.id,
    kind: p.kind,
    description: p.description || '',
    amount: p.amount,
    status: p.status,
    period_start: p.period_start || '',
    period_end: p.period_end || '',
    charged_at: p.charged_at || '',
    created_date: p.created_date || '',
    invoice: p.invoice || '',
    ccode: p.ccode || '',
    error_code: p.error_code || '',
    refunded_amount: toAgorot(p.refunded_amount) / 100,
    cancelled_at: p.cancelled_at || '',
    refunded_at: p.refunded_at || '',
  };
}

// The admin's view adds what can be done with the payment now and every cancel or refund attempt.
// deno-lint-ignore no-explicit-any
export function adminPaymentSummary(p: any, today: string) {
  return {
    ...paymentSummary(p),
    ...reverseOffer(p, today),
    // deno-lint-ignore no-explicit-any
    refunds: refundAttempts(p).map((r: any) => ({
      kind: r.kind,
      amount: r.amount,
      status: r.status,
      ccode: r.ccode || '',
      error_code: r.error_code || '',
      requested_at: r.requested_at || '',
      answered_at: r.answered_at || '',
    })),
  };
}

// deno-lint-ignore no-explicit-any
export async function listPayments(base44: any, customerId: string, limit = 24, summary: (p: any) => any = paymentSummary): Promise<any[]> {
  if (!customerId) return [];
  const rows = await base44.asServiceRole.entities.Payment.filter({ customer_id: customerId }, '-created_date', limit);
  return (rows ?? []).map(summary);
}

export type ChargeOutcome = {
  ok: boolean;
  reason: string;
  // deno-lint-ignore no-explicit-any
  payment: any;
};

// Charges one Payment row exactly once. The row is claimed with updateMany (compare-and-set on
// status 'pending') BEFORE HYP is called, so a second call for the same row charges nothing; every
// later write matches the claim. A row left in 'processing' (the run died after calling HYP) is
// never retried here: HYP may have charged it, so it is checked by hand in the HYP portal.
// `charge` is hyp.ts's chargeToken bound to the terminal and the card.
export async function chargePayment(
  // deno-lint-ignore no-explicit-any
  base44: any,
  // deno-lint-ignore no-explicit-any
  payment: any,
  charge: () => Promise<{ ccode: string; transId: string; acode: string; invoice: string }>,
): Promise<ChargeOutcome> {
  const Payment = base44.asServiceRole.entities.Payment;
  const claimId = crypto.randomUUID();
  const claimedAt = new Date().toISOString();
  const claim = await Payment.updateMany(
    { id: payment.id, status: 'pending' },
    { $set: { status: 'processing', claim_id: claimId, claimed_at: claimedAt } },
  );
  if (!claim || claim.updated !== 1) {
    return { ok: false, reason: 'already_charged', payment: paymentSummary(payment) };
  }

  let result: { ccode: string; transId: string; acode: string; invoice: string };
  try {
    result = await charge();
  } catch (error) {
    // No answer from HYP: whether the card was charged is unknown, so the row stays 'processing'.
    console.error('chargePayment: no answer from HYP', payment.id, (error as Error).message);
    return { ok: false, reason: 'charge_unknown', payment: paymentSummary({ ...payment, status: 'processing' }) };
  }

  const ok = result.ccode === '0';
  const reason = ok ? '' : (result.ccode ? reasonFor(result.ccode) : 'charge_unknown');
  const update = {
    status: ok ? 'succeeded' : (result.ccode ? 'failed' : 'processing'),
    charged_at: new Date().toISOString(),
    hyp_trans_id: result.transId,
    ccode: result.ccode,
    acode: result.acode,
    invoice: result.invoice,
    error_code: reason,
  };
  await Payment.updateMany({ id: payment.id, status: 'processing', claim_id: claimId }, { $set: update });
  console.log('chargePayment', payment.id, ok ? 'succeeded' : `failed CCode=${result.ccode || 'none'}`);
  return { ok, reason, payment: paymentSummary({ ...payment, ...update }) };
}

// ---------- Cancel and refund ----------
// Money back on a succeeded Payment: a cancel (HYP CancelTrans: the whole charge, until HYP
// transmits it) or a refund (HYP zikoyAPI: all or part of what is left, after). Every attempt is
// kept in Payment.refunds (pending, approved or declined); refunded_amount is the sum of the
// approved ones. Subscriptions: a cancelled or fully refunded payment no longer pays its period,
// and nothing here moves BillingAccount.paid_through back: that is the admin's decision.

const toAgorot = (ils: unknown) => Math.round((Number(ils) || 0) * 100);

// deno-lint-ignore no-explicit-any
const refundAttempts = (p: any): any[] => (Array.isArray(p?.refunds) ? p.refunds : []);

// The Israel day of a stored timestamp ('' when there is none). Platform timestamps come back in
// UTC without a trailing Z, ours carry one.
function israelDayOf(ts: unknown): string {
  const raw = String(ts || '');
  if (!raw) return '';
  const date = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`);
  return Number.isNaN(date.getTime()) ? '' : israelToday(date);
}

// What is left to give back on a payment, in agorot. Zero for anything but a charge HYP approved
// (a pending, failed or unanswered row, or one being cancelled or refunded right now).
// deno-lint-ignore no-explicit-any
export function leftAgorot(p: any): number {
  if (!['succeeded', 'partially_refunded'].includes(p?.status) || !p?.hyp_trans_id) return 0;
  return Math.max(0, toAgorot(p.amount) - toAgorot(p.refunded_amount));
}

// What the admin is offered now, by HYP's documented windows: a cancel on the Israel day of the
// charge, while nothing was given back and HYP did not say it was already transmitted (920); a
// refund on any later day, or right after that 920. HYP has the last word on the timing, so
// reversePayment does not check the day.
// deno-lint-ignore no-explicit-any
export function reverseOffer(p: any, today: string): { offer: '' | 'cancel' | 'refund'; refund_left: number } {
  const left = leftAgorot(p);
  if (!left) return { offer: '', refund_left: 0 };
  const transmitted = refundAttempts(p).some((r) => r.kind === 'cancel' && r.ccode === '920');
  const cancel = p.status === 'succeeded' && !toAgorot(p.refunded_amount) && !transmitted && israelDayOf(p.charged_at) === today;
  return { offer: cancel ? 'cancel' : 'refund', refund_left: left / 100 };
}

export type ReverseAsk = { kind: 'cancel' | 'refund'; agorot: number; note: string; by: string };

// Cancels or refunds a Payment exactly once. The caller holds the account lock and has checked the
// amount against leftAgorot on a fresh read. The row is claimed with updateMany BEFORE HYP is
// called, on the exact status and refunded_amount it read, so a parallel or later second request
// sends nothing; every later write matches the claim. A row left 'cancelling' / 'refunding' (no
// answer from HYP) is unknown: it is never retried here, it is checked in the HYP portal and fixed
// by hand. `send` is hyp.ts's cancelTrans or refundTrans bound to the terminal and the charge.
export async function reversePayment(
  // deno-lint-ignore no-explicit-any
  base44: any,
  // deno-lint-ignore no-explicit-any
  payment: any,
  ask: ReverseAsk,
  send: () => Promise<ReverseResult>,
): Promise<ChargeOutcome> {
  const Payment = base44.asServiceRole.entities.Payment;
  const inFlight = ask.kind === 'cancel' ? 'cancelling' : 'refunding';
  const claimId = crypto.randomUUID();
  const requestedAt = new Date().toISOString();
  const before = refundAttempts(payment);
  const attempt = { kind: ask.kind, amount: ask.agorot / 100, status: 'pending', requested_at: requestedAt, by: ask.by, note: ask.note };
  const claim = await Payment.updateMany(
    { id: payment.id, status: payment.status, refunded_amount: payment.refunded_amount ?? null },
    { $set: { status: inFlight, refund_claim_id: claimId, refund_claimed_at: requestedAt, refunds: [...before, attempt] } },
  );
  if (!claim || claim.updated !== 1) {
    return { ok: false, reason: 'payment_changed', payment: paymentSummary(payment) };
  }

  let result: ReverseResult;
  try {
    result = await send();
  } catch (error) {
    // No answer from HYP: whether the money went back is unknown, so the row stays in flight.
    console.error('reversePayment: no answer from HYP', payment.id, ask.kind, (error as Error).message);
    return { ok: false, reason: 'refund_unknown', payment: paymentSummary({ ...payment, status: inFlight }) };
  }

  const answeredAt = new Date().toISOString();
  const answer = { ...attempt, ccode: result.ccode, answered_at: answeredAt, ...(result.reversal ? { reversal: result.reversal } : {}) };
  // CCode 0 is HYP's "cancelled" / "refunded". A cancel's ReversalStatus is only kept: the docs show
  // 777, but the production terminal answered 125 to a cancel the HYP portal shows as done (08/11/2026).
  const ok = result.ccode === '0';
  let reason = '';
  let update: Record<string, unknown>;
  if (ok) {
    const refunded = toAgorot(payment.refunded_amount) + ask.agorot;
    update = {
      status: ask.kind === 'cancel' ? 'cancelled' : refunded >= toAgorot(payment.amount) ? 'refunded' : 'partially_refunded',
      refunded_amount: refunded / 100,
      [ask.kind === 'cancel' ? 'cancelled_at' : 'refunded_at']: answeredAt,
      refunds: [...before, { ...answer, status: 'approved', trans_id: result.transId, acode: result.acode, invoice: result.invoice }],
    };
  } else if (result.ccode) {
    // HYP said no, so nothing moved: the row goes back to its status, and the attempt is kept.
    reason = reverseReasonFor(result.ccode);
    update = { status: payment.status, refunds: [...before, { ...answer, status: 'declined', error_code: reason }] };
  } else {
    // An answer without a CCode: unknown, like no answer at all.
    reason = 'refund_unknown';
    update = { refunds: [...before, { ...answer, error_code: reason }] };
  }
  await Payment.updateMany({ id: payment.id, status: inFlight, refund_claim_id: claimId }, { $set: update });
  console.log(
    'reversePayment', payment.id, ask.kind, ask.agorot / 100, ok ? 'approved' : 'not approved',
    `CCode=${result.ccode || 'none'}${result.reversal ? ` ReversalStatus=${result.reversal}` : ''}`,
  );
  return { ok, reason, payment: paymentSummary({ ...payment, ...update, status: update.status ?? inFlight }) };
}
