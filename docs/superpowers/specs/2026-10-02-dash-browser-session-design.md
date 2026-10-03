# A Browser Session for Dash — Design

Status: designed, not implemented. Plan:
`docs/superpowers/plans/2026-10-02-dash-browser-session.md`
Closes: #48
Related: #7 (the authorization server this builds on), #61 (where operator
authority lives — three of its constraints are acceptance criteria here), #49
(the HTTP API that will be the first real consumer), #36 (the same problem from
the CLI side), #23 (open client registration).
Citations: by symbol rather than line, and of the code as it stood when this was
written.

## Problem

`dash.bellman.sh` — the control panel — cannot hold a bearer token.

It is a static SPA in a browser, and it renders billing and provider keys. A
token in web storage on that page turns any XSS into account takeover. A token
the page cannot read turns the same bug into a much smaller incident. So the
panel needs a credential it never sees: an `HttpOnly` cookie, set and verified by
the Worker.

Nothing issues or verifies one today. `GET /account` already answers JSON when
`Accept: application/json`, and already carries nearly everything the panel's
account screen needs — user, plan, role, org, plan source, entitlements, usage
against `monthlyCreates`. It has no way to authenticate a browser, so in a
browser it returns a bare 401 with `WWW-Authenticate`. There is also no CORS
handling anywhere in `src/worker.ts`, no CSRF story (bearer auth needed none),
and no sign-out (rotating refresh tokens have a revocation path; a browser
session has nothing).

This is the one thing blocking the panel from doing anything at all.

## Decisions

Four, taken before the design because each one changes the shape of the rest.

### 1. The panel and the API stay on separate origins of the same site

`dash.bellman.sh` serves the SPA from Cloudflare Pages. `mcp.bellman.sh` serves
the API from the Worker, as it does now.

Those are **same-site and cross-origin**, and the distinction decides two
different things:

- **SameSite** is evaluated on the registrable domain. Both hosts are
  `bellman.sh`, so a request from the panel to the API is a same-site request and
  `SameSite=Lax` sends the cookie on it. `SameSite=None` is not needed.
- **CORS** is evaluated on the origin. The origins differ, so a CORS allowlist
  with `Access-Control-Allow-Credentials` and preflight handling is mandatory.

The rejected alternative was putting the API on `dash.bellman.sh/api/*` so that
both are same-origin and CORS disappears entirely. It is the smaller attack
surface, and it was rejected because it gives the Worker a second hostname —
which collides with a deliberate existing property. `oauthConfig` in
`src/worker.ts` derives `issuer` and `resource` from the request's own origin,
and its comment states the intent: *a token minted for mcp.bellman.sh is not
accepted on any other hostname this Worker answers.* Keeping the API on one
hostname leaves that untouched.

#### The cookie does not need a `Domain`

The cookie is set by the Worker and sent to the Worker. The panel never reads it
— that is the entire point of `HttpOnly`. So the cookie only ever needs to
travel to `mcp.bellman.sh`, which makes it **host-only**: no `Domain` attribute
at all.

`Domain=.bellman.sh` would also work and is strictly worse. It sends the session
cookie to every subdomain of the zone, including the marketing site at
`bellman.sh` and every subdomain added later. Host-only costs nothing and keeps
the cookie's reach to the one host that can use it.

A host-only cookie is still sent on the panel's cross-origin fetches, because
the cookie jar is keyed by the request's **target** host, not by the origin of
the page making the request.

### 2. The session is an opaque id over a stored record, not a signed token

The cookie holds 32 random bytes. The record lives in `AuthDO`.

The alternative — a signed JWT cookie, reusing `signJwt`/`verifyJwt` with a new
audience — is less code and needs no storage read. It was rejected because it
cannot be revoked. `src/oauth/tokens.ts` says so in its own header: access
tokens are signed rather than stored, *there is no revocation list, so a stolen
token is only good until it expires.* That is an accepted trade for a 10-minute
token on `/mcp`. It is not an acceptable trade for a browser session on a page
that renders billing, where `POST /auth/signout` has to actually invalidate
rather than clear the browser's copy and hope.

An idle timeout needs a last-used timestamp, which needs storage anyway. Having
chosen storage for that, the revocation comes free.

The cost is one Durable Object RPC per authenticated request. The panel's data
requests already reach the store, so this does not add a round trip to a path
that had none.

### 3. Seven-day ceiling, 24-hour idle timeout

`SESSION_TTL_MS = 7 days`, `SESSION_IDLE_MS = 24 hours`.

A daily user signs in about once a week. A session left on a borrowed laptop
dies within a day. Well short of `REFRESH_TOKEN_TTL_MS`, which is 30 days — the
arrangement #48 names and rejects, on the grounds that a panel showing billing
should not stay signed in for a month.

### 4. `/admin/*` stays bearer-only

Cookie authentication is accepted on `/auth/*` and `/account`. It is refused on
`/admin/*`.

`/admin/grants` gates its writes on `planSource === "operator"`. Under cookie
auth an operator would carry that, and could write grants from a browser — which
is an operator bit on the customer session, the thing #61 rules out, even though
the endpoint is itself org-scoped.

It costs nothing today: the panel has no grants screen. When #53–#58 build the
org-admin UI, that is the point to design a cookie-reachable admin surface
deliberately rather than inherit one by accident.

## Storage

New shapes in `src/oauth/storage.ts`, which is the half kept free of any Workers
import so it runs under plain Node in tests. `MemoryAuthStore` and `AuthDO` both
implement them.

```ts
export const SESSION_TTL_MS  = 7 * 24 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
/** Far below the idle window; see touchSession. */
export const SESSION_TOUCH_MS = 60 * 60 * 1000;

export interface PanelSession {
  identity: Identity;
  plan_source: string;
  /** Upstream keys, so the plan re-resolves — the same field RefreshToken carries. */
  identity_keys: string[];
  created_at: number;
  last_used_at: number;
  /** When the plan was last re-resolved. Bounded by ACCESS_TOKEN_TTL_SECONDS. */
  replanned_at: number;
  expires_at: number;
}
```

### One predicate for "dead"

```ts
export function sessionDead(
  s: Pick<PanelSession, "last_used_at" | "expires_at">,
  now: number
): boolean;
```

A session is dead past its ceiling, or idle past the window. One predicate rather
than two call sites that each decide, for the reason `hasLapsed` is one
predicate: a read and a sweep that disagree about expiry mean a session usable
only because no purge has run yet.

### Three methods on `AuthStorage`

- **`putSession(id, value)`** — create.
- **`touchSession(id, now)` → `PanelSession | undefined`** — get, test
  `sessionDead`, and bump `last_used_at`, as **one** operation.
- **`deleteSession(id)`** — sign-out.

`touchSession` is one method rather than a get and a put from the Worker because
of the pattern this repo keeps rediscovering: a check in one call and an act in
another has a window between them. `admitRegistration` is one method for exactly
this reason, and its comment says so. Inside the object, the input gate covers
the whole of it.

#### Why `touchSession` skips most writes

It rewrites `last_used_at` only when `now - last_used_at > SESSION_TOUCH_MS`.

Without that, a panel that polls writes to Durable Object storage on every
request. `markClientUsed` already declines a write that would store the value
the record holds, for the same reason.

The skip is not free, and what it costs is bounded. Idle time is measured from
`last_used_at`, which lags the last real request by up to `SESSION_TOUCH_MS`
(1 hour), so a session that goes quiet dies between 23 and 24 hours after its
last request, depending on whether that request happened to write. What holds:

- **The skip is never more permissive than writing on every request.** It can
  only end a quiet session early, by at most `SESSION_TOUCH_MS`. It never keeps
  one alive longer.
- **A session whose requests never go more than 23 hours apart cannot die of
  idleness.** That is `SESSION_IDLE_MS` minus `SESSION_TOUCH_MS`. The difference
  is the margin, not the 24-to-1 ratio: every hour added to `SESSION_TOUCH_MS`
  comes straight off it.
- **Staleness does not accumulate.** Any request more than `SESSION_TOUCH_MS`
  after the stored value writes it back, so `last_used_at` never lags a session
  in continuous use by more than that.

That reasoning is the kind that rots, so it gets tests rather than only this
paragraph. Continuous use across more than the idle window must not expire the
session; that test guards against the skip never writing, and it passes for any
`SESSION_TOUCH_MS` below the idle window, so it does not pin the margin. Two
more tests do. After a request that skipped the write, the session survives a
gap of 23 hours and dies one millisecond past it, with the 23 hours written out
so that changing either constant fails one of them.

#### Purging

Sessions are swept with the existing `sweepPage` machinery, cursored, the way
codes and refresh tokens already are.

The existing `#purge` in `src/oauth/store.ts` decides on `expires_at < now`.
Sessions need `sessionDead`, because a session can die of idleness while its
ceiling is still in the future — so the session sweep passes `sessionDead` rather
than reusing the `expires_at`-only predicate.

## The `caller` seam

`caller` in `src/oauth/routes.ts` reads only `Authorization` today. It becomes
bearer-first, cookie-second:

```ts
async function caller(request, config): Promise<{
  identity: Identity;
  planSource: string;
  via: "bearer" | "cookie";
} | null>
```

`via` is the only new information, and only the CSRF check reads it. Everything
downstream — `entitlementsFor`, the org checks, the audit writes — sees an
`Identity` and cannot tell how the caller authenticated. That is the seam #48 is
counting on: authorization logic stays in one place.

### Re-resolving the plan

The cookie branch runs `replanOnRefresh(stored.identity, stored.identity_keys,
config)` when `now - replanned_at > ACCESS_TOKEN_TTL_SECONDS * 1000`, and writes
the result back.

The bound is deliberately the same 10 minutes the access token already bounds
plan staleness to. A grant revoked mid-session cannot outlive on the panel what
it outlives on `/mcp`; there is one staleness number for the system rather than
two.

`replanOnRefresh` is the right function rather than `resolvePlan` because this
code has no provider profile — only the keys written down at sign-in. Its
existing rules then apply unchanged, and they matter here: it consults
`immutableKeys` only, so an override or grant filed against an address that has
changed hands since sign-in does not reach this session.

### What a session cannot carry

`Identity` is `{ userId, orgId, plan, role, label }`. There is no operator field
in the type, and `role: "admin"` is admin **of an org**, not of the platform.
#61's first constraint — the cookie carries tenant-scoped identity only — is
therefore satisfied structurally rather than by a check that could be forgotten.

Decision 4 closes the one place it was not: `planSource === "operator"` is
carried on the session, and `/admin/*` is the only surface that reads it, so
`/admin/*` refuses cookies.

## Routes

```
GET  /auth/signin?return_to=…    provider buttons; return_to sealed in signed state
GET  /authorize/:provider        unchanged
GET  /callback/:provider         third audience branch → finishSession
GET  /auth/session               the identity, or 401
POST /auth/signout               deletes the record, clears the cookie
```

### Reusing `/callback/:provider`

#48 proposes `GET /auth/callback`. That is a **new** redirect URI, which has to
be registered in the GitHub and Google OAuth app consoles — configuration
outside this repo, invisible to CI, and easy to miss on a fresh deploy.

`/callback/:provider` already demultiplexes on the state JWT's audience:
`STATE_AUDIENCE` for a client connecting, falling through to `UPGRADE_AUDIENCE`
for signing in to pay. Adding `SESSION_AUDIENCE` as a third branch is how
`/upgrade` was built, reuses a redirect URI both providers already have, and
needs no provider configuration at all.

`/authorize/:provider` accepts any of the three audiences, as it already accepts
two.

`/callback/:provider` needs no CORS. It is reached by a top-level navigation the
provider issues, not by a `fetch` from the panel, so no browser ever applies the
same-origin policy to it. Same for `/auth/signin`, which is a page rather than an
API. CORS is for `/auth/session`, `/auth/signout` and `/account` — the three the
panel calls with `fetch`.

### What `/auth/session` returns

The identity and nothing that costs a second store read:

```json
{ "user_id": "…", "label": "…", "plan": "free", "role": "member", "org_id": null }
```

Not the `/account` body. `/account` additionally computes `entitlementsFor` and
calls `countCreatesThisMonth`, which is a round trip to the registry object. The
panel calls `/auth/session` on every boot and every reload to decide whether to
render the app or a sign-in button, and that decision does not need usage
figures. `/account` stays the full account screen's endpoint.

Its 401 carries **no** `WWW-Authenticate`. That header exists to tell an OAuth
client where discovery starts (`unauthorizedHeaders`, RFC 9728), and a browser
cannot act on it. The panel's answer to a 401 is to show a link to
`/auth/signin`, so the header would be noise on the one path that has a human
behind it.

### `verifyState`

That audience fallback is a chain of `??` over `verifyJwt` in two places. A third
audience makes it unreadable, so it collapses into one helper:

```ts
async function verifyState(
  token: string,
  config: Pick<OAuthConfig, "issuer" | "secret">,
  audiences: readonly string[]
): Promise<{ claims: Claims; audience: string } | null>
```

Returning which audience matched is what lets the callback dispatch on it rather
than re-verify. A targeted improvement, in code this change already touches.

### `return_to` is the open redirect

It travels **inside** the signed state, so it cannot be altered during the
provider round trip. It is validated again on the way out, and the rule is exact
origin equality:

```
new URL(return_to).origin  ===  one of config.panelOrigins
```

Not a prefix test, not a suffix test, not "contains". A `startsWith` check
against `https://dash.bellman.sh` admits
`https://dash.bellman.sh.attacker.example`. Anything that fails falls back to the
first configured panel origin, rather than erroring — a sign-in that completed
should land somewhere usable.

Parsing is not validation. `new URL` succeeding tells you the string is a URL,
not that it is one we are willing to send a freshly-authenticated browser to.

### `POST /auth/signout`

Deletes the record, then clears the cookie with `Max-Age=0` and otherwise
identical attributes — a `Set-Cookie` that differs in `Path` or `Domain` does not
overwrite the original.

Idempotent: an absent, unknown or already-dead cookie still returns 204 and still
sends the clearing header. Signing out must never fail, because the user's
recourse when it does is to leave the session open.

## CORS

New field on `OAuthConfig`:

```ts
/** Origins the control panel is served from. Browser auth is refused elsewhere. */
panelOrigins?: string[];
```

Populated in `oauthConfig` from a new `BELLMAN_PANEL_ORIGINS` on `WorkerEnv`. A
**var**, not a secret: it is not sensitive, and changing which origins may hold a
session should be a reviewed commit. `wrangler.toml` already makes that argument
for `BELLMAN_BILLING`.

Applied to the three endpoints the panel reaches with `fetch` —
`/auth/session`, `/auth/signout` and `/account`. Not applied to `/mcp`: MCP
clients are not browsers, and giving them a CORS surface invites a browser to
try. Not applied to `/admin/*`, per decision 4. Not needed on
`/callback/:provider` or `/auth/signin`, which are navigations.

The rules:

- **Echo the allowlisted origin.** Never `*`. A wildcard with credentials is
  rejected by browsers anyway, and echoing an *unvalidated* origin is the classic
  CORS hole — it makes every origin trusted while looking like an allowlist.
- **`Vary: Origin` on every CORS response.** Without it a cache can serve one
  origin's `Access-Control-Allow-Origin` to a different origin.
- **`Access-Control-Allow-Credentials: true`**, or the browser discards the
  response and never sends the cookie.
- **Preflight.** `OPTIONS` answers 204 with the above plus
  `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers: content-type`
  and `Access-Control-Max-Age`. A `fetch` sending
  `content-type: application/json` is not a simple request, so every mutation
  preflights.
- **An origin not on the list gets no CORS headers at all** — not a 403. The
  browser then blocks it, which is the correct outcome, and the response says
  nothing about who is on the list.

## CSRF

One rule:

> If the request authenticated **by cookie**, and the method is not `GET`, `HEAD`
> or `OPTIONS`, then `Origin` must be present and on the panel allowlist.
> Otherwise 403.

Bearer-authenticated requests are exempt entirely. `curl` sends no `Origin` and
needs none; a browser cannot attach a bearer token cross-site without JavaScript
that already holds the token.

Why this is sufficient, and why `SameSite=Lax` alone is not:

- Browsers send `Origin` on all cross-origin requests and on every `POST`. A
  missing `Origin` on a cookie-authenticated mutation is not a browser we want to
  serve.
- `SameSite=Lax` blocks cross-**site** forgery. It does not block the
  same-**site** case, and `bellman.sh` is same-site: an XSS on the marketing site
  could otherwise POST to `mcp.bellman.sh` with the session cookie riding along.
  The `Origin` check is what closes that.

No CSRF token, no double-submit cookie, no server-side nonce. A token would add a
storage round trip and a failure mode to defend against something the `Origin`
header already answers.

## The cookie

```
Set-Cookie: bellman_session=<32 random bytes, base64url>;
            HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800
```

- **No `Domain`** — host-only, per decision 1.
- **`HttpOnly`** — the whole premise. The panel never reads this value.
- **`Secure`** when the issuer's scheme is `https:`. Conditional so that
  `wrangler dev` over `http://localhost` still works; derived from the request
  the Worker is already deriving `issuer` from, not from a separate flag.
- **`SameSite=Lax`** rather than `Strict`. `Strict` would also work for the
  panel's own fetches, since those are same-site. `Lax` additionally survives a
  cross-site top-level GET navigation back into the API — the shape
  `/upgrade/<link>` already has when Stripe returns a browser — so it leaves room
  for entry points `Strict` would silently break.
- **`Path=/`** because `/auth/session` and `/account` are not under a common
  prefix, and #49's `/api/*` will not be either.
- The id is `randomId()`, the same 256 bits of randomness authorization codes and
  refresh tokens already use.

## Testing

`tests/panel-session.test.ts`, driving the real `handleOAuth` against
`MemoryAuthStore`, with the providers stubbed at the `fetch` boundary. That is
the `tests/oauth-flow.test.ts` pattern, and everything but the upstream provider
is the real implementation.

Every assertion below is first run against a deliberately broken implementation,
and must fail there before it counts as coverage. A test that has never failed
has not been shown to test anything.

**The flow**

1. Sign-in sets `HttpOnly`, `Secure`, `SameSite=Lax`, no `Domain`, and redirects
   to an allowlisted `return_to`.
2. A `return_to` on any other origin is ignored; the redirect falls back to the
   configured panel origin. Includes the suffix case
   (`https://dash.bellman.sh.attacker.example`), which is what a `startsWith`
   check would admit.
3. `/auth/session` with no cookie is 401, and that 401 carries no
   `WWW-Authenticate`. With a live cookie it returns the identity and does not
   reach `countCreatesThisMonth` — asserted against a store that throws from it,
   so "cheaper than `/account`" is a property rather than an intention.

**Lifetime**

4. A session past `expires_at` is 401.
5. A session idle past `SESSION_IDLE_MS` but still inside `expires_at` is 401 —
   the idle window has independent effect.
6. **Continuous use across more than `SESSION_IDLE_MS` does not expire the
   session.** This is the `SESSION_TOUCH_MS` skip, and it is the assertion that
   would catch the plausible-looking version of that optimisation.

**Revocation**

7. `POST /auth/signout` makes the next `/auth/session` a 401. Signing out twice
   is still 204.
8. A grant revoked mid-session stops applying within 10 minutes, and not before
   — driving the clock, asserting both directions.

**CSRF and CORS**

9. A cookie-authenticated `POST` with no `Origin` is 403; with a non-allowlisted
   `Origin` is 403; with the allowlisted one passes.
10. A bearer-authenticated `POST` with no `Origin` passes — the exemption is real
    and is not an accident of ordering.
11. Preflight carries `Vary: Origin` and never `*`. A non-allowlisted origin gets
    no CORS headers.

**The #61 constraint**

12. `/admin/grants` refuses a cookie and accepts a bearer token, for a caller
    whose identity is otherwise identical. Decision 4, asserted rather than
    documented.

### Where the two implementations are held together

`tests/helpers/store-contract.ts` is what makes `BellmanStore` a seam rather than
a comment. `AuthStorage` has no equivalent: `MemoryAuthStore` and `AuthDO`
implement it independently, with nothing asserting they agree.

Adding three methods to two classes with no conformance suite is precisely where
they drift — and the halves that would drift here are `touchSession`'s skip
threshold and the sweep predicate, both of which fail silently in opposite
directions.

`worker-tests/` runs the real `workerd` against a separate dependency tree and
already reaches `AuthDO` (`reconcile-race.test.ts`). The session methods are
covered there, against the real object, rather than by inventing a third test
program or by trusting that two hand-written implementations match.

## Out of scope

- **The `/api/*` surface itself** is #49. This lands the credential; that lands
  what the credential reads.
- **The `dash` repo.** Worker-side only.
- **Audited operator reads.** #61's second constraint depends on #58's tamper
  evidence, which is not built. Decision 4 keeps the cookie out of the operator
  path entirely, which is what this change can do about it today.
- **`extension/manifest.json`.** No new MCP tool, so the Desktop bundle's
  declared surface is unchanged and `tests/extension.test.ts` keeps passing
  untouched. Named here because adding a tool without editing that file is a
  standing trap in this repo, and the answer "not applicable" is worth recording.

## Acceptance

From #48:

- [ ] `GET /auth/session` returns the current identity, or 401. The identity
      only — no entitlements, no usage, no second store read.
- [ ] The provider flow completes, sets the cookie, and redirects to the panel's
      intended destination.
- [ ] `POST /auth/signout` invalidates server-side and clears the cookie.
- [ ] The cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, and scoped as narrowly
      as the domain layout allows — host-only, no `Domain`.
- [ ] The cookie resolves through the same `caller` seam as a bearer token.
- [ ] CORS: an explicit allowlist, `Access-Control-Allow-Credentials`, preflight
      handling, `Vary: Origin`, never `*`.
- [ ] CSRF: `Origin` required and allowlisted on every cookie-authenticated
      mutation.
- [ ] `GET /account` answers a browser.

From #61, carried:

- [ ] **The session cookie carries tenant-scoped identity only.** No operator
      bit, no cross-tenant capability. Operator authority derives from deploy
      access — a Worker secret — not from a cookie.
- [ ] **A signed-in operator holding this cookie is indistinguishable from any
      other customer as far as the API is concerned.** Enforced by decision 4:
      `planSource` is the only operator-adjacent field on the session, and the
      only surface that reads it refuses cookies.
