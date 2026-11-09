# ADR 0049: Room apps: agent-written server code, source in Artifacts, a gate, and human-approved reach

**Date:** 2026-11-09 · **Status:** proposed · **Issue:** #430 · **Spec:** `docs/superpowers/specs/2026-11-01-room-filesystem-and-apps-design.md` (ADR B; spec decisions are cited by number) · **Spike:** `docs/superpowers/specs/2026-11-07-room-apps-spike.md` (#563)

## Context

A surface `html` item is a static page in a sandbox with no network and no data. An agent can draw a bug tracker; it
cannot build one that saves a bug. The planned route to apps (#448) waited on the whole room data layer (#380) and
ruled out server code. ADR 0046 gave rooms files at paths, and reserved `/apps/` for this ADR: until it ships, every
write there is refused `apps_not_enabled`.

The spike (#563) answered the spec's six open questions against Bellman's own Cloudflare account. Dynamic Workers and
Artifacts are both in open beta on Workers Paid; a loaded worker's `fetch()` and `connect()` both go to
`globalOutbound`; an Artifacts push whose branch moved is refused, forced or not; `Partitioned` cookies work in
Chrome 114+, Firefox 141+ and Safari 26.2+. Cloudflare does not say whether a deleted repo's snapshots are deleted.

## Decision

1. **An app is a room feature built on room files** (spec decisions 3 and 4). An agent writes the app's pages and
   server code under `/apps/<key>/` with `bellman_fs`, and publishes it by writing the room's `app` surface item for
   that key. Members open it at `https://dash.bellman.sh/a/<room>/<key>`, signed in and holding a seat. There are no
   public apps in v1. Apps are paid-only: `appsPerRoom` is 0 on `free` and 20 on paid plans (*starting values*),
   stamped on the room at creation as `appsCeiling`, and a room created before this ships gets 0.
2. **App source is one Artifacts repo per app, and Bellman makes every commit** (decisions 2, 8 source part, 17 and
   18). Each app has an `AppDO`, which takes one write at a time, commits with isomorphic-git, and pushes over Git's
   smart HTTP with a short-lived token it mints for itself (the binding has no commit method). The push names the
   head it expects; the spike saw a moved branch refused `stale ref` in all 20 races. Bellman writes the whole commit
   message: a fixed subject and the trailers `Bellman-Seat`, `Bellman-Base` and `Bellman-Change`, with no agent text.
   Then `SessionDO` records the new head and appends one `fs` event and its audit entries in one transaction. A head
   the record does not name is adopted from its trailers; a head without them marks the app `diverged` and refuses
   writes. Agents get no Git tokens, read or write.
3. **`TreeStore` is the seam for source:** read a file or tree at a version, commit against a base, log, diff, purge
   with verification. A memory implementation (tests and the Node server) and an Artifacts one (Workers only) pass one
   contract suite. A third over `fs:` rows (Alternative C) is the fallback if Artifacts fails in production, and is
   not built now.
4. **A version is named by hashes Bellman computes** (SHA-256, hex). The version hash covers the sorted lines
   `<path> <sha256 of content>`, `app.json` included; the bundle hash covers the built bundle's bytes; the capability
   hash covers the capability set as `canonical()` (`src/room/decision.ts`) writes it. Artifacts' commit SHA is stored
   beside the version hash and is never the identity.
5. **Server code runs in a Dynamic Worker, and an app's data lives in its own `AppDO`** (decisions 4, 11 and 15). The
   gate bundles the tree with `@cloudflare/worker-bundler` into R2 at `apps/<room>/<key>/<bundle hash>`, at most 5 MB.
   Serving reads that bundle, never Artifacts. The apps Worker loads it with the id
   `<room>:<app>:<version hash>:<capability hash>`, so no two apps and no two approved sets share a loaded worker.
   App code sees only Bellman's bindings, each a Bellman entrypoint bound with `{room, app, version, capability hash}`:
   - `env.DB`: the `AppDO`'s own SQLite storage, with D1's statement API. No Facets.
   - `env.ROOM`: room files and events, within an approved scope.
   - `env.AI`: model calls through Bellman's AI Gateway, metered to the room against the app's budget.

   An app holds `env.DB` or `env.ROOM`, never both, until #380. A load runs under the plan's CPU and subrequest
   limits, lowered per app; at most 4 dynamic workers run per request and 10 per Durable Object (spike, answer 2).
6. **Network is phased** (decisions 5 and 9). In phase A, `globalOutbound` refuses every `fetch()` and `connect()`
   (spike, answer 5). In phase B it is Bellman's egress Worker, which must be the apps Worker's own entrypoint, passed
   as `ctx.exports.Egress({ props })` under the `enable_ctx_exports` flag: an entrypoint of a loaded worker cannot be
   passed. It allows host, method and path-prefix entries only, refuses Bellman's own hosts, private ranges and bare
   IPs, re-checks every redirect, injects each secret only for its entry and scrubs it from responses, caps requests
   and bytes per app, and answers a refusal with a typed 403. Phase B needs #191 (secret custody) and ships to
   allowlisted users after the logs, caps and kill switches (decision 12) have run in production.
7. **`env.ROOM` acts as viewer ∩ author ∩ scope.** For each request the apps Worker replaces `x-bellman-request` with
   a token it signs (audience `bellman:apps-request`, 60 seconds, room, app, version and viewer seat id; never a user
   id). A call succeeds only if the viewer may make it, the version's author may make it, and the approved scope
   allows it. Both seats are checked live by a read gate that writes nothing, as `gateFsRead` does (`gateSeat` calls
   `touchMember`, which would mark the viewer present). Memory files follow ADR 0046's
   rule as ADR 0047 amends it, applied to the viewer and the author with no own-account exemption. `env.ROOM` never
   writes under `/members/**`, never offers `vote`, `request_actions`, `respond_actions`, `govern` or a `provision_*`
   verb, stamps each write `via: app:<key>@<version>`, passes writes through the viewer's send limit, and caps reads at
   120 a minute per app per viewer, counted in `AppDO`. Alarms get no `env.ROOM`, and there are no inbound webhooks.
8. **A viewer reaches an app through a dash-minted session.** A Run click is recorded per (app, viewer seat, approved
   set hash); no server code runs for a viewer before it. `POST /rooms/:id/apps/:key/session` accepts only a session
   cookie with a checked Origin, and returns a 5-minute, single-use assertion naming the live version. The dash frames
   `https://<app id>.<apps domain>/__bellman/enter` and hands it over by `postMessage`; the apps Worker sets
   `__Host-bellman_viewer` (HttpOnly, Secure, `SameSite=None`, `Partitioned`, 300 seconds) and the dash re-mints every
   4 minutes. Before app code sees a request, the apps Worker removes that cookie and every cookie without the
   `__Host-` prefix. It replaces the app's CSP with its own (`connect-src 'self'`, `worker-src 'none'`,
   `frame-ancestors https://dash.bellman.sh`), refuses service worker registration, and strips `Set-Cookie` with a
   `Domain`. The frame is `sandbox="allow-scripts allow-same-origin allow-forms"`. Previews run on the separate origin
   `https://p-<app id>.<apps domain>` with no `env.AI`, no `env.ROOM`, no network and a throwaway database.
   **Supported browsers** are those that keep a partitioned cookie in a third-party frame: Chrome 114, Firefox 141 and
   Safari 26.2 or later. The dash shows any other browser a page saying it cannot open room apps (spike, answer 6).
9. **The apps domain is `gettwin.xyz` for now** (decision 13). Nothing else is served on it. Code reads its name from
   one var; the literal appears only in `wrangler.toml`. It goes on the Public Suffix List before allowlisted users
   get access, and stays listed after a move.
10. **An automated gate checks every version, asynchronously** (decisions 6 and 16). `bellman_fs op:"check"` sets an
    `AppDO` alarm, which builds the bundle and runs five stages: `app.json` schema and capability rules; static checks
    on the bundle; dependencies pinned and checked against OSV; #415's secret detectors (recorded as skipped until #415
    lands); an LLM security review of the source tree, at most 100,000 input tokens. A high-severity review finding
    blocks only a version whose set holds more than the base set; for a `db`-only version it is advisory. The
    reviewer is never the boundary: the bindings, the approved record, the CSP and the egress Worker are. Findings
    are structured (`stage, rule, path, line, message, fix`) and go out in the untrusted envelope. A verdict is cached
    by (version hash, bundle hash) and records every analyzer, rule set, model and prompt version it ran.
11. **Publishing is a surface write that only the gate's verdict admits.** `normalizeSurfaceWrite` and
    `normalizeSurfaceBatch` refuse an `app` item mixed with other items or in a proposal, and every surface write path
    hands an `app` item to `publishApp`. In one `SessionDO` transaction it checks for a passing verdict on exactly
    that version and bundle hash, that the version's set is within the current approved set, and that it does not
    write to the room. Then the version is `live` and the previous one `superseded`. Otherwise it is refused
    `not_checked`, refused with the failing findings, or held `pending_approval` while the live version keeps serving.
    Rollback is a publish of an older version. Removing an `app` item is refused; an app stops through revoke or a
    kill flag.
12. **Humans approve capability sets, never commits** (decision 10). `app.json` is a request; the current approved set
    is a `SessionDO` record that the bindings and the egress Worker read. Every app starts with the base set, `db`
    alone, pre-approved. A wider set, and every version that writes to the room, needs a human: approve, deny and
    revoke go through `POST /rooms/:id/apps/:key/approval`, which accepts only a dash session cookie (bearer and agent
    tokens are refused) and acts from the account's oldest active seat whose role holds `govern`. Never through an
    action request or a vote. Revoking returns the app to the base set and stops a live version that needs more.
    Any change to the approved set asks every viewer to click Run again.
13. **Operators can stop apps without a deploy.** `BELLMAN_APPS` (default `off`) and `BELLMAN_APPS_USERS` gate apps
    by the room creator's user id, as the hosted seat's switches do. An operator route sets an app's or a room's kill
    flag in `SessionDO`; the apps Worker reads it in its one `SessionDO` read per request, and the bindings, the egress
    Worker and every alarm refuse on it. Each version keeps a log ring in its `AppDO` (200 entries of at most 2 KiB),
    read with `bellman_fs op:"logs"`, and its first server error appends one `app` event. The audit chain (ADR 0035)
    gains `app_published`, `app_approved`, `app_denied`, `app_revoked`, `app_gate` and `app_disabled`, each carrying
    hashes, never content. Caps refuse before a call runs: the `env.AI` budget, 100 checks and 200 previews per room
    per day, and `env.ROOM` rates (*starting values*).
14. **A room's purge deletes every app backend and confirms each:** app repos, `AppDO` storage, bundles, capability
    secrets and the room's `appid:` rows in `RegistryDO`. A `reposSwept` flag retries a repo delete until it reads as
    gone, as `blobsSwept` does. v1 deletes app storage only with its room. **Snapshots are assumed deleted:** a
    deleted repo is gone at once (the spike checked), but Cloudflare does not say whether or when it deletes the
    object-storage copies and snapshots it keeps. The owner ruled on 2026-11-09 to proceed as if it does. The privacy
    docs say what Bellman deletes and what it relies on Cloudflare to delete.
15. **The agent surface grows inside the token ceiling.** `bellman_fs` gains `check`, `status`, `logs` and `call`, reads
    app source at a `version`, and takes a `base` version on app writes; `bellman_send` gains the `app` surface kind. The long guide is
    the file `/.bellman/guide/apps.md`. The spec's 600-token allowance for `bellman_fs` was spent by ADR 0046's ops
    (598), and the listing stood at 11,636 of 11,840 when this was written, so these additions get at most 204 tokens
    together, re-measured when they land. If they do not fit, `call` is cut first; raising the ceiling is an owner
    decision recorded in ARCHITECTURE §11.

## Consequences

- Bellman runs code that agents wrote. The bound is the bindings, the approved record, the CSP and frame sandbox, the
  caps and the kill flags; the LLM review is a second line that an author can talk round.
- An app's code is shared across viewers, so it can show one viewer what it read for another, within viewer ∩ author ∩
  scope. A page can still reach the network through WebRTC, which CSP does not govern, so the approval screen and the
  docs say an app with `env.ROOM` can show what it reads to a viewer's browser.
- Safari 18.5 through 26.1 cannot open room apps.
- A secret written before #415's detectors land reaches Artifacts, and the docs warn authors.
- Purge rests on an assumption about Cloudflare's snapshots (decision 14). If Cloudflare says otherwise, app source
  moves to `fs:` rows behind the same `TreeStore` seam, and only that implementation changes.
- Cost for a busy app-building room is about $4 a month, most of it loaded workers, which the daily check and preview
  caps bound (spec, Cost and Scale). Artifacts billing starts 2026-11-12.
- **Rollback:** a revert while no room holds an app. After that, old code refuses `/apps/` writes again
  (`apps_not_enabled`), reads an `app` item as an unknown kind, and leaves `app:` records, repos and `AppDO` storage
  unread until the room is purged; the purge steps are never rolled back while any of them exist.

## Alternatives

B (agents push with write tokens), C (source in `fs:` rows, now the fallback), D (Postgres per room), E (D1 per room),
F (a SQLite file in the filesystem), G (a Bellman-run `DataDO`), H (client-only apps), I (egress in the first
release), J (approving every version or commit), K (approving through an action request or a vote), L (Workers for
Platforms at launch), M (deploying to members' own accounts), N (forking VibeSDK as a service) and O (an LLM review
that blocks every version) are in the spec, each with its reason. The spec also records the choices of decisions 13
and 15–18: a domain bought now, Facets, a Workflow for the gate, intent rows for attribution, and clone tokens.

## Supersedes

- #430: its out-of-scope lines for code execution and file access from `html` items.
- #448: folds into #430 as its app phase. "Server-side code out of scope" and the `bellman_data` app ops are
  withdrawn, "commits through the binding" is corrected, and per-seat Git tokens are withdrawn for v1.
- #394: its app data policy (host messages only, `appAccess`); its viewport routes stay.
- #380, decision 2: apps hold their own data until the data layer exists.
- #381, D7: amended to match.
- #392 and #393: merge into this runtime and gate.
