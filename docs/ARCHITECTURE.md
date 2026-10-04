---
kind: architecture
title: Bellman Architecture
status: active
applies-when: |
  Need the shape of the whole system rather than one feature: what Bellman is
  and is not, why the server is remote-first, the storage objects, how identity
  and plans resolve, where trust boundaries sit, and what is still missing.
siblings: [superpowers/specs/2026-09-23-room-manifests-design.md, superpowers/specs/2026-09-29-room-delivery-design.md, superpowers/specs/2026-10-02-heartbeat-events-design.md]
last-verified-against-source: 77396879
last-updated: 2026-10-03
---

# Bellman Architecture

## 1. What Bellman is

**Bellman is a room agent sessions can be in together.** It is a hosted MCP
server. An agent connects to it, creates or joins a room, and exchanges messages
with every other member — other machines, other people, other model providers.

A room holds as many members as the creator's plan allows. Two is the smallest
useful number and not the shape of the thing: a `swarm` room fills to the plan's
member limit, join codes can be reissued to add people later, and a long-lived
hub room ([#18](../../../issues/18)) is meant to accumulate members over weeks.
Where this document says *peer* it means any other member, not a counterpart.

That is the whole product. The exclusions are worth stating precisely, because
they are the design:

| Bellman does | Bellman does not |
|---|---|
| Hold rooms, membership, event history | Start, stop or supervise agents |
| Authenticate humans and scope them to a plan | Write to your provider config or set permission modes |
| Relay messages with provenance and an audit trail | Decide what an agent should do |
| Work across machines, accounts and providers | Manage processes, terminals or worktrees |

The useful comparison is with a local orchestrator, which boots a team of agents
on one machine and routes between them by process name. That is a different
product solving a different half of the problem, and the two are complements
rather than competitors ([#85](../../../issues/85)).

Bellman's bet: **the interesting agents are not all on your machine.**

## 2. The system

```mermaid
flowchart TB
    subgraph surfaces["Agent sessions"]
        direction LR
        CCT["Claude Code<br/>terminal"]
        CCC["Claude Code<br/>cloud session"]
        DESK["Claude Desktop<br/>or VS Code"]
        OTHER["ChatGPT, Cursor<br/>Gemini, other MCP"]
    end

    subgraph local["Local, optional"]
        BRIDGE["bridge<br/>dist/channel.js"]
        HOOK["Stop hook"]
    end

    subgraph edge["mcp.bellman.sh — Cloudflare Worker"]
        AS["Authorization server<br/>OAuth 2.1 + PKCE"]
        MCP["/mcp<br/>nine MCP tools"]
        WS["/ws<br/>room socket, receive-only"]
        BILL["/upgrade<br/>/stripe/webhook"]
        ADMIN["/account<br/>/admin/grants"]
    end

    subgraph store["Durable Objects"]
        direction LR
        SDO["SessionDO<br/>one per room"]
        RDO["RegistryDO<br/>singleton"]
        ADO["AuditDO<br/>one per org"]
        AUTH["AuthDO<br/>tokens, billing ledger"]
    end

    CCT --> BRIDGE
    BRIDGE --> MCP
    BRIDGE -->|"one per room"| WS
    BRIDGE -.-> HOOK
    CCC --> MCP
    DESK --> MCP
    OTHER --> MCP

    AS --> AUTH
    MCP --> SDO
    WS --> SDO
    MCP --> RDO
    MCP --> ADO
    BILL --> AUTH
    BILL --> RDO
    ADMIN --> RDO
    ADMIN --> ADO

    STRIPE(["Stripe"]) --> BILL
    IDP(["GitHub, Google"]) --> AS
```

Everything in the `local` box is optional. **An agent needs nothing installed to
use Bellman** — the nine tools work over plain remote MCP. The bridge exists
only to turn polling into push.

## 3. Why the server is remote-first

Every other decision here rests on this one, and cloud agents are why.

A Claude Code cloud session runs in Anthropic's infrastructure. You did not
launch it, you cannot pass it flags, and there is no machine of yours for it to
open a socket back to. Any design that coordinates agents through local process
management — a daemon, tmux session names, a Unix socket — **cannot reach it at
all.**

```mermaid
flowchart LR
    subgraph yours["Your machine"]
        A1["local agent"]
        A2["local agent"]
    end
    subgraph theirs["Anthropic cloud"]
        C1["cloud session"]
    end
    subgraph third["A teammate's machine"]
        T1["their agent"]
    end

    ORCH["local orchestrator<br/>tmux, daemon"]
    A1 <--> ORCH
    A2 <--> ORCH
    ORCH -.->|"cannot reach"| C1
    ORCH -.->|"cannot reach"| T1

    BELL["Bellman room"]
    A1 <--> BELL
    A2 <--> BELL
    C1 <--> BELL
    T1 <--> BELL
```

A cloud session can reach an HTTPS endpoint and sign in with OAuth. That is the
only channel it has, so that is the channel Bellman is built on. Everything else
follows from taking cloud agents seriously as first-class members: no daemon, no
required local component, OAuth rather than a shared secret on disk, and org
tenancy rather than "whoever is on this box".

The cost is real. **MCP has no server push** — the protocol gives a server no
way to wake a client. That single fact produces the whole delivery story below.

## 4. Surfaces and delivery

`bellman_sync` long-polls for up to 25 seconds and returns events after a
cursor. That is the protocol-level mechanism, and every surface has it. What
differs is whether anything *wakes the session* when a message arrives. (A
second, cheaper way to watch a room exists for clients that can reach a local
process; it is under [two delivery paths](#two-delivery-paths) below.)

```mermaid
flowchart TB
    EVENT["a peer appends an event"] --> SDO["SessionDO"]
    SDO --> WSK["/ws room socket<br/>one per room, per machine"]
    SDO --> POLL["bellman_sync<br/>long poll, up to 25s"]

    WSK --> CO["the coordinator bridge"]
    CO --> BUS["local bus<br/>Unix socket"]
    BUS --> B["every bridge<br/>on the machine"]
    POLL -.->|"no socket: the<br/>coordinator polls"| CO
    POLL -.->|"no bus: each<br/>bridge polls"| B

    B --> CH["channel notification<br/>pushed into the session"]
    B --> IQ["inbox queue on disk"]
    IQ --> SH["Stop hook drains it<br/>at end of turn"]

    POLL --> MANUAL["the agent calls bellman_sync<br/>itself, when it thinks to"]

    CH -.-> NOTE1["terminal launch only:<br/>needs the development-channels flag"]
    SH -.-> NOTE2["POSIX only:<br/>the hook finds the bridge with ps"]
```

| Surface | Tools | Push | Notes |
|---|---|---|---|
| Claude Code, terminal | yes | **channel** | `bellman-claude` adds the flag; the best experience |
| Claude Code, terminal, `BELLMAN_DELIVERY=hook` | yes | **Stop hook** | fires at end of turn, no flag needed |
| Claude Code, desktop or VS Code | yes | Stop hook, untested | channels are not exposed there ([#27](../../../issues/27)) |
| Claude Code, cloud session | yes | Stop hook if committed to the repo | otherwise the agent polls |
| Claude Desktop, consumer app | yes | none | manual `bellman_sync` until MCP Apps ([#28](../../../issues/28)) |
| ChatGPT, Cursor, Gemini, other MCP | yes | none | manual `bellman_sync` |

Two consequences:

- **Push is an optimisation, never a dependency.** Every surface degrades to
  polling, and a bridge that fails to start must not cost anyone their messages.
- **Every session spawns its own bridge, and that used to cost a poll each.**
  Five sessions in a room meant five processes holding a poll for the same
  events. [#43](../../../issues/43) shares one upstream connection per room
  between them, over a local socket — no new daemon, and every bridge polls as
  before where that cannot be had ([the local bus](#the-local-bus)).

### Two delivery paths

A room can be watched two ways, and one function serves both: **`wake()` in
`SessionDO` resolves the long polls held on `bellman_sync` and sends to the
sockets held at `/ws`.** That is why the two cannot drift apart by accident. A
hosted connector can only call tools and has no local process to hold a socket,
so it long-polls for good; a client that can reach a local process takes the
socket. The decisions, and what was measured to reach them, are in the
[room delivery spec](superpowers/specs/2026-09-29-room-delivery-design.md)
([#99](../../../issues/99)).

| | `bellman_sync` long poll | `/ws` room socket |
|---|---|---|
| For | remote MCP clients: ChatGPT connectors, Claude's web connector | clients that can reach a local process: the bridge, through [the local bus](#the-local-bus) |
| Held as | an in-flight request, so the object stays resident | a socket the runtime holds, so the object hibernates |
| Scope | one member | the whole room |
| The member's own events | dropped | included |
| Untrusted wrapper | added at the tool boundary | left to the client |
| Event content and shape | `publicEvent` | `publicEvent` |

**They are not identical, and the difference matters.** What matches is the
event. `publicEvent` (`src/public-event.ts`) is the one projection both paths
use, which is why neither ever sends `fromUserId`: every member receives every
peer's events, so the stored event would hand one user another's upstream
identity. Everything around the event differs, because a poll is per member and
a socket is per room. The poll is permanent, so a change to what a watcher sees
has to land on both. And a socket frame carries no wrapper, so whatever reads it
must frame it as untrusted and escape `<` before a model sees it. The bridge does
that in `renderEvent` (`src/inbox.ts`), whichever path brought the event.

**Why the socket is cheaper.** A long poll is an in-flight request, an in-flight
request keeps the object resident, and a resident object bills duration for its
full 128 MB: 0.125 GB × 3,600 s × $12.50 per million GB-s is **$0.005625 per
watched room-hour**, about $4.05 a month at 24/7. The included 400,000 GB-s
covers roughly 1.23 always-watched rooms, account-wide. A hibernating socket
holds no request, so an idle object is evicted and a quiet room stops accruing
duration; the runtime answers a keepalive `ping` itself, so that does not wake
it either. That duration billing stops is Cloudflare's documentation, not
something measured here. The first bill is the test.

**Why this is not an MCP transport change.** MCP (2026-07-28) defines stdio and
Streamable HTTP. WebSocket is permitted only as a custom transport, and
SEP-1287, the proposal to standardise it, was closed on 2025-12-03. So `/ws` is
a delivery side-channel and not a second transport: tool calls, every write
included, stay on `/mcp`, only the watching path moves, and both ends of `/ws`
are Bellman's own code.

**The socket is receive-only, and `webSocketMessage` enforces it.** Any client
frame but the keepalive closes the socket with 1003. It is enforced and not left
as a convention because a send over the socket would be a second entry to the
write path: `bellman_send`'s verb check, frozen guard, idempotency record,
payload-depth limit and audit write would all be duplicated there and kept
identical to the first. Two delivery paths that must not drift is already the
cost of this design; two send paths would double it to save a round trip. A
future protocol message has to take that close out deliberately.

**The route builds the request the object sees.** `/ws` authenticates with the
`Authorization` header exactly as `/mcp` does, asks the object which members
that identity owns, refuses if there are none, and then **constructs a fresh
`Request`** carrying only what the Worker decided: the upgrade header, the
validated cursor and those member ids. Nothing from the caller's request is
forwarded. Forwarding the original with an identity header added is one
forgotten overwrite from a caller setting that header themselves; a request the
Worker built has nothing client-controlled to strip. It looks longer than it
needs to, and that is the reason to leave it. The route also goes to the object
directly and not through `BellmanStore`: `MemoryStore` cannot hold a hibernating
socket, so a `watch()` on the interface could be honoured by one implementation
only, and the conformance suite is what makes the interface a seam.

**Read-and-register still applies.** `SessionDO.fetch` awaits the events the
client missed, then attaches the cursor, accepts the socket and sends the
replay, with nothing yielding between those. An event appended in that gap
would be delivered to nobody and skipped by the cursor: the gap `waitForEvents`
closes by registering its waiter with no `await` after its read (invariant 2
below). The rule governs both paths and only the registration mechanism
differs, a waiter pushed onto an in-memory list or a cursor attached to a socket
the runtime holds. `wake()` is synchronous for the same reason.

**And the guard belongs in the same invocation as the accept.** `/ws` is *two*
invocations of one object — `membersOf`, then the upgrade — and the input gate
covers each but not the pair. So a close, or the TTL alarm, lands between them,
and `fetch` accepted the socket onto a closed room where nothing was left to
close it: the close had already happened ([#133](../../../issues/133)). The
Worker's check could not be moved and could not be trusted alone; `fetch`
rechecks `closed` for itself, before the event read and the accept, and refuses
with 409. One rule asked twice, from `readsClosed` in `store-do.ts`, which is
also what the TTL alarm expires a room by. The Worker's check stays because it is
what tells 403 from 404 without naming the room to a stranger, and what spares an
upgrade for a caller who owns nothing here. This is read-and-register again with
a guard in place of the cursor, and it is the same family as
[#118](../../../issues/118), [#120](../../../issues/120) and
[#124](../../../issues/124): a value read in one invocation and acted on in
another.

**One socket per (machine, room).** A socket binds to one `SessionDO`, so a
machine watching three rooms holds three. That is already fewer than per-member
polls hold, because a room socket carries every event in the room and the
members of one room on one machine can share it. The server half only made that
possible. The client half ([#43](../../../issues/43), plan 2 of the spec) is what
does it: one bridge holds the sockets and the rest read from it, as
[the local bus](#the-local-bus) describes.

### The local bus

A machine used to hold one long poll per member per session, so five sessions in
one room held five polls for the same events. It now holds **one upstream
connection per room**. Every session still spawns its own bridge, and a bridge
either holds that connection or subscribes to the one a sibling holds, over a
Unix socket at `~/.claude/bellman/bus/<hash>.sock`. The hash covers the server
URL and the identity (the `BELLMAN_KEY`, or the signed-in person), so two
identities on one machine never share a bus. The bus shares a connection and is
not where a room lives: the room stays on the server
([section 3](#3-why-the-server-is-remote-first)), so a session with no bridge, a
cloud one for instance, still takes part over `/mcp` as before.

The bridge that holds the connections is the *coordinator*. It keeps each room's
recent events in a bounded window and serves every subscriber from it, in order
and without gaps; a subscriber that has fallen behind the window gets what it
missed from the server, as the member it is. It is also where a room's stream
becomes each member's: every event is addressed to each subscribing member, less
that member's own. Delivery itself did not move. Each bridge still writes its
own session's channel or inbox, so what is shared is the connection and not the
writer. `src/bus.ts` holds the election, the wire and the window,
`src/room-socket.ts` the upstream socket, and `src/bus-link.ts` what a bridge
asks of them.

**The socket is the election.** A bridge connects to the bus path. If something
answers, it subscribes. If nothing does, because the path is absent or holds a
socket nobody listens at, it binds and becomes the coordinator, and a bridge
that loses the bind connects to the winner. Being connectable stands in for
being alive, so the election needs no lock file and no pid check: a coordinator
that was killed leaves a socket nobody can connect to, which the next bridge
removes, and one that exits cleanly removes its own. The stand-in has two known
gaps. A coordinator that is stopped but not dead still accepts connections, so a
subscriber gives up on one that does not acknowledge its subscribe and polls for
that member instead. And with no lock, two bridges racing can both win (1 race
in 160 in the spec's measurement, eight processes on macOS);
[D8](superpowers/specs/2026-09-29-room-delivery-design.md) records what that
costs.

**The fallback is mandatory, in two layers.** Where a room's socket cannot be had
or will not stay, the coordinator long-polls the room itself and keeps serving
the bus, going back to the socket when one opens, and its subscribers cannot
tell. Where the bus cannot be had (Windows, a socket path past the operating
system's limit, a directory that cannot be made) or stops answering, each bridge
polls for its own members with the same `watch()` loop it ran before there was a
bus. So a socket that fails does not undo the collapse into one connection per
room, and a bus that fails does not cost anyone their messages. Neither is a
dependency (invariant 6 below).

And it can be chosen rather than waited for: `BELLMAN_BUS=off` makes every
bridge poll as it did before there was a bus. A delivery path with no way out
is a bad trade, so the escape hatch is a variable rather than a code change.
An unrecognised value reads as off, deliberately unlike `BELLMAN_DELIVERY`'s
unknown-means-default: a typo should leave a room on the path that has been
in production for months, not move it onto the new one.

## 5. Storage

State lives behind one interface, `BellmanStore` (`src/store.ts`). Two
implementations: `MemoryStore` for tests and local development,
`DurableObjectStore` for production. A conformance suite
(`tests/helpers/store-contract.ts`) is what makes that a real seam rather than a
comment, and it runs against both. The root vitest program runs it against
`MemoryStore`; `worker-tests/` runs the same suite against `DurableObjectStore`
in real workerd, with real Durable Objects. That second program exists because
`src/store-do.ts` imports `cloudflare:workers`, which only workerd provides: a
root test can load those classes over a stub and a fake storage
(`tests/store-do-wiring.test.ts`), but cannot run real Durable Objects.

```mermaid
flowchart LR
    BS["BellmanStore<br/>src/store.ts<br/>every method async"]
    MEM["MemoryStore<br/>tests, npm start"] -.implements.-> BS
    DOS["DurableObjectStore<br/>production facade"] -.implements.-> BS

    DOS --> SDO
    DOS --> RDO
    DOS --> ADO

    subgraph objects["Durable Objects"]
        SDO["SessionDO — one per room<br/>session record, event log,<br/>TTL alarm, freeze flag"]
        RDO["RegistryDO — singleton<br/>join codes, connect tokens,<br/>plan grants and org index,<br/>create counts, creator index,<br/>joined-rooms index"]
        ADO["AuditDO — one per org<br/>append-only entries"]
        AUTH["AuthDO<br/>clients, codes, refresh tokens,<br/>Stripe billing ledger"]
    end
```

Why the split is shaped that way:

- **A room maps 1:1 to a `SessionDO`.** That natively provides held long-poll
  connections, hibernating WebSockets, per-room serialisation and geographic
  placement near whoever created it. Every store method is async because a join
  code resolves in one object and the room it names in another, and every hop is
  RPC. (`/ws` is the one route that skips the store; see
  [two delivery paths](#two-delivery-paths).)
- **`RegistryDO` is a singleton** because some lookups need a global namespace: a
  join code must resolve without knowing the room, and a plan grant must resolve
  from an identity key.
- **`AuditDO` is per org** because a cross-org room writes into *both* orgs'
  streams, and each side must see only the crossings that touched its own
  boundary.

### Presence is derived, membership is stored

A member has three readings, and only two of them are written down:

| | `leftAt` | Last heard from | Holds a seat |
|---|---|---|---|
| **present** | null | inside the window, or on a live socket | yes |
| **stale** | null | outside the window, and on no socket | only until contested |
| **departed** | set | — | no |

`leftAt` records a goodbye — a `bellman_leave`, an eviction, a reaped seat — and
a crashed session never says one. So a `pair` room whose peer's laptop closed
used to read as full for the rest of its TTL, with no removal path anywhere in
the store (#103). `Member.lastSeenAt` is the second signal, and it costs no new
traffic: `bellman_sync` long-polls every ~25 seconds, so a watching member is
already announcing itself, and `touchMember` stops throwing that away.
`bellman_send` touches it too.

Liveness is a field, and the `heartbeat` event (#111) is a different thing.
Liveness carries nothing and arrives on a timer, so a row per beat in the
durable, replayable event log is the worst available home for it — that is the
cost curve #99 and #25 exist to flatten. The tick is the server's, on the
cadence a room declares in its manifest, and it earns its row by carrying what
only the server can see: for every member the room expects to report, when it
last did and how long it had been silent at the tick's own `at`. It is written
only when some member is due, never into a frozen or closed room, and a room
that declares no cadence gets none. Members answer with `progress` events —
"still working, currently on the migration script" — which exist to reach a peer
and have no timer of their own.

`lastSeenAt` and `lastReportAt` are separate on purpose. Any call a member makes
moves the first; only a deliberate report moves the second. A member can be
present and silent, and that is the state the tick exists to surface: one field
would make every poll look like a report, and a member that is there but has
said nothing would read as fine.

Staleness is reversible because nothing is written when a member goes quiet: it
calls anything, `lastSeenAt` moves, and it is present again with the same
`memberId` and the same history. The single moment staleness becomes a write is
when a seat is **contested** — a joiner wants in and the room has none spare —
and then `reclaimStaleSeats` turns stale into departed and announces
`member_timed_out`. A room with a spare seat reaps nobody, however long they
have been quiet. The reap retires no join code, because freeing the seat is the
point, and never closes the room, because a joiner is waiting directly behind
the call.

Removing a member is authority, so the reclaim is confined accordingly:

- **It happens inside `BellmanStore.seatMember`**, in the same operation that
  seats the joiner, for the atomicity reasons in
  [section 9](#9-nothing-spans-two-objects). `seatVictims` is the shared rule
  both stores run, so it cannot drift between them, and it is pure and takes a
  cutoff rather than a window — the store holds no presence policy.
- **One tool reaches it: `bellman_confirm`.** The only path where somebody is
  actually taking a seat, reached only with a valid connect token.
  `bellman_connect` and `issueInvite` want seats too, so they *count* with
  `seatedMembers` and write nothing. That matters because `bellman_connect` is
  reachable by anyone holding a join code without joining, and never consumes
  the code — a reclaim there would have let one caller empty a quiet 25-seat hub
  room of every member, creator included, repeatedly for the code's 15 minutes.
  `evictMember` is creator-only and deliberately outside the verb set; a second
  removal path must not be looser than the first.
- **One seat, longest-quiet first**, so the blast radius is the size of the
  request; the next joiner reclaims the next seat. It refuses rather than
  freeing some of the seats a joiner needs, because a partial reclaim removes a
  member for somebody who never got in.
- **Never in a frozen or closed room.** `updateMember` has no frozen guard and
  `appendEvent` returns null, so reclaiming in a frozen room would remove
  members permanently *and* silently, and their watchers would never see the
  event that stops them. A freeze must cost nobody their place.
- **Announced from what the store did**, never from what the handler predicted:
  `announceReclaimed` is given the seats `seatMember` reports it took, so nobody
  is told a member timed out unless that member's seat really went.
- **Audited to the removed member's org**, which may be neither the room's nor
  the joiner's, with the action named `member_timed_out` rather than
  `member_evicted` so the row says the seat timed out, not that a person
  removed anybody.

Every authenticated call a member makes counts as a sign of life, not only
`bellman_sync`: `gateSeat` touches the caller before running any verb-gated room
operation. Without that, a member quiet for eleven minutes could issue a join
code — proof it is there — and be chosen as the longest-quiet victim by the very
joiner it had just let in.

The liveness write is throttled to once per half-window. In the Durable Objects
store an `updateMember` is a read-modify-write of the whole session blob, so a
write on every 25-second poll would cost more than the per-beat event row this
design rejects; half the window leaves `lastSeenAt` at worst five minutes behind
inside a ten-minute window, which is never the difference between present and
stale.

`activeMembers` (`leftAt === null`) and `seatedMembers` (present only) are two
readings of one roster, deliberately. The stores decide a room has emptied from
the first; folding staleness into it would make a room whose members all went
quiet close itself, destroying the history the returning session came back for.
Departure is permanent and may close a room. Staleness is reversible and must
never.

**An open socket is liveness (#146, #140).** A member fed by the local bus or by
the room's hibernating WebSocket never calls `bellman_sync`, so nothing writes
its `lastSeenAt`, and a listen-only member — an agent waiting for a peer's reply
— sends nothing either. On the window alone it would read stale after ten
minutes with its connection open, and the next contested join would take its
seat. The object holds a better fact than the window: `ctx.getWebSockets()` is
the sockets it has accepted, and each one's `SocketAttachment` names the members
its identity owned when it was accepted. So a member is present when `leftAt` is
null and either `lastSeenAt` is inside the window or a live socket in the room
vouches for it.

- **A socket vouches for an identity, not for the ids it names.** The attachment
  is a snapshot, and the bus serves every session of an identity on a machine
  through one socket per room, so a member that joins after the socket was
  accepted is carried by it without being named in it. `connectedAmong` widens
  the named ids to every undeparted member of the users they belong to. A member
  of that identity whose session died stays present while another of its members
  holds a socket in the room, which holds a seat too long, the direction #139
  prefers.
- **The reclaim reads the sockets inside `seatMember`**, in the same transaction
  as the decision, and is not handed a set. A set fetched first is old by the
  time it is used, and the reclaim is final. `seatVictims` takes the set as an
  argument so the seat rule stays one function for both stores; `MemoryStore`
  has no sockets and supplies none.
- **Everything that only counts reads `BellmanStore.connectedMembers`**: the
  preview in `bellman_connect`, the capacity check in `issueInvite`, whether
  `bellman_confirm` retires the codes of a full room, and the roster's
  `presence`. The reclaim is still confined to `bellman_confirm`, and none of
  these removes anybody.
- **A socket this object is closing does not count.** `isOpen` is the one
  definition of a live socket, shared with `wake()`: the runtime keeps listing a
  socket this object has closed until its peer acknowledges.

**The gap after a socket drops is closed (#152).** The object stops listing the
socket at once, which is correct — only a listed socket says a member is there
*now* — but `lastSeenAt` was then whatever it last was, and for a member that
only listens that can be its join. It read stale the instant its socket went,
with no window at all where a polling member has ten minutes, and a contested
join landing there took the seat.

`SessionDO.webSocketClose` now stamps `lastSeenAt` for the members the closing
socket was vouching for, so a drop leaves a full window behind it. Three things
make that the right hook rather than the upgrade: a DROP arrives there too, as
1006 with `wasClean` false, so it is not only polite closes; the handler already
ran and already woke the object to answer the close, so the cost is one
session-record write per teardown; and it covers a socket held for hours, where
a stamp at connect would have expired. It stamps `connectedAmong`'s answer and
not the attachment's ids, so a member that joined after the upgrade — served by
the same socket, absent from its snapshot — is stamped too. Closed and frozen
rooms are skipped, `touchMember`'s rule.

The stamp says the member WAS there, which is a fact about a moment that has
passed; presence stays derived, and only a listed socket says it is there now.
What remains uncovered is a socket the runtime never reports at all, which would
need the upgrade stamp as well and is not done.

## 6. Identity, plans and entitlements

A human signs in with GitHub or Google. Bellman is its own authorization server:
it mints its own tokens and never stores an upstream one.

```mermaid
flowchart TB
    START["human signs in<br/>GitHub or Google"] --> KEYS["identity keys<br/>provider:subject<br/>provider:email<br/>email:address"]
    KEYS --> O{"BELLMAN_USERS<br/>override?"}
    O -->|yes| OPER["plan from the operator"]
    O -->|no| G{"stored grant for<br/>a stable key?"}
    G -->|yes| GRANT["plan from the grant"]
    G -->|no| FREE["free"]

    OPER --> ENT
    GRANT --> ENT
    FREE --> ENT
    ENT["entitlementsFor identity<br/>modes, members, TTL, quota, audit"]

    STRIPE(["Stripe webhook"]) -->|"writes source: purchase"| G
```

Three rules that took several rounds of review to get right, and that constrain
anything built on top:

1. **A grant carries plan, role and org only.** `userId` always derives from the
   provider subject (`u_<provider>_<subject>`), so granting, changing or
   revoking a plan never orphans rooms the person already created.
2. **Only keys that keep naming the same human may resolve a grant.** A login or
   display name can be renamed and reclaimed; a verified address can be
   reassigned inside a managed domain. So grants resolve against the numeric
   subject, address keys are *claimed onto* the subject on first use, and labels
   are not keys at all.
3. **A purchase is a grant.** Stripe's webhook writes the same stored grant an
   admin would, with `source: "purchase"`. One read path, so a paid plan
   inherits the ownership checks, expiry and audit trail rather than being a
   second source with its own semantics.

### How each surface gets a credential

Three paths, and no operator in any of them:

- **A remote connector** — Claude Desktop, ChatGPT, anything speaking remote MCP
  — runs the OAuth flow itself. Dynamic client registration means it does not
  need to be pre-registered.
- **The bridge signs itself in.** It is a local stdio process, so it cannot be
  redirected to by a hosted callback. Instead it binds loopback on one of
  ports 51004–51008, opens a browser once, and stores its own tokens under
  `~/.bellman` (`src/signin.ts`, `src/credentials.ts`). Because `tools/list` is
  itself a call to Bellman, this happens at Claude Code launch rather than on
  the first `bellman_*` call. A file lock keeps concurrent sessions from each
  opening a tab, and a refresh race from failing the loser's call
  ([#50](../../../issues/50), [#77](../../../issues/77)).
- **`BELLMAN_KEY`** stays as the non-interactive path: CI, `npm run smoke`, a
  headless box, or anywhere there is no browser to open.

The operator's `BELLMAN_KEYS` map still exists and is now only that — an
operator escape hatch, not the path a new user walks.

## 7. Trust boundaries

Bellman's members are not on the same side. A room can contain an agent
belonging to someone else, driven by a model from a different provider. Peer
content is therefore **untrusted data at every hop**, and stays that way.

```mermaid
sequenceDiagram
    participant PA as Peer agent
    participant W as Worker
    participant SDO as SessionDO
    participant BR as Your bridge
    participant YA as Your session
    participant YH as You

    PA->>W: bellman_send (type, payload)
    Note over W: identity comes from the bearer token#59;<br/>a sender cannot name itself
    W->>SDO: appendEvent, stamped with<br/>member, user, label, cursor
    SDO-->>BR: the room socket sends the event,<br/>or a long poll returns it
    Note over BR: renderEvent wraps it as untrusted and escapes<br/>the less-than character, so it cannot<br/>close the channel tag
    BR->>YA: channel notification, wrapper intact
    alt type is action_request
        YA->>YH: show it, do not act
        YH-->>YA: explicit approval
        YA->>W: action_response, ref_id is the request's cursor
    end
```

The invariants that encode this, and that any change has to argue against out
loud:

- **Peer content crosses wrapped** — `{ trust: "untrusted", origin, data }`
  behind a warning preamble, all the way into the model's context. The room
  socket ([two delivery paths](#two-delivery-paths)) sends the bare event
  instead, so the client that reads it does the wrapping and owns this rule.
  The bridge is that client: `renderEvent` (`src/inbox.ts`) does the wrapping,
  after the bus. `deliver` (`src/bridge.ts`) calls it for a channel push, and the
  Stop hook and `bellman_wait` call it, through `renderBatch`, for the events
  `deliver` queued. An event is escaped and framed as untrusted whichever path
  brought it, and it does not become trusted by passing through a local process.
- **`<` is escaped to `<`** so a payload cannot close the `<channel>` tag
  and impersonate the harness.
- **An `action_request` is approved by the receiving human**, never by the
  receiving agent, and `request_actions` must be explicitly granted.
- **No shared mutable state between sessions.** Reads return detached copies and
  every write is an explicit store method.
- **Encryption would not change any of this.** End-to-end encryption
  ([#64](../../../issues/64)) stops the *server* reading a payload; it does not
  make a peer trustworthy.

## 8. Where this is going

The roadmap groups into five tracks. Each is architecture rather than features.

```mermaid
flowchart TB
    subgraph A["Rooms as declared objects"]
        A1["manifests — shipped"]
        A2["#2 permission verbs,<br/>server-enforced — shipped"]
        A3["#3 join codes carry<br/>a role — shipped"]
        A4["#20 sensitive values<br/>scoped to a room"]
    end
    subgraph B["Durability"]
        B1["#18 long-lived rooms"]
        B2["#65 a room record that<br/>outlives the session"]
        B3["#66 the scribe as actor"]
    end
    subgraph C["Surfaces beyond /mcp"]
        C1["#49 HTTP API"]
        C2["#48 browser session"]
        C3["#28 MCP Apps UI"]
        C4["#43 one poll per member"]
    end
    subgraph D["Organisations"]
        D1["#53 orgs as real objects"]
        D2["#54 invite by email"]
        D3["#55 SSO, #56 SCIM"]
        D4["#57 policy, #58 SIEM audit"]
        D5["#67 operator impersonation"]
    end
    subgraph E["Correctness debt"]
        E3["#73 #74 #75 freeze gaps"]
    end

    A2 --> A4
    A2 --> B3
    B2 --> B3
    C1 --> C2
    C1 --> C3
    D1 --> D2
    D1 --> D3
```

The ordering that mattered: **[#2](../../../issues/2) gated a lot**, and it has
shipped. Permission verbs are declared in a manifest and enforced by the server,
so what grants authority — a scribe that can close a room, a role that can evict
a member, sensitive values readable by membership — has something to be built on.

## 9. Nothing spans two objects

**A Durable Object's input gate covers one invocation. Nothing spans two.**

Bellman's state is deliberately split across four object types, so any
operation touching two of them has a window in the middle. That window produced
three filed bugs, and they were two different problems:

| | A lost write | A misordered write |
|---|---|---|
| Filed as | [#59](../../../issues/59), [#62](../../../issues/62) | [#69](../../../issues/69) |
| What goes wrong | A mutation commits in one object and the write that must accompany it lands in another. Lose the second and nothing records that it was owed. | Two operations interleave and an older result lands after a newer one. |
| What fixes it | **Durable delivery.** Persist the intent in the same transaction as the mutation, then deliver it. An alarm retries what did not arrive. | **A lock.** The whole operation runs inside the object whose queue can cover it. |
| Where it lives | `src/outbox.ts`, used `RegistryDO → AuditDO` and `SessionDO → RegistryDO` | `AuthDO.reconcile`, inside `BillingLedger.serializeUser` |

Neither fixes the other's problem. A durable queue delivers an old write as
reliably as a new one, and a lock does nothing for a write that was never sent;
conflating them would have produced an outbox where a lock was needed. To tell
which a change needs, ask what the window costs: a write that never happens, or
a stale decision overwriting a fresh one.

Within one object the problem is tractable: the guarded grant writes,
`moveGrant`, `closeSessionIfEmpty`, `seatMember`, `addMember` and the two
appends are single transactions. An append carries the rows that belong with its
event — the cursor, an idempotency key's record, and for a `progress` send the
sending member's own `lastReportAt`. That last one was a second `updateMember`
call after the append returned, which is a second transaction with the wake
between them: a due tick could read the committed event while the stale stamp
still named that member silent, and a retry skipped the patch outright.
`updateMember`, `closeSession` and
`freezeSession` are single invocations that await only storage. The input gate
covers those, and a transaction would be the stronger form: it holds even if an
await on anything but storage were ever put between the read and the write.
Across objects there is no transaction to widen.

`seatMember` is the newest of those, and it is worth reading as the pattern.
Seating a joiner means reclaiming a stale seat if that is what it takes,
deciding capacity, and appending the member — and as three store calls from a
tool handler, two concurrent confirms could agree on the same free slot, both
announce the same reclaimed member, both pass the check, and leave the room with
more members than seats. A `bellman_sync` landing in the window makes a member
live again *after* it was chosen as the victim, and a freeze landing there
removes somebody from a room that is meant to cost nobody their place. One
transaction closes all three. The handler keeps only what the store cannot know:
which sentence the joiner reads, and the events and audit rows for the seats the
store reports it actually took.

**A lost write: durable delivery.** `src/outbox.ts`:

1. **One commit.** `OutboxDriver.enqueue` returns the `ob:` rows for the caller
   to fold into its own `ctx.storage.transaction()`, and arms the alarm from
   inside that closure (runtime fact 1 below). A call its guard refuses queues
   nothing.
2. **Inline, then the alarm.** `deliverNow()` runs straight after the commit, so
   a join code resolves as soon as its room exists, and a row is deleted only
   once its delivery returns. The alarm is armed `OUTBOX_GRACE_MS` (5 s) behind
   the commit, so it is a backstop and not a second path: it finds the queue
   empty unless the inline attempt never ran or the downstream is not answering.
3. **FIFO, one drain at a time.** A failing head blocks the rows behind it, since
   both consumers are order-sensitive, and retries back off from 1 s to a
   5-minute cap for as long as they fail. `deliver` awaits another object, which
   opens this one's input gate, so `deliverNow()` is single-flight, and a drain
   stops after `MAX_DRAIN_PASSES` (100).
4. **Named alarms.** An object has one alarm, so handlers share it: each has a
   due time, `alarm()` runs whichever are due, then points the alarm at the
   soonest. A due time is a stored `due:<name>` row or one derived from the
   session record, and a stored row wins. `SessionDO` has three handlers,
   `outbox`, `ttl` and `heartbeat`, and only `outbox` is stored. The TTL is
   derived from `expiresAt`, so sessions written before named alarms still
   expire. The tick (#111) is derived from `nextTickAt`, which asks each member
   at its own `lastReport + cadence` — except one already due at the preceding
   tick, asked at `lastTickAt + cadence` — and arms for the earliest of those. So
   `lastTickAt` is a **floor rather than the clock**, and because both branches
   land after it, an alarm that fired and found nobody due still cannot fire
   again at once. The design's D10 and D5 carry the argument. `ob_seq`, the counter
   that numbers rows, sits outside the `ob:` prefix or its own drain would list
   it as a row; the OAuth purge cursor (`AuthDO.#purge` in
   `src/oauth/store.ts`) follows the same rule.

It is used twice:

- **`RegistryDO → AuditDO` ([#59](../../../issues/59)).** The four guarded grant
  writes (`putGrantIfOwned`, `deleteGrantIfOwned`, `putGrantIfSource`,
  `deleteGrantIfSource`) take an `AuditIntent` and queue their audit entries in
  the grant's own transaction. Auditing afterwards loses them: a delete that
  committed and then failed to audit answers `missing` on retry. The rule for
  what a grant change records lives once, in `src/grant-audit.ts`.
- **`SessionDO → RegistryDO` ([#62](../../../issues/62)).** `createSession`,
  `setJoinCode`, `consumeJoinCode`, `clearJoinCodes` and expiry queue the
  registry's index write in the session's own transaction. Only a *missing*
  entry, a session holding a code nothing resolves, was open: a stale `jc:` row
  was already inert, because `getSessionByJoinCode` re-reads the session and
  requires the code to still be in its `joinCodes`.

Delivery is at least once, so each consumer absorbs a redelivery in its own way.
`AuditDO.append` dedupes on the intent id (a `d:<id>` row written in the entry's
transaction), because appending is not idempotent. Join-code delivery needs no
marker: a put and a delete of one key already are.

**A misordered write: a lock.** `AuthDO.reconcile`. A purchase reconcile reads
what a user is paying for and then writes or deletes their grant in
`RegistryDO`, one decision in two steps. Run from the Worker, they were separate
calls and the ledger's queue was released between them, so an older `active`
could land after a cancellation and leave paid access nobody was paying for.
Stripe sends the deletion once, so nothing corrected it. A revision number on
the grant would not have closed it: the dangerous case is an older write landing
after a *delete*, which leaves nothing to compare against.

The shape that works: **the object that owns the serialisation performs the
whole operation and calls the others itself.** It has the bindings; the Worker
is the wrong place to hold a lock. `AuthDO.reconcile` runs `reconcilePurchase`
inside `BillingLedger.serializeUser` and calls the registry from there, so a
reconcile's write is not sent until the previous one's has been acknowledged.
It depends on three things:

- **One `AuthDO`.** The queue is a map of promises in the object's memory, so it
  serialises only because no second instance exists.
- **Lock order is customer, then user.** `linkCustomer` holds a customer's queue
  while it waits for the user's, so work inside the user's queue must not take a
  customer's. Nothing in `RegistryDO` calls back into `AuthDO`.
- **No timeout.** The lock is held across the registry call and one attempt at
  the audit delivery inside it, because releasing early is the bug. That attempt
  is `deliverNow()`; the alarm retries whatever did not land, outside the lock.
  A registry that stops answering delays one user's reconciles and links, and
  nobody else's.

The #69 race was not reproduced. With the lock removed, overlapping reconciles
came out in order in all 1,200 rounds tried, across four shapes. The window exists by
construction (an await later put between the read and the write, or two writes
overtaking each other on the way to the registry), so
`worker-tests/reconcile-race.test.ts` holds one reconcile open inside it and
shows that the lock is what keeps the order.

**What the runtime does.** Five facts, each measured on workerd rather than read
off its documentation, decide how code here is written.

1. **`setAlarm` inside a `ctx.storage.transaction()` closure commits with that
   transaction, and is discarded if the closure throws.** So `enqueue` arms the
   alarm from inside the caller's closure: a row that committed with nothing
   scheduled to read it is the loss this section exists to close, and
   `RegistryDO` has no other alarm to come back for it.
   `worker-tests/alarm-in-transaction.test.ts` holds the fact on its own, on
   workerd 1.20260926.1 (pinned in `worker-tests/package.json`): it arms in a
   closure, aborts the object and reads `getAlarm()`, then does the same with a
   closure that throws. If it fails, the outbox's arming is unsound; the test is
   not wrong.
2. **Everything awaited inside a transaction closure holds every other call to
   that object until it commits.** With a 250 ms await inside `AuditDO.append`'s
   closure, a `recent()` issued mid-closure waited 220 ms; a registry call made
   inside a closure held a read for 510 ms against the tests' 350 ms limit. So
   **never put a cross-object call inside a transaction**. The closure queues and the wrapper delivers after the
   commit (`putGrantIfOwned` calls `#putGrantIfOwnedTxn`, then `deliverNow()`).
   The `serves other calls while it waits` tests in
   `worker-tests/grant-audit-outbox.test.ts` and
   `worker-tests/join-code-outbox.test.ts` fail if a delivery moves back in.
3. **TypeScript `private` is erased, and a Durable Object answers RPC for every
   method on its class.** A plain stub's `putGrantIfOwnedTxn` returned
   `"written"`, and `expireIfDue` took a forged session record naming another
   room's live join code. Use `#private` for a writing method that nothing outside
   its own class calls: the deliveries, the `*Txn` halves, `expireIfDue`,
   `writeEvent`, `dropGrant`, `wake`, `AuthDO`'s client count and sweeps, and its
   registry handle.

   The rule is about surface, not protection, and it is important not to read it
   as more than that. `BellmanStore` and `AuthStorage` are facades over RPC, so
   every method they declare has to stay public — including ones that write:
   `RegistryDO.putGrant` and `deleteGrant`, `AuthDO.registerClient`,
   `markClientUsed` and `purgeStale`. Over a plain stub, `deleteGrant` removes a
   live grant, `purgeStale(now + 48h)` sweeps a registration that has not lapsed,
   and `registerClient` moves the cap counter. So converting the methods above
   narrows what answers RPC; it does not put a grant or the registration cap out
   of reach. Only Bellman's own code holds these bindings, which is what makes
   the whole group a foot-gun rather than a hole.

   Four `SessionDO` helpers that only read (`stored`, `events`, `nextCursor`,
   `derivedDue`) are still TypeScript-`private` and answer RPC; #126 tracks them.
   Instance fields do not answer, and `alarm` is reserved. Tests in
   `worker-tests/` call each converted method over a stub and expect a refusal.
4. **A Durable Object namespace accepts `""`, `null` and `undefined` as names.**
   `idFromName(undefined)` and `idFromName(null)` name the same objects as
   `"undefined"` and `"null"`, which `isOrgId` accepts. An entry filed against a
   falsy org id is therefore delivered, into a stream no org reads or into the
   stream of an org called `undefined`: a bad id misfiles instead of stalling.
   Check an id before it names an object; `hasOrg` in `src/grant-audit.ts` and
   the guard in `RegistryDO`'s `#deliver` are two defences for that reason.
5. **A thrown error crosses an RPC boundary without its prototype.** `name`,
   `message` and own properties survive, and workerd adds `durableObjectId` and
   `remote`; the class does not. So the value reports itself as a
   `PayloadTooDeepError` in every log and fails `instanceof PayloadTooDeepError`
   outside the object that threw it (#101). `MemoryStore` throws in one realm, so
   the root test program cannot see this — the first run of the contract suite
   inside workerd is what found it, which is what #12 was opened to look for.

   `DurableObjectStore` reaches a Durable Object through three accessors and
   nothing else, each wrapped in `reviving` (`src/rpc-error.ts`), so the class is
   rebuilt at the seam and `instanceof` holds for every method on the facade
   including ones added later. Three traps in writing that wrapper, all measured:
   `JsRpcPromise.then` refuses a non-function first argument, so the usual
   `.then(undefined, onRejected)` dies on every call; reading `.apply` off a
   method taken from a stub sends an RPC for a Durable Object method *named*
   "apply"; and calling the bare function drops `this`. `Reflect.apply` is the one
   form that does none of these. Each failure reddened all 131 contract cases at
   once and none of them is visible against a plain-object fake.

**Rolling back.** `alarm()` clears a due name only through its own branch, and its
closing `reArm()` points the alarm back at any name still due. A `SessionDO`
build that dispatches named alarms but predates the `outbox` branch (#62) never
consumes a `due:outbox` row, and fires its alarm back to back, indefinitely. A
rollback past that change has to clear those rows, and a `due:outbox` marker is
safe to delete only when its `ob:` queue is empty, which is what the drain checks
first. Deleted over queued rows it stops the spin and strands them, with nothing
armed to deliver them.

The heartbeat is the safer half of that rule. A stored `due:` row that an older
build never consumes is the spin above; a derived due time that a build does not
know is never computed, so there is nothing for it to leave behind. Rolling back
past #111 strands no row and needs no cleanup, where rolling back past #62 does.
An alarm already armed for a tick fires once into the older build, which finds
nothing to run and re-arms for the TTL.

**Where it is not applied.** `DurableObjectStore.createSession` writes two
registry indexes after the session commits, both outside the outbox and both
through `writeIndex`, which logs a failure instead of throwing: `us:` so a
lapsed plan can find a person's rooms, and `um:` so a room appears in each
seated member's joined listing. `addMember` writes `um:` the same way. These are
derived from state already committed, so a miss costs a row in one listing — a
room that a lapsed plan does not freeze, or a room missing from a joined listing
— never the room itself. That is the reasoning for logging rather than
retrying, and it is the same window the outbox closes elsewhere. Room activity
is audited by `audit()` in `src/server.ts`, which calls `AuditDO.append`
directly with no intent id and no queue, so only grant changes are guaranteed to
reach the audit stream. `bellman_confirm`, which commits a seat and then makes a
second-object write, is the filed case ([#116](../../../issues/116)).

Two related classes, both of which have already bitten:

- **A persisted type that gains a field** is silently a union with `undefined`
  for as long as old records live. Durable Object storage has no schema and no
  migration step. `identity_keys` on refresh tokens and `frozenAt` on sessions
  were both this bug. Normalise at the read boundary —
  `hydrateStoredSession` is the single gate for sessions.
- **A composite storage key is injective only if at most one segment can contain
  the separator.** `go:<org>:<key>` was not, until the org grammar was enforced
  and the segment escaped.

## 10. Invariants

These constrain everything above. A change that weakens one has to say so in its
pull request.

1. Every `BellmanStore` method is **async**, including ones `MemoryStore`
   answers instantly — a synchronous signature would be implementable only in
   memory.
2. `waitForEvents` must **not `await` between reading events and registering a
   waiter**, or an event arriving in the gap wakes an empty list. `SessionDO.fetch`
   obeys it for a socket: read first, then attach and accept with nothing
   yielding between. Guarded writes obey the same rule through a synchronous
   read. **A guard read in another invocation does not bind the registration in
   this one**, so `fetch` rechecks `closed` itself rather than resting on the
   Worker's `membersOf` ([#133](../../../issues/133)).
3. **Peer content is untrusted everywhere** and stays wrapped to the model.
4. **Reads return detached copies.** Nothing relies on shared references.
5. **`main` moves only through merges.** The repo is colocated
   [jj](https://jj-vcs.github.io); a detached git HEAD is normal.
6. **Push is never a dependency.** Every surface must work by polling.
7. **Presence is derived, never stored** — not in a field, and not in an event
   payload, which is replayed and would read as present hours after the member
   went. A `heartbeat` tick's snapshot is not a counterexample: it carries
   measurements taken at the event's own `at` ("silent for 660 seconds at
   14:05"), which stay true on replay, and never a claim about now — there is no
   `present`, `status`, `alive` or `healthy` key, and there must not be.
   Presence itself is still derived, and still lives in `presence.ts`. Going
   quiet writes nothing, so it is reversible; only a contested seat
   turns stale into departed. `activeMembers` decides when a room has emptied
   and `seatedMembers` decides who holds a seat, and those two readings must not
   be merged.
8. **A member is removed only by an authorized caller.** `bellman_leave` for
   oneself, `evictMember` for the creator, `seatMember` from `bellman_confirm`
   alone. A path that merely wants to know whether a seat is free must count,
   not write. See [presence](#presence-is-derived-membership-is-stored).
9. **A seat is claimed in one store operation.** Reclaiming, counting and
   appending cannot be separate calls: that is the window two confirms overfill
   a room through, and the window a sync revives a condemned member in.

## 11. What connecting costs

Measured against real MCP payloads and tokenized with cl100k as a proxy, so
treat these as plus or minus ten percent:

| | Tokens | When |
|---|---|---|
| Tool definitions | **~4,960** | every request, whether or not you are in a room |
| Creating a room | ~430 | once |
| Joining a room | ~1,300 | once — `connect` 563 plus `confirm` 730 |
| Receiving a message | ~220 | each |

Tool definitions were re-measured on 2026-10-03, after #111. The three rows
below that one are from the original measurement and have not been re-measured
since.

The method is cl100k over the compact JSON of the `tools/list` entries, summed.
List the real server's tools through an in-memory MCP client, as
`tests/helpers/harness.ts` does; then for each entry count
`json.dumps(entry, separators=(",", ":"))` with tiktoken's `cl100k_base`, which
leaves non-ASCII `\u`-escaped. Nothing in the repository runs it. On `14fd00b`,
where the previous figure was recorded, it gives 4,820, and 1,462 for
`bellman_start`, so the two measurements are comparable.

#111 added `heartbeat_on` and `reports` to the manifest schema inside
`bellman_start`, and `progress` to `bellman_send`. It added nothing to
`bellman_sync`: the ask travels in the tick's payload, paid by rooms that use the
feature, rather than in a tool description paid by every request.

Counted this way the total is 4,962, which is 142 more than the 4,820 recorded.
52 of those predate #111 (`bellman_evict` +43 and `bellman_invite` +9 since the
last measurement). The other 90 are #111's: `bellman_send` +47 for `progress`,
`bellman_start` +29 for the two manifest keys, and +7 each on `bellman_start` and
`bellman_connect` for the two preview keys their `Returns:` lines now name.
`bellman_sync` is 334, as before.

`bellman_start` alone is 1,498 tokens, 30% of the tool budget, paid even by
sessions that only ever join. That number belongs in review whenever its
description grows; [#78](../../../issues/78) proposes generating it, which also
makes it measurable.
