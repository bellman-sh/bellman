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
   the one rule, and it is read as the org stands, not only when a seat is written.
2. **Every other seat is an invite**, an `OrgInvite` kept in `RegistryDO` under `io:<org>:<key>` and
   `iv:<key>:<org>`, apart from the grants, so nothing that reads a grant can take one for a seat: not
   `firstGrant`, so no plan, no org on the identity and nothing for `ssoRefusal`; not the seat count; not
   the rooms an org sat in. `POST /org/members` answers it with 202 and `status: "invited"`, the roster
   lists invites after members, and `DELETE /org/members/:key` withdraws one. Whether the key holds
   another org's grant is not asked, so an invite tells the admin nothing of the person. An invite takes
   no seat, and an org holds at most 200 at once. `member_invited` and `invite_withdrawn` are filed in
   the org's stream, naming the key the admin typed.
3. **An admin's seat on an address the org no longer owns by its form is read as an invite, in place.**
   That is a `source: "org"` grant on an address key, under a domain the org has released since, or
   written before this decision for an address the org never owned (`isUnownedSeat`). The grant stays
   as it is, but a sign-in neither resolves it nor claims it onto the subject; the page in 4 offers it,
   the roster lists it as invited, and it keeps its seat until it is answered or removed. It holds the
   person nowhere: it refuses no Join to another org, and an org that owns the address by its form now
   takes the key from it with the guarded write, which revokes the seat in its own org's stream as the
   system, naming no other org (`takenSeatAuditEntries`). A seat on a provider subject is not an address,
   and keeps its effect.
4. **The person answers at their next sign-in.** After the provider's exchange and before the plan
   resolves, a GitHub or Google sign-in whose keys, the subject and the verified address, an org has made
   an offer to stops at a page naming each such org, with Join, Decline, and a way on without answering,
   which leaves the offers for the next sign-in. The buttons say only Join and Decline: an org's name is
   its admin's text, so it is drawn once, as text, escaped and isolated in `<bdi>`, and a name holds
   nothing that draws nothing (`parseOrgName`): the mod's rule for a peer's text, copied, which refuses
   every control, format, private-use or unassigned character, line and paragraph separator, and code
   point Unicode leaves undrawn, the Hangul fillers among them, but a joiner or a variation selector
   directly after a character that draws. A name stored before that rule is drawn without what it
   refuses, or as the org's id when nothing is left. The page's forms carry the sign-in signed, under its
   own audience, as the provider round trip carries its state, ending ten minutes after the provider's
   exchange however often the page is drawn again. The first answer spends it (`spendOnce`), and each page
   drawn after an answer carries a fresh one with the same end. An answer after the first with the same
   one, such as a second press of Join, applies nothing and mints nothing: it follows the first answer to
   where that left the browser, the client's code or the panel with its cookies, since a browser shows
   the response to the last press (`settleSpent`); it draws the page again when the first did; and while
   the first is on its way it says so, with a button that asks again. A panel sign-in's answer, the first
   or a later one, counts only from the browser holding that sign-in's nonce cookie, checked before
   anything is spent or followed. An SSO sign-in is its org's by its form and stops at no page.
5. **Join is one operation, `acceptOrgInvite`**: in one `RegistryDO` transaction it reads the offer, the
   switch, every key's grant and the seats, writes the grant under the provider subject, `team`, the
   offer's role, `source: "invite"`, `grantedBy` whoever made the offer, with the `plan_granted` row
   naming the person, and drops the org's invites of the sign-in's keys and every unowned seat the org
   holds on them, which the grant replaces. So an invite withdrawn before it seats nobody. A full org
   refuses it as seating does, unless a seat moves; so does any grant the sign-in's keys already hold,
   another org's or a plan of the person's own, since a person is in one org, but an unowned seat in any
   org is no grant here; and so does an org with `require_sso` on, since the account would be refused at
   its next sign-in by the org it had just joined. A refused Join leaves the offer.
6. **Decline is kept on the person's side**, under `ix:<subject>:<org>` with its time: the offers that
   org had made by then stop showing on their pages, and the org's invites stay as its admin wrote them,
   pending until withdrawn. So a decline tells the admin nothing, not even which of the keys they invited
   were one person's. An offer the org makes after it is a new question and shows; that tells the admin
   nothing new either, since nothing they can read changes until the person answers it. A decline acts
   only on an org that made this sign-in an offer, and only such an org is named in what the page says.
7. **`require_sso` refuses by a grant that took effect, never by an invite.** `ssoRefusal` reads the
   plan's org, which only a grant or an operator override sets. Its domain half is unchanged: an address
   under a verified domain is the org's by its form.

## Consequences

- Grants written before this keep their effect, but for 3. An admin's seat was written `source: "org"`
  with the admin as `grantedBy`; from here on `source: "org"` is written only for an identity the org
  owns by its form, and an accepted invite is `source: "invite"`. An address grant claimed onto a
  subject at sign-in keeps its source, so `grantedAt` before this change is the cleaner cut for finding
  the older seats.
- `/admin/grants`, whose writes are for admins `BELLMAN_USERS` names, and the operator's `POST /admin/orgs`
  still seat directly: both are the operator's.
- An invite does not expire, and is not turned into a seat when the org later verifies the address's
  domain; it stays an invite until it is answered or withdrawn. A decline has no undo: the person who
  declined sees those offers no more, though a newer one from the same org shows.
- The dash's member list needs the invited rows. There is still no way for a person to leave an org.
