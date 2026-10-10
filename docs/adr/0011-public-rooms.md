# ADR 0011 — Public rooms are read without sign-in and name members by number

**Date:** 2026-10-09 · **Status:** accepted · **Recorded:** 2026-10-09 · **Spec:** `docs/superpowers/specs/2026-10-09-public-rooms-design.md`

## Context

A room's work was readable only by its members. A room run in the open, a public
review or a design worked through for others to follow, had no way to show its
surface and its conversation short of inviting people in, which also lets them
speak. A member's label is how they signed in, an email address for most.

## Decision

1. **A room is public only if marked so when it starts.** The manifest takes
   `public` on both arms, false unless given (ADR 0009). A saved preset's value is
   the default for its rooms and a cite's own wins; the built-ins are private.
   Nothing makes a room public after it starts: its members joined on the promise
   of a private room (spec D2).
2. **The creator can make it private, for good.** `POST /rooms/:id/unpublish` is
   the creator's alone (`session.createdBy`): 204, and 204 again with the first
   time kept, 403 to a member who is not the creator, and the route's one 404 to
   anyone else. `isPublic` in `src/rooms.ts` reads `manifest.public === true` and
   no `unpublishedAt`.
3. **Anyone with the link reads, with no credential.** `src/http/public.ts`,
   mounted in the Worker and the Node app, answers `GET /public/rooms/:id`,
   `/surface` (its cursor as the `ETag`), `/events` (200 at a time, from `?after`)
   and `/blobs/:blobId`. It reads no cookie or bearer and answers every origin with
   `*`, never with credentials. A private, unpublished, unknown or purged room is
   one 404 with one body. The link is the room's id: `qs_` and a random UUID.
   `bellman_start` returns the page as `public_url`, under `PUBLIC_ROOM_URL_BASE`
   (`https://dash.bellman.sh/r/`), and tells an agent to share it and not `join_url`.
4. **A reader sees the surface and the log, never a brief.** `publicReadEvent` in
   `src/public-event.ts` leaves out `brief_update` and cuts `member_joined` to the
   joiner's id, label and seat. A blob downloads only while an item on the surface
   names it. A closed public room reads until its purge.
5. **Members are named by number.** `publicNames` calls them `member 1`, `member
   2` and on, in the order they joined, keyed by label, so one person's handles
   share a number; the hosted seat keeps `host@bellman` (ADR 0002). `byNumber`
   swaps every property named `label` that holds a member's label, at any depth,
   in every public answer. Spec D4 showed labels; #233's review replaced them
   before merge.
6. **Joining still takes a code, and joiners are told first.** The preview's
   trusted spine carries `public` (`roomPreview`), `bellman_start` and
   `bellman_connect` say what it means, and the MCP App's join screen says "Anyone
   with this room's link can read its surface and its log."

## Consequences

- A public room gives up confidentiality on purpose (spec D8): its surface, its
  log and the files on its surface are readable by anyone with the link, and its
  briefs, a blob no item names and its members' labels are not. Peer content is
  still text, and the public page has no write path (ADR 0008).
- A label a member types into a message is shown as typed: the renaming matches
  `label` properties, not text. Member ids and seats still show.
- The page seats nobody. A public link is for reading, and only a code joins
  (ADR 0010).
- The public reads have no rate limit beyond Cloudflare's (spec D9).
- Deferred at merge (#233): images and file links on the public page carry dash's
  cookie, which the route ignores; a made-up room id starts a Durable Object; an
  open page keeps polling after the room goes private.
