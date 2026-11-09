import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
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
import { formatMoney, paymentDay } from '@/lib/billing';

// The admin's question before money goes back to a customer's card: a cancel of the whole charge
// (mode 'cancel'), or a refund of an amount up to what is left (mode 'refund'). It names the
// payment and the card, and shows the exact amount right above the button. It stays open while HYP
// answers (busy) and closes when the caller clears `open`. `notice` says why it opened, for example
// after HYP refused a cancel because the charge was already transmitted.
export default function RefundDialog({ open, mode, payment, card, notice = '', busy = false, onConfirm, onClose, t, language }) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!open || !payment) return;
    setAmount(String(payment.refund_left || ''));
    setNote('');
  }, [open, payment, mode]);

  if (!payment) return null;
  const isCancel = mode === 'cancel';
  const max = Number(payment.refund_left) || 0;
  const value = isCancel ? Number(payment.amount) : Number(amount);
  const agorot = Math.round(value * 100);
  const valid = isCancel || (Number.isFinite(value) && agorot >= 1 && agorot <= Math.round(max * 100) && Math.abs(agorot - value * 100) < 1e-6);
  const money = valid ? formatMoney(value, language) : '';

  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <AlertDialogContent className="w-[calc(100%-2rem)] max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto p-6 sm:p-8">
        <AlertDialogHeader className="text-start sm:text-start">
          <AlertDialogTitle>{t(isCancel ? 'admin_cancel_title' : 'admin_refund_title')}</AlertDialogTitle>
          <AlertDialogDescription>{t(isCancel ? 'admin_cancel_desc' : 'admin_refund_desc')}</AlertDialogDescription>
        </AlertDialogHeader>

        {notice && <p className="rounded-md bg-muted p-4 text-base leading-snug">{notice}</p>}

        <p className="text-base text-muted-foreground">
          {payment.description || t(`pay_kind_${payment.kind}`)} · <span className="tabular-nums">{paymentDay(payment)}</span> · <span className="tabular-nums">{formatMoney(payment.amount, language)}</span>
          {card && <> · <span dir="ltr" className="tabular-nums whitespace-nowrap">•••• {card.last4}</span></>}
        </p>

        {!isCancel && (
          <label className="block">
            <span className="block mb-1.5 text-sm text-muted-foreground">{t('admin_refund_amount')}</span>
            <input
              type="number"
              inputMode="decimal"
              min="0.01"
              max={max}
              step="0.01"
              dir="ltr"
              value={amount}
              disabled={busy}
              aria-invalid={!valid}
              onChange={(e) => setAmount(e.target.value)}
              className="w-40 h-11 rounded-md border border-input bg-background px-3 text-base tabular-nums"
            />
            <span className="block mt-1 text-sm text-muted-foreground">{t('admin_refund_left')} {formatMoney(max, language)}</span>
          </label>
        )}

        <label className="block">
          <span className="block mb-1.5 text-sm text-muted-foreground">{t('admin_refund_note')}</span>
          <input
            type="text"
            maxLength={200}
            value={note}
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
            className="w-full h-11 rounded-md border border-input bg-background px-3 text-base"
          />
        </label>

        <p className="text-lg">{t('admin_reverse_amount')}: <span className="font-medium tabular-nums">{money || '-'}</span></p>

        <AlertDialogFooter className="mt-2">
          <AlertDialogCancel disabled={busy} className="h-12 px-6 text-base">{t('admin_reverse_back')}</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy || !valid}
            onClick={(e) => { e.preventDefault(); onConfirm({ amount: value, note: note.trim() }); }}
            className="h-12 px-6 text-base"
          >
            {busy && <Loader2 className="animate-spin" />} {isCancel ? t('admin_cancel_confirm') : `${t('admin_refund_confirm')} ${money}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
