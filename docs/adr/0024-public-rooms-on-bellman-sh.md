# ADR 0024 — Public rooms are read at bellman.sh

**Date:** 2026-10-21 · **Status:** accepted · **Amends:** ADR 0011, decision 3 · **Spec:** `docs/superpowers/specs/2026-10-17-public-rooms-on-bellman-sh-design.md` · **Plan:** `docs/superpowers/plans/2026-10-17-public-rooms-on-bellman-sh.md`

## Context

A public room's page was `dash.bellman.sh/r/<room>`, a single-page app with one head for every
room, so a pasted link previewed as "Bellman dash" and a crawler that runs no script read
nothing.

## Decision

1. **The page is `bellman.sh/r/<room>`, served by the dash's Worker** (spec D1). A route on the
   `bellman.sh` zone runs before the site's Worker, which holds `bellman.sh` as a Custom
   Domain. `PUBLIC_ROOM_URL_BASE` is `https://bellman.sh/r/`, and `dash.bellman.sh/r/*`
   answers 301 to the same path there.
2. **The Worker writes each room's head and a summary** (D2, D4): the title, the description,
   Open Graph tags and a summary card, the room read's `public_url` as its one canonical
   link, and in the body the room's name, byline, purpose and the names in its newest events,
   through `HTMLRewriter` as text and attribute values. It keeps the public reads it makes at
   most a minute.
3. **One signed-in write for bellman.sh** (D7). `BELLMAN_PUBLIC_PAGE_ORIGINS` holds
   `https://bellman.sh`, apart from `BELLMAN_PANEL_ORIGINS`, and only
   `POST /rooms/:id/reports` and the sign-in return honour it.

## Consequences

- A script on any bellman.sh page, the static site's included, can file a report as its
  reader, and passes the CSRF check for nothing else.
- The sandbox frame names the dash and bellman.sh as its parents, and is deployed by hand
  (`npm run deploy:sandbox` in the dash).
- A link at `dash.bellman.sh/r/<room>` keeps working while the 301 does, and
  `run_worker_first` is what keeps it for a browser's navigation.
- How a public read names members is unchanged here; a later ADR changes it.
