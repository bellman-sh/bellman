# scim

## Overview

SCIM 2.0 parts for org provisioning from an identity provider such as Okta or Entra: a one-clause filter parser,
parsers for a pushed User and a PATCH body, the response and discovery document shapes, and the walk over a
person's rooms on deprovision and reprovision. The route handler that uses them is `scimRoutes` in
[`src/http/scim.ts`](../http/EGM.md); this directory holds no routes.

## Interface

- `parseFilter(filter)`: accepts only `userName eq "..."` or `externalId eq "..."`, else `{error}`;
  `ScimFilter {attribute, value}` [src/scim/filter.ts:parseFilter]
- `readUserName(value)`: trimmed, lowercased, must contain `@`, at most 254 characters
  [src/scim/patch.ts:readUserName]
- `readActive(value)`: a boolean, or `"true"`/`"false"` in any case (Entra sends `"False"`)
  [src/scim/patch.ts:readActive]
- `readUser(body)`: `{userName, externalId | null, active (default true)}` or `{error}` for POST/PUT
  [src/scim/patch.ts:readUser]
- `applyOperations(operations)`: a `ScimPatch`, or the first `{error, scimType: invalidValue | invalidSyntax}`
  [src/scim/patch.ts:applyOperations]
- `SCIM_JSON` content type and the USER, LIST, ERROR and PATCH schema URNs [src/scim/resource.ts:SCIM_JSON]
- `userResource(user, base)`: a User with `emails [{value: userName, primary}]` and `meta.location`
  `${base}/Users/${id}` [src/scim/resource.ts:userResource]
- `listResponse`, `scimJson(status, body, headers)`, `scimError(status, detail, scimType?)`
  [src/scim/resource.ts:scimError]
- `serviceProviderConfig(base)`, `resourceTypes(base)`, `schemas(base)`: discovery documents
  [src/scim/resource.ts:serviceProviderConfig]
- `WalkScope {orgId, everywhere}`; `scimIdentity(orgId)`: `{userId: "scim", plan: "team", role: "admin",
  label: "SCIM"}` [src/scim/rooms.ts:scimIdentity]
- `departedRooms(store, userId, actor, now, scope)` returns `{left, frozen[]}`; `thawRooms(...)` returns the
  thawed room ids [src/scim/rooms.ts:departedRooms]

## Invariants

- Filter: one clause, `eq` only, a double-quoted value with `\"` and `\\` escapes; attribute and operator are
  case-insensitive; anything else is an error [src/scim/filter.ts:CLAUSE]
- A `userName` filter value is lowercased; an `externalId` value is kept as sent [src/scim/filter.ts:parseFilter]
- Only `userName`, `externalId` and `active` are stored; any other pushed or patched attribute is accepted and
  dropped [src/scim/patch.ts:take]
- PATCH ops must be add, replace or remove (case-insensitive); `userName` and `active` cannot be removed;
  removing `externalId` sets it to null [src/scim/patch.ts:take]
- A remove with no path is refused; an add or replace with no path needs an object value
  [src/scim/patch.ts:applyOperations]
- ServiceProviderConfig advertises patch and filter (`maxResults` 200); bulk, sort, etag and changePassword are
  unsupported [src/scim/resource.ts:serviceProviderConfig]
- `everywhere: true` touches every room; otherwise only rooms whose `orgId` matches [src/scim/rooms.ts:inScope]
- Memberships are removed before created rooms are frozen, so a room that empties closes instead of freezing
  [src/scim/rooms.ts:departedRooms]
- Closed and already-frozen rooms are skipped; both walks are idempotent and, per the header comment, not atomic
  with the registry write [src/scim/rooms.ts:departedRooms]
- Created rooms are read in rounds of 500 for at most 10 rounds, so rooms past 5,000 can stay unfrozen (a
  `ponytail:` comment marks the ceiling) [src/scim/rooms.ts:createdRooms]
- Thaw touches only rooms with `frozenAt` set, on the stated premise that only a deprovision freezes a room
  [src/scim/rooms.ts:thawRooms]

## Side Effects

- `store.removeMember` for each active handle, with an eviction request of reason `"deprovisioned"` and
  `frozen: "allow"`, then `store.closeSessionIfEmpty` [src/scim/rooms.ts:departedRooms]
- `store.freezeSession(id, now)` plus a `room_frozen` audit row `{reason: "deprovisioned", user_id}`
  [src/scim/rooms.ts:departedRooms]
- `store.freezeSession(id, null)` plus a `room_thawed` audit row `{reason: "reprovisioned", ...}`
  [src/scim/rooms.ts:thawRooms]
- Responses carry `content-type: application/scim+json` and `cache-control: no-store`
  [src/scim/resource.ts:scimJson]

## Verification

- Run: `npm test -- tests/scim` (`scim-filter`, `scim-patch`, `scim-resource`, `scim.test.ts`)
- Full gate: `npm run verify`
