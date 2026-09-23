# The bridge signs in

Design for [#36](https://github.com/bellman-sh/bellman/issues/36) — self-serve
credentials for the Claude Code bridge.

## The problem

A new user of the bridge cannot start without an operator. They need a key
minted into `BELLMAN_KEYS`, the Worker redeployed, and the key pasted into their
MCP entry:

```
claude mcp add --scope user bellman -e BELLMAN_KEY=<your key> -- bellman-channel
```

#7 gave remote connectors self-serve identity, but the bridge is a local stdio
process that reads `BELLMAN_KEY` from its environment, so the path we actually
dogfood is still hand-issued keys.

After this change:

```
claude mcp add --scope user bellman -- bellman-channel
```

The first `bellman_*` call opens a browser once. Every call after that is
silent. `BELLMAN_KEY` stays supported and becomes the non-interactive path — CI,
`npm run smoke`, a headless box.

## What already exists

This is client work, not protocol work. The authorization server shipped with #7
and needs no changes:

- dynamic client registration (`POST /register`)
- loopback redirect validation — `usableRedirect` in `src/oauth/routes.ts`
  accepts `http` on `localhost`, `127.0.0.1` and `[::1]` precisely so a local
  client has somewhere to listen
- PKCE S256, and refresh tokens that rotate on every use

The MCP SDK (1.30.0) supplies the client half: `OAuthClientProvider` and
`StreamableHTTPClientTransport({ authProvider })`. Three facts from reading it
shape everything below.

1. On 401 the transport calls `auth()`, which does discovery, registers the
   client if it has no `client_id`, refreshes if it has a refresh token, and
   otherwise calls `provider.redirectToAuthorization(url)` and throws
   `UnauthorizedError`. The caller waits for the code and calls
   `transport.finishAuth(code)`.
2. `applyClientAuthentication('none', …)` puts `client_id` in the token request
   body, which is what `/token` already checks. Client and server agree as
   shipped.
3. **On refresh failure the SDK swallows network and server errors and falls
   through to a browser flow, but re-throws `invalid_grant`.** A refresh token
   that was rotated away, revoked, or lost to a race therefore throws instead of
   re-authenticating. Handling this is not optional; see
   [Failure modes](#failure-modes).

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| When does the browser open? | Lazily, on the first tool call | The bridge has no TTY and stdout is the MCP transport. Nothing extra to install or run; a session that never touches Bellman never opens a tab. |
| Concurrent bridges? | A lock file, and the loser re-reads | Refresh tokens rotate. Two processes refreshing the same token means one gets `invalid_grant`. One lock gives one browser tab and one refresh. |
| Surfacing identity? | A stderr line, plus a `bellman_whoami` tool | A room shows your label to peers, so who you signed in as is load-bearing. |
| Does the Stop hook need credentials? | No | `src/stop-hook.ts` drains the local inbox and never contacts the server. `src/channel.ts:22` is the only consumer of `BELLMAN_KEY` in `src/`. |

## Architecture

Two new modules on the Claude Code client side, beside `bridge.ts` and
`inbox.ts`. `src/oauth/` stays the authorization *server*; nothing there
changes.

```
channel.ts ──┬─ BELLMAN_KEY set ──→ connectRemote(url, key)      (bridge.ts, unchanged)
             └─ unset ───────────→ connectSignedIn(url, opts)    (signin.ts)
                                        │
                                        ├─ credentials.ts   file + lock
                                        └─ MCP SDK          discovery, DCR, PKCE, refresh
```

`src/bridge.ts` does not change. Its `remote: () => Promise<Remote>` option is
already the seam, and both connect functions return the same `Remote`.

### `src/credentials.ts`

The credential file and nothing else: read, write at mode 0600, the lock, and
the on-disk shape. No network and no OAuth, so it tests against a temp directory
with no server at all.

Location is `$XDG_CONFIG_HOME/bellman/credentials.json`, defaulting to
`~/.config/bellman/`. The directory is created 0700, the file 0600.

```json
{
  "version": 1,
  "servers": {
    "https://mcp.bellman.sh/mcp": {
      "client":   { "client_id": "…" },
      "tokens":   { "access_token": "…", "refresh_token": "…", "expires_at": 1758000000000 },
      "identity": { "userId": "u_jesse", "orgId": null, "plan": "free", "role": "member", "label": "jesse@github" }
    }
  }
}
```

Keyed by server URL so a `wrangler dev` server and production never clobber each
other's tokens.

`expires_at` is absolute milliseconds, computed on save from the SDK's relative
`expires_in`.

`identity` is the access token's `bellman` claim stored verbatim — the `Identity`
type from `src/types.ts`, camelCase and all, so there is no second shape to keep
in step. It is decoded **without verifying the signature, for display only.** It
never gates anything locally; the server verifies its own signature on every
request. The code says so at the decode site, because an unverified JWT claim
that later grows a caller who trusts it is exactly how this kind of field goes
wrong.

### The lock

`credentials.lock` beside the file, created with the `wx` flag (`O_EXCL`),
holding `{ pid, heartbeat_at }`.

**The holder heartbeats; it does not race a fixed deadline.** A plain age
threshold cannot work here: a human finishing a browser sign-in may hold the
lock for minutes, and any threshold short enough to reclaim a crashed process
promptly is short enough to evict a live one mid-sign-in — which produces
exactly the second browser tab the lock exists to prevent. So the holder
rewrites `heartbeat_at` every 15 seconds for as long as it holds the lock,
including while it waits on the human, and the lock is stale only when the PID
is gone or the heartbeat is more than 60 seconds old. A killed process stops
heartbeating and is reclaimed within a minute regardless of how long it had
been holding.

Waiters poll every 100ms for up to 6 minutes — the 5 minute browser cap plus
slack, so a waiter outlives the longest legitimate hold rather than giving up
while someone is still typing a password.

The loser re-reads rather than retries. That is the whole reason there is one
browser tab:

```
P1  lock → no tokens → browser → write → unlock
P2  lock (waited)    → re-read → tokens present → use them, no browser
P3  lock (waited)    → re-read → tokens present → use them, no browser
```

and the same shape on refresh:

```
P1  lock → refresh → write new → unlock
P2  lock → re-read → access token is fresh → skip the refresh entirely
```

The lock wraps the whole `connect()`, not just the file write, because the SDK
calls `tokens()` and `saveTokens()` at points the caller does not choose.

If the wait elapses without the lock, re-read once more: usable tokens mean
proceed, nothing usable means fail with a message naming the lock file, so a
genuinely stuck lock is something a human can delete.

### `src/signin.ts`

The `OAuthClientProvider` implementation, the loopback listener, the browser
opener, and `connectSignedIn(url, opts)`.

**The redirect port is fixed, not ephemeral.** `/authorize` requires an exact
match against a registered `redirect_uri` (`routes.ts`, the
`client.redirect_uris.includes(redirectUri)` check), so a port that changes
between runs would break every re-authentication. Registration therefore claims
a small fixed range once:

```
http://127.0.0.1:51004/callback … http://127.0.0.1:51008/callback
```

and the listener binds the first free one, trying them in ascending order. Five
is enough: concurrent bridges serialize on the lock, so a busy port means some
other application, not another bridge.

The listener must be bound **before** `connect()`, because the SDK reads
`provider.redirectUrl` before it calls `redirectToAuthorization`. Returning
`undefined` there is not a no-op — the SDK treats a missing `redirectUrl` as a
non-interactive flow and takes a different path.

The flow:

1. Take the lock. Read credentials.
2. Bind a loopback port. If all five are busy but the cached access token is
   still unexpired, skip the auth provider and connect with a plain bearer
   header — degraded, but a busy port should not block a user who already has a
   working token.
3. `client.connect(transport)`. The SDK does discovery, registers the client if
   there is no `client_id`, and refreshes if there is a refresh token.
4. On `UnauthorizedError`: open the browser, await the code on the loopback
   (5 minute cap), `transport.finishAuth(code)`, reconnect.
5. On `invalid_grant`: clear the stored tokens and retry from step 3, **once.**
6. Write credentials. Close the listener. Release the lock. Log
   `signed in as <label>` to stderr.

`BELLMAN_NO_BROWSER=1` prints the authorization URL to stderr instead of
launching a browser — SSH, headless boxes, and the manual test path.

The loopback responds to the callback with a small HTML page telling the human
to close the tab, then stops listening. It answers exactly one request.

## Failure modes

| Failure | Behavior |
| --- | --- |
| Refresh token rotated away by a racing process | `/token` returns `invalid_grant`; the SDK **re-throws** rather than falling back. `signin.ts` catches it, clears tokens, and re-runs the flow once. Without this the user sees a hard error where they should see a browser tab. |
| Refresh token expired or revoked | Same path: cleared, browser opens. |
| Authorization server unreachable | The SDK swallows it and falls through to the browser flow, which also fails. Surfaces as a failed tool call with the underlying message; the bridge's existing backoff covers the watcher. |
| All five loopback ports busy | Unexpired access token → connect without the provider. Otherwise fail naming the port range. |
| Human never finishes the browser flow | The 5 minute cap elapses; the tool call fails, the listener closes, the lock releases. The next call starts clean. |
| Stale lock from a killed process | The heartbeat stops; PID is gone or the heartbeat is over 60s old → reclaimed. A live holder waiting on a human keeps heartbeating and is never evicted. |
| A waiter's 6 minute poll elapses | Re-read once more: usable tokens → proceed; nothing usable → fail with a message naming the lock file, so a genuinely stuck lock is something a human can delete. |
| Credential file corrupt or unreadable JSON | Treated as absent, and a stderr line says so. Fail-closed would strand the user with no way back but to find and delete a file; a fresh sign-in costs one browser tab. |

## Configuration

| | Behavior |
| --- | --- |
| `BELLMAN_KEY` set | Exactly today. Static bearer header, no credential file, no listener, no lock. CI, `npm run smoke`, headless. |
| `BELLMAN_KEY` unset | Sign in, cache under `~/.config/bellman/`. |

`BELLMAN_KEY` wins when both a key and a cached credential exist: an explicitly
set environment variable is a deliberate act.

`channel.ts` stops calling `process.exit(1)` when the key is missing.

New variables: `BELLMAN_NO_BROWSER` (print the URL instead of launching), and
`XDG_CONFIG_HOME` is honored for the credential directory.

## `bellman_whoami`

A local tool the bridge adds under both deliveries — the `bellman_wait`
precedent, which `bridge.ts` already adds under hook delivery. It answers from
the cached claim with no round trip:

```json
{ "label": "jesse@github", "plan": "free", "role": "member", "org_id": null, "source": "oauth" }
```

Snake_case at the tool boundary, matching `session_id` and `member_id` on every
other tool; `credentials.ts` stores the claim's camelCase verbatim and
`bellman_whoami` maps it at the edge.

Under `BELLMAN_KEY` it returns `{ "source": "env", "label": null }`. The bridge
genuinely cannot know the identity behind a static key, and saying so is better
than guessing.

## Testing

`handleOAuth` is already a pure `Request → Response` — that is how
`tests/oauth-flow.test.ts` drives it — and `StreamableHTTPClientTransport` takes
a `fetch` override used for *all* network requests, auth included. So the tests
route the SDK client's fetch straight into the real `handleOAuth`: the real
client against the real authorization server, in process, no network and no
mocked protocol. Same instinct as `tests/helpers/store-contract.ts` — test
against the real thing, or the seam is a comment.

**`tests/credentials.test.ts`** — no server involved.

- round-trips a credential, and the file is mode 0600
- two server URLs do not clobber each other
- a second holder waits, then re-reads what the first one wrote
- a lock whose PID is dead is reclaimed
- a lock whose heartbeat is stale is reclaimed
- **a live holder that keeps heartbeating is not reclaimed, however long it
  holds** — the regression test for the eviction-mid-sign-in bug
- corrupt JSON reads as absent rather than throwing

**`tests/signin.test.ts`** — SDK client against `handleOAuth`.

- a first sign-in registers a client, and a second run reuses the stored
  `client_id` instead of registering again
- PKCE round-trips: the code the loopback captures exchanges successfully
- an expired access token refreshes without opening a browser
- `invalid_grant` on refresh clears tokens and re-runs the flow rather than
  throwing
- two concurrent `connectSignedIn` calls open **one** browser and both end up
  with working tokens
- `BELLMAN_NO_BROWSER=1` prints the URL and launches nothing

**`tests/bridge.test.ts`** — extend the existing file.

- `bellman_whoami` reports the cached identity under OAuth
- `bellman_whoami` reports `source: "env"` under `BELLMAN_KEY`

## Documentation

`README.md` drops `-e BELLMAN_KEY=<your key>` from the `claude mcp add` lines
and describes the sign-in instead, keeping `BELLMAN_KEY` documented as the
non-interactive path.

`src/channel.ts`'s header comment gains the new variables.

## Out of scope

- **#24, self-serve plans.** Anyone who signs in lands on whatever
  `identityFor` gives them. Self-serve credentials without a self-serve plan
  moves the manual step rather than deleting it, but that is #24's problem.
- **#23, rate limiting registration.** Self-registering bridges make open client
  registration busier. The fixed redirect range and the cached `client_id` mean
  one registration per user per server rather than one per run, which helps, but
  the limiting itself is #23.
- **`bellman login` / `logout` as commands.** Lazy sign-in covers the install
  path. If deliberate re-authentication turns out to be wanted, it is a small
  follow-up on top of `credentials.ts`.
- **`tsconfig.worker.json` inheriting `exclude`.** It overrides `include` but
  not `exclude`, so `npm run typecheck:worker` skips `src/worker.ts` and
  `src/store-do.ts` — the two files it exists to check. Real, unrelated, its own
  issue.
