import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { israelToday, serverError } from './_shared/common.ts';
import { hypConfig } from './_shared/hyp.ts';
import { getBillingSettings } from './_shared/billing.ts';
import { billAccount } from './_shared/subscription.ts';

const PAGE = 200;

// The daily subscription run, called by the Workflow "Daily billing" (base44/workflows/; apps on
// Workflows reject function.jsonc crons with 409). Like every scheduled route it is reachable
// without a user, so it reads NOTHING from the body: a stray or repeated call can only do what is
// due today, and a second run the same day finds nothing due. [DESIGN]
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const today = israelToday();
    const cfg = hypConfig();
    if (!cfg) {
      console.error('runBilling: HYP secrets are not set: nothing done');
      return Response.json({ today, skipped: 'billing_unavailable' });
    }
    const settings = await getBillingSettings(base44);
    const counts: Record<string, number> = {};
    for (const status of ['trial', 'active', 'past_due']) {
      const ids: string[] = [];
      for (let skip = 0; ; skip += PAGE) {
        const rows = (await base44.asServiceRole.entities.BillingAccount.filter({ subscription_status: status }, 'created_date', PAGE, skip)) ?? [];
        ids.push(...rows.map((r: { id: string }) => r.id));
        if (rows.length < PAGE) break;
      }
      // One account at a time: a failure on one never stops the others.
      for (const id of ids) {
        try {
          const result = await billAccount(base44, id, today, settings, cfg);
          counts[result] = (counts[result] || 0) + 1;
        } catch (error) {
          counts.error = (counts.error || 0) + 1;
          console.error('runBilling: account failed', id, (error as Error).message);
        }
      }
    }
    console.log('runBilling', today, JSON.stringify(counts));
    return Response.json({ today, counts });
  } catch (error) {
    return serverError(error);
  }
});
