// The HYP Pay protocol (https://developers.hyp.co.il/pay): signing a payment page, VERIFY of the
// redirect, getToken, charging a token (action=soft), cancelling and refunding a charge
// (CancelTrans, zikoyAPI), stopping a HYP-managed recurring agreement (HKStatus) and a signed
// invoice link (PrintHesh). No entities here: billing.ts keeps the records. No imports either, so
// every function folder can carry its own copy (see scripts/sync-shared.mjs).
//
// Every call is a GET to HYP_URL that answers with a URL-encoded string and HTTP 200, even on an
// error: success is read only from CCode. An HTML answer means a system error on HYP's side.
// Never log what HYP returns in full (getToken's answer carries the card token), and never log a
// URL that was sent to HYP (it carries PassP and KEY).
//
// Generalized from live integrations on production terminals (2026): a subscription app, where the
// card check, VERIFY, getToken, a token charge and a cancel ran, and a small-payments app, where a
// refund ran. Marked [DOC-ONLY] below: what no integration has run against the real HYP yet.

// HYP answers on two hosts. One was down on 19/08/2026 and a live site stopped taking payments, so
// calls that move no money (SIGN, VERIFY, getToken, PrintHesh) try the second host when the first
// cannot be reached. A call that moves money is sent ONCE: if the first host charged and its answer
// was lost, a retry on the second host would charge again.
export const HYP_URL = 'https://pay.hyp.co.il/p/';
export const HYP_HOSTS = [HYP_URL, 'https://icom.yaad.net/p/'];

// The card check is a J5 authorization of 1 ILS that is never captured: the card company checks
// the card for real (CVV, credit, ID where the issuer supports it) and holds 1 ILS for about 5 days,
// then lets it go. Nothing is charged. J5=J2 only receives the details: a wrong CVV passed it with
// status 600 on a production terminal (10/2026), so it is never used to check a card.
export const CARD_CHECK_AMOUNT = '1';

// Redirect CCodes that let a card be saved: 700 is the J5 authorization (the expected answer).
// 600 (details received without a check) and 0 (an approved charge) are accepted too but logged
// as warnings by confirmCard: a 0 means 1 ILS was really charged and must be cancelled.
export const CARD_CHECK_OK = ['700', '600', '0'];

export type HypConfig = { masof: string; passp: string; key: string };
export type Pairs = [string, string][];

export class HypError extends Error {
  // `reason` is one of our 422 reason codes (translated in the frontend's i18n).
  constructor(public reason: string, public ccode = '', message = '') {
    super(message || `HYP ${reason}${ccode ? ` (CCode=${ccode})` : ''}`);
  }
}

// The terminal's credentials, from `base44 secrets` (HYP_MASOF, HYP_PASSP, HYP_KEY). Null until
// they are set, so callers can answer "not available yet" instead of failing at HYP.
export function hypConfig(): HypConfig | null {
  const masof = Deno.env.get('HYP_MASOF')?.trim();
  const passp = Deno.env.get('HYP_PASSP')?.trim();
  const key = Deno.env.get('HYP_KEY')?.trim();
  if (!masof || !passp || !key) return null;
  return { masof, passp, key };
}

// Parses a query string without turning '+' into a space. HYP's Sign can be base64, which has
// '+'; URLSearchParams would read it as a space, the signature would change, and VERIFY would
// reject a real payment (this lost real payments on a live site in 08/2026, and a second live
// checkout was fixed for it in 10/2026). decodeURIComponent leaves '+' alone. Order and duplicates
// are kept: VERIFY needs both.
export function parseQuery(raw: string): Pairs {
  const out: Pairs = [];
  for (const pair of String(raw || '').replace(/^\?/, '').split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    const k = i === -1 ? pair : pair.slice(0, i);
    const v = i === -1 ? '' : pair.slice(i + 1);
    try {
      out.push([decodeURIComponent(k), decodeURIComponent(v)]);
    } catch (_) {
      // Not UTF-8 (HYP answers in windows-1255 without UTF8out=True): keep it as it came.
      out.push([k, v]);
    }
  }
  return out;
}

export function pick(pairs: Pairs, key: string): string {
  return pairs.find(([k]) => k === key)?.[1] ?? '';
}

// `moneyFree`: the call moves no money, so it may go to the second host when the first fails.
async function call(params: Pairs, moneyFree = false): Promise<{ raw: string; pairs: Pairs; host: string }> {
  const query = new URLSearchParams(params).toString();
  let last: HypError | null = null;
  for (const host of moneyFree ? HYP_HOSTS : [HYP_URL]) {
    try {
      return await callHost(host, query);
    } catch (error) {
      last = error as HypError;
    }
  }
  throw last ?? new HypError('hyp_unreachable');
}

async function callHost(host: string, query: string): Promise<{ raw: string; pairs: Pairs; host: string }> {
  let res: Response;
  try {
    res = await fetch(`${host}?${query}`, { method: 'GET', signal: AbortSignal.timeout(25_000) });
  } catch (error) {
    // A network error's message can quote the URL, and the URL carries PassP and KEY: drop the query.
    const detail = String((error as Error)?.message || error).replace(/\?\S*/g, '?[query hidden]');
    throw new HypError('hyp_unreachable', '', `HYP request failed: ${detail}`);
  }
  const raw = (await res.text()).trim();
  if (!res.ok || raw.startsWith('<') || /<html/i.test(raw)) {
    throw new HypError('hyp_unreachable', '', `HYP answered HTTP ${res.status} with ${raw.startsWith('<') ? 'HTML' : 'text'}`);
  }
  return { raw, pairs: parseQuery(raw), host };
}

// ---------- Status codes ----------

// HYP's table: https://developers.hyp.co.il/pay/reference/response-status-codes
// Maps a non-zero CCode to the reason the customer or the admin sees.
export function reasonFor(ccode: string): string {
  const code = Number(ccode);
  if (!Number.isInteger(code)) return 'hyp_unreachable';
  if ([1, 2, 5].includes(code)) return 'card_blocked';
  if (code === 3) return 'card_call_issuer';
  if (code === 6 || code === 26) return 'card_cvv_or_id';
  if ([15, 416, 429, 447, 997].includes(code)) return 'card_invalid';
  if (code === 9 || code === 999) return 'hyp_unreachable';
  if (code === 998) return 'card_check_cancelled';
  // Terminal and protocol errors (no permission, wrong PassP, missing parameter...): nothing the
  // customer can fix. Logged with the code so the admin can follow up with HYP.
  // 300-322: the acquirer did not give the terminal a permission (for example 322, no J5).
  if (code === 200 || code === 250 || code === 400 || code === 402 || (code >= 300 && code <= 322) || code >= 900) return 'billing_unavailable';
  return 'card_declined';
}

// ---------- Payment page ----------

export type PageInput = {
  // Our one-time id for this page: the redirect brings it back as Order.
  order: string;
  // ILS including VAT: the amount the card is charged. Ignored for a card check (always 1 ILS).
  amount?: number;
  // A line for HYP's transaction list (Info). Customers see it in the HYP portal's reports, not on the page.
  info: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  // A 9-digit Israeli ID when it is already known. Without it, the page asks for one if the terminal requires it.
  idNumber?: string;
  lang: 'he' | 'en';
  // J5 card check of CARD_CHECK_AMOUNT, never captured (subscriptions with merchant-managed tokens).
  cardCheck?: boolean;
  // Up to `max` regular installments (no interest); `fixed` forces exactly `max`. The terminal must be
  // approved for installments. Without it the page is one payment: Tash=1 and FixTash=True are sent,
  // because a page that sends no Tash offers the terminal's default (36 installments, seen live).
  installments?: { max: number; fixed?: boolean };
  // HYP Invoice (EZcount): email the document to `email`; `description` is printed on it. [DOC-ONLY for EZ.lang]
  invoice?: { description: string; lang?: 'he' | 'en' };
  // HYP-managed recurring charges of `amount` every `months` months; `charges` 999 = until stopped. [DOC-ONLY]
  recurring?: { months: number; charges?: number };
};

// Signs a payment page and returns its URL. HYP sends the customer back to the return address set on
// the terminal (Settings, "דף תשלום ו-API", "הפנייה לאחר עסקה"), never to a per-request URL (a
// per-request successUrl was ignored live in 10/2026), with Order = input.order. UTF8 and UTF8out
// keep Hebrew names and the redirect in UTF-8.
export async function signPage(cfg: HypConfig, input: PageInput): Promise<string> {
  if (input.installments && input.recurring) throw new Error('installments and recurring both use Tash: pick one');
  const amount = input.cardCheck ? CARD_CHECK_AMOUNT : Number(input.amount).toFixed(2);
  if (!input.cardCheck && !(Number(input.amount) > 0)) throw new Error('signPage: amount must be positive');
  const params: Pairs = [
    ['action', 'APISign'],
    ['What', 'SIGN'],
    ['Masof', cfg.masof],
    ['KEY', cfg.key],
    ['PassP', cfg.passp],
    ['Sign', 'True'],
    ['Amount', amount],
    ['MoreData', 'True'],
    ['Coin', '1'],
    ['Order', input.order],
    ['Info', input.info],
    ['ClientName', input.firstName || ''],
    ['ClientLName', input.lastName || ''],
    ['email', input.email || ''],
    ['sendemail', 'False'],
    ['PageLang', input.lang === 'en' ? 'ENG' : 'HEB'],
    ['UTF8', 'True'],
    ['UTF8out', 'True'],
  ];
  if (input.phone) params.push(['cell', input.phone]);
  if (/^\d{9}$/.test(input.idNumber || '') && input.idNumber !== '000000000') params.push(['UserId', input.idNumber!]);
  if (input.cardCheck) params.push(['J5', 'True']);
  if (input.installments && input.installments.max > 1) {
    params.push(['Tash', String(Math.floor(input.installments.max))], ['FixTash', input.installments.fixed ? 'True' : 'False'], ['tashType', '1']);
    if (input.lang === 'en') params.push(['ShowEngTashText', 'True']);
  } else if (!input.recurring) {
    params.push(['Tash', '1'], ['FixTash', 'True']);
  }
  if (input.recurring) {
    params.push(['HK', 'True'], ['freq', String(input.recurring.months)], ['Tash', String(input.recurring.charges ?? 999)], ['OnlyOnApprove', 'True']);
  }
  if (input.invoice && input.email) {
    params.push(['SendHesh', 'True'], ['heshDesc', input.invoice.description]);
    if (input.invoice.lang === 'en') params.push(['EZ.lang', 'en']);
  }
  const { raw, pairs, host } = await call(params, true);
  if (!pick(pairs, 'signature')) {
    const ccode = pick(pairs, 'CCode');
    throw new HypError(ccode ? reasonFor(ccode) : 'billing_unavailable', ccode, `APISign SIGN failed (CCode=${ccode || 'none'})`);
  }
  // The answer is appended to the URL of the host that signed it, as is, in HYP's order.
  return `${host}?${raw}`;
}

// ---------- Verify the redirect ----------

const RESERVED = ['action', 'What', 'KEY', 'PassP', 'Masof'];

// Asks HYP whether the redirect parameters are authentic (they carry HYP's Sign). Every parameter
// goes back in its original order, none filtered out. Returns HYP's CCode ('0' = authentic).
export async function verifyRedirect(cfg: HypConfig, redirect: Pairs): Promise<string> {
  const params: Pairs = [
    ['action', 'APISign'],
    ['What', 'VERIFY'],
    ['Masof', cfg.masof],
    ['KEY', cfg.key],
    ['PassP', cfg.passp],
    ...redirect.filter(([k]) => !RESERVED.includes(k)),
  ];
  const { pairs } = await call(params, true);
  return pick(pairs, 'CCode');
}

// ---------- Token ----------

// The token of a transaction. allowFalse=True also lets a check that is not an approved charge
// (J5 authorization 700, or J2 600) return a token. 901 here means the terminal has no token
// permission (HYP support turns it on).
export async function getToken(cfg: HypConfig, transId: string): Promise<{ token: string; tokef: string }> {
  const { pairs } = await call([
    ['action', 'getToken'],
    ['Masof', cfg.masof],
    ['PassP', cfg.passp],
    ['TransId', transId],
    ['allowFalse', 'True'],
  ], true);
  const ccode = pick(pairs, 'CCode');
  const token = pick(pairs, 'Token');
  const tokef = pick(pairs, 'Tokef');
  if (ccode !== '0' || !/^\d{19}$/.test(token) || !/^\d{4}$/.test(tokef)) {
    throw new HypError(ccode && ccode !== '0' ? reasonFor(ccode) : 'billing_unavailable', ccode, `getToken failed (CCode=${ccode || 'none'})`);
  }
  return { token, tokef };
}

// Tokef is YYMM. A card is good through the last day of its expiry month.
export function tokefParts(tokef: string): { month: string; year: string } {
  return { year: tokef.slice(0, 2), month: tokef.slice(2, 4) };
}

export function tokefExpired(tokef: string, today: string): boolean {
  if (!/^\d{4}$/.test(tokef)) return true;
  const { year, month } = tokefParts(tokef);
  return `20${year}-${month}` < today.slice(0, 7);
}

// ---------- Charge a token ----------

export type ChargeInput = {
  token: string;
  tokef: string;
  idNumber?: string;
  amount: number;
  firstName: string;
  lastName: string;
  email: string;
  info: string;
  // The line on the invoice that HYP issues and emails (SendHesh). Empty = no invoice email.
  invoiceDescription?: string;
  // Two-terminal setups only: the terminal that created the token, when another terminal charges it.
  tOwner?: string;
};

export type ChargeResult = { ccode: string; transId: string; acode: string; invoice: string };

// One server-to-server charge. The caller must have claimed the Payment row first
// (billing.ts, chargePayment): this function charges every time it is called.
// The terminal must not require CVV for token charges, or every charge answers CCode 6 (seen on a
// production terminal in 10/2026, until HYP removed the requirement about two weeks later).
export async function chargeToken(cfg: HypConfig, input: ChargeInput): Promise<ChargeResult> {
  const { month, year } = tokefParts(input.tokef);
  const params: Pairs = [
    ['action', 'soft'],
    ['Masof', cfg.masof],
    ['PassP', cfg.passp],
    ['Amount', input.amount.toFixed(2)],
    ['CC', input.token],
    ['Tmonth', month],
    ['Tyear', year],
    ['Token', 'True'],
    ['UserId', /^\d{9}$/.test(input.idNumber || '') ? input.idNumber! : '000000000'],
    ['ClientName', input.firstName || input.lastName || 'Customer'],
    ['ClientLName', input.lastName],
    ['email', input.email],
    ['Info', input.info],
    ['Coin', '1'],
    ['sendemail', 'False'],
    ['UTF8', 'True'],
    ['UTF8out', 'True'],
  ];
  if (input.tOwner) params.push(['tOwner', input.tOwner]);
  if (input.invoiceDescription && input.email) {
    params.push(['SendHesh', 'True'], ['heshDesc', input.invoiceDescription]);
  }
  const { pairs } = await call(params);
  return {
    ccode: pick(pairs, 'CCode'),
    transId: pick(pairs, 'Id'),
    acode: pick(pairs, 'ACode'),
    invoice: pick(pairs, 'Hesh'),
  };
}

// ---------- Cancel and refund a charge ----------
// https://developers.hyp.co.il/pay/common-use-cases/cancellations and .../refunds. Both take the
// charge's Id (Payment.hyp_trans_id) and need only PassP: zPass is for payouts (a credit that is
// not linked to a charge), which these templates never send.

export type ReverseResult = { ccode: string; transId: string; acode: string; invoice: string; reversal: string };

// Cancels a whole charge before HYP transmits it to the card company (the same business day,
// until about 22:00 Israel time): the charge disappears and the card company takes no fee.
// Cancelled = CCode 0. ReversalStatus is not a condition: the docs show 777, a production
// terminal answered 125 to a cancel the portal shows as done (11/2026). 920 = already
// transmitted (or no such charge): refund it instead. The caller must have claimed the Payment row
// first (billing.ts, reversePayment).
export async function cancelTrans(cfg: HypConfig, transId: string): Promise<ReverseResult> {
  const { pairs } = await call([
    ['action', 'CancelTrans'],
    ['Masof', cfg.masof],
    ['PassP', cfg.passp],
    ['TransId', transId],
  ]);
  return { ccode: pick(pairs, 'CCode'), transId: pick(pairs, 'TransId'), acode: '', invoice: pick(pairs, 'Hesh'), reversal: pick(pairs, 'ReversalStatus') };
}

// Refunds all or part of a charge: a new credit transaction on the same card, linked to the charge,
// so HYP itself refuses more than the charge (CCode 33). Answers with the refund's own Id. The docs
// say the charge must already be transmitted, yet a full refund of a charge from the same morning
// passed live (10/2026); a cancel is still the better choice that day (no fee). The
// caller must have claimed the Payment row first: this function refunds every time it is called.
export async function refundTrans(cfg: HypConfig, transId: string, amount: number): Promise<ReverseResult> {
  const { pairs } = await call([
    ['action', 'zikoyAPI'],
    ['Masof', cfg.masof],
    ['PassP', cfg.passp],
    ['TransId', transId],
    ['Amount', amount.toFixed(2)],
  ]);
  return { ccode: pick(pairs, 'CCode'), transId: pick(pairs, 'Id'), acode: pick(pairs, 'ACode'), invoice: pick(pairs, 'HeshASM'), reversal: '' };
}

// Maps a non-zero CCode of a cancel or refund to the reason the admin sees.
export function reverseReasonFor(ccode: string): string {
  const code = Number(ccode);
  if (!Number.isInteger(code)) return 'hyp_unreachable';
  if (code === 33) return 'refund_too_much';
  if (code === 920) return 'cancel_not_possible';
  if (code === 250) return 'refund_not_found';
  // 901: the terminal may not use this action (HYP support turns it on); 902: wrong PassP.
  if (code === 901 || code === 902) return 'refund_not_permitted';
  return 'refund_declined';
}

// ---------- HYP-managed recurring (HK) ----------

// Stops (newStat 1) or resumes (2) a recurring agreement made by a page signed with `recurring`.
// The agreement id is HKId in that page's redirect. 906 = no such agreement. [DOC-ONLY]
export async function hkStatus(cfg: HypConfig, hkId: string, newStat: 1 | 2): Promise<string> {
  const { pairs } = await call([
    ['action', 'HKStatus'],
    ['Masof', cfg.masof],
    ['PassP', cfg.passp],
    ['HKId', hkId],
    ['NewStat', String(newStat)],
  ]);
  return pick(pairs, 'CCode');
}

// ---------- Invoice link ----------

// A signed link that downloads the PDF of the invoice HYP Invoice issued for a transaction. Build it
// on the server and hand the link (not the credentials) to the browser. [DOC-ONLY]
export async function invoiceLink(cfg: HypConfig, transId: string): Promise<string> {
  const { raw, pairs, host } = await call([
    ['action', 'APISign'],
    ['What', 'SIGN'],
    ['Masof', cfg.masof],
    ['KEY', cfg.key],
    ['PassP', cfg.passp],
    ['TransId', transId],
    ['type', 'EZCOUNT'],
    ['ACTION', 'PrintHesh'],
  ], true);
  if (!pick(pairs, 'signature')) {
    const ccode = pick(pairs, 'CCode');
    throw new HypError('billing_unavailable', ccode, `PrintHesh SIGN failed (CCode=${ccode || 'none'})`);
  }
  return `${host}?${raw}`;
}
