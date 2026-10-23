# ADR 0027 — A seat takes effect when its person accepts it

**Date:** 2026-10-23 · **Status:** accepted · **Amends:** ADR 0024 (decisions 2 and 6), ADR 0025 (decision 6)

## Context

A seat in an org is a grant (ADR 0024), and the grant puts the org on the person's identity. Everything
that reads `Identity.orgId` then acts for the org: `require_sso` decides whether their GitHub or Google
sign-in is let through, their plan becomes the org's, the rooms they sit in are filed under the org for
its admins to list and read once closed, and the org's audit stream records those rooms. That makes a
seat the person's to take, and not only an admin's to give.

## Decision

1. **An org owns some identities by their form**, and a seat for one takes effect as it did: a subject
   of its own IdP (`sso:<this org>:…`), and an address under a domain whose `verifiedAt` is set. The org
   already answers for both: it runs the IdP, and it proved the domain. `ownsByForm` in `src/orgs.ts` is
   the one rule.
2. **Every other seat is an invite**, an `OrgInvite` kept in `RegistryDO` under `io:<org>:<key>` and
   `iv:<key>:<org>`, apart from the grants, so nothing that reads a grant can take one for a seat: not
   `firstGrant`, so no plan, no org on the identity and nothing for `ssoRefusal`; not the seat count; not
   the rooms an org sat in. `POST /org/members` answers it with 202 and `status: "invited"`, the roster
   lists invites after members, and `DELETE /org/members/:key` withdraws one. Whether the key holds
   another org's grant is not asked, so an invite tells the admin nothing of the person. An invite takes
   no seat, and an org holds at most 200 at once. `member_invited` and `invite_withdrawn` are filed in
   the org's stream, naming the key the admin typed.
3. **The person answers at their next sign-in.** After the provider's exchange and before the plan
   resolves, a GitHub or Google sign-in whose keys, the subject and the verified address, an org has
   invited stops at a page naming each such org, with Join, Decline, and a way on without answering,
   which leaves the invites for the next sign-in. The page's forms carry the sign-in signed, under its
   own audience and for ten minutes, as the provider round trip carries its state, and a panel sign-in's
   answer counts only from the browser holding that sign-in's nonce cookie. An org's name is escaped
   like everything else on the page. An SSO sign-in is its org's by its form and stops at no page.
4. **Join writes the grant through `putGrantIfOwned`**, under the provider subject as a claimed address
   grant is: `team`, the invite's role, `source: "invite"`, `grantedBy` the admin who invited, with the
   `plan_granted` row naming the person as its actor. A full org refuses it as seating does, and so does
   any grant the sign-in's keys already hold, another org's or a plan of the person's own, since a
   person is in one org. An org with `require_sso` on refuses it too: the account would be refused at
   its next sign-in by the org it had just joined. A refused Join leaves the invite. Decline removes the
   org's invites of the sign-in's keys and files nothing of the person in the org's stream.
5. **`require_sso` refuses by a grant that took effect, never by an invite.** `ssoRefusal` reads the
   plan's org, which only a grant or an operator override sets. Its domain half is unchanged: an address
   under a verified domain is the org's by its form.

## Consequences

- Grants written before this keep their effect. An admin's seat was written `source: "org"` with the
  admin as `grantedBy`; from here on `source: "org"` is written only for an identity the org owns by its
  form, and an accepted invite is `source: "invite"`. An address grant claimed onto a subject at sign-in
  keeps its source, so `grantedAt` before this change is the cleaner cut for finding the older seats.
- `/admin/grants`, whose writes are for admins `BELLMAN_USERS` names, and the operator's `POST /admin/orgs`
  still seat directly: both are the operator's.
- An invite does not expire, and is not turned into a seat when the org later verifies the address's
  domain; it stays an invite until it is answered or withdrawn.
- The dash's member list needs the invited rows. There is still no way for a person to leave an org.
