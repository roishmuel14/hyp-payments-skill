#!/bin/bash
# Proves the tests still catch each broken money rule after the templates were adapted: every check
# breaks one rule in a throwaway copy of the project, runs the billing tests, and expects a failure.
# Run from the project root: bash tests/break-checks.sh
# "MISSED" = the tests no longer guard that rule. "pattern not found" = the code was adapted: point
# the check at the new line. Nothing in the project itself is touched.
ROOT=$(pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
check() { # label, file, old text, new text
  rm -rf "$TMP/p" && mkdir -p "$TMP/p" && cp -R "$ROOT/base44" "$ROOT/tests" "$ROOT/scripts" "$TMP/p/" && cd "$TMP/p" || exit 1
  if ! python3 -c "import sys;p,o,n=sys.argv[1:4];s=open(p).read();assert o in s;open(p,'w').write(s.replace(o,n,1))" "$2" "$3" "$4" 2>/dev/null; then
    echo "pattern not found  $1 ($2)"; cd "$ROOT"; return
  fi
  node scripts/sync-shared.mjs > /dev/null
  sum=$(deno test --no-config --node-modules-dir=none --import-map=tests/import_map.json --allow-env --allow-read=. tests/ 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "passed .*failed" | tail -1)
  case "$sum" in *"| 0 failed"*) echo "MISSED  $1";; *) echo "caught  $1";; esac
  cd "$ROOT"
}
check "a charge claimed without its status" base44/shared/billing.ts "{ id: payment.id, status: 'pending' }," "{ id: payment.id },"
check "a refund claimed without the refunded amount" base44/shared/billing.ts "{ id: payment.id, status: payment.status, refunded_amount: payment.refunded_amount ?? null }," "{ id: payment.id },"
check "a '+' in Sign read as a space" base44/shared/hyp.ts "out.push([decodeURIComponent(k), decodeURIComponent(v)]);" "out.push([decodeURIComponent(k), decodeURIComponent(v.replace(/\+/g, ' '))]);"
check "a paid page closed without its status" base44/functions/confirmPayment/entry.ts "{ id: payment.id, status: 'awaiting_payment' },
      {" "{ id: payment.id },
      {"
check "no check of the paid amount" base44/functions/confirmPayment/entry.ts "const mismatch = paid !== toAgorot(payment.amount);" "const mismatch = false;"
check "a subscription charged without the account lock" base44/shared/subscription.ts "const lockId = await lockAccount(base44, account);
  if (!lockId) return 'locked';" "const lockId = 'x';"
check "a period charged again while HYP never answered" base44/shared/subscription.ts "    if (open.length) {" "    if (false) {"
check "the token in the card summary" base44/shared/billing.ts "  return {
    last4: account.card_last4" "  return {
    // deno-lint-ignore no-explicit-any
    ...({ token: account.token } as any),
    last4: account.card_last4"
check "a charge sent again to the second host" base44/shared/hyp.ts "  const { pairs } = await call(params);
  return {
    ccode: pick(pairs, 'CCode'),
    transId: pick(pairs, 'Id'),
    acode: pick(pairs, 'ACode'),
    invoice: pick(pairs, 'Hesh'),
  };" "  const { pairs } = await call(params, true);
  return {
    ccode: pick(pairs, 'CCode'),
    transId: pick(pairs, 'Id'),
    acode: pick(pairs, 'ACode'),
    invoice: pick(pairs, 'Hesh'),
  };"
check "a single-payment page without Tash" base44/shared/hyp.ts "  } else if (!input.recurring) {
    params.push(['Tash', '1'], ['FixTash', 'True']);
  }" "  }"
