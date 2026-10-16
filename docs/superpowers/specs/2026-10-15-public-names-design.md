# Public names. Design

**Date:** 2026-10-15
**Status:** approved in conversation; implementation plan to follow
**Builds on:** the public rooms spec (`2026-10-09-public-rooms-design.md`), and its D10 (public rooms are a paid plan's)
**Citations:** by symbol, of the code as it stood when this was written.

## Problem

A public room's page is `dash.bellman.sh/r/<session id>`, and a session id is
`qs_` and a UUID (`generateSessionId`, `publicRoomUrl`). Shared, the link says
nothing about the room, and nobody could read it aloud or type it.

## Decisions

**D1. A name is chosen, never made up.** A public room has its permanent link
until someone sets a name for it, at start or later. Nothing derives a name
from the room's own, and no code is appended to make one unique: a caller who
finds a name taken chooses another. A room without a name keeps a link nobody
can guess. A room with one can be found by anyone trying names, which is what a
name is for.

**D2. What a name may be.** 3 to 40 characters of lowercase letters, digits and
single hyphens, starting and ending with a letter or digit:
`^(?=.{3,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$`. Anything else is refused with that
rule in words, never rewritten, so the name checked is the name set. A name has
no `_`, so it can never be read as a session id.

**D3. One tool, `bellman_public_name`.** With `name` alone it checks, and
returns `{ name, free }`. With `name` and the room (`session_id`, or its alias
`room_id`, as every room tool takes it) it sets the name, and returns
`{ name, public_url }`:

- only for the room's creator, checked as `unpublishRoom` checks it: a member of
  theirs in the room, and `createdBy` theirs;
- only on a room that is public (`isPublic`) and open;
- a taken name is refused; the name the room already holds is returned as it is;
- a new name replaces the room's current one, which is free at once.

Checking needs no plan. Setting needs a public room, which needs a paid plan
(public rooms spec, D10). A room made public before this has no name, and its
creator can set one the same way.

**D4. `bellman_start` takes `public_name`.** An argument beside `manifest`, not a
field in it: a saved preset is started many times, and a name is held by one
room. It needs the resolved manifest to be public. Invalid, taken, or given for
a private room, it is refused before anything is created or counted against the
monthly limit, and the refusal names the cure: another name, or none now and
`bellman_public_name` later.

**D5. Who holds a name.** The room whose own record names it (`publicName`),
while that room is public and open. The registry keeps an index from name to
room, read as a hint. An entry whose room no longer names it, has closed, has
been made private, or was never created is free, and the next claim takes it
over. A claim writes the index only if the entry is still what the claimer
read, so of two claims on one name exactly one wins.

Nothing runs when a room closes, goes private or is renamed. The room's record
is the truth and the index a hint, as the store is truth and the channel
transport. A claim that wins the index and then fails to write the room's
record leaves an entry no room names, which is free.

**D6. Reading.** `GET /public/rooms/:key` takes a name or a session id. A name
resolves through the index and D5's check, and a free name is not found. A
session id reads as the public rooms spec says, so a closed room stays readable
there until its record is purged (its D7), while its name is free from the
moment it closed. That was decided in conversation: a name is released when its
room ends, and an old link may then open another room.

**D7. Where the name appears.**

- `public_url` is the name's link when the room has one and the session id's
  otherwise, from one function every caller uses (`publicRoomUrl`, taking the
  session). `bellman_start` and a set return it, and the MCP App's card shows
  whatever it is given.
- The session gains `publicName: string | null`, read as null for rows written
  before it. `roomPreview`, which carries `public` to the members' room read
  (dash), to `bellman_connect` and to `bellman_start`, gains `public_name`. Like
  a role key it is chosen by the creator but held to a grammar the server checks,
  so it sits beside `public` rather than in the untrusted envelope.
- Dash, in its own PR after bellman deploys: the canvas header's copy link uses
  `public_name` when set. The public page passes the URL's segment to
  `GET /public/rooms/:key` as it does now, so it needs no change.
- `extension/manifest.json` lists `bellman_public_name`.

**D8. Cost.** Every tool's definition is sent on every request, which is why one
tool checks and sets rather than a lookup and a setter. With `public_name` on
`bellman_start`, the listing is estimated to grow 250 to 300 tokens over 8,102,
to be measured and recorded in ARCHITECTURE §11 when built.

## Testing

- The rule: a table of names accepted and refused (the length bounds, capitals,
  `_`, a hyphen leading, trailing or doubled).
- Free, taken, and free again: after a rename, a close, being made private, and
  for a room never created.
- Setting: the creator only; a public, open room only; a new name frees the
  old; a taken name refused; the held name returned unchanged.
- `bellman_start`'s `public_name`: free (the room holds it and `public_url` is
  its link); taken (nothing created, nothing counted); for a private room,
  refused.
- Two claims on one name at once: exactly one wins, in the store contract, so
  on `MemoryStore` and the registry Durable Object alike.
- `GET /public/rooms/:key` serves a room by its name and by its session id, and
  a freed name is not found.
- `extension/manifest.json` against the bridge's surface
  (`tests/extension.test.ts`), and the description against the handler's
  refusals (`tests/tools/surface.test.ts`).
- Dash: the copy link with a name and without one.

## Out of scope

- Reserved names. Only a paid plan can make a public room, which is the
  friction; revisit when a name is abused.
- Suggesting free names when one is taken.
- Setting a name from dash: the creator's agent sets it.
- Redirecting `/r/<session id>` to the room's name.
- Clearing a name without setting another: making the room private frees it.
