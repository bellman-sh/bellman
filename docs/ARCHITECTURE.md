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
        MCP["/mcp<br/>eight MCP tools"]
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
use Bellman** — the eight tools work over plain remote MCP. The bridge exists
only to turn polling into push.

## 3. Why the server is remote-first

This is the decision everything else rests on, and cloud agents are why.

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
comment — though it does not yet run against the Durable Object implementation
([#12](../../../issues/12)).

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
        RDO["RegistryDO — singleton<br/>join codes, connect tokens,<br/>plan grants and org index,<br/>create counts, creator index"]
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
        A2["#2 permission verbs,<br/>server-enforced"]
        A3["#3 join codes carry a role"]
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
        E1["#59 #62 #69 atomicity"]
        E2["#12 contract against the DO"]
        E3["#73 #74 #75 freeze gaps"]
        E4["#79 idempotency keys"]
    end

    A2 --> A4
    A2 --> B3
    B2 --> B3
    C1 --> C2
    C1 --> C3
    D1 --> D2
    D1 --> D3
```

The ordering that matters: **[#2](../../../issues/2) gates a lot.** Permission
verbs are declared in a manifest today and not enforced, so anything that grants
authority — a scribe that can close a room, a role that can evict a member,
sensitive values readable by membership — waits on enforcement being real.

## 9. Nothing spans two objects

**A Durable Object's input gate covers one invocation. Nothing spans two.**

Bellman's state is deliberately split across three object types, so any
operation touching two of them has a window in the middle. That one fact has
produced three separately filed bugs:

| Issue | The two objects | What can go wrong |
|---|---|---|
| [#59](../../../issues/59) | RegistryDO + AuditDO | a durable grant change whose audit entry is lost permanently, because the retry cannot tell the mutation already happened |
| [#62](../../../issues/62) | SessionDO + RegistryDO | a consumed single-use join code that stays redeemable |
| [#69](../../../issues/69) | AuthDO + RegistryDO | an older subscription state landing after a newer cancellation, leaving paid access nobody is paying for |

Within one object the problem is tractable and has been solved in place:
`putGrantIfOwned`, `deleteGrantIfSource`, `moveGrant` and the frozen-write
guards are each a single transaction. Across objects there is no such move, and
three ad-hoc patches would be worse than one pattern.

The shape that works: **the object that owns the serialisation performs the
whole operation and calls the others itself.** It has the bindings; the Worker
is the wrong place to hold a lock.

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

## 11. What connecting costs

Measured against real MCP payloads and tokenized with cl100k as a proxy, so
treat these as plus or minus ten percent:

| | Tokens | When |
|---|---|---|
| Tool definitions | **~3,730** | every request, whether or not you are in a room |
| Creating a room | ~430 | once |
| Joining a room | ~1,300 | once — `connect` 563 plus `confirm` 730 |
| Receiving a message | ~220 | each |

`bellman_start` alone is 1,352 tokens, 36% of the tool budget, paid even by
sessions that only ever join. That number belongs in review whenever its
description grows; [#78](../../../issues/78) proposes generating it, which also
makes it measurable.
