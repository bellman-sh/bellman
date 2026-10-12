# Public rooms. Design

**Date:** 2026-10-09
**Status:** approved in conversation; implementation plan to follow
**Builds on:** #183 and #184 (the room routes), #221 (the room's log over HTTP), #65 (the durable record and its purge), #224 and dash#21 (saved presets)
**Citations:** by symbol, of the code as it stood when this was written.

## Problem

A room's work is readable only by its members. A room run in the open (a
public review, a design worked through for others to follow, a demo) has no
way to show its working surface and its conversation to anyone else, short of
inviting them in, which also lets them speak.

A public room is readable by anyone with its link and joinable only as any
room is: with a code.

## Decisions

**D1. Public or private, chosen when the room starts.** The manifest gains
`public: boolean`, false unless given, accepted on both arms like `room` and
`purpose`. A saved preset carries it as the default for the rooms started from
it, which is the designer's checkbox: citing a saved preset, the room is public
when the cite says so, else when the preset does. The built-ins are private.
The stored manifest reads `public: false` for a room written before it.

**D2. The creator can unpublish, never publish later.** The session gains
`unpublishedAt: number | null`, mutable, read as `null` for older rows. A room
is publicly readable when `manifest.public` is true and `unpublishedAt` is null
(`isPublic`, runtime-free). `POST /rooms/:id/unpublish` sets it: the room's
creator only (`session.createdBy`), by bearer or by the panel's cookie behind
the CSRF check; 204, and 204 again; 403 to a member who is not the creator; the
route's one 404 to anyone else. A new `BellmanStore.unpublishSession(id, at)`,
pinned on both stores by the contract. Nothing turns a room public after it
starts: its members joined on the promise of a private room.

**D3. Anyone with the link reads, with no credential.** A new module,
`src/http/public.ts`, mounted in both servers, answers `GET` under
`/public/rooms/:id`, reads no credential at all, and answers every origin
(`access-control-allow-origin: *`, never credentials). A room that is not
publicly readable (private, unpublished, unknown, purged) gets one 404 with one
body. The link is the room's id, a random UUID.

- `GET /public/rooms/:id`: `{ id, status, closed_at, mode, text }`, `text` the
  creator's envelope holding the room's name and purpose, as the preview sends it.
- `GET /public/rooms/:id/surface`: `{ surface_cursor, items }` with the surface
  cursor as its `ETag`, as the member route answers.
- `GET /public/rooms/:id/events[?after=<cursor>]`: the newest 200 events, or
  the next 200 past `after`, as the member route answers, in the projection D4
  sets.
- `GET /public/rooms/:id/blobs/:blobId`: a blob's bytes under the member
  download's headers (an attachment, `nosniff`, a `sandbox` policy), only for a
  blob an item on the surface names. A blob uploaded and never placed stays the
  members'.

**D4. What a reader sees: the surface and the log, never a brief.** Surface
items as members read them. Events as members read them, through `publicEvent`
and the untrusted envelope, except: `brief_update` events are left out, and a
`member_joined` payload is reduced to `{ member: { member_id, label, room_role
} }`, which drops the brief, the org, the agent and the capabilities. A member's
label is shown on what they wrote, as members see it.

**D5. Members are told before they join.** `roomPreview`'s trusted spine gains
`public: boolean` (the room as it stands, from `isPublic`). `bellman_connect`'s
description says what it means. The MCP App's join screen shows "Anyone with
this room's link can read its surface and its log." The monitor marks a public
room. Dash's canvas header shows "Public", a "Copy public link" button, and,
for the creator, "Make private" (D2).

**D6. The page: `dash.bellman.sh/r/<id>`, outside sign-in.** The room's name
and purpose as the creator's words, the canvas read-only, and the log, each
polling the public routes with no credentials. Images and files come from the
public blob route, and an `html` item's bytes are fetched from it for the
sandbox frame. The canvas's nodes take their blob URLs from context, so the
member page and the public page share them.

**D7. A closed public room stays readable** until its record is purged (#65),
as it does for its members. A purged room is the 404 of D3.

**D8. The trust trade, stated.** This deliberately gives up confidentiality
for a room marked public: its surface, its log and the files on its surface are
readable by anyone with the link. Rendering is unchanged: peer content is text
on the public page as on the member's, and the public page has no write path.
Briefs never leave, nor does a blob that is not on the surface. Members consent
at the preview, before they join.

**D9. Ponytail: no rate limit beyond Cloudflare's.** The reads are the
members' own: a surface read answered from the record on an `ETag` match, and
an events read bounded at 200.

**D10. A paid plan's (decided 2026-10-10, after D1 to D9 shipped).** `publicRooms` in
`ENTITLEMENTS` is false on free and true on pro, max and team. `bellman_start` refuses a
public room on free after the manifest resolves, so a cite's `public` and a saved preset's
default meet the same check, and the refusal creates and counts nothing. Like every plan
gate it is read at creation only: rooms already public stay public, a plan that lapses does
not unpublish one, and a free account may still save a preset that defaults to public.

## Testing

Every assertion runs against a broken version first and must fail there.

- Manifest: `public` on both arms, false by default, read false for an old row;
  a saved preset's `public` is the default and an explicit cite wins.
- Preview: `public` in the trusted spine, from `isPublic`.
- Unpublish: the creator gets 204 twice, a member 403, a stranger 404; the
  public routes then 404; nothing republishes. Contract: `unpublishSession` on
  both stores.
- Public routes: a public room 200 with no credential and with `*`; a private,
  an unpublished, an unknown and a purged room the same 404; the events
  projection drops `brief_update` and reduces `member_joined`; a blob on the
  surface downloads and one not on it does not; a closed public room still
  reads. Mounted in the Worker (a worker test) and the Node app.
- Dash: the public page renders the surface and the log from the public routes
  without credentials; the canvas header's badge, link and Make private.
- MCP App: the join screen's notice for a public room.

## Out of scope

- Making a private room public after it starts.
- Listing or discovering public rooms.
- Per-item or per-event visibility.
- Joining without a code.
- A rate limit of our own.
