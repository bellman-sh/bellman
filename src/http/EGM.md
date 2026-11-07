# http

## Overview

The plain-HTTP routers that sit beside `/mcp`, each a runtime-free function from a web `Request` to a
`Response`, returning `undefined` for paths it does not serve. Members' room routes (`/rooms`), the account-scoped
routes (`/me`, `/account`, `/presets`, `/audit`), org administration (`/org`) and SCIM (`/scim/v2`), moderation
(bans and reports), operator views (`/operator`), and the credential-free public reads (`/public`, the 0.3 agent
card). They share one caller resolution, CORS for the panel's origins, OPTIONS preflight, a CSRF check on cookie
writes, and body-length limits checked before parsing.

## Interface

Room routes [src/http/rooms.ts:roomRoutes]:

- `GET /rooms` (`?as=admin` lists the caller's org's closed rooms); `GET|DELETE /rooms/:id` (DELETE answers
  202 `{id, purge_at}`) [src/http/rooms.ts:listRooms]
- `GET|PUT /rooms/:id/surface` (read takes `?query=`, `?window=`, `?next=`; PUT writes a batch `{items}`);
  `PUT|DELETE /rooms/:id/surface/:key` [src/http/rooms.ts:writeSurfaceBatchRoute]
- `GET /rooms/:id/events` (`?after=` or `?query=`) [src/http/rooms.ts:readEventsRoute]
- `GET /rooms/:id/decisions`: `{open, decisions, next}` from `BellmanStore.decisions`, each decision in
  `decisionShown`'s full shape; `?before=` (a decision cursor) pages on from a `next`, `?limit=` 1 to
  `MAX_DECISION_PAGE` (100, default `DECISION_PAGE` 50); the ETag is a SHA-256 of the body and `If-None-Match`
  answers 304 [src/http/rooms.ts:readDecisionsRoute]
- `POST /rooms/:id/blobs` (201 `{blob_id, bytes, type, name}`); `GET /rooms/:id/blobs/:blobId`
  [src/http/rooms.ts:uploadBlob]
- Creator settings: `POST /rooms/:id/unpublish` (204), `PUT|DELETE /rooms/:id/byline`, `PUT /rooms/:id/view`
  (`canvas` | `page`), `PUT /rooms/:id/host` (`{instructions}`), `POST /rooms/:id/codes` (201 join code)
  [src/http/rooms.ts:mintCode]
- `RoomCaller {identity, via: "bearer" | "cookie"}`, `RoomRouteDeps {store, blobs, caller, panelOrigins}`
  [src/http/rooms.ts:RoomRouteDeps]
- `STATUS` maps `RoomFailure` codes: not_found 404, closed/frozen/conflict/stale/paused 409, forbidden 403,
  invalid 400, rate_limited 429, too_large/over_quota 413 [src/http/rooms.ts:STATUS]
- Shared helpers `json`, `problem`, `methodNotAllowed`, `lengthRefusal`, `blobResponse`; ETag helpers
  `surfaceTag`, `searchTag`, `windowTag`, `etagMatches`, `windowParams` [src/http/rooms.ts:etagMatches]
- Limits `MAX_ROOMS_LISTED` 50, `MAX_SURFACE_WRITE_BYTES` 64 KB, `MAX_SURFACE_BATCH_BYTES` 1 MB,
  `MAX_EVENTS_READ` 200 [src/http/rooms.ts:MAX_ROOMS_LISTED]

Account, org and operator routes:

- `auditRoutes`: `GET /audit`, `/audit/export`, `/audit/verify`, `GET|PATCH /audit/settings`,
  `PUT|DELETE /audit/sink`, `POST /audit/sink/resume`; `parseAuditQuery`, `AUDIT_PAGE` 100,
  `AUDIT_EXPORT_PAGE` 500, CSV helpers `csvRow`/`csvCell`, `exportFilename` [src/http/audit.ts:auditRoutes]
- `handleRoutes`: `GET|PUT|DELETE /account/handle` [src/http/handles.ts:handleRoutes]
- `notesSharingRoutes`: `GET /rooms/:id/notes-sharing` returns `{shared}` for the caller's account, bearer or cookie,
  404 without a seat of the caller's in the room (present or departed); `PUT /rooms/:id/notes-sharing` `{shared: boolean}`
  sets the `ns:` row from a dash session alone (403 `dash_session_required` to a bearer, the CSRF check), 400 for any
  other body; `DELETE /rooms/:id/notes` deletes the account's own notes in the room, one `writeFs` delete per file from
  its first active seat, stopping at the first refusal, and answers 200 `{deleted, refused}` (`refused` is
  `{path, code}` or null), 404 without a seat [src/http/notes-sharing.ts:notesSharingRoutes]
- `meRoutes`: `GET /me/rooms` returns `{rooms: liveRooms(...)}`; `GET /me/memory` returns the account's `HomeSettings`
  (`{capture, paused}`) to a bearer or a cookie, `PUT /me/memory` `{capture?, paused?}` (at least one, no other key,
  else 400) merges into it [src/http/me.ts:meRoutes]
- The rest of `meRoutes`, all dash-session only: `GET /me/memory/lookups` `{lookups}` (newest first, at most
  `LOOKUP_KEEP` 1,000); `DELETE /me/memory` (204, the whole home room with its `hs` row); `DELETE /me/memory/notes?path=`
  (204 | 404 `not_found` | 400 `invalid_request`, the note, its history and the path in every lookup row);
  `GET /me/memory/export` (200 `text/markdown`, an attachment `bellman-memory-YYYY-MM-DD.md`, works while paused, logs
  no lookup) [src/http/me.ts:meRoutes]
- Every account memory route but `GET /me/memory` is dash-session only: a bearer gets 403 (`dash_session_required`,
  or `forbidden` on `PUT /me/memory`) and a write is CSRF-checked [src/http/me.ts:meRoutes]
- `presetRoutes`: `GET /presets` (`{builtin, mine}`), `PUT|DELETE /presets/:name`; `MAX_PRESET_BYTES` 32 KB
  [src/http/presets.ts:presetRoutes]
- `statsRoutes`: `GET /operator/stats` (`PlatformStats {accounts, free, paid, paidCapped}`),
  `GET /operator/accounts`, `/operator/rooms` and `/operator/rooms/:id` handed to `operatorRooms`, and
  `/operator/room-counts` handed to `operatorRoomCounts` [src/http/stats.ts:statsRoutes]
- `operatorRooms`: `GET /operator/rooms` lists every room newest first, one read of `limit + 1` rows from
  `listRoomsPage`, or `listRoomsFiltered` when `created_by`, `org`, `hosted` or `public=true` is given, each row
  joined to its `roomSummary` and its creator's handle (`{rooms, next}`, each row with `created_by_handle`;
  `?limit=` 1 to `MAX_ROOMS_PAGE` 50, `?after=` a page's `next`, filters `?created_by=`, `?public=`, `?hosted=`,
  `?org=` an org id or `~none`, `?status=` open | closed | frozen | purge_scheduled); `GET /operator/rooms/:id`
  one room with its `purpose` and role names [src/http/operator-rooms.ts:operatorRooms] [src/http/operator-rooms.ts:pageOf]
- `operatorRoomCounts`: `GET /operator/room-counts?by=owner|org` (`{by, total_rooms, groups: [{key, label, rooms}],
  next}`; largest first, ties by key; `?limit=` 1 to 100, default 50; `?after=` a page's `next`, `<rooms>:<key>`;
  the no-org group's key `~none`; an owner labelled by handle, an org by name) [src/http/operator-rooms.ts:operatorRoomCounts]
- `orgRoutes`: `GET|PATCH /org`; `GET|POST /org/members`; `PATCH|DELETE /org/members/:key`;
  `POST /org/members/:key/resend`; `GET|PUT|DELETE /org/idp`; `POST /org/domains`;
  `DELETE /org/domains/:domain`; `POST /org/domains/:domain/verify`; `GET /org/scim`;
  `POST|DELETE /org/scim/token`; any other `/org/*` is 404 [src/http/orgs.ts:orgRoutes]
- `memberView`, `inviteView`, `OrgRouteDeps` [src/http/orgs.ts:OrgRouteDeps]
- `scimRoutes` under `/scim/v2`: `GET /ServiceProviderConfig`, `/ResourceTypes`, `/Schemas`; `GET|POST /Users`;
  `GET|PUT|PATCH|DELETE /Users/:id`; `GET /Groups` (empty list); `MAX_SCIM_BODY_BYTES` 16 KB, `SCIM_PAGE_MAX`
  200 [src/http/scim.ts:scimRoutes]. Parsers and the room walk live in [`../scim/EGM.md`](../scim/EGM.md).

Moderation and public routes:

- `moderationRoutes`: `GET|POST /rooms/:id/bans`, `DELETE /rooms/:id/bans/:banId`, `GET|POST /rooms/:id/reports`,
  `GET /account/bans`, `DELETE /account/bans/:banId`; `MAX_BAN_BYTES` 1024, `MAX_REPORT_BYTES` 4096
  [src/http/moderation.ts:moderationRoutes]
- `routeOrigin(request, panelOrigins, publicPageOrigins)`: the allowed Origin, also used by the Worker's
  suspension gate [src/http/moderation.ts:routeOrigin]
- `publicRoutes`: `GET /public/rooms`, `/public/rooms/:id` (id or public name), `/surface`, `/events`,
  `/agent-card.json`, `/blobs/:blobId`, `GET /public/handles/:handle`,
  `GET /a2a/:id/.well-known/agent-card.json` (0.3 card) [src/http/public.ts:publicRoutes]
- `PublicRouteDeps {store, blobs, oauth?}` [src/http/public.ts:PublicRouteDeps]

## Invariants

- No caller is 401. A missing room and a caller with no handle in it get the same 404; a non-creator member gets
  403 on creator-only routes, checked before the body is read [src/http/rooms.ts:unpublishRoom]
- Every cookie-authenticated write runs `csrfRefusal` before any write, including the `lastSeenAt` touch in
  `gateSeat`; bearer callers are exempt [src/http/rooms.ts:uploadBlob]
- An org admin reads a room only when it is closed, `auditRefusal` passes, the room's orgs include the admin's
  org, and the admin holds no handle in it or only removed ones; such an admin gets 403 on writes while strangers keep the 404
  [src/http/rooms.ts:admitsAdmin]
- A member whose every handle the creator removed reads roster, surface and events only up to its cut, and is
  refused blob downloads [src/http/rooms.ts:readEventsRoute]
- A JSON body needs a digit `Content-Length` (400) under the route's maximum (413) before it is parsed
  [src/http/rooms.ts:lengthRefusal]
- Upload refuses from headers before reading the body (411, 413, the `write_surface` verb, quota); it stores
  first, then charges, and deletes the blob if the charge is refused [src/http/rooms.ts:uploadBlob]
- Downloads are never `text/html`: allowlisted images inline, everything else an attachment, with `nosniff` and a
  CSP sandbox [src/http/rooms.ts:blobResponse]
- Events are wrapped by `untrusted()` with the sender's member id and label [src/http/rooms.ts:readEventsRoute]
- `?after` and `?query` cannot combine; nor can `?window`/`?next` with `?query` [src/http/rooms.ts:windowParams]
- `DELETE /rooms/:id` needs a closed room (409 when open) and is idempotent [src/http/rooms.ts:deleteRoom]
- Audit and org routes act on the caller's own org, never a parameter; an unknown or repeated audit query
  parameter is 400, never dropped [src/http/audit.ts:parseAuditQuery] [src/http/orgs.ts:orgRoutes]
- A CSV cell starting with `= + - @`, tab or CR gets a leading `'`; an export failure partway errors the stream
  so a short file never looks complete [src/http/audit.ts:csvCell] [src/http/audit.ts:exportAudit]
- The org owner's grant cannot be re-seated, demoted or removed (409); `require_sso: true` needs an IdP and a
  verified domain; seats are counted (409 full) [src/http/orgs.ts:isOwner]
- A DNS resolver failure is 502, never "unverified" [src/http/orgs.ts:orgRoutes]
- The operator check (403 `not_available`) comes before the method check in `/operator/*`, the rooms routes
  included, and nothing past `/operator/rooms/:id` is served [src/http/stats.ts:statsRoutes]
- Operator room reads return metadata, counts and states, never a brief, an event body or a surface item's
  content; an unknown query parameter is 400. A row whose `roomSummary` rejects stays with its summary fields
  null and is never dropped; a row whose room is gone is skipped and deleted from the index
  [src/http/operator-rooms.ts:summarised]
- A `RegistryDO` still on the code before a deploy answers the counts and a filtered list 503 `not_ready`, with
  nothing audited [src/http/operator-rooms.ts:notReady]
- Every operator room read is audited before it answers, and fails closed: a failed audit write is a 500 with no
  room [src/http/operator-rooms.ts:operatorRooms]
- `GET /rooms/:id/decisions` admits callers as the events read does: a member, a removed member up to its cut
  (with `open` empty), or an org admin reading a closed room; anyone else gets the 404. `?before` and `?limit`
  out of range are 400 [src/http/rooms.ts:readDecisionsRoute]
- Decisions are shown with proposals and vote reasons wrapped by `untrusted()` and each account as an alias
  (`a1`, `a2`, ...), never the upstream user id [src/projections.ts:decisionShown]
- SCIM refuses in a fixed order (404 path, 405/501 method, 401 when the hashed bearer token maps to no org, then
  body); the token's org scopes every operation [src/http/scim.ts:scimRoutes]
- Public routes read no credential, answer `access-control-allow-origin: *`, GET/OPTIONS only; a room not
  publicly readable is one 404 decided before anything else [src/http/public.ts:publicRoom]
- Public reads drop briefs, wrap peer content with `untrusted()`, and replace each `label` with the member's
  number so sign-in labels and emails are not shown [src/http/public.ts:byNumber]
- A public blob is served only if an item on the room's surface names it [src/http/public.ts:publicRoutes]
- Report filing answers 201 new, 200 folded into an open report, 429 with `Retry-After`; only `POST`/`OPTIONS`
  on `/rooms/:id/reports` admit public-page origins [src/http/moderation.ts:fileReport]

## Side Effects

- Surface writes through `writeSurface` / `writeSurfaceBatch`; blob `put`/`delete` and `chargeBlobBytes`
  [src/http/rooms.ts:writeSurfaceRoute] [src/http/rooms.ts:uploadBlob]
- Store writes `schedulePurge`, `unpublishSession`, `signRoom`/`unsignRoom`, `setPublicView`,
  `setHostInstructions` (a `host_instructions_changed` audit row per org, with length only), `issueInvite`
  [src/http/rooms.ts:writeHostInstructions]
- Audited org writes (org update, SCIM token issue storing only its SHA-256 hash, IdP put/delete with the client
  secret sealed, domain claim/verify/release, invites, grants) [src/http/orgs.ts:orgRoutes]
- Network: OIDC discovery on `PUT /org/idp`, DNS TXT lookup on verify, invite mail after the org's daily mail
  budget is spent [src/http/orgs.ts:sendInvite]
- Audit sink and retention writes; streamed export with `content-disposition: attachment`
  [src/http/audit.ts:exportAudit]
- `claimHandle`/`releaseHandle`; `putPreset`/`deletePreset` [src/http/handles.ts:handleRoutes]
  [src/http/presets.ts:writePreset]
- Bans via `evictMember`/`banAsker`, lifts via `liftRoomBan`/`liftCreatorBan`; reports via `fileRoomReport` and
  `mailReport` [src/http/moderation.ts:banMember]
- Operator room reads write an `operator_rooms_listed` or `operator_room_read` entry to the operator's stream
  (`appendOperatorAudit`); a single-room read also writes an `operator_room_read` row (`appendAudit`) to each org
  that sat in the room [src/http/operator-rooms.ts:operatorRooms]
- `GET /rooms/:id/decisions` only reads; the store may write its decision index rows on the way
  [src/http/rooms.ts:readDecisionsRoute]
- SCIM user create/update/delete with `scimIntent(orgId)`; deactivation walks rooms with `departedRooms`,
  reactivation with `thawRooms` [src/http/scim.ts:scimRoutes]
- Every router logs a thrown handler with `console.error` and answers 500; org failure logs redact
  `/org/members/:key` [src/http/orgs.ts:orgRoutes]

## Verification

- Run: `npm test -- tests/http- tests/scim.test.ts tests/stats.test.ts tests/operator-rooms.test.ts
  tests/projections.test.ts`
- Run: `npm run test:worker` (`worker-tests/room-routes.test.ts`, `moderation-routes.test.ts`,
  `operator-rooms-routes.test.ts`)
- Full gate: `npm run verify`
