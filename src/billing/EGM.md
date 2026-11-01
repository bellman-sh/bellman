# billing

## Overview

Stripe billing. `BELLMAN_BILLING` plus the Stripe secrets choose a mode. A hand-verified webhook links Stripe
customers to Bellman users and re-reads each subscription from the Stripe API into a serialized ledger; the best
paid plan is then reconciled into a `"purchase"`-sourced plan grant and, for org-scoped plans, a purchased org
with a seat count. The ledger runs on any `LedgerKV`; `AuthDO` in `src/oauth/store.ts` holds the production one.

## Interface

- `BillingMode = "off" | "shadow" | "on"`; `billingMode(raw)` parses `BELLMAN_BILLING` trimmed and lowercased
  [src/billing/config.ts:billingMode]
- `BillingEnv` reads `BELLMAN_BILLING`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_API_KEY`, `STRIPE_PAYMENT_LINKS`;
  `billingSettings(env)` returns `{mode, webhookSecret?, apiKey?, applyPlans, paymentLinks}`
  [src/billing/config.ts:billingSettings]
- `PURCHASE = "purchase"`: the grant source billing stamps and the only one it touches [src/billing/grants.ts:PURCHASE]
- `grantKeyForUser` maps `u_(github|google)_<digits>` to `"<provider>:<digits>"`, else null;
  `orgForUser(userId)` is `` `org_${userId}` ``; `canPurchaseAs(userId)` [src/billing/grants.ts:canPurchaseAs]
- `purchaseGrant(key, plan, userId)`: admin of `org_<userId>` when `ENTITLEMENTS[plan].orgScoping`, else member
  with no org; source purchase, `grantedBy` stripe, no expiry [src/billing/grants.ts:purchaseGrant]
- `PurchaseGrantStore` (`putGrantIfSource`, `deleteGrantIfSource`, `activatePurchasedOrg`, `deactivateOrg`);
  `reconcilePurchase(userId, billing, plans)` returns `"written" | "deleted" | "missing" | "conflict" |
  "unkeyable"` [src/billing/grants.ts:reconcilePurchase]
- `BillingStorage` (`linkCustomer`, `syncSubscription`, `paidPlan`, `userForCustomer`); records
  `SubscriptionState`, `CustomerRecord`, `PaidPlan`; `LedgerKV` [src/billing/ledger.ts:BillingStorage]
- `BillingLedger` implements `BillingStorage`, adding `serializeUser(userId, work)` and `recordSubscription`;
  `MemoryBillingStore` for tests and the Node server [src/billing/ledger.ts:BillingLedger]
- `SIGNATURE_TOLERANCE_SECONDS = 300`, `MAX_WEBHOOK_BYTES = 256 * 1024`; `isLinkableUserId`
  (`/^u_[A-Za-z0-9_-]{1,198}$/`) [src/billing/stripe.ts:isLinkableUserId]
- `verifyStripeSignature(payload, header, secret, nowSeconds?, tolerance?)`: HMAC-SHA256 over `${t}.${payload}`
  [src/billing/stripe.ts:verifyStripeSignature]
- `handleStripeWebhook` for `POST /stripe/webhook`, with `StripeWebhookConfig`: applies
  `checkout.session.completed` and `customer.subscription.created/updated/deleted/paused/resumed`; any other type
  is acknowledged and not applied [src/billing/stripe.ts:handleStripeWebhook]
- `parsePaymentLinks(raw)`: `STRIPE_PAYMENT_LINKS` JSON to a name-to-URL map [src/billing/stripe.ts:parsePaymentLinks]
- `isPaidPlan` (any `ENTITLEMENTS` key but `"free"`), `planForPrice` (`metadata.plan`, else the `lookup_key`
  prefix before `_`), `pricesOf`, `isRecord` [src/billing/subscription.ts:planForPrice]
- `readSubscription(id, source)` with `SubscriptionSource {apiKey, fetchImpl?}` returns `{plan, status, seats}`
  [src/billing/subscription.ts:readSubscription]

## Invariants

- A `BELLMAN_BILLING` value other than off, shadow or on reads as off and logs an error
  [src/billing/config.ts:billingMode]
- Shadow or on without `STRIPE_WEBHOOK_SECRET` or `STRIPE_API_KEY` falls back to off; `applyPlans` is true only
  in on mode [src/billing/config.ts:billingSettings]
- Webhook: POST only (405); over 256 KB is 413, checked on `Content-Length` and again while streaming; a failed
  signature is 400, and nothing in the body is trusted before it passes [src/billing/stripe.ts:handleStripeWebhook]
- A signature more than 300 s off is rejected; a match on any one `v1` value suffices; the comparison is
  constant-time [src/billing/stripe.ts:verifyStripeSignature]
- A signed body that is not an event envelope is 400, not a throw, so Stripe does not retry it as a 5xx
  [src/billing/stripe.ts:parseEvent]
- Only a `checkout.session` in `subscription` mode with a valid `client_reference_id` and a customer links a
  customer [src/billing/stripe.ts:handleStripeWebhook]
- The first link wins: a customer linked to another user stays there; a user collects customers and never swaps
  one out [src/billing/ledger.ts:BillingLedger.linkCustomer]
- A subscription event is never trusted for state: the handler re-reads from Stripe; a failed read is 502 so
  Stripe retries, and a 404 throws rather than reading as cancelled [src/billing/subscription.ts:readSubscription]
- Writes serialize in in-memory queues per customer and per user; the customer queue is always taken first, and
  work passed to `serializeUser` must not take a customer queue [src/billing/ledger.ts:BillingLedger.serializeUser]
- `eventAt` strictly increases per subscription; a terminal status (canceled, incomplete_expired) or a higher
  `eventAt` is never overwritten [src/billing/ledger.ts:BillingLedger.writeSubscription]
- Only active, trialing and past_due grant a plan; the highest-ranked plan in `ENTITLEMENTS` order wins, a tie
  goes to more seats, customers whose `userId` does not match are skipped [src/billing/ledger.ts:BillingLedger.paidPlan]
- A subscription selling more than one distinct plan grants nothing; seats count only the items selling the plan
  [src/billing/subscription.ts:readSubscription]
- `reconcilePurchase` writes or deletes only purchase-sourced grants; an operator's grant comes back as conflict
  (logged, acknowledged, not retried); an operator-created org is left alone [src/billing/grants.ts:reconcilePurchase]
- On lapse the grant is deleted before the org is deactivated; on payment the org is activated before the grant
  is written [src/billing/grants.ts:reconcilePurchase]
- Payment links are kept only for names matching `/^[a-z0-9_]{1,64}$/` and https URLs on `buy.stripe.com` or
  `checkout.stripe.com`, so `/upgrade` cannot become an open redirect [src/billing/stripe.ts:parsePaymentLinks]

## Side Effects

- `fetch GET https://api.stripe.com/v1/subscriptions/{id}` with the API key as bearer
  [src/billing/subscription.ts:readSubscription]
- Ledger keys `billing:customer:<customerId>` and `billing:user:<userId>` via `LedgerKV.put`
  [src/billing/ledger.ts:BillingLedger.syncSubscription]
- Purchase grant written or deleted with an audit intent whose actor is `"stripe"`; the store writes the audit
  row in the same transaction [src/billing/grants.ts:reconcilePurchase]
- Purchased org seats set (`activatePurchasedOrg`) or the org deactivated (`deactivateOrg`)
  [src/billing/grants.ts:reconcilePurchase]
- Webhook replies 200 `{received, applied, grant}`, 400, 413, 502 [src/billing/stripe.ts:handleStripeWebhook]
- `console.error` / `console.warn` for conflicts, unkeyable users, unreadable subscriptions, unlinked customers,
  and invalid billing config [src/billing/stripe.ts:settle]

## Verification

- Run: `npm test -- tests/billing.test.ts tests/billing-grants.test.ts tests/grant-audit.test.ts`
- Run: `npm run test:worker` (`worker-tests/reconcile-race.test.ts`)
- Full gate: `npm run verify`
