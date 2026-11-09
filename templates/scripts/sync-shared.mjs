#!/usr/bin/env node
// Copies base44/shared/* into each consuming function's _shared/ folder.
// Functions deploy without a bundler, so a function can import only files inside its own folder.
// Usage: node scripts/sync-shared.mjs          (write the copies)
//        node scripts/sync-shared.mjs --check  (exit 1 if any copy is stale; run before deploy)
// A project that already has this script adds the billing modules and functions to its CONSUMERS.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BILLING = ['createCardSession', 'confirmCard', 'getMyBilling', 'adminCharge', 'adminRefundPayment', 'createPayment', 'confirmPayment', 'runBilling'];
const CONSUMERS = {
  // billing.ts imports common.ts, customer.ts and hyp.ts, so every billing function gets all four.
  'common.ts': BILLING,
  'customer.ts': BILLING,
  'hyp.ts': BILLING,
  'billing.ts': BILLING,
  'products.ts': ['createPayment', 'confirmPayment'],
  'subscription.ts': ['confirmCard', 'runBilling'],
};
const header = (m) => `// GENERATED, do not edit. Source of truth: base44/shared/${m} (scripts/sync-shared.mjs).\n\n`;

const check = process.argv.includes('--check');
let stale = 0;
for (const [module, fns] of Object.entries(CONSUMERS)) {
  const content = header(module) + readFileSync(join(ROOT, 'base44/shared', module), 'utf8');
  for (const fn of fns) {
    const target = join(ROOT, 'base44/functions', fn, '_shared', module);
    const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
    if (current === content) continue;
    if (check) {
      console.error(`stale: ${target}`);
      stale += 1;
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      console.log(`wrote ${target}`);
    }
  }
}
if (stale) process.exit(1);
