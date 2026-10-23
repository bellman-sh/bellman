# ADR 0031 — An org's policy binds its members at a start and at a join

**Date:** 2026-10-23 · **Status:** accepted · **Closes:** #57 · **Spec:** `docs/superpowers/specs/2026-10-23-org-policy-design.md` · **Plan:** `docs/superpowers/plans/2026-10-23-org-policy.md`

## Context

`org_only` was opt-in, per room, by the member starting it: the person least motivated to set it. An
org that bought the team plan for the scoping had no way to say "every room, always", which outside
orgs its members may sit with, which capabilities they may hand a peer, or who may start a room at
all. Each of those was decided by whichever member was calling.

## Decision

1. **The policy is a field of the org record.** `Org.policy` holds `requireOrgOnly`,
   `forbiddenCapabilities`, `allowedCounterpartyOrgs`, `whoMayCreate` and
   `allowOperatorImpersonation`. A row written before the field reads as the default, lifted at the
   read in both stores as earlier fields were, so no row is migrated and every rule is a no-op for an
   org that has set nothing. The issue's `maxSessionTtlMs` is dropped: rooms have no lifetime since #18,
   and `retainAfterCloseMs` is a plan ceiling, not a policy knob. `allowOperatorImpersonation` is
   stored and shown, defaulting to allowed because #67 made consent blanket through the terms; #67
   enforces it, and the slot exists now so no row needs migrating then.
2. **Policy only tightens.** Entitlements stay the ceiling: a policy cannot grant swarm mode, public
   rooms or org scoping to a plan without them, and every check runs beside the entitlement check it
   sits with, never instead of it.
3. **Each rule is evaluated where the member acts, after the entitlement refusals and before any
   write** (ADR 0006). `bellman_start` reads the caller's org once: `whoMayCreate: "admins_only"`
   refuses a non-admin, `forbiddenCapabilities` refuses a declaration holding one, and
   `requireOrgOnly` stamps the room `orgOnly: true`, said back in the result's `org_only` and the
   audit row. `bellman_connect` and `bellman_confirm` both run the counterparty rule, so a policy
   tightened between preview and seat refuses the seat; `bellman_confirm` also checks the joiner's
   declared capabilities. A caller with no org reads nothing and is bound by nothing of their own.
4. **Counterparty orgs bind both sides of a join.** The joiner's org must allow every org in the
   room (`session.orgs`, every org that has sat in it, ADR 0019), and every org in the room must allow
   the joiner's. A member outside any org, the creator or anyone on the roster, is outside every list,
   so a list, even an empty one, refuses a room holding one, and an org's list refuses a joiner with
   no org. The refusal says which side's policy refused and names the org: `your org's policy does not
   allow rooms with org "acme".`, `your org's policy does not allow rooms with a member outside any
   org.`, or `org "acme"'s policy does not allow members of your org in its rooms.` One `getOrg` per
   org in the room; rooms hold few orgs. `null` allows every org; `[]` allows only the member's own,
   kept beside `requireOrgOnly` because `requireOrgOnly` also stamps the room, which `bellman_connect`
   enforces with no policy read and the dash shows.
5. **Running rooms are left alone.** A policy is evaluated at a start and at a join. A room already
   running is not revisited when the policy tightens: its members, its outside orgs and the
   capabilities they declared all stay. An admin who wants a running room to match has
   `bellman_evict` and the room's close. #47's freeze is not used: a freeze is for a room whose
   standing lapsed, and it would freeze the room for every member, the other orgs' included, over one
   org's rule.
6. **The owner and admins are bound too.** `whoMayCreate: "admins_only"` admits admins by its
   definition, not by exception. An admin who loosens the policy to start a room and tightens it back
   leaves two `org_updated` rows.
7. **No new route and no new event.** `PATCH /org` takes `policy` as a partial, each field validated by
   its type, a field left out left as it was; `GET /org` shows it to every member, since the policy
   binds the member reading it. The change is audited as `org_updated` with the fields that changed,
   as a `require_sso` change is. A refusal by policy is not audited: no entitlement refusal is, and an
   audited denial is #58's surface.

## Consequences

- No dash card yet; it is filed as a dash issue when this merges. `allowOperatorImpersonation` is
  not enforced (#67). No policy on `bellman_invite` or `bellman_send`: the join is where an outside
  org arrives, and a forbidden capability is refused at the declaration.
- The counterparty check is read-then-write across two objects (ARCHITECTURE section 9), as the
  `orgOnly` check is: a joiner whose seat lands between another joiner's policy read and their seat
  can share a room with an org the policy would have refused had the two joins been ordered. Each
  joiner is still checked against the room as it stood at their read, and `bellman_evict` corrects
  the room after.
- A room org with no record reads as open, so a deleted org's rooms refuse nothing on its behalf.
- The counterparty list is capped at 50 org ids, validated by `isOrgId` and not against the registry:
  an id that names no org is allowed and admits nobody.
