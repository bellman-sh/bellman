# Public Rooms on bellman.sh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public room's page is served at `bellman.sh/r/{room}` with a head that link previews and crawlers read, links already posted at `dash.bellman.sh/r/{room}` answer 301 there, and every public read names a member by the handle their account claimed, else "member N", with no message ever shown under a name another account now holds.

**Architecture:**
- A route sends `bellman.sh/r/*` to the dash's Worker, which until now served assets alone. A script in front of the assets answers `/r/*` and nothing else: on `dash.bellman.sh` a 301 to `bellman.sh`; elsewhere the built panel, with the room's head and a plain summary written in by `HTMLRewriter`. The build names `https://dash.bellman.sh/` as Vite's `base`, so every asset URL in that page is the dash's, and `/assets/*` answer CORS for `https://bellman.sh`.
- The server's public projection (`src/http/public.ts`) names each label it rewrites by the claimed handle of the one account the room seated under that label, else by the label's number. Handles come from the registry through `handlesOf`, behind an hour's per-isolate `HandleCache` in the Worker. A name freed by a release, a change or the operator is held from every account for 65 minutes, longer than any cache can show it. `PUBLIC_ROOM_URL_BASE` moves to `https://bellman.sh/r/`, and `https://bellman.sh` joins `BELLMAN_PANEL_ORIGINS`.
- Four PRs in three repos, in this order: the dash (Part 1, then a sandbox deploy), bellman (Part 2), then the dash's and the site's text (Part 3).

**Tech Stack:** TypeScript. Cloudflare Workers: the assets binding, `HTMLRewriter`, the Cache API, Durable Objects. The dash is Vite 8 and React 19 with TanStack Router; vitest 5 in each repo, and vitest 4 with `@cloudflare/vitest-pool-workers` for the workerd tests. The site is static HTML, a small Worker and Python tools.

**Spec:** `docs/superpowers/specs/2026-10-17-public-rooms-on-bellman-sh-design.md` (approved; D5 added by the owner's ruling, 2026-10-17). It amends `2026-10-09-public-rooms-design.md` and `2026-10-15-public-names-design.md`.

## Global Constraints

- **Hosts.** The page is `https://bellman.sh/r/<room>`, the panel `https://dash.bellman.sh`, the API `https://mcp.bellman.sh`. In the dash they are `PUBLIC_ORIGIN`, `DASH_ORIGIN` and `PUBLIC_ROOM_BASE` in `src/lib/hosts.ts` (Task 1); `API_ORIGIN` in `src/lib/api.ts` stays as it is.
- **The server's link base:** `PUBLIC_ROOM_URL_BASE = "https://bellman.sh/r/"`.
- **Panel origins:** `BELLMAN_PANEL_ORIGINS = "https://dash.bellman.sh, https://bellman.sh"`, the dash first, because `panelDestination` falls back to the first entry.
- **Old links:** every `/r/` path on `dash.bellman.sh` answers 301 to the same path and query on `https://bellman.sh`.
- **The head of a public room's page:** `<title>` is the room's name, a space, U+00B7 (written `\u{B7}` in TypeScript), a space, `Bellman`; `description` and `og:description` are the room's purpose, or `A public Bellman room.` when it has none; `og:title` is the room's name; `og:url` and the canonical link are `https://bellman.sh/r/<key>`, the key as requested; `og:site_name` is `Bellman`; `og:image` is `https://bellman.sh/og.png`; `twitter:card` is `summary`.
- **No room, or not public:** 404, the template's head untouched, no summary.
- **The dash's preview cache:** the dash's Worker keeps each public read it makes, a 200 or a 404, at most a minute (`CACHE_SECONDS = 60`).
- **CORS:** `/assets/*` answer `Access-Control-Allow-Origin: https://bellman.sh`.
- **Names:** `@<handle>` or `member <N>`. The hosted seat keeps its label. One account's seats share a name. A label two accounts were seated under is `member <N>`. A claimed, changed or released handle reaches public pages within the hour.
- **The handle cache:** `HANDLE_CACHE_MS = 60 * 60_000` in `src/handles.ts`, the one constant. `HandleCache` keeps each account's handle, or that it has none, per isolate and by user id, in front of `handlesOf` in the public read path only. `handlesOf`, `MemoryStore` and the store contract stay exact.
- **The hold:** `HANDLE_HOLD_MS = HANDLE_CACHE_MS + 5 * 60_000`, 65 minutes. A name freed by any path that deletes its `hn:` row (`releaseHandle`, the operator's `releaseHandleNamed`, and `claimHandle` moving to another name; the same three in `MemoryStore`) answers "taken" to every account, its last holder included, while `at < freedAt + HANDLE_HOLD_MS`. At exactly `freedAt + HANDLE_HOLD_MS` it can be claimed.
- **Untrusted text stays text.** A room's name and purpose and members' names reach HTML only through `HTMLRewriter`: `setInnerContent(…)` or `append(…, { html: false })` for text, `setAttribute` for attribute values. Only constant markup goes in with `{ html: true }`.
- **Non-ASCII in TypeScript** is a braced escape such as `\u{B7}`, never a four-digit one.
- **Store methods:** every `BellmanStore` method is async, and a new one goes into both stores and `tests/helpers/store-contract.ts`.
- **Repos:** bellman is jj (`jj commit`); the dash and the site are git, on a branch from `origin/main`. Every commit is signed. Nothing reaches `main` but through a PR.
- **Writing:** a room holds many members. Never "two sessions" or "the other session". No phrase from `~/.claude/projects/-Users-mcfearsome-src-github-com-bellman-sh-bellman/memory/banned-phrases.md`.
- **Rollout:** (1) the dash PR, after the sandbox is deployed and the deploy token can add the route; (2) the bellman PR; (3) the dash's text PR and the site's PR. If the CI token cannot add a route on the `bellman.sh` zone, the dash's first deploy is the owner's.
- **Reviews:** one whole-branch review per part, at the end of that part, before its PRs. No task has a review step.

## Rulings on the spec

Every place the spec is silent or the code disagrees with it, and what this plan does.

- **R1. The site's `/docs` page needs nothing.** It names neither `dash.bellman.sh/r` nor how members are named, on `origin/main` or on any branch. What the names change and the hold make false on the site is `privacy.html` (two items of "Who else sees it" and the "Public handles" item of how long things are kept) and `terms.html` (one sentence of section 4), and Part 3 changes those. *Cost if wrong:* `/docs` could name the page's host in one more sentence.
- **R2. The sandbox frame takes bellman.sh as a parent.** Its `frame-ancestors` and `mountFrame`'s `ev.origin` check name `https://dash.bellman.sh` alone, so every diagram and HTML item on the bellman.sh page would be a refused frame. Task 2 makes both a list, `SANDBOX_PANEL_ORIGINS`, the dash and bellman.sh by default. CI deploys the panel only, so the sandbox goes out with `npm run deploy:sandbox`, by hand, before the dash PR merges: the new frame accepts both parents, so it is safe early.
- **R3. The build writes the asset links, not the Worker.** The spec has the script point the page's script and style links at the dash. The public route is a lazy chunk, and with `base: "/"` Vite's preload helper is `` function(e){return`/`+e} `` (seen in a build of the dash's `origin/main`), which resolves against bellman.sh. So `base` is `https://dash.bellman.sh/`: the tags, the preload helper and the CSS's font URLs all name the dash (seen in the same build), and the Worker rewrites no link. Vite ignores the origin part in `npm run dev`.
- **R4. The Worker sets the page's headers itself.** The assets binding's answer carries `public/_headers` (seen in workerd), and that policy's `script-src 'self'` would refuse the dash's scripts on bellman.sh. `worker/policy.ts` holds the page's policy, the panel's with `'self'` replaced by the dash's origin, and `src/lib/csp.test.ts` holds the two together.
- **R5. `run_worker_first = ["/r/*"]` is required.** With compatibility date 2026-09-01 the asset layer answers a browser's navigation to a path no file matches with `index.html` and never runs the Worker, so the 301 would reach crawlers only. The Workers vitest pool runs the Worker for a navigation either way (removing the setting left the 301 in place, in a scratch copy), so `src/wrangler.test.ts` pins the line and the dash's CI checks the live redirect after each deploy.
- **R6. The route runs in front of the site's Custom Domain.** The spec says the more specific route wins, but the site holds `bellman.sh` as a Custom Domain, not a route. Cloudflare treats a Custom Domain's Worker as an origin and runs a route on the zone before it, so the outcome is the one the spec wants.
- **R7. The summary's members come from the room's newest events.** The public room read carries no roster. The Worker also reads `/public/rooms/<id>/events` and lists the distinct names of its senders, `system` left out, in the order they first appear, at most 20.
- **R8. The dash keeps its relabel of a signed creator.** The dash ships before the server, so dropping `relabel` would show the creator's number until Part 2 deploys. After that it still matters: during the cache's hour after a change, `by.as` can be the creator's cached old name, and `relabel` shows the byline's current handle there (R23).
- **R9. A name is decided per label.** The projection rewrites `label` properties, and a label is how someone signed in, not an account: two accounts can share one (a GitHub and a Google sign-in with one email). The accounts come from the room's members now (`session.members`) and `getMembers` for the departed member ids the page carries. A label the room seated exactly one account under, which holds a handle, is `@handle`; any other is `member N`. The hosted seat has no number, so it is never renamed.
- **R10. Names go through an hour's cache, per the owner's ruling (spec D5).** `HandleCache` in `src/handles.ts`, per isolate and keyed by user id, sits in front of `handlesOf`, which stays one exact batched read of the registry, so `MemoryStore` and the contract stay exact. It keeps an account with no handle too, so a page reads the registry only for accounts no entry covers. Each entry's time is taken before its registry read, so an answer read just before a release expires within the hour after it, inside the hold. A page naming nobody reads nothing.
- **R11. `by: { handle, as }` stays,** and `as` is the creator's public name, `@handle` when they hold one. The dash reads it.
- **R12. The panel origins and the sign-in return list are one list.** `BELLMAN_PANEL_ORIGINS` feeds both `allowedOrigin` (CORS and the CSRF check) and `panelDestination` (the sign-in return), so the change is one var. It lets every page on bellman.sh, the static site's included, make a cookie-authenticated write, and `csrfRefusal`'s comment names a marketing-site XSS as what the check stops. Task 12 rewrites that comment, and the PR says so.
- **R13. The dash has no Report form yet,** so "Sign in to report" has no dash code in this plan. The server's tests cover the origin check and a sign-in that returns to `https://bellman.sh/r/<room>`.
- **R14. More tool texts change than the two the spec names.** `bellman_start` and `bellman_connect` say members are named by number; both now say by the public handle their account claimed, or by number, and `bellman_connect` says "you included", since a joiner's claimed handle shows. ARCHITECTURE §11's tool-definitions row is re-measured, as every tool-text change has been.
- **R15. More docs change than the spec lists:** ARCHITECTURE's public room paragraph and its panel-cookie invariant, the room-manifest skill, and a new ADR 0023, with ADR 0011's status line naming decisions 3 and 5 and ADR 0021's naming decisions 2 and 4 as amended by it. ADRs are not rewritten.
- **R16. The page's details.** Canonical and `og:url` use the key as requested, a name or an id, since the room read carries no public name. Only `/r/<one segment>` names a room; `/r/` and `/r/a/b` are the 404 and ask the API nothing. A host other than `dash.bellman.sh` gets the page, so a local `wrangler dev` does. An API failure, an unreachable API or an answer of the wrong shape gets the app with the template's head and a 200, and nothing is cached: the app reads the room itself.
- **R17. The dash's Worker tests are a package of their own**, `worker-tests/`, as bellman's are: `@cloudflare/vitest-pool-workers` 0.23.0 still peers on vitest 4, and the dash runs vitest 5. Its `overrides` pin `miniflare` and `workerd` to what the dash's own wrangler resolves, because the pool's workerd refuses compatibility date 2026-09-01 (it stops at 2026-08-22, seen).
- **R18. The site's deploy checks that `bellman.sh/r/*` still reaches the dash,** for the spec's risk of two Workers on one host.
- **R19. The hold takes the caller's clock.** `claimHandle`, `releaseHandle` and `releaseHandleNamed` gain a required `at`, as `signRoom` has one, so the contract sets the time for both stores without a fake clock. `npm run typecheck` then lists every caller in `src/` and `tests/`; `worker-tests/` is in no typecheck program, so Task 9 names its three calls.
- **R20. The hold is a row of its own:** `hh:<handle>`, the time the name was freed, written in the transaction that deletes the `hn:` row (`#release`, and `claimHandle` moving to another name) and deleted when the name is claimed again. `MemoryStore` keeps a map. It names no account, so the privacy page's "releasing it deletes both at once" stays true of the handle and its signatures. ponytail: a held name nobody claims again keeps its row.
- **R21. Nothing but `claimHandle` answers "free" for a handle.** No route checks one, the dash learns "taken" from the PUT's 409, and the handle page's 404 during the hold says nobody holds the name, which is true.
- **R22. The 409's description changes.** `<handle> belongs to someone else` is false for a last holder during the hold, and the dash shows the description as it comes. It becomes `<handle> is taken. A handle that was released or changed away from is held for 65 minutes before anyone can claim it.`
- **R23. The byline stays an exact read** (`bylineFor`, ADR 0021 decision 4); only names are cached. After a change, `by.handle` is the new handle at once and `as` can be the cached old name for the hour, which the dash's relabel shows as `by.handle`. After a release, `by` is null at once and the names go within the hour.
- **R24. Only the Worker caches.** `handles` is optional in `PublicRouteDeps`: absent, a read is exact, which the Node server (local only) and the tests that are not about the cache keep. The Worker passes one per isolate, as it does `SuspensionCache`, and a worker test with a user of its own shows it does: a handle released after a read still shows on the next.
- **R25. The dash's Settings copy is false twice after Part 2:** "with your own messages in it under that name" holds for signed rooms only, and "frees it for anyone at once" ignores the hold. It changes in a dash PR of its own, in Part 3, after Part 2 deploys, since before that it would describe a hold the server does not keep.
- **R26. Two polls, every 4 seconds each.** D5's "public pages poll every 4 seconds" is each of the page's two polls, the log and the surface (`POLL_MS` in `src/lib/use-events.ts` and `src/lib/use-surface.ts`), so without the cache one viewer could reach the registry every 2 seconds. ADR 0023 says both.
- **R27. Four existing tests reclaim a freed name at once, which the hold refuses:** the contract's "frees the old handle when one changes", `tests/http-bylines.test.ts`' "free the old handle on a change, and release it on DELETE" and "lists none of an old owner's rooms under a freed handle someone else claimed", and `worker-tests/handle-routes.test.ts`' "read, claim, refuse a held one, free the old on a change, release, and refuse the rest". Task 9 makes each expect "taken", then claim after the hold with a later `at`.
- **R28. `worker-tests/public-routes.test.ts`' handle-page case no longer asserts `as`:** its earlier cases leave the Worker's cache holding that user's answer for the hour. The cache's own cases run in Node with a fake clock, and its wiring in a worker test with a user of its own.

## Review Focus

1. **A browser following a link at `dash.bellman.sh/r/<room>`.** It sends `Sec-Fetch-Mode: navigate`, and without `run_worker_first` it gets the dash's app and no redirect (R5). Task 4 pins the setting, and Task 7 checks the live redirect after each deploy.
2. **A diagram or an HTML item on the bellman.sh page.** The sandbox refuses a parent it was not built for (R2). Task 2 tests a message from the public page's origin and the resize back to it.
3. **The public route's own chunk on bellman.sh.** Its preloads and the fonts load from wherever the build says (R3). Task 1 tests the built HTML, the preload helper's base and the font URLs; Task 4 tests an asset's CORS header.
4. **The API failing, or unreachable, while someone opens a room.** They should get the app, which reads the room again, not a 500, and the failure must not be kept as a 404 for a minute (R16). Task 5 tests both.
5. **A member named by label alone, or one who has left.** A payload can carry a label with no member id beside it, and a departed member is not in `session.members` (R9). Task 11 tests both.
6. **The hold's boundary.** A claim a millisecond before `freedAt + HANDLE_HOLD_MS` is "taken", for another account and for the last holder, and one at exactly that time is "claimed", for each of the three paths that free a name (R19, R20). Task 9 tests it in both stores.
7. **A handle read just before its release.** The registry answers before the release lands and the answer reaches the cache after it; the entry's time is the read's start, so it is gone within the hour after the release, before the hold ends (R10). Task 11 tests it with the read held while the clock moves six minutes.

## Every place that writes `dash.bellman.sh/r`

The predicate: a string that is `dash.bellman.sh/r…` at run time. That is the literal, or a `/r/` path joined to an origin that is the dash's when it runs: `window.location.origin` on the panel, or a relative link on a dash page.

```bash
# bellman, in this workspace
rg -n --hidden -g '!node_modules' -g '!.jj' -g '!docs/superpowers/**' 'dash\.bellman\.sh(/|</code>/)r\b' .
rg -n -g '!docs/superpowers/**' -e '/r/\$\{' -e '\}/r/' -e "[\"'(]/r/" -e '`/r/' src ui/src plugin extension docs-site/src docs README.md
# the dash and the site, at origin/main
git -C ~/src/github.com/bellman-sh/dash grep -n -E -e 'dash\.bellman\.sh/r' -e '\}/r/' -e '/r/\$\{' -e "[\"'(\`]/r/" origin/main -- . ':!docs/superpowers'
git -C ~/src/github.com/bellman-sh/site grep -n -E -e 'dash\.bellman\.sh(/|</code>/)r' -e "[\"'(]/r/" origin/main -- .
```

What it found, and the task that changes each:

- **bellman, the producer:** `PUBLIC_ROOM_URL_BASE` in `src/codes.ts`. Every `public_url` comes from it, through `publicRoomUrl` (Task 8).
- **bellman, text:** `bellman_public_name`'s description (`src/tools/public-name.ts`), `bellman_start`'s `public_name` line (`src/tools/start.ts`) and their generated pages under `docs-site/src/content/docs/reference/tools/` (Task 13); `README.md`'s public rooms item, `docs-site/src/content/docs/guides/public-rooms.md` in four places, and ARCHITECTURE's "Dash renders it at `/r/<id>`" (Task 14).
- **bellman, tests that assert it:** `tests/public-names.test.ts` (5), `tests/public-rooms.test.ts` (2), `tests/http-bylines.test.ts` (3), `worker-tests/public-routes.test.ts` (1), and a fixture in `ui/test/render.test.ts` (2) (Task 8).
- **bellman, kept as a record:** decision 3 of `docs/adr/0011-public-rooms.md`; ADR 0023 amends it (Task 14).
- **the dash, composed:** `PublicControls`' copy link, `` `${window.location.origin}/r/…` `` in `src/components/canvas/public-controls.tsx`, and `HandleRooms`' room links, a relative `/r/…` on `dash.bellman.sh/u/<handle>`, in `src/routes/public-handle.tsx`. Their tests: `src/components/canvas/canvas.test.tsx` (2), `src/routes/public-handle.test.tsx` (2), `src/router.test.tsx` (2) (Task 3).
- **the dash, literal:** the header comment of `src/routes/public-room.tsx`, and a `public_url` fixture in each of `src/router.test.tsx` and `src/routes/public-handle.test.tsx` (Task 3).
- **not writers:** the route's own path (`src/router.tsx`), the public page's tab links, `boot("/r/…")` in `src/router.test.tsx` and the `Link` stand-in in `src/routes/public-room.test.tsx`. They are paths inside the app, so on bellman.sh they stay on bellman.sh.
- **the site:** nothing. Its illustrations already say `bellman.sh/r/…`.

---

# Part 1 — the dash (one PR, first)

The checkout is `~/src/github.com/bellman-sh/dash`: `git fetch origin`, then `git switch -c mcfearsome/public-on-bellman-sh origin/main`, or a worktree from `origin/main`. It needs its own `npm ci`; never symlink `node_modules`. Unit tests: `npm test`. Lint: `npm run lint`. The build, which typechecks: `npm run build`.

### Task 1: Every asset URL the build writes names the dash

**Files:**
- Create: `src/lib/hosts.ts`
- Modify: `vite.config.ts`, `public/_headers`
- Test: `src/build.test.ts`, `src/lib/csp.test.ts`

**Interfaces:**
- Produces: `src/lib/hosts.ts` exports `DASH_ORIGIN = "https://dash.bellman.sh"`, `PUBLIC_ORIGIN = "https://bellman.sh"` and ``PUBLIC_ROOM_BASE = `${PUBLIC_ORIGIN}/r/` ``. Plain constants with no `import.meta.env`, so `vite.config.ts`, the sandbox's config and the Worker import them as well as the app.

- [ ] **Step 1: Write the failing tests**

In `src/build.test.ts`, replace the font test in `describe("the built panel (dash #33)")`, and add a `describe` after that block:

```ts
  it("serves every font face from a file in the panel's own assets, named in full", () => {
    const faces = text(/\.css$/).flatMap((f) => readFileSync(f, "utf8").match(/@font-face\{[^}]*\}/g) ?? []);
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) expect(/src:url\(https:\/\/dash\.bellman\.sh\/assets\/[^)]+\.woff2\)/.test(face), face.slice(0, 120)).toBe(true);
  });
});

// The public room page is served on bellman.sh (public rooms on bellman.sh spec, D2), where a path that starts "/" is
// the site's. So every URL the build writes names the dash in full: the page's tags, and the base Vite's preload helper
// puts before a lazy route's dependencies, which /r/$roomId is.
describe("the built panel's asset URLs", () => {
  it("names the dash in full in every src and href index.html carries", () => {
    const html = readFileSync(join(out, "index.html"), "utf8");
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThanOrEqual(3);
    expect(urls.filter((u) => !u.startsWith("https://dash.bellman.sh/"))).toEqual([]);
  });

  it("puts the dash before a lazy route's preloads, and never a bare slash", () => {
    const js = text(/\.js$/).map((f) => readFileSync(f, "utf8"));
    expect(js.some((s) => /return["'`]https:\/\/dash\.bellman\.sh\/["'`]\+/.test(s))).toBe(true);
    expect(js.some((s) => /return["'`]\/["'`]\+/.test(s))).toBe(false);
  });
});
```

In `src/lib/csp.test.ts`, inside `describe("the content security policy")`:

```ts
  it("lets bellman.sh fetch the panel's assets by CORS, for the public room page there, and grants nothing else", () => {
    // The page on bellman.sh loads the module scripts, the stylesheet and the fonts from the dash, each by CORS: Vite
    // marks the tags crossorigin, and fonts always are.
    const block = text.split("\n\n").map((b) => b.trim().split("\n").map((l) => l.trim())).find((b) => b[0] === "/assets/*");
    expect(block).toEqual(["/assets/*", "Access-Control-Allow-Origin: https://bellman.sh"]);
    expect(text.match(/Access-Control-Allow-Origin/g)).toHaveLength(1);
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/build.test.ts src/lib/csp.test.ts`
Expected: FAIL. The font test sees `src:url(/assets/…)`; the first URL test sees `/favicon.svg` and two `/assets/…`; the second finds `` return`/`+ ``; the CORS test's `block` is `undefined`.

- [ ] **Step 3: Implement**

- `src/lib/hosts.ts`: the three constants, each with a one-line comment on where it is used.
- `vite.config.ts`: `import { DASH_ORIGIN } from "./src/lib/hosts.ts"` and ``base: `${DASH_ORIGIN}/` ``, with a comment: the public room page is served on bellman.sh, and a lazy route's preloads resolve against the page's origin unless the base names the dash.
- `public/_headers`: after the `/*` block, a blank line and:

```
/assets/*
  Access-Control-Allow-Origin: https://bellman.sh
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run src/build.test.ts src/lib/csp.test.ts && npm test && npm run build`
Expected: PASS, the whole suite, and a build whose `dist/index.html` names `https://dash.bellman.sh/assets/` and `https://dash.bellman.sh/favicon.svg`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/hosts.ts vite.config.ts public/_headers src/build.test.ts src/lib/csp.test.ts
git commit -m "The build names the dash in every asset URL it writes, and /assets/* answer CORS for bellman.sh"
```

### Task 2: The sandbox frame takes bellman.sh as a parent

**Files:**
- Modify: `sandbox/policy.ts`, `sandbox/mount.ts`, `sandbox/frame.ts`, `sandbox/vite.config.ts`, `README.md`
- Test: `sandbox/policy.test.ts`, `sandbox/mount.test.ts`, `sandbox/build.test.ts`

**Interfaces:**
- Consumes: `DASH_ORIGIN`, `PUBLIC_ORIGIN` (Task 1).
- Produces: `framePolicy(panelOrigins: readonly string[]): string`; `headersFile(panelOrigins: readonly string[]): string`; `panelOriginsOf(value: string): string[]`, which replaces `panelOriginOf`; `mountFrame(win: Window, panelOrigins: readonly string[], renderDiagram: (source: string) => Promise<string>): void`. The build reads `SANDBOX_PANEL_ORIGINS`, origins separated by whitespace, by default `` `${DASH_ORIGIN} ${PUBLIC_ORIGIN}` ``, and defines `__PANEL_ORIGINS__` as a JSON array of them.

- [ ] **Step 1: Write the failing tests**

`sandbox/policy.test.ts`. Import `panelOriginsOf` in place of `panelOriginOf`. In `describe("the frame's policy")`, `p` becomes `framePolicy(["https://dash.bellman.sh", "https://bellman.sh"])`; every other `headersFile("…")` becomes `headersFile(["…"])`; the policy string the spec test expects reads `frame-ancestors https://dash.bellman.sh https://bellman.sh;` and its `headersFile` is given both. Replace the frame-ancestors case:

```ts
  it("may be embedded by the panel and by bellman.sh, where the public room page is, and nothing else", () => {
    expect(directive(p, "frame-ancestors")).toBe("https://dash.bellman.sh https://bellman.sh");
  });
```

Replace `describe("the panel origin a build bakes in")`:

```ts
describe("the panel origins a build bakes in", () => {
  // The frame compares event.origin with each and frame-ancestors names them all: a trailing slash or a path never
  // matches, and the frame would then ignore every message with no error anywhere. So the build stops on anything else.
  it("reads origins separated by spaces, each as it is", () => {
    expect(panelOriginsOf("https://dash.bellman.sh https://bellman.sh")).toEqual(["https://dash.bellman.sh", "https://bellman.sh"]);
    expect(panelOriginsOf("  http://localhost:5173  ")).toEqual(["http://localhost:5173"]);
  });
  it.each(["https://dash.bellman.sh", "http://localhost:5173", "http://127.0.0.1:8080"])("takes %s as it is", (value) => {
    expect(panelOriginsOf(value)).toEqual([value]);
  });
  it.each([
    ["a trailing slash", "https://dash.bellman.sh/"],
    ["a path", "https://dash.bellman.sh/panel"],
    ["a query", "https://dash.bellman.sh?x=1"],
    ["capitals", "HTTPS://Dash.Bellman.sh"],
    ["a default port written out", "https://dash.bellman.sh:443"],
    ["no scheme", "dash.bellman.sh"],
    ["the word null", "null"],
    ["a file URL, whose origin is opaque", "file:///tmp/panel"],
  ])("refuses %s, beside a good origin too, and the message names it", (_what, value) => {
    expect(() => panelOriginsOf(`https://bellman.sh ${value}`)).toThrow(JSON.stringify(value));
    expect(() => panelOriginsOf(value)).toThrow("SANDBOX_PANEL_ORIGINS");
  });
  it("refuses a list with no origin in it", () => {
    expect(() => panelOriginsOf("   ")).toThrow("SANDBOX_PANEL_ORIGINS");
  });
});
```

`sandbox/mount.test.ts`. Add `const PUBLIC_PAGE = "https://public.test";`, make `fresh()` call `mountFrame(window, [PANEL, PUBLIC_PAGE], render)`, rename "ignores a message from any origin but the panel, and renders nothing" to "ignores a message from any origin it was not built for, and renders nothing", and add:

```ts
  it("renders a message from the public room page's origin, the other parent it was built for", async () => {
    const slot = fresh();
    fromPanel({ kind: "html", html: "<p>from bellman.sh</p>" }, PUBLIC_PAGE);
    await flush();
    expect(nested(slot)!.getAttribute("srcdoc")).toContain("from bellman.sh");
  });

  it("forwards a resize to the parent that sent the content, never to another origin it was built for", async () => {
    const slot = fresh();
    fromPanel({ kind: "html", html: "<p>x</p>" }, PUBLIC_PAGE);
    await flush();
    const post = vi.spyOn(window.parent, "postMessage");
    try {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "resize", height: 333 }, origin: "null", source: nested(slot)!.contentWindow }));
      expect(post.mock.calls).toEqual([[{ kind: "resize", height: 333 }, PUBLIC_PAGE]]);
    } finally {
      post.mockRestore();
    }
  });
```

`sandbox/build.test.ts`. `builtFor(origins: string | undefined)` sets `SANDBOX_PANEL_ORIGINS` to `origins` for the build, or deletes it when `undefined`, and restores it after; the other cases keep building for `ORIGIN`, and `describe("a build for a panel origin that is not an origin")` sets the renamed variable. Add:

```ts
describe("the sandbox built with nothing set", () => {
  let out = "";
  beforeAll(async () => {
    out = await builtFor(undefined);
  }, 60_000);

  it("names the dash and bellman.sh in frame-ancestors, and bakes both into the frame's script", () => {
    expect(readFileSync(join(out, "_headers"), "utf8")).toContain("frame-ancestors https://dash.bellman.sh https://bellman.sh;");
    const entry = readdirSync(join(out, "assets")).find((f) => /^frame-.*\.js$/.test(f))!;
    const js = readFileSync(join(out, "assets", entry), "utf8");
    for (const origin of ["https://dash.bellman.sh", "https://bellman.sh"]) expect(js.includes(origin), `${entry} bakes ${origin}`).toBe(true);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run sandbox`
Expected: FAIL. `panelOriginsOf` is not exported, `framePolicy` joins the array with a comma, both new mount cases see the message from `PUBLIC_PAGE` dropped, and the default build's `frame-ancestors` names the dash alone.

- [ ] **Step 3: Implement**

- `sandbox/policy.ts`: `framePolicy` and `headersFile` take the list, and `frame-ancestors` is the origins joined by a space. `panelOriginsOf` splits on whitespace, puts each entry through the check `panelOriginOf` made (`new URL(value).origin === value`), and throws, naming `SANDBOX_PANEL_ORIGINS` and the entry as `JSON.stringify` writes it, on the first that fails or on a list with none.
- `sandbox/mount.ts`: a message is accepted when `panelOrigins.includes(ev.origin) && ev.source === win.parent`, and the first accepted one records `ev.origin` as the parent's origin. A resize goes to `win.parent.postMessage(out, parentOrigin)`, and to nothing before a message was accepted.
- `sandbox/frame.ts`: `declare const __PANEL_ORIGINS__: string[];`, then `mountFrame(window, __PANEL_ORIGINS__, renderDiagram)`.
- `sandbox/vite.config.ts`: ``const panelOrigins = panelOriginsOf(process.env.SANDBOX_PANEL_ORIGINS ?? `${DASH_ORIGIN} ${PUBLIC_ORIGIN}`)``, with `DASH_ORIGIN` and `PUBLIC_ORIGIN` imported from `../src/lib/hosts.ts`; `define: { __PANEL_ORIGINS__: JSON.stringify(panelOrigins) }`; the headers plugin writes `headersFile(panelOrigins)`.
- `README.md`, under Develop: the dev command becomes `SANDBOX_PANEL_ORIGINS=http://localhost:5173 npm run dev:sandbox`, and the sentence on what the production build bakes becomes: "The production build bakes `https://dash.bellman.sh` and `https://bellman.sh`, where the public room page is, the origins its `frame-ancestors` names, so a preview hostname of the panel embeds nothing."

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run sandbox && npm test && npm run build:sandbox`
Expected: PASS; `sandbox/dist/_headers` reads `frame-ancestors https://dash.bellman.sh https://bellman.sh;`. Then `git grep -n -E 'SANDBOX_PANEL_ORIGIN\b|panelOriginOf\b' -- ':!docs/superpowers'` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add sandbox/policy.ts sandbox/mount.ts sandbox/frame.ts sandbox/vite.config.ts sandbox/policy.test.ts sandbox/mount.test.ts sandbox/build.test.ts README.md
git commit -m "The sandbox frame takes bellman.sh as a parent beside the panel, and answers the parent that spoke"
```

### Task 3: Links in and out of the public page

**Files:**
- Modify: `src/components/room/byline-line.tsx`, `src/routes/not-found.tsx`, `src/components/canvas/public-controls.tsx`, `src/routes/public-handle.tsx`, `src/routes/public-room.tsx` (its header comment)
- Test: `src/components/room/byline-line.test.tsx`, `src/routes/public-handle.test.tsx`, `src/components/canvas/canvas.test.tsx`, `src/router.test.tsx`

**Interfaces:**
- Consumes: `DASH_ORIGIN`, `PUBLIC_ROOM_BASE` (Task 1).

- [ ] **Step 1: Write the failing tests**

Each change is an expected value; the cases are the existing ones.

- `src/components/room/byline-line.test.tsx`, "links @handle to the handle's page": `toHaveAttribute("href", "https://dash.bellman.sh/u/ada")`.
- `src/routes/public-handle.test.tsx`: the fixture's ``public_url: `https://bellman.sh/r/${id}` ``; "lists the handle's rooms…": `"https://bellman.sh/r/qs_1"`; "encodes a room's id into its link": `"https://bellman.sh/r/a%20b%2Fc"`.
- `src/components/canvas/canvas.test.tsx`, `describe("a public room's header")`: `toHaveBeenCalledWith("https://bellman.sh/r/bellman-dev")` and `toHaveBeenCalledWith("https://bellman.sh/r/qs_1")`.
- `src/router.test.tsx`:
  - the API stand-in's handle page: `public_url: "https://bellman.sh/r/qs_pub"`;
  - "shows the not-found screen for a path that is nothing, with a plain link back, and logs nothing": `toHaveAttribute("href", "https://dash.bellman.sh/rooms")`;
  - "shows a signed room's byline under its name, linked to the handle's page…": `toHaveAttribute("href", "https://dash.bellman.sh/u/ada")`;
  - "lists the handle's rooms to a visitor who is not signed in…": the room link `"https://bellman.sh/r/qs_pub"`;
  - "is where a public room's byline link goes": assert `expect(byline).toHaveAttribute("href", "https://dash.bellman.sh/u/ada")` first, push `new URL(byline.getAttribute("href")!).pathname` to `router.history`, and expect the room link `"https://bellman.sh/r/qs_pub"`.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/components/room/byline-line.test.tsx src/routes/public-handle.test.tsx src/components/canvas/canvas.test.tsx src/router.test.tsx`
Expected: FAIL on each changed value: `/u/ada`, `/r/qs_1`, `/r/a%20b%2Fc`, jsdom's origin before `/r/…`, `/rooms`, `/r/qs_pub`.

- [ ] **Step 3: Implement**

- `BylineLine`: ``href={`${DASH_ORIGIN}/u/${encodeURIComponent(by.handle)}`}``. The comment says why in full: the page is served on bellman.sh, where `/u/` is the site's.
- `NotFound`: a plain ``<a href={`${DASH_ORIGIN}/rooms`} className={buttonVariants()}>`` in place of the router's `Link`. On bellman.sh a `Link` would render the panel's rooms page there.
- `PublicControls`: ``const link = `${PUBLIC_ROOM_BASE}${name ?? roomId}`;``
- `HandleRooms`: ``href={`${PUBLIC_ROOM_BASE}${encodeURIComponent(r.id)}`}``, still by id.
- `src/routes/public-room.tsx`'s header comment: the page is `bellman.sh/r/<id>`, or `/r/<name>`, served by this repo's Worker; `dash.bellman.sh/r/` answers 301 there.

- [ ] **Step 4: Run them and watch them pass**

Run: `npm test`
Expected: PASS. Then `git grep -n -E 'dash\.bellman\.sh/r|window\.location\.origin\}/r/|href=\{`/r/' -- src` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/components/room/byline-line.tsx src/routes/not-found.tsx src/components/canvas/public-controls.tsx src/routes/public-handle.tsx src/routes/public-room.tsx src/components/room/byline-line.test.tsx src/routes/public-handle.test.tsx src/components/canvas/canvas.test.tsx src/router.test.tsx
git commit -m "Public room links name bellman.sh, and the public page's links out name the dash in full"
```

### Task 4: A Worker in front of the assets, and its tests in workerd

**Files:**
- Create: `worker/index.ts`, `tsconfig.worker.json`, `src/wrangler.test.ts`, `worker-tests/package.json`, `worker-tests/vitest.config.ts`, `worker-tests/README.md`, `worker-tests/routing.test.ts`; generated and committed: `worker-tests/package-lock.json`
- Modify: `wrangler.toml`, `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `DASH_ORIGIN`, `PUBLIC_ORIGIN` (Task 1).
- Produces: `worker/index.ts` exports `interface Env { ASSETS: Fetcher }` and a default `{ fetch(request: Request, env: Env): Promise<Response> }`, and holds a module-private `publicRoomPage(url: URL, env: Env): Promise<Response>` that Task 5 writes. The root script `npm run test:worker`.

- [ ] **Step 1: The harness, and a Worker that hands everything to the assets**

- `package.json`: `@cloudflare/workers-types` in `devDependencies` (`npm install -D @cloudflare/workers-types@^5.20260916.1`, bellman's range), and the script `"test:worker": "vite build && npm --prefix worker-tests install --legacy-peer-deps --no-audit --no-fund --silent && npm --prefix worker-tests run test"`.
- `vite.config.ts`: `test.exclude: [...configDefaults.exclude, "worker-tests/**"]`, `configDefaults` from `vitest/config`, so `npm test` leaves the workerd files alone.
- `tsconfig.worker.json`: `tsconfig.node.json`'s options with `"lib": ["ES2023"]`, `"types": ["@cloudflare/workers-types"]`, `"module": "esnext"`, `"moduleResolution": "bundler"`, its own `tsBuildInfoFile` (`./node_modules/.tmp/tsconfig.worker.tsbuildinfo`), `"include": ["worker"]`. `tsconfig.json` gains `{ "path": "./tsconfig.worker.json" }` in `references`, so `npm run build` typechecks it.
- `wrangler.toml`: `main = "worker/index.ts"`, and `binding = "ASSETS"` under `[assets]`. Rewrite the comment above `[assets]`: the panel is a static build; a script runs in front of it for `/r/*` alone, a public room's page; everything else is the assets binding as before, and unknown paths get `index.html` so the router owns them on a direct visit.
- `worker/index.ts`: the default export's `fetch` returns `env.ASSETS.fetch(request)` for every request.
- `worker-tests/package.json`:

```json
{
  "name": "dash-worker-tests",
  "private": true,
  "type": "module",
  "description": "The dash's Worker in real workerd, over the built panel. A separate dependency tree: @cloudflare/vitest-pool-workers peers on vitest 4, and the dash runs vitest 5. See README.md.",
  "scripts": { "test": "vitest run" },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.23.0",
    "vitest": "^4.1.0",
    "wrangler": "^4.148.0"
  },
  "overrides": { "miniflare": "5.20261006.0-alpha", "workerd": "1.20261006.1" }
}
```

- `worker-tests/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// The real wrangler.toml, so the Worker runs with the assets, the binding and run_worker_first it deploys with; the
// pool ignores its routes. The assets are ../dist, which `npm run test:worker` builds first.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "../wrangler.toml" } })],
  test: { include: ["**/*.test.ts"] },
});
```

- `worker-tests/README.md`, short: why the package is separate (the vitest peers); why `--legacy-peer-deps` (bellman's `worker-tests/README.md` has the npm crash it avoids); why `overrides` pins `miniflare` and `workerd` (the pool's own workerd stops at compatibility date 2026-08-22, and production is on 2026-09-01; the pins are the versions the root's `package-lock.json` resolves for wrangler, and move together); that a navigation reaches the Worker in the pool whatever `run_worker_first` says, so `src/wrangler.test.ts` and the deploy's check pin that.
- `.github/workflows/ci.yml`: after `- run: npm run build`, `- run: npm run test:worker`, with a comment naming `worker-tests/README.md`.

Run: `npm run test:worker` with no test file yet.
Expected: vitest starts the pool and reports no test files found, exiting 1. A refusal naming a compatibility date means the overrides did not apply: check `worker-tests/node_modules/workerd/package.json`.

- [ ] **Step 2: Write the failing tests**

`worker-tests/routing.test.ts`:

```ts
/**
 * The dash's Worker over the built panel, in real workerd (public rooms on bellman.sh spec, section 1): links already
 * posted at dash.bellman.sh/r/ are sent to bellman.sh, and everything else is the assets, as before there was a script.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const navigate = { "sec-fetch-mode": "navigate" };

describe("the dash's Worker", () => {
  it("answers a link at dash.bellman.sh/r/ with a 301 to the same path and query on bellman.sh", async () => {
    const res = await SELF.fetch("https://dash.bellman.sh/r/open-review?view=log", { headers: navigate, redirect: "manual" });
    expect([res.status, res.headers.get("location")]).toEqual([301, "https://bellman.sh/r/open-review?view=log"]);
  });

  it("answers every /r/ path on dash.bellman.sh that way, one that names no room included", async () => {
    for (const path of ["/r/qs_1", "/r/a/b", "/r/"]) {
      const res = await SELF.fetch(`https://dash.bellman.sh${path}`, { redirect: "manual" });
      expect([res.status, res.headers.get("location")], path).toEqual([301, `https://bellman.sh${path}`]);
    }
  });

  // The harness's own control: the build is there, and the assets answer as they did with no script.
  it("leaves the panel's own paths to the assets: the app for a page, the file for an asset, with its CORS header", async () => {
    const page = await SELF.fetch("https://dash.bellman.sh/rooms/qs_1", { headers: navigate });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<div id="root"></div>');
    const script = /<script type="module" crossorigin src="([^"]+)"/.exec(html)![1];
    const asset = await SELF.fetch(script);
    expect([asset.status, asset.headers.get("access-control-allow-origin")]).toEqual([200, "https://bellman.sh"]);
  });
});
```

`src/wrangler.test.ts`:

```ts
/**
 * What wrangler.toml deploys for the public room page, read as text. The Workers vitest pool runs the Worker for a
 * navigation whatever run_worker_first says (worker-tests/README.md), so only this and the deploy's check see it: with
 * a compatibility date past 2025-04-01, a browser's navigation to a path no file matches is answered with index.html
 * before any Worker runs, and a link at dash.bellman.sh/r/ would never reach the 301.
 *
 * @vitest-environment node
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const lines = (key: string) => toml.split("\n").map((l) => l.trim()).filter((l) => l.startsWith(`${key} =`));

describe("the dash's wrangler.toml", () => {
  it("runs the Worker first for /r/* alone, over the assets it binds", () => {
    expect(lines("main")).toEqual(['main = "worker/index.ts"']);
    expect(lines("binding")).toEqual(['binding = "ASSETS"']);
    expect(lines("run_worker_first")).toEqual(['run_worker_first = ["/r/*"]']);
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run src/wrangler.test.ts; npm run test:worker`
Expected: `src/wrangler.test.ts` FAILS on `run_worker_first` (`[]`); in workerd the two 301 cases FAIL (200 with the app), and the assets case PASSES.

- [ ] **Step 4: Implement**

- `wrangler.toml`: `run_worker_first = ["/r/*"]` under `[assets]`, with a comment saying why (R5) in two sentences.
- `worker/index.ts`, with a header comment naming the spec's D1 and D2:

```ts
const DASH_HOST = new URL(DASH_ORIGIN).host;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/r/")) return env.ASSETS.fetch(request);
    if (url.host === DASH_HOST) return Response.redirect(`${PUBLIC_ORIGIN}${url.pathname}${url.search}`, 301);
    return publicRoomPage(url, env);
  },
};
```

  `publicRoomPage` answers `env.ASSETS.fetch(new URL("/", url))` until Task 5.

- [ ] **Step 5: Run them and watch them pass**

Run: `npx vitest run src/wrangler.test.ts && npm run test:worker && npm run build && npm run lint`
Expected: PASS, and a build that typechecks the worker program.

- [ ] **Step 6: Commit**

```bash
git add worker/index.ts tsconfig.worker.json tsconfig.json src/wrangler.test.ts worker-tests/package.json worker-tests/package-lock.json worker-tests/vitest.config.ts worker-tests/README.md worker-tests/routing.test.ts wrangler.toml package.json package-lock.json vite.config.ts .github/workflows/ci.yml
git commit -m "A Worker in front of the dash's assets sends dash.bellman.sh/r/ to bellman.sh, with tests over the build in workerd"
```

### Task 5: The public room page on bellman.sh

**Files:**
- Create: `worker/policy.ts`, `worker-tests/page.test.ts`
- Modify: `worker/index.ts`
- Test: `src/lib/csp.test.ts`, `worker-tests/page.test.ts`

**Interfaces:**
- Consumes: `Env` and the routing (Task 4).
- Produces: in `worker/policy.ts`, `PAGE_POLICY: string`. In `worker/index.ts`: `API_ORIGIN = "https://mcp.bellman.sh"`, `CACHE_SECONDS = 60`, `type ApiRead = { status: 200; body: unknown } | { status: 404 } | null`, and `apiRead(path: string): Promise<ApiRead>`, which Task 6 calls for the log too.

- [ ] **Step 1: Write the failing tests**

In `src/lib/csp.test.ts`, inside `describe("the content security policy")`, with `import { PAGE_POLICY } from "../../worker/policy";` at the top:

```ts
  it("serves the public room page on bellman.sh under the panel's policy, with the dash where the panel says 'self'", () => {
    // Every script, style, font and image that page loads is the dash's (src/lib/hosts.ts), so what 'self' admits on
    // the panel is the dash's origin by name there, and nothing else differs.
    expect(PAGE_POLICY).toBe(policy.replaceAll("'self'", "https://dash.bellman.sh"));
  });
```

`worker-tests/page.test.ts`:

```ts
/**
 * A public room's page on bellman.sh (public rooms on bellman.sh spec, sections 1 and 2): the dash's Worker over the
 * built panel, in real workerd. The server's public reads are stubbed at `fetch`, which reaches the Worker because the
 * pool runs it in this test's isolate, as bellman's worker-tests/host.test.ts stubs the model. Each case uses room keys
 * of its own: the Worker keeps what it reads for a minute, in a cache the cases share.
 */
import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAGE_POLICY } from "../worker/policy.ts";

const API = "https://mcp.bellman.sh";
let answers: Record<string, { status: number; body?: unknown }>;
let asked: string[];

beforeEach(() => {
  answers = {};
  asked = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new Request(input, init).url;
    asked.push(url);
    const answer = answers[url];
    if (!answer) throw new TypeError(`unreachable: ${url}`);
    return Response.json(answer.body ?? { error: "not_found", error_description: "no such public room" }, { status: answer.status });
  });
});
afterEach(() => vi.restoreAllMocks());

type Origin = { memberId: string; label: string };

/** A public room under `key`, answered as GET /public/rooms/:key and /public/rooms/:id/events answer. Its id. */
function stubRoom(key: string, over: { id?: string; room?: string; purpose?: string | null; by?: { handle: string; as: string } | null; log?: Origin[] } = {}) {
  const id = over.id ?? `qs_${key.replaceAll("-", "_")}`;
  answers[`${API}/public/rooms/${key}`] = {
    status: 200,
    body: {
      id, status: "active", closed_at: null, mode: "swarm", by: over.by ?? null,
      text: {
        trust: "untrusted", origin: { memberId: "m_creator", label: "member 1" },
        data: { room: over.room ?? "Open review", purpose: over.purpose === undefined ? "Read along" : over.purpose },
      },
    },
  };
  const log = over.log ?? [];
  answers[`${API}/public/rooms/${id}/events`] = {
    status: 200,
    body: {
      events: log.map((origin, i) => ({
        trust: "untrusted", origin,
        data: { cursor: i + 1, type: "message", from: { member_id: origin.memberId, label: origin.label }, payload: { text: "hi" }, ref_id: null, at: "2026-10-17T00:00:00.000Z" },
      })),
      cursor: log.length,
    },
  };
  return id;
}

/** The page as a browser asks for it. */
const open = (path: string) => SELF.fetch(`https://bellman.sh${path}`, { headers: { "sec-fetch-mode": "navigate" } });

/**
 * What a parser finds: the `name` attribute of every element `selector` matches, in order. Not a string search: setAttribute
 * leaves `<` and `>` as they are inside a quoted attribute, where a parser reads them as text.
 */
async function attrs(html: string, selector: string, name: string): Promise<(string | null)[]> {
  const found: (string | null)[] = [];
  await new HTMLRewriter().on(selector, { element(e) { found.push(e.getAttribute(name)); } }).transform(new Response(html)).text();
  return found;
}
const count = async (html: string, selector: string) => (await attrs(html, selector, "id")).length;

describe("a public room's page on bellman.sh", () => {
  it("serves the dash's app, every script, style and icon named in full on the dash", async () => {
    stubRoom("served-room");
    const res = await open("/r/served-room");
    expect([res.status, res.headers.get("content-type")]).toEqual([200, "text/html; charset=utf-8"]);
    const html = await res.text();
    const urls = [...(await attrs(html, "script[src]", "src")), ...(await attrs(html, 'link[href]:not([rel="canonical"])', "href"))];
    expect(urls.length).toBeGreaterThanOrEqual(3);
    expect(urls.filter((u) => !u!.startsWith("https://dash.bellman.sh/"))).toEqual([]);
    expect(await count(html, "div#root")).toBe(1);
  });

  it("answers under headers of its own: the panel's policy with the dash where the panel says 'self'", async () => {
    stubRoom("policy-room");
    const res = await open("/r/policy-room");
    expect(res.headers.get("content-security-policy")).toBe(PAGE_POLICY);
    expect(PAGE_POLICY).toContain("script-src https://dash.bellman.sh;");
    expect([res.headers.get("x-content-type-options"), res.headers.get("referrer-policy")]).toEqual(["nosniff", "no-referrer"]);
  });

  it("answers a room that is not public with 404 and the template's head, writes nothing the API said, and asks once a minute", async () => {
    answers[`${API}/public/rooms/qs_private`] = { status: 404 };
    const res = await open("/r/qs_private");
    expect([res.status, res.headers.get("content-security-policy")]).toEqual([404, PAGE_POLICY]);
    const html = await res.text();
    expect(html).toContain("<title>Bellman dash</title>");
    expect(await count(html, 'meta[property^="og:"]')).toBe(0);
    expect(html).not.toContain("no such public room");
    await open("/r/qs_private");
    expect(asked).toEqual([`${API}/public/rooms/qs_private`]);
  });

  it("answers a path that names no room with that 404, and asks the API nothing", async () => {
    for (const path of ["/r/", "/r/open-review/log"]) expect((await open(path)).status, path).toBe(404);
    expect(asked).toEqual([]);
  });

  it("reads a room's public answers once a minute, however many unfurls ask", async () => {
    stubRoom("cached-room");
    for (let i = 0; i < 3; i++) expect((await open("/r/cached-room")).status).toBe(200);
    expect(asked.filter((u) => u === `${API}/public/rooms/cached-room`)).toHaveLength(1);
  });

  // Review Focus 4.
  it("serves the app with the template's head when the API fails or cannot be reached, and keeps neither", async () => {
    answers[`${API}/public/rooms/flaky-room`] = { status: 503, body: { error: "unavailable" } };
    for (const key of ["flaky-room", "unreachable-room"]) {
      const res = await open(`/r/${key}`);
      expect(res.status, key).toBe(200);
      expect(await res.text(), key).toContain("<title>Bellman dash</title>");
    }
    stubRoom("flaky-room");
    await open("/r/flaky-room");
    expect(asked.filter((u) => u === `${API}/public/rooms/flaky-room`)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/lib/csp.test.ts; npm run test:worker`
Expected: FAIL. `worker/policy.ts` does not exist, so the CSP case and the page file fail to import. With an empty `export const PAGE_POLICY = ""` in place, the page cases fail on the policy header, the 404s (200 from the assets), and `asked` staying empty.

- [ ] **Step 3: Implement**

`worker/policy.ts`, its comment saying what R4 says:

```ts
export const PAGE_POLICY =
  "default-src https://dash.bellman.sh; connect-src https://dash.bellman.sh https://mcp.bellman.sh; img-src https://dash.bellman.sh https://mcp.bellman.sh data:; script-src https://dash.bellman.sh; style-src https://dash.bellman.sh; frame-src https://bellman-sandbox.jesse-483.workers.dev; object-src 'none'; base-uri https://dash.bellman.sh; form-action https://dash.bellman.sh; frame-ancestors 'none'";
```

`worker/index.ts`:
- `apiRead(path)` reads `` `${API_ORIGIN}${path}` `` through `caches.default`. A hit is the answer. On a miss it fetches with `accept: application/json`; a 200, its JSON parsed, or a 404 is put back under the same URL as a new `Response` with `cache-control: max-age=60` (`CACHE_SECONDS`), awaited before it returns. Any other status, a throw, or JSON that does not parse is `null`, and nothing is put.
- The page's headers are a constant: `content-type: text/html; charset=utf-8`, `content-security-policy: PAGE_POLICY`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `cache-control: no-store`. Every answer `publicRoomPage` gives is ``new Response(page.body, { status, headers })``, never the asset's headers.
- `publicRoomPage(url, env)`:
  - The page is `env.ASSETS.fetch(new URL("/", url))`, fetched beside the API read.
  - The key is `/^\/r\/([^/]+)\/?$/` on `url.pathname`, the segment as received. No key: 404, and no API read.
  - `apiRead(`/public/rooms/${key}`)`: `null`, or a 200 whose body has no string `id` or no string `text.data.room`, is the page with a 200; a 404 is the page with a 404; a 200 is the page with a 200, which Task 6 writes the room into.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run src/lib/csp.test.ts && npm run test:worker && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/policy.ts worker/index.ts worker-tests/page.test.ts src/lib/csp.test.ts
git commit -m "bellman.sh/r/<room> is the dash's app under its own policy, 404 for a room that is not public, its reads kept a minute"
```

### Task 6: The room written into its page

**Files:**
- Modify: `worker/index.ts`
- Test: `worker-tests/page.test.ts`

**Interfaces:**
- Consumes: `apiRead` (Task 5), `PUBLIC_ROOM_BASE` (Task 1).
- Produces: in `worker/index.ts`, a local `interface PublicRoom { id: string; text: { data: { room: string; purpose: string | null } }; by: { handle: string; as: string } | null }`, mirroring `GET /public/rooms/:id`; `SUMMARY_NAMES = 20`; `HEAD_TAGS: string`; `namesIn(log: unknown, by: PublicRoom["by"]): string[]`; `written(page: Response, room: PublicRoom, key: string, names: string[]): Response`.

- [ ] **Step 1: Write the failing tests**

Append to `worker-tests/page.test.ts`:

```ts
describe("the room written into its page", () => {
  it("writes the head: its title, description, Open Graph tags, a summary card and the canonical link", async () => {
    stubRoom("open-review");
    const html = await (await open("/r/open-review?view=log")).text();
    expect(html).toContain("<title>Open review \u{B7} Bellman</title>");
    const content = (selector: string) => attrs(html, selector, "content");
    expect(await content('meta[name="description"]')).toEqual(["Read along"]);
    expect(await content('meta[property="og:title"]')).toEqual(["Open review"]);
    expect(await content('meta[property="og:description"]')).toEqual(["Read along"]);
    expect(await content('meta[property="og:url"]')).toEqual(["https://bellman.sh/r/open-review"]);
    expect(await content('meta[property="og:site_name"]')).toEqual(["Bellman"]);
    expect(await content('meta[property="og:image"]')).toEqual(["https://bellman.sh/og.png"]);
    expect(await content('meta[name="twitter:card"]')).toEqual(["summary"]);
    expect(await attrs(html, 'link[rel="canonical"]', "href")).toEqual(["https://bellman.sh/r/open-review"]);
  });

  it("writes a summary a crawler can read, which the app replaces: the room's name, its byline, its purpose, its members' names", async () => {
    stubRoom("summary-room", {
      by: { handle: "ada", as: "member 1" },
      log: [
        { memberId: "m_creator", label: "member 1" }, { memberId: "m_peer", label: "member 2" },
        { memberId: "system", label: "bellman" }, { memberId: "m_creator", label: "member 1" },
        { memberId: "m_host", label: "host@bellman" },
      ],
    });
    const html = await (await open("/r/summary-room")).text();
    expect(html).toContain(
      '<div id="root"><main data-room-summary><h1>Open review</h1><p>by @ada</p><p>Read along</p><p>Members: @ada, member 2, host@bellman</p></main></div>',
    );
  });

  it("describes a room with no purpose in Bellman's words, and writes no line it has nothing for", async () => {
    stubRoom("quiet-room", { purpose: null });
    const html = await (await open("/r/quiet-room")).text();
    expect(await attrs(html, 'meta[name="description"]', "content")).toEqual(["A public Bellman room."]);
    expect(html).toContain("<main data-room-summary><h1>Open review</h1></main>");
  });

  it("names at most 20 members, the first to appear in the log", async () => {
    const log = Array.from({ length: 25 }, (_, i) => ({ memberId: `m_${i}`, label: `member ${i + 1}` }));
    stubRoom("crowded-room", { log });
    const html = await (await open("/r/crowded-room")).text();
    expect(html).toContain(`<p>Members: ${log.slice(0, 20).map((o) => o.label).join(", ")}</p>`);
  });

  it("reads the log by the id the room's read returned, and writes the room without members when the log cannot be read", async () => {
    const id = stubRoom("no-log-room", { id: "qs_7f3k" });
    answers[`${API}/public/rooms/${id}/events`] = { status: 503 };
    const html = await (await open("/r/no-log-room")).text();
    expect(asked).toContain(`${API}/public/rooms/qs_7f3k/events`);
    expect(await attrs(html, 'meta[property="og:title"]', "content")).toEqual(["Open review"]);
    expect(html).toContain("<main data-room-summary><h1>Open review</h1><p>Read along</p></main>");
  });

  it('keeps a room\'s name, purpose and members\' names as text, a name of "><script> included', async () => {
    stubRoom("plain-room");
    const plain = await (await open("/r/plain-room")).text();
    stubRoom("evil-room", { room: '"><script>alert(1)</script>', purpose: "<img src=x onerror=alert(1)>", log: [{ memberId: "m_x", label: "<b>member 9</b>" }] });
    const html = await (await open("/r/evil-room")).text();
    expect(await count(html, "script")).toBe(await count(plain, "script"));
    expect(await count(html, "img")).toBe(0);
    expect(await count(html, "main[data-room-summary] *")).toBe(3);
    expect(html).toContain('<title>"&gt;&lt;script&gt;alert(1)&lt;/script&gt; \u{B7} Bellman</title>');
    expect(await attrs(html, 'meta[property="og:title"]', "content")).toEqual(['&quot;><script>alert(1)</script>']);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm run test:worker`
Expected: the new cases FAIL: the title is `Bellman dash`, no `og:` tag and no summary is written, and the log is never asked for. Task 5's cases still PASS.

- [ ] **Step 3: Implement**

- The log: for a 200 room read, `apiRead(`/public/rooms/${encodeURIComponent(room.id)}/events`)`; a 200 gives `namesIn(body, room.by)`, anything else no names.
- `namesIn`: each event's `origin.label`, skipping origins whose `memberId` is `"system"`, with `by.as` shown as `` `@${by.handle}` `` (the dash's `nameFor`, R8), distinct, in order of first appearance, the first `SUMMARY_NAMES`.
- `HEAD_TAGS`, constant markup appended to `<head>`, the values the second pass sets left empty:

```ts
const HEAD_TAGS =
  '<meta name="description" content=""><meta property="og:title" content=""><meta property="og:description" content="">' +
  '<meta property="og:url" content=""><meta property="og:site_name" content="Bellman"><meta property="og:image" content="https://bellman.sh/og.png">' +
  '<meta name="twitter:card" content="summary"><link rel="canonical" href="">';
```

- `written` runs two `HTMLRewriter` passes, the second over the first's output: an element the first pass appends is not matched by the same pass, and `setAttribute` is the only way to an escaped attribute value.
  - The first pass: `title` gets `setInnerContent(`${room.text.data.room} \u{B7} Bellman`)`; `head` gets `append(HEAD_TAGS, { html: true })`; `div#root` gets the summary, each tag appended with `{ html: true }` and each value with `{ html: false }`: `<main data-room-summary>`, then `<h1>` and the name, then `<p>` and `` `by @${room.by.handle}` `` when there is a byline, `<p>` and the purpose when there is one, `<p>` and `` `Members: ${names.join(", ")}` `` when there are names, then `</main>`.
  - The second pass sets `content` on `meta[name="description"]` and `meta[property="og:description"]` to the purpose, or `A public Bellman room.` when it is null or empty; on `meta[property="og:title"]` to the room's name; on `meta[property="og:url"]`, and `href` on `link[rel="canonical"]`, to `` `${PUBLIC_ROOM_BASE}${key}` ``.

- [ ] **Step 4: Run them and watch them pass**

Run: `npm run test:worker && npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/index.ts worker-tests/page.test.ts
git commit -m "A public room's page carries its name and purpose in its head and a plain summary, written as text"
```

### Task 7: The route on bellman.sh, the README and the deploy's checks

**Files:**
- Modify: `wrangler.toml`, `README.md`, `.github/workflows/ci.yml`
- Test: `src/wrangler.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/wrangler.test.ts`:

```ts
  it("attaches bellman.sh/r/* on the bellman.sh zone, beside the panel's own hostname", () => {
    expect(toml).toMatch(/\[\[routes\]\]\npattern = "bellman\.sh\/r\/\*"\nzone_name = "bellman\.sh"\n/);
    expect(toml).toMatch(/\[\[routes\]\]\npattern = "dash\.bellman\.sh"\ncustom_domain = true\n/);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/wrangler.test.ts`
Expected: FAIL on the first match.

- [ ] **Step 3: Implement**

- `wrangler.toml`, after the `dash.bellman.sh` route, with a comment: the site's Worker holds `bellman.sh` as a Custom Domain, which Cloudflare treats as an origin, so this route runs before it; adding it needs the deploy token to hold Workers Routes on the `bellman.sh` zone, and a deploy that cannot attach it still puts the script live (wrangler uploads, then attaches routes, with no rollback), so the 301 would send every old link to the site's 404.

```toml
[[routes]]
pattern = "bellman.sh/r/*"
zone_name = "bellman.sh"
```

- `README.md`, the Shape item on the static build: the panel is served by a Cloudflare Worker's assets binding at `dash.bellman.sh`, with a script in front of it for `/r/*` alone (`worker/index.ts`): a public room's page, served at `bellman.sh/r/<room>` with the room's head and a summary written in, and a 301 there from `dash.bellman.sh/r/*`; `wrangler.toml` attaches both hosts, and the route on the `bellman.sh` zone needs the token to hold Workers Routes there. Under Develop: `npm run test:worker` builds the panel and runs the Worker over it in workerd (`worker-tests/`, a dependency tree of its own).
- `.github/workflows/ci.yml`, after the deploy step and also only on `main`, with a comment saying R5 in one sentence:

```yaml
      - if: github.ref == 'refs/heads/main'
        name: A link at dash.bellman.sh/r/ still reaches bellman.sh, and bellman.sh/r/ is this Worker's
        run: |
          sleep 5
          got=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -H 'Sec-Fetch-Mode: navigate' --max-time 30 https://dash.bellman.sh/r/no-such-room)
          test "$got" = "301 https://bellman.sh/r/no-such-room" || { echo "dash.bellman.sh/r/: got $got"; exit 1; }
          curl -sI --max-time 30 https://bellman.sh/r/no-such-room | grep -qi '^content-security-policy:.*script-src https://dash.bellman.sh;' \
            || { echo "bellman.sh/r/ is not the dash's page"; exit 1; }
```

- [ ] **Step 4: Run everything**

Run:
```bash
npx vitest run src/wrangler.test.ts
npm run lint && npm test && npm run build && npm run test:worker
npx wrangler deploy --dry-run --outdir "$(mktemp -d)"
```
Expected: PASS, and the dry run bundles `worker/index.ts` with the `ASSETS` binding and refuses nothing. A dry run does not reach the zone, so the route's permission shows only on the real deploy.

- [ ] **Step 5: Commit**

```bash
git add wrangler.toml README.md .github/workflows/ci.yml src/wrangler.test.ts
git commit -m "The dash's Worker takes bellman.sh/r/*, and each deploy checks the old links' redirect and the page live"
```

### Part 1's review and PR

- [ ] **The whole-branch review:** one reviewer over `git diff origin/main...HEAD`, with this plan and the spec. Fix what it finds, with tests, before the PR.
- [ ] **The PR.** Read `git diff --stat origin/main...HEAD` against the files these tasks list, then push and open it. The body says what changes; that it ships before the server's PR; that the sandbox is deployed from the branch before the merge (`npm run deploy:sandbox`, by hand); that the route needs Workers Routes on the `bellman.sh` zone, granted to the CI token or attached by hand before the merge, or the old links go to the site's 404; and that CI now checks the redirect live.
- [ ] **Before the merge:** the sandbox is deployed, and the token holds the route permission or the route is attached by hand.
- [ ] **After the merge:** read the deploy job and the new check, not only the merge. Open `https://bellman.sh/r/<a public room>`: the canvas draws, a diagram renders, the log tab reads. Paste the link into Slack and see it unfurl.

---

# Part 2 — bellman (one PR, after Part 1 is deployed)

The workspace is `/Users/mcfearsome/.worktrees/bellman-public-host`, a jj workspace on the bookmark `mcfearsome/public-on-bellman-sh`. It has no `.git`, so git commands fail there: use `jj`, and `jj -R ~/src/github.com/bellman-sh/bellman git fetch` to fetch. `npm ci` has been run. Unit tests: `npx vitest run <file>`. The workerd suite: `npm run test:worker`. Everything: `npm run verify`.

### Task 8: Public links start `https://bellman.sh/r/`

**Files:**
- Modify: `src/codes.ts`
- Test: `tests/public-names.test.ts`, `tests/public-rooms.test.ts`, `tests/http-bylines.test.ts`, `worker-tests/public-routes.test.ts`, `ui/test/render.test.ts`

**Interfaces:**
- Produces: `PUBLIC_ROOM_URL_BASE = "https://bellman.sh/r/"`; `publicRoomUrl` is unchanged.

- [ ] **Step 1: Write the failing tests**

In each of the five files, replace `https://dash.bellman.sh/r/` with `https://bellman.sh/r/`: 5, 2, 3, 1 and 2 places. Then `rg -n 'dash\.bellman\.sh/r' tests worker-tests ui/test` prints nothing.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/public-names.test.ts tests/public-rooms.test.ts tests/http-bylines.test.ts ui/test/render.test.ts`
Expected: FAIL in the first three, each `expected 'https://dash.bellman.sh/r/…' to be 'https://bellman.sh/r/…'`. `ui/test/render.test.ts` PASSES: its fixture is input, which the card prints as given.

- [ ] **Step 3: Implement**

`PUBLIC_ROOM_URL_BASE = "https://bellman.sh/r/"`. Its comment: the page a public room is read at (public rooms on bellman.sh spec, D1) is `bellman.sh/r/`, which the dash's Worker serves, by the room's name while it holds one (public names spec, D7) and by its id otherwise.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/public-names.test.ts tests/public-rooms.test.ts tests/http-bylines.test.ts ui/test/render.test.ts && npm run test:worker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
jj commit -m "Public room links start https://bellman.sh/r/, where the dash's Worker serves the page"
```

### Task 9: A freed handle is held for 65 minutes

**Files:**
- Modify: `src/handles.ts`; `src/store.ts` (the `BellmanStore` interface's `claimHandle`, `releaseHandle` and `releaseHandleNamed`, and `MemoryStore`'s); `src/store-do.ts` (`RegistryDO.claimHandle`, `releaseHandle`, `releaseHandleNamed` and `#release`, and `DurableObjectStore`'s three); `src/http/handles.ts`; `src/oauth/routes.ts` (the `/admin/handles/:handle` branch)
- Test: `tests/handles.test.ts`, `tests/helpers/store-contract.ts`, `tests/http-bylines.test.ts`, `worker-tests/handle-routes.test.ts`

**Interfaces:**
- Produces: in `src/handles.ts`, `HANDLE_CACHE_MS = 60 * 60_000` and `HANDLE_HOLD_MS = HANDLE_CACHE_MS + 5 * 60_000`. On `BellmanStore`: `claimHandle(userId: string, handle: string, at: number): Promise<"claimed" | "taken">`, `releaseHandle(userId: string, at: number): Promise<void>`, `releaseHandleNamed(handle: string, at: number): Promise<string | undefined>`, where `at` is the caller's clock in milliseconds; `claimHandle` answers "taken" while `at < freedAt + HANDLE_HOLD_MS` for a held name.

- [ ] **Step 1: Write the failing tests**

`tests/handles.test.ts`, importing `HANDLE_CACHE_MS` and `HANDLE_HOLD_MS` beside `checkHandle`:

```ts
describe("the hold on a freed handle (public rooms on bellman.sh spec, D5)", () => {
  it("outlasts the hour a server keeps a handle and the minute the dash keeps a page's reads", () => {
    expect(HANDLE_CACHE_MS).toBe(60 * 60_000);
    expect(HANDLE_HOLD_MS).toBe(HANDLE_CACHE_MS + 5 * 60_000);
  });
});
```

`tests/helpers/store-contract.ts`, in `describe("handles and bylines")`: `const T = 1_800_000_000_000;` at its top, and every `claimHandle`, `releaseHandle` and `releaseHandleNamed` call in the block gains `T` as its time. "frees the old handle when one changes" becomes:

```ts
      it("moves a handle on a change, and holds the old one from everyone", async () => {
        await store.claimHandle("u_a", "ada", T);
        expect(await store.claimHandle("u_a", "lovelace", T)).toBe("claimed");
        expect(await store.userOfHandle("ada")).toBeUndefined();
        expect(await store.claimHandle("u_b", "ada", T)).toBe("taken");
        expect(await store.handleOf("u_a")).toBe("lovelace");
      });
```

and the block gains, with `HANDLE_HOLD_MS` imported from `../../src/handles.js`:

```ts
      // Public rooms on bellman.sh spec, D5. Each path that deletes a name's row frees it, and the name is then held from
      // every account, its last holder too (so a holder cannot undo the operator's release), for HANDLE_HOLD_MS.
      describe("a freed handle's hold", () => {
        const frees: [string, (s: BellmanStore) => Promise<unknown>][] = [
          ["a release", (s) => s.releaseHandle("u_a", T)],
          ["a change to another name", (s) => s.claimHandle("u_a", "ada-two", T)],
          ["the operator's release", (s) => s.releaseHandleNamed("ada", T)],
        ];
        // Review Focus 6: the boundary, a millisecond either side of it.
        it.each(frees)("holds a name freed by %s from every account, its last holder too, until HANDLE_HOLD_MS has passed", async (_how, free) => {
          await store.claimHandle("u_a", "ada", T - 1);
          await free(store);
          expect(await store.userOfHandle("ada")).toBeUndefined();
          const late = T + HANDLE_HOLD_MS - 1;
          expect(await store.claimHandle("u_b", "ada", late)).toBe("taken");
          expect(await store.claimHandle("u_a", "ada", late)).toBe("taken");
          expect(await store.handleOf("u_b")).toBeUndefined();
          expect(await store.claimHandle("u_b", "ada", T + HANDLE_HOLD_MS)).toBe("claimed");
          expect(await store.userOfHandle("ada")).toBe("u_b");
        });

        it("holds a name from its latest freeing, not its first", async () => {
          await store.claimHandle("u_a", "ada", T);
          await store.releaseHandle("u_a", T);
          expect(await store.claimHandle("u_b", "ada", T + HANDLE_HOLD_MS)).toBe("claimed");
          await store.releaseHandle("u_b", T + HANDLE_HOLD_MS + 10);
          expect(await store.claimHandle("u_a", "ada", T + 2 * HANDLE_HOLD_MS)).toBe("taken");
          expect(await store.claimHandle("u_a", "ada", T + 2 * HANDLE_HOLD_MS + 10)).toBe("claimed");
        });
      });
```

`tests/http-bylines.test.ts`, with `HANDLE_HOLD_MS` imported from `../src/handles.js`; every `store.claimHandle` and `store.releaseHandle` call gains `Date.now()`:
- "free the old handle on a change, and release it on DELETE" becomes:

```ts
  it("hold the old handle on a change, and release it on DELETE", async () => {
    await handleCall(DEV_KEY.jesse, "PUT", { handle: "first" });
    await handleCall(DEV_KEY.jesse, "PUT", { handle: "second" });
    const held = (await handleCall(DEV_KEY.peer, "PUT", { handle: "first" }))!;
    expect([held.status, await held.json()]).toEqual([409, {
      error: "handle_taken",
      error_description: "first is taken. A handle that was released or changed away from is held for 65 minutes before anyone can claim it.",
    }]);
    expect(await store.claimHandle("u_peer", "first", Date.now() + HANDLE_HOLD_MS)).toBe("claimed");
    expect((await handleCall(DEV_KEY.jesse, "DELETE"))!.status).toBe(204);
    expect(await bodyOf(await handleCall(DEV_KEY.jesse, "GET"))).toEqual({ handle: null });
  });
```

- "lists none of an old owner's rooms under a freed handle someone else claimed": the peer's `PUT` of `jesse` becomes `await store.claimHandle("u_peer", "jesse", Date.now() + HANDLE_HOLD_MS);`.

`worker-tests/handle-routes.test.ts`, which no typecheck program reads, so its three calls by hand, with `HANDLE_HOLD_MS` imported from `../src/handles.js`:
- `registry.claimHandle("u_someone_else", "held-by-other", Date.now())` and `registry.claimHandle("u_someone", "wire-held", Date.now())`;
- the change case becomes:

```ts
    // A change holds the old handle from everyone for HANDLE_HOLD_MS, and frees it after.
    expect((await put("wire-do-two")).status).toBe(200);
    expect(await registry.claimHandle("u_someone_else", "wire-do", Date.now())).toBe("taken");
    expect(await registry.claimHandle("u_someone_else", "wire-do", Date.now() + HANDLE_HOLD_MS)).toBe("claimed");
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/handles.test.ts tests/store.test.ts tests/http-bylines.test.ts`
Expected: FAIL. The constants are not exported; every hold case and the changed contract case see "claimed" where they expect "taken"; the 409's description is `first belongs to someone else`.

- [ ] **Step 3: Implement**

- `src/handles.ts`: the two constants, `HANDLE_HOLD_MS`'s comment saying it must outlast the hour a name can sit in a server's cache (`HANDLE_CACHE_MS`) plus the minute it can sit in the dash's preview cache, so no page shows a name under an account after another account claims it.
- The interface's three methods take `at`, their doc comments saying a freed name is held from every account for `HANDLE_HOLD_MS`, its last holder too.
- `RegistryDO`, each in the transaction it already runs:
  - `claimHandle`: after the holder check, a `hh:<handle>` row with `at < freedAt + HANDLE_HOLD_MS` answers "taken"; moving from an old name deletes `hn:<old>` and puts `hh:<old>` = `at`; the claim deletes `hh:<handle>`.
  - `#release(txn, userId, at)`: deletes the rows it deletes now and puts `hh:<handle>` = `at` when there was a handle. `releaseHandle` and `releaseHandleNamed` pass `at` to it.
- `MemoryStore`: a `Map` of held names to their freeing time, kept the same way.
- `DurableObjectStore`: passes `at` through.
- `src/http/handles.ts`: `releaseHandle(userId, Date.now())` and `claimHandle(userId, check.handle, Date.now())`; the 409's description is `` `${check.handle} is taken. A handle that was released or changed away from is held for 65 minutes before anyone can claim it.` ``
- `src/oauth/routes.ts`: `releaseHandleNamed(handle, Date.now())`.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/handles.test.ts tests/store.test.ts tests/http-bylines.test.ts && npm run typecheck && npm run test:worker`
Expected: PASS; `npm run typecheck` names no call left without `at`.

- [ ] **Step 5: Commit**

```bash
jj commit -m "A handle released, changed away from or released by the operator is held from every account for 65 minutes"
```

### Task 10: Many users' handles in one registry read

**Files:**
- Modify: `src/store.ts` (the `BellmanStore` interface, `MemoryStore`), `src/store-do.ts` (`RegistryDO`, `DurableObjectStore`)
- Test: `tests/helpers/store-contract.ts`, run by `tests/store.test.ts` and `worker-tests/store-contract.test.ts`

**Interfaces:**
- Produces: `handlesOf(userIds: readonly string[]): Promise<Record<string, string>>` on `BellmanStore`, after `userOfHandle`: the handle each of these users holds, by user id, in one read of the registry; a user who holds none is left out.

- [ ] **Step 1: Write the failing test**

In `describe("handles and bylines")` of `tests/helpers/store-contract.ts`:

```ts
      // More users than one storage read takes (128), so the read must batch them.
      it("reads many users' handles in one call, leaving out a user who holds none", async () => {
        await store.claimHandle("u_a", "ada", T);
        await store.claimHandle("u_b", "grace", T);
        const nobody = Array.from({ length: 130 }, (_, i) => `u_none_${i}`);
        expect(await store.handlesOf(["u_a", ...nobody, "u_b", "u_a"])).toEqual({ u_a: "ada", u_b: "grace" });
        await store.releaseHandle("u_b", T);
        expect(await store.handlesOf(["u_a", "u_b"])).toEqual({ u_a: "ada" });
        expect(await store.handlesOf([])).toEqual({});
      });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/store.test.ts -t "many users' handles"`
Expected: FAIL, `store.handlesOf is not a function`.

- [ ] **Step 3: Implement**

- The interface method, its doc comment naming the public reads as its caller (public rooms on bellman.sh spec, section 3) and saying it is exact: the public read path caches in front of it (Task 11).
- `MemoryStore`: from `handleByUser`.
- `RegistryDO.handlesOf(userIds: string[])`: `getRows<string>(this.ctx.storage, [...new Set(userIds)].map((u) => `uh:${u}`))`, each key with `uh:` cut off.
- `DurableObjectStore.handlesOf`: `{}` for no ids without a call; otherwise one call, `this.registry.handlesOf([...new Set(userIds)])`.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/store.test.ts && npm run test:worker`
Expected: PASS in both programs.

- [ ] **Step 5: Commit**

```bash
jj commit -m "handlesOf reads many users' handles from the registry in one call"
```

### Task 11: Public reads name members by the handle their account claimed, kept an hour

**Files:**
- Modify: `src/handles.ts` (`HandleCache`), `src/http/public.ts`, `src/worker.ts`
- Create: `worker-tests/public-names.test.ts`
- Test: `tests/handles.test.ts`, `tests/http-public.test.ts`, `tests/http-bylines.test.ts`, `worker-tests/public-routes.test.ts`, `worker-tests/public-names.test.ts`

**Interfaces:**
- Consumes: `handlesOf` (Task 10); `HANDLE_CACHE_MS` (Task 9); `getMembers` and `publicNumbers`, as they are.
- Produces:
  - `class HandleCache` in `src/handles.ts`: `constructor(ttlMs = HANDLE_CACHE_MS, max = 10_000)` and `handlesOf(userIds: readonly string[], read: (userIds: string[]) => Promise<Record<string, string>>, now = Date.now()): Promise<Record<string, string>>`, which keeps each account's answer, a handle or none, until `now + ttlMs`, `now` taken before `read` is called, and calls `read` once with only the accounts it keeps no answer for. ponytail: cleared whole past `max`, as `SuspensionCache` is.
  - `PublicRouteDeps` gains `handles?: HandleCache`.
  - Module-private `publicNames(deps: PublicRouteDeps, session: StoredSession, page: unknown): Promise<Map<string, string>>`, and `named(deps, session, page)` and `byName(value, names)` in place of `numbered` and `byNumber`, each taking the session where it took its id.

- [ ] **Step 1: Write the failing tests**

`tests/handles.test.ts`, importing `HandleCache` beside the constants and `vi` beside the file's other vitest imports:

```ts
describe("HandleCache (public rooms on bellman.sh spec, D5)", () => {
  it("reads only the accounts it keeps no answer for, in one call, and keeps an account with no handle too", async () => {
    const cache = new HandleCache();
    const read = vi.fn(async (ids: string[]) => Object.fromEntries(ids.filter((id) => id === "u_a").map((id) => [id, "ada"])));
    expect(await cache.handlesOf(["u_a", "u_b"], read, 0)).toEqual({ u_a: "ada" });
    expect(await cache.handlesOf(["u_a", "u_b", "u_c"], read, 1)).toEqual({ u_a: "ada" });
    expect(read.mock.calls).toEqual([[["u_a", "u_b"]], [["u_c"]]]);
  });

  it("keeps an answer for HANDLE_CACHE_MS from the time it was asked for, and reads again after", async () => {
    const cache = new HandleCache();
    let handle = "ada";
    const read = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, handle])));
    await cache.handlesOf(["u_a"], read, 1_000);
    handle = "ada-two";
    expect(await cache.handlesOf(["u_a"], read, 1_000 + HANDLE_CACHE_MS - 1)).toEqual({ u_a: "ada" });
    expect(await cache.handlesOf(["u_a"], read, 1_000 + HANDLE_CACHE_MS)).toEqual({ u_a: "ada-two" });
  });

  it("asks nothing for no accounts, and clears whole past its bound rather than growing", async () => {
    const read = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, "h"])));
    const cache = new HandleCache(HANDLE_CACHE_MS, 2);
    expect(await cache.handlesOf([], read, 0)).toEqual({});
    expect(read).not.toHaveBeenCalled();
    await cache.handlesOf(["u_a", "u_b"], read, 0);
    await cache.handlesOf(["u_c"], read, 0);
    await cache.handlesOf(["u_a"], read, 0);
    expect(read.mock.calls.at(-1)).toEqual([["u_a"]]);
  });
});
```

`tests/http-public.test.ts`, importing `HOST_MEMBER_ID` and `HOST_USER_ID` beside `MemoryStore` from `../src/store.js`, `HOST_LABEL` from `../src/host.js`, `HANDLE_CACHE_MS` and `HandleCache` from `../src/handles.js`, and `afterEach` beside the file's other vitest imports:

```ts
describe("members' public names (public rooms on bellman.sh spec, section 3)", () => {
  const originsOf = async (room: string, query = "", handles?: HandleCache) =>
    ((await bodyOf(await publicRoutes(new Request(`${ISSUER}/public/rooms/${room}/events${query}`), { store, blobs, handles }))) as unknown as {
      events: { origin: { label: string } }[];
    }).events.map((e) => e.origin.label);
  const sends = (room: string, from: Member) =>
    store.appendEvent(room, { type: "message", fromMemberId: from.memberId, fromUserId: from.userId, fromLabel: from.label, payload: { text: "hi" }, refId: null });

  it("names a member whose account claimed a handle @handle, and one with none member N, the room's read included", async () => {
    await store.claimHandle("u_jesse", "jesse", Date.now());
    await sends(PUB, member());
    await sends(PUB, peer());
    expect(await originsOf(PUB)).toEqual(["@jesse", "member 2"]);
    expect((await bodyOf(await read(`/public/rooms/${PUB}`))).text).toMatchObject({ origin: { memberId: "m_creator", label: "@jesse" } });
  });

  // Review Focus 5: the session holds the members in the room now, so one who left is read by the id the page carries.
  it("names a member who has left by their handle", async () => {
    await store.claimHandle("u_peer", "peer", Date.now());
    await sends(PUB, peer());
    await store.updateMember(PUB, "m_peer", { leftAt: Date.now() });
    expect((await store.getSession(PUB))!.members.map((m) => m.memberId)).toEqual(["m_creator"]);
    expect(await originsOf(PUB)).toEqual(["@peer"]);
  });

  // Review Focus 5: a payload may name a member by label with no member id beside it, here on a page of its own.
  it("names a member still in the room by their handle where the page names them by label alone", async () => {
    await store.claimHandle("u_jesse", "jesse", Date.now());
    await store.appendEvent(PUB, {
      type: "heartbeat", fromMemberId: "system", fromUserId: "system", fromLabel: "bellman",
      payload: { about: { origin: { label: "jesse@codenerd" } } }, refId: null,
    });
    const { events } = (await bodyOf(await read(`/public/rooms/${PUB}/events`))) as unknown as { events: { data: { payload: unknown } }[] };
    expect(events.map((e) => e.data.payload)).toEqual([{ about: { origin: { label: "@jesse" } } }]);
  });

  it("names one account's seats alike", async () => {
    const second = member({ memberId: "m_creator_2" });
    await store.createSession(publicRoom({ id: "qs_two_seats", members: [member(), second, peer()] }));
    await store.claimHandle("u_jesse", "jesse", Date.now());
    await sends("qs_two_seats", member());
    await sends("qs_two_seats", second);
    expect(await originsOf("qs_two_seats")).toEqual(["@jesse", "@jesse"]);
  });

  it("names a label two accounts were seated under by its number, whichever of them claimed a handle", async () => {
    const twin = member({ memberId: "m_twin", userId: "u_twin", roomRole: "peer_b" });
    await store.createSession(publicRoom({ id: "qs_shared_label", members: [member(), twin] }));
    await store.claimHandle("u_jesse", "jesse", Date.now());
    await sends("qs_shared_label", member());
    await sends("qs_shared_label", twin);
    expect(await originsOf("qs_shared_label")).toEqual(["member 1", "member 1"]);
  });

  it("keeps the hosted seat's own label, whatever its account holds", async () => {
    const host = member({ memberId: HOST_MEMBER_ID, userId: HOST_USER_ID, label: HOST_LABEL, roomRole: "peer_b" });
    await store.createSession(publicRoom({ id: "qs_hosted", members: [member(), host] }));
    // Nothing claims a handle for the seat; this shows a public read never names it by one.
    await store.claimHandle(HOST_USER_ID, "the-host", Date.now());
    await sends("qs_hosted", host);
    expect(await originsOf("qs_hosted")).toEqual([HOST_LABEL]);
  });

  it("asks the registry nothing for a page that names nobody", async () => {
    const handles = vi.spyOn(store, "handlesOf");
    expect(await originsOf(PUB, "?after=0")).toEqual([]);
    expect(handles).not.toHaveBeenCalled();
  });

  // The spec's check (section 4): every label the room holds or held, against every public answer, the handle page's too.
  it("answers no public read with a member's sign-in label", async () => {
    const gone = member({ memberId: "m_gone", userId: "u_gone", label: "gone@codenerd", roomRole: "peer_b" });
    await store.createSession(publicRoom({ id: "qs_every", members: [member(), peer(), gone] }));
    await store.claimHandle("u_jesse", "jesse", Date.now());
    await store.claimHandle("u_gone", "gone", Date.now());
    await store.signRoom("u_jesse", "qs_every", Date.now());
    await store.claimPublicName("every-label", { id: "qs_every", at: Date.now() }, null);
    await store.setPublicName("qs_every", "every-label");
    const put = (await asCreator("/rooms/qs_every/surface/plan?member_id=m_creator", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "text", title: "The plan", body: "hello" }),
    }))!;
    expect(put.status).toBe(200);
    const log = (from: Member, type: EventType, payload: unknown) => store.appendEvent("qs_every", {
      type, fromMemberId: from.memberId, fromUserId: from.userId, fromLabel: from.label, payload, refId: null,
    });
    await log(member(), "message", { text: "hello" });
    await log(peer(), "member_joined", { member: storedMember(peer()), brief: brief() });
    await log(gone, "message", { text: "bye" });
    await log(gone, "member_left", { label: gone.label });
    await store.updateMember("qs_every", "m_gone", { leftAt: Date.now() });
    await store.appendEvent("qs_every", {
      type: "heartbeat", fromMemberId: "system", fromUserId: "system", fromLabel: "bellman",
      payload: { members: [{ member_id: "m_peer", label: peer().label }], about: { origin: { label: gone.label } } }, refId: null,
    });
    const room = (await store.getSession("qs_every"))!;
    const labels = [...room.members, ...(await store.departedMembers("qs_every")).members].map((m) => m.label);
    expect(new Set(labels)).toEqual(new Set(["jesse@codenerd", "peer@codenerd", "gone@codenerd"]));

    const { events } = (await bodyOf(await read("/public/rooms/qs_every/events"))) as unknown as { events: { data: { cursor: number } }[] };
    const paths = [
      ...["qs_every", "every-label"].flatMap((key) => [`/public/rooms/${key}`, `/public/rooms/${key}/surface`, `/public/rooms/${key}/events`]),
      ...events.map((e) => `/public/rooms/qs_every/events?after=${e.data.cursor - 1}`),
      "/public/handles/jesse",
    ];
    const answered = await Promise.all(paths.map(async (path) => [path, await (await read(path))!.text()] as const));
    for (const [path, body] of answered) {
      expect(body.length, path).toBeGreaterThan(2);
      for (const label of labels) expect(body, `${path} names ${label}`).not.toContain(label);
    }
    // The control: these reads name the members, by handle and by number.
    const all = answered.map(([, body]) => body).join("\n");
    for (const name of ["@jesse", "@gone", "member 2"]) expect(all).toContain(name);
  });

  // Public rooms on bellman.sh spec, D5, with the cache the Worker keeps, on a fake clock.
  describe("the hour a public read keeps a handle", () => {
    const T0 = Date.parse("2026-10-17T12:00:00Z");
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T0);
    });
    afterEach(() => vi.useRealTimers());

    it("shows a released handle until an hour after the read that kept it, and member N after", async () => {
      const handles = new HandleCache();
      await store.claimHandle("u_jesse", "jesse", T0);
      await sends(PUB, member());
      expect(await originsOf(PUB, "", handles)).toEqual(["@jesse"]);
      await store.releaseHandle("u_jesse", T0);
      vi.setSystemTime(T0 + HANDLE_CACHE_MS - 1);
      expect(await originsOf(PUB, "", handles)).toEqual(["@jesse"]);
      vi.setSystemTime(T0 + HANDLE_CACHE_MS);
      expect(await originsOf(PUB, "", handles)).toEqual(["member 1"]);
    });

    // Review Focus 7: the registry answers before the release lands, and the answer reaches the cache six minutes later.
    it("keeps a handle read just before its release no longer than an hour from that read, inside the hold", async () => {
      const handles = new HandleCache();
      await store.claimHandle("u_jesse", "jesse", T0);
      await sends(PUB, member());
      let open!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      const exact = store.handlesOf.bind(store);
      const asked = vi.spyOn(store, "handlesOf").mockImplementationOnce(async (ids) => {
        const answer = await exact(ids);
        await gate;
        return answer;
      });
      const reading = originsOf(PUB, "", handles);
      await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
      await store.releaseHandle("u_jesse", T0);
      vi.setSystemTime(T0 + 6 * 60_000);
      open();
      expect(await reading).toEqual(["@jesse"]);
      vi.setSystemTime(T0 + HANDLE_CACHE_MS);
      expect(await originsOf(PUB, "", handles)).toEqual(["member 1"]);
      expect(await store.claimHandle("u_peer", "jesse", T0 + HANDLE_CACHE_MS)).toBe("taken");
    });
  });
});
```

`tests/http-bylines.test.ts`, `describe("the byline on the public reads")` and the reserved-handle case, where the creator now holds a handle (its deps carry no cache, so its reads are exact):
- "is null until the creator signs, then names the handle and the creator's public number", renamed "… then names the handle, and the creator by it": `by: { handle: "jesse", as: "@jesse" }`.
- "names the creator in the log by the same number the byline gives", renamed "… by the same name the byline gives": unchanged otherwise.
- "carries the handle and the number and nothing more", renamed "carries the handle and the creator's name and nothing more": `{ handle: "jesse", as: "@jesse" }`.
- "names the creator's seat after the creator has left the room": `label: "@jesse"` and `as: "@jesse"`.
- "names the creator on a read by the room's public name, as on a read by its id": `as: "@jesse"`.
- "still names the creator on a closed room's read, until its purge": `as: "@jesse"`.
- "reads a handle that is reserved but well-formed and held, and the byline on its room says the same": `as: "@admin"`.

`worker-tests/public-routes.test.ts`, the handle page case: `toMatchObject({ by: { handle: "ws-jesse" } })`, with a comment: `as` is whatever the Worker's cache holds for this user, and an earlier case in this file read it (R28).

`worker-tests/public-names.test.ts`:

```ts
/**
 * The Worker keeps each account's handle for an hour where it serves public reads (public rooms on bellman.sh spec, D5),
 * over the real registry. A user of its own, through a key map of its own, so no other case's read is in the cache.
 */
import { afterEach, describe, expect, it } from "vitest";
import { env, reset, abortAllDurableObjects } from "cloudflare:test";
import { DurableObjectStore } from "../src/store-do.js";
import worker from "../src/worker.js";
import { member, roomManifest, session } from "../tests/helpers/fixtures.js";

const ORIGIN = "https://mcp.example.test";
const KEY = "qk_names_cache";
const ROOM = "qs_worker_names";
const USER = { userId: "u_names_cache", orgId: null, plan: "pro", role: "member", label: "names@codenerd" };
const keyed = { ...env, BELLMAN_KEYS: JSON.stringify({ [KEY]: USER }) } as unknown as Parameters<typeof worker.fetch>[1];
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), keyed, ctx);

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

describe("public names through the Worker", () => {
  it("keeps a handle it has read, so one released after that read still shows on the next", async () => {
    const store = new DurableObjectStore(env as never);
    await store.createSession(session({
      id: ROOM, manifest: roomManifest({ public: true }),
      members: [member({ memberId: "m_names", userId: USER.userId, label: USER.label })],
    }));
    const auth = { authorization: `Bearer ${KEY}` };
    const claimed = await call("/account/handle", { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ handle: "names-cache" }) });
    expect(claimed.status, await claimed.clone().text()).toBe(200);
    const creator = async () => ((await (await call(`/public/rooms/${ROOM}`)).json()) as { text: { origin: { label: string } } }).text.origin.label;
    expect(await creator()).toBe("@names-cache");
    expect((await call("/account/handle", { method: "DELETE", headers: auth })).status).toBe(204);
    expect(await store.handleOf(USER.userId)).toBeUndefined();
    expect(await creator()).toBe("@names-cache");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/handles.test.ts tests/http-public.test.ts tests/http-bylines.test.ts; npm run test:worker`
Expected: FAIL. `HandleCache` is not exported; each new case that claims a handle sees `member N`; the byline cases see `as: "member 1"`; the no-label case passes its label check and FAILS its control (`@jesse`, `@gone`); in workerd, `public-names.test.ts` sees `member 1`. "asks the registry nothing" PASSES already; its control is in Step 4.

- [ ] **Step 3: Implement**

- `HandleCache` as its Interfaces line says. Each answer is `{ handle: string | null; until: number }`, `until` being `now + ttlMs` with the `now` the call was given.
- In `src/http/public.ts`, beside `labelsIn`, `memberIdsIn(value, into)`: every string under a `memberId` or `member_id` key, at any depth. Then `publicNames`, whose comment says R9 and R10:

```ts
async function publicNames(deps: PublicRouteDeps, session: StoredSession, page: unknown): Promise<Map<string, string>> {
  const labels = [...labelsIn(page)];
  if (labels.length === 0) return new Map();
  const here = new Set(session.members.map((m) => m.memberId));
  const away = [...memberIdsIn(page)].filter((id) => !here.has(id));
  const [numbers, gone] = await Promise.all([
    deps.store.publicNumbers(session.id, labels),
    away.length === 0 ? Promise.resolve([]) : deps.store.getMembers(session.id, away),
  ]);
  // The accounts the room seated under each label, among the members it holds now and those this page names.
  const accounts = new Map<string, Set<string>>();
  for (const m of [...session.members, ...gone]) accounts.set(m.label, (accounts.get(m.label) ?? new Set()).add(m.userId));
  const sole = (label: string) => { const a = accounts.get(label); return a?.size === 1 ? [...a][0] : undefined; };
  const wanted = Object.keys(numbers).flatMap((label) => sole(label) ?? []);
  const handles = deps.handles
    ? await deps.handles.handlesOf(wanted, (missing) => deps.store.handlesOf(missing))
    : await deps.store.handlesOf(wanted);
  return new Map(Object.entries(numbers).map(([label, n]) => {
    const handle = handles[sole(label) ?? ""];
    return [label, handle === undefined ? `member ${n}` : `@${handle}`];
  }));
}
```

  Add a `ponytail:` line to that comment: a departed member the page names only by label, and a label shared with a departed account the page does not name by id, are decided from the members the call can see; reading every member row per read would close both. The room read passes its deps and the session it read, and the byline's comment says `as` is the creator's name (ADR 0023), which can be the cached one for the hour after a change, so the page's relabel shows `by.handle` there. The module's header comment says members are named by the handle their account claimed, kept an hour where the Worker serves the read, or by number, never by label.
- `src/worker.ts`: a module-level `const handleNames = new HandleCache();` beside `suspensions`, with a comment (per isolate, spec D5), passed as `publicRoutes(request, { store, blobs, handles: handleNames })`. The Node app passes none (R24).

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/handles.test.ts tests/http-public.test.ts tests/http-bylines.test.ts && npm run test:worker`
Expected: PASS. For the control of "asks the registry nothing", add `await sends(PUB, member())` before its read, see it fail, then take the line out. For the race case's control, give `HandleCache` the time after `read` returns instead, see the case fail at `T0 + HANDLE_CACHE_MS`, then put it back.

- [ ] **Step 5: Commit**

```bash
jj commit -m "Public reads name each member by the handle their account claimed, kept an hour per isolate, else by number"
```

### Task 12: bellman.sh is a panel origin

**Files:**
- Modify: `wrangler.toml` (`BELLMAN_PANEL_ORIGINS` and its comment), `src/oauth/browser.ts` (the comment on `csrfRefusal`), `tests/helpers/panel.ts`
- Test: `tests/browser-safety.test.ts`, `tests/panel-session.test.ts`

**Interfaces:**
- Produces: `productionPanelOrigins(): string[]` in `tests/helpers/panel.ts`: `BELLMAN_PANEL_ORIGINS` as `wrangler.toml` sets it, matched by `/^BELLMAN_PANEL_ORIGINS = "([^"]*)"$/m`, through `parsePanelOrigins`, throwing when the line is missing.

- [ ] **Step 1: Write the failing tests**

`tests/browser-safety.test.ts`, in `describe("parsing BELLMAN_PANELS")`, with `productionPanelOrigins` added to the file's import from `./helpers/panel.js`:

```ts
  // Public rooms on bellman.sh (spec section 1): the page there posts with the cookie. The dash stays first: it is where
  // a sign-in with nowhere usable to return to lands.
  it("admits the dash and bellman.sh as wrangler.toml deploys them, the dash first", () => {
    const origins = productionPanelOrigins();
    expect(origins).toEqual(["https://dash.bellman.sh", "https://bellman.sh"]);
    const post = from("https://bellman.sh", "POST");
    expect(allowedOrigin(post, origins)).toBe("https://bellman.sh");
    expect(csrfRefusal(post, "cookie", allowedOrigin(post, origins))).toBeUndefined();
  });
```

`tests/panel-session.test.ts`, in `describe("signing in to the panel")`, with `productionPanelOrigins` imported from `./helpers/panel.js`:

```ts
  // Public rooms on bellman.sh (spec section 1): "Sign in to report" on a room's page comes back to the room.
  it("returns a sign-in started on a public room's page to the room, with the origins wrangler.toml deploys", async () => {
    cfg.panelOrigins = productionPanelOrigins();
    expect((await signIn("https://bellman.sh/r/open-review")).headers.get("location")).toBe("https://bellman.sh/r/open-review");
    expect((await signIn()).headers.get("location")).toBe("https://dash.bellman.sh");
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/browser-safety.test.ts tests/panel-session.test.ts`
Expected: FAIL. The origins are `["https://dash.bellman.sh"]`, and the sign-in returns to `https://dash.bellman.sh`.

- [ ] **Step 3: Implement**

- `wrangler.toml`: `BELLMAN_PANEL_ORIGINS = "https://dash.bellman.sh, https://bellman.sh"`. The comment above it gains: bellman.sh is where the dash's Worker serves the public room pages, which post with the session cookie and to which a sign-in started there returns; the dash stays first, the destination of a sign-in with nowhere usable to return to.
- `src/oauth/browser.ts`, the paragraph of `csrfRefusal`'s comment that begins "SameSite=Lax is not sufficient on its own" becomes:

```
 * SameSite=Lax is not sufficient on its own, which is why this exists: SameSite
 * is evaluated on the registrable domain, so every bellman.sh host is same-site
 * with mcp.bellman.sh, and Lax lets a POST from any of them carry the session
 * cookie. This admits only the listed origins. https://bellman.sh is one of
 * them, for the public room pages the dash's Worker serves there, so a script
 * on any bellman.sh page, the static site's included, passes this check: no
 * page there may run a script its repo did not ship.
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/browser-safety.test.ts tests/panel-session.test.ts && npm run typecheck:worker && npx wrangler deploy --dry-run --outdir "$(mktemp -d)"`
Expected: PASS, and the dry run lists `BELLMAN_PANEL_ORIGINS` with both origins.

- [ ] **Step 5: Commit**

```bash
jj commit -m "bellman.sh is a panel origin, for the public room pages there: their signed-in posts and their sign-in return"
```

### Task 13: The tool texts

**Files:**
- Modify: `src/tools/start.ts`, `src/tools/public-name.ts`, `src/tools/connect.ts`
- Generated: `docs-site/src/content/docs/reference/tools/bellman_start.md`, `bellman_public_name.md`, `bellman_connect.md`, by `npm run docs:gen`
- Test: `tests/public-rooms.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/public-rooms.test.ts`:

```ts
describe("the tools' words for a public room (public rooms on bellman.sh spec)", () => {
  it("put the page on bellman.sh, and name members by the public handle their account claimed, or by number", async () => {
    const h = new Harness();
    try {
      const jesse = await h.connect(DEV_KEY.jesse);
      const text = Object.fromEntries((await jesse.listTools()).tools.map((t) => [t.name, t.description ?? ""]));
      expect(text.bellman_public_name).toContain("bellman.sh/r/<name>, which until then is bellman.sh/r/<session_id>.");
      expect(text.bellman_start).toContain("- public_name: a public room's name in its link, bellman.sh/r/<public_name> (needs public: true).");
      expect(text.bellman_start).toContain("with each member named by the public handle their account claimed, or by number;");
      expect(text.bellman_connect).toContain("with each member, you included, named by the public handle their account claimed, or by number, and never a brief");
      expect(Object.values(text).join("\n")).not.toMatch(/dash\.bellman\.sh\/r|named by number/);
    } finally {
      await h.close();
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/public-rooms.test.ts -t "the tools' words"`
Expected: FAIL on the first `toContain`.

- [ ] **Step 3: Implement**

- `src/tools/public-name.ts`: the description's first sentence becomes `Check or set the name in a public room's link, bellman.sh/r/<name>, which until then is bellman.sh/r/<session_id>.`
- `src/tools/start.ts`: in the `public_name` line, `dash.bellman.sh/r/<public_name>` becomes `bellman.sh/r/<public_name>`; in the `public: true` paragraph, `with members named by number;` becomes `with each member named by the public handle their account claimed, or by number;`.
- `src/tools/connect.ts`: `with members named by number and never a brief` becomes `with each member, you included, named by the public handle their account claimed, or by number, and never a brief`.
- Run `npm run docs:gen`.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/public-rooms.test.ts tests/docs-reference.test.ts tests/extension.test.ts`
Expected: PASS. `tests/docs-reference.test.ts` fails until `docs:gen` has run; `extension/manifest.json` names tools, not their texts, and no tool was added.

- [ ] **Step 5: Commit**

```bash
jj commit -m "The tool texts put a public room's page on bellman.sh, and name its members by their public handle, or by number"
```

### Task 14: The docs, ADR 0023, and the whole suite

**Files:**
- Create: `docs/adr/0023-public-rooms-on-bellman-sh.md`
- Modify: `docs/adr/0011-public-rooms.md`, `docs/adr/0021-bylines.md` (status lines), `README.md`, `docs-site/src/content/docs/guides/public-rooms.md`, `plugin/skills/room-manifest/SKILL.md`, `docs/ARCHITECTURE.md`

- [ ] **Step 1: ADR 0023**

```markdown
# ADR 0023 — Public rooms are read at bellman.sh, and name members by their handle

**Date:** 2026-10-17 · **Status:** accepted · **Amends:** ADR 0011, decisions 3 and 5; ADR 0021, decisions 2 and 4 · **Spec:** `docs/superpowers/specs/2026-10-17-public-rooms-on-bellman-sh-design.md` · **Plan:** `docs/superpowers/plans/2026-10-17-public-rooms-on-bellman-sh.md`

## Context

A public room's page was `dash.bellman.sh/r/<room>`, a single-page app with one head for every room, so a pasted link previewed as "Bellman dash" and a crawler that runs no script read nothing. Members were named by number (ADR 0011), and a signed room's creator by a handle (ADR 0021), so a handle someone claimed named them in the rooms they signed and nowhere else, and a changed or released handle was free for anyone at once.

## Decision

1. **The page is `bellman.sh/r/<room>`, served by the dash's Worker** (spec D1). A route on the `bellman.sh` zone runs before the site's Worker, which holds `bellman.sh` as a Custom Domain. `PUBLIC_ROOM_URL_BASE` is `https://bellman.sh/r/`, and `dash.bellman.sh/r/*` answers 301 to the same path there.
2. **The Worker writes each room's head and a summary** (D2, D4): the title, the description, Open Graph tags and a summary card, a canonical link, and in the body the room's name, byline, purpose and the names in its newest events, through `HTMLRewriter` as text and attribute values. It keeps the public reads it makes at most a minute.
3. **A member is named by the handle their account claimed, else by number** (D3). `publicNames` in `src/http/public.ts` resolves each label to the accounts the room seated under it, and one account holding a handle is `@handle`. `by.as` is the creator's name.
4. **Names are kept an hour, and a freed name is held 65 minutes** (D5, the owner's choice over a one-minute cache and over storing handles in each room). A viewer's page polls the log and the surface, each every 4 seconds, so a registry read per page would put up to one read every 2 seconds per viewer on `RegistryDO`, which ADR 0021's decision 4 kept polls off. The Worker keeps each account's handle, or that it has none, for `HANDLE_CACHE_MS`, an hour, per isolate, in front of the exact `handlesOf`. Without a hold, a page could show the old holder's messages under a name another account had just claimed. So a name freed by a release, a change or the operator's release is held for `HANDLE_HOLD_MS`, the hour plus five minutes, from every account, its last holder included: longer than the hour plus the minute the dash's preview cache adds.
5. **`https://bellman.sh` is a panel origin,** for the page's signed-in posts and its sign-in return.

## Consequences

- A claimed handle names its holder in every public room they are or were in, not only the ones they signed.
- A new handle can take an hour to appear on public pages, and a released one an hour to go.
- A released name can't be claimed by anyone for 65 minutes, so someone whose handle an operator took back from an impersonator waits that long to claim it, and a holder cannot undo an operator's release.
- Every page on bellman.sh, the static site's included, can make a cookie-authenticated write to the API.
- A label two accounts were seated under stays a number, whatever either claimed.
- The sandbox frame names the dash and bellman.sh as its parents, and is deployed by hand (`npm run deploy:sandbox` in the dash).
- A link at `dash.bellman.sh/r/<room>` keeps working while the 301 does, and `run_worker_first` is what keeps it for a browser's navigation.
```

ADR 0011's status becomes `accepted; decisions 3 and 5 amended by ADR 0023`; ADR 0021's `accepted; decisions 2 and 4 amended by ADR 0023`.

- [ ] **Step 2: README, the docs site and the skill**

- `README.md`, the public rooms item:
  - "Members are named there by number, `member 1` and on, never by the label they signed in with, which for most is an email address." becomes "A member whose account has claimed a handle is named there by it, `@handle`, and every other member by number, `member 1` and on; never by the label they signed in with, which for most is an email address. A new or released handle reaches those pages within the hour, and a released or changed-away handle is held 65 minutes from every account before anyone can claim it."
  - "Readers open it at `dash.bellman.sh/r/<id>`." becomes "Readers open it at `bellman.sh/r/<id>`, which the dash's Worker serves with the room's name and purpose in the page's head for link previews; a link at `dash.bellman.sh/r/<id>` answers 301 there."
  - "makes its link `dash.bellman.sh/r/<name>`" becomes "makes its link `bellman.sh/r/<name>`".
- `docs-site/src/content/docs/guides/public-rooms.md`:
  - In "What a reader sees", `dash.bellman.sh/r/<id>` becomes `bellman.sh/r/<id>`, and "a join shows only the joiner's member id, number and seat" becomes "a join shows only the joiner's member id, public name and seat".
  - The paragraph that begins "Members are named by number" becomes: "Each member is named by the handle their account claimed, `@handle`, and a member with no handle by number, `member 1` and on, in the order they joined. Nobody is named by the label they signed in with, which for most people is an email address. One person's seats share a name. Claiming a handle names you by it in every public room you are in or were in, not only in the rooms you signed. A new or released handle can take up to an hour to show on public pages. A handle you release or change away from is held for 65 minutes, from everyone, you included, and then anyone can claim it."
  - The paragraph after it becomes: "A closed public room keeps reading at `bellman.sh/r/<id>` until it is deleted. A link pasted into Slack or X shows the room's name and purpose. A link from before the page moved, `dash.bellman.sh/r/<id>`, redirects to the same room on `bellman.sh`."
  - In "A public name", both `dash.bellman.sh/r/` in its first paragraph become `bellman.sh/r/`, as does the one in its last.
- `plugin/skills/room-manifest/SKILL.md`, "A public room": "Readers see members by number, not by how they signed in." becomes "Readers see each member by the handle their account claimed, or by number, never by how they signed in.", wrapped as the file wraps.

- [ ] **Step 3: ARCHITECTURE**

- The "**A public room**" paragraph: "every public read then names each member by number (`member 1` and on) wherever a `label` holds theirs" becomes "every public read then names each member wherever a `label` holds theirs: by the handle their account claimed (`@handle`, from one `handlesOf` read of the registry's `uh:` rows behind the Worker's per-isolate `HandleCache`, which keeps each account's answer an hour), or by number (`member 1` and on). A name freed by a release, a change or the operator's release is held 65 minutes from every account (`hh:` rows, `HANDLE_HOLD_MS`), longer than any page can still show it under its old holder (ADR 0023)"; "Dash renders it at `/r/<id>`, outside sign-in." becomes "The dash's Worker serves the page at `bellman.sh/r/<id>`, by a route that runs before the site's Worker, writing the room's head and a plain summary for link previews and crawlers, and answers `dash.bellman.sh/r/*` with a 301 there."; "where `as` is the creator's number, which the page swaps for `@handle`" becomes "where `as` is the creator's name, `@handle` since ADR 0023, or the cached one for the hour after a change, which the page shows as `by.handle`".
- The invariant "**The control panel holds a cookie, not a token**" gains a last sentence: "Its origins are `BELLMAN_PANEL_ORIGINS`: the dash, and `https://bellman.sh`, where the dash's Worker serves the public room pages, so a script on any bellman.sh page, the static site's included, can make a cookie-authenticated write (ADR 0023)."
- §11, "What connecting costs": re-measure the tool definitions, then put the total in the row and a paragraph above the newest "Re-measured" one, saying what changed: "Re-measured on <date> for public rooms on bellman.sh, by the method below: <n> tokens over the <m> that main (`<commit>`) measures. `bellman_start` is <a> to <b>, `bellman_connect` <c> to <d> and `bellman_public_name` <e> to <f>, for the page's host and for members named by their public handle. No other tool changed. That is <total>." The figures come from the measurement. The method, which nothing in the repo runs: in a scratch directory with `node_modules` symlinked to a checkout's, a `.mts` script run with that checkout's `node_modules/.bin/tsx` imports its `src/auth.ts`, `src/server.ts`, `src/store.ts` and `src/blobs.ts`, builds the server for `qk_dev_jesse` with `hostedSeat: true` as `tests/helpers/harness.ts` does, lists the tools over `InMemoryTransport` and prints them; `python3.13` with tiktoken's `cl100k_base` counts `json.dumps(entry, separators=(",", ":"))` for each and sums them. Measure `main` first as the control, and compare with its own figure, not the row's.

- [ ] **Step 4: The predicate, and everything**

Run:
```bash
rg -n --hidden -g '!node_modules' -g '!.jj' -g '!docs/superpowers/**' 'dash\.bellman\.sh(/|</code>/)r\b' .
npm run verify
npx wrangler deploy --dry-run --outdir "$(mktemp -d)"
```
Expected: the predicate prints only the 301 sentences in `README.md`, `docs-site/src/content/docs/guides/public-rooms.md`, `docs/ARCHITECTURE.md` and `docs/adr/0023-public-rooms-on-bellman-sh.md`, and decision 3 of `docs/adr/0011-public-rooms.md`; `verify` passes; the dry run passes.

- [ ] **Step 5: Commit**

```bash
jj commit -m "ADR 0023, and the README, the docs site, the skill and ARCHITECTURE put public rooms on bellman.sh and name members by handle"
```

### Part 2's review and PR

- [ ] **The whole-branch review:** one reviewer over the branch's diff from `trunk()`, with this plan and the spec. Fix what it finds, with tests, before the PR.
- [ ] **The PR.** Read the diff's stat against the files these tasks list, set the bookmark, push and open it. The body says, out loud: `https://bellman.sh` joins the panel origins, so every page on bellman.sh, the static site's included, can make a cookie-authenticated write; a handle reaches public pages within the hour; and a released or changed-away handle is held from every account, its last holder too, for 65 minutes, which an operator's release also starts.
- [ ] **After the merge:** read the deploy job. Then `curl -s https://mcp.bellman.sh/public/rooms/<a public room>/events` names a member who holds a handle by it, `bellman_start` with `public: true` returns a `public_url` on `https://bellman.sh/r/`, and a PUT of a handle just released answers 409 with the hold's words.

---

# Part 3 — the dash's and the site's text (two PRs, after Part 2 is deployed)

Both say what Part 2 made true, so neither lands before it deploys.

### Task 15: The dash's Settings say what a handle names, and how long a freed one is held

The dash checkout as in Part 1, on a new branch from `origin/main`.

**Files:**
- Modify: `src/components/settings/handle-section.tsx`
- Test: `src/components/settings/handle-section.test.tsx`

- [ ] **Step 1: Write the failing tests**

- "says what the public page lists and what a change frees, naming the page as it is when %s", renamed "says what a handle names, what the public page lists, and how long a freed handle is held, naming the page as it is when %s", expects:

```ts
    expect(description).toHaveTextContent("Claim a handle and every public room you are in, or were in, shows your messages under it, never your sign-in label.");
    expect(description).toHaveTextContent(
      `A page at ${page} lists the rooms you signed. Releasing a handle unsigns every room. A handle you release or change is held for 65 minutes, from everyone, you included, before anyone can claim it, and public pages can take up to an hour to show a change.`,
    );
```

- The release question's case expects `screen.getByText("Every room you signed is unsigned, and @ada is held for 65 minutes before anyone can claim it.")`.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/components/settings/handle-section.test.tsx`
Expected: FAIL on both texts.

- [ ] **Step 3: Implement**

- The paragraph under "Public handle": "Claim a handle and every public room you are in, or were in, shows your messages under it, never your sign-in label. Sign a public room you created and it also shows "by @handle". A page at {page} lists the rooms you signed. Releasing a handle unsigns every room. A handle you release or change is held for 65 minutes, from everyone, you included, before anyone can claim it, and public pages can take up to an hour to show a change."
- The release question: "Every room you signed is unsigned, and @{handle} is held for 65 minutes before anyone can claim it."
- The header comment: claiming a handle names the person by it in every public room they are or were in (public rooms on bellman.sh spec, D3). The comment on asking twice: a freed handle is held 65 minutes and then anyone can claim it, so it cannot be taken back.

- [ ] **Step 4: Run them and watch them pass**

Run: `npm test && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/handle-section.tsx src/components/settings/handle-section.test.tsx
git commit -m "Settings say a handle names you in every public room you are in, and that a freed one is held 65 minutes"
```

### Task 16: The privacy policy and the terms name members by handle, and state the hold

The site's checkout is `~/src/github.com/bellman-sh/site`, on a branch or a worktree from `origin/main`. Its checks are `node --test tools/worker.test.mjs` and `python3.13 -m unittest discover -s tools -p 'test_*.py'`; the default `python3` here is 3.11, which the tools refuse. Regenerating the generated pages must change nothing: `for t in build-pricing build-compare build-stories; do python3.13 tools/$t.py; done; python3.13 tools/sitenav.py; git status --porcelain`.

**Files:**
- Modify: `public/privacy.html`, `public/terms.html`

- [ ] **Step 1: Read what each page says now**

Run: `rg -n 'by number|byline|handle' public/privacy.html public/terms.html`
Expected: `privacy.html`'s "Anyone with a public room's link" and "Anyone, for a byline you choose to add" items, its "Public handles" item under how long things are kept, and `terms.html`'s paragraph of section 4 on public rooms.

- [ ] **Step 2: The privacy policy's two items**, in "Who else sees it", replace the two:

```html
  <li><strong>Anyone with a public room's link</strong>, when the room's creator made it
      public: its canvas and its log, with each member shown by the handle they claimed, or
      by number if they have none. Briefs and the label you sign in with, usually your email
      address, are never shown. A creator can make a public room private, and it cannot be
      made public again.</li>
  <li><strong>Anyone</strong>, for a handle you choose to claim. Once you claim one, every
      public room you are in, or were in, names you by it. If you also sign a public room
      you created, the room shows "by @yourhandle", and a page at your handle lists the
      public rooms you signed and when you signed each. Unsign a room and its byline is
      gone. Release your handle in Settings, or change it, and within an hour public rooms
      stop showing it; the old handle is then held for 65 minutes, from everyone, you
      included, before anyone can claim it.</li>
```

- [ ] **Step 3: The privacy policy's "Public handles" item**, under how long things are kept, becomes:

```html
  <li><strong>Public handles.</strong> A handle and its signatures are kept until you
      release the handle in Settings, and releasing it deletes both at once. The name
      itself is then held for 65 minutes, linked to no account, before anyone can claim
      it. When we delete your account, your handle goes with it.</li>
```

- [ ] **Step 4: The terms' paragraph**, in section 4, replace the one on public rooms. It describes no release, so it states no hold:

```html
<p>A room&rsquo;s creator on a paid plan can make the room public. Anyone with its link can then
read its canvas and its log without signing in, with each member shown by the handle they
claimed, or by number if they have none. A creator can also sign a public room with their
handle, and the room then names them as its author. Do not put anything in a public room you
would not publish.</p>
```

- [ ] **Step 5: The effective dates.** On both pages, `<p class="updated">Effective 12 October 2026</p>` takes the day this merges.

- [ ] **Step 6: Run the site's checks**

Run the three commands above.
Expected: the tests pass, and `git status --porcelain` lists `public/privacy.html` and `public/terms.html` alone.

- [ ] **Step 7: Commit**

```bash
git add public/privacy.html public/terms.html
git commit -m "The privacy policy and the terms name each member by the handle they claimed, and the policy states a freed handle's hold"
```

### Task 17: The site leaves `/r/*` to the dash

**Files:**
- Modify: `README.md`, `.github/workflows/deploy.yml`

- [ ] **Step 1: The README.** After the paragraph that ends "this deployment serves `bellman.sh`.", add: "Except `bellman.sh/r/*`: a route on the zone sends it to the dash's Worker (`bellman-sh/dash`), which serves the public room pages there. A route runs before a Custom Domain's Worker, which this one is, so nothing here sees `/r/`. A change to this Worker's routing must leave `/r/*` to the dash, and the deploy checks that it does."

- [ ] **Step 2: The deploy's check.** In "Smoke test the live site", before `exit $fail`:

```bash
          # bellman.sh/r/* is the dash's Worker's, by a route that runs before this one: its page carries the dash's policy.
          check "bellman.sh/r/ is the dash's" \
            "$(curl -sI --max-time 30 https://bellman.sh/r/no-such-room | tr -d '\r' | grep -ci '^content-security-policy:.*script-src https://dash.bellman.sh;')" \
            "1"
```

- [ ] **Step 3: Run it by hand against the live site**

Run the `curl` in Step 2 on its own.
Expected: `1`, once Part 1 is deployed; before that, `0`.

- [ ] **Step 4: Commit**

```bash
git add README.md .github/workflows/deploy.yml
git commit -m "The site's README says bellman.sh/r/* is the dash's, and each deploy checks it still is"
```

### Part 3's review and PRs

- [ ] **The whole-branch reviews:** one reviewer over each repo's `git diff origin/main...HEAD`, with this plan and the spec.
- [ ] **The PRs,** after Part 2 is deployed, since their text is true only then, and soon after it: until they merge, the dash's Settings say a freed handle is free at once and the privacy page says members are shown by number. Read each diff's stat first. After the merges, read each deploy job, the site's smoke test included.
