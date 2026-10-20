#!/usr/bin/env bash
# Excerpt from the private production repository, included for illustration.
# Phase 2 checkpoint: the full customer lifecycle, driven entirely by curl.
#
#   enroll -> scan -> stamp x6 -> redeem -> verify the log
#
# Every assertion here is one the design promises: idempotent retries, a
# cooldown that blocks a genuine second stamp but not a replay, a redemption
# that subtracts the threshold rather than zeroing, and a cached balance that
# agrees with the append-only log.
#
# Usage: npm run lifecycle            (service on :8787, AUTH_MODE=insecure-dev)
set -euo pipefail

API="${API:-http://127.0.0.1:8787}"
SHOP="${SHOP:-demo-cafe}"

# Idempotency keys live in shops/<shop>/transactions and are scoped to the
# shop, not to the customer. Fixed keys therefore only work once per database:
# a second run reuses them for a different customer, which is correctly
# rejected as a conflict. Namespace them per run so the script is re-runnable.
RUN_ID="${RUN_ID:-$(date +%s)-$$}"

HDRS=(-H "content-type: application/json"
      -H "x-shop-id: ${SHOP}"
      -H "x-barista-uid: barista-sinan"
      -H "x-role: owner")

pass=0; fail=0
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
check(){
  if [ "$2" = "$3" ]; then ok "$1 = $3"; else
    bad "$1: expected $3, got $2"
    [ -n "${4:-}" ] && printf '       response: %s\n' "$(printf '%s' "$4" | head -c 240)"
  fi
}

die() {
  printf '\n\033[31m%s\033[0m\n' "$1"
  shift
  for line in "$@"; do printf '  %s\n' "$line"; done
  echo
  exit 2
}

jqp() {
  python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    print(eval('d' + sys.argv[1]))
except Exception:
    print('<unparseable>')
" "$1" 2>/dev/null || echo '<unparseable>'
}

# --- preflight ---------------------------------------------------------------
# This script is three curl calls deep before anything meaningful happens, and
# `set -e` turns a refused connection into a bare exit code with no hint of what
# to start. Check the obvious preconditions first and say what to do about them.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

if ! curl -sS -m 3 -o /dev/null "$API/health" 2>/dev/null; then
  die "The pass service is not reachable at $API" \
      "Start it, and the database it talks to, in two other terminals:" \
      "" \
      "  npm run emulator     # terminal 1 (needs Java)" \
      "  npm run dev          # terminal 2" \
      "" \
      "Then re-run: npm run lifecycle"
fi

# If the service is pointed at the emulator, a running service with a stopped
# emulator fails later with an opaque timeout. Catch it here instead.
EMU_HOST=$(grep -E '^FIRESTORE_EMULATOR_HOST=' "$REPO_ROOT/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)
if [ -n "${EMU_HOST:-}" ] && ! curl -sS -m 3 -o /dev/null "http://$EMU_HOST/" 2>/dev/null; then
  die "The service is configured for the Firestore emulator at $EMU_HOST, but nothing is there." \
      "  npm run emulator" \
      "" \
      "Or comment out FIRESTORE_EMULATOR_HOST in .env to use the real project."
fi

# The shop is created deliberately, never by an API call, so a missing one is a
# setup step rather than a bug. Detect it before it looks like a test failure.
# This doubles as step 1, so the check does not leave a stray customer behind.
CUST=$(curl -sS "${HDRS[@]}" -X POST "$API/shops/$SHOP/customers" -d '{"platform":"apple"}' 2>/dev/null || true)
if printf '%s' "$CUST" | grep -q SHOP_NOT_FOUND; then
  die "Shop \"$SHOP\" does not exist in the database this service is using." \
      "  npm run seed -- --shop $SHOP --name \"Demo Cafe\"" \
      "" \
      "The emulator forgets everything when it restarts, so this is normal after a restart."
fi
if [ -z "$CUST" ] || ! printf '%s' "$CUST" | grep -q customerId; then
  die "Unexpected response from the service. Is it healthy?" "$CUST"
fi

# --- enroll ---
step "1. Enroll a customer"
CID=$(printf '%s' "$CUST" | jqp "['customer']['customerId']")
SERIAL=$(printf '%s' "$CUST" | jqp "['customer']['serialNumber']")
echo "  customerId $CID"
echo "  serial     $SERIAL"
check "starting balance" "$(printf '%s' "$CUST" | jqp "['customer']['stamps']")" "0"
if printf '%s' "$CUST" | grep -q authToken; then
  bad "authToken leaked in the response"
else
  ok "authToken not exposed to clients"
fi

# --- scan ---
step "2. Resolve the scanned QR to a card"
CARD=$(curl -sS "${HDRS[@]}" "$API/shops/$SHOP/cards?serial=$SERIAL")
check "resolved customerId" "$(printf '%s' "$CARD" | jqp "['customer']['customerId']")" "$CID"
check "redeemable" "$(printf '%s' "$CARD" | jqp "['redeemable']")" "False"

step "3. A serial that does not exist"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "${HDRS[@]}" "$API/shops/$SHOP/cards?serial=NOPE")
check "http status" "$CODE" "404"

# --- stamping ---
step "4. Add a stamp"
S1=$(curl -sS "${HDRS[@]}" -X POST "$API/shops/$SHOP/customers/$CID/stamps" \
      -d "{\"idempotencyKey\":\"life-stamp-1-$RUN_ID\",\"deviceLabel\":\"till-1\"}")
check "balance" "$(printf '%s' "$S1" | jqp "['customer']['stamps']")" "1" "$S1"
check "applied" "$(printf '%s' "$S1" | jqp "['applied']")" "True"
check "logged delta" "$(printf '%s' "$S1" | jqp "['transaction']['delta']")" "1"

step "5. Replay the same idempotency key (the double-tap)"
S1R=$(curl -sS "${HDRS[@]}" -X POST "$API/shops/$SHOP/customers/$CID/stamps" \
       -d "{\"idempotencyKey\":\"life-stamp-1-$RUN_ID\",\"deviceLabel\":\"till-1\"}")
check "balance unchanged" "$(printf '%s' "$S1R" | jqp "['customer']['stamps']")" "1"
check "applied" "$(printf '%s' "$S1R" | jqp "['applied']")" "False"

step "6. A genuinely new stamp inside the cooldown is refused"
CODE=$(curl -sS -o /tmp/cooldown.json -w '%{http_code}' "${HDRS[@]}" \
        -X POST "$API/shops/$SHOP/customers/$CID/stamps" \
        -d "{\"idempotencyKey\":\"life-stamp-2-$RUN_ID\"}")
check "http status" "$CODE" "409"
check "error code" "$(jqp "['error']['code']" < /tmp/cooldown.json)" "STAMP_COOLDOWN"

step "7. Fill the card to the threshold"
# The cooldown is real, so the remaining stamps go in as adjustments — the same
# transactional path, without a 90-second wait per stamp in a smoke test.
ADJ=$(curl -sS "${HDRS[@]}" -X POST "$API/shops/$SHOP/customers/$CID/adjustments" \
       -d "{\"idempotencyKey\":\"life-adjust-1-$RUN_ID\",\"amount\":7}")
check "balance" "$(printf '%s' "$ADJ" | jqp "['customer']['stamps']")" "8" "$ADJ"

CARD=$(curl -sS "${HDRS[@]}" "$API/shops/$SHOP/cards?serial=$SERIAL")
check "redeemable" "$(printf '%s' "$CARD" | jqp "['redeemable']")" "True"

# --- redemption ---
step "8. Redeem: subtracts the threshold, keeps the surplus"
R1=$(curl -sS "${HDRS[@]}" -X POST "$API/shops/$SHOP/customers/$CID/redemptions" \
      -d "{\"idempotencyKey\":\"life-redeem-1-$RUN_ID\"}")
check "balance" "$(printf '%s' "$R1" | jqp "['customer']['stamps']")" "2" "$R1"
check "logged delta" "$(printf '%s' "$R1" | jqp "['transaction']['delta']")" "-6"
check "redemptionCount" "$(printf '%s' "$R1" | jqp "['customer']['redemptionCount']")" "1"
check "lifetimeStamps" "$(printf '%s' "$R1" | jqp "['customer']['lifetimeStamps']")" "8"

step "9. Redeeming again below the threshold is refused"
CODE=$(curl -sS -o /tmp/redeem2.json -w '%{http_code}' "${HDRS[@]}" \
        -X POST "$API/shops/$SHOP/customers/$CID/redemptions" \
        -d "{\"idempotencyKey\":\"life-redeem-2-$RUN_ID\"}")
check "http status" "$CODE" "409"
check "error code" "$(jqp "['error']['code']" < /tmp/redeem2.json)" "INSUFFICIENT_STAMPS"

# --- the log is authoritative ---
step "10. Cached balance agrees with the append-only log"
AUDIT=$(curl -sS "${HDRS[@]}" "$API/shops/$SHOP/customers/$CID/audit")
check "cached" "$(printf '%s' "$AUDIT" | jqp "['cached']")" "2"
check "from log" "$(printf '%s' "$AUDIT" | jqp "['fromLog']")" "2"
check "consistent" "$(printf '%s' "$AUDIT" | jqp "['consistent']")" "True"

# --- tenancy and validation ---
step "11. A caller cannot reach another shop"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' \
        -H "content-type: application/json" -H "x-shop-id: other-cafe" -H "x-role: owner" \
        "$API/shops/$SHOP/customers/$CID")
check "http status" "$CODE" "403"

step "12. Unauthenticated requests are refused"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -H "content-type: application/json" \
        "$API/shops/$SHOP/customers/$CID")
check "http status" "$CODE" "401"

step "13. A malformed body is rejected before it reaches the domain"
CODE=$(curl -sS -o /tmp/bad.json -w '%{http_code}' "${HDRS[@]}" \
        -X POST "$API/shops/$SHOP/customers/$CID/stamps" -d '{"idempotencyKey":"short"}')
check "http status" "$CODE" "400"
check "error code" "$(jqp "['error']['code']" < /tmp/bad.json)" "INVALID_REQUEST"

step "14. A barista cannot make manual adjustments"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' \
        -H "content-type: application/json" -H "x-shop-id: $SHOP" -H "x-role: barista" \
        -X POST "$API/shops/$SHOP/customers/$CID/adjustments" \
        -d "{\"idempotencyKey\":\"life-adjust-9-$RUN_ID\",\"amount\":5}")
check "http status" "$CODE" "403"

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
