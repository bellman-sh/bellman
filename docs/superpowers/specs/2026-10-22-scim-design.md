# SCIM: provisioning, and the half that matters, deprovisioning

**Issue:** #56. **Blocked by, and built on:** #53 (orgs, ADR 0024) and #55 (SSO, ADR 0025), both
shipped. **Reuses:** #47's `freezeSession` and the creator index, which nothing in production
has called until now.

**Status:** design settled 2026-10-22. The choices below were made by the builder, not agreed in
conversation: the owner asked for the work to start and said the shape was open. Each decision says
why, so any of them can be reversed with the reason in hand.

**Scope:** one SCIM 2.0 bearer token per org, issued and revoked from the org routes; the SCIM
endpoints an IdP's provisioning connector calls (`ServiceProviderConfig`, `ResourceTypes`, `Schemas`,
`Users` with filtering, `Groups` as a stub); a per-org directory that ties an address to the key the
person is seated under, written by SCIM and by the SSO sign-in alike; deprovisioning that removes
the grant, ends the person's sign-in, takes them out of every room and freezes the rooms they created;
reprovisioning that seats them again and thaws; and audit rows for all of it. Group-to-role mapping,
transfer of a frozen room to someone else, and the control panel's page are follow-ups.

## Problem

SSO answers "can this person sign in". It does not answer "should they still be able to". A grant
persists until an admin removes it by hand, and nothing notices a departure. For a buyer, the person
who left last month and still holds a working login is the audit finding, and every IdP that does
SSO also does SCIM: Okta and Entra ID push a user when they are assigned the app, update them, and
deactivate them when they are unassigned or leave.

Three things stand in the way today:

- There is no bearer token an IdP could present, and no SCIM endpoint for it to call.
- An SSO member's address is stored nowhere. `provisionSsoMember` seats `sso:<orgId>:<sub>`, and the
  address the IdP vouched for is used once, to claim an admin's `email:` grant, then dropped. A SCIM
  connector matches people by `userName`, which is the address, so without a directory a person who
  signed in before the connector was set up would be pushed as a second seat.
- `freezeSession` exists, both stores implement it and the contract holds them to it, but no
  production path calls it. The creator index #47 built for a lapse has had no caller either.

## Decisions

### D1. One SCIM bearer token per org, hashed in the registry, scoped to SCIM alone

`POST /org/scim/token` (admin, on the org routes' rules, the CSRF check included) mints
`bst_<base64url of 32 random bytes>`, stores its SHA-256 under `sc:<orgId>` as
`{ tokenHash, issuedAt, issuedBy }` and the lookup `sh:<tokenHash> -> orgId`, in one transaction that
also deletes the previous token's lookup row, and answers the token once:
`{ token, issued_at, issued_by, base_url }`. Issuing again is the rotation; the old token stops at the
commit. `DELETE /org/scim/token` revokes (204; 404 when none). `GET /org/scim` answers
`{ base_url, token_set, issued_at, issued_by }` and never the token or its hash. `base_url` is
`<origin>/scim/v2`, which is what the Okta or Entra admin pastes in.

A SCIM request authenticates with `Authorization: Bearer <token>`: the hash is looked up, and the org
it names is the org every path operates on. The token is not a JWT and `caller` never admits it, so it
reaches `/mcp`, `/org` and `/audit` as nothing: a leaked token can provision and deprovision the org's
members and nothing else. Issue and revoke record `scim_token_issued` (with `replaced`) and
`scim_token_revoked` under `org:<orgId>`.

### D2. A SCIM user is a row that names the member's grant; the member is still the grant

```ts
interface ScimUser {
  id: string;            // opaque and random; the IdP stores it and asks by it
  orgId: string;
  userName: string;      // the address, lowercased whole
  externalId: string | null;
  active: boolean;
  key: string;           // the grant key the person is seated under, as it stands now
  createdAt: number;
  updatedAt: number;
}
```

Stored under `su:<orgId>:<id>` in the registry, beside the grants and the org. Membership stays the
grant (orgs spec, D2): a SCIM user that is active holds a `team` member grant from `scim` under `key`,
and one that is inactive holds none. The row is what SCIM reads back, and the one place a key, an
address and an IdP's `externalId` are tied together.

`userName` must contain `@`; it is lowercased whole, since Okta lowercases usernames and Entra's are
case-insensitive, and the address grant written for it is `email:<userName>`. A domain the org has not
verified is accepted, as an admin may seat any address: SSO will not claim such an address (SSO spec,
D12), and a GitHub or Google sign-in with it verified will. Nothing else in the pushed resource is
kept: a name, a title, an `emails` list and the rest are accepted and not stored, and the resource
answered shows what is held. A SCIM id is `randomId(16)`.

### D3. The directory: an address to the key it is seated under, written by SCIM and by SSO

Two index rows beside the SCIM user:

- `sn:<orgId>:<address> -> { key, scimId: string | null }`: the org's directory by address. SCIM
  writes it when it creates a user; the SSO sign-in writes it, with `scimId: null`, when it seats a
  person whose address the IdP vouched for under a verified domain. That second write is what makes
  "a user who signed in before the connector existed" a link rather than a second seat.
- `sk:<key> -> { orgId, scimId }`: the SCIM user a key is managed by. Written when a SCIM user gets its
  key, re-pointed whenever that key moves.

`moveGrant(from, to)` re-points both: it reads `sk:<from>`, and when `from` is an address key it reads
`sn:<org>:<address>` as well, and rewrites the SCIM user's `key`, the `sk:` row and the directory
entry in the same transaction. This covers the two claims that move a grant: an SSO sign-in claiming
`email:` onto `sso:` (D4), and a GitHub or Google sign-in claiming it onto `github:` or `google:`
(`claimGrant`). Without it a deprovision would delete `email:<address>`, find it gone, and leave the
subject's grant standing.

### D4. The SSO sign-in reads the directory, and refuses a deprovisioned subject

`provisionSsoMember(orgId, key, now, audit, address?)` takes the vouched address, and does in one
transaction what the callback did in two calls:

1. `sk:<key>` names a SCIM user with `active: false`: `deprovisioned`. Nothing is written.
2. A live grant at `key`: `exists`, as today.
3. `address` is given and `sn:<org>:<address>` names a SCIM user: inactive is `deprovisioned`; active
   re-points that user's `key`, `sk:` and the directory to `key`, moves the `email:<address>` grant
   onto `key` if one is live in this org (role and source kept, no seat taken), and answers
   `written`. An `email:` grant in this org with no SCIM user is moved the same way (the claim ADR
   0025 decision 5 describes, now inside the transaction).
4. Otherwise the seat as today, `full` at the cap, and when `address` is given, the directory row
   with `scimId: null`.

The directory is read and written by the address lowercased whole, whoever spelt it: a connector
lowercases `userName`, and an IdP's `email` claim may carry capitals, so the address is lowercased
inside `scimNameKey` and both spellings of `email:<address>` are tried for the grant. The grant moved
in step 3 is whatever the directory's key names, not only an address key: a `github:` or `google:` key a
personal sign-in claimed earlier, or an `sso:` key the IdP reissued, so one person holds one seat, under
the door they last came through; a personal account that held it drops to free with its rooms kept.

The callback drops its separate `moveGrant` and passes the vouched address. `deprovisioned` ends the
sign-in with a page: "Your organisation has removed your access. Ask its admin." Nothing is minted.

`AccessRemoved` is thrown where `SsoRequired` is: `ssoRefusal` gains a second check, one `sk:` read per
stable key, and refuses when the row says inactive. Both classes extend `SignInRefused`, and the six
places that caught `SsoRequired` catch the base, so a token refresh, a panel session's re-check and a
hosted room's month turn all stop a deprovisioned person within `ACCESS_TOKEN_TTL_SECONDS`, as they
stop one `require_sso` refuses. A deprovisioned person has no free account left under their SSO
identity: the finding is the login, not only the org.

The refusal applies to a subject the org's IdP minted, an `sso:` key of that org, and to no other key. A
personal GitHub or Google account that an address linked to the org (a SCIM user whose key a sign-in
claimed onto `github:` or `google:`) loses the org's grant on deactivation and keeps its sign-in, as free;
otherwise an org could end a stranger's sign-in by pushing their address.

### D5. Provisioning

`POST /scim/v2/Users` runs `createScimUser(orgId, { id, userName, externalId, active }, now, audit)`,
one transaction:

- `sn:` names a SCIM user: `exists` (SCIM 409, `scimType: "uniqueness"`).
- `sn:` names a key with no SCIM user (an SSO sign-in wrote it): the row is created pointing at that
  key, `sk:` written, no grant written and no seat taken: `linked`.
- A live `email:<userName>` grant in this org (an admin seated the address): `linked` the same way,
  the role kept. The same grant in another org: `conflict` (409).
- Otherwise, when `active`, a `team` member grant from `scim`, `grantedBy: "scim"`, within the seats
  (`full` is 409 with the numbers, as `/org/members` answers it); with `active: false`, the row alone.
  `written`.

201 with the resource and a `Location`. The audit row is `scim_user_created` with `user_name`,
`external_id`, `key` and `linked`, plus the `plan_granted` row the grant write files, actor `scim`.

### D6. Deprovisioning: the grant, the sign-in, the rooms

`active` going from true to false, by `PATCH`, `PUT` or `DELETE`, runs `updateScimUser` (or
`deleteScimUser`) in the registry: the grant at `key` is deleted when it is this org's (its
`plan_revoked` row filed), the row is marked inactive, and `scim_user_deactivated` (or
`scim_user_deleted`) is recorded. A delete also hides the row: it stays as a tombstone, `deletedAt`
set, with its directory entry and key index, so the subject is refused as a deactivated one is, a
repeat `DELETE` answers 204 and walks again, and a push for the address starts over under the key the
tombstone kept. A push with `active: false` onto a key a sign-in or an admin seated is itself the
deactivation: the grant goes and the walk runs. The answer carries the row, whose `key` says who the
person is.

Then, outside the registry and after it committed, the rooms. A key that no sign-in has claimed
names nobody and has no rooms. For an `sso:`, `github:` or `google:` key the user id is derived
(`userIdForKey`), and `departedRooms(store, userId, actor)` in `src/scim/rooms.ts` does three things:

- **Every open room they are in**: each of their handles is removed through `removeMember` with the
  request an eviction makes (`cut: true`, the seat's code retired, a `member_evicted` event from the
  system naming `reason: "deprovisioned"`, the audit rows `evictMember` files with that reason), but
  `frozen: "allow"` and no `byUserId`: this is the system acting on the org's instruction, not a
  creator, and a frozen room is not a reason to leave them seated. `closeSessionIfEmpty` after each.
  Rooms from `sessionsJoinedBy`, bounded by `JOINED_SCAN`.
- **Every open room they created**: `freezeSession(id, now)`, and a `room_frozen` audit row to the
  room's orgs with the reason. Members stay, history stays readable, writes are refused, which is
  #47's rule and the first production use of it. Rooms from `sessionsCreatedBy`, called until it
  answers nothing, since it may return fewer than asked. A room frozen already is left as it is.
- **The walk's scope follows the key.** Every room for a subject the org's IdP minted, whose sign-in the
  deprovision ends outright; only rooms whose `orgId` is this org for a personal account an address linked,
  which keeps its sign-in and its rooms elsewhere.
- **Nothing is closed or transferred.** The frozen room may be the only place a piece of work lives.
  The org's admins see the `room_frozen` rows and the deactivation in the audit log, and can read a
  frozen room as they read a closed one. Transfer to another member is a follow-up; until then the
  room thaws when the person is reprovisioned (D7) and otherwise stays frozen.

The pass is not atomic with the registry write (ARCHITECTURE section 9), and it does not need to be:
the registry's write is the decision, the rooms are its consequence, and the pass is idempotent. A
second deactivation of an inactive user answers 200 and runs the pass again, which is how a pass cut
short is finished. The person's own tokens end on their next re-check (D4) whatever the pass did.

### D7. Reprovisioning seats them again as a member, and thaws

`active` going from false to true writes the grant again under the row's `key` (`full` is 409; the
role is `member`, since the grant that carried the old one is gone, and an admin promotes), records
`scim_user_reactivated`, and the route thaws every open room they created that is frozen
(`freezeSession(id, null)`, a `room_thawed` row). Nothing freezes a room but this, so every frozen
room of theirs is one a deprovision froze. Amended by ADR 0027: when the row's key is a personal account
rather than the org's own `sso:` subject, the grant is written under the address instead, and the
account takes it back at its next sign-in; the thaw still runs for the account the deprovision walked.

### D8. Renames and the rest of an update

`PUT /scim/v2/Users/:id` replaces `userName`, `externalId` and `active` from the body and leaves
everything else; `PATCH` applies `Operations`: `add` and `replace`, matched case-insensitively since
Entra sends `Replace`, with no `path` (the value is an object of attributes) or with `path` naming
`active`, `userName` or `externalId`; `remove` of `externalId` clears it. `active` takes a boolean or
the strings `true` and `false` in any case, since Entra sends `"False"`. An op on any other path is
accepted and changes nothing, so a connector that also pushes a name or an email does not fail on it;
an op that is not one of the three is 400 `invalidValue`, and a filter on anything but `userName` or
`externalId` is 400 `invalidFilter`.

A `userName` change moves the directory entry, and when `key` is an address key, moves the grant to
`email:<new address>` (`moveGrant`); a key already claimed onto a subject is left, since it names the
person and not the address. A new `userName` another SCIM user holds is 409 `uniqueness`.
`scim_user_updated` names what changed.

### D9. The protocol surface

Mounted at `/scim/v2` by the Worker ahead of the OAuth routes, behind `unconfigured` and not behind
`routeGate`: there is no caller and no cookie, and the token's org is the only identity. The Node
server mounts it beside `/org`. `src/http/scim.ts` holds the routes and `src/scim/` what they share:
the filter, the patch, the resource shape.

- `GET ServiceProviderConfig`: patch and filter supported (`maxResults: 200`), bulk, sort, etag and
  password change not, one `oauthbearertoken` scheme. `GET ResourceTypes`: User. `GET Schemas`: the
  core User schema, with the attributes held.
- `GET Users`: `filter=userName eq "x"` or `externalId eq "x"` (one clause, `eq` only, the attribute
  case-insensitive), `startIndex` from 1 and `count` at most 200, a `ListResponse`. ponytail: the
  page is cut from a scan of the org's rows capped at 1,000, so an org with more SCIM users than
  that pages wrong; a counter row and a cursor are the upgrade.
- `POST Users` (D5); `GET`, `PUT`, `PATCH`, `DELETE Users/:id` (D6 to D8). An id of another org is
  404 like a missing one.
- `GET Groups`: an empty `ListResponse`, so a connector that reads groups finds none; any write is
  501 with "groups are not managed here; roles are set in Bellman", since a pushed group would have
  to mean something and roles are not settled (#56).
- Responses are `application/scim+json`; a body is read as JSON whether sent as that or as
  `application/json`, under 16 KB. Errors are the SCIM error schema with `status`, `scimType` when
  one applies, and `detail`. 401 names the token, with no CORS: a browser never calls this.

### D10. The IdP owns the members it pushed

`DELETE /org/members/:key` on a key `sk:` names, whose SCIM user is active, is 409 `managed`: "this
member is provisioned by your identity provider; remove them there". Otherwise the next sync would
seat them again and present as members reappearing. Changing their role is Bellman's and stays
open. `POST /org/members` with such an address is the `exists` it already answers. Members an admin
seated and the IdP never pushed are untouched by SCIM, until a push links them (D5). The operator's
`/admin/grants` is unchanged.

### D11. Audit rows

`scim_token_issued`, `scim_token_revoked` under `org:<orgId>` with the admin as actor;
`scim_user_created`, `scim_user_updated`, `scim_user_deactivated`, `scim_user_reactivated`,
`scim_user_deleted` under `scim:<id>` with the actor `{ userId: "scim", label: "SCIM", orgId }`, each
naming `user_name` and `key`; the grant rows the guarded writes file; and in the rooms,
`member_evicted` with `reason: "deprovisioned"`, `room_frozen` and `room_thawed` with the reason, to
the room's orgs as every room row goes. `entryView` reads `scim:` as it reads `grant:` and `org:`: no
room.

## What this does not do

- Map IdP groups to roles, SAML, a default role setting, closing or transferring a frozen room, a
  schedule that re-checks the IdP, and the panel's page: dash work, given `GET /org/scim` and the two
  token routes.
- Change `BELLMAN_USERS`, `/admin/grants`, or the owner's break-glass. An owner is never a SCIM user's
  key: a push for the owner's address links nothing, since the owner's grant is a subject key the
  directory does not name; it is 409 `conflict`, and the row says so.
- Lock out a token after failed attempts. A wrong token is 401, every time.

## Errors

- Token routes: the org routes' refusals; 404 `not_found` on a revoke with no token.
- SCIM: 401 `unauthorized` with no or an unknown token; 404 for an unknown id or path; 405 with `Allow`
  for a method a path does not take; 400 `invalidSyntax` for a body that is not a JSON object, `invalidValue`
  for a `userName` without `@`, an op outside the three, or an `active` that is not a boolean, `invalidFilter`
  for a filter outside the grammar; 409 `uniqueness` for a `userName` held by another SCIM user, 409 `conflict`
  for an address granted in another org or the owner's, 409 `full` with the seats; 413 for a body over the bound;
  501 for a Groups write; 500 for a failure, with the SCIM error schema throughout.
- `/org/members/:key` DELETE: 409 `managed` (D10).
- Sign-in: `deprovisioned` is a page from the callback and `access_denied` for a client, `invalid_grant` on
  `/token`, and the end of a panel session, as `require_sso`'s refusal is.

## Testing

- `tests/scim-filter.test.ts` and `tests/scim-patch.test.ts`: the filter grammar (both attributes, case,
  quoting, a rejected clause) and the patch ops (Okta's and Entra's shapes, the string booleans, an ignored
  path, a refused op).
- `tests/helpers/store-contract.ts`: the token (issue, replace, revoke, the lookup, and that a replaced
  token no longer resolves); `createScimUser`'s five answers and the directory rows each leaves;
  `updateScimUser` deactivating (grant gone, row kept), reactivating (grant back, `full`), renaming (the
  `email:` grant moved, a claimed key left); `deleteScimUser`; `provisionSsoMember` with an address: the
  directory row, the link onto an existing SCIM user, `deprovisioned` by key and by address, and the
  `email:` claim inside the transaction; `moveGrant` re-pointing the rows; and every audit row. Runs
  against both stores through `worker-tests/store-contract.test.ts`.
- `tests/scim.test.ts`: the routes over a MemoryStore with a real token: discovery, create, the list and
  the filter, get, put, patch (Okta and Entra), delete; 401, 404, 405, 409 (`uniqueness`, `conflict`,
  `full`), the bound; Groups; the deprovision room pass end to end over rooms the person created and
  joined (evicted with the reason, the creator's rooms frozen, `room_frozen` rows, a repeat harmless),
  and the thaw on reactivation.
- `tests/http-orgs.test.ts`: the three token routes, the CSRF refusal on issue and revoke, `managed`
  on a SCIM-owned member's removal, and that the removal of an admin-seated member still works.
- `tests/sso-flow.test.ts`: a SCIM-provisioned address signs in and takes no second seat, with the
  role kept; a sign-in before the push links on the push; a deactivated user's sign-in shows the page
  and their refresh is `invalid_grant`; a reactivated user signs in again.

## Files

`src/types.ts` (`ScimUser`, `ScimToken`), `src/grant-index.ts` (the five keys), `src/store.ts` (the methods,
`MemoryStore`), `src/store-do.ts` (`RegistryDO`, `DurableObjectStore`), `src/grant-audit.ts` (the
rows), `src/audit.ts` and `src/http/audit.ts` (`scim:` is no room), `src/scim/{filter,patch,resource,rooms}.ts`,
`src/http/scim.ts`, `src/http/orgs.ts` (the token routes, `managed`), `src/oauth/routes.ts`
(`SignInRefused`, `AccessRemoved`, the callback), `src/oauth/providers.ts` if a helper moves,
`src/worker.ts`, `src/app.ts`, `docs/adr/0029-scim-provisioning.md`, `README.md`, `docs/ARCHITECTURE.md` sections 5
and 6, `docs-site/src/content/docs/guides/teams.md`.
