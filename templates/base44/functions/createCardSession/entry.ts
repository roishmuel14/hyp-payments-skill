import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { currentUser, fail, readBody, serverError, unauthorized } from './_shared/common.ts';
import { findOwnCustomer } from './_shared/customer.ts';
import { HypError, hypConfig, signPage } from './_shared/hyp.ts';
import { ensureBillingAccount } from './_shared/billing.ts';

// How long the card page link stays good. HYP's page can be left open a while; after this the
// customer starts again from the billing screen.
const SESSION_MINUTES = 60;

// The line in HYP's transaction list. Put the app's name first, for example "MyApp: ...".
const INFO = { he: 'בדיקת כרטיס למנוי, ללא חיוב', en: 'Card check for the subscription, no charge' };

// A signed-in customer opens HYP's card-check page (J5: the card company approves 1 ILS that is
// never charged). The customer comes from the token, never from the body. A one-time session id
// goes to HYP as Order and is kept on the customer's BillingAccount; confirmCard accepts the
// redirect only with that id.
// Body: { lang: 'he' | 'en' } for the page language. Answers { url }.
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await currentUser(base44);
    if (!user) return unauthorized();

    const body = await readBody(req);
    const lang = body.lang === 'en' ? 'en' : 'he';

    const customer = await findOwnCustomer(base44, user);
    if (!customer) return fail([{ code: 'no_customer', message: 'לא נמצא חשבון לחיוב' }]);
    if (customer.blocked) return fail([{ code: 'bad_status', message: 'הפעולה לא אפשרית בסטטוס הנוכחי' }]);

    const cfg = hypConfig();
    if (!cfg) {
      console.error('createCardSession: HYP secrets are not set');
      return fail([{ code: 'billing_unavailable', message: 'שמירת כרטיס לא זמינה כרגע' }]);
    }

    const account = await ensureBillingAccount(base44, customer);
    // 'k' + 31 hex: 32 characters, a shape a production terminal accepted as Order, and the return
    // page tells a card session ('k') from a payment page ('p') on a terminal that serves both.
    const sessionId = `k${crypto.randomUUID().replace(/-/g, '').slice(1)}`;
    const expiresAt = new Date(Date.now() + SESSION_MINUTES * 60_000).toISOString();
    await base44.asServiceRole.entities.BillingAccount.update(account.id, {
      session_id: sessionId,
      session_expires_at: expiresAt,
      owner_user_id: customer.owner_user_id || account.owner_user_id || '',
    });

    try {
      const url = await signPage(cfg, {
        order: sessionId,
        cardCheck: true,
        firstName: customer.first_name,
        lastName: customer.last_name,
        email: customer.email,
        lang,
        info: INFO[lang],
      });
      return Response.json({ url });
    } catch (error) {
      if (error instanceof HypError) {
        console.error('createCardSession:', error.message);
        return fail([{ code: error.reason, message: 'לא ניתן לפתוח את דף הכרטיס' }]);
      }
      throw error;
    }
  } catch (error) {
    return serverError(error);
  }
});
