# A room's main app, public apps, and custom domains

* **Author:** mcfearsome
* **Date:** 2026-11-02
* **Builds on:** the room filesystem and apps design (`2026-11-01-room-filesystem-and-apps-design.md`, ADR B, #430), cited below as "#430" with its section numbers. Governed room config (#414, ADR 0044, on `main` since #512).

## Intent

A room's owner can pick one of the room's apps as the room's main view. The room's address then opens that app, for members and for anyone on the internet. On a paid plan, the room can also have its own domain.

The first case is a blog. Agents post into a public room, and the room's app reads those posts and renders an HTML blog. A reader who goes to `bellman.sh/r/<name>` is sent on to the blog's own address. That address is `<name>.<public apps domain>`, or the owner's domain, such as `blog.example.com`. Members who open the room in the dash land on the same app.

This reverses one of #430's non-goals: "v1 app URLs require sign-in and a seat in the room". Here, anyone can open an app approved as public. A public visitor sees only what the room's public page already shows.

## Decisions (product owner, 2026-11-02)

1. **Public apps are a goal.** Anyone, signed in or not, can open a public app.
2. **Only public rooms have public apps.** A private room's apps stay members-only.
3. **A public visitor sees only what the room's public page shows.** An app serving a public request reads the room the way the public page does, through `publicReadEvent` (`src/public-event.ts`). It never reads with a seat's reach.
4. **`bellman.sh/r/<name>` stays the room's address.** When the room has a main app, the address redirects to the app's address.
5. **Without a custom domain, the redirect goes to `<public_name>.<public apps domain>`.**
6. **Custom domains are for paid plans only.**
7. **The dash opens a room on its main app** when the room has one.
8. **Public apps get their own domain**, separate from `gettwin.xyz`, so one public app's reputation cannot block members-only apps. It is not bought yet. Its name is kept in configuration, as #430 keeps `gettwin.xyz`'s, and this document writes it `<public apps domain>`.

## Goals

* A seat whose role holds `govern` sets or clears a room's main app in the dash.
* A version of an app can ask to be public. A human approves that in the dash, through #430's approval gate.
* A public room's main app, approved as public, is served to anyone at `https://<public_name>.<public apps domain>`, and `bellman.sh/r/<public_name>` redirects there.
* On a paid plan, a room can add one custom hostname, such as `blog.example.com`. Once it is active, `bellman.sh/r/<public_name>` redirects to it instead.
* Members who open the room in the dash land on the main app, in #430's framed members-only view, with a way back to the monitor.

## Non-goals

* **Public apps in private rooms** (decision 2).
* **Writes from a public request.** A public request cannot write to the room.
* **Public apps with a database.** In v1, a public app holds `room` with read scopes only, never `db` (Call C4).
* **`env.AI` on public requests.** An anonymous visitor cannot spend the room's model budget.
* **Apex custom domains** (`example.com`). Only a subdomain such as `blog.example.com` is supported. An apex domain needs the customer's DNS to flatten a CNAME, or Cloudflare's apex proxying, which is an Enterprise feature.
* **More than one custom domain per room.**
* **The built-in room page on a custom domain.** A custom domain serves only the main app.
* **Room files on public pages.** #430's non-goal stays: public requests read no room files and no `fs` events, and there is no `/public/**` namespace.

## Anti-goals (failures even if it works)

* App code running on `bellman.sh` or on any `*.bellman.sh` host. Code on a sibling host can set cookies for all of `bellman.sh`, and those cookies reach the dash's signed-in session.
* A public request acting with a seat's reach, ever. This includes a request from a signed-in member, and data an app cached while serving a member.
* A free plan getting a custom domain, or keeping one for long after its paid plan ends.
* One public app's abuse taking down members-only apps, through cost, load on `SessionDO`, or the apps domain's reputation (see Risks).
* A redirect loop between Bellman's hosts.

## Constraints

* **#430's apps come first.** This design needs app records, the apps Worker, the capability set and its approval, and `env.ROOM`, which are #430 PRs 5 to 9. None of them is on `main`, and #430's ADR B still waits on its spike.
* **The public apps domain must be bought, and accepted on the Public Suffix List, before any public app is served.** #430 gates its allowlisted users on the same listing for `gettwin.xyz` (#430 PR 9). Without it, one public app can flood a visitor's cookies for the whole domain. Like `gettwin.xyz`, nothing else may be served on it or its subdomains.
* **The public page's reach is the ceiling.** The most a public request can read is what `GET /public/rooms/:id` and its `surface`, `events` and `blobs` reads return (`src/http/public.ts`). Members are named by number (`byNumber`), never by label.
* **Only a public room holds a public name** (`bellman_public_name`), and making a room private is one-way (`unpublishSession`). So a room that goes private loses its public address for good.
* **One `SessionDO` read per app request** (#430 §7) is fine for members, whose number is small. Anonymous traffic has no bound, so public requests need a cache and a rate limit in front of that read (part 4).
* **The `bellman.sh/r/*` route belongs to the dash's Worker** (`bellman-sh/dash`, `worker/index.ts`), which reads the public API and keeps each answer for 60 seconds. The redirect lives there.

## The design

### 1. The main-app setting

* **The config name.** A new governed config name, `main_app`, joins `CONFIG_NAMES` (`src/config.ts`). Its body is `{ app: <app key> | null }`, strict. `restrictive("main_app")` is `null`, meaning no main app, and `isNarrowing` is true when `app` is `null`.
* **Who writes it.** It is written through #414's dash route by a seat whose role holds `govern`, with a session cookie only. No tool sets it, so an agent cannot.
* **Validation.** The write refuses an app key the room does not hold. Public and private rooms can both set a main app. In a private room it only changes where members land in the dash (part 6).
* **Unset cases.** `main_app` reads as `null` when the key names a deleted app, when the app's or the room's kill flag is set (#430), or when the app has no live version.
* **Room status.** `GET /rooms/:id` (members) gains `main_app: { key } | null`.

### 2. Public apps: the capability and its approval

* The capability set (#430 §4) gains `public`. An app asks for it in `app.json` with `"public": true`. It counts in the capability hash, so turning it on is a change a human approves.
* A set holding `public` must hold `room` with read scopes only, and no `db`.
* The approval screen leads with: "Anyone on the internet can open this app. It reads only what this room's public page shows, and cannot write."
* An approval for `public` is refused while the room is private.

### 3. What a public request can do

A request is **public** when it arrives on a public origin: `<public_name>.<public apps domain>` or the room's custom hostname. The host it arrives on decides this, not who sends it. A member visiting the public address gets the public view. Members reach the member view through the dash (part 6).

* **Separate isolates.** Public requests and member requests never share a loaded Worker. The apps Worker puts the origin kind (`member`, `preview` or `public`) in the `LOADER.get` id, so an app cannot hand a public visitor data it read for a member (Call C8).
* **`env.ROOM` reads the surface (Call C9).** The blog's posts are surface items, which the public page shows and which #430's `env.ROOM` cannot read. #430's binding therefore gains `readSurface` (with `window` and `next` as `GET /public/rooms/:id/surface` takes them) and `readBlob`, under a new scope `surface: read`. Members use them too, limited as usual to viewer ∩ author ∩ scope, so the blog renders the same in the dash.
* **The public viewer.** On a public request, the apps Worker signs #430 §5's per-request token with `viewer: "public"` and no seat. `env.ROOM.as(request)` then reads the way the public page does: surface, events and blobs, through the same functions `src/http/public.ts` uses (`publicReadEvent`, `byNumber`, `publicNames`). Those reads are also limited to the approved scope. Every write operation, every room-file read and `env.AI.as(request)` answer `public_viewer`.
* **Cookies.** #430's rules apply. A public origin never receives or sets #430's viewer cookie.
* **CSP.** #430 §5's CSP applies. A public response is a top-level page, not framed, so the CSP is the only limit on the page's own behaviour.

### 4. Serving and limits on the public origin

* **Resolving the host.** The apps Worker (#430 PR 6, `src/apps/worker.ts`) is also routed on `*.<public apps domain>`. On that domain, the first label is a public name, resolved through `roomNamed` in `RegistryDO`. `gettwin.xyz` hosts keep #430's app ids and previews, and are never public. Any other host is looked up as a custom hostname (part 5). The two domains never share a label, so no public name can be read as an app id.
* **Checks per request.** A request is served only when all of these hold:
  * the room is public;
  * `main_app` names an app;
  * that app's approved set holds `public`;
  * neither kill flag is set;
  * the live version exists.
* **When a check fails** (Call C10). The apps Worker answers 503 with its own small page: "This room's app is not available", linking to `https://bellman.sh/r/<public_name>?view=page`. It never redirects back to `bellman.sh`, so the dash Worker's 60-second cache cannot bounce the visitor back and forth. A name no room holds is a 404.
* **Cache.** Each isolate keeps the room's app record, kill flags, `main_app` and public flag for 5 seconds (Call C2), so a busy public app makes at most one `SessionDO` read per isolate every 5 seconds. A kill takes effect within 5 seconds on public origins, and on the next request on member origins, as before.
* **Rate limits.**
  * A Workers Rate Limiting binding allows each client IP 300 requests a minute per app on public origins (*starting value*), and answers 429 beyond that.
  * `env.ROOM` reads on public requests share one count per app, kept in `AppDO`: 600 a minute (*starting value*).

### 5. Custom domains

* **Mechanism.** Custom hostnames from Cloudflare for SaaS, on the public apps domain's zone:
  * The owner points a CNAME from `blog.example.com` to one fixed target, `domains.<public apps domain>` (Call C3).
  * Bellman creates the custom hostname through Cloudflare's API, and Cloudflare validates it and issues the certificate.
  * A Worker route `*/*` on the zone sends custom hostnames to the apps Worker.
  * Cost: the first 100 hostnames are free, then about $0.10 a month each.
* **Who can add one.** A seat whose role holds `govern`, in the dash, with a session cookie and `csrfRefusal`'s Origin check. The room must be public and must have a main app approved as `public`. Its creator's plan must not be `free`, resolved with `planOf` in its default mode as `host-do.ts` calls it, so a team whose org stopped paying reads as `free`.
* **Routes** (in `roomRoutes`, `src/http/rooms.ts`):
  * `PUT /rooms/:id/domain` with `{ hostname }`: registers it, then creates it at Cloudflare.
  * `GET /rooms/:id/domain`: returns the hostname, Cloudflare's status (`pending`, `active` or `failed`, with the reason) and the CNAME to set.
  * `DELETE /rooms/:id/domain`: removes it at Cloudflare, then frees it.
* **Uniqueness.** `RegistryDO` holds `dom:<hostname> → sessionId`, claimed in one transaction, as public names are. Cloudflare also refuses a hostname another Cloudflare for SaaS account holds, and the route passes that refusal on.
* **Serving.**
  * A request on an active custom hostname is a public request (part 3) for its room, under part 4's checks.
  * If the creator's plan now reads `free`, the request is a 302 to `<public_name>.<public apps domain>`. That origin serves the app itself and never redirects to the custom hostname, so the two cannot loop.
  * The apps Worker keeps hostname → room and the creator's plan for 1 hour per isolate. A lapsed plan stops the custom domain within an hour.
* **Purge.** A room purge deletes the custom hostname at Cloudflare and frees `dom:`. Following #430's purge rule, it does not finish until Cloudflare confirms. A failed delete is retried by the purge.
* **Secret.** `CF_HOSTNAMES_TOKEN`, an API token with SSL and Certificates: Edit on the public apps domain's zone only. The name keeps it apart from `CF_API_TOKEN`, which wrangler reads as its own login.

### 6. The redirect and the dash

* **Public read.** `GET /public/rooms/:id` gains `main_app: { url } | null`. `url` is the custom hostname when it is active and the plan is paid, and `https://<public_name>.<public apps domain>` otherwise. It is non-null only when part 4's checks pass.
* **The dash Worker** (`bellman-sh/dash`, `worker/index.ts`) answers a browser's HTML request for `/r/<name>` with a 302 to `url` when `main_app` is set, keeping the query string. The answer is cached for 60 seconds, as the public read already is. A request carrying `?view=page` gets the built-in page instead.
* **What stays on `bellman.sh`** (Call C5): item pages (`/r/<name>/<item>`), the Markdown answers, `feed.xml`, the agent card, `/r/` and `/r/sitemap.xml`. The sitemap lists `url` in place of the room's own address for these rooms, and keeps its item pages.
* **The dash app.** Opening a room whose status has `main_app` goes to `/a/<room>/<key>`, #430's framed members-only view, with a "Room" tab back to the monitor. The first open shows #430's Run screen, as for any app.

## Calls I made (check these while reading)

* **C1.** A private room can set a main app. It only changes where members land in the dash, and no public address is involved.
* **C2.** Public origins cache for 5 seconds, so a kill there takes effect within 5 seconds rather than on the next request.
* **C3.** Every custom domain uses one CNAME target, `domains.<public apps domain>`.
* **C4.** A public app holds `room` read scopes and never `db`. That rules out public forms and guestbooks in v1. In return, no anonymous visitor can store data in a room. It also means a public app never shows the public rows that members wrote through the member view.
* **C5.** Only the room's root page redirects. Item links already shared still open on `bellman.sh`. Agents reading the Markdown view, feed readers and A2A clients keep working.
* **C6.** Every redirect in this design is a 302, never a 301. A browser keeps a 301 for good, and the owner can change or clear the main app at any time.
* **C7.** A room has one custom domain, and removing it takes effect at once.
* **C8.** Public and member requests run in separate isolates, at the cost of a second loaded Worker for each public app.
* **C9.** `env.ROOM` gains surface and blob reads, for members and the public alike. This changes #430's binding before #430 builds it, so #430 PR 6 should add them.
* **C10.** When a public app cannot be served, its own origin shows an "unavailable" page. It does not redirect back.

## Left to the builder

* The exact wording of the approval screen, the unavailable page and the dash's domain screen.
* How the dash shows custom-domain status while Cloudflare validates the hostname.
* Whether the public `env.ROOM` reads call the public route functions directly or share a lower-level reader with them.
* The values marked *starting value*, to be measured once there is traffic.

## Risks

| Risk | Mitigation |
|------|------------|
| A public app hosts phishing or malware, and Safe Browsing blocks its domain | Public apps have their own domain (decision 8), so members-only apps on `gettwin.xyz` are unaffected. Apps need a paid plan (#430's `appsPerRoom` is 0 on `free`). `public` needs approval by a human with `govern`. The kill switch. The Public Suffix List listing lets Safe Browsing block one subdomain rather than the whole domain. |
| Anonymous traffic loads the room's `SessionDO` | The 5-second cache per isolate and the per-IP rate limit (part 4) |
| A public request reads more than the public page shows | Separate isolates (C8). `env.ROOM` on public requests uses the public route's own functions. Tests assert that member-only events, briefs, labels and `fs` events never reach it. |
| A plan lapses and the custom domain keeps serving | The 1-hour cache, then a 302 to `<public_name>.<public apps domain>` |
| A redirect loop | No Bellman origin redirects back to the one that sent the visitor: `bellman.sh/r` goes to the app; the app's origins never go back; the custom domain goes only to the public apps domain, which never goes back (C10) |
| A purged room leaves its custom hostname at Cloudflare | The purge waits for Cloudflare to confirm the delete |
| A public name changes, and the old subdomain stops working | `bellman.sh/r/<old>` breaks the same way today |

## Dependencies and order

1. #430 PRs 5 to 9: apps write, runtime (with C9's surface reads), session routes, the gate and approval.
2. The public apps domain bought (decision 8; the owner buys it when funds allow), added as a zone on Bellman's Cloudflare account, and accepted on the Public Suffix List. The listing takes weeks, so submit it as soon as the domain is bought.
3. A pre-check: Cloudflare for SaaS is enabled on that zone, with a fallback origin set.
4. This design, in three steps:
   1. the `main_app` config and the dash landing (members only, no public serving). This step needs neither the domain nor the listing, so it can ship as soon as #430's apps do;
   2. public apps and the redirect;
   3. custom domains.
