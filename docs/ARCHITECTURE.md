---
kind: architecture
title: Bellman Architecture
status: active
applies-when: |
  Need the shape of the whole system rather than one feature: what Bellman is
  and is not, why the server is remote-first, the storage objects, how identity
  and plans resolve, where trust boundaries sit, and what is still missing.
siblings: [superpowers/specs/2026-09-23-room-manifests-design.md, superpowers/specs/2026-09-29-room-delivery-design.md]
last-verified-against-source: af052f0c
last-updated: 2026-10-02
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
    BRIDGE -.-> HOOK
    CCC --> MCP
    DESK --> MCP
    OTHER --> MCP

    AS --> AUTH
    MCP --> SDO
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
    SDO --> POLL["bellman_sync<br/>long poll, up to 25s"]

    POLL --> B["the bridge holds the poll"]
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

Two consequences worth stating plainly:

- **Push is an optimisation, never a dependency.** Every surface degrades to
  polling, and a bridge that fails to start must not cost anyone their messages.
- **The bridge is per-session today, which does not scale on one machine.** Five
  sessions in a room means five processes each holding a poll for the same
  events. [#43](../../../issues/43) elects one bridge as coordinator and fans
  out over a local socket — no new daemon, and it falls back to independent
  polling when the lock or socket cannot be created.

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
| For | remote MCP clients: ChatGPT connectors, Claude's web connector | clients that can reach a local process: the bridge, once [#43](../../../issues/43) lands |
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
must frame it as untrusted and escape `<` before a model sees it, as the
bridge's `renderEvent` does for poll results today.

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

**One socket per (machine, room).** A socket binds to one `SessionDO`, so a
machine watching three rooms holds three. That is already fewer than per-member
polls hold, because a room socket carries every event in the room and the
members of one room on one machine can share it. But the server half only makes
that possible. The client half, [#43](../../../issues/43) in plan 2 of the spec,
is what makes it one per machine per room rather than one per member per
session: one bridge holds the sockets and fans out locally. Until it lands the
bridge still long-polls, and no shipped client opens `/ws`.

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
| **present** | null | inside the window | yes |
| **stale** | null | outside the window | only until contested |
| **departed** | set | — | no |

`leftAt` records a goodbye — a `bellman_leave`, an eviction, a reaped seat — and
a crashed session never says one. So a `pair` room whose peer's laptop closed
used to read as full for the rest of its TTL, with no removal path anywhere in
the store (#103). `Member.lastSeenAt` is the second signal, and it costs no new
traffic: `bellman_sync` long-polls every ~25 seconds, so a watching member is
already announcing itself, and `touchMember` stops throwing that away.
`bellman_send` touches it too.

It is a field and not a `heartbeat` event on purpose. Liveness carries nothing
and arrives on a timer, so a row per beat in the durable, replayable event log
is the worst available home for it — that is the cost curve #99 and #25 exist to
flatten. Progress updates — "still working, currently on the migration script" —
are the opposite case and *are* events (#111): they exist to reach a peer, and
they have no timer.

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

**A gap this leaves open: #140.** #99's hibernating WebSocket has already
landed, and `SocketAttachment` carries the member ids — so the object holds a
hard fact about who is connected, which beats any timeout because it is being
told rather than inferring. Presence consults none of it. That is latent only
while every client still long-polls `bellman_sync`; the first one that prefers
the socket stops touching `lastSeenAt`, looks stale with a live connection, and
is then the quietest member in the room by construction, so the next joiner
takes its seat. Closing it means stamping `lastSeenAt` when the socket is
accepted and excluding connected members from `seatVictims` inside the object,
which changes a `SessionDO` path the seat bug does not.

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
    Note over W: identity comes from the bearer token;<br/>a sender cannot name itself
    W->>SDO: appendEvent, stamped with<br/>member, user, label, cursor
    SDO-->>BR: the long poll returns the event
    Note over BR: wrapped as trust untrusted, origin, data;<br/>the less-than character is escaped,<br/>so it cannot close the channel tag
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
appends are single transactions. `updateMember`, `closeSession` and
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
4. **Named alarms.** An object has one alarm, so handlers share it: each keeps a
   `due:<name>` row, and `alarm()` runs whichever are due, then points the alarm
   at the soonest. `SessionDO` has two, `outbox` and `ttl`; its TTL is derived
   from the session record, so sessions written before named alarms still
   expire. `ob_seq`, the counter that numbers rows, sits outside the `ob:` prefix
   or its own drain would list it as a row; the OAuth purge cursor
   (`AuthDO.#purge` in `src/oauth/store.ts`) follows the same rule.

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

**What the runtime does.** Four facts, each measured on workerd rather than read
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

**Rolling back.** `alarm()` clears a due name only through its own branch, and its
closing `reArm()` points the alarm back at any name still due. A `SessionDO`
build that dispatches named alarms but predates the `outbox` branch (#62) never
consumes a `due:outbox` row, and fires its alarm back to back, indefinitely. A
rollback past that change has to clear those rows, and a `due:outbox` marker is
safe to delete only when its `ob:` queue is empty, which is what the drain checks
first. Deleted over queued rows it stops the spin and strands them, with nothing
armed to deliver them.

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
   read.
3. **Peer content is untrusted everywhere** and stays wrapped to the model.
4. **Reads return detached copies.** Nothing relies on shared references.
5. **`main` moves only through merges.** The repo is colocated
   [jj](https://jj-vcs.github.io); a detached git HEAD is normal.
6. **Push is never a dependency.** Every surface must work by polling.
7. **Presence is derived, never stored** — not in a field, and not in an event
   payload, which is replayed and would read as present hours after the member
   went. Going quiet writes nothing, so it is reversible; only a contested seat
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
| Tool definitions | **~4,820** | every request, whether or not you are in a room |
| Creating a room | ~430 | once |
| Joining a room | ~1,300 | once — `connect` 563 plus `confirm` 730 |
| Receiving a message | ~220 | each |

Tool definitions were re-measured on 2026-10-01. The three rows below that one
are from the original measurement and have not been re-measured since.

`bellman_start` alone is 1,462 tokens, 30% of the tool budget, paid even by
sessions that only ever join. That number belongs in review whenever its
description grows; [#78](../../../issues/78) proposes generating it, which also
makes it measurable.
