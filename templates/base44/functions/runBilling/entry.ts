import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { currentUser, israelToday, readBody, serverError } from './_shared/common.ts';
import { hypConfig } from './_shared/hyp.ts';
import { getBillingSettings } from './_shared/billing.ts';
import { BILLABLE, type BillingMode, TEST_CHARGE_AMOUNT, billAccount, billingMode, mayBill } from './_shared/subscription.ts';

const PAGE = 200;

// The daily subscription run, called by the Workflow "Daily billing" (base44/workflows/; apps on
// Workflows reject function.jsonc crons with 409). Like every scheduled route it is reachable
// without a user, so it reads NOTHING from an anonymous body: a stray or repeated call can only do
// what is due today, and a second run the same day finds nothing due. [DESIGN]
//
// What it may do comes only from the BILLING_MODE secret (subscription.ts): off (the default) only
// plans (what live would do today, nothing done), test bills only BILLING_TEST_CUSTOMERS at 1 ILS,
// live bills everyone. In test and live ANY call is a real run, an anonymous POST included: to probe
// the route or confirm the mode, an admin sends { dry_run: true } (counts and the due list, nothing
// written, charged or emailed). The Workflow calls as the admin who created it, without dry_run, so
// its runs are real.
// Never run it under `base44 dev`: that forwards updateMany to production.
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await currentUser(base44);
    const admin = user?.role === 'admin';
    const body = admin ? await readBody(req) : {};
    const mode = billingMode();
    const dryRun = mode.mode === 'off' || body.dry_run === true;
    const today = israelToday();
    const cfg = hypConfig();
    if (!cfg && !dryRun) {
      console.error('runBilling: HYP secrets are not set: nothing done');
      return Response.json({ today, mode: mode.mode, skipped: 'billing_unavailable' });
    }
    const settings = await getBillingSettings(base44);
    const counts: Record<string, number> = {};
    const due: { customer_id: string; status: string; next_charge_on: string; amount: number | null }[] = [];
    // The plan in off mode shows what live would do; in test and live, what this mode will do.
    const plan: BillingMode = mode.mode === 'off' ? { mode: 'live', testCustomers: [] } : mode;
    for (const status of BILLABLE) {
      // deno-lint-ignore no-explicit-any
      const accounts: any[] = [];
      for (let skip = 0; ; skip += PAGE) {
        const rows = (await base44.asServiceRole.entities.BillingAccount.filter({ subscription_status: status }, 'created_date', PAGE, skip)) ?? [];
        accounts.push(...rows);
        if (rows.length < PAGE) break;
      }
      for (const account of accounts) {
        if (dryRun) {
          // A plan only: who is due today and for how much in this mode. Nothing is written.
          const isDue = !!account.next_charge_on && account.next_charge_on <= today && !account.cancel_at_period_end;
          const key = !mayBill(plan, account.customer_id) ? 'off' : isDue ? 'due' : 'not_due';
          counts[key] = (counts[key] || 0) + 1;
          if (key === 'due') {
            // amount null: no card, so today ends the trial or counts a failed try instead of a charge.
            const amount = !account.token ? null : plan.mode === 'test' ? TEST_CHARGE_AMOUNT : settings.monthly_price;
            due.push({ customer_id: account.customer_id, status, next_charge_on: account.next_charge_on, amount });
          }
          continue;
        }
        // One account at a time: a failure on one never stops the others.
        try {
          const result = await billAccount(base44, account.id, today, settings, cfg!, mode);
          counts[result] = (counts[result] || 0) + 1;
        } catch (error) {
          counts.error = (counts.error || 0) + 1;
          console.error('runBilling: account failed', account.id, (error as Error).message);
        }
      }
    }
    console.log('runBilling', JSON.stringify({ today, mode: mode.mode, dry_run: dryRun, trigger: admin ? 'admin' : 'anonymous', counts }));
    const summary = { today, mode: mode.mode, dry_run: dryRun, counts };
    return Response.json(admin ? { ...summary, test_customers: mode.testCustomers, due } : summary);
  } catch (error) {
    return serverError(error);
  }
});
