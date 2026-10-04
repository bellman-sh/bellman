# Room Delivery — Design

Issues: [#99 Room delivery over a hibernating WebSocket](https://github.com/bellman-sh/bellman/issues/99),
[#43 Bridge: one long-poll per member, shared by every local session](https://github.com/bellman-sh/bellman/issues/43),
[#25 SessionDO.getSession loads every event on every call](https://github.com/bellman-sh/bellman/issues/25)
Status: implemented, in two parts. The server half merged in #127; the client
half is on `mcfearsome/room-delivery-client-half`. Plans:
`docs/superpowers/plans/2026-09-29-room-delivery-server.md` and
`docs/superpowers/plans/2026-10-03-room-delivery-client.md`.
Supersedes: [Pricing Re-tier](2026-09-29-pricing-re-tier-design.md), superseded before implementation
Related: #12 (the store contract against the DO store), #18 (room inactivity),
#26, #27 (surfaces that exercise delivery), #48 (a browser-authenticated dash)

## Problem

Three issues describe one path, and each is cheaper to fix with the other two
in hand.

**#99 — the connection is the wrong kind.** The bridge watches a room by
long-polling `bellman_sync`. A long poll is an in-flight request, an in-flight
request keeps the Durable Object resident, and a resident object bills duration
for its full 128 MB against wall-clock time. There is no hibernation for plain
HTTP.

```
0.125 GB × 3,600 s × $12.50/M GB-s  =  $0.005625 per watched room-hour
                                    =  $4.05 / month at 24/7
```

The 400,000 GB-s included allowance covers about 1.23 always-watched rooms,
account-wide.

**#43 — there are too many of them.** Every Claude Code session spawns its own
`dist/channel.js`, and `createBridge` arms one `watch()` loop per member it
learns about (`src/bridge.ts:488`). Connections scale with sessions times
memberships rather than with rooms.

**#25 — each one re-reads the room.** `bellman_sync` calls `getSession` before
it waits (`src/server.ts:838`), and `getSession` returns `{ ...fresh, events:
await this.events(0) }` (`src/store-do.ts:108`) — the whole history, every
time. At a 25-second poll that is `103,680 × members × events` rows a month per
watched room, a term that grows for the life of the room. On the team plan that
life is 30 days.

Fixed separately, the seams get designed twice. #43's coordinator handoff *is*
#99's reconnect-from-cursor path. #99 removes #25's cost for clients that can
reach a local process and leaves it untouched for the ones that cannot, so
whether #25 still matters is a question only answerable with #99 decided.

### The probe

A throwaway Worker and DO, run under `wrangler dev` against real Durable
Objects, holding zero instance state — everything in `ctx.storage` or
`serializeAttachment`, the two things that survive eviction. The object was
evicted and revived while the socket stayed open, and delivery still worked:

```
connected.  constructions=1 sockets=1
  +10s      constructions=2 sockets=1 wsOpen=true
>>> EVICTED AND REVIVED after ~10s idle (constructions 1 -> 2)
>>> delivery after revival: delivered=1, client received=true
```

Eleven checks passed, against a deliberate control assertion that failed first
to prove the harness reports failures: a bad bearer on the upgrade is refused
401 and a good one upgrades; an event posted over ordinary HTTP reaches a
watching socket; fan-out reaches every member; reconnecting with a cursor
replays exactly what was missed and nothing already seen; a member sending over
its own socket fans out to the others.

**Not verified:** that duration billing actually stops. Cloudflare states it,
it is not observable under `wrangler dev`, and a local number would not be
evidence. D13 says what is done about that.

### Why this is not an MCP transport change

The MCP specification (2026-07-28) defines two standard transports: stdio and
Streamable HTTP. WebSocket is permitted only as a custom transport, and
SEP-1287, the proposal to standardise it, was closed on 2025-12-03.

This is a delivery side-channel. Tool calls stay on Streamable HTTP at `/mcp`,
only the watching path moves, and both ends of it are Bellman's own code.

## Scope

One spec, two implementation plans, in this order:

1. **The server half.** `/ws`, `SessionDO`'s socket arm, and #25. Nothing
   client-side changes and every bridge keeps long-polling, so this is
   shippable and verifiable on its own.
2. **The client half.** Coordinator election, the local bus, the upstream
   socket, and the fallback.

The split is a real seam rather than bookkeeping: after plan 1 the server
serves both delivery paths and a test client exercises the new one, while
production traffic is still entirely on the old one.

## Decisions

### D1 — The socket is receive-only, and that is enforced.

Server-to-client delivery only. The client never sends an application frame;
every write stays a normal MCP tool call on `/mcp`.

The probe tested sending over the socket and it worked, so this is a choice,
not a limitation. A send path over the socket would need `bellman_send`'s verb
check, frozen guard, idempotency record, payload-depth limit and audit write
reimplemented at a second entry point and kept behaviourally identical to the
first. Two delivery paths that must not drift is already the main cost of this
change (D11); two *send* paths would double it for a saved round trip.

Enforced rather than assumed: `webSocketMessage` is defined and closes the
socket on any client frame. A future protocol addition has to delete that line
deliberately.

Cursor acks were considered and rejected. The client states its cursor at
connect and that is authoritative, so a client that dies mid-batch simply asks
for the same events again — an ack would only let the DO record *attempted*
delivery more precisely, which nothing reads.

### D1a — A socket frame carries exactly what a poll response carries.

The spec left the frame's shape unstated, and the first implementation sent the
stored `SessionEvent` verbatim. That is wrong twice over.

**It leaks a field.** `publicEvent` (`src/server.ts`) deliberately omits
`fromUserId`, exposing only `cursor`, `type`, `from: { member_id, label }`,
`payload`, `ref_id` and an ISO `at`. A raw `SessionEvent` carries `fromUserId`
— `u_github_4242` and the like. Every member of a room receives every other
member's events, so a raw frame hands one user another user's upstream identity
across the network. The poll path has never done that.

**It forks the envelope.** The poll gives `from: { member_id, label }` and an
ISO timestamp; the raw event gives `fromMemberId`/`fromUserId`/`fromLabel` and
an epoch number. A bridge consuming both would need two parsers for one kind of
thing, and the two would drift — which is this design's named standing risk
arriving as a data format.

So the socket sends `publicEvent(event)`, and `publicEvent` moves out of
`src/server.ts` into a runtime-free module both programs can import, the way
`src/stored-session.ts` already holds the shape `store-do.ts` and the tests
share. One function, one shape, both transports.

The untrusted wrapper is NOT added here. The poll wraps at the tool boundary
and the bridge renders with `<` escaped at delivery; the socket keeps that
division, carrying the public event and leaving the wrapper to the client
(D9). What must be identical is the *content*, not the packaging.

### D2 — The upgrade authenticates by `Authorization` header, exactly as `/mcp` does.

Same order, same functions: `identityFromAccessToken` for an OAuth access
token, then `resolveIdentity` against the `BELLMAN_KEYS` static map, then
`unauthorized(oauth)`. No new credential type, no ticket store, one auth path
to reason about.

A browser cannot set that header. That is accepted: #48's cookie-authenticated
dash is out of scope, and it gets a ticket or a subprotocol when it is actually
built rather than a mechanism speculatively maintained until then.

Node can, and this was measured rather than assumed. Node 22's global
`WebSocket` accepts a non-standard `headers` option and the header arrives:

```
{ "auth": "Bearer PROBE_UNDICI" }   undici WebSocket + headers
{ "auth": "Bearer PROBE_GLOBAL" }   global WebSocket + headers
{ "proto": "bearer.PROBE_PROTO" }   subprotocol also arrives
```

So the client half needs no new runtime dependency. The `headers` option is
outside the WHATWG spec, which is a real dependency on non-standard behaviour;
the third line is the fallback if a future Node drops it, and it is recorded
here so that a later maintainer finds the answer rather than the surprise.

**What that API will not give you is the refusal's status.** Measured on Node
22.16 (undici 6.21.2) and 25.8.2 (undici 7.24.4): 400, 401, 403, 404, 409, 426,
500 and 503 all arrive as one bare `error` event with the status nowhere
readable. This matters because the route's codes are deliberately different
answers — 409 means the room is closed and retrying is pointless, 401 means the
credential is gone and retrying is harmful — and a client that cannot tell them
apart must treat every refusal the same.

The way out is a second request: after a failed handshake, ask again with
`node:http`, same URL and headers, purely to read the status. It has to carry
the upgrade headers, because a non-upgrade request is answered 426 before any
of the interesting checks run — which means the probe can itself be answered
101, so whatever socket that hands back must be destroyed rather than leaked.

**Two more behaviours of the same API.** On Node 22 a refused handshake
emits `error` and then no `close` at all, and `readyState` stays 0: the failure
is reported, but a client that waits for `close` waits for ever (a first
measurement waited two minutes for one). Node 25 follows the `error` with a
`close`. And a server that accepts TCP and never answers the handshake leaves
the client with no event for five minutes: both Nodes fire `error` at 301 s
(Node 25 then closes 1006, Node 22 says nothing more). A room cannot go unserved
that long, so a connect timeout of the client's own is what ends that attempt.

**Three more, from building the client.** `fetch` cannot be the second request:
it refuses an `Upgrade` header (a TypeError whose cause is "invalid upgrade
header", on both Nodes), which is why the probe uses `node:http`. Node 25's
WebSocket sends a refused upgrade a second time by itself when the status is 401
(two identical requests; a 409 or a 503 gets one, and Node 22.16 sends one every
time), so a refused credential is presented three times per attempt there. And
closing a connection whose peer never answers frees nothing from the client's
side: the socket was still CLOSING 30 s later on both Nodes, so an abandoned
connection holds its file descriptor until the operating system gives up on it.

### D3 — The Worker never forwards the client's `Request` to the object.

It reads `?session=` and `?cursor=`, validates them, resolves identity, and
then **constructs a fresh `Request`** carrying only what it decided: the
`Upgrade: websocket` header the DO needs to recognise the handshake, the
validated cursor, and the member ids `membersOf` returned. No header, query
parameter or body from the caller is copied across.

The alternative — forwarding the original with an identity header attached — is
one forgotten overwrite away from a caller setting that header itself. A fresh
request has no such failure mode, because nothing client-controlled is present
to strip.

The fail-closed guard `/mcp` carries applies here unchanged: with neither
`BELLMAN_KEYS` nor OAuth configured, refuse with 503. `nodejs_compat` means
`process` exists in the Worker and `resolveIdentity` falls back to the dev
table when handed nothing, so without the guard a deploy that forgot the secret
would serve `qk_dev_jesse` — team plan, admin role — on a public URL.

### D4 — `SessionDO` keeps its waiters and gains sockets.

#99 says the object "loses its waiters". It cannot. Remote MCP clients keep
calling `bellman_sync`, `bellman_sync` calls `waitForEvents`, and
`waitForEvents` needs the in-memory list. `waiters` stays exactly as it is and
`wake()` grows a second arm.

`wake()` stays synchronous, because every socket call it needs is:

```
let frame: string | undefined;   // built once, and only if a socket is due
for (const ws of this.ctx.getWebSockets()) {
  try {
    // Already closing or closed: do not bother. The receive-only rule closes a
    // socket that sends, and workerd keeps it listed until its peer acks.
    if (ws.readyState === WS_CLOSING || ws.readyState === WS_CLOSED) continue;
    const att = ws.deserializeAttachment();
    // Fail closed: a socket whose cursor we do not know gets nothing, since
    // over-delivering is the worse of the two wrong answers.
    if (!att || event.cursor <= att.cursor) continue;
    frame ??= JSON.stringify(publicEvent(event));   // D1a: never the stored event
    ws.send(frame);
    ws.serializeAttachment({ ...att, cursor: event.cursor });
  } catch (err) {
    // Per socket, so one failing member cannot starve the rest of the
    // fan-out. Unobserved, not a known failure.
    console.error("socket delivery failed", err);
  }
}
```

`getWebSockets`, `deserializeAttachment`, `send` and `serializeAttachment` are
all sync, so the existing waiter arm above this is untouched and no caller of
`wake()` changes shape.

### D5 — Accept, replay and attach happen in one invocation.

`SessionDO` gains its first `fetch` handler. Inside it, in this order:

1. `await` the events the client missed (`eventsAfter(cursor)`)
2. `serializeAttachment({ memberIds, cursor })`
3. `ctx.acceptWebSocket(server)`
4. send the replay

**The read comes first, and an earlier draft of this spec had it second.**
That draft accepted the socket before reading, which leaves a real failure
open: if the storage read throws, an accepted socket survives with no
attachment, and `wake()`'s guard is `if (att && event.cursor <= att.cursor)`
— null `att` fails the guard, so that socket receives *every* later event
regardless of cursor, carrying no member ids. Reading first means a failed
read accepts nothing.

Steps 2 and 3 are synchronous and adjacent, so no await separates attaching a
cursor from accepting the socket. That is the same shape `waitForEvents` already
has — await the read, then register without yielding — so this order follows
CLAUDE.md's rule rather than merely coexisting with it.

**Attach before accept, and this was measured rather than assumed.** A draft of
this section asserted that the Hibernation API requires accepting first for an
attachment to persist. That is false. Against the pinned workerd
(`1.20260926.1`), attaching first works, the attachment lands on the socket
that is then accepted, and it survives a real eviction — the instance was torn
down after 16 s idle and the attachment came back.

It also closes the last orphan. `serializeAttachment` throws above the 16 KB
cap, and with accept first that throw strands an accepted socket carrying no
cursor; the probe reproduced it at 1,400 member ids, leaving `[null]` where
attach-first leaves `[]`. `wake()` fails closed on a null attachment, so such a
socket would silently receive nothing for as long as it stayed open.

The reachability is remote but not zero, and not for the reason first given.
A room's *active* membership is capped by its plan (2, 8 or 25), but nothing
removes a member — `membersOf` deliberately returns members who have left, so
that `/ws` and `bellman_sync` agree about who may watch (D6). A hub room
accumulating a thousand seatings by one identity is churn, not a cap breach.

The order therefore depends on a runtime behaviour this spec measured once.
Task 8's workerd test and the smoke leg are what keep it honest: if a future
workerd stopped persisting a pre-accept attachment, every socket would fail
closed, and both checks would go red loudly rather than delivery going quiet.

All four are inside one invocation, and the input gate holds every other
request to the object for its duration. **This is CLAUDE.md's read-and-register
rule, not an exemption from it.** The rule exists because a poll has a gap
between reading events and registering a waiter, and an event landing in that
gap wakes an empty list. A socket has the same gap available and closes it the
same way. The reason survives intact; only the registration mechanism changes.

`ctx.setWebSocketAutoResponse()` handles ping/pong so a keepalive never wakes
the object, which is the difference between a hibernating socket and a resident
one. It is set **once in the constructor**, not per upgrade: measured against
workerd `1.20260926.1`, the runtime holds the pair for the whole object, it
survives eviction and revival, it covers sockets accepted before it was set,
and it does not keep an idle object resident. Per-`fetch` also works; the
constructor is where object-wide state belongs, and it keeps `fetch`'s pinned
call sequence to the four steps that are actually ordered.

**An earlier draft said `webSocketClose` and `webSocketError` are "defined so
the runtime can hibernate at all". That is false, and was measured false.**
Neither handler is required to hibernate. They exist for a smaller, real
reason: with an empty `webSocketClose`, a polite client close hangs about ten
seconds and then ends in 1006, so the handler replies `ws.close(1000)` to
complete the handshake. Echoing the peer's code is wrong — a close with no code
reads back as 1005 and throws. `webSocketError` genuinely has nothing to do and
stays empty.

### D6 — The socket path does not go through `BellmanStore`.

The `/ws` route reaches the Durable Object namespace directly. `BellmanStore`,
`MemoryStore` and the facade are untouched by the socket work.

`MemoryStore` cannot hold a hibernatable socket. A `watch()` method on the
interface would therefore be one that only a single implementation could
honour, and `tests/helpers/store-contract.ts` is what makes that interface a
seam rather than a comment. Adding a method the contract cannot test identically
in both implementations is how the seam stops meaning anything.

Two calls, not one: `membersOf(userId)` returns the member ids that identity
owns in this room plus whether the room is closed; empty means 403. Then
`stub.fetch()` performs the upgrade.

An earlier draft justified `membersOf` as "reads the session row only, never an
event key". That was true against the `getSession` this spec inherited, and
D12 has since removed the distinction — `getSession` reads no events either
now. Two real reasons survive, and they are the ones to keep:

- **It returns two fields, not a session record.** Every hop here is RPC
  between Durable Objects, so the payload is the cost.
- **It does not expire the room as a side effect.** `getSession` calls
  `expireIfDue`, which *writes*: it puts `closed: true`, clears the join codes
  and appends a `session_expired` event. An authorization check on a watch
  attempt must not do that.

The second one has a trap attached. Because `membersOf` skips `expireIfDue`,
a room past its TTL whose alarm has not yet fired would report `closed: false`
while `bellman_sync` — which goes through `getSession` — reports it closed.
That is the two-paths drift this spec names as its standing risk, arriving by
the back door. `membersOf` therefore answers
`closed: s.closed || now > s.expiresAt`: the same answer `getSession` would
give, reached without writing. The alarm still performs the real expiry.

An identity that owns a member in a room receives every event in that room and
filters locally. That is the visibility `bellman_sync` already grants, so
nothing widens.

### D7 — One socket per (machine, room), not one per machine.

A WebSocket binds to one `SessionDO`, so a machine watching three rooms holds
three sockets. #43's framing of one connection per machine is not reachable.

This is a further collapse than #43 gets alone, not a shortfall. #43's
coordinator polls per member; a room socket carries every event in the room, so
two members of the same room on one machine share one connection where #43
would hold two. `N sessions × M members` becomes one socket per room.

### D8 — The socket is the lock.

#43 proposes a separate exclusive lock at `~/.bellman/poll.lock`. Drop it.

Try to connect. Success means a coordinator exists and you are a subscriber.
`ECONNREFUSED` or `ENOENT` means the path is stale: unlink and `listen()`.
`EADDRINUSE` means another bridge won the race: connect again.

Connectability *is* liveness, which removes stale-pid heuristics entirely — no
`process.kill(pid, 0)`, no clock skew, no pid reuse. A coordinator killed with
`SIGKILL` leaves an unconnectable socket file, which the next bridge unlinks;
one that exits cleanly unlinks its own.

The path is `~/.claude/bellman/bus/<hash>.sock`, mode `0600`, the hash covering
server URL and credential so two identities on one machine never share a bus.
#43 says `~/.bellman/`, which matches neither existing convention: credentials
use `$XDG_CONFIG_HOME/bellman` (`src/credentials.ts:47`) and inboxes use
`~/.claude/bellman/inbox` (`src/inbox.ts:121`). This is runtime state, so it
belongs beside the inbox.

`sun_path` caps around 104 bytes on macOS, a genuine fallback trigger under a
long home directory rather than a theoretical one. **It is also a correctness
boundary, not tidiness.** Node 22 *truncates* an over-long socket path; Node 25
refuses it with `EINVAL`. Truncation is the dangerous half: two identities whose
hashes differ only past the cut would silently share a bus, which is precisely
what hashing the credential into the path exists to prevent. So the length check
is what keeps identities apart, and D11 catches the refusal.

**Measured correction: macOS gives the bind loser `EEXIST`, not
`EADDRINUSE`.** The paragraph above names the POSIX code; the platform we
develop on does not use it. 31 of 40 race trials failed before both codes were
handled. Treat either as "someone won, connect instead".

**Residual: this election can still produce two coordinators.** Measured at
about 1 in 160 real-process races (8 racers, macOS). No event is lost — a
subscriber that loses its bus races again and catches up from its own cursor —
and only a lock would close it, which this decision rejects. What *was* fixed is
the harm: a replaced coordinator's shutdown used to unlink its successor's
socket, turning a rare race into an outage caused by cleanup. The obvious mitigation — stat
the path and unlink only on an inode match — **cannot work**, and finding out
why is worth recording: libuv unlinks by *name*, inside `server.close()`,
synchronously. There is no point at which a guard could run between the check
and the removal.

So a coordinator records the file it bound at `listen()`, and on close, if the
name now refers to someone else's socket, it renames that file aside, closes
(letting libuv unlink the name it no longer owns), and renames it back — all in
one turn. It is strange-looking code and it is the only shape that works where
the unlink actually happens. Do not simplify it back to a plain `close()`.
Residual: the name is absent for microseconds between the two renames.

Linux is unmeasured.

**What this decision does and does not cover (#142).** D8 rejects liveness
heuristics for deciding **ownership**, and that is its whole scope.
Connectability decides who the coordinator is, and nothing else may. Whether a
connection is being *served* is a different question, which the subscribe
acknowledgement bound has always answered, and which a coordinator frozen after
acknowledging made unavoidable: no events flowed, nothing reported it, and the
next `subscribe` was the only thing that would notice. That is silent
non-delivery, the worst failure this feature has.

So the subscriber keeps two deadlines, and both answer that second question
rather than the first:

- **The ack bound** — this subscribe went unanswered. Per subscription, so it
  still fires on a connection busy with another member's events.
- **The idle bound** — this connection has sent nothing at all. Per connection,
  renewed by any frame, which is what the coordinator's periodic keepalive is
  for. Local only, so a quiet room still costs nothing upstream.

**Authority, when they disagree.** The election is authoritative for ownership
and the deadlines have no say in it. A subscriber that gives up ends its
subscriptions, falls back to polling, and **never unlinks the socket and never
claims the bus** — so a frozen coordinator keeps it, and every subscriber simply
stops depending on it until the next election. No liveness heuristic removes a
coordinator, which is the property D8 exists to protect. The count of mechanisms
is therefore two, not three: ownership, and whether this connection serves me.

**Both deadlines measure time the subscriber was LISTENING, not elapsed time.**
`readLines` pauses the socket and awaits each line's handler, so while an
`onEvent` runs nothing is read — including another subscription's
acknowledgement and including a keepalive. Wall-clock deadlines therefore
counted the subscriber's own work as the coordinator's silence, and a slow
consumer looked like a frozen coordinator (measured; it was #142's second
finding). Deadlines are held for the duration of a handler and resume with what
they had left, and one created inside a handler does not start until that handler
returns. The push is by time spent and not a fresh bound, so a subscribe that is
never answered is still given up on however busy the subscriber is.

### D9 — The bus delivers a gapless ordered stream from the cursor you named.

NDJSON framing. A subscriber sends `{ subscribe, session_id, member_id, cursor }`
— `session_id` is new versus #43, because the upstream socket is per room (D7)
and the coordinator must know which room to open.

The invariant is the whole point: a subscriber never buffers, never dedupes
against a second source, and never learns whether its events came from the
window, an upstream catch-up, or the live socket. That is what lets D10's
window be resized or deleted later without touching a single subscriber.

The untrusted envelope crosses the bus intact. `renderEvent` runs at
`deliver()` time in each bridge (`src/bridge.ts:657`), so the `<`-escaping
happens on the last hop and the bus carries raw `PeerEvent`s. Peer content does
not become trusted by passing through a local process.

### D10 — The coordinator keeps a bounded replay window; a miss syncs upstream.

Per-room ring, bounded by **both** count and bytes: 500 events or 2 MB, oldest
dropped. `MAX_PAYLOAD_CHARS` is 20,000 (`src/server.ts:19`), so a count-only
bound is a 10 MB worst case per room.

A window miss — a bridge re-arming after a long gap, holding a cursor older
than anything the coordinator has seen — is served by the coordinator issuing
one `bellman_sync` from that subscriber's cursor. Legal because the bus hash
already pins server URL and credential (D8), so the coordinator's identity owns
the member.

Each subscriber carries a `sentThrough` cursor and the coordinator never sends
it anything at or below that. One monotonic guard covers all three phases, so a
miss needs no separate queue: sync upstream, flush the window above whatever
that returned, go live. Events arriving mid-catch-up land in the window and are
therefore picked up by the flush rather than skipped.

Per-subscriber queueing keeps one slow catch-up from stalling the others.

### D11 — The fallback is mandatory, and it is today's `watch()` loop unchanged.

If the bus cannot be created — sandbox, permissions, a path over the `sun_path`
limit, an OS that refuses — the bridge polls on its own exactly as it does
today. `watch()` is kept, not reimplemented: the fallback is the code currently
in production, which is the only fallback worth having.

The degradation is layered. If the upstream *WebSocket* fails but the bus is
healthy, the coordinator long-polls upstream and keeps serving the bus
unchanged; subscribers cannot tell. So #99 failing never costs #43's collapse,
and #43 failing never costs anyone their messages.

This is an optimisation, never a dependency.

**In code (client half).** `openRoomSocket` takes the long poll as a required
`poll`, because a fallback that is mandatory is a parameter and not something a
caller is trusted to remember. After `degradeAfter` (3) failed attempts in a row
the room is polled through it, and what it returns reaches the same `ingest`
through the same one cursor guard as the socket's frames, so the bus cannot tell
which path an event came by. When a socket opens again the poll is cancelled and
the socket replays from the cursor reached.

Two statuses are not waited out. A 409 stops it, after one poll with no wait for
what the room said before it closed: the 409 comes instead of the replay that
reconnect was about to be sent. A 401 stops attempts with that credential, which
is read again for every attempt because an access token lasts ten minutes
(`ACCESS_TOKEN_TTL_SECONDS`), and leaves the room to the poll until the
credential changes. Everything else is full-jitter backoff. A keepalive, the text
the object answers itself (D5), is what tells a connection gone half-dead from a
room that is quiet in seconds, rather than whenever the operating system gives up
on it.

### D12 — `getSession` returns `StoredSession`; the one history caller gets `eventAt`.

`src/stored-session.ts` already defines `StoredSession = Omit<Session, "events">`,
already runtime-free by design, already the shape `SessionDO` holds on disk.
#25 is not introducing a concept — it is stopping `getSession` from
re-inflating one. `getSession` returns `StoredSession`, and
`getSessionByJoinCode` returns `{ session: StoredSession, role }`.

**The type does the enforcing.** With no `events` field on the return, a future
handler reaching for history stops compiling rather than quietly restoring the
full read. #25 asks that the behaviour be pinned so `MemoryStore` and the DO
store cannot drift; the type gives that at compile time and the tests give the
rest.

Exactly one **production** caller reads `session.events`: `src/server.ts`,
`bellman_send` resolving an `action_response`'s `ref_id` by cursor. It becomes
`eventAt(sessionId, cursor)` — one `storage.get(eventKey(cursor))`. A single
key, which is better than the full list and better than `eventsAfter` too.
`eventAt` joins `BellmanStore` and the contract suite, so both implementations
are pinned together.

The word *production* is doing real work there, and an earlier draft of this
spec omitted it and was wrong. Eleven further lines read `session.events` —
two in the contract suite and nine across `tests/tools` — and five helper
signatures (`activeMembers`, `findMember`, `roomPreview`, `audit` in
`server.ts`, `denyVerb` in `roles.ts`) take a `Session` only to read fields a
`StoredSession` still has. The ripple is small in `src/`, not small overall.

**One caveat on "the type does the enforcing".** It enforces against *callers*:
a handler reaching for `.events` stops compiling. It does not enforce against
an *implementation*, because a `Session` is assignable to `StoredSession` — a
store that kept returning events would typecheck. That half needs a contract
case asserting the returned object has no `events` property, or the claim is
only half true.

#25 says the contract pinning needs #12 first. For this it does not (D13).

What it is worth: `bellman_sync` costs one key plus a usually-empty list
instead of one key plus every event. `103,680 × members × events` becomes
`103,680 × members`. **The poll cost stops growing with the age of the room**,
which is the term that made a 30-day team room expensive. #99 removes the cost
for socket clients; this stops its growth for everyone else.

### D13 — Eviction is proved in workerd, and again by smoke.

`tests/store-do-wiring.test.ts` already loads the real `SessionDO` over a fake
storage via `vi.mock("cloudflare:workers")`. That fake grows
`acceptWebSocket`, `getWebSockets` and `serializeAttachment`, which covers
fan-out, replay-from-cursor, the `cursor <= att.cursor` guard, and the
receive-only close. It cannot cover eviction and revival, which is the claim
the whole change rests on.

So `npm run smoke` gains a `/ws` leg: connect, idle past the ~10s eviction,
assert delivery after revival. `BELLMAN_URL` already points smoke at any
deployment including `wrangler dev`, so the throwaway probe becomes a standing
check against real Durable Objects.

**Amended after #12 landed (PR #102).** This decision originally rejected
`@cloudflare/vitest-pool-workers` — "it would make the eviction assertion a
per-commit gate, at the cost of a third test program" — and said to revisit
with #12. #12 built that program: `worker-tests/`, its own dependency tree so
the pool keeps its vitest 4 peers while the root stays on vitest 5, and
`npm run verify` already runs it. The rejection's only stated cost is now
sunk, so the revisit resolves the other way.

The eviction assertion becomes a per-commit gate. `worker-tests/wrangler.toml`
sets `main = "../src/worker.ts"`, so the pool serves the real `/ws` route and
a test can drive the whole path rather than a stubbed object.

The mechanism comes from #12's own contract test, which documents it while
making a different point:

> `abortAllDurableObjects()` "tears the instances down, and that is what clears
> `SessionDO.waiters` — in-memory state no storage rollback would touch."

That is this design's central claim stated by someone who was not making it.
Waiters are in-memory and die with the instance; sockets are held by the
runtime and do not. One test asserts both halves — a socket delivers across a
teardown, and a waiter registered before the same teardown does not — which
pins the difference between the two arms rather than only the presence of one.

**The contingency fired, and resolved the other way.** This decision warned
that if `abortAllDurableObjects()` closed accepted sockets rather than leaving
them hibernating, eviction would stay smoke-only. It does close them — measured,
close 1006, unclean. But the pool at 0.22.0 also has
`evictAllDurableObjects()`, which hibernates sockets and is the right call
here. So the eviction assertion IS a per-commit gate. (`worker-tests/README.md`
and this spec both previously said the pool could not express eviction; both
were written before anyone looked for a second teardown.)

**No single teardown both keeps sockets and kills a waiter**, because evict
drains in-flight polls. So the companion waiter case uses abort, where the poll
rejects rather than resolving empty — it pins a runtime fact more than it pins
`SessionDO`'s code, and is weaker than the socket case for that reason.

**The input-gate premise is now tested, and it holds.** `worker-tests` races an
append against an upgrade and asserts the event arrives exactly once. 420 races
swept across a 0-20 ms append lag each delivered exactly once, and the test
discriminates: a deliberate 25 ms gap opened between the read and the
registration was caught at lags of 3-20 ms. A zero-lag race only exercises the
replay path, which is why the sweep matters.

The smoke leg stays either way. It is the only check that runs against a real
deployment, and a pool is a simulation of workerd's lifecycle, not a bill.

For #25 specifically, two checks can go red today without #12: the contract
suite gains `eventAt` cases run against `MemoryStore` as every other case is,
and a wiring test counts `storage.list` calls during `getSession`. Every new
assertion here is run against a deliberately broken implementation first —
restore `events: await this.events(0)` by hand and watch the count test fail —
before it is trusted.

## Architecture

### The server half

`/ws` sits in `src/worker.ts` after the OAuth routes and `/healthz`, before the
`/mcp` 404 at `:144`. A non-upgrade request gets 426.

```
client                Worker                      SessionDO
  |  GET /ws            |                            |
  |  Upgrade: websocket |                            |
  |  Authorization: …   |                            |
  |  ?session&cursor    |                            |
  |-------------------->| fail-closed guard          |
  |                     | identityFromAccessToken    |
  |                     |   ?? resolveIdentity       |
  |                     |--- membersOf(identity) --->| stored() only
  |                     |<-- [memberId] or [] -------|  (never events)
  |                     | 403 if empty               |
  |                     | build a FRESH Request      |
  |                     |--- stub.fetch(fresh) ----->| acceptWebSocket
  |                     |                            | eventsAfter(cursor)
  |                     |                            | send replay
  |                     |                            | serializeAttachment
  |<------ 101 ---------|<---------------------------|   (one invocation)
```

Afterwards the object hibernates. An `appendEvent` from any source revives it,
`wake()` runs both arms, and the socket receives without the object ever having
been resident in between.

### The client half

`src/bridge.ts` is 794 lines already, so this lands beside it rather than
inside it: `src/bus.ts` holds election, server, client, framing and the window;
`src/room-socket.ts` holds the upstream WebSocket, its auth header, its cursor
and its jittered reconnect. `bridge.ts` gains a bus-backed watch path and keeps
`watch()` as D11's fallback.

```
Claude session A ─ bridge (coordinator) ─── room socket ──> SessionDO(room1)
                     │  ├ window(room1)  ─── room socket ──> SessionDO(room2)
                     │  └ bus server ── ~/.claude/bellman/bus/<hash>.sock
Claude session B ─ bridge (subscriber) ─────┤
Claude session C ─ bridge (subscriber) ─────┘
```

Every bridge still calls `deliver()` itself, so channel notifications go over
each session's own stdio transport and hook delivery writes each session's own
inbox. `deliver()` is untouched.

#43 claims hook delivery gets "one writer to the queue instead of N". It does
not: `inboxDirFor(process.ppid)` gives each Claude Code process its own inbox,
so there are N inboxes either way and each bridge writes its own. The saving
for hook delivery is the same as for channel — N upstream connections collapse
to one per room.

Reconnect storms are addressed twice over. The storm is already divided by
session count, because a machine now opens one socket per room rather than one
per member per session; and `room-socket.ts` uses full jitter,
`random(0, min(cap, base × 2^n))`, so a fleet reconnecting after a deploy
spreads rather than synchronises.

### Cursors

Four holders after this lands, each with exactly one job.

| holder | means | why it cannot be merged with another |
|---|---|---|
| DO `serializeAttachment` | what was **sent** to that socket | survives eviction; per-socket, not per-member |
| coordinator, per room | upstream position; feeds the window | one per room, shared by every subscriber to it |
| coordinator, per subscriber (`sentThrough`) | gaplessness (D9/D10) | different subscribers are at different points |
| bridge `w.delivered` | what the **agent** has seen | a manual `bellman_sync` advances it out of band |

The last row is why the per-event guard at `src/bridge.ts:625` stays. The bus
guarantees no gaps; the bridge goes on guaranteeing no duplicates reach the
agent. Two different jobs, and no new dedupe machinery on either side.

## Testing

**Server half.** Fake-ctx unit tests for: fan-out to every socket; the
`cursor <= att.cursor` guard skipping an already-sent event; replay from a
cursor returning exactly what was missed and nothing already seen; a client
frame closing the socket; `membersOf` returning empty for a non-member and the
route answering 403; a fresh `Request` carrying no client header. Contract-suite
cases for `eventAt`. A wiring test counting `storage.list` during `getSession`.

**Smoke.** A `/ws` leg: bad bearer refused 401, good bearer upgrades, an event
posted over HTTP arrives on the socket, then idle past eviction and assert
delivery after revival.

**Client half.** `tests/bus.test.ts` over real Unix sockets in a temp dir:
election under a race; handoff mid-stream losing no event; a window hit; a
window miss syncing upstream and arriving in order; `sentThrough` suppressing a
duplicate; and the fallback engaging when the socket path is unusable.
`tests/helpers/fake-bellman.ts` gains a fake `/ws`. `tests/bridge.test.ts`
keeps exercising `watch()` unchanged, because it is now the fallback and has to
stay correct.

Every new assertion is run against a deliberately broken implementation before
it is trusted. A green test nobody has seen fail is not evidence.

## Files

**Plan 1 — server.** `src/worker.ts` (the `/ws` route), `src/store-do.ts`
(`fetch`, `membersOf`, `wake()`'s second arm, the three socket handlers,
autoresponse, `getSession` returning `StoredSession`, `eventAt`), `src/store.ts`
(`BellmanStore.getSession` signature, `eventAt`, the `MemoryStore` side),
`src/server.ts` (`:729` uses `eventAt`), `tests/helpers/store-contract.ts`,
`tests/store-do-wiring.test.ts`, `scripts/smoke.ts`, `docs/ARCHITECTURE.md`.

**Plan 2 — client.** New `src/bus.ts` and `src/room-socket.ts`; `src/bridge.ts`
(bus-backed watch path, `watch()` kept), `src/channel.ts` (shutdown closes the
bus), new `tests/bus.test.ts`, `tests/helpers/fake-bellman.ts`,
`tests/bridge.test.ts`.

## Out of scope

- **Browser and cookie auth for `/ws`** (#48). D2 takes the header-only path;
  a ticket or subprotocol arrives with the surface that needs it.
- **Unbounded event growth.** #25's tail. A retention decision tangled with
  #18, whose cost argument this spec weakens anyway.
- **Cross-machine coordination.** #43's own non-goal, unchanged.
- **Windows.** `net` supports named pipes, but D8's socket-is-the-lock election
  is unverified there, so Windows takes D11's fallback and polls. An unverified
  mechanism belongs behind the fallback, not in front of it.
- **`maxLiveRooms` and the pricing re-tier.** The superseded spec priced all
  traffic on the long-poll path's cost. Whatever replaces it has to price the
  remaining long-poll path alone, and that wants a real bill to read.

## Risks

- **Duration billing is stated, not measured.** Everything else in the probe is
  observed; this one is Cloudflare's documentation. The first bill after
  deployment is the test, and the pricing work is deliberately deferred until
  it can be read.
- **Inbound frames may bill as requests, and "a keepalive at most" was wrong.**
  D1 makes the socket receive-only and `setWebSocketAutoResponse` keeps a
  matching ping from waking the object. But a client that ignores the 1003
  close keeps reaching `webSocketMessage` once per frame — measured, six frames
  in two seconds gave six handler runs, with the socket staying listed and
  reading CLOSING until the client dropped TCP. A polite close wakes a
  hibernated object too. Enforcement holds (`ws.close` never throws on a
  repeat, so a chatty client cannot turn it into an exception), but the
  *billing* exposure is one invocation per unwanted frame, not zero. Confirm
  against a bill.
- **A stored event that cannot be projected poisons its room's replay.**
  `fetch` maps `publicEvent` over every missed event with no per-event guard —
  deliberately, so a failure accepts no socket rather than half a replay. But
  the failure is durable: that event stays stored, so every reconnect from
  before its cursor fails again, forever. `at` cannot cause it (server-set at
  all three creation sites), yet `JSON.stringify` of a very deep payload can:
  the tool boundary's own stringify and the frame's differ by about one level
  of nesting, and `MAX_PAYLOAD_DEPTH` (64) guards only *keyed* sends — an
  unkeyed send is capped at 20,000 characters and not at depth. Measured in
  Node 22 and unmeasured in workerd. A depth cap beside the char cap in
  `bellman_send` would close it at the door, which is the right place.
  **Closed** by #136: `assertPayloadDepth` (`src/payload.ts`) runs in
  `bellman_send` before the char cap, on every send rather than only keyed
  ones. `fetch` still has no per-event guard, for the reason above — what
  changed is that no payload it cannot project can be stored any more.
- **The two delivery paths carry the same content, not the same packaging.**
  The long poll is permanent, for clients that cannot reach a local process,
  and any change to what a watcher sees has to land in both arms of `wake()`.
  They are not identical and must not be described as such: the poll drops a
  member's own events and adds the untrusted wrapper, while a room socket is
  per-room by construction (D7), carries every event including the member's
  own, and leaves the wrapper to the client (D1a, D9). What must match is the
  event's content and shape. D1 is what keeps
  that from also meaning two send paths.
- **The TTL alarm's timing is measured on one platform only.** `expireIfDue`
  expires a room strictly past `expiresAt`, so an alarm firing *on* the
  boundary expires nothing, and `alarm()` re-arms for that case. 450 natural
  firings across two independent harnesses landed 1-14 ms late, none early and
  none on the boundary — but all 450 were local workerd reading one process
  clock. **That is "not observed locally", not "cannot happen".** If production
  dispatches within the same millisecond, `now === expiresAt` is common there
  and the re-arm does real work. The other branch, an alarm firing *early*, needs
  clock disagreement larger than dispatch latency, which a Durable Object
  migrating between machines could in principle supply; local data cannot see it
  at all. Either way the cost is mild and bounded: the room stays open until the
  next `getSession` expires it lazily, `membersOf` already reports it closed to
  new watchers, and only a quiet socket-only room misses `session_expired`
  entirely. Logging the two branches would settle it from production data.
- **Node's `headers` option is non-standard.** D2 records the measurement and
  the subprotocol fallback so a future break is a lookup rather than a
  rediscovery.
