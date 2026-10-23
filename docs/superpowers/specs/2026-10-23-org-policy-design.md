# Org policy (#57)

**Date:** 2026-10-23 · **Closes:** #57 · **ADR:** 0031 · **Builds on:** ADR 0024 (orgs), 0025 (SSO), 0027 (seat consent), 0029 (SCIM)

## The problem

`org_only` is opt-in, per room, by the person least motivated to set it: the member starting the
room. An org that bought the team plan for the scoping has no way to say "every room, always", nor
to say which outside orgs its members may sit with, which capabilities they may hand a peer, or
who may start a room at all. Each of those is decided today by whichever member is calling.

## Decisions

### D1. The policy is a field of the `Org` record

```ts
interface OrgPolicy {
  /** Every room a member starts is org-only, whatever org_only the call says. */
  requireOrgOnly: boolean;
  /** Capabilities a member may not grant a peer, at start or at confirm. */
  forbiddenCapabilities: Capability[];
  /** The orgs a member may share a room with, besides their own; null is any, [] is none. */
  allowedCounterpartyOrgs: string[] | null;
  /** Who may start a room. */
  whoMayCreate: "any_member" | "admins_only";
  /** Whether the operator may act as a member of this org (#67). Stored and shown; enforced when #67 lands. */
  allowOperatorImpersonation: boolean;
}

const DEFAULT_POLICY: OrgPolicy = {
  requireOrgOnly: false, forbiddenCapabilities: [], allowedCounterpartyOrgs: null,
  whoMayCreate: "any_member", allowOperatorImpersonation: true,
};
```

`Org.policy: OrgPolicy`. A record written before this field reads as `DEFAULT_POLICY`, lifted at
the read in both stores as other fields have been (`liftOrg`), so no row is migrated and every
rule below is a no-op for an org that has set nothing.

`maxSessionTtlMs` from the issue is dropped: rooms have no lifetime since #18, and
`retainAfterCloseMs` is a plan ceiling, not a policy knob. `allowOperatorImpersonation` defaults
to allowed because #67 decided consent is blanket through the terms; the slot is the org's opt-out,
written now so no row needs migrating when #67 enforces it.

Policy only tightens. Entitlements are the ceiling: a policy cannot grant swarm mode, public
rooms or org scoping to a plan without them, and every check below runs beside, never instead of,
the entitlement check it sits with.

### D2. Where each rule is evaluated

The policy read is `getOrg(identity.orgId)` by the tool, only for an identity that names an org;
a caller with no org reads nothing and is bound by nothing of their own. Each refusal names the
policy and the field, so the member can tell their admin which rule said no.

| Rule | `bellman_start` | `bellman_connect` | `bellman_confirm` |
|---|---|---|---|
| `whoMayCreate: "admins_only"` | refused unless `identity.role === "admin"`: `your org's policy lets only admins start rooms.` | | |
| `requireOrgOnly` | the room is created `orgOnly: true`; the audit row and the result say so | | |
| `forbiddenCapabilities` | refused when the declared `capabilities` hold one: `your org's policy forbids granting request_actions to peers; call again without it.` | | same, on the joiner's declaration |
| `allowedCounterpartyOrgs` | | both directions, D3 | both directions again, from the room as it stands at the seat |

The checks run after the entitlement refusals and before any write, on ADR 0006's rule that every
refusal comes before the first write. `requireOrgOnly` on a plan without `orgScoping` is not a
case: an org record exists only on team.

`bellman_start` returns `org_only` beside `plan` so a member sees the policy's effect on the room
they just made. `bellman_connect` already returns `session.org_only`.

### D3. Counterparty orgs bind both sides of a join

`allowedCounterpartyOrgs` is a rule about which orgs a member may share a room with. A join puts
two sets of orgs in one room, so it is checked from both sides:

- **The joiner's org** must allow every org in `session.orgs` (every org that has sat in the
  room, ADR 0019) that is not the joiner's own. A room whose creator has no org counts as holding
  an org outside any list, so a list, even an empty one, refuses it.
- **Every org already in the room** must allow the joiner's org, or the joiner has none and the
  org's list refuses them. One `getOrg` per org in `session.orgs`; rooms hold few orgs.

The refusal says which side's policy refused and names the org it refused for:
`your org's policy does not allow rooms with org "acme".` or `org "acme"'s policy does not allow
members of your org in its rooms.` The second names an org the joiner can already see, since the
room's orgs are in the preview. This is the issue's asymmetry resolved: each org's rule binds its
own members, and a room that holds an org's members takes a joiner only if that org allows the
joiner's org, or the rule would be bypassed by having the outsider join.

`null` allows every org; `[]` allows only the member's own, which is `org_only` by another name
and is kept because a list can be emptied without touching `requireOrgOnly`. `requireOrgOnly`
stays, because it also stamps the room's `orgOnly`, which `bellman_connect` enforces with no
policy read and the dash shows.

### D4. Running rooms are left alone

A policy is evaluated at a start and at a join. A room already running is not revisited when the
policy tightens: its members stay, its outside orgs stay, and its members keep the capabilities
they declared. An admin who wants a running room to match the policy has `bellman_evict` and the
room's own close. Freezing through #47's mechanism is not done: a freeze is for a room whose
standing has lapsed, and it would freeze a room for every member in it, the other orgs' included,
over one org's rule.

### D5. The owner and admins are bound too

Every rule binds every member of the org, the owner and admins included; `whoMayCreate:
"admins_only"` admits admins by its definition, not by exception. The policy change itself is the
audited act (D7), so an admin who loosens the policy to start a room and tightens it back leaves
two rows.

### D6. The route and the view

`PATCH /org { policy: { ...partial } }`, admin only, on the route's existing rules (stray-field
400, CSRF, `404 no_org`). Each given field is validated by its type: booleans, `forbidden_capabilities`
a list of the three capability names with no repeat, `allowed_counterparty_orgs` null or a list of
at most 50 distinct org ids by `isOrgId`, `who_may_create` one of the two words. A field left out is
left as it was (`patchedOrg` merges, as it does for a name). `GET /org` returns `policy` in snake
case, for members and admins alike, since the policy binds the member reading it.

No new route: the policy is a field of the org, and the panel edits it where it edits the name.

### D7. Audit

`org_updated` with `policy: { <changed fields, snake case> }`, from `orgAuditEntries`'s diff as
`require_sso` is; nothing for a change that changed nothing. No new event type. A refusal by policy
is not audited: no entitlement refusal is, and an audited denial is #58's query surface to design.

### D8. Not in this PR

- A dash card for the policy, filed as a dash issue when this merges.
- Enforcing `allowOperatorImpersonation`: #67.
- Audited denials: #58.
- A policy on `bellman_invite` or on `bellman_send`: the join is where an outside org arrives,
  and a forbidden capability is refused at the declaration, so neither needs a rule of its own.

## Files

- `src/types.ts`: `OrgPolicy`, `DEFAULT_POLICY`, `Org.policy`, `OrgPatch.policy`.
- `src/orgs.ts`: `liftOrg`, `policyView`, `parsePolicyPatch`, the refusal texts.
- `src/store.ts`, `src/store-do.ts`: the lift at every org read; `patchedOrg` merges the policy.
- `src/grant-audit.ts`: the policy diff in `orgAuditEntries`.
- `src/tools/start.ts`, `connect.ts`, `confirm.ts`: the checks in D2 and D3.
- `src/http/orgs.ts`: `PATCH /org` takes `policy`.
- `tests/helpers/store-contract.ts`, `tests/orgs.test.ts`, `tests/http-orgs.test.ts`,
  `tests/tools/handshake.test.ts` (or a new `tests/tools/org-policy.test.ts`).
- `docs/adr/0031-org-policy.md`, `docs/ARCHITECTURE.md` section 6, the teams guide, `npm run docs:gen`.
