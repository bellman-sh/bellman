# ADR 0023 — An org is a record, and its members are its grants

**Date:** 2026-10-21 · **Status:** accepted · **Closes:** #53 · **Spec:** `docs/superpowers/specs/2026-10-21-orgs-and-sso-design.md` (D1 to D8)

## Context

An org was a string: whatever `orgId` a grant or `BELLMAN_USERS` carried, and the two things
Team is sold on, `orgScoping` and `audit`, keyed off it. Nothing created one, owned one or
counted a seat, and a purchased team admin could add nobody to their org: `/admin/grants`
refuses a purchased admin's writes, rightly while membership had no lifetime tied to the
purchase, since one month of team would otherwise buy permanent team. SSO (#55) has nowhere to
hang a per-org identity provider until the org is a record.

## Decision

1. **The `Org` record lives in `RegistryDO`, under `org:<orgId>`,** beside the grants and the
   org index, so a seat is decided in the transaction that takes it and the rows an org change
   owes go out through the registry's outbox (ADR 0006). It holds a name, exactly one owner,
   a seat count, a source (`purchase` or `operator`), a standing (`active`), and the fields SSO
   will fill (`requireSso`, `domains`), written now so no row needs migrating.
2. **Membership is the grant.** A member is a `PlanGrant` whose `orgId` names the org; the role
   is the grant's; the seats used are the live grants in the org's index (`countOrgMembers`).
   There is no `OrgMember` record to disagree with it. A person is in one org, since
   `Identity.orgId` is singular.
3. **The seat cap is enforced inside `putGrantIfOwned`,** which answers `full` when the org has a
   record, the key is not already a member of it, and the live grants have reached `seats`. A role
   change takes no seat. Billing's write (`putGrantIfSource`) does not check, so an org can sit one
   over its count after a lapse and a return. An org with no record has no cap.
4. **A team purchase creates the org, in `reconcilePurchase`.** `readSubscription` sums the
   seats over the items that sell the plan; `activatePurchasedOrg` creates the record named by
   its id, or sets its seats and `active: true` and nothing else, so a name its owner gave it
   survives every Stripe event. A subscription that stops paying, or moves to a plan that scopes
   no org, deactivates it after the grant goes.
5. **A lapsed org keeps its members and loses the plan.** `active: false` makes every grant in the
   org resolve to `free` with the role and the org kept, through `standingOf` in `firstGrant`, the
   one function sign-in, a refresh, a panel session's re-check and a hosted room's month turn
   all pass through. An org with no record is active; an operator org always is.
6. **The org admin's routes are cookie-reachable,** `src/http/orgs.ts` on the audit routes'
   rules: `GET` and `PATCH /org`, `GET` and `POST /org/members`, `PATCH` and `DELETE
   /org/members/:key`. A purchased admin writes here: a grant in a recorded org lapses with the
   org, can only be `team` in the admin's own org, and is counted against the seats bought.
   `/admin/grants` stays bearer-only and operator-granted.
7. **The operator creates and resizes an org that was not bought,** `POST /admin/orgs` and
   `PATCH /admin/orgs/:orgId` on `operatorGate`, the owner's admin grant written in the same
   transaction as the record (`createOrg`).

## Consequences

- An org named only in `BELLMAN_USERS` or in older grants has no record: no cap, always active,
  no member routes, `/admin/grants` as before. The operator gives it a record when its admin
  should have the routes.
- The owner's own purchase grant still goes with the subscription, so a lapsed org's owner falls
  to free with no org until they subscribe again; the members it kept are resolved free meanwhile.
- `org_created` and `org_updated` rows are filed under `org:<orgId>` and view with no room, as
  grant rows do.
- Rows the ledger recorded before seats were read count as one seat until the next Stripe event
  re-reads the subscription.
- The panel's org, members and billing pages are dash work; this PR gives them the JSON.
