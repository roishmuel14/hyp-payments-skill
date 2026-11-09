import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { errorMessages, invokeFunction, reasonCodes, returnKind, takeReturnQuery } from '@/lib/billing';
import { CardLine } from '@/components/billing/CardSummary';

// The ONE page HYP sends the customer back to, after success and after failure: the terminal's
// "עסקה שהצליחה" and "עסקה שנכשלה" both point here (the address is set on the terminal, not per
// request). A card check (Order 'k...') needs a signed-in customer: a visitor is sent to log in and
// comes back here, and the raw query waits in sessionStorage. A payment page (Order 'p...') works for
// anonymous buyers too. The server checks everything; this page only reports what it answered.
// Props: t (the project's i18n, or billingT from billing-i18n.js), backTo (where "back" goes),
// onNeedLogin (a project with its own login page passes it, e.g. a redirect to /login?returnTo=/billing/return).
const platformLogin = () => base44.auth.redirectToLogin(window.location.href);

export default function BillingReturn({ t, backTo = '/', onNeedLogin = platformLogin }) {
  const [raw] = useState(takeReturnQuery);
  const kind = returnKind(raw);
  const [result, setResult] = useState({ phase: 'checking' });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      if (!kind) {
        setResult({ phase: 'failed', error: null });
        return;
      }
      if (kind === 'card' && !(await base44.auth.isAuthenticated())) {
        onNeedLogin();
        return;
      }
      try {
        const res = await invokeFunction(kind === 'card' ? 'confirmCard' : 'confirmPayment', { rawQuery: raw });
        setResult({ phase: 'done', res });
        // A purchase pixel or analytics event fires only when res.first is true (a reload answers false).
      } catch (e) {
        console.error(e);
        setResult({ phase: 'failed', error: e });
      }
    })();
  }, [kind, raw, onNeedLogin]);

  const { phase, res, error } = result;
  const messages = phase === 'failed' ? (error ? errorMessages(error, t) : [t('err_missing_return')]) : [];
  const card = kind === 'card';
  // "Nothing was charged" only when it is true: a card check is never captured, and a payment page
  // is unpaid only when the card was declined. After a VERIFY failure or no answer the money may
  // have moved (a live site lost real payments that way), so the page does not promise it.
  const notCharged = card || reasonCodes(error).some((c) => c.startsWith('card_'));
  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-16 bg-background">
      <div className="max-w-md w-full text-center" aria-live="polite">
        {phase === 'checking' && (
          <>
            <Loader2 className="w-10 h-10 mx-auto animate-spin text-primary" aria-hidden="true" />
            <h1 className="mt-6 text-2xl font-semibold">{t('return_checking')}</h1>
          </>
        )}
        {phase === 'done' && (
          <>
            <CheckCircle2 className="w-12 h-12 mx-auto text-primary" aria-hidden="true" />
            <h1 className="mt-6 text-2xl font-semibold">{t(card ? 'return_card_saved_title' : 'return_paid_title')}</h1>
            {card && <CardLine card={res?.card} t={t} className="mt-4 text-lg" />}
            <p className="mt-3 text-lg text-muted-foreground">{t(card ? 'return_card_saved_desc' : 'return_paid_desc')}</p>
            <Link to={backTo} className="inline-flex mt-8 h-12 items-center rounded-md bg-primary px-6 text-primary-foreground">{t('return_back')}</Link>
          </>
        )}
        {phase === 'failed' && (
          <>
            <AlertCircle className="w-12 h-12 mx-auto text-destructive" aria-hidden="true" />
            <h1 className="mt-6 text-2xl font-semibold">{t(card ? 'return_card_failed_title' : 'return_payment_failed_title')}</h1>
            {messages.map((m) => (
              <p key={m} className="mt-3 text-lg text-muted-foreground">{m}</p>
            ))}
            {notCharged && <p className="mt-3 text-base text-muted-foreground">{t('return_not_charged')}</p>}
            <Link to={backTo} className="inline-flex mt-8 h-12 items-center rounded-md bg-primary px-6 text-primary-foreground">{t('return_retry')}</Link>
          </>
        )}
      </div>
    </main>
  );
}
