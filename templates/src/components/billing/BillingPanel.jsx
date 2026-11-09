import React, { useCallback, useEffect, useState } from 'react';
import { CreditCard, Loader2, Undo2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { errorMessages, formatMoney, invokeFunction, reasonCodes } from '@/lib/billing';
import { CardLine, PaymentList } from '@/components/billing/CardSummary';
import RefundDialog from '@/components/billing/RefundDialog';

const MAX_AMOUNT = 5000;

// The admin's billing box for one customer: the saved card, the payments, a test charge of the card,
// and money back on a payment: a cancel on the day of the charge, a refund (all or part) after it.
// Everything comes from adminCharge and adminRefundPayment: the browser never reads BillingAccount
// (the token stays on the server). Every money action asks first, with the amount: on a production
// terminal it is real money, and only the person who may move money presses it.
// Props: customerId, t, language.
export default function BillingPanel({ customerId, t, language }) {
  const [data, setData] = useState(null);
  const [amount, setAmount] = useState('1');
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [notice, setNotice] = useState(null);
  // The open cancel or refund question: { mode: 'cancel' | 'refund', payment, notice? }.
  const [reverse, setReverse] = useState(null);
  const [reversing, setReversing] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await invokeFunction('adminCharge', { customer_id: customerId, action: 'summary' }));
    } catch (e) {
      console.error(e);
      setData({ failed: true });
    }
  }, [customerId]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  const value = Number(amount);
  const amountOk = Number.isFinite(value) && value >= 1 && value <= MAX_AMOUNT;

  const charge = async () => {
    setBusy(true);
    try {
      await invokeFunction('adminCharge', { customer_id: customerId, action: 'charge', amount: value });
      setNotice({ ok: true, text: t('admin_test_charged') });
    } catch (e) {
      setNotice({ ok: false, text: errorMessages(e, t).join(' ') });
    } finally {
      setBusy(false);
      setConfirmOpen(false);
      load();
    }
  };

  // The payment goes with the refunded amount this screen showed: if it changed since, the server
  // sends nothing (a double click or a stale screen never gives money back twice).
  const runReverse = async ({ amount: refundAmount, note }) => {
    const { mode, payment } = reverse;
    setReversing(true);
    try {
      await invokeFunction('adminRefundPayment', {
        customer_id: customerId,
        payment_id: payment.id,
        action: mode,
        ...(mode === 'refund' ? { amount: refundAmount } : {}),
        expected_refunded: payment.refunded_amount || 0,
        note,
      });
      setNotice({ ok: true, text: t(mode === 'cancel' ? 'admin_cancelled' : 'admin_refunded') });
      setReverse(null);
    } catch (e) {
      if (mode === 'cancel' && reasonCodes(e).includes('cancel_not_possible')) {
        // HYP already transmitted the charge: offer a refund of the whole amount right away.
        setReverse({ mode: 'refund', payment, notice: t('admin_cancel_too_late') });
      } else {
        setNotice({ ok: false, text: errorMessages(e, t).join(' ') });
        setReverse(null);
      }
    } finally {
      setReversing(false);
      load();
    }
  };

  const paymentActions = (p) => {
    if (!data?.card_enabled || !p.offer) return null;
    return (
      <button type="button" onClick={() => setReverse({ mode: p.offer, payment: p })} disabled={busy || reversing} className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-primary">
        <Undo2 className="w-4 h-4" aria-hidden="true" /> {t(p.offer === 'cancel' ? 'admin_pay_cancel' : 'admin_pay_refund')}
      </button>
    );
  };

  return (
    <section className="p-5 rounded-lg bg-card border border-border">
      <h3 className="mb-3 flex items-center gap-2 text-base font-medium">
        <CreditCard className="w-4 h-4 text-primary" aria-hidden="true" /> {t('admin_billing_title')}
      </h3>

      {notice && <p className={`mb-3 text-sm ${notice.ok ? 'text-primary' : 'text-destructive'}`} role="status">{notice.text}</p>}

      {!data ? (
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" aria-label={t('loading')} />
      ) : data.failed ? (
        <p className="text-muted-foreground">{t('err_generic')}</p>
      ) : (
        <div className="space-y-4">
          {!data.card_enabled && <p className="text-muted-foreground">{t('admin_billing_off')}</p>}
          {data.card ? (
            <>
              <CardLine card={data.card} t={t} />
              {data.card.expired && <p className="text-destructive">{t('card_expired_short')}</p>}
            </>
          ) : (
            <p className="text-muted-foreground">{t('admin_no_card')}</p>
          )}

          {data.card_enabled && data.card && !data.card.expired && (
            <div className="flex flex-wrap items-end gap-3">
              <label className="block">
                <span className="block mb-1.5 text-sm text-muted-foreground">{t('admin_test_amount')}</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="1"
                  max={MAX_AMOUNT}
                  step="0.01"
                  dir="ltr"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-32 h-11 rounded-md border border-input bg-background px-3 text-base tabular-nums"
                />
              </label>
              <button type="button" onClick={() => setConfirmOpen(true)} disabled={busy || !amountOk} className="inline-flex h-11 items-center gap-2 rounded-md bg-primary px-4 text-primary-foreground disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <CreditCard className="w-4 h-4" aria-hidden="true" />} {t('admin_test_charge')}
              </button>
            </div>
          )}

          <PaymentList payments={data.payments} t={t} language={language} showCode renderActions={paymentActions} className="border-t border-border" />
        </div>
      )}

      <RefundDialog
        open={!!reverse}
        mode={reverse?.mode}
        payment={reverse?.payment}
        card={data?.card}
        notice={reverse?.notice}
        busy={reversing}
        onConfirm={runReverse}
        onClose={() => setReverse(null)}
        t={t}
        language={language}
      />

      <AlertDialog open={confirmOpen} onOpenChange={(next) => { if (!next && !busy) setConfirmOpen(false); }}>
        <AlertDialogContent className="w-[calc(100%-2rem)] max-w-md p-6 sm:p-8">
          <AlertDialogHeader className="text-start sm:text-start">
            <AlertDialogTitle>{t('admin_test_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('admin_test_confirm_amount')}: <span className="font-medium tabular-nums">{formatMoney(value, language)}</span>. {t('admin_test_confirm_desc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy} className="h-12 px-6 text-base">{t('admin_reverse_back')}</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={(e) => { e.preventDefault(); charge(); }} className="h-12 px-6 text-base">
              {busy && <Loader2 className="animate-spin" />} {t('admin_test_charge')} {formatMoney(value, language)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
