# Public rooms on bellman.sh: design

**Date:** 2026-10-17 · **Status:** for review

Amends `2026-10-09-public-rooms-design.md` (where the public page is served, and how it names members) and `2026-10-15-public-names-design.md` (the link's host).

## Goal

A public room's page lives at `bellman.sh/r/{room}`, not `dash.bellman.sh/r/{room}`. A shared link previews with the room's name and purpose, and search engines can index it. The page names each member by their public handle when they have one.

Success means:

- `bellman.sh/r/{room}` serves the public room page, and every public link the server hands out starts there.
- A link pasted into Slack or X unfurls with the room's name and purpose, and a crawler that runs no script still reads the room.
- A member with a handle appears as `@handle` on the public page. Everyone else is "member N". No sign-in label appears.
- Links already posted at `dash.bellman.sh/r/{room}` still reach the room.

## Decisions

- **D1. A Cloudflare route sends `bellman.sh/r/*` to the dash's Worker,** which serves its existing public page there. The site's Worker is untouched, and there is one implementation of the page. (Rejected: the site's Worker proxying the dash's page, which ties the site's deploys to the dash's build; and rebuilding the page in the site, a second copy of the log and canvas.)
- **D2. The dash's Worker gains a small script.** Today it serves assets only. The script writes each public room's head as it serves the page, and loads the app's scripts from `dash.bellman.sh`.
- **D3. A member's public name is their handle, else "member N"** (amending the public rooms spec's numbering). Only names people chose to publish appear.
- **D4. Untrusted text stays text.** The room's name and purpose, and members' names, are written into HTML as text and into attributes as escaped values, never as markup.
- **D5. Handles are cached for an hour, and a released name is held for longer.** Public pages poll every 4 seconds, so reading handles from the registry on every poll would put every viewer's polls on one object. The server caches each account's handle for an hour where it serves public reads. A name that is released, changed away from, or released by an operator can't be claimed by any account, its last holder included, for 65 minutes: longer than the hour a name can sit in the server's cache plus the minute it can sit in the dash's preview cache. So no message ever shows under a name another account now holds. (The owner's choice, 2026-10-17, over a one-minute cache and over storing handles in each room.)
- **D6. Names ship 30 days after notice.** Naming current handle holders in every public room changes how their data is used, and the privacy policy promises at least 30 days' notice of such a change, by email or in the service.
  - The move ships first and the names later: the server's work splits into the move (2a) and the names (2b), and the site's the same way (3a, 3b).
  - On the notice day the site posts the new privacy policy and terms with an effective date 30 days on, and the owner emails every account holding a handle, from the owner's own mailbox. The dash's Settings copy changes with 2b or right after it.
  - An operator-only listing of handle holders, each with the sign-in label of a room they sat in, gives the email's recipients.
  - 2b merges on or after the effective date. (The owner's ruling, 2026-10-17.)
- **D7. One signed-in write for bellman.sh.** `https://bellman.sh` does not join `BELLMAN_PANEL_ORIGINS`. A separate list, `BELLMAN_PUBLIC_PAGE_ORIGINS`, holds it, and only `POST /rooms/:id/reports` (its CORS and its CSRF check) and the sign-in return honour it. A script on a bellman.sh page can file a report as its reader, and make no other signed-in call. (The owner's ruling, 2026-10-17.)

## 1. Serving bellman.sh/r/{room}

- **The route.** The dash's `wrangler.toml` gains a route for `bellman.sh/r/*` on the `bellman.sh` zone. The more specific route wins over the site's.
- **The script:**
  - For `/r/*` on `bellman.sh`, it serves the app's page with its script and style links pointing at `https://dash.bellman.sh/assets/…`.
  - `dash.bellman.sh/r/*` answers 301 to the same path on `bellman.sh`, so links already posted keep working.
  - Every other request goes to the assets as now.
  - The dash's `/assets/*` answer with CORS for `https://bellman.sh`, so the module scripts load there.
- **The server:**
  - `PUBLIC_ROOM_URL_BASE` in `src/codes.ts` becomes `https://bellman.sh/r/`. The tool texts that name `dash.bellman.sh/r/…` follow (`bellman_start`, `bellman_public_name`).
  - `BELLMAN_PUBLIC_PAGE_ORIGINS`, holding `https://bellman.sh`, lets the Report form's signed-in post pass CORS and the CSRF check (D7). Every other credentialed route keeps refusing bellman.sh.
  - The sign-in return honours the same list, so "Sign in to report" comes back to the room.
  - Cookies still travel, because `bellman.sh` and `mcp.bellman.sh` are the same site.
- **Links out of the page,** such as a handle's page or the dash itself, point at `dash.bellman.sh` in full.

## 2. Previews and search

- **The head.** For `bellman.sh/r/{room}`, the script reads the room's public data from `mcp.bellman.sh/public/rooms/…` and writes:
  - the title, as "<room> · Bellman";
  - the description, from the room's purpose;
  - `og:title`, `og:description`, `og:url` and `og:site_name`;
  - a Twitter summary card;
  - a canonical link to the room's own public link, its public name's while it holds one and its id's otherwise, with `og:url` the same.
- **A summary for crawlers.** The body gets a plain block: the room's name and purpose, its byline if signed, and the members' public names (section 3). The app replaces the block when it loads, so readers see the live page, while a crawler or link unfurler that runs no script still reads the room.
- **A short cache.** The script caches a room's public data for at most a minute, so repeated unfurls don't each reach the API. A room made private stops being described within that minute.
- **No room, or not public:** the head stays generic, the page answers 404, and nothing about the room is written. The app shows its usual "not found".

## 3. Names

- **Where names are made.** The server's public projection (`src/http/public.ts`, where "member N" is made today) names each member by the handle their account has claimed, as `@handle`, and anyone without one as "member N". The hosted seat keeps its own label.
- **Every place a label appears is covered:** envelope origins, event senders, joins, leaves, evictions, the roster and surface writers. That's the same set "member N" covers today.
- **One person's seats share a name,** as they share a number now. A claimed, changed or released handle reaches public pages within the hour (D5).
- **The hold.** While a released name is held, claiming it answers "taken" to every account, its last holder too, so a holder can't undo an operator's release.
- **The consequence:** a member's handle shows in every public room they hold or held a seat in. Claiming a handle makes their public participation visible under it, not only in rooms they signed.
- **The dash** still relabels a signed room's creator, and keeps doing so until 2b names everyone.

## 4. Tests, docs and rollout

- **Server names:**
  - a member with a handle shows as `@handle`, and one without as "member N";
  - the hosted seat keeps its label;
  - a released handle still shows within the cache's hour, and goes back to "member N" after it;
  - a released, changed-away or operator-released name answers "taken" to every account, its last holder included, for 65 minutes, and can be claimed after;
  - no public response contains a member's sign-in label, checked against every label in the room.
- **The dash's Worker:**
  - `/r/*` on `bellman.sh` serves the page with its scripts pointing at `dash.bellman.sh`;
  - the head tags are written for a public room, and a room name containing `"><script>` stays text;
  - a room that isn't public gets 404 and a generic head;
  - `dash.bellman.sh/r/*` answers 301.
- **Server links and access:**
  - public links start `https://bellman.sh/r/`;
  - `https://bellman.sh` passes the report route's origin check, and every other credentialed route refuses it;
  - sign-in returns to the room.
- **Docs:**
  - the docs site's Public rooms page;
  - the README;
  - the `bellman_start` and `bellman_public_name` texts, with `npm run docs:gen`;
  - the site's `/docs` page.
- **Rollout:**
  1. The dash PR first: its Worker serves `bellman.sh/r/*` and redirects the old links.
  2. The move (2a): the server points new links at `bellman.sh` and honours the narrow list (D7). The site's README and its smoke check (3a) ship with it.
  3. The notice (D6): the site posts the new privacy policy and terms with an effective date 30 days on (3b), and the owner emails every account holding a handle.
  4. The names (2b), on or after the effective date: handles in public reads, the hour's cache and the 65-minute hold. The site makes the new versions current the same day, and the dash's Settings copy changes with 2b or right after it.

  If the Cloudflare token can't add a route on the `bellman.sh` zone, the dash's first deploy is the owner's to run. The server work starts after the abuse protections' reports (their section 1C) merge, so the report route exists on main.

## Out of scope

- A per-room share image (the site's existing image is used).
- A sitemap.
- Moving the handle page, or any other dash page, to `bellman.sh`.

## Risks

- **The route needs zone permission.** If the token lacks it, the first deploy waits on the owner.
- **Two Workers serve one host.** A change to the site's routing must leave `/r/*` to the dash.
- **Handles reveal participation.** Section 3 states the consequence, and the owner approved it.
- **An hour of staleness.** A new handle can take an hour to appear on public pages, and a released one an hour to go. Someone whose handle an operator released from an impersonator waits 65 minutes to claim it (D5).
- **A month between the move and the names.** Until 2b, public pages name members by number, and a signed room's creator by handle. An account that claims a handle after the email goes out gets no email; the upcoming privacy policy, linked from the current one, is what tells it.
- **One signed-in write from the static site's host.** A script on any bellman.sh page, the site's own included, can file a report as its reader (D7).
