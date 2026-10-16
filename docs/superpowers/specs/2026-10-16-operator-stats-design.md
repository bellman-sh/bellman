# Operator stats. Design

**Date:** 2026-10-16
**Status:** approved in conversation; implementation plan to follow
**Builds on:** #258 (`countUsers`, landed in #260), and #61's revision — read-only
aggregates in the dash behind an operator flag, cross-tenant authority out
**Citations:** by symbol, of the code as it stood when this was written.

## Problem

Nothing reads the account count. #258 made a sign-in leave a record, so
`countUsers` exists in both stores, but no route returns it and no page shows
it. "How many people have signed up, and how many of them pay" has an answer in
the registry that nobody can see.

The operator surface that exists refuses to answer it from a browser, on
purpose. `/admin/grants` and `/admin/handles/:handle` both refuse a cookie
(`who.via === "cookie"` → 401) and are served no CORS, because operator
authority comes from deploy access and a session cookie is a weaker credential
for the one account whose compromise is every customer's problem rather than one
customer's. The dash is a browser, and its session cookie is `__Host-` prefixed
with no `Domain` (`sessionCookieName`, `serializeSessionCookie`), so it is
host-only to the Worker's origin and reaches nothing else.

So the read cannot go on `/admin/*` as it stands, and it cannot be proxied by
the dash either: the dash is a static assets build with no Worker script, and a
browser on `dash.bellman.sh` holds no credential that a dash Worker could read.

## Decisions

**D1. The route is `GET /operator/stats`, on the panel surface.** Not under
`/admin/*`. The two routes there write — one grants plans, one destroys a handle
and every room signed with it — and their refusal of browsers stands unamended.
This one reads three numbers and a flag. It goes where `/rooms`, `/presets` and
`/account/handle` already go: a leaf module in `src/http/`, dispatched from
`src/worker.ts` ahead of the OAuth router, with the panel's CORS, the panel's
preflight, and the same `unconfigured(env, oauth)` guard.

Naming it `/operator/stats` rather than `/panel/stats` says what the gate is.
Every route on this surface is the panel's; this is the only one not scoped to
the caller's own account.

**D2. The gate is `operators`, the same set `/admin/handles/:handle` checks.**
`parseOperators(env.BELLMAN_OPERATORS)` is already built, already on
`OAuthConfig` (`operators?: ReadonlySet<string>`), and already wired in
`oauthConfig`. The module takes it as a dep beside `panelOrigins`; no second
notion of who an operator is, and no new secret.

The check is `deps.operators?.has(who.identity.userId)`. An absent or empty set
admits nobody, matching `allowedOrigin`'s reading of an absent allowlist.

**D3. `BELLMAN_OPERATORS` lists the user id as the identity carries it.** An
operator override in `BELLMAN_USERS` can set `userId` to anything — `u_jesse`
is the case `sessionCaller` names — and this gate reads `identity.userId`, so an
override's value is the value to list. Same as the handle-release gate. A deploy
that lists the provider subject key instead matches nobody and the panel reads
403, which is the safe direction but gives no hint why; the implementation plan
carries a note to check this on first deploy.

**D4. A non-operator gets 403, with a message that names no mechanism.** The
status matches both existing operator gates. The message does not:
`/admin/grants` answers "granting plans requires a team admin" and the handle
route answers "limited to the user ids BELLMAN_OPERATORS lists", and both are
read only by someone holding a bearer token. This route is reachable by any
signed-in customer who tries the URL, so it answers `403 not_available`, "this
account has no platform stats". Naming the secret to every customer buys
nothing.

**D5. No CSRF check.** `csrfRefusal` guards writes a cookie makes. This route
has no write and answers only GET, so there is nothing for a forged request to
do. `OPTIONS` gets `preflightResponse(origin)`; anything other than GET and
OPTIONS gets `methodNotAllowed("GET", origin)`.

**D6. The response is scalars, and the type cannot hold a row.**

```ts
/** Scalars only, by type. A row cannot be expressed here (#259). */
export interface PlatformStats {
  accounts: number;
  free: number;
  paid: number;
  paidCapped: boolean;
}
```

The handler's return type is `PlatformStats`. A `userId`, an email, an `orgId`, a
label or a join code added to this response is a compile error rather than
something a reviewer has to notice. #259's constraint — the endpoint is built so
it cannot return a row — is this interface and the test in D10 that walks the
body and refuses a value that is not a number or a boolean.

If a panel ever needs a row, that is the signal to build `manage.bellman.sh`,
not to widen this.

**D7. Three numbers read, one derived.**

| Field | Source |
|---|---|
| `accounts` | `countUsers()` |
| `paid` | `listGrants(MAX_GRANTS_COUNTED)`, counted by plan |
| `free` | `accounts - paid` |
| `paidCapped` | `paid === MAX_GRANTS_COUNTED` |

No per-plan counters maintained on write. A counter incremented beside a grant
is the drift the AuthDO client count had in #122, and the registry already
answers this with one bounded read.

`free` is derived rather than counted because a free account is the absence of a
grant, and `countUsers` counts everyone. A grant held by someone who has never
signed in would make `free` negative; the handler clamps at 0 rather than
returning a negative count, and the clamp is tested.

**D8. `paidCapped` is how the ceiling tells the truth.** `listGrants(limit,
orgId?)` returns at most `limit` rows. Past it `paid` undercounts and `free`
overcounts, and nothing in the numbers would say so. `paidCapped` says so, and
the panel renders `3+` rather than a confident wrong number.

```ts
// ponytail: 1000 grants, not tuned. One grant per paying key; at three paid
// accounts this is years of headroom. paidCapped is what says when it is not.
export const MAX_GRANTS_COUNTED = 1000;
```

**D9. The module serves one path and returns `undefined` for every other.** As
`handleRoutes` does: `if (path !== PATH) return undefined`. A second route on
this prefix cannot appear by accident, and one that writes belongs on `/admin/*`
behind a bearer token.

**D10. The dash shows it, and hides it on 403.** One page, one nav entry, one
call through the existing `src/lib/api.ts` client, which already sends
`credentials: "include"` to `API_ORIGIN`. The page calls on mount; a 403 renders
nothing and hides the nav entry, so a customer who guesses the URL sees what a
wrong URL shows. No new client machinery and no second probe request — the stats
call is the probe.

## Testing

`tests/stats.test.ts`, mirroring `tests/handles.test.ts`:

- a request with no session gets 401
- a signed-in caller not in `operators` gets 403, and the body names no secret
- an empty or absent `operators` set admits nobody, including a signed-in caller
- an operator gets 200 and the four fields
- every value in the body is a number or a boolean — the guard that fails if the
  response type is widened to carry a row
- `free` is `accounts - paid`, and clamps at 0 rather than going negative
- `paidCapped` is false below the limit and true at it
- `OPTIONS` answers the preflight for an allowed origin
- `POST` gets 405
- any other path gets `undefined`, so the server carries on

The store contract needs nothing new: `countUsers` and `listGrants` are both
already covered against `MemoryStore` and `DurableObjectStore`.

The dash gets a test that the page renders the numbers, and one that a 403
leaves the nav entry absent.

## Out of scope

- **`/admin/stats`.** Not built. #259 names it and needs editing to this design.
- **Caching.** #259 proposed a minute of staleness. Four integers read by one
  person; skipped until a refresh costs something measurable.
- **An audit entry.** Reading aggregates touches no org, so there is no customer
  stream to write to. This is the platform-level operator audit gap that #61
  left open, and it stays its own issue rather than being invented here.
- **Room counts.** #259 named `roomsThisMonth` and `roomsActive`.
  `countCreatesThisMonth(userId)` is per person, so neither exists as a platform
  total. If they are wanted they are counters maintained on write, and their own
  issue.
- **More than one operator.** The gate is a set and admits as many as
  `BELLMAN_OPERATORS` lists, but nothing here manages who is on it. That stays a
  deploy-time edit.
