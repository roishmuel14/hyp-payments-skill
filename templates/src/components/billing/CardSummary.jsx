import React from 'react';
import { formatMoney, paymentDay } from '@/lib/billing';

// A saved card as the server describes it: last 4 digits, brand and expiry. Never more.
export function CardLine({ card, t, className = '' }) {
  if (!card) return null;
  return (
    <p className={className}>
      <span dir="ltr" className="font-medium tabular-nums">•••• {card.last4}</span>
      {card.brand && <> · {card.brand}</>}
      {' · '}{t('card_exp')} <span dir="ltr" className="font-medium tabular-nums">{card.exp}</span>
    </p>
  );
}

// Payments, newest first: what it was and when on one side, the amount and its status on the other,
// so a row fits a phone without wrapping. A cancelled or fully refunded amount is struck through.
// `showCode` is the admin's view: HYP's code on a failed row, a cancel or refund HYP never answered
// (unknown: check the portal), and the last declined one. `renderActions` adds the admin's buttons.
export function PaymentList({ payments, t, language, showCode = false, renderActions, className = '' }) {
  if (!payments?.length) return null;
  return (
    <ul className={`divide-y divide-border ${className}`}>
      {payments.map((p) => {
        const inFlight = p.status === 'cancelling' || p.status === 'refunding';
        const last = showCode ? p.refunds?.at(-1) : null;
        const gone = p.status === 'cancelled' || p.status === 'refunded';
        let status = t(`pay_status_${p.status}`);
        if (p.status === 'partially_refunded') status += `: ${formatMoney(p.refunded_amount, language)}`;
        if (showCode && p.status === 'failed' && p.ccode) status += ` (${p.ccode})`;
        if (showCode && inFlight) status = t('admin_pay_unknown');
        const actions = renderActions?.(p);
        return (
          <li key={p.id} className="py-3">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p>{p.description || t(`pay_kind_${p.kind}`)}</p>
                <p className="text-sm text-muted-foreground tabular-nums">{paymentDay(p)}</p>
              </div>
              <div className="shrink-0 text-end">
                <p className={`tabular-nums ${gone ? 'line-through text-muted-foreground' : ''}`}>{formatMoney(p.amount, language)}</p>
                <p className={`text-sm ${p.status === 'failed' || (showCode && inFlight) ? 'text-destructive' : 'text-muted-foreground'}`}>{status}</p>
              </div>
            </div>
            {showCode && inFlight && last?.status === 'pending' && (
              <p className="mt-2 text-sm leading-snug text-destructive">
                {t(`admin_pay_unknown_${last.kind}`)} {formatMoney(last.amount, language)}. {t('admin_pay_unknown_check')}
              </p>
            )}
            {last?.status === 'declined' && (
              <p className="mt-2 text-sm leading-snug text-muted-foreground">
                {t(`admin_pay_declined_${last.kind}`)}{last.ccode ? ` (${t('admin_pay_code')} ${last.ccode})` : ''}
              </p>
            )}
            {actions && <div className="mt-1 flex justify-end">{actions}</div>}
          </li>
        );
      })}
    </ul>
  );
}
