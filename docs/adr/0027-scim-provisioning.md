# ADR 0027 — SCIM provisions an org's members, and a deprovision ends the sign-in and freezes the rooms

**Date:** 2026-10-22 · **Status:** accepted · **Closes:** #56 · **Spec:** `docs/superpowers/specs/2026-10-22-scim-design.md` · **Plan:** `docs/superpowers/plans/2026-10-22-scim.md`

## Context

SSO (ADR 0025) answers "can this person sign in" and not "should they still be able to". A grant
persisted until an admin removed it by hand, and nothing noticed a departure; the person who left last
month and still holds a working login is the audit finding a buyer looks for first. Every IdP that does
SSO also does SCIM: Okta and Entra ID push a user when they are assigned the app, update them, and
deactivate them when they are unassigned or leave.

Two things the code did not have. An SSO member's address was stored nowhere: `provisionSsoMember`
seated `sso:<orgId>:<sub>` and used the vouched address once, to claim an admin's `email:` grant, so a
connector matching people by `userName` would have pushed anyone who signed in first as a second seat.
And `freezeSession`, which #47 built for a lapse, had no production caller: both stores implemented it
and nothing froze a room.

## Decision

1. **One SCIM bearer token per org, hashed, scoped to SCIM alone.** `POST /org/scim/token` mints
   `bst_<32 random bytes>`, stores its SHA-256 under `sc:<orgId>` and the lookup `sh:<hash>`, replacing
   the previous token in the same transaction, and shows the token once. It is not a JWT: `caller` never
   admits it, so a leaked token can provision and deprovision and nothing else.
2. **A SCIM user is a registry row naming the member's grant; membership stays the grant.**
   `su:<orgId>:<id>` holds `userName` (the address, lowercased whole), `externalId`, `active` and `key`,
   the grant key the person is seated under. An active user holds a `team` member grant from `scim`; an
   inactive one holds none and the row stays, so the IdP can read it back.
3. **A directory by address, written by SCIM and by the SSO sign-in alike.** `sn:<orgId>:<address>`
   maps an address to the key it is seated under; `sk:<key>` maps a key to the SCIM user managing it;
   `moveGrant` re-points both. The SSO sign-in takes the vouched address and, in the seat's own
   transaction, claims an `email:` grant onto the subject and writes the directory, so a push after a
   first sign-in links rather than seats again, and a push before it is claimed at that sign-in.
4. **A deprovision ends the sign-in, frees the seat, leaves every room and freezes the rooms they
   created.** `active: false` by PATCH, PUT or DELETE deletes the grant in the registry; then, outside it
   and idempotently, every handle of theirs is removed from every open room with a `member_evicted` naming
   `reason: "deprovisioned"`, and every open room they created is frozen with a `room_frozen` row, the
   first production use of `freezeSession`. Frozen is not closed: members stay, history stays readable.
   A reactivation seats them again as a member and thaws. The sign-in refusal (`AccessRemoved`, beside
   `SsoRequired` under `SignInRefused`) runs where plans resolve, so a token refresh, a panel session and
   a hosted room's month turn stop them within `ACCESS_TOKEN_TTL_SECONDS`.
5. **The refusal and the whole-platform walk apply only to the IdP's own subject.** For an `sso:` key of
   the managing org the sign-in is over everywhere. For a personal GitHub or Google account that an
   address linked to the org, a deactivation removes the org's grant and touches only rooms whose org is
   this one; the account signs in as free. Otherwise an org could end a stranger's sign-in by pushing
   their address.
6. **The IdP owns the members it pushed.** `DELETE /org/members/:key` on a key an active SCIM user
   manages is `409 managed`: removed by hand, the next sync would seat them again. Roles stay Bellman's.
   A rename or a reactivation onto an address another org holds a grant under is `409 conflict`.
7. **Groups are served, not managed.** `GET /scim/v2/Groups` lists none and a write is 501: a pushed
   group would have to mean something, and roles are not settled.

## Consequences

- No group-to-role mapping, no transfer of a frozen room, no schedule that re-checks the IdP, and no
  panel page yet: the dash gets `GET /org/scim` and the two token routes.
- The room walk is not atomic with the registry write (ARCHITECTURE section 9) and does not need to
  be: the write is the decision, the walk is its consequence, and a repeat of the deactivation finishes a
  walk cut short. A person's tokens end on their next re-check whatever the walk did.
- An address is matched exactly as lowercased: an admin who seated `Bo@Acme.test` by hand has a
  separate key from the `bo@acme.test` the IdP pushes, and that push takes a seat of its own.
- The list is cut from a scan of at most 1,000 of the org's rows; a larger org pages wrong past it.
- The IdP may push an address under a domain the org has not verified, as an admin may seat one; the
  cross-tenant checks, not the domain, are what protect other orgs' seats.
