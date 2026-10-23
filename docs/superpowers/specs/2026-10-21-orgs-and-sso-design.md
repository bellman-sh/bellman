# Orgs as a real object, and SSO on top of them

**Issues:** #53 (orgs: creation, membership, ownership, seats) and #55 (SSO: per-org OIDC,
domain verification, JIT provisioning). #55 says #53 blocks it, and it does: per-org IdP
config has nowhere to hang until an org is a record. Two PRs, in that order. #54 (add a
teammate by email) falls out of PR 1's member routes, since a grant key may be an address.

**Status:** design settled 2026-10-21. The choices below were made by the builder, not
agreed in conversation: the owner asked for the work to start and said the shape was open.
Each decision says why, so any of them can be reversed with the reason in hand.

**Scope:** the `Org` record and its store methods, membership as the grant it already is,
seats from Stripe, an org's standing when its subscription stops paying, the org admin's
routes the control panel will call, the operator's org routes; then one OIDC provider
configured per org, domain verification by DNS, routing a sign-in by its email's domain,
just-in-time provisioning into the org, and `require_sso` with the owner as the break-glass.
SAML, SCIM (#56), account linking, org deletion, and the panel's pages are follow-ups.

## Problem

An org is a string. `Identity.orgId` is whatever a grant or `BELLMAN_USERS` says, and the two
things Team is sold on, `orgScoping` and `audit`, key off it. Nothing creates one, nothing
owns one, nothing counts a seat, and a purchased team admin cannot add anyone to their org at
all (`/admin/grants` refuses a purchased admin's writes, for a reason that is right while
membership has no lifetime tied to the purchase: one month of team would buy permanent team).

Sign-in is `PROVIDERS = { github, google }`, compiled in. Every company that would buy Team
authenticates through Okta, Entra ID, Google Workspace or JumpCloud, and asks for SSO before
anything else in this repo. Without domain verification anyone could claim `@acme.com`;
without JIT provisioning a verified sign-in lands as `free`, org-less; without enforcement SSO
is advisory.

## Where it stands, and what is reused

- `PlanGrant` is `{ key, plan, role, orgId, source, grantedAt, grantedBy, expiresAt }`,
  written through guarded store methods that audit in the same transaction (ADR 0014,
  `src/grant-audit.ts`), and indexed per org (`go:<org>:<key>`, `src/grant-index.ts`).
- A plan resolves one way, `resolvePlan` in `src/oauth/routes.ts`: override, then a stored
  grant for a stable key, then free; `replanOnRefresh` repeats it over the subject key alone.
- A team purchase writes the buyer an admin grant in `org_<userId>` (`purchaseGrant`), and
  `reconcilePurchase` rewrites it from the ledger on every Stripe event, inside `AuthDO`'s
  per-user queue (ADR 0006, decision 3).
- `Provider` is one interface with `authorizeUrl` and `exchange`, and `ProviderProfile`
  normalises what comes back; `identityKeys` puts `<provider>:<subject>` first.
- The org admin's HTTP surface already exists in the shape the panel needs: `src/http/audit.ts`
  is a cookie-reachable, CORS-granted, org-scoped route module on `auditRefusal`'s predicate.

## Decisions: PR 1, orgs (#53)

### D1. The `Org` record lives in `RegistryDO`, beside the grants

```ts
interface Org {
  orgId: string;          // isOrgId grammar, never reused
  name: string;           // display, 1 to 80 characters, trimmed
  ownerUserId: string;    // exactly one, never changes
  seats: number;          // how many grants the org may hold, the owner's included
  source: "purchase" | "operator";
  active: boolean;        // D5. Always true for an operator org
  createdAt: number;
  requireSso: boolean;    // PR 2 (D13); false until then
  domains: OrgDomain[];   // PR 2 (D11); [] until then
}
```

Stored under `org:<orgId>`. The registry is the singleton that already holds every grant and
the org index, so creating an org, counting its seats and writing a member are one object and
one transaction (ADR 0006, decision 5): no second object, no outbox hop for the decision. The
audit rows an org change owes go out through the registry's existing outbox.

### D2. Membership is the grant. There is no `OrgMember` record

A member of an org is a grant whose `orgId` names it. The role is the grant's role, the key is
the member's stable identity key, and the seat count is the number of live grants in the org's
index (`countOrgMembers`, a prefix scan of `go:<org>:`). #53 proposed a separate `OrgMember`
and warned that two records for who is in the org disagree; the grant already is that record,
resolved on every sign-in, listed by `/admin/grants`, audited on every change. So billing
counts seats, the grant store holds members, and nothing is derived from anything else.

`user_id` in a member listing is derived from the key where it can be (`github:4242` is
`u_github_4242`; `sso:` keys per D10) and null for an address not yet claimed onto a subject.

Multi-org stays out: `Identity.orgId` is singular and every tenancy rule reads it. A key
already granted in another org is a `conflict`, as `putGrantIfOwned` answers today.

### D3. The seat cap is enforced inside the guarded write

`putGrantIfOwned` gains a third answer, `"full"`: inside its transaction, when the grant's org
has a record and the key is not already a member of that org, it counts the org's live grants
and refuses at `seats`. A role change for an existing member takes no seat. An org with no
record (one that exists only as a string in `BELLMAN_USERS` or in older grants) has no cap, as
today. `putGrantIfSource`, billing's write, does not check: the owner's grant is seated by the
subscription that bought the org, and after a lapse and a return (D5) the members kept may
already fill the seats. That can leave an org one over its count until an admin removes
someone, and the org page shows `seats_used` so they can see it.

ponytail: the count is a scan of the org's index on every member write, bounded by the org's
own size. A seat counter row is the upgrade if an org ever holds thousands.

### D4. A team purchase creates the org, in `reconcilePurchase`

`SubscriptionReading` gains `seats`: the sum of `quantity` over the subscription's items whose
price names the plan, 1 when an item carries none. `SubscriptionState` stores it and
`PaidPlan` carries the chosen subscription's (absent on a state recorded before this field,
read as 1: the safe direction, and the next Stripe event re-reads the subscription and
corrects it). The team price's three-seat minimum is Stripe's to enforce on the Payment Link.

`reconcilePurchase` then does, in the user's queue as today:

- paid and the plan scopes an org: `activatePurchasedOrg(orgForUser(userId), userId, seats, audit)`,
  then the grant write it does now. The method creates the record with `name = orgId` when
  there is none (the owner renames it) and otherwise sets `seats` and `active: true`, never
  touching the name or the owner. Unchanged values write nothing and audit nothing.
- otherwise: the grant delete it does now, then `deactivateOrg(orgForUser(userId), audit)`,
  a no-op when no record exists. A buyer who moves from team to pro deactivates their org
  the same way: nobody is paying for its seats.

`PurchaseGrantStore` gains both methods. The ledger stays the record and the org follows it,
exactly as the grant does (ADR 0014, decision 2).

### D5. A lapsed org keeps its members and loses the plan

`active: false` is what a lapse means. Every grant in the org stays, so a failed card does not
wipe a roster, and the plan each grant resolves to becomes `free` while the org is inactive
(role and org are kept). One rule, in one place: `firstGrant`'s result passes through
`standingOf(plans, grant)`, which reads the org record when the grant names an org, and both
`resolvePlan` and `replanOnRefresh` go through it, so a token refresh and a panel session
re-check see the lapse within `ACCESS_TOKEN_TTL_SECONDS` as they see a revocation. An org
with no record is active. An operator org is always active.

The owner's own purchase grant is deleted by the reconcile as today, so the owner falls to
free with no org until they subscribe again, at which point the org is re-activated with the
members it kept. This is the "frozen, not closed" rule the rooms already follow.

### D6. The org admin's routes, cookie-reachable, in `src/http/orgs.ts`

On the audit routes' rules: `deps.caller` (bearer or panel cookie), CORS for the panel's
origins, the preflight, `csrfRefusal` on every write, one JSON error shape, and the org always
the caller's own. An admin is what `auditRefusal` admits (team plan, admin role, an org), which
with D5 means the org is active. A route that needs the record answers `404 no_org` when the
caller's org has none: those orgs are administered through `/admin/grants` as today, until the
operator creates the record (D7).

- `GET /org`: for anyone whose identity names an org with a record, member or admin.
  `{ org_id, name, owner_user_id, seats, seats_used, active, source, created_at, require_sso,
  domains, your_role }`.
- `PATCH /org` `{ name }`: admin. 1 to 80 characters after trimming. (PR 2 adds `require_sso`.)
- `GET /org/members`: admin. `{ members: [{ key, user_id, role, plan, source, granted_at,
  expires_at, owner }] }`, from `listGrants(200, orgId)`.
- `POST /org/members` `{ key, role }`: admin. `key` must pass `isStableIdentityKey`; `role` is
  `member` or `admin`. Writes `{ plan: "team", role, orgId, source: "org", grantedBy: the admin,
  expiresAt: null }` through `putGrantIfOwned`: 201 with the member, `409 full` at the cap,
  `409 conflict` for a key granted in another org. Amended by ADR 0027: that write is for an
  identity the org owns by its form, and any other key gets an invite, 202, which the roster
  lists and `DELETE` withdraws, until the person accepts it at a sign-in (D13).
- `PATCH /org/members/:key` `{ role }`: admin. The owner's grant cannot be demoted (`409 owner`).
- `DELETE /org/members/:key`: admin. The owner cannot be removed (`409 owner`); a key with no
  grant in the org is 404. An admin may remove themselves.

A purchased admin writes here. The argument that keeps them off `/admin/grants` (a self-written
grant outlives the subscription) no longer holds for a grant in a recorded org: it resolves to
free the moment the org is inactive (D5), it can only be `team` in the admin's own org, and it
is counted against the seats the subscription bought. `/admin/grants` is unchanged, bearer-only
and operator-granted admins only, and its writes now pass through D3's cap too.

The Worker mounts the module under `/org` behind `unconfigured` and `routeGate`, as `/audit`
is; the Node server mounts it as it mounts `/presets`.

### D7. The operator creates and resizes orgs that were not bought

Two routes in `src/oauth/routes.ts` on `operatorGate` (bearer only, `BELLMAN_OPERATORS`):

- `POST /admin/orgs` `{ org_id, name, owner_key, seats }`: `org_id` passes `isOrgId`,
  `owner_key` is a `<provider>:<subject>` key (an address names no user id yet, so it cannot
  own), `seats` is an integer of at least 1. One transaction (`createOrg`) writes the record,
  `source: "operator"`, `active: true`, and the owner's admin grant `{ plan: "team", role:
  "admin", source: "operator" }`. `409 exists` for an org id in use; `409 conflict` when the
  owner's key is granted in another org.
- `PATCH /admin/orgs/:orgId` `{ name?, seats? }`: `updateOrg`. Nothing else is operator-editable:
  `active` is billing's for a purchased org, and an operator org is always active.

`BELLMAN_USERS` keeps naming orgs by string. An override's org with no record behaves as
today; the operator gives it a record when its admin should get the routes in D6.

### D8. Audit rows

`org_created` (actor: the operator, or `stripe`), `org_updated` with the fields that changed
(`name`, `seats`, `active`, `require_sso`), and nothing for a change that changed nothing.
Filed under `sessionId: "org:<orgId>"` as grant rows are under `grant:<key>`; `entryView`
reads both prefixes as "no room". Member changes are the `plan_granted` and `plan_revoked`
rows the grant path already writes. Both stores produce the same rows, held by the contract.

## Decisions: PR 2, SSO (#55)

### D9. One generic OIDC provider, configured per org, discovered when saved

```ts
interface OrgIdp {
  protocol: "oidc";          // the field SAML would widen; nothing reads another value
  issuer: string;            // https, as the IdP's discovery document states it
  clientId: string;
  clientSecret: string;      // sealed (D14); never plaintext in the store
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string | null;
  configuredAt: number;
  configuredBy: string;
}
```

Stored under `oi:<orgId>` in the registry, apart from the `Org` record, so `getOrg` never
hands a secret to a caller that wanted a name. `PUT /org/idp` fetches
`<issuer>/.well-known/openid-configuration`, requires `issuer` in the document to equal the
one given and the two endpoints to be https, and stores what it found. Sign-in then reads the
stored endpoints and fetches no discovery document. An IdP that moves an endpoint is re-saved
by its admin, and the 400 the save gives names what was wrong.

OIDC first and SAML never in this PR: OIDC covers Okta, Entra ID, Google Workspace and
JumpCloud, and SAML is a different protocol, not a variant. The `protocol` field and the
separate `oi:` row are the two places a SAML config would differ, and both are already there.

### D10. The subject is the stable key; the user id encodes the org and the subject

An IdP's `sub` is stable within its issuer and opaque. The identity key is
`sso:<orgId>:<sub>`, readable in a member listing, unambiguous because an org id holds no
colon. The user id is `u_sso_<base64url(orgId + ":" + sub)>`: the user id grammar is letters,
digits, `-` and `_`, the org id grammar is the same set, so no separator could split the two
inside a user id, and base64url is reversible, which `signedInPlan` needs to read a hosted
room creator's plan again. `sub` is 1 to 128 printable ASCII characters; anything else is
refused at sign-in.

`isStableIdentityKey` admits `sso:` keys whose org passes `isOrgId` and whose sub passes that
grammar; `immutableKeys` keeps them, since an IdP subject is as immutable as a GitHub id;
`grantKeys` therefore resolves grants against them. `identityKeys` for an SSO profile is
`[sso:<org>:<sub>, email:<address>]`, the address only when D11 verified its domain for this
org, so `claimGrant` moves an admin's `email:` grant onto the subject at the first sign-in, as
it does for GitHub. `grantKeyForUser` stays github and google: an SSO user does not buy a plan
for themselves, and `/upgrade` tells them so.

### D11. A domain does nothing until a DNS TXT record proves it

`POST /org/domains { domain }` stores `{ domain, token, verifiedAt: null }` on the org and
answers the record to publish: name `_bellman.<domain>`, type TXT, value
`bellman-verify=<token>`, the token 16 random bytes in base64url. `POST
/org/domains/:domain/verify` resolves that name over DNS-over-HTTPS
(`https://cloudflare-dns.com/dns-query`, `accept: application/dns-json`, a fetch and no
dependency) and, when a TXT answer carries the value, runs `verifyDomain` in the registry:
one transaction that marks the claim and writes `od:<domain> -> orgId`, or answers `taken`
when another org verified it first. `DELETE /org/domains/:domain` removes the claim and the
index row. The domain is lowercased and must match a hostname grammar (labels of letters,
digits and hyphens, a TLD of letters, at most 253 characters).

`orgForDomain(domain)` reads the index, and only verified domains are in it, so routing (D12)
and enforcement (D13) see nothing unverified. A claim is checked once; re-checking on a
schedule is a follow-up, and the record staying published is the usual arrangement.

### D12. Sign-in is routed by email domain, with the provider buttons as the fallback

The `/authorize` and `/auth/signin` pages keep their buttons and gain a work-email field. It
submits to `GET /authorize/sso?req=<state>&email=<address>`: the domain after the last `@`,
`orgForDomain`, the org's IdP, and a 302 to its authorization endpoint with `scope=openid
email profile`, `state=<req>` (the same signed state the buttons carry, so the three audiences
and the panel's nonce binding work unchanged), a `nonce` that is the SHA-256 of the state, and
`redirect_uri=<issuer>/callback/sso/<orgId>`. An org's IdP is registered with that one
redirect URI, which is what an Okta or Entra admin expects. No match, or an org with no IdP,
answers the page again with "no single sign-on is set up for that domain" above the buttons.

`GET /callback/sso/:orgId` verifies the state as the provider callbacks do, loads the org's
IdP, exchanges the code at the token endpoint with the client id and the unsealed secret, and
reads the `id_token`: `iss` must equal the configured issuer, `aud` must name the client id,
`exp` must be ahead, `nonce` must match, `sub` must be present. The signature is not checked:
the token arrived in the token endpoint's own response over TLS, the case OIDC Core 3.1.3.7
step 6 allows, and the endpoint is the one the org's admin configured. ponytail: a JWKS check
is the upgrade if an IdP ever answers from somewhere other than its issuer. `email` and `name`
come from the id token, or from `userinfo_endpoint` when the token lacks them.

The result is a `ProviderProfile` with `provider: "sso"`, `subject: "<orgId>:<sub>"`, `label`
the name or the address, and `email` only when its domain is one the org verified. It then
runs the same tail as a GitHub profile: the authorization code for a client, the panel
session, and the plan through `resolvePlan`. `/upgrade` offers no SSO: an SSO user's plan is
their org's.

### D13. Provisioning on first sign-in, and `require_sso`

Before `resolvePlan`, the SSO callback calls `provisionSsoMember(orgId, key, now, audit)`: one
registry transaction that answers `exists` when the key already has a grant, writes
`{ plan: "team", role: "member", orgId, source: "sso", grantedBy: "sso", expiresAt: null }`
when it does not and a seat is free, and `full` otherwise. `full` ends the sign-in with a page
that says the org has no free seat and to ask its admin; nothing is minted. An inactive org
still provisions: the member's plan is free until the org pays (D5), and the seat they took is
the one they will hold. The default role is `member`, not a setting; an admin promotes.

`PATCH /org { require_sso: true }` needs an IdP and at least one verified domain, or 409.
With it on, a GitHub or Google sign-in is refused when it would land in this org or carries a
verified address under one of its domains, unless the person is the org's owner: that is the
break-glass, the owner's original provider, the one every SSO product keeps. `ssoRefusal` is
asked by `resolvePlan` after the plan resolves and by `replanOnRefresh` over the stored keys, so
a token or a panel session from before the switch stops at its next re-check rather than
running on for a month. An SSO profile, an operator override and the owner are exempt. The
refusal is `SsoRequired`, which the authorize callback turns into `access_denied` naming the
org, the panel and upgrade pages into a page, `/token` into `invalid_grant` without restoring
the refresh token, and `sessionCaller` into the end of the session.

What this does to a person who already had a personal account under `jesse@acme.com` is the
account-linking problem #55 names, and it is not solved here: with `require_sso` on they sign
in through SSO as `u_sso_…`, a different account, and their earlier rooms stay with the old
one. The page the refusal shows says so. Admins should add existing members by their GitHub or
Google key before turning the switch on if they want those accounts kept; linking the two is a
follow-up.

**Amended by ADR 0027 (seat consent).** A sign-in lands in this org only by a grant that took
effect, never by an invite. A seat takes effect without the person only for an identity the org
owns by its form: a subject of its own IdP, as provisioning above writes, and an address under a
domain whose `verifiedAt` is set, which the switch's domain half already covers. An admin's seat
for any other key, a GitHub or Google key among them, is an invite, and the person accepts it on
a page their next sign-in stops at; the org has none of what a seat carries until then, so it
refuses none of their sign-ins. Accepting into an org whose switch is on is refused, since the
account would be refused at its next sign-in by the org it had just joined, so the existing
members above are added before the switch, and each accepts.

### D14. The client secret is sealed with a Worker secret

`src/oauth/sealed.ts`: AES-256-GCM over a key derived by HKDF-SHA256 from `BELLMAN_SEAL_SECRET`
when set and from `BELLMAN_TOKEN_SECRET` otherwise, a random 96-bit nonce, the output
`v1.<nonce>.<ciphertext>` in base64url. The route seals before `putOrgIdp` and unseals after
`getOrgIdp`; `GET /org/idp` answers `client_secret_set: true` and never the value. A registry
dump therefore does not yield an IdP secret without the Worker secret too, which is the posture
#55 asked to have stated. Rotating the seal secret means every org re-enters its secret, so
`BELLMAN_SEAL_SECRET` exists to keep that apart from a token secret rotation.

## What this does not do

- SAML, SCIM (#56), org deletion, a second org for one person, account linking, a configurable
  default role, periodic re-verification of a domain, and the control panel's pages. The panel
  gets the JSON above; its org, members and SSO pages are dash work.
- Change `BELLMAN_USERS` or the key-table path. An override still supplies a whole identity
  and is exempt from `require_sso`.
- Give a purchased admin `/admin/grants`. The member routes are theirs.

## Errors

- Org routes: 401 with no caller, the CSRF refusal, 403 in `auditRefusal`'s words, `404 no_org`
  for an org with no record, 400 for a body that is not the shape named, `409 full`, `409
  conflict`, `409 owner`, `409 exists`, `409 taken`, `409 unverified` with the TXT values found,
  `400 discovery` with what the IdP's document was missing.
- Sign-in: an unknown domain shows the page again; an org without an IdP likewise; a seat-full
  org shows a page; an id token that fails a claim check is `access_denied` as a failed
  provider exchange is today, with the claim named in the log and not on the page.
- A DNS-over-HTTPS failure is `502 dns` on the verify route, not an unverified answer.

## Testing

PR 1:

- `tests/helpers/store-contract.ts`: create, get and update an org; `createOrg` writes the owner's
  grant in the same operation and refuses an id in use or a key granted elsewhere;
  `putGrantIfOwned` answers `full` at the cap and `written` for a role change at the cap;
  `countOrgMembers`; `activatePurchasedOrg` creates then updates and keeps a renamed name;
  `deactivateOrg` on a missing org is a no-op; the audit rows each writes, and none for a
  no-op. Runs against both stores through `worker-tests/store-contract.test.ts`.
- `tests/billing.test.ts`: a subscription's `seats` from item quantities, absent as 1.
- `tests/billing-grants.test.ts`: `reconcilePurchase` activates the org with the seats and then
  writes the grant; a lapse deletes the grant and deactivates; pro after team deactivates.
- `tests/oauth-flow.test.ts`: a grant in an inactive org signs in as free with the org kept, and
  a refresh re-checks it; an org with no record resolves as before.
- `tests/http-orgs.test.ts`: every route in D6 over a cookie and a bearer, the CSRF refusal, the
  member predicate (a member reads `/org` and nothing else; a free caller is 403), the owner
  protections, `full` and `conflict`, and `/admin/orgs` on the operator gate.

PR 2:

- `tests/identity-keys.test.ts`: `sso:` keys are stable and immutable; the user id round-trips.
- `tests/sealed.test.ts`: seal, unseal, a tampered ciphertext and a wrong secret refuse.
- `tests/oidc.test.ts`: discovery validation, the authorize URL, the exchange over a fake IdP
  with each claim check made to fail once, userinfo as the fallback.
- `tests/dns.test.ts`: a TXT answer with the token, without it, quoted and split segments, a
  DoH error.
- `tests/sso-flow.test.ts`: the whole flow over a fake IdP and fake DoH: claim and verify a
  domain, save the IdP, `/authorize` routes the address to the IdP, the callback provisions a
  member and mints a code, a second sign-in provisions nothing, a full org is refused, the panel
  flow with the nonce, `require_sso` refuses GitHub for a member and for a verified address and
  admits the owner, a refresh after the switch is `invalid_grant`, an operator override is exempt.
- `tests/http-orgs.test.ts`: the IdP and domain routes, the secret never returned, `require_sso`
  refused without an IdP or a verified domain.
- `tests/helpers/store-contract.ts`: `putOrgIdp`/`getOrgIdp`/`deleteOrgIdp`, the domain claim,
  verify, `taken`, release and `orgForDomain`, and `provisionSsoMember`'s three answers.

## Files

PR 1: `src/types.ts` (`Org`, `OrgDomain`), `src/store.ts` (the methods, `MemoryStore`),
`src/store-do.ts` (`RegistryDO`, `DurableObjectStore`), `src/grant-index.ts` (`orgKey`),
`src/grant-audit.ts` (`orgAuditEntries`), `src/billing/subscription.ts`, `src/billing/ledger.ts`,
`src/billing/grants.ts`, `src/oauth/routes.ts` (`standingOf`, `PlanStore`, `/admin/orgs`),
`src/http/orgs.ts`, `src/http/audit.ts` (`entryView`), `src/worker.ts`, `src/app.ts`,
`docs/adr/0024-orgs-as-a-record.md`, `README.md`, `docs/ARCHITECTURE.md` sections 5 and 6,
`docs-site/src/content/docs/guides/teams.md`.

PR 2: `src/types.ts` (`OrgIdp`), `src/oauth/providers.ts` (the `sso` profile, keys and ids),
`src/oauth/oidc.ts`, `src/oauth/dns.ts`, `src/oauth/sealed.ts`, `src/oauth/routes.ts` (the pages,
`/authorize/sso`, `/callback/sso/:orgId`, `SsoRequired`, `ssoRefusal`), `src/http/orgs.ts` (IdP and
domains, `require_sso`), `src/store.ts`, `src/store-do.ts`, `src/worker.ts` (`BELLMAN_SEAL_SECRET`),
`docs/adr/0025-sso-per-org-oidc.md`, `README.md`, `docs/ARCHITECTURE.md` section 6, the teams guide.
