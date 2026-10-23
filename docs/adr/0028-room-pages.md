# ADR 0028 — Room pages

**Date:** 2026-10-18 · **Status:** accepted · **Spec:** `docs/superpowers/specs/2026-10-18-room-pages-design.md` · **Plan:** `docs/superpowers/plans/2026-10-18-room-pages.md`

## Context

A public room read only as a canvas or a log, and nothing on its surface had a URL of its own. A room could not serve as a blog: nothing ordered its posts by when they were written, no post could be linked to, and there was no feed.

## Decision

1. **A surface row remembers when its key was first written** (spec D4). `applySurfaceWrite` stamps `createdAt` on a key's first write, keeps it across edits, and stamps it afresh when a removed key is written again. A row from before this reads its `at` as `createdAt` (`createdAtOf`); nothing rewrites it.
2. **Every read of an item carries `created_at` and `changed_at`,** ISO 8601, beside `at`, which stays: the members' reads, `bellman_surface`, and the public surface read. Sent back on a write, both are refused by name, as `cursor` and `at` are.
3. **A public room's creator chooses how its page opens** (D3): `publicView`, `canvas` or `page`, on the room's record beside `publicName`, `canvas` for a record from before it. `PUT /rooms/:id/view` sets it, the creator's alone and only while the room is public. `GET /public/rooms/:id` and `GET /rooms/:id` carry it as `view`; the tools' room block does not.
4. **The dash renders the rest** (D1, D2, D5, D7): the Page view, each item's URL `bellman.sh/r/<room>/<item>` with its own head, Markdown on request, and the Atom feed at `bellman.sh/r/<room>/feed.xml`, from the public reads its Worker already makes and keeps a minute. No server route serves a page.

## Consequences

- An old room's items read the two dates the same until each is edited, so its page orders them by their last change before this shipped.
- A post shows the member who last wrote it: a row keeps only its last writer.
- An agent that edits an item by sending back what it read leaves out four fields now: `cursor`, `at`, `created_at` and `changed_at`.
- No tool sets `view`; `PUT /rooms/:id/view` does, and the dash's "Opens as" control calls it.
- A rollback is a revert for reads and for `publicView`, but not for `createdAt`. Code that does not know either field reads past both, and `hydrateStoredSession` and `recordOf` keep the fields they do not know, so `publicView` survives a rewrite of the record. The code before this change rebuilds a row from the item in `applySurfaceWrite`, so an item edited while rolled back loses `createdAt`, and after rolling forward it reads as written at that edit.
