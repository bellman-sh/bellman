# ADR 0015 — The working surface: keyed items, last write wins, html only on another origin

**Date:** 2026-10-06 · **Status:** accepted · **Recorded:** 2026-10-09 · **Closes:** #129, #183, #185 · **Spec:** `docs/superpowers/specs/2026-10-06-working-surface-design.md`, `docs/superpowers/specs/2026-10-06-surface-html-artifacts-design.md`

## Context

A room's durable state was its event log, and a member joining at hour three
read the creator's brief from minute zero (#129). The room scribe spec had
proposed one summary document, written by its own tool and appending no event.
What a room accumulates is a plan, a decision list, a diagram, a link and the
lines between them, which a writer wants to address, place and connect. Some of
it is code from a peer (ADR 0008), for a panel that holds the account cookie.

## Decision

1. **The surface is a set of keyed items, not a document.** An item has a key in
   the role-key grammar (`SurfaceKeyShape`), a kind from the closed
   `SURFACE_KINDS`, and an optional placement. Writing a key replaces its item,
   so a writer needs no read first. Four kinds came first, then `file` and
   `image` (PR #192), `html` (PR #206) and `shape` (PR #240). A connector joins
   two items that are not connectors, and a removal cascades to nothing.
2. **A write is `bellman_send type: "surface"`, and it appends an event.** It
   needs `write_surface`, which each preset gives its creator seat (ADR 0009).
   `writeSurface` (`src/rooms.ts`) is the one write path, for the tool and for
   `PUT` and `DELETE /rooms/:id/surface/:key`. The event is ambient, and every
   version of every item stays in the log at its cursor (ADR 0004).
3. **An item is a row written in the event's transaction, and the last write
   wins per key.** The row is `sf:<key>` in `SessionDO`, put or deleted through
   `AppendExtras.surface` with the event. `applySurfaceWrite`, shared by both
   stores, replaces a row only for a higher cursor; there is no compare-and-set.
   A replay applies no surface write, a removal leaves no tombstone, and
   `surfaceCursor` moves in the same put only when a row changed.
4. **No verb gates a read.** `bellman_connect` shows an index with no prose
   (`surfaceIndex`). `bellman_confirm`, `bellman_sync` with `surface: true` and
   `bellman_surface` return each item in an untrusted envelope with its writer
   as origin; every poll carries `surface_cursor` once the surface has changed.
5. **A blob-backed item carries the bucket's record, and `html` renders only on
   another origin.** A `file` or an `image` names a blob in R2 under
   `rooms/<sessionId>/<blobId>`, and an `html` page is a blob or an inline body,
   never both. `writeSurface` copies the object's size, type and name onto the
   item, and an `html` blob must be stored as `text/html`. `mcp.bellman.sh` never
   serves stored bytes as a page: `blobResponse` sends all but four image types
   as an `application/octet-stream` attachment, with `nosniff` and
   `Content-Security-Policy: sandbox`. The panel renders `html` and `diagram`
   items in a frame on `bellman-sandbox`, a `workers.dev` Worker cross-site to
   `bellman.sh` that no cookie reaches, under `connect-src 'none'` (`framePolicy`
   in `bellman-sh/dash`). In the MCP App an inline page goes into a nested
   `sandbox="allow-scripts"` frame, an opaque origin, where a probe shows the
   host allows one (`artifactFrame`, ADR 0016).

## Consequences

- A race on one key loses nothing: the later append wins and the earlier version
  stays in the log; the upgrade is an `expect_cursor` refused inside the append.
- The 64-item cap and a connector's ends are courtesy bounds (the spec's word),
  read outside the append's transaction: two writes can both add a 64th item.
- A closed room's surface stays readable to its members until the purge, after
  the window its creator's plan keeps closed rooms (#65).
- `bellman_send`'s `html` clause says what the policy does not close: in Chromium
  a page naming a STUN or TURN server reaches that host over WebRTC.
