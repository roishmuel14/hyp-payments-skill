import { base44 } from '@/api/base44Client';

// Billing helpers for the screens: calling the functions, reading their 422 reasons, money and days.
// The texts live in billing-i18n.js; every component takes the project's `t` and `language`.

// Function calls resolve to the axios-style response with the body on `.data`.
export async function invokeFunction(name, payload) {
  const result = await base44.functions.invoke(name, payload);
  return result?.data ?? result;
}

// The SDK puts the response body on `.data`; older or raw paths use `.body` or `.response.data`.
function parseBody(err) {
  try {
    const body = err?.data ?? err?.body ?? err?.response?.data;
    return typeof body === 'string' ? JSON.parse(body) : body || null;
  } catch {
    return null;
  }
}

// The reason codes of a function's 422 answer, for a screen that reacts to one of them.
export function reasonCodes(err) {
  const reasons = parseBody(err)?.reasons;
  return Array.isArray(reasons) ? reasons.map((r) => r?.code).filter(Boolean) : [];
}

// Any thrown error as messages in the current language: each reason code is translated through
// `err_<code>`; the server's Hebrew `message` is never shown as is.
export function errorMessages(err, t) {
  const messages = reasonCodes(err)
    .map((code) => {
      const text = t(`err_${code}`);
      return text === `err_${code}` ? null : text;
    })
    .filter(Boolean);
  return messages.length ? [...new Set(messages)] : [t('err_generic')];
}

// Money in shekels, in the page language (499 ₪ / ₪499).
export function formatMoney(amount, language) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return '';
  return new Intl.NumberFormat(language === 'en' ? 'en-IL' : 'he-IL', {
    style: 'currency',
    currency: 'ILS',
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

// The Israel day of a timestamp as DD/MM/YYYY. Platform timestamps come back in UTC without a
// trailing Z, so one is added before parsing.
export function timestampDay(ts) {
  if (!ts) return '';
  const date = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(ts) ? ts : `${ts}Z`);
  if (Number.isNaN(date.getTime())) return '';
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  return formatDay(day);
}

// YYYY-MM-DD as DD/MM/YYYY.
export function formatDay(day) {
  const [y, m, d] = String(day || '').split('-');
  return y && m && d ? `${d}/${m}/${y}` : '';
}

// When a payment happened: HYP's answer time, or the row's creation for one never sent.
export function paymentDay(p) {
  return timestampDay(p?.charged_at || p?.created_date);
}

// HYP's parameters exactly as they reached the browser, kept in sessionStorage so a detour through
// the login page, or a reload, still has them, and taken out of the address bar. Never rebuilt with
// URLSearchParams: it turns the '+' in HYP's Sign into a space and the server's VERIFY then fails.
const RETURN_KEY = 'hyp_return';
export function takeReturnQuery() {
  const fromUrl = window.location.search.replace(/^\?/, '');
  try {
    if (fromUrl) {
      sessionStorage.setItem(RETURN_KEY, fromUrl);
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
    return fromUrl || sessionStorage.getItem(RETURN_KEY) || '';
  } catch {
    return fromUrl;
  }
}

// The Order in the return query, read only to pick the flow: 'k' = a card session (confirmCard),
// 'p' = a payment page (confirmPayment). The server checks everything again.
export function returnKind(raw) {
  const pair = String(raw || '').split('&').find((p) => p.startsWith('Order='));
  const order = pair ? pair.slice(6) : '';
  if (/^k[0-9a-f]{31}$/.test(order)) return 'card';
  if (/^p[0-9a-f]{31}$/.test(order)) return 'payment';
  return '';
}
