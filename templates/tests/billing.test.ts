// The HYP billing functions end to end, against an in-memory Base44 (tests/fake-sdk.ts) and a fake
// HYP that answers like the documented API (developers.hyp.co.il/pay). Proves the logic: card
// session, VERIFY with a '+' in Sign, token kept on the server, declines, forged and foreign
// redirects, that a charge never runs twice, that a cancel or refund never gives back more than the
// charge or gives it back twice, the one-time payment page, and the daily subscription run. Does NOT
// prove HYP's real answers or the platform's RLS: those are checked on the terminal and the live app
// (references/testing-and-go-live.md in the hyp-payments skill).
//
// Run: deno test --no-config --node-modules-dir=none --import-map=tests/import_map.json --allow-env --allow-read=. tests/
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { store } from './fake-sdk.ts';
import { parseQuery, reasonFor, tokefExpired } from '../base44/shared/hyp.ts';

// ---------- Fake HYP ----------

const CFG = { HYP_MASOF: '0010000001', HYP_PASSP: 'test-passp', HYP_KEY: 'test-key' };
// A made-up token in HYP's shape: 19 digits, the last 4 are the card's (0772, as in the docs' example).
const TOKEN = '1000000000000000772';
const TOKEF = '3105';
// HYP's Sign can be base64: '+' and '/' must survive the round trip through the browser.
const SIGN = 'Zm9v+YmFy/YmF6+cXV4==';

type Call = Record<string, string>;
const hyp = {
  calls: [] as Call[],
  // What the fake HYP recorded when the customer "filled the page": Id -> { order, ccode, amount? }.
  transactions: new Map<string, { order: string; ccode: string; amount?: string }>(),
  softCCode: '0',
  tokenPermission: true,
  // Approved charges (soft Id -> agorot), what HYP refunded of each, and which ones it already
  // transmitted to the card company (CancelTrans answers 920 for those).
  charges: new Map<string, number>(),
  refunded: new Map<string, number>(),
  transmitted: new Set<string>(),
  nextId: 900001000,
  // Overrides for one test: a CancelTrans answer, a zikoyAPI CCode, no answer at all, or one host down.
  cancelAnswer: '',
  refundCCode: '',
  silent: false,
  downHost: '',
};

function answer(pairs: Record<string, string>): string {
  return Object.entries(pairs).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const host = url.origin + url.pathname;
  if (!['https://pay.hyp.co.il/p/', 'https://icom.yaad.net/p/'].includes(host)) throw new Error(`unexpected fetch ${url.href}`);
  await new Promise((r) => setTimeout(r, 5));
  const p: Call = { ...Object.fromEntries(url.searchParams.entries()), _host: host };
  hyp.calls.push(p);
  if (hyp.silent || hyp.downHost === host) throw new TypeError(`error sending request for url (${url.href}): operation timed out`);
  if (p.Masof !== CFG.HYP_MASOF || p.PassP !== CFG.HYP_PASSP) return new Response('CCode=902');

  if (p.action === 'APISign' && p.What === 'SIGN') {
    if (p.KEY !== CFG.HYP_KEY) return new Response('CCode=902');
    const echo = Object.fromEntries(Object.entries(p).filter(([k]) => !['action', 'What', 'KEY', 'PassP', '_host'].includes(k)));
    return new Response(`${answer(echo)}&action=pay&signature=test-signature`);
  }
  if (p.action === 'APISign' && p.What === 'VERIFY') {
    const tx = hyp.transactions.get(p.Id);
    const ok = tx && p.Sign === SIGN && p.Order === tx.order && p.CCode === tx.ccode && (tx.amount === undefined || p.Amount === tx.amount);
    return new Response(ok ? 'CCode=0' : 'CCode=200');
  }
  if (p.action === 'getToken') {
    if (!hyp.tokenPermission) return new Response('CCode=901&Fild1=&Fild2=&Fild3=');
    if (!hyp.transactions.has(p.TransId) || p.allowFalse !== 'True') return new Response('CCode=910&Fild1=&Fild2=&Fild3=');
    return new Response(answer({ Id: p.TransId, CCode: '0', Token: TOKEN, Tokef: TOKEF, Fild1: '', Fild2: '', Fild3: '' }));
  }
  if (p.action === 'soft') {
    if (p.Token !== 'True' || p.CC !== TOKEN || p.Tmonth !== '05' || p.Tyear !== '31') return new Response('Id=1&CCode=997&Amount=0&ACode=');
    const ok = hyp.softCCode === '0';
    const id = String(hyp.nextId++);
    if (ok) hyp.charges.set(id, Math.round(Number(p.Amount) * 100));
    return new Response(answer({ Id: id, CCode: hyp.softCCode, Amount: p.Amount, ACode: ok ? '0000001' : '', Fild1: '', Fild2: '', Fild3: '', ...(ok ? { Hesh: 'EZ' } : {}) }));
  }
  if (p.action === 'CancelTrans') {
    if (hyp.cancelAnswer) return new Response(hyp.cancelAnswer);
    if (!hyp.charges.has(p.TransId) || hyp.transmitted.has(p.TransId)) return new Response(`TransId=${p.TransId}&CCode=920`);
    hyp.charges.delete(p.TransId);
    return new Response(`TransId=${p.TransId}&CCode=0&Hesh=EZ&ReversalStatus=777`);
  }
  if (p.action === 'zikoyAPI') {
    if (hyp.refundCCode) return new Response(`CCode=${hyp.refundCCode}`);
    const charged = hyp.charges.get(p.TransId);
    if (charged === undefined) return new Response('CCode=250');
    const done = (hyp.refunded.get(p.TransId) ?? 0) + Math.round(Number(p.Amount) * 100);
    if (done > charged) return new Response('CCode=33');
    hyp.refunded.set(p.TransId, done);
    return new Response(`Id=${hyp.nextId++}&CCode=0&ACode=0000002&HeshASM=EZ`);
  }
  return new Response('<html>error</html>');
};

// The card-check redirect HYP sends the customer back with, raw, the way it reaches the browser.
function redirect(order: string, { id = '900000001', ccode = '700', sign = SIGN } = {}): string {
  hyp.transactions.set(id, { order, ccode });
  return `Id=${id}&CCode=${ccode}&Amount=1&ACode=&Order=${order}&Fild1=Dana%20Cohen&Fild2=a%40example.test&Fild3=&Brand=Visa&UserId=000000000&Sign=${sign}`;
}

// ---------- Function harness ----------

type Handler = (req: Request) => Promise<Response>;
const handlers: Record<string, Handler> = {};
for (const name of ['createCardSession', 'confirmCard', 'getMyBilling', 'adminCharge', 'adminRefundPayment', 'createPayment', 'confirmPayment', 'runBilling']) {
  // deno-lint-ignore no-explicit-any
  (Deno as any).serve = (h: Handler) => { handlers[name] = h; return {}; };
  await import(`../base44/functions/${name}/entry.ts`);
}

const USER_A = { id: 'userA', email: 'a@example.test', role: 'user', full_name: 'דנה כהן' };
const USER_B = { id: 'userB', email: 'b@example.test', role: 'user', full_name: 'Ben Levi' };
const ADMIN = { id: 'admin1', email: 'admin@example.test', role: 'admin', full_name: 'Admin' };

// deno-lint-ignore no-explicit-any
async function call(name: string, body: unknown, user?: object): Promise<{ status: number; json: any; text: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (user) headers['x-test-user'] = encodeURIComponent(JSON.stringify(user));
  const res = await handlers[name](new Request('http://localhost/', { method: 'POST', headers, body: JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text), text };
}

const reason = (r: { json: { reasons?: { code: string }[] } }) => r.json.reasons?.[0]?.code;
const setSecrets = () => Object.entries(CFG).forEach(([k, v]) => Deno.env.set(k, v));
const clearSecrets = () => Object.keys(CFG).forEach((k) => Deno.env.delete(k));

function seed() {
  for (const k of Object.keys(store)) delete store[k];
  store.User = [
    { ...USER_A, created_date: '2026-10-01T00:00:00Z' },
    { ...USER_B, created_date: '2026-10-02T00:00:00Z' },
  ];
  store.Settings = [{
    id: 's1', monthly_price: 499, trial_days: 30, grace_days: 7,
    one_time_price: 449, one_time_name: 'קורס', max_installments: 3, invoices_enabled: true,
    created_date: '2026-10-01T00:00:00Z',
  }];
  hyp.calls = [];
  hyp.transactions.clear();
  hyp.softCCode = '0';
  hyp.tokenPermission = true;
  hyp.charges.clear();
  hyp.refunded.clear();
  hyp.transmitted.clear();
  hyp.cancelAnswer = '';
  hyp.refundCCode = '';
  hyp.silent = false;
  hyp.downHost = '';
}

const account = (customerId: string) => store.BillingAccount?.find((r) => r.customer_id === customerId);
const softCalls = () => hyp.calls.filter((c) => c.action === 'soft').length;

// ---------- Pure helpers ----------

Deno.test('parseQuery keeps a + in Sign, order and duplicates', () => {
  const pairs = parseQuery(`?a=1&Sign=${SIGN}&Fild1=Dana%20Cohen&a=2`);
  assertEquals(pairs, [['a', '1'], ['Sign', SIGN], ['Fild1', 'Dana Cohen'], ['a', '2']]);
});

Deno.test('a network error never logs the URL query (it carries PassP and KEY)', async () => {
  const { hypConfig, getToken, HypError } = await import('../base44/shared/hyp.ts');
  setSecrets();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request) => Promise.reject(new TypeError(`error sending request for url (${String(input)})`));
  try {
    await getToken(hypConfig()!, '1');
    throw new Error('expected a failure');
  } catch (error) {
    assert(error instanceof HypError);
    assertEquals(error.reason, 'hyp_unreachable');
    assert(!error.message.includes(CFG.HYP_PASSP) && !error.message.includes('PassP'), error.message);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test('a numeric Brand from HYP is not shown as the card brand', async () => {
  const { brandName, cardSummary } = await import('../base44/shared/billing.ts');
  assertEquals([brandName('1'), brandName(''), brandName('Visa'), brandName(' MasterCard ')], ['', '', 'Visa', 'MasterCard']);
  assertEquals(cardSummary({ token: TOKEN, tokef: TOKEF, card_last4: '0772', card_brand: '1' }, '2026-10-25')?.brand, '');
});

Deno.test('reasonFor and tokefExpired', () => {
  assertEquals(reasonFor('4'), 'card_declined');
  assertEquals(reasonFor('6'), 'card_cvv_or_id');
  assertEquals(reasonFor('2'), 'card_blocked');
  assertEquals(reasonFor('901'), 'billing_unavailable');
  assertEquals(reasonFor('322'), 'billing_unavailable');
  assertEquals(reasonFor('349'), 'card_declined');
  assertEquals(reasonFor('999'), 'hyp_unreachable');
  assertEquals(reasonFor('x'), 'hyp_unreachable');
  assertEquals(tokefExpired('2610', '2026-10-20'), false);
  assertEquals(tokefExpired('2609', '2026-10-20'), true);
  assertEquals(tokefExpired('3105', '2026-10-20'), false);
});

// ---------- Card session ----------

Deno.test('without HYP secrets nothing reaches HYP and the page says "not available"', async () => {
  seed();
  clearSecrets();
  const r = await call('createCardSession', { lang: 'he' }, USER_A);
  assertEquals(r.status, 422);
  assertEquals(reason(r), 'billing_unavailable');
  const sub = await call('getMyBilling', {}, USER_A);
  assertEquals(sub.json.card_enabled, false);
  assertEquals(hyp.calls.length, 0);
});

Deno.test('card flow: session, verify, token on the server only, reload, foreign and forged redirects', async (t) => {
  seed();
  setSecrets();

  await t.step('anonymous callers get 401', async () => {
    assertEquals((await call('createCardSession', {})).status, 401);
    assertEquals((await call('confirmCard', { rawQuery: 'a=1' })).status, 401);
    assertEquals((await call('getMyBilling', {})).status, 401);
  });

  let order = '';
  await t.step('createCardSession signs a J5 page (1 ILS authorization) with a one-time Order', async () => {
    const r = await call('createCardSession', { lang: 'he' }, USER_A);
    assertEquals(r.status, 200);
    assert(r.json.url.startsWith('https://pay.hyp.co.il/p/?'));
    assertStringIncludes(r.json.url, 'signature=');
    const sign = hyp.calls.at(-1)!;
    assertEquals([sign.action, sign.What, sign.J5, sign.Amount, sign.Sign, sign.PageLang], ['APISign', 'SIGN', 'True', '1', 'True', 'HEB']);
    assertEquals([sign.Tash, sign.FixTash], ['1', 'True'], 'one payment: never the terminal default of 36');
    assertEquals([sign.ClientName, sign.ClientLName, sign.email], ['דנה', 'כהן', 'a@example.test']);
    order = account('userA')!.session_id;
    assert(/^k[0-9a-f]{31}$/.test(order));
    assertEquals(sign.Order, order);
    assert(!r.json.url.includes(CFG.HYP_KEY) && !r.json.url.includes(CFG.HYP_PASSP), 'credentials leaked into the page URL');
  });

  await t.step('a declined card check saves nothing and makes no HYP call', async () => {
    const before = hyp.calls.length;
    const r = await call('confirmCard', { rawQuery: redirect(order, { id: '900000002', ccode: '4' }) }, USER_A);
    assertEquals(r.status, 422);
    assertEquals(reason(r), 'card_declined');
    assertEquals(hyp.calls.length, before);
    assert(!account('userA')!.token);
  });

  await t.step('a wrong CVV under J5 (CCode 6) shows its own reason and saves nothing', async () => {
    const before = hyp.calls.length;
    const r = await call('confirmCard', { rawQuery: redirect(order, { id: '900000003', ccode: '6' }) }, USER_A);
    assertEquals(reason(r), 'card_cvv_or_id');
    assertEquals(hyp.calls.length, before);
    assert(!account('userA')!.token);
  });

  await t.step('another customer cannot use this redirect', async () => {
    const r = await call('confirmCard', { rawQuery: redirect(order) }, USER_B);
    assertEquals(r.status, 422);
    assertEquals(reason(r), 'session_mismatch');
    assert(!account('userA')!.token);
  });

  await t.step('a forged redirect (wrong Sign) is rejected by VERIFY', async () => {
    const raw = redirect(order, { id: '900000004' }).replace(SIGN, 'Zm9vYmFyYmF6cXV4==');
    const r = await call('confirmCard', { rawQuery: raw }, USER_A);
    assertEquals(reason(r), 'verify_failed');
    assert(!account('userA')!.token);
  });

  await t.step('a redirect with a changed Order is not this session', async () => {
    const r = await call('confirmCard', { rawQuery: redirect(`k${'f'.repeat(31)}`, { id: '900000005' }) }, USER_A);
    assertEquals(reason(r), 'session_mismatch');
  });

  let raw = '';
  await t.step('the real redirect saves the token, and only a safe summary comes back', async () => {
    raw = redirect(order);
    const r = await call('confirmCard', { rawQuery: raw }, USER_A);
    assertEquals(r.status, 200, r.text);
    assertEquals(r.json.card, { last4: '0772', brand: 'Visa', exp: '05/31', expired: false });
    assert(!r.text.includes(TOKEN) && !r.text.includes(TOKEF), 'token or tokef left the server');
    const verify = hyp.calls.find((c) => c.What === 'VERIFY' && c.Id === '900000001')!;
    assertEquals(verify.Sign, SIGN, 'the + in Sign did not survive');
    const acc = account('userA')!;
    assertEquals([acc.token, acc.tokef, acc.card_trans_id, acc.session_id, acc.confirmed_session_id], [TOKEN, TOKEF, '900000001', null, order]);
    assertEquals(acc.card_id_number, '', 'an all-zero ID must not be stored');
  });

  await t.step('reloading the return page answers again without calling HYP', async () => {
    const before = hyp.calls.length;
    const r = await call('confirmCard', { rawQuery: raw }, USER_A);
    assertEquals(r.status, 200);
    assertEquals(r.json.already, true);
    assertEquals(hyp.calls.length, before);
  });

  await t.step('getMyBilling shows the card and price, never the token', async () => {
    const r = await call('getMyBilling', {}, USER_A);
    assertEquals(r.status, 200);
    assertEquals([r.json.card_enabled, r.json.price, r.json.card.last4, r.json.subscription_status], [true, 499, '0772', 'none']);
    assert(!r.text.includes(TOKEN) && !r.text.includes(TOKEF));
  });

  await t.step('an expired session is refused', async () => {
    await call('createCardSession', { lang: 'en' }, USER_A);
    const acc = account('userA')!;
    acc.session_expires_at = new Date(Date.now() - 1000).toISOString();
    const r = await call('confirmCard', { rawQuery: redirect(acc.session_id, { id: '900000006' }) }, USER_A);
    assertEquals(reason(r), 'session_expired');
    assertEquals(account('userA')!.card_trans_id, '900000001', 'the saved card must stay');
  });

  await t.step('no token permission on the terminal (getToken 901) is a clear "not available"', async () => {
    await call('createCardSession', { lang: 'he' }, USER_B);
    hyp.tokenPermission = false;
    const r = await call('confirmCard', { rawQuery: redirect(account('userB')!.session_id, { id: '900000007' }) }, USER_B);
    hyp.tokenPermission = true;
    assertEquals(reason(r), 'billing_unavailable');
    assert(!account('userB')!.token);
  });
});

// ---------- Test charge ----------

Deno.test('adminCharge: admin only, one charge per click, declines recorded', async (t) => {
  seed();
  setSecrets();
  await call('createCardSession', { lang: 'he' }, USER_A);
  await call('confirmCard', { rawQuery: redirect(account('userA')!.session_id) }, USER_A);

  await t.step('a customer cannot charge, an anonymous caller neither', async () => {
    assertEquals((await call('adminCharge', { customer_id: 'userA', action: 'charge', amount: 10 }, USER_A)).status, 403);
    assertEquals((await call('adminCharge', { customer_id: 'userA', action: 'charge', amount: 10 })).status, 401);
    assertEquals(softCalls(), 0);
  });

  await t.step('summary shows the card without the token', async () => {
    const r = await call('adminCharge', { customer_id: 'userA', action: 'summary' }, ADMIN);
    assertEquals([r.json.card_enabled, r.json.card.last4], [true, '0772']);
    assert(!r.text.includes(TOKEN));
  });

  await t.step('bad amounts and a customer without a card are refused before HYP', async () => {
    for (const amount of [0, -5, 5001, 10.123, 'x']) {
      const r = await call('adminCharge', { customer_id: 'userA', action: 'charge', amount }, ADMIN);
      assertEquals(reason(r), 'bad_amount', `amount ${amount}`);
    }
    const r = await call('adminCharge', { customer_id: 'userB', action: 'charge', amount: 10 }, ADMIN);
    assertEquals(reason(r), 'no_card');
    assertEquals(softCalls(), 0);
  });

  await t.step('a charge: Payment written, HYP called once, invoice emailed', async () => {
    const r = await call('adminCharge', { customer_id: 'userA', action: 'charge', amount: 10.5 }, ADMIN);
    assertEquals(r.status, 200, r.text);
    assertEquals([r.json.payment.status, r.json.payment.amount, r.json.payment.ccode, r.json.payment.invoice], ['succeeded', 10.5, '0', 'EZ']);
    const soft = hyp.calls.filter((c) => c.action === 'soft');
    assertEquals(soft.length, 1);
    assertEquals([soft[0].Amount, soft[0].UserId, soft[0].SendHesh, soft[0].email, soft[0].ClientName], ['10.50', '000000000', 'True', 'a@example.test', 'דנה']);
    assertEquals(store.Payment.length, 1);
    assertEquals(store.Payment[0].kind, 'test');
    assertEquals(account('userA')!.charge_lock, null, 'the lock must be released');
  });

  await t.step('two clicks at the same moment charge once', async () => {
    const before = softCalls();
    const [a, b] = await Promise.all([
      call('adminCharge', { customer_id: 'userA', action: 'charge', amount: 10 }, ADMIN),
      call('adminCharge', { customer_id: 'userA', action: 'charge', amount: 10 }, ADMIN),
    ]);
    assertEquals(softCalls() - before, 1);
    assertEquals([a.status, b.status].sort(), [200, 422]);
    assertEquals(reason(a.status === 422 ? a : b), 'charge_in_progress');
  });

  await t.step('a declined charge is recorded as failed with its reason', async () => {
    hyp.softCCode = '4';
    const r = await call('adminCharge', { customer_id: 'userA', action: 'charge', amount: 10 }, ADMIN);
    hyp.softCCode = '0';
    assertEquals(r.status, 422);
    assertEquals(reason(r), 'card_declined');
    const last = store.Payment.at(-1)!;
    assertEquals([last.status, last.ccode, last.error_code], ['failed', '4', 'card_declined']);
  });

  await t.step('the customer sees the payments, newest first', async () => {
    const r = await call('getMyBilling', {}, USER_A);
    assertEquals(r.json.payments.map((p: { status: string }) => p.status), ['failed', 'succeeded', 'succeeded']);
  });
});

Deno.test('chargePayment never charges the same Payment row twice', async () => {
  seed();
  setSecrets();
  const { chargePayment } = await import('../base44/shared/billing.ts');
  // deno-lint-ignore no-explicit-any
  const base44 = (await import('./fake-sdk.ts')).createClientFromRequest(new Request('http://x/')) as any;
  const payment = await base44.asServiceRole.entities.Payment.create({ customer_id: 'userA', amount: 10, status: 'pending' });
  let charges = 0;
  const charge = async () => { charges += 1; await new Promise((r) => setTimeout(r, 5)); return { ccode: '0', transId: '1', acode: '2', invoice: '' }; };
  const [a, b] = await Promise.all([chargePayment(base44, payment, charge), chargePayment(base44, payment, charge)]);
  assertEquals(charges, 1);
  assertEquals([a.ok, b.ok].sort(), [false, true]);
  assertEquals((a.ok ? b : a).reason, 'already_charged');
  const again = await chargePayment(base44, payment, charge);
  assertEquals([again.ok, again.reason, charges], [false, 'already_charged', 1]);
});

// ---------- Cancel and refund ----------

Deno.test('adminRefundPayment: cancel the same day, refund later, never more than the charge, never twice', async (t) => {
  seed();
  setSecrets();
  await call('createCardSession', { lang: 'he' }, USER_A);
  await call('confirmCard', { rawQuery: redirect(account('userA')!.session_id) }, USER_A);

  const charge = async (amount: number) => (await call('adminCharge', { customer_id: 'userA', action: 'charge', amount }, ADMIN)).json.payment;
  // deno-lint-ignore no-explicit-any
  const listed = async (id: string): Promise<any> =>
    // deno-lint-ignore no-explicit-any
    (await call('adminCharge', { customer_id: 'userA', action: 'summary' }, ADMIN)).json.payments.find((p: any) => p.id === id);
  const reverse = (body: object, user: object = ADMIN) => call('adminRefundPayment', { customer_id: 'userA', ...body }, user);
  const row = (id: string) => store.Payment.find((p) => p.id === id)!;
  const moneyBack = () => hyp.calls.filter((c) => c.action === 'CancelTrans' || c.action === 'zikoyAPI');

  const p1 = await charge(10);
  const trans1 = row(p1.id).hyp_trans_id;

  await t.step('an anonymous caller gets 401 and a customer 403, and nothing reaches HYP', async () => {
    assertEquals((await call('adminRefundPayment', { customer_id: 'userA', payment_id: p1.id, action: 'cancel', expected_refunded: 0 })).status, 401);
    assertEquals((await reverse({ payment_id: p1.id, action: 'cancel', expected_refunded: 0 }, USER_A)).status, 403);
    assertEquals((await reverse({ payment_id: p1.id, action: 'refund', amount: 1, expected_refunded: 0 }, USER_A)).status, 403);
    assertEquals(moneyBack().length, 0);
    assertEquals(row(p1.id).status, 'succeeded');
  });

  await t.step('a charge from today is offered as a cancel of the whole amount', async () => {
    const p = await listed(p1.id);
    assertEquals([p.offer, p.refund_left, p.refunded_amount], ['cancel', 10, 0]);
  });

  await t.step('a wrong customer or a missing body field sends nothing', async () => {
    assertEquals(reason(await call('adminRefundPayment', { customer_id: 'userB', payment_id: p1.id, action: 'cancel', expected_refunded: 0 }, ADMIN)), 'payment_not_found');
    assertEquals(reason(await reverse({ payment_id: p1.id, action: 'cancel' })), 'invalid_body');
    assertEquals(reason(await reverse({ payment_id: p1.id, action: 'void', expected_refunded: 0 })), 'invalid_body');
    assertEquals(moneyBack().length, 0);
  });

  await t.step('cancel after HYP transmitted the charge (920): nothing changes, and a refund is offered', async () => {
    hyp.transmitted.add(trans1);
    const r = await reverse({ payment_id: p1.id, action: 'cancel', expected_refunded: 0 });
    assertEquals(r.status, 422);
    assertEquals(reason(r), 'cancel_not_possible');
    assertEquals(moneyBack().map((c) => [c.action, c.TransId]), [['CancelTrans', trans1]]);
    const saved = row(p1.id);
    assertEquals([saved.status, saved.refunded_amount, saved.refunds.at(-1).status, saved.refunds.at(-1).ccode], ['succeeded', undefined, 'declined', '920']);
    const p = await listed(p1.id);
    assertEquals([p.offer, p.refund_left], ['refund', 10]);
  });

  await t.step('a partial refund: HYP gets the charge Id and the amount, the row keeps the refund Id', async () => {
    const r = await reverse({ payment_id: p1.id, action: 'refund', amount: 4, expected_refunded: 0, note: '  הלקוח   ביקש  ' });
    assertEquals(r.status, 200, r.text);
    assertEquals([r.json.payment.status, r.json.payment.refunded_amount], ['partially_refunded', 4]);
    const z = moneyBack().at(-1)!;
    assertEquals([z.action, z.TransId, z.Amount], ['zikoyAPI', trans1, '4.00']);
    assert(!('zPass' in z), 'a refund must not send zPass (that is the payout flow)');
    const saved = row(p1.id);
    const last = saved.refunds.at(-1);
    assertEquals([last.kind, last.status, last.amount, last.by, last.note, last.ccode], ['refund', 'approved', 4, 'admin1', 'הלקוח ביקש', '0']);
    assert(last.trans_id && last.trans_id !== trans1, 'the refund has its own HYP Id');
    assert(saved.refunded_at);
    assertEquals(account('userA')!.charge_lock, null, 'the lock must be released');
    assertEquals((await listed(p1.id)).refund_left, 6);
  });

  await t.step('more than what is left, or a bad amount, is refused before HYP', async () => {
    const before = moneyBack().length;
    assertEquals(reason(await reverse({ payment_id: p1.id, action: 'refund', amount: 6.01, expected_refunded: 4 })), 'refund_too_much');
    for (const amount of [0, -1, 1.234, 'x']) {
      assertEquals(reason(await reverse({ payment_id: p1.id, action: 'refund', amount, expected_refunded: 4 })), 'bad_refund_amount', `amount ${amount}`);
    }
    assertEquals(reason(await reverse({ payment_id: p1.id, action: 'cancel', expected_refunded: 4 })), 'not_refundable', 'a refunded charge cannot be cancelled');
    assertEquals(moneyBack().length, before);
  });

  await t.step('a retried request from the old screen (expected_refunded 0) sends nothing', async () => {
    const before = moneyBack().length;
    const r = await reverse({ payment_id: p1.id, action: 'refund', amount: 4, expected_refunded: 0 });
    assertEquals(reason(r), 'payment_changed');
    assertEquals(moneyBack().length, before);
    assertEquals(row(p1.id).refunded_amount, 4);
  });

  await t.step('two clicks at the same moment refund once', async () => {
    const before = moneyBack().length;
    const [a, b] = await Promise.all([
      reverse({ payment_id: p1.id, action: 'refund', amount: 6, expected_refunded: 4 }),
      reverse({ payment_id: p1.id, action: 'refund', amount: 6, expected_refunded: 4 }),
    ]);
    assertEquals(moneyBack().length - before, 1);
    assertEquals([a.status, b.status].sort(), [200, 422]);
    assert(['charge_in_progress', 'payment_changed'].includes(reason(a.status === 422 ? a : b)!));
    const saved = row(p1.id);
    assertEquals([saved.status, saved.refunded_amount, hyp.refunded.get(trans1)], ['refunded', 10, 1000]);
  });

  await t.step('a fully refunded payment offers nothing more', async () => {
    const p = await listed(p1.id);
    assertEquals([p.status, p.offer, p.refund_left, p.refunded_amount], ['refunded', '', 0, 10]);
    assertEquals(reason(await reverse({ payment_id: p1.id, action: 'refund', amount: 1, expected_refunded: 10 })), 'not_refundable');
  });

  const p2 = await charge(7.5);
  const trans2 = row(p2.id).hyp_trans_id;

  await t.step('cancel the same day: CancelTrans once, the whole amount, then nothing more to do', async () => {
    assertEquals((await listed(p2.id)).offer, 'cancel');
    const before = moneyBack().length;
    const r = await reverse({ payment_id: p2.id, action: 'cancel', expected_refunded: 0, note: 'בדיקה' });
    assertEquals(r.status, 200, r.text);
    assertEquals([r.json.payment.status, r.json.payment.refunded_amount], ['cancelled', 7.5]);
    assertEquals(moneyBack().slice(before).map((c) => [c.action, c.TransId]), [['CancelTrans', trans2]]);
    const saved = row(p2.id);
    assertEquals([saved.refunds.at(-1).kind, saved.refunds.at(-1).status, saved.refunds.at(-1).trans_id], ['cancel', 'approved', trans2]);
    assert(saved.cancelled_at);
    const again = await reverse({ payment_id: p2.id, action: 'cancel', expected_refunded: 0 });
    assertEquals(reason(again), 'payment_changed');
    assertEquals((await listed(p2.id)).offer, '');
    assertEquals(moneyBack().length, before + 1);
  });

  const p3 = await charge(5);
  hyp.transmitted.add(row(p3.id).hyp_trans_id);

  await t.step("HYP's own refusals: 33 (more than the charge) and 901 (no permission) leave the row as it was", async () => {
    hyp.refundCCode = '33';
    assertEquals(reason(await reverse({ payment_id: p3.id, action: 'refund', amount: 5, expected_refunded: 0 })), 'refund_too_much');
    hyp.refundCCode = '901';
    assertEquals(reason(await reverse({ payment_id: p3.id, action: 'refund', amount: 5, expected_refunded: 0 })), 'refund_not_permitted');
    hyp.refundCCode = '';
    const saved = row(p3.id);
    assertEquals([saved.status, saved.refunded_amount], ['succeeded', undefined]);
    assertEquals(saved.refunds.map((r: { status: string; ccode: string }) => [r.status, r.ccode]), [['declined', '33'], ['declined', '901']]);
  });

  await t.step('no answer from HYP: the refund stays unknown and is never sent again by itself', async () => {
    hyp.silent = true;
    const r = await reverse({ payment_id: p3.id, action: 'refund', amount: 2, expected_refunded: 0 });
    hyp.silent = false;
    assertEquals(reason(r), 'refund_unknown');
    assert(!r.text.includes(CFG.HYP_PASSP), 'the PassP leaked');
    const saved = row(p3.id);
    assertEquals([saved.status, saved.refunds.at(-1).status, saved.refunds.at(-1).amount], ['refunding', 'pending', 2]);
    assertEquals(account('userA')!.charge_lock, null, 'the lock must be released');
    const before = moneyBack().length;
    assertEquals(reason(await reverse({ payment_id: p3.id, action: 'refund', amount: 2, expected_refunded: 0 })), 'refund_unknown');
    assertEquals(moneyBack().length, before);
    const p = await listed(p3.id);
    assertEquals([p.status, p.offer, p.refunds.at(-1).status], ['refunding', '', 'pending']);
  });

  const p4 = await charge(3);
  const p5 = await charge(2);

  await t.step('the production answer to a cancel (CCode 0, ReversalStatus 125, 08/11/2026) is a cancel, and 125 is kept', async () => {
    hyp.cancelAnswer = `TransId=${row(p5.id).hyp_trans_id}&CCode=0&ReversalStatus=125`;
    const r = await reverse({ payment_id: p5.id, action: 'cancel', expected_refunded: 0 });
    hyp.cancelAnswer = '';
    assertEquals(r.status, 200, r.text);
    const saved = row(p5.id);
    assertEquals([saved.status, saved.refunded_amount, saved.refunds.at(-1).status, saved.refunds.at(-1).reversal], ['cancelled', 2, 'approved', '125']);
  });

  await t.step('an answer without a CCode is unknown, not cancelled', async () => {
    hyp.cancelAnswer = `TransId=${row(p4.id).hyp_trans_id}&ReversalStatus=777`;
    const r = await reverse({ payment_id: p4.id, action: 'cancel', expected_refunded: 0 });
    hyp.cancelAnswer = '';
    assertEquals(reason(r), 'refund_unknown');
    assertEquals(row(p4.id).status, 'cancelling');
  });

  await t.step('the customer sees each status and what was given back, never the attempts', async () => {
    const r = await call('getMyBilling', {}, USER_A);
    // deno-lint-ignore no-explicit-any
    const mine = (id: string) => r.json.payments.find((p: any) => p.id === id);
    assertEquals([mine(p1.id).status, mine(p1.id).refunded_amount], ['refunded', 10]);
    assertEquals([mine(p2.id).status, mine(p2.id).refunded_amount], ['cancelled', 7.5]);
    assertEquals([mine(p3.id).status, mine(p4.id).status], ['refunding', 'cancelling']);
    assert(!r.text.includes('refunds') && !r.text.includes('refund_claim') && !r.text.includes('admin1'), 'admin details leaked to the customer');
  });
});

Deno.test('reversePayment never sends the same refund twice', async () => {
  seed();
  const { reversePayment } = await import('../base44/shared/billing.ts');
  // deno-lint-ignore no-explicit-any
  const base44 = (await import('./fake-sdk.ts')).createClientFromRequest(new Request('http://x/')) as any;
  const payment = await base44.asServiceRole.entities.Payment.create({ customer_id: 'userA', amount: 10, status: 'succeeded', hyp_trans_id: '1' });
  let sent = 0;
  const send = async () => {
    sent += 1;
    await new Promise((r) => setTimeout(r, 5));
    return { ccode: '0', transId: '2', acode: '3', invoice: '', reversal: '' };
  };
  const ask = { kind: 'refund' as const, agorot: 400, note: '', by: 'admin1' };
  const [a, b] = await Promise.all([reversePayment(base44, payment, ask, send), reversePayment(base44, payment, ask, send)]);
  assertEquals(sent, 1);
  assertEquals([a.ok, b.ok].sort(), [false, true]);
  assertEquals((a.ok ? b : a).reason, 'payment_changed');
  // The same stale read once more (a retry): the row moved on, so nothing is sent.
  const again = await reversePayment(base44, payment, ask, send);
  assertEquals([again.ok, again.reason, sent], [false, 'payment_changed', 1]);
  assertEquals(store.Payment[0].refunded_amount, 4);
});

// ---------- One-time payment page ----------

// The redirect after a one-time payment, raw. HYP may write the Amount without decimals.
function payRedirect(order: string, { id = '900000101', ccode = '0', amount = '449', sign = SIGN } = {}): string {
  hyp.transactions.set(id, { order, ccode, amount });
  return `Id=${id}&CCode=${ccode}&Amount=${amount}&ACode=0000003&Order=${order}&Fild1=Dana%20Cohen&Fild2=a%40example.test&Fild3=&Sign=${sign}&Payments=3&L4digit=0772&Hesh=EZ`;
}

Deno.test('one-time payment: server price, VERIFY, one claim, one fulfillment, anonymous buyers', async (t) => {
  seed();
  setSecrets();
  const buyer = { first_name: 'דנה', last_name: 'כהן', email: 'A@Example.test', phone: '050-1234567', lang: 'he' };
  const row = (order: string) => store.Payment.find((p) => p.order_id === order)!;

  let order = '';
  await t.step('the price comes from the server: an amount in the body is ignored', async () => {
    const r = await call('createPayment', { ...buyer, amount: 1 });
    assertEquals(r.status, 200, r.text);
    order = r.json.order_id;
    assert(/^p[0-9a-f]{31}$/.test(order));
    const sign = hyp.calls.at(-1)!;
    assertEquals([sign.What, sign.Amount, sign.Order, sign.Tash, sign.FixTash, sign.SendHesh, sign.heshDesc], ['SIGN', '449.00', order, '3', 'False', 'True', 'קורס']);
    assertEquals([sign.email, sign.cell, sign.UTF8, sign.UTF8out], ['a@example.test', '0501234567', 'True', 'True']);
    assert(!('J5' in sign), 'a one-time payment is a charge, not a card check');
    const p = row(order);
    assertEquals([p.kind, p.status, p.amount, p.customer_id, p.owner_user_id], ['one_time', 'awaiting_payment', 449, 'guest:a@example.test', 'guest']);
  });

  await t.step('missing buyer details and a coupon the project did not implement are refused before HYP', async () => {
    const before = hyp.calls.length;
    const r = await call('createPayment', { first_name: '', email: 'not-an-email', lang: 'he' });
    assertEquals(r.status, 422);
    assertEquals(r.json.reasons.map((x: { code: string }) => x.code).sort(), ['invalid', 'required', 'required']);
    assertEquals(reason(await call('createPayment', { ...buyer, coupon: 'FREE100' })), 'coupon_invalid');
    assertEquals(hyp.calls.length, before);
  });

  await t.step('a declined try keeps the page open and pays nothing', async () => {
    const r = await call('confirmPayment', { rawQuery: payRedirect(order, { id: '900000102', ccode: '4' }) });
    assertEquals(reason(r), 'card_declined');
    assertEquals([row(order).status, row(order).last_ccode], ['awaiting_payment', '4']);
  });

  await t.step('a forged redirect is rejected by VERIFY and closes nothing', async () => {
    const r = await call('confirmPayment', { rawQuery: payRedirect(order, { id: '900000103' }).replace(SIGN, 'Zm9vYmFyYmF6cXV4==') });
    assertEquals(reason(r), 'verify_failed');
    assertEquals(row(order).status, 'awaiting_payment');
  });

  await t.step('an order we never created is not found, without calling HYP', async () => {
    const before = hyp.calls.length;
    assertEquals(reason(await call('confirmPayment', { rawQuery: payRedirect(`p${'a'.repeat(31)}`, { id: '900000104' }) })), 'payment_not_found');
    assertEquals(reason(await call('confirmPayment', { rawQuery: payRedirect(account('userA')?.session_id || `k${'a'.repeat(31)}`, { id: '900000105' }) })), 'payment_not_found');
    assertEquals(reason(await call('confirmPayment', { rawQuery: payRedirect('', { id: '900000106' }) })), 'missing_return');
    assertEquals(hyp.calls.length, before);
  });

  let raw = '';
  await t.step('two tabs at once: VERIFY with the +, one claim, one fulfillment', async () => {
    raw = payRedirect(order);
    const [a, b] = await Promise.all([call('confirmPayment', { rawQuery: raw }), call('confirmPayment', { rawQuery: raw })]);
    assertEquals([a.status, b.status], [200, 200], a.text + b.text);
    assertEquals([a.json.first, b.json.first].sort(), [false, true]);
    const verify = hyp.calls.find((c) => c.What === 'VERIFY' && c.Id === '900000101')!;
    assertEquals(verify.Sign, SIGN, 'the + in Sign did not survive');
    const p = row(order);
    assertEquals([p.status, p.hyp_trans_id, p.paid_amount, p.installments, p.card_last4, p.error_code], ['succeeded', '900000101', 449, 3, '0772', '']);
    assert(p.fulfilled_at, 'fulfillment ran');
  });

  await t.step('a reload answers again without HYP, and first is false (no second analytics event)', async () => {
    const before = hyp.calls.length;
    const r = await call('confirmPayment', { rawQuery: raw });
    assertEquals([r.status, r.json.first, r.json.payment.status], [200, false, 'succeeded']);
    assertEquals(hyp.calls.length, before);
  });

  await t.step('a different amount than priced keeps the money visible and does not fulfill', async () => {
    const r1 = await call('createPayment', { ...buyer, email: 'b@example.test' });
    const r = await call('confirmPayment', { rawQuery: payRedirect(r1.json.order_id, { id: '900000107', amount: '1' }) });
    assertEquals(reason(r), 'amount_mismatch');
    const p = row(r1.json.order_id);
    assertEquals([p.status, p.paid_amount, p.error_code, p.fulfilled_at ?? null], ['succeeded', 1, 'amount_mismatch', null]);
  });

  await t.step('a signed-in buyer owns the payment and sees it in getMyBilling', async () => {
    const r1 = await call('createPayment', { ...buyer, email: 'a@example.test' }, USER_A);
    assertEquals([row(r1.json.order_id).customer_id, row(r1.json.order_id).owner_user_id], ['userA', 'userA']);
    await call('confirmPayment', { rawQuery: payRedirect(r1.json.order_id, { id: '900000108' }) });
    const mine = await call('getMyBilling', {}, USER_A);
    assertEquals(mine.json.payments.map((p: { kind: string; status: string }) => [p.kind, p.status]), [['one_time', 'succeeded']]);
    assert(!mine.text.includes('buyer_email') && !mine.text.includes('order_id'), 'the summary carries only what the customer needs');
  });

  await t.step('the admin can cancel a one-time payment of a guest (no BillingAccount, the row claim alone)', async () => {
    const p = row(order);
    hyp.charges.set(p.hyp_trans_id, 44900);
    const r = await call('adminRefundPayment', { customer_id: 'guest:a@example.test', payment_id: p.id, action: 'cancel', expected_refunded: 0 }, ADMIN);
    assertEquals(r.status, 200, r.text);
    assertEquals([row(order).status, row(order).refunded_amount], ['cancelled', 449]);
  });

  await t.step('one email cannot hold more than 5 open pages', async () => {
    for (let i = 0; i < 5; i++) await call('createPayment', { ...buyer, email: 'c@example.test' });
    assertEquals(reason(await call('createPayment', { ...buyer, email: 'c@example.test' })), 'too_many_pages');
  });
});

Deno.test('one-time payment: a fulfillment that fails is retried on the next reload, once', async () => {
  seed();
  setSecrets();
  const r1 = await call('createPayment', { first_name: 'Dana', last_name: 'Cohen', email: 'd@example.test', lang: 'en' });
  const sign = hyp.calls.at(-1)!;
  assertEquals([sign.PageLang, sign.ShowEngTashText, sign['EZ.lang']], ['ENG', 'True', 'en']);
  const order = r1.json.order_id;
  const p = () => store.Payment.find((x) => x.order_id === order)!;
  const raw = payRedirect(order, { id: '900000109' });
  // The template's fulfill only logs: count its log lines, and make the first one throw.
  const original = console.log;
  let runs = 0;
  console.log = (...args: unknown[]) => {
    if (args[0] === 'fulfill: nothing to do yet for') {
      runs += 1;
      if (runs === 1) throw new Error('email service down');
    }
  };
  try {
    const first = await call('confirmPayment', { rawQuery: raw });
    assertEquals([first.status, first.json.first], [200, true]);
    assertEquals(p().fulfilled_at ?? null, null, 'the claim was given back');
    const again = await call('confirmPayment', { rawQuery: raw });
    assertEquals([again.status, again.json.first], [200, false]);
    assert(p().fulfilled_at, 'the reload fulfilled it');
    await call('confirmPayment', { rawQuery: raw });
    assertEquals(runs, 2, 'never a third time');
  } finally {
    console.log = original;
  }
});

// ---------- Subscription (daily run) ----------

Deno.test('subscription: trial, first charge once, retries 3 and 7, past_due, expired, new card, cancel', async (t) => {
  seed();
  setSecrets();
  const sub = await import('../base44/functions/runBilling/_shared/subscription.ts');
  const { getBillingSettings } = await import('../base44/functions/runBilling/_shared/billing.ts');
  const { hypConfig } = await import('../base44/functions/runBilling/_shared/hyp.ts');
  // deno-lint-ignore no-explicit-any
  const base44 = (await import('./fake-sdk.ts')).createClientFromRequest(new Request('http://x/')) as any;
  const cfg = hypConfig()!;
  const bill = async (customerId: string, today: string) => sub.billAccount(base44, account(customerId)!.id, today, await getBillingSettings(base44), cfg);
  const periodRows = (customerId: string, start: string) => store.Payment.filter((p) => p.customer_id === customerId && p.period_start === start);

  // Customer A saves a card; customer B never does.
  await call('createCardSession', { lang: 'he' }, USER_A);
  await call('confirmCard', { rawQuery: redirect(account('userA')!.session_id) }, USER_A);
  await base44.asServiceRole.entities.BillingAccount.create({ customer_id: 'userB', owner_user_id: 'userB', failed_attempts: 0 });
  await sub.startTrial(base44, account('userA'), '2026-11-01', 30);
  await sub.startTrial(base44, account('userB'), '2026-11-01', 30);

  await t.step('a trial is not charged before its last day passes', async () => {
    assertEquals([account('userA')!.trial_ends_at, account('userA')!.next_charge_on], ['2026-11-30', '2026-12-01']);
    assertEquals(await bill('userA', '2026-11-30'), 'not_due');
    assertEquals(softCalls(), 0);
  });

  await t.step('a trial without a card: reminders 7 days and 1 day before, once each, then expired', async () => {
    assertEquals(await bill('userB', '2026-11-23'), 'not_due');
    assertEquals(account('userB')!.last_notice, 'trial-7:2026-11-30');
    await bill('userB', '2026-11-23');
    assertEquals(account('userB')!.last_notice, 'trial-7:2026-11-30');
    await bill('userB', '2026-11-29');
    assertEquals(account('userB')!.last_notice, 'trial-1:2026-11-30');
    assertEquals(await bill('userB', '2026-12-01'), 'expired');
    assertEquals([account('userB')!.subscription_status, account('userB')!.next_charge_on], ['expired', null]);
    assertEquals(softCalls(), 0);
  });

  await t.step('the first charge: once, even when the run is repeated or runs twice at once', async () => {
    assertEquals(await bill('userA', '2026-12-01'), 'charged');
    assertEquals(await bill('userA', '2026-12-01'), 'not_due');
    const acc = account('userA')!;
    assertEquals([acc.subscription_status, acc.paid_through, acc.next_charge_on, acc.failed_attempts], ['active', '2026-12-31', '2027-01-01', 0]);
    const [row] = periodRows('userA', '2026-12-01');
    assertEquals([row.kind, row.status, row.amount, row.period_end, row.attempt, row.created_by], ['subscription', 'succeeded', 499, '2026-12-31', 1, 'cron']);
    assertEquals(hyp.calls.filter((c) => c.action === 'soft').map((c) => c.Amount), ['499.00']);
    const results = await Promise.all([bill('userA', '2027-01-01'), bill('userA', '2027-01-01')]);
    assertEquals(results.filter((r) => r === 'charged').length, 1, results.join(','));
    assertEquals(softCalls(), 2);
  });

  await t.step('a declined card: past_due, tries on days 3 and 7, expired after the grace days', async () => {
    hyp.softCCode = '4';
    assertEquals(await bill('userA', '2027-02-01'), 'declined');
    let acc = account('userA')!;
    assertEquals([acc.subscription_status, acc.failed_attempts, acc.due_since, acc.next_charge_on], ['past_due', 1, '2027-02-01', '2027-02-04']);
    assertEquals(await bill('userA', '2027-02-02'), 'not_due');
    assertEquals(await bill('userA', '2027-02-04'), 'declined');
    assertEquals(account('userA')!.next_charge_on, '2027-02-08');
    assertEquals(await bill('userA', '2027-02-08'), 'expired');
    acc = account('userA')!;
    assertEquals([acc.subscription_status, acc.next_charge_on, acc.paid_through], ['expired', null, '2027-01-31']);
    assertEquals(periodRows('userA', '2027-02-01').map((r) => [r.attempt, r.status]), [[1, 'failed'], [2, 'failed'], [3, 'failed']]);
    hyp.softCCode = '0';
  });

  await t.step('a new card on an expired account is charged at once, for a period that starts today', async () => {
    const today = (await import('../base44/functions/runBilling/_shared/common.ts')).israelToday();
    await call('createCardSession', { lang: 'he' }, USER_A);
    const r = await call('confirmCard', { rawQuery: redirect(account('userA')!.session_id, { id: '900000008' }) }, USER_A);
    assertEquals([r.status, r.json.charge], [200, 'charged'], r.text);
    const acc = account('userA')!;
    assertEquals([acc.subscription_status, periodRows('userA', today).length], ['active', 1]);
    assert(acc.paid_through > today);
  });

  await t.step('no answer from HYP leaves the row processing, and the next run charges nothing', async () => {
    const due = account('userA')!.next_charge_on;
    hyp.silent = true;
    assertEquals(await bill('userA', due), 'unknown');
    hyp.silent = false;
    const before = softCalls();
    assertEquals(await bill('userA', due), 'unknown');
    assertEquals(softCalls(), before);
    assertEquals(periodRows('userA', due).map((r) => r.status), ['processing']);
    assertEquals(account('userA')!.charge_lock, null, 'the lock must be released');
  });

  await t.step('a run that died after the charge only moves the dates', async () => {
    const due = account('userA')!.next_charge_on;
    periodRows('userA', due)[0].status = 'succeeded';
    const before = softCalls();
    assertEquals(await bill('userA', due), 'charged');
    assertEquals(softCalls(), before);
    assert(account('userA')!.next_charge_on > due);
  });

  await t.step('cancel at the end of the paid period: no more charges', async () => {
    await sub.cancelAtPeriodEnd(base44, account('userA'), true);
    const before = softCalls();
    assertEquals(await bill('userA', account('userA')!.next_charge_on), 'cancelled');
    assertEquals([account('userA')!.subscription_status, softCalls()], ['cancelled', before]);
  });

  await t.step('an admin trial extension moves the first charge', async () => {
    await sub.startTrial(base44, account('userB'), '2026-11-01', 30);
    await sub.extendTrial(base44, account('userB'), '2027-02-28');
    assertEquals([account('userB')!.next_charge_on, account('userB')!.next_period_start], ['2027-03-01', '2027-03-01']);
    assertEquals(await bill('userB', '2026-12-01'), 'not_due');
  });
});

Deno.test('runBilling reads nothing from the body, and a second run the same day charges nothing', async () => {
  seed();
  setSecrets();
  const { israelToday, addDays } = await import('../base44/functions/runBilling/_shared/common.ts');
  const today = israelToday();
  await call('createCardSession', { lang: 'he' }, USER_A);
  await call('confirmCard', { rawQuery: redirect(account('userA')!.session_id) }, USER_A);
  Object.assign(account('userA')!, { subscription_status: 'trial', trial_ends_at: addDays(today, -1), next_period_start: today, next_charge_on: today });
  const first = await call('runBilling', { today: '2030-01-01', customer_id: 'userB', amount: 1 });
  assertEquals([first.status, first.json.today, first.json.counts.charged], [200, today, 1]);
  const second = await call('runBilling', {});
  assertEquals(second.json.counts.not_due, 1);
  assertEquals(hyp.calls.filter((c) => c.action === 'soft').map((c) => c.Amount), ['499.00']);
});

// ---------- Two hosts ----------

Deno.test('a host that is down: SIGN, VERIFY and getToken use the second host; a charge is never sent twice', async () => {
  seed();
  setSecrets();
  hyp.downHost = 'https://pay.hyp.co.il/p/';
  const r = await call('createCardSession', { lang: 'he' }, USER_A);
  assertEquals(r.status, 200, r.text);
  assert(r.json.url.startsWith('https://icom.yaad.net/p/?'), 'the page URL comes from the host that signed it');
  const saved = await call('confirmCard', { rawQuery: redirect(account('userA')!.session_id) }, USER_A);
  assertEquals(saved.status, 200, saved.text);
  const before = hyp.calls.length;
  const charge = await call('adminCharge', { customer_id: 'userA', action: 'charge', amount: 5 }, ADMIN);
  assertEquals(reason(charge), 'charge_unknown');
  const sent = hyp.calls.slice(before).filter((c) => c.action === 'soft');
  assertEquals(sent.map((c) => c._host), ['https://pay.hyp.co.il/p/'], 'a money call goes to one host, once');
  assertEquals(store.Payment.at(-1)!.status, 'processing');
});
