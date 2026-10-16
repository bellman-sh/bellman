# ADR 0014 — A purchase is a grant, and switches are vars

**Date:** 2026-09-25 · **Status:** accepted · **Recorded:** 2026-10-09 · **Closes:** #39

## Context

Becoming a paying customer meant asking the operator to run `grant-plan` (#39).
PR #44 (#37) made a plan runtime data: grants stored in `RegistryDO`, written
through one path with ownership checks, expiry, the claiming of an address key
onto the provider subject, and an audit trail. #46 drafted Stripe as a second
plan source, a ledger read at sign-in and refresh, and none of those rules
applied to it. And a purchase had to run end to end before a plan relied on it.

## Decision

1. **A purchase is a grant.** The Stripe webhook (`handleStripeWebhook`,
   `src/billing/stripe.ts`, PR #68) writes the grant an admin would write, with
   `source: "purchase"` (`purchaseGrant`), under the provider subject the user
   id was built from (`grantKeyForUser`). A plan resolves one way, in
   `resolvePlan`: a `BELLMAN_USERS` override, then a stored grant for a stable
   key, then free. A grant gives plan, role and org, never `userId` (ADR 0013).
2. **Stripe is the record, and the grant follows the ledger.** An event says a
   subscription changed, not what it is now, so the ledger reads it from Stripe
   with a restricted key and records that (`syncSubscription`, `BillingLedger`
   in `AuthDO`). `reconcilePurchase` then writes the best plan across the user's
   customers and subscriptions, in the user's queue (`AuthDO.reconcile`, #69).
   A subscription that sells two plans grants none.
3. **Billing touches only the grants billing wrote.** `putGrantIfSource` and
   `deleteGrantIfSource` refuse a grant of another source, so a lapsed
   subscription never revokes a comped plan; the clash is logged, not retried.
   `/upgrade` stops before Stripe when an override or a hand-written grant
   decides the plan, or when no purchase could be filed (`canPurchaseAs`). A
   team buyer becomes admin of `org_<userId>` and cannot write grants.
4. **Switches are vars; credentials are secrets.** `BELLMAN_BILLING` (`off`,
   `shadow` or `on`) and `BELLMAN_HOSTED_SEAT` (ADR 0002) sit under `[vars]` in
   `wrangler.toml`, so that turning either on is a reviewed commit and not a
   dashboard click; `BELLMAN_PANEL_ORIGINS` is a var for the same reason. Both
   switches read an unknown value as off and log it (`billingMode`,
   `hostedSeatOn`). The Stripe values, `BELLMAN_KEYS` and `ANTHROPIC_API_KEY`
   are secrets, and setting one switches nothing on.
5. **`BELLMAN_BILLING` gates resolution, not the write.** Under `shadow` and `on`
   the webhook records payments and writes grants. `honourPurchases`, read by
   `firstGrant` at sign-in and at every refresh, counts a `purchase` grant only
   under `on`. Under `off` the webhook answers 503 and `/upgrade` serves no
   links. Without both Stripe secrets, `shadow` and `on` are off.

## Consequences

- Billing went to `shadow` on 2026-10-01 (PR #107) and to `on` on 2026-10-06
  (PR #182, closing #39). Purchases seen in shadow took effect with that deploy,
  because shadow had written their grants.
- Switching billing off takes paid plans away at each token's next refresh and
  keeps the grants, so switching it on again restores them with no new event.
  Grants written by hand resolve whatever the switch says.
- The ledger is in `AuthDO` and the grant in `RegistryDO`, so a reconcile spans
  two objects; `AuthDO`'s in-memory per-user queue orders it, which holds
  because there is one `AuthDO` (ADR 0006).
- A purchase grant has no expiry: the webhook removes it when the subscription
  stops paying, and a missed cancellation is the failure this accepts.
- Adding people to a purchased org is not built.
