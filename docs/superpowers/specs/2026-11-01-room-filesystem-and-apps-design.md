# Room filesystem and agent-built apps

*   **Author:** mcfearsome
*   **Status:** Draft (revised after review rounds 1, 2 and 3)
*   **Date:** 2026-11-01

--------------------------------------------------------------------------------

## Overview

A room gets files, and agents in the room can build apps.

This design lands as two ADRs (decision 12). Sections and table rows are marked **[A]** or **[B]** where they belong to one of them.

*   **ADR A, the room filesystem [A].** Files at paths, stored as `fs:` rows in the room's `SessionDO` and written through the same event transaction as the room log. Two uses: **documents** that members' agents and humans write and edit together, and **agent memory**, notes an account keeps under `/members/<memory id>/` that peers read only with `read_context`. A third path, **`/.bellman/`**, is a read-only view of the room's governed config (#414), rendered from #414's rows when read and never stored as files. ADR A depends only on #414.
*   **ADR B, apps [B].** A separate feature that builds on the filesystem's tool and paths. An agent writes a small web app (pages plus server code) for the room, and members open it at a members-only URL. App source lives in Cloudflare Artifacts, one Git repository per app, and Bellman makes every commit. The server code runs as a Cloudflare Dynamic Worker, and the app keeps its data in the SQLite storage of its own Durable Object. An automated gate checks every version before it goes live, and a human approves what an app may reach, in the dash. ADR B waits for the spike (Open Questions).

The reference product is xAI's Grok Build Mode: describe an app, see it running, share a link. What Bellman adds is that several people's agents, from any provider, build and use the same app under the room's roles.

Together the ADRs supersede parts of #430, #448, #394, #380 (decision 2), #381 (D7) and #392/#393; Technical Plan §12 lists each change.

## The Problem

Today a room has two places to keep shared state: the event log and the working surface. Neither fits documents, memory or apps.

*   **No shared documents [A].** Surface items cap at 8,000 characters and 1,000 items per room, and carry canvas layout. A spec, a runbook or a long plan does not fit, and there is no history, path or diff for a document.
*   **Memory is private and local [A].** Agents keep memory and instructions in files on their own machine. Peers cannot read them, and cloud agents, which have no machine, cannot keep any. A member's brief is one short record, not a set of notes.
*   **Governed config has no readable home [A].** Room instructions and policies from #414 are reachable only through dash forms and connect-time delivery (the room text an agent receives when it joins). An agent cannot browse them as files.
*   **Agents cannot build anything that runs [B].** A surface `html` item is a static page in a sandbox with no network and no data (`connect-src 'none'`). An agent can draw a mock-up of a bug tracker; it cannot build one that saves a bug. The planned route to apps (#448) waits on the whole data layer (#380), and it rules out server code.

## Terms

*   **Account**: a Bellman user id. A person's own seats and the seats of agents signed in as that user id belong to one account.
*   **Seat**: one place in a room, with its own member id and one role. An account can hold several seats in a room. Elsewhere in Bellman a seat is also called a member or, in ADR 0023, a handle; this document says **seat**.
*   **Member**: used only in its everyday sense, a participant in the room. "Members" means the room's participants; it never names a single seat.
*   **Role** and **verb**: a role grants verbs from a closed set (ADR 0009); `write_surface`, `send` and `vote` are verbs. A call needing a verb the seat's role lacks is refused.
*   **`read_context`**: a capability a seat grants to peers (ADR 0023). Today it lets peers read the seat's brief; this design extends it to the account's memory files.
*   **`govern`**: the verb #414 adds for changing governed room config. This design also uses it to approve what an app may reach.
*   **Memory id**: an opaque, random id Bellman assigns to an account in one room, used in `/members/<memory id>/` paths. It is the same for all of the account's seats and across rejoins, differs between rooms, and reveals nothing about the account. It is unrelated to Bellman's public handles (`src/handles.ts`).
*   **Room socket**: the WebSocket the dash shares across members, which reads the room as no account (`readableEvent` with a null reader). It never receives memory files or their events.
*   **Public page**: a public room's page and outside readers, which read through `publicReadEvent` (`src/public-event.ts`). It receives no `fs` events at all.
*   **Frozen room; evicted or departed seat**: existing room states. A frozen room refuses writes; an evicted seat was removed by a creator; a departed seat left. `gateSeat` (`src/rooms.ts`) refuses all three for writes.
*   **Phase A, phase B [B]**: phase A apps have no general network; phase B adds outbound calls through the egress Worker (decision 9).
*   **App key [B]**: the name of an app within a room, chosen by the seat that first writes under `/apps/<key>/`; same character rules as a surface item key. An app has exactly one `app` surface item, and that item's key is the app key.
*   **App id [B]**: a random 20-character lowercase hex id Bellman assigns to an app when its key is first written. The app is served at `https://<app id>.<apps domain>`, and its previews at the separate origin `https://p-<app id>.<apps domain>`.
*   **App author [B]**: for a version, the seat that published it, stamped by the server; for a draft, the seat that wrote it. Publishing makes a seat the author even of code another seat wrote: the publisher vouches for it.
*   **Capability set [B]**: what a version asks to reach: `db` or `room` (with a scope), `ai` (with a budget), and in phase B hosts and secrets. The **base set** is `db` alone. The **current approved set** is the one set per app a human last approved (or the base set).
*   **Version hash, bundle hash, capability hash [B]**: defined in §4.
*   **Durable Object Facet**: a Cloudflare feature that lets one Durable Object host another class's storage. This design does not use it (decision 15).

## Decisions

Decided by the product owner during design, numbered as the rest of this document cites them.

1. The room filesystem ships before the room data layer (#380).
2. App source lives in Cloudflare Artifacts.
3. The purpose is building apps in a room, with xAI's Grok Build Mode as the reference product.
4. Apps run server code that agents write, with storage of their own.
5. Apps get network access (phased by decision 9).
6. An automated gate (static analysis plus an LLM security review) checks new versions.
7. Agent memory and the `/.bellman/` view are in scope.
8. Storage split: documents and memory are `fs:` rows in `SessionDO`; `/.bellman/` is rendered from #414's rows and never stored; app source is one Artifacts repo per app; Bellman makes every commit and agents do not push in v1.
9. Network is phased. Phase A: no general network; `env.AI` and a restricted `env.ROOM`. Phase B: egress through the egress Worker, first for allowlisted users.
10. Humans approve capability sets, never individual commits, and only in a signed-in dash session from a seat whose role holds `govern`. `app.json` is a request. **Exception:** a version whose set includes writing to the room needs a human every time.
11. Until #380, an app holds `env.ROOM` or its own database, never both.
12. Two ADRs: ADR A for the filesystem, ADR B for apps.
13. The apps domain is `gettwin.xyz` for now, dedicated to apps, its name kept in configuration.
14. Memory is keyed by account, not by seat, so notes survive leaving and rejoining.

Accepted by the product owner with review round 2's fix list (2026-11-01):

15. An app's database is its `AppDO`'s own SQLite storage; Facets are not used.
16. The gate runs asynchronously from the `AppDO` alarm; there is no Workflow.
17. Commit attribution is read from metadata Bellman stamps into each commit; there are no intent rows.
18. Agents get no Git tokens in v1, read or write.

## Goals

*   **[A] Room files.** A seat whose role holds `write_surface` can create, read, edit, list and delete files at paths in the room. Every write is one event in the room log with an audit entry and a revision; any of the last 20 revisions can be read and restored.
*   **[A] Agent memory.** An account writes notes under `/members/<its memory id>/`, which belongs to the account and outlives any one seat. A peer reads them only when every seat the account holds grants `read_context`, checked on every path that reveals a memory file, its name or its activity.
*   **[A] `/.bellman/` view.** Agents read governed config as files. No write to `/.bellman/` succeeds through the filesystem; config changes only through #414's route.
*   **[B] Build an app from a chat client.** An agent with no shell or Git can write a multi-file app, check it, and publish it, using only Bellman tools; a human opens a preview from a link the agent receives.
*   **[B] Apps run server code.** A published app serves its pages and runs its server code at a members-only URL. A `db` app's data persists across versions and is deleted when the room is purged (v1 has no per-app deletion).
*   **[B] An automated gate.** No version goes live without passing it. It returns structured findings an agent can act on and records the versions of every check it ran.
*   **[B] Human approval of reach.** What an app can reach is a server record a human approves in a signed-in dash session from a seat whose role holds `govern`. A version within the current approved set ships with no human step, except a version that writes to the room (decision 10).
*   **[B] Phase B egress.** Apps call outside hosts only through Bellman's egress Worker, which enforces the approved record. A refused call tells the agent why.
*   **[B] Operable.** On-call can turn off one app, a room's apps or all apps without a deploy. An app's author can read its server errors, egress calls and gate verdicts, and is told of the first error in each version.
*   **[A][B] Within budget.** The tool listing stays at or under ARCHITECTURE §11's ceiling of 11,840 tokens. This work adds one tool, `bellman_fs`, whose whole definition (description, schema and parameter text) is at most 600 tokens, and grows `bellman_send`'s definition by at most 40 tokens.
*   **[A][B] Purge confirms each deletion.** A room purge deletes its file rows, memory ids, app repos, `AppDO` storage (app databases and log rings), bundles, app ids in `RegistryDO` and app secrets, and does not finish until each step confirms. One known gap: Cloudflare has not confirmed that deleting an Artifacts repo deletes its snapshots (see Risks).

## Non-Goals

*   **Public apps [B].** v1 app URLs require sign-in and a seat in the room.
*   **A `/public/**` namespace [A].** #430 proposed one for public rooms; room files are not served on public pages in v1.
*   **General network in phase A [B].** Phase A apps reach nothing outside Bellman except metered model calls.
*   **`env.ROOM` and an app database in the same app [B]**, until #380 (decision 11).
*   **Git access for agents [B].** No push, and in v1 no clone tokens either (decision 18). Agents read source through `bellman_fs`.
*   **Committing `/.bellman/` or memory to Git.** Neither ever goes in an Artifacts repo.
*   **Approval through an action request or a vote [B].** An agent can answer those, so they cannot approve an app's reach.
*   **Workers for Platforms at launch [B].**
*   **Migrating `html` items into apps [B].** Existing `html` items stay static and data-free.
*   **FUSE, a two-way mount, or CRDT editing [A].**
*   **E2E-encrypted rooms (#64).** They do not exist in the code yet. When #64 adds them, it must refuse files and apps in them; this design adds no E2E check, which reverses #430's fs-06 gate (§12).
*   **Forking VibeSDK as a service [B].** Bellman reuses its packages and patterns, not its agent loop.
*   **Enforcing "no personal data" [A].** The docs ask members not to keep personal records in files; nothing checks content for it.
*   **Content search [A].** v1 `find` matches path names only; searching file content waits for an index.
*   **Data residency [B].** One bundle bucket and no jurisdiction pinning. Residency is a later, room-level feature that must cover `SessionDO` too.
*   **Per-app deletion [B].** App storage is deleted with its room.

## Open Questions

The spike answers these in writing before ADR B (PR 4). None blocks ADR A.

*   **Platform availability.** Are Worker Loader (Dynamic Workers) and Artifacts enabled on Bellman's Cloudflare plan?
*   **Limits.** What CPU and memory limits apply inside a loaded worker?
*   **Commits.** What do isomorphic-git's bundle size, CPU per commit and peak memory measure at 1 file, 50 files and 5 MB? Does an Artifacts push fail when the ref moved since the expected head (compare-and-set)?
*   **Purge.** Does Cloudflare hard-delete an Artifacts repo and its R2 snapshots, and on what timeline?
*   **Sockets.** Does `globalOutbound` also intercept `connect()` TCP sockets from a loaded worker?
*   **Cookies.** Do the target browsers, Safari included, keep a `SameSite=None; Partitioned` cookie in a third-party frame?
*   **Fallback.** If the commit measurements or the purge answer rule Artifacts out, app source moves to `fs:` rows under `/apps/<key>/` (Alternative C) through the same `TreeStore` seam; decision 2 stands otherwise.

## Critical User Journeys (CUJs)

### CUJ 1 [A]: Two members' agents edit one document

*   **Given**: A room where two seats' roles hold `write_surface`.
*   **When**: Agent 1 writes `/plans/launch.md`. Agent 2 reads it at revision 1 and edits a line with `base_rev: 1`. Agent 1, still at revision 1, appends a section with `base_rev: 1`. Later Agent 2 restores revision 1.
*   **Then**: Agent 2's edit lands as revision 2. Agent 1's append is refused as `stale` with revision 2 and the changed content; it re-reads and lands as revision 3. The restore writes revision 1's content as revision 4. Each write is one event and one audit entry.

### CUJ 2 [A]: A member's agent keeps memory

*   **Given**: Account A's only seat grants `read_context`; account B's does not.
*   **When**: Each writes notes under `/members/<its memory id>/`, and a third seat's agent tries to read, list and search both. Later A leaves the room and rejoins with a new seat.
*   **Then**: The third seat's agent reads, lists and finds A's notes and none of B's; it receives `fs` events for A's notes and none for B's. No one but A's own seats can write under A's path. After rejoining, A's agent finds the same notes at the same memory id.

### CUJ 3 [B]: A chat agent builds and publishes a tracker

*   **Given**: A room on a paid plan with apps enabled. A seat's agent runs in a chat client with no shell, and its role holds `write_surface`.
*   **When**: It writes `/apps/bugs/index.html`, `/apps/bugs/server.js` and `/apps/bugs/app.json` in one `bellman_fs` write, sends its human the preview link from `status`, runs `check`, and when the verdict passes, publishes by writing the `bugs` `app` surface item.
*   **Then**: `app.json` asks for `db` only, the base set, so the version goes live with no human step. Members open it at `https://dash.bellman.sh/a/<room>/bugs` and click Run. Bugs they file persist across later versions.

### CUJ 4 [B]: An app asks for more reach, and a version fails the gate

*   **Given**: The live tracker. Its author's agent changes `app.json` to ask for `ai` with a monthly budget and adds a summary feature.
*   **When**: The first `check` fails: the LLM review flags a high-severity finding. The agent fixes the code from the structured finding, checks again, and publishes.
*   **Then**: The second verdict passes, but the set widened, so the version is `pending_approval` and the old version keeps serving. A human whose seat holds `govern` sees "this app can call models, up to N tokens a month" in the dash and approves. The new version goes live and the agent receives an event.

### CUJ 5 [B]: On-call stops a runaway app

*   **Given**: An app looping on model calls.
*   **When**: The operator disables it from the operator route.
*   **Then**: The next page request, `env.AI` call and alarm are refused. No deploy is needed. The app's data, logs and pinned version are kept.

## Technical Plan (Architecture)

### 1. Dependencies

*   **#414 governed config [A][B].** The `govern` verb, the `cfg:` rows, `getGovernedConfig` and the dash write route do not exist on `main` (`VERBS` in `src/manifest.ts` has eight verbs, none of them `govern`). `/.bellman/` and capability approval both need them. #414 lands first.
*   **The spike [B]** (Open Questions). Only ADR B and the app PRs wait for it.
*   **#415 secret detectors [B].** The gate and the app write path use them (§4, §6). Until #415 lands, both skip that check and say so.
*   **#191 secret custody [B].** Phase B only.

### 2. Components

```text
                       agents (any client)                      humans (dash)
                             │ bellman_fs / bellman_send               │ approve, deny, revoke (govern)
                             ▼                                         ▼
  ┌────────────────────────────── SessionDO (one per room) ──────────────────────────────┐
  │ [A] fs:<path> rows, fsh:<path>:<rev> history, mi:<userId> memory ids                  │
  │ [A] /.bellman/** rendered from cfg: rows (#414) on read, never stored                 │
  │ [B] app:<key> record: head version, current approved set, verdicts, states, flags     │
  │ events and audit entries in the same transaction as each write                        │
  └───────────────┬───────────────────────────────────────────────────────────────────────┘
                  │ [B] app write
                  ▼
        AppDO (one per app, reached through AppHost): one writer at a time; isomorphic-git
        commit stamped with seat, base and change hash; push expects the old head; alarm runs
        the gate; owns env.DB, the log ring, read and env.AI counters
                  │                                   │ verdict by (version hash, bundle hash)
                  ▼                                   ▼
        Artifacts repo per app ──► bundle (worker-bundler) ──► R2 apps/<room>/<key>/<bundle hash>
                                                            │
  viewer ──► dash ──frame──► <app id>.gettwin.xyz ──► LOADER.get(room:app:version:capability hash)
             (previews: p-<app id>.gettwin.xyz)           │  env.DB   → AppDO SQLite        (or)
                             apps Worker: viewer cookie,          │  env.ROOM → viewer ∩ author ∩ scope
                             CSP, kill flags (one SessionDO read) │
                                                                  │  env.AI   → AI Gateway, metered
                                                                  └─ fetch → refused (A) / egress Worker (B)
```

### 3. Room files [A]

*   **Store.** `fs:<path>` rows in `SessionDO` and history rows `fsh:<path>:<rev>`, following #430's original design. Text only, at most 64 KiB per file. The `fsh:` key is parsed from the last colon, so paths may contain colons.
*   **Write path.** `writeFs` (`src/rooms.ts`) is a sibling of `writeSurface`, not built on a shared core: `writeSurface` has no stale check and no history rows, and its restore re-reads the event log by cursor, which file events cannot support because they carry no content. `writeFs` calls `gateSeat`, authorizes the path, calls `admitSend` (the per-seat send limit, ADR 0022) as `writeSurface` does, builds its audit entries with `auditEntries(...)`, and makes one store call, `appendFs`, which compares `base_rev` and writes the file row, a history row, the event and the audit entries in one transaction (as `bellman_decide`'s writes do).
*   **Revisions.** Each path has its own revision, an integer starting at 1 and raised by one on every write. `restore` writes an old revision's content as a new revision. A write names the `base_rev` it read; a write whose `base_rev` is not the current revision is refused as `stale`. A write without `base_rev` creates the file, and is refused as `stale` if the path already exists. History keeps the last 20 revisions per path; older ones are deleted on write. File rows and history count against the room's file byte quota, and each write charges the net change (new rows minus pruned history; a delete gives its bytes back).
*   **Change feed.** None of its own: every write appends an `fs` event (path, revision, size, op; never content) to the room log, and `bellman_sync` delivers it.
*   **Outcomes.** A write returns `ok` (path, revision) or `replayed` (a retried `idempotency_key`, same key rules as `bellman_send`). It is refused as one of the existing `RoomFailure` codes, `frozen`, `forbidden` (namespace, verb, or an evicted or departed seat) or `conflict` (an idempotency key reused with different content), or as one of three new codes: `stale` (HTTP 409, with the current revision and the changed content, capped at 64 KiB), `too_large` (413) and `over_quota` (413, with `used` and `ceiling`). The last two reuse the wire codes the blob routes already return.
*   **Quota.** `fsBytesPerRoom` sits beside `blobBytesPerRoom` in the plan table (`src/auth.ts`): 1 MiB on `free`, 50 MiB on `pro`, 500 MiB on `max` and `team` (starting values). It is stamped on the room at creation as `fsBytesCeiling`, as `blobBytesCeiling` is; a room created before this ships gets the free plan's value, the same default `blobBytesCeiling` uses. `decideFsCharge` sits beside `decideBlobCharge`.
*   **Paths.** Normalized and validated in one runtime-free module: NFC; slashes collapsed; no `.`, `..`, empty segments or control characters; at most 512 characters and 32 segments. Four kinds:
    *   `/members/<memory id>/**`: memory (below).
    *   `/.bellman/**`: built from #414's rows when read, as `room.md` (room instructions) and one Markdown file per other config name. ADR B adds `guide/apps.md` (the app author's guide, PR 9). Every write is refused with a pointer to the dash route.
    *   `/apps/<key>/**` [B]: app source (§4). Reading needs a seat in the room; writing needs `write_surface` and goes through the app write sequence.
    *   Everything else: room documents. Reading needs a seat in the room; writing needs `write_surface`. #430 asked whether to add `read_files`/`write_files` verbs; this design reuses `write_surface` (Alternative Q).
*   **Refusals.** Writes are refused in frozen rooms and from evicted or departed seats, through `gateSeat`.

#### Memory files

*   **Keyed by account (decision 14).** Bellman assigns a memory id (16 random hex characters) the first time an account writes under `/members/`; reads assign nothing and find no memory until then. It stores it as `mi:<userId>` in `SessionDO`, and reuses it for every seat of that account in that room. User ids never appear in a path, event or listing: peers do not see user ids today, and some encode the sign-in provider (`u_sso_…`).
*   **Who writes.** Only the account's own seats.
*   **Who reads.** A peer seat reads an account's memory files only if **every** seat the account currently holds in the room grants `read_context` (the most restrictive rule; ADR 0023 stores grants per seat and one account's seats can differ). A seat that left or was evicted is not held. If the account holds no seat now, every seat it held must have granted `read_context` when it left or was evicted (ADR 0023 keeps a departed seat's grant). The account's own seats read their own files through Bellman's tools and routes; app code gets no such exemption (§5). The room socket and the public page never read memory files or their events, though `seesBrief(…, null)` admits a granted brief: memory is not a brief.
*   **Every path that reveals a memory file uses the rule:** `read`, `list`, `history`, `find` (which filters before it ranks or counts, as `briefs_omitted` does), the `fs` events, and `env.ROOM` reads [B]. `readableEvent` (`src/public-event.ts`) gains its own branch for `fs` events on `/members/**`: it loads the account's seats with `membersOfUser(sessionId, event.fromUserId)`, applies the rule, and drops these events for the room socket. `publicReadEvent` drops every `fs` event. Each path is listed in `tests/delivery-paths.test.ts`.
*   **Default visibility.** `read_context` is granted by default, so memory is readable by the room unless the account withholds it. The docs say so; the Risks table lists it.
*   **Linking seats.** A shared memory id shows peers that two seats belong to one account. The docs say so.

### 4. App source [B]

*   **One Artifacts repo per app**, created by the app's first commit. When a seat first writes under `/apps/<key>/`, `createApp` checks the room's `appsCeiling` and reserves the app record and app id in one `SessionDO` transaction; the app id is then registered in `RegistryDO` (`appid:<app id>` → room, key), retried on the next write if that call failed.
*   **`AppHost` seam.** `write` and `check` for one app, one call at a time, plus reads (`read`, `tree`, `log`, `diff` at a version). In the Worker it is a stub to the app's `AppDO`. In memory it is a promise queue per app over `MemoryTreeStore`, used by tests and the Node server. The Node server writes, reads and reports status; `check` (which bundles), serving apps, previews and `call` need Workers, and the Node server refuses them with `apps_not_available`.
*   **Allowlist.** While `BELLMAN_APPS` is off, apps work only in rooms whose creator is in `BELLMAN_APPS_USERS`. The first app write, the apps Worker and the session route each check the room creator's user id.
*   **Bellman makes every commit, one writer per app.** `bellman_fs op:"write"` on paths under `/apps/<key>/` takes a set of file changes and a `base` version:
    1. `SessionDO` checks the seat (`write_surface`), and runs #415's detectors on every changed file; a secret refuses the whole write. Until #415 lands this check is skipped, and a secret written then reaches Artifacts, where it may not be removable (Risks).
    2. The app's `AppDO` takes the write through `AppHost`. It handles one write at a time, so two writers to one app never interleave. It commits with isomorphic-git and pushes naming the head it expects, so the push fails if the ref moved. Bellman writes the whole commit message, a fixed subject and the trailers `Bellman-Seat`, `Bellman-Base` and `Bellman-Change` (a hash of the changes); no agent text goes into it, so an agent cannot inject a trailer.
    3. `SessionDO` records the new head and appends the `fs` event with its audit entries, in one transaction.
    *   Commits never run in `SessionDO`, so commit CPU never stalls room delivery. They run in `AppDO`, which also serves the app's `env.DB` and runs the gate's build (§6), so a commit or a build can delay that app's database calls for its duration. This is accepted while a room holds at most 20 apps and starts at most 100 checks a day.
    *   If step 3 does not happen, the next write finds a head the record does not name. Only Bellman can write the repo (decision 18), so the head is adopted from its trailers and audited as the seat they name. A head without Bellman trailers is not adopted; the app is marked `diverged`, writes to it are refused, and the operator log records it for manual repair.
*   **Stale writes.** If `base` is not the head, a write applies when none of its paths changed on the head since `base`; otherwise it is refused as `stale` with the head version and those paths' current content.
*   **Events.** One `fs` event per app version, not per file: `{path: "/apps/<key>/", version, files: <changed paths>, op: "commit"}`.
*   **Removal.** Removing an `app` surface item is refused; an app stops through revoke or the kill flag.
*   **Reads.** Agents read app files through `bellman_fs` at any version (`version`, a version hash, in place of `rev`; `status` and `list` report the head version to send as the next write's `base`), including `history` with two versions, which returns a diff. Every diff, for room files and app source, is unified with 3 lines of context, at most 64 KiB, marked `truncated` past that, made with the `diff` package.
*   **Version identity.** All hashes are SHA-256, hex.
    *   **Version hash:** the hash of the lines `<path> <sha256 of content>`, sorted by path and joined with newlines; `app.json` is part of the tree. Artifacts' commit SHA is stored beside it, never used as the identity.
    *   **Bundle hash:** the hash of the built bundle's bytes; the app record maps each version hash to its bundle hash.
    *   **Capability hash:** the hash of the capability set written by `canonical()` (`src/decision.ts`, exported for this), the same sorted-key JSON `decisionHash` uses.
*   **`TreeStore` seam.** Read a file or tree at a version, commit changes against a base, log, diff, purge with verification. Two implementations against one contract suite, like `BlobStore`: memory (tests and the Node server) and Artifacts (Workers-only). A third, over `fs:` rows, is built only if the spike rules Artifacts out.

### 5. App runtime [B]

*   **Build.** The gate (§6) reads the tree at the version, bundles it with `@cloudflare/worker-bundler`, and stores it in R2 under `apps/<room>/<key>/<bundle hash>`, in the one app-bundle bucket. Bundles over 5 MB are refused. Serving reads that exact bundle, never Artifacts, so an Artifacts outage does not take live apps down and what is served is what the gate checked.
*   **Loading.** The apps Worker loads a version with `env.LOADER.get(id, …)`, where `id` is `<room>:<app>:<version hash>:<capability hash>`. Worker Loader fixes a loaded worker's `env` per id, so the id must carry everything `env` depends on: two apps with the same bundle never share a worker, and a change to the approved set loads a new one.
*   **Bindings.** A versioned Bellman contract with a compatibility date in `app.json`; app code never sees a raw Cloudflare binding. Each binding is a Bellman entrypoint bound at load with props `{room, app, version, capability hash}`. Item 37 lists every method, argument, return value and error code.
    *   `env.DB`: the app's SQLite, in its `AppDO`'s own storage (decision 15), with D1's statement API so code written for D1 runs unchanged. Present only if the approved set holds `db`.
    *   `env.ROOM`: room files and events. Present only if the approved set holds `room` with a scope (path prefixes, event kinds, read or write). Never alongside `env.DB`.
    *   `env.AI`: model calls through Bellman's AI Gateway, metered to the room. Present only if the approved set holds `ai`; refused past its budget.
    *   `fetch` and sockets: go to `globalOutbound`, which refuses everything in phase A and is the egress Worker in phase B.
*   **Per-request viewer.** The loaded `env` holds no viewer. For each request, the apps Worker replaces any incoming `x-bellman-request` header with a token it signs (`signJwt`, audience `bellman:apps-request`), carrying only room, app, version and viewer seat id, no user id and no `Identity`, and expiring 60 seconds after it is issued. App code passes the incoming request to `env.ROOM.as(request)` and `env.AI.as(request)`; the binding verifies the token and acts as that viewer. `env.DB` takes no viewer: it is the app's own data.
*   **What app code can do with a viewer's token (threat model).** App code is shared across viewers, and an isolate's memory persists between requests, so an app can always show one viewer data it read for another, and can reuse a token within its 60 seconds. Bellman does not try to prevent that inside the app. It bounds it: every `env.ROOM` call is limited to viewer ∩ author ∩ approved scope, so an app can only ever read what its author could read anyway; room writes need a human on every version (decision 10); and a token is useless after 60 seconds.
*   **`env.ROOM` authority is viewer ∩ author ∩ scope.** A call succeeds only if the viewer may do it, the version's author may do it, and the approved scope allows it. Both seats are checked live, so an evicted author's app gets `author_lacks_access`. The check uses `gateSeatRead`, not `gateSeat`, because `gateSeat` calls `touchMember`, which would write to `SessionDO` and mark the viewer present. Event reads go through `readableEvent` with the viewer as reader. Memory-file reads apply §3's rule to both the viewer and the author with no own-account exemption: an app reads an account's memory only if every seat of that account grants `read_context`, even when the viewer or the author belongs to that account.
*   **`env.ROOM` limits.** A closed set of operations that never includes `vote`, `request_actions`, `respond_actions`, `govern` or any `provision_*`. No write may target `/members/**`. Every write is stamped `via: app:<key>@<version>`, shown to peers. Alarms get no `env.ROOM`, and there are no inbound webhooks (no anonymous access). Writes go through `admitSend`, the viewer seat's send limit, inside the write transaction. Reads are capped at 120 a minute per app per viewer, counted in `AppDO`, so reads never write to `SessionDO`.
*   **Viewer session.**
    1. **Run.** On first open, and after any change to the current approved set, the dash shows a Run button; the click calls `POST /rooms/:id/apps/:key/run`, which records it (§7).
    2. **Mint.** The dash, holding the viewer's signed-in session, calls `POST /rooms/:id/apps/:key/session`. The route accepts only a session cookie (bearer callers are refused) and checks the request's Origin. Bellman picks the acting seat by §7's seat rule, checks its Run click, and returns an assertion signed with `signJwt` under `BELLMAN_TOKEN_SECRET`: audience `bellman:apps`, carrying only room, app, the version live at that moment, seat id, `preview` and a single-use `jti` (no user id, no `Identity`), expiring 5 minutes after it is issued.
    3. **Enter.** The dash frames `https://<app id>.<apps domain>/__bellman/enter` and sends the assertion with `postMessage`, naming that origin as `targetOrigin`. The enter page is served by the apps Worker, never app code, and accepts messages only from `https://dash.bellman.sh`.
    4. **Session.** The enter page posts the assertion to `/__bellman/session`. `AppDO` consumes the `jti` (a second use is refused), and the response sets `__Host-bellman_viewer` (HttpOnly, Secure, SameSite=None, Partitioned, `Max-Age=300`), which carries the assertion's version, and loads the app.
    5. **Requests.** On every request the apps Worker verifies the cookie and serves the version it names. Before app code sees the request, it removes that cookie and every cookie whose name lacks the `__Host-` prefix, and replaces `x-bellman-request` with the per-request token above.
    6. **Re-mint.** The dash repeats steps 2–4 every 4 minutes. Each new assertion names the version live then, so an open tab moves to a new live version within 4 minutes. An evicted viewer's next re-mint is refused, so they lose access within 5 minutes; requests in between add no seat lookup.
    *   App script on the app's origin can read a refresh assertion as it arrives. It is single-use and expires in 5 minutes; the iframe sandbox and CSP below limit where script could send it, and WebRTC remains a residual path (Risks).
*   **The dash frame.** `sandbox="allow-scripts allow-same-origin allow-forms"`: no popups and no top-level navigation. The dash's own CSP allows `frame-src https://*.<apps domain>`.
*   **App CSP.** The apps Worker replaces any Content-Security-Policy the app sets with: `default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; form-action 'self'; frame-src 'none'; worker-src 'none'; frame-ancestors https://dash.bellman.sh`. `default-src 'self'` also blocks inline scripts; the guide says so. The apps Worker refuses any request carrying `Service-Worker: script`, so no service worker can register on an app or preview origin and answer requests without this CSP. With the frame sandbox, page script can reach only the app's own origin, except through WebRTC (Risks).
*   **Cookies.** The apps Worker strips any `Set-Cookie` with a `Domain` attribute, or naming the reserved cookie, from app responses. Page script can still set a cookie on `gettwin.xyz` with `document.cookie`, but the apps Worker drops every incoming cookie whose name lacks the `__Host-` prefix, and browsers refuse a `__Host-` cookie that has a `Domain` attribute, so a sibling app's cookie never reaches app code. The guide tells authors to name their cookies `__Host-…`. Cookie flooding, which can break a sibling app, remains until `gettwin.xyz` is on the Public Suffix List, submitted before allowlisted users get access (PR 9). A listed domain is slow to remove, so the eventual move to a bought domain (decision 13) leaves `gettwin.xyz` listed.
*   **Previews.** A preview is `https://dash.bellman.sh/a/<room>/<key>?version=<version hash>`, returned by `bellman_fs op:"status"` for the head and for any version an agent names. Only an account with a seat whose role holds `write_surface` may open one (§7's seat rule). It uses the same session flow with `preview: true` in the assertion, but the dash frames the preview origin `https://p-<app id>.<apps domain>`, so ungated preview code never shares browser storage, cookies or service workers with the live app. The apps Worker resolves a `p-` host by stripping the prefix. It builds the bundle in the request on first open if the gate has not (bounded by the 5 MB bundle cap and the Worker's CPU limit per request), and loads it with no `env.AI`, no `env.ROOM`, no network, and a throwaway database that `AppDO` keeps under a preview prefix and deletes after 24 hours. A chat agent cannot open a URL; it sends the link to its human, or tests with `op:"call"` (§9).
*   **URLs.** Members reach an app at `https://dash.bellman.sh/a/<room>/<key>`; the dash frames `https://<app id>.<apps domain>`. The apps Worker resolves the app id through `RegistryDO` and keeps the mapping in memory (it never changes). Then it makes one `SessionDO` read per request, which returns the app record and the kill flags, so a kill takes effect on the next request. Nothing on the app request path writes to `SessionDO` except `env.ROOM` writes. No anonymous access.
*   **The apps domain is `gettwin.xyz` for now** (decision 13). Nothing else may be served on it or its subdomains. Its name is one var that code reads; the literal domain appears only in `wrangler.toml`'s route, never in code or app records. A move changes every app's origin, which drops each app's browser storage; `env.DB` data and dash URLs are unaffected.

### 6. The gate and the version lifecycle [B]

*   **Lifecycle.** States: `draft`, `checking`, `passed`, `failed`, `pending_approval`, `live`, `denied`, `superseded` and `stopped` for a version, and `diverged` for the app (§4). Killing an app (§9) sets a flag, not a state. Each step and its store call:
    1. **`draft`.** A write creates the version (`AppDO` commit, then `SessionDO` records it).
    2. **`checking`.** `bellman_fs op:"check"` calls `startCheck`, which sets the version to `checking` and counts it against the room's 100 checks a day (a cached verdict is returned at once and not counted), then sets an `AppDO` alarm and returns.
    3. **`passed` or `failed`.** The alarm builds the bundle, runs stages 1–5, and calls `recordVerdict`, which writes the verdict keyed by (version hash, bundle hash) and appends an `app` event (key, version, state, author) to the room.
    4. **Publish.** The agent writes the app's `app` surface item naming the version. `publishApp`, in one `SessionDO` transaction, checks that a passing verdict exists for exactly this version and bundle hash, that the version's set is within the current approved set, and that it does not write to the room. If all hold, the item is written, the version is `live`, the previous live version becomes `superseded`, and any `pending_approval` version becomes `superseded`. A `stopped` app comes back the same way: publishing a version within the current approved set makes it live. With no verdict the write is refused as `not_checked` (next step: `check`); with a failed verdict, with the findings.
    5. **`pending_approval`.** If the verdict passed but the set is wider than the current approved set, or writes to the room, nothing is written; the version is `pending_approval` with the publishing seat, replacing any earlier pending version (which becomes `superseded`), and the refusal carries `{ approver_role: "govern", link }`. The live version keeps serving.
    6. **Approve or deny.** In the dash, a human approves (`approveApp`: refused if the seat that asked to publish fails `gateSeatRead`, because it was evicted or left; otherwise the set becomes the current approved set, and the `app` item is written, authored by the seat that asked to publish and stamped `approved_by` with the approving seat chosen by §7's seat rule) or denies (`denyApp`: the version becomes `denied` with the human's reason, nothing is written, and the agent receives an event; the next step is to change the version and check again). Because a live publish supersedes the pending version, an approval never replaces a newer live version.
    7. **Rollback** is a publish of an older version, through step 4 against the current approved set. The publishing seat becomes its author.
*   **Where publish is enforced.** `normalizeSurfaceWrite` and `normalizeSurfaceBatch` (`src/surface.ts`), which every surface write path passes through, refuse a batch that mixes an `app` item with other items and refuse `app` items in proposals. `writeSurface` and `writeSurfaceBatch` (`src/rooms.ts`) hand an `app` item to `publishApp`, which refuses a key that is not an app key, so no write path skips the gate.
*   **Stages.**
    1. `app.json` schema and capability rules (including: not both `db` and `room`).
    2. Static checks on the bundle (banned imports, the 5 MB cap). `eval`, `new Function` and WebAssembly compiled from bytes are refused by the runtime; a test confirms that holds under Worker Loader.
    3. Dependencies pinned and checked against OSV at check time.
    4. #415's detectors over every file (they also run on write, §4). Until #415 lands, the verdict records that the stage was skipped.
    5. LLM security review of the source tree (not the bundle), at most 100,000 input tokens per check; a tree over the cap fails stage 5 for any set beyond the base set. Output is structured. A high-severity finding blocks a version whose set holds more than the base set; for a `db`-only version the findings are advisory. The reviewer reads text the author wrote and can be talked into a pass; it is a second line, not the boundary (Risks).
*   **Findings** are structured (`stage, rule, path, line, message, fix`) and returned in the untrusted envelope.
*   **Verdicts** are cached by (version hash, bundle hash) and record the analyzer, rule-set, model and prompt versions and the OSV query date. A newer rule set applies to new checks only.
*   **One gate.** #392/#393's logic units use this gate when they ship.

### 7. Capability record and approval [B]

*   **`app.json` is a request** naming `db` or `room` (with scope), an `ai` budget (tokens a month), and in phase B hosts and secrets.
*   **The current approved set** lives in `SessionDO` under the app: the set, its hash, the approving seat, the time, and the version that asked for it. Approving replaces it. Runtime bindings and the egress Worker read only this record.
*   **Subset rules.** A requested set is within the current set when: `db` and `room` match; each requested `room` path prefix lies under an approved prefix; its event kinds are a subset; a requested `read` is within an approved `write`; the `ai` budget is not larger; and (phase B) each host entry is covered by an approved entry and each secret is approved for the same host.
*   **The base set is pre-approved.** Every app starts with `db` only: no `env.AI`, no `env.ROOM`, no network.
*   **Which seat acts.** Every dash route that acts for a signed-in human (`run`, `session`, a preview, approve, deny, revoke) acts from the account's oldest active seat whose role holds the verb the route needs: `govern` for approve, deny and revoke; `write_surface` for a preview; none for `run` and `session`. Oldest follows `yourSeats`' order. That seat is recorded as the actor, `approved_by` for an approval.
*   **Who approves.** A human in a signed-in dash session, acting from a seat in the room that belongs to their own account and whose role holds `govern`. Seats of agents signed in as the same account count as the account's seats, but an agent cannot approve: the route accepts only a session cookie and refuses bearer and agent tokens explicitly, and `csrfRefusal` checks the request's Origin (it does not refuse bearer callers by itself). Approval goes through `POST /rooms/:id/apps/:key/approval`, built with #414's route helpers. Never through an action request or a vote.
*   **Revocation.** A human acting from a seat whose role holds `govern` can revoke the current set. It returns to the base set. A live version whose set exceeds the base set becomes `stopped`: the apps Worker serves a page saying the app is paused, and its bindings refuse calls. Pending versions stay pending. An approval stays in force when the approving seat later loses `govern` or leaves; it is a room record like any other.
*   **The approval screen** leads with the capability change in plain words (and the full `env.ROOM` scope when the set writes to the room), then the author and the seat that wrote the code if different, the gate summary (reviewer text labelled advisory), then the code diff, collapsed.
*   **Click to run.** A viewer's Run click is recorded in `SessionDO` per (app, viewer seat, current approved set hash). Any change to the current set asks every viewer again. No server code runs for a viewer before that click.

### 8. Phase B: egress [B]

*   `globalOutbound` is the Bellman egress Worker. It reads the capability record and:
    *   allows host + method + path prefix entries only; refuses wildcards on public-suffix and shared-hosting domains, and refuses Bellman's own hosts, private ranges and bare IP addresses outright;
    *   sets `redirect: "manual"` and re-checks every hop;
    *   injects each secret only for its (host, method, path), and scrubs secret values from responses;
    *   caps requests and bytes per app;
    *   answers a refusal with a typed 403 (`x-bellman-egress: refused; reason=…`).
*   **A host that accepts writes** is any entry allowing a method other than `GET` or `HEAD`. An app whose set holds `room` read plus such a host needs a human on every version. A `GET` with a query string can also carry data out; the approval screen says so for every host. Whether `room` read plus any host needs a human on every version is an owner decision taken at PR 10 (Risks).
*   Secrets are held under #191's custody model, not a new store.
*   Ships to allowlisted users first, after §9's logs, caps and kill switches have run in production.

### 9. Operations [B]

*   **Kill switches.** `BELLMAN_APPS` (default `off`) and `BELLMAN_APPS_USERS`, parsed like `BELLMAN_HOSTED_SEAT` (`hostedSeatOn`, `hostedSeatUsers` in `src/host.ts`). An operator route beside `/operator/rooms` disables one app (the app flag) or a room's apps (the room flag), both in `SessionDO`, through `setAppFlag`. The apps Worker reads the flags in its one `SessionDO` read per request; the bindings and the egress Worker refuse calls on a request whose read found a flag, and an `AppDO` alarm reads them before it runs. A kill therefore takes effect on the next request. Disabling revokes secret injection.
*   **Logs.** A bounded ring per version in the app's `AppDO` (200 entries, each at most 2 KiB; *starting values*) holds server errors, gate results and (phase B) egress calls, each tagged `{room, app, version, viewer seat}`. Read with `bellman_fs op:"logs"`. The first server error in each version appends one `app` event with state `error` to the room. Logs never go to the room log or `AuditDO`.
*   **Audit.** The hash-chained audit (ADR 0035) gets policy events: `fs_write`, `app_published`, `app_approved`, `app_denied`, `app_revoked`, `app_gate`, `app_disabled`. Each carries hashes, never content.
*   **Debugging.** `bellman_fs op:"call"` sends one HTTP request to a version (as a preview, so with no `env.AI`, `env.ROOM` or network) and returns its status, headers, the first 16 KiB of the body, and the log entries it caused.
*   **Caps.** Enforced before each call from the first release that has the call: `env.AI` budget per app (PR 6), previews (200 per room per day, PR 6), checks (100 per room per day, PR 7), `env.ROOM` rates (§5), egress (phase B). Apps per room: `appsPerRoom` in the plan table (0 on `free`, 20 on the paid plans; *starting values*), stamped on the room at creation as `appsCeiling`; a room created before this ships gets 0, so a free-plan room never creates an app (PR 5). `env.AI` metering uses the host meter's pattern (`decideHostCharge` in `src/store.ts`), counted per app in `AppDO`.

### 10. Purge [A][B]

*   The purge in `src/retention.ts` gains one step per backend: file rows and memory ids (in the room object, deleted with it), app repos, `AppDO` storage (database, log rings, counters), bundles, the capability record's secrets, and the room's `appid:` rows in `RegistryDO`. Each step confirms before the room record is removed. v1 deletes app storage only with its room. A `reposSwept` flag retries a repo delete until it reads as gone, the way `blobsSwept` does for blobs. The purge audit entry lists what was deleted.
*   The close-time sweep removes repos no app record names.
*   Until Cloudflare confirms hard deletion of repo snapshots in writing, the privacy docs state the gap.

### 11. Agent tool surface [A][B]

*   **One new tool, `bellman_fs`,** with an `op` enum: `read`, `list`, `write`, `edit` (replace one exact string), `append`, `delete`, `restore`, `history` (with two versions, a diff), `find` (path-name search, at most 20 results) [A]; `check`, `status`, `logs`, `call` [B]. Its whole definition is at most 600 tokens. The long guide (app layout, `app.json`, bindings, gate rules, error codes) is the file `/.bellman/guide/apps.md`, which the description points to.
*   **Publishing and rollback** are writes of the `app` surface kind through `bellman_send`, at most 40 tokens more in its definition.
*   **If the listing would pass 11,840 tokens,** `call` is cut first, then `find`; raising the ceiling is an owner decision recorded in ARCHITECTURE §11.
*   **Errors** follow the codebase's refusal style: a stable code, the current state, one next step.

### 12. Plans this supersedes

| Issue | What changes |
|---|---|
| #430 | Out-of-scope lines for code execution and html file access, and "after #380", are removed. The shared `writeRow` core is dropped (`writeFs` is a sibling). The `/public/**` namespace is dropped. fs-06's E2E gate is dropped until #64 exists. The `fs-*` children are re-planned around this design. |
| #448 | Folds into #430 as its app phase. "Server-side code out of scope" and the `bellman_data` app ops are withdrawn; "commits through the binding" is corrected; per-seat Git tokens are withdrawn for v1. |
| #394 | Its app data policy (host messages only, `appAccess`) no longer applies to apps; viewport routes stay. |
| #380 | Decision 2 is amended: apps hold their own data until the data layer exists. |
| #381 | D7 is amended to match. |
| #392 / #393 | Merge into this design's runtime and gate. |

## Alternatives Considered

### Alternative A [A]: One Artifacts repo per room, holding every use

The room is a Git repo, with documents, `/members/` memory and `/.bellman/` as paths in it (#430's comment).

*   **Pros**: One storage system. Git history, diff and restore for everything.
*   **Cons**: Artifacts tokens cover a whole repo, so a read token exposes every account's notes and `read_context` cannot be enforced. `/.bellman/` committed to Git is a second copy of config, which #414 forbids. A push bypasses `SessionDO`: no event, verb check, audit or eviction check.
*   **Reason for Rejection**: Memory privacy and the room log cannot hold (decision 8).

### Alternative B [B]: Agents push to Artifacts with write tokens

Bellman mints per-seat write tokens and agents `git push` (#448's model).

*   **Pros**: Agents with a shell use ordinary Git; no isomorphic-git in Bellman.
*   **Cons**: A push never touches `SessionDO`, so there is no event, verb check, audit entry or eviction check. Attribution rests on commit authors, which the client claims. Tokens are not cut off by eviction. Secret detectors would see a secret only after it lands. Chat agents still need a tool path, so there would be two write paths with different errors.
*   **Reason for Rejection**: It bypasses every room control. Reconsider if Artifacts adds pre-receive hooks that let Bellman refuse a push.

### Alternative C [B]: App source in `fs:` rows, Artifacts as a mirror

VibeSDK's default keeps files and history in the workspace object's SQLite.

*   **Pros**: No isomorphic-git; purge is certain; an Artifacts outage costs only Git history.
*   **Cons**: App source counts against the room object's 10 GB and per-file limits; Git history for clones lags; Bellman builds its own diff and history for source.
*   **Reason for Rejection**: Decision 2 puts source in Artifacts for Git history, diff and future clone access without building them. C is the fallback if the spike's commit measurements or purge answer rule Artifacts out (Open Questions).

### Alternative D [B]: A Postgres database per room (Neon through Hyperdrive)

*   **Pros**: Postgres extensions such as pgvector; a connection string for outside tools.
*   **Cons**: A second vendor and a network hop on every query. Per-room projects hit plan limits. Purge, residency and audit cross vendors. Reverses #380's decision to host room data on Cloudflare.
*   **Reason for Rejection**: For room-scale apps it adds a vendor, latency and cross-vendor purge, and gives nothing `AppDO` SQLite lacks.

### Alternative E [B]: A D1 database per room

*   **Pros**: SQLite with a REST API, export and time travel; up to a million databases per account.
*   **Cons**: Worker bindings are fixed at deploy, so a database created per room is reached over HTTP or through a per-room Worker.
*   **Reason for Rejection**: The same engine as `AppDO` SQLite, with more setup.

### Alternative F [B]: A SQLite file in the filesystem

*   **Pros**: Downloadable and versioned with the source.
*   **Cons**: Every write rewrites the whole file in Git; two writers conflict on the entire file; nothing can query it in place.
*   **Reason for Rejection**: Unusable as a live store.

### Alternative G [B]: Apps read and write through a Bellman-run `DataDO` (#380, #394)

*   **Pros**: Room-level access control on every row. Audit, quotas, purge and export already designed.
*   **Cons**: Waits on the whole data layer. Apps cannot run their own server logic.
*   **Reason for Rejection**: Decision 4. `DataDO` stays the home for governed room data; decision 11 keeps app databases and `env.ROOM` apart until it exists.

### Alternative H [B]: Client-only apps (the `html` item plus host messages)

*   **Pros**: Already built. Nothing runs on the server.
*   **Cons**: No server logic and no data of its own.
*   **Reason for Rejection**: Decision 4. Existing `html` items stay as they are.

### Alternative I [B]: Egress in the first release

*   **Pros**: Apps can call outside APIs from day one.
*   **Cons**: Egress needs redirect checks, host rules, secret scoping and response scrubbing, and would ship before the logs, caps and kill switches that watch it.
*   **Reason for Rejection**: Decision 9.

### Alternative J [B]: Approve every version, or approve by commit

*   **Pros**: A human sees every change.
*   **Cons**: Approving by commit holds every later code-only commit behind a human once one commit widened reach, so iteration stalls on a human for changes that reach nothing new.
*   **Reason for Rejection**: Decision 10: approve the capability set. Room writes are the exception and need a human every time.

### Alternative K [B]: Approve through an action request or a vote

*   **Pros**: Works from any chat client; no dash needed.
*   **Cons**: ADR 0008: the server cannot tell who answered an action request, and `human_approved` on a vote is claimed by the agent. A prompt-injected agent could approve its own app's reach.
*   **Reason for Rejection**: Only a signed-in dash session with `govern` approves.

### Alternative L [B]: Workers for Platforms at launch

*   **Pros**: Dispatch namespaces, an outbound Worker for egress, custom CPU limits per customer.
*   **Cons**: A $25 a month base and per-script costs for scale Bellman does not have yet.
*   **Reason for Rejection**: Deferred. The Bellman binding contract lets apps move there later without changes to app code.

### Alternative M [B]: Agents deploy to their own humans' accounts; Bellman only links

*   **Pros**: Bellman runs no untrusted code and carries no hosting liability.
*   **Cons**: Loses several people's agents building one app under room roles, with room data in reach.
*   **Reason for Rejection**: Rejected as the product. Kept as the exit if abuse or cost exceeds what the caps and kill switches contain.

### Alternative N [B]: Fork VibeSDK as a separate service

*   **Pros**: A working app builder on the same Cloudflare products.
*   **Cons**: Its built-in agent duplicates Bellman's external agents, and room permissions would have to be added from outside.
*   **Reason for Rejection**: Bellman reuses its packages and patterns (`worker-bundler`, version-keyed loading, signed previews, rollback as an old tree published again), not the service.

### Alternative O [B]: LLM review blocking every version

*   **Pros**: One gate shape for every app.
*   **Cons**: A `db`-only version has no `env.ROOM`, `env.AI` or network, so its server code reaches nothing outside its own database. Its page can still use WebRTC (§5), which a review does not close. Blocking it adds false positives that stall iteration and protects nothing the bindings do not already.
*   **Reason for Rejection**: It runs on every version and blocks only versions whose set holds more than the base set.

### Alternative P [A]: A shared `writeRow` core under `writeSurface` and `writeFs`

#430's original design.

*   **Pros**: One stale check, history and audit path.
*   **Cons**: `writeSurface` has no stale check or history rows, and its restore re-reads the event log; extracting a core means rewriting a heavily used write path.
*   **Reason for Rejection**: The real overlap is a gate call, an audit call and an append; `writeFs` is a sibling.

### Alternative Q [A]: New `read_files` / `write_files` verbs

#430's open question 1.

*   **Pros**: Finer control: a role could write files without writing the surface.
*   **Cons**: ADR 0009 allows a new verb only with the operation it gates; files and the surface are written by the same roles in every preset today; every manifest and preset would need updating.
*   **Reason for Rejection**: Reuse `write_surface`; add a verb when a room needs the split.

### Alternative R [A]: Memory keyed by seat

*   **Pros**: Uses the existing per-seat `read_context` grant directly.
*   **Cons**: Notes are lost when a person leaves and rejoins with a new seat, and are split across an account's seats.
*   **Reason for Rejection**: Decision 14.

### Alternative S [A]: Longer surface items instead of files

*   **Pros**: No new store or tool.
*   **Cons**: Surface items carry canvas layout and count toward the 1,000-item cap; they have no paths, per-path history or stale check.
*   **Reason for Rejection**: Documents and memory need paths and history.

## Risks and Mitigations

| ADR | Risk | Mitigation |
|---|---|---|
| A | Memory is readable by the room by default, because `read_context` is granted by default | The docs and the room-files guide say so; an account withholds it from every seat to keep notes private |
| A | A memory file's name or activity leaks through a listing, search or event | The memory rule on every path (§3), each listed in `tests/delivery-paths.test.ts`; the room socket never receives them |
| A | Rolling back PR 3 after files exist leaves `fs` events that old code would deliver to every peer | The delivery rule ships alone in PR 2, a deploy ahead, and is never rolled back with PR 3 (ADR A's rollback note) |
| B | Two apps with the same bundle share one loaded worker and its `env` | The loader id carries room, app, version and capability hash (§5) |
| B | App code acts with a viewer's authority, or reuses a viewer's token | viewer ∩ author ∩ scope on every call; tokens expire in 60 seconds; room writes need a human every version; no writes to `/members/**`; click to run |
| B | App pages send data from the viewer's browser | The app CSP (with `worker-src 'none'`) and the dash frame sandbox; WebRTC remains, so the approval screen and docs say an app with `env.ROOM` can show what it reads to a viewer's browser |
| B | A service worker serves responses without the CSP, answers `/__bellman/enter`, or outlives its version | `worker-src 'none'`; the apps Worker refuses `Service-Worker: script` requests; a test checks that registration fails on live and preview origins |
| B | Preview code, which no gate has checked, reads the live app's browser storage | Previews run on the separate `p-<app id>` origin |
| B | One app sets a cookie on `gettwin.xyz` that sibling apps receive, or floods cookies to break them | Server `Set-Cookie` with `Domain` is stripped; incoming cookies without the `__Host-` prefix are dropped before app code; flooding remains until `gettwin.xyz` is on the Public Suffix List, submitted before allowlisted users |
| B | App code reads a viewer's user id | Assertions and request tokens carry seat ids only, never `sub` or `Identity` |
| B | Phase B: an app with `room` read sends data out through a `GET` query string without a human | The approval screen says so for every host; requiring a human on every such version is an owner decision at PR 10 |
| B | The LLM reviewer is talked into a pass | It is never the boundary: the bindings, the approved record, the CSP and (phase B) the egress Worker are |
| B | A secret written before #415 lands reaches Artifacts and may never be removable | #415's detectors run on write once they exist; until then the docs warn authors, and Cloudflare's purge answer is pending |
| B | Worker Loader or Artifacts do not work as assumed | The spike answers first; Alternative C is the source fallback; ADR A does not depend on either |
| B | Deleting an Artifacts repo may leave its snapshots | Cloudflare's written answer before launch; `reposSwept` retries; the privacy docs state the gap |
| B | A commit lands but the room never records it | One writer per app; the push expects the old head; heads are adopted from Bellman's commit trailers; anything else marks the app `diverged` |
| B | A busy app loads its room's `SessionDO` | One `SessionDO` read per app request and no writes except `env.ROOM` writes, which pass the send limit; read counters, logs and `env.AI` usage live in `AppDO`; viewers must hold seats |
| B | A runaway app runs up cost | Caps refuse calls before they run; kill flags on every call; apps are paid-only |
| B | Apps host phishing or malware | No anonymous URLs; viewers hold seats; the kill switch; the room's report route |

## Cost and Scale

Cloudflare prices from its docs as of 2026-10-31. Values marked *starting value* are set in the ADRs and can change.

| ADR | Item | What drives it | Price or limit |
|---|---|---|---|
| A | Room files | File rows and 20 revisions per path in `SessionDO` | 64 KiB per file; `fsBytesPerRoom` 1 MiB `free`, 50 MiB `pro`, 500 MiB `max` and `team` (*starting values*) |
| B | Dynamic Workers | Each distinct loader id (version × approved set) that runs on a day, live versions included, and each previewed version | 1,000 distinct Workers a month included per account, then $0.002 per Worker per day; CPU billed including startup |
| B | Artifacts | Commits and source reads | 10,000 operations a month included per account, then $0.15 per 1,000; 1 GB-month included, then $0.50 per GB-month; 1 GB per repo, 32 MiB per file |
| B | R2 bundles | One object per checked or previewed version | Standard R2 storage; 5 MB per bundle |
| B | LLM review | One reviewer call per `check` not already cached | At most 100,000 input tokens per check; Claude Haiku 5.5 at $0.10 per million input and $0.50 per million output tokens (prompts up to 100,000 tokens), charged to the room |
| B | `env.AI` | Model calls apps make | The approved budget per app, metered like host units |
| B | `AppDO` | Commits and gate builds (CPU), app database storage | Durable Object pricing; 1 GB of storage per app (*starting value*) |
| B | Checks and previews | Agents iterating | 100 checks and 200 previews per room per day (*starting values*) |
| B | Apps per room | The plan's `appsPerRoom` | 0 on `free`, 20 on paid plans (*starting values*) |
| B | Egress (phase B) | Outbound calls through the egress Worker | Workers requests and CPU; capped per app (§8) |

**Per-room estimate for one active app-building room** (assumptions: 20 commits, 20 checks and 40 previewed versions a day; half the checks need the LLM review at 30,000 input and 2,000 output tokens; 2 live apps viewed daily):

*   Dynamic Workers: about 42 distinct loader ids a day (40 previews, 2 live) × $0.002 ≈ $0.08 a day, $2.52 a month once the account's included 1,000 are used.
*   LLM review: 10 reviews a day, 300 a month: 9 million input tokens × $0.10 per million = $0.90, plus 600,000 output tokens × $0.50 per million = $0.30, about $1.20 a month.
*   Artifacts: about 600 commits (20 a day) and a few thousand reads a month, within or near the account's included 10,000 operations.
*   R2 and `AppDO` storage: under a gigabyte, cents a month.

About $4 a month for a busy room. Loaded workers cost the most; the daily preview and check caps bound them.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

Checked against `origin/main` at `a21cd779`. Ten PRs, numbered in landing order. Every PR runs `npm run verify` (`typecheck:ui`, `typecheck`, `typecheck:worker`, `build`, `test`, `test:worker` and `test:mod`). A PR that changes a tool's definition runs `npm run docs:gen` and adds a row to ARCHITECTURE §11's budget table; a PR that adds a tool also edits `extension/manifest.json`. Every PR that adds a Workers-only file adds it to the `exclude` list of both `tsconfig.json` and `tsconfig.test.json`. Every PR that adds a Durable Object class or `WorkerEntrypoint` exports it from `src/worker.ts`.

**Prerequisites, not part of this plan:** #414 has merged. The spike (Open Questions) must have finished before PR 4.

**Order:** PR 1 needs #414. PR 2 needs PR 1. PR 3 needs PR 2 to be deployed. PR 4 needs PR 1 and the spike's written answers. PR 5 needs PRs 3 and 4. Each of PRs 6–9 needs the one before it. PR 10 needs PR 9, #191 (secret custody), and the logs, caps and kill switches running in production for allowlisted users. The filesystem (PRs 1–3) can ship before the spike finishes.

### PR 1: ADR A (room filesystem) and plan edits [A]

#### 1. `docs/adr/00NN-room-filesystem.md` (Create)

*   **Type / Scope**: Architecture decision record.
*   **Proposed Changes**: Decisions 1, 7, 8 (files part), 12 and 14; the namespaces; `write_surface` as the write verb; the memory rule and every path it covers; a write whose `base_rev` is not the current revision is refused as `stale`, and a write without `base_rev` only creates; 64 KiB per file and 20 revisions; `find` by path name only; the quota; purge; Alternatives P–S and A. **Rollback note:** the delivery rule (PR 2) is never rolled back while `fs` events exist; a rollback of PR 3 keeps it. "Supersedes" lists #430's original storage paragraphs, `writeRow`, `/public/**`, fs-06's E2E gate and "after #380". The number is checked against `origin/main`, every open PR and every local branch (`git for-each-ref` over `docs/adr`) when the PR opens.

#### 2. `GLOSSARY.md` (Create)

*   **Type / Scope**: Domain glossary (created lazily, per `docs/agents/domain.md`).
*   **Proposed Changes**: The filesystem terms: account, seat, room file, memory id, room socket. PR 4 adds the app terms.

#### 3. `docs/ARCHITECTURE.md` (Modify)

*   **Type / Scope**: System documentation.
*   **Proposed Changes**: §5 Storage gains room files (`fs:`, `fsh:`, `mi:` rows). §7 Trust boundaries gains the memory rule.

#### 4. GitHub issue #430 (Modify, through `gh`)

*   **Type / Scope**: Plan of record.
*   **Proposed Changes**: Point #430 at ADR A; move the superseded paragraphs under a "Superseded" heading; open sub-issues for PRs 2 and 3.

### PR 2: The memory delivery rule [A]

Ships a deploy ahead of PR 3, so no rollback of PR 3 can leave `fs` events without it.

#### 5. `src/types.ts`, `src/attention.ts` (Modify)

*   **Type / Scope**: Shared types; attention table.
*   **Proposed Changes**: The `fs` event type (path, revision, size, op; never content), `FsRow` (path, revision, content, size, media type, writer seat id and label, written at, deleted flag) and `FsHistoryRow`. `ATTENTION` gains `fs: "ambient"`, as `surface` is (the table is `satisfies Record<EventType, Attention>`, so the build fails without it).

#### 6. `src/public-event.ts`, `src/rooms.ts`, `src/store-do.ts` (Modify)

*   **Type / Scope**: Delivery filters and their callers.
*   **Proposed Changes**: A new predicate, `seesMemory(accountSeats, reader, { ownAccount })`. It returns true when `ownAccount` is allowed and the reader is one of the account's seats; otherwise only when every seat the account holds grants `read_context`, or, if it holds none, every seat it held granted when it left or was evicted. It returns false for a null reader (the room socket). `readableEvent` gets its own branch for `fs` events on `/members/**` (not through `carriesBrief`, whose branch would return the event with a null brief instead of dropping it): it drops the events `seesMemory` refuses. The rows come from `membersOfUser(sessionId, event.fromUserId)` (`handlesOf` in `src/rooms.ts` wraps it), loaded where `eventsFor` (`src/rooms.ts`) loads brief authors today; the other `readableEvent` callers in `src/rooms.ts` and the two socket paths in `src/store-do.ts` pass the same rows. `publicReadEvent` returns null for every `fs` event. `seesMemory` is exported for `list`, `history`, `find` and `env.ROOM` (which passes `ownAccount: false`).

#### 7. Tests for PR 2

*   `tests/delivery-paths.test.ts`: `fs` events on `/members/**` reach the account's own seats and, when every seat grants, peers; never a peer when any seat withholds; never the room socket; no `fs` event at all through `publicReadEvent`.
*   `tests/attention.test.ts`: covers `fs`.
*   `tests/projections.test.ts`: passes unchanged.

### PR 3: Room files [A]

#### 8. `src/fs-path.ts` (Create)

*   **Type / Scope**: Runtime-free module.
*   **Proposed Changes**: `normalizePath(raw)` returns a path or a refusal (NFC, collapsed slashes, no `.`/`..`/empty segments/control characters, at most 512 characters and 32 segments). `namespaceOf(path)` returns `memory` (with the memory id), `bellman`, `app` (with the key) or `room`.

#### 9. `src/types.ts`, `src/stored-session.ts` (Modify)

*   **Type / Scope**: Room types and the stored room record.
*   **Proposed Changes**: `fsBytesCeiling` on `Session` beside `blobBytesCeiling`, and `fsBytesPerRoom` on `Entitlements` beside `blobBytesPerRoom`. `fsBytes` and `fsBytesCeiling` on `StoredSession`; `hydrateStoredSession` defaults `fsBytes` to 0 and `fsBytesCeiling` to the `free` plan's value, as it does for `blobBytesCeiling`, and its doc comment's field count is updated.

#### 10. `src/auth.ts`, `src/tools/start.ts`, `tests/auth.test.ts` (Modify)

*   **Type / Scope**: Plans and room creation.
*   **Proposed Changes**: `fsBytesPerRoom` beside `blobBytesPerRoom` in each plan: 1 MiB `free`, 50 MiB `pro`, 500 MiB `max` and `team` (written as `n * 1024 * 1024`, as the blob ceilings are). `start` stamps `fsBytesCeiling` where it stamps `blobBytesCeiling`. `tests/auth.test.ts`, which pins the differences between plans, gains the new field.

#### 11. `src/fs.ts` (Create), `package.json` (Modify)

*   **Type / Scope**: Runtime-free module; the `diff` dependency.
*   **Proposed Changes**: Planning for each op: the 64 KiB cap; `decideFsCharge` (beside `decideBlobCharge`, charging the net change: new rows minus pruned history, a delete giving its bytes back); the `base_rev` comparison (no `base_rev` means create-only); `diffText(a, b)` with the `diff` package (unified, 3 lines of context, cut at 64 KiB with `truncated: true`), added to `package.json` here; `edit` (exactly one match of the old string, else refuse); `append`; authorization by namespace (memory paths writable only by the account's seats; `/.bellman/**` refused with the dash route; `/apps/**` refused until PR 5; other paths need `write_surface`); reads of memory paths through `seesMemory`.

#### 12. `src/rooms.ts` (Modify)

*   **Type / Scope**: Room operations.
*   **Proposed Changes**: `RoomFailure` gains `stale` (409), `too_large` (413) and `over_quota` (413, with `used` and `ceiling`), mapped to HTTP in `STATUS` (`src/http/rooms.ts`) and matching the wire codes the blob routes return (`overQuota`). `writeFs`, a sibling of `writeSurface` (which is not changed): `gateSeat`, `src/fs.ts`'s authorization, `admitSend` (the per-seat send limit, in the same place `writeSurface` calls it), `auditEntries("fs_write", …)` with path, revision, op, size and content hash, then `store.appendFs`.

#### 13. `src/store.ts` (Modify)

*   **Type / Scope**: Storage boundary and `MemoryStore`.
*   **Proposed Changes**: Async `BellmanStore` methods: `readFs(sessionId, path, rev?)`; `listFs(sessionId, prefix, cursor?)`, 100 entries a page; `fsHistory(sessionId, path, before?)`; `findFs(sessionId, query, cursor?)` (path names only, at most 20 results); `appendFs(sessionId, write, audit)`, which takes the path, `base_rev`, content or op, seat and optional idempotency key, and in one step compares the revision, writes the file and history rows, prunes history past 20, charges the net change in `fsBytes`, appends the event and the audit entries, and returns `ok`, `stale`, `over_quota`, `too_large`, `conflict` or `replayed`. `memoryIdOf(sessionId, userId)` returns the account's memory id or none, and never writes; `appendFs` assigns one (16 hex characters, from the generator `newBlobId` uses) on the account's first write under `/members/`. `memoryIdOwner(sessionId, memoryId)`. `MemoryStore` implements them.

#### 14. `src/store-do.ts` (Modify)

*   **Type / Scope**: Durable Objects store (Workers-only).
*   **Proposed Changes**: `SessionDO` implements the methods over `fs:`, `fsh:` and `mi:` rows inside the transaction that appends the event, using the existing idempotency rows. Purge deletes them with the room's storage.

#### 15. `src/projections.ts` (Modify)

*   **Type / Scope**: Wire projections.
*   **Proposed Changes**: `fsEntry(row)` and `fsFile(row)` wrap content with `untrusted()` and set `origin` to the server-stamped writer seat. `find` results (paths, writer labels) are wrapped the same way.

#### 16. `src/governed-view.ts` (Create)

*   **Type / Scope**: Runtime-free module.
*   **Proposed Changes**: Renders `/.bellman/**` from `getGovernedConfig` (#414) on read: `room.md` and one Markdown file per other config name. Never writes rows. PR 9 adds `guide/apps.md`.

#### 17. `src/tools/fs.ts` (Create)

*   **Type / Scope**: MCP tool.
*   **Proposed Changes**: `bellman_fs` with the PR 3 ops: `read`, `list`, `write`, `edit`, `append`, `delete`, `restore`, `history`, `find`. Input schema (each field used only by the ops named):
    *   `session_id`, `member_id` (the acting seat, as every tool), `op`, `idempotency_key` (writes).
    *   `path` (at most 512 characters); `content` (`write`, `append`; at most 64 KiB); `base_rev` (writes; absent means create-only); `old` and `new` (`edit`; each at most 64 KiB); `rev` (`read`, `restore`); `from` and `to` (`history` diff); `prefix` and `cursor` (`list`, `history`, `find`); `query` (`find`; at most 200 characters, bounds through `checkQuery` in `src/search.ts`).
    *   Added by PR 5: `files` (app writes: up to 50 entries of `{path, content}` or `{path, delete: true}`) and `base` (the app version read). By PR 7: `version` (`check`, `status`). By PR 8: `version` for `logs` and `call`, and `request` (`call`: method, path, headers, body at most 64 KiB).
    *   `list`, `history` and `find` drop memory paths `seesMemory` refuses; `find` matches path names only and filters before ranking and counting. Whole definition at most 600 tokens including the PR 7–8 ops (`check`, `status`, `logs`, `call`). Refusals: a stable code, the current state, one next step.

#### 18. `src/server.ts` (Modify)

*   **Type / Scope**: Server composition.
*   **Proposed Changes**: Import `./tools/fs.js` and call `registerFs(server, identity, s)` in `buildServer`.

#### 19. `src/http/rooms.ts` (Modify)

*   **Type / Scope**: HTTP routes for the dash.
*   **Proposed Changes**: `GET /rooms/:id/files?prefix=&cursor=` and `GET /rooms/:id/files/*path?rev=`; `PUT` (body `{ content, base_rev }`) and `DELETE` (`?base_rev=`) on the same path. Writes take `?member_id=` and follow the surface write routes' order: `findMember` (404), `adminWriteRefusal`, then `writeFs`. Writes accept only a session cookie (an explicit refusal when `who.via !== "cookie"`) and pass `csrfRefusal`'s Origin check. Each `RoomFailure` maps to its HTTP status through `STATUS`.

#### 20. `extension/manifest.json` and `docs-site/src/content/docs/reference/tools/` (Modify; Generated)

*   **Type / Scope**: Desktop bundle; generated reference.
*   **Proposed Changes**: Add `bellman_fs` to the manifest (`tests/extension.test.ts` asserts it); `npm run docs:gen` writes its page.

#### 21. `docs-site/src/content/docs/guides/room-files.md` (Create)

*   **Type / Scope**: Docs site guide.
*   **Proposed Changes**: Files, memory and `/.bellman/`; who can read what; that memory is room-readable while `read_context` is granted; that a shared memory id links an account's seats; that the docs ask for no personal records.

#### 22. `CLAUDE.md` and `docs/ARCHITECTURE.md` §11 (Modify)

*   **Type / Scope**: Agent instructions; token budget.
*   **Proposed Changes**: Layout lines for `src/fs*.ts`, `src/governed-view.ts`; the budget row for `bellman_fs`.

#### 23. Tests for PR 3

*   `tests/fs-path.test.ts`: table tests and a seeded random loop (no new dependency) checking that no normalized path escapes its root or contains `..`; a path with a colon round-trips through `fsh:` keys.
*   `tests/fs.test.ts`, through `tests/helpers/harness.ts`: CUJ 1 end to end; `edit` refuses zero or several matches; memory paths refuse other accounts' writes; `/.bellman/` refuses writes; frozen, evicted and departed cases refuse; a write without `base_rev` on an existing path is `stale`; history keeps 20 revisions, counts against the quota, and pruning gives bytes back; `over_quota` and `too_large` refusals; a seat past its send limit is refused as `rate_limited`; `find` never matches file content; reads never assign a memory id; `replayed` and `conflict` for idempotency keys; CUJ 2 end to end, including a rejoin and two seats of one account sharing a memory id; an account with one granting and one withholding seat is refused to peers; no path, event or listing contains a user id.
*   `tests/delivery-paths.test.ts`: `read`, `list`, `history` and `find` join the memory paths.
*   `tests/helpers/store-contract.ts`: the new store methods, so both stores pass identically.
*   `worker-tests/fs-routes.test.ts`: the file routes refuse bearer tokens on writes and a request without an allowed Origin; an unknown `member_id` is 404; each `RoomFailure` maps to its HTTP status.
*   `tests/governed-view.test.ts`: rendering from #414's rows; writes refused.
*   `worker-tests/purge.test.ts`: purge removes file and memory-id rows.
*   `tests/working-surface.test.ts` and `worker-tests/surface-rows.test.ts` pass unchanged.

### PR 4: ADR B (apps) and plan edits [B]

#### 24. `docs/adr/00NN-room-apps.md` (Create)

*   **Type / Scope**: Architecture decision record.
*   **Proposed Changes**: Decisions 2–6, 8 (source part), 9–11, 13, 15–18; the spike's written answers; the runtime, bindings and threat model; the lifecycle; capability approval; phase B; the apps domain; purge of app storage with the room; Alternatives B–O, plus alternatives for decisions 13 and 15–18 written in the ADR (a bought domain now, Facets, a Workflow gate, intent rows, clone tokens). "Supersedes" names each paragraph in #430 (code execution and html file access), #448, #394, #380 decision 2, #381 D7 and #392/#393. Rollback note per ADR 0043's style: old code reads an `app` row as an unknown kind. Numbered after ADR A, checked the same way.

#### 25. `GLOSSARY.md`, `docs/ARCHITECTURE.md`, issues #448, #394, #380, #381, #392, #393 (Modify)

*   **Type / Scope**: Glossary, system documentation, plan of record.
*   **Proposed Changes**: Glossary: app, app key, app id, app author, version, capability set, base set, current approved set, verdict, click to run, preview, kill flag. ARCHITECTURE: §5 gains app records and `AppDO`; §7 the apps domain, the viewer session, the request token and the capability record; §9 the app write (commit, then record) and publish (compare-and-set against a verdict). Issue bodies point at ADR B and move superseded paragraphs under a "Superseded" heading; #430 gets sub-issues for PRs 5–10.

### PR 5: App source [B]

#### 26. `src/tree-store.ts`, `src/apps/app-host.ts` (Create)

*   **Type / Scope**: Runtime-free seams plus their memory implementations.
*   **Proposed Changes**: `TreeStore`: `readFile(app, version, path)`, `readTree(app, version)`, `commit(app, base, changes, trailers)` returning `{ version, providerRef }` (`providerRef` is the Artifacts commit SHA) or stale, `log(app, before?)`, `diff(app, from, to)` (through `diffText`), `purge(app)` returning confirmed; `MemoryTreeStore`. `AppHost`: `write(room, key, base, changes, seat)` and `check(room, key, version)`, one call at a time per app, and `read(room, key, version, path)`, `tree(room, key, version)`, `log(room, key, before?)`, `diff(room, key, from, to)`, which go to `TreeStore`; `MemoryAppHost`, a promise queue per app over `MemoryTreeStore`, used by tests and the Node server, whose `check` answers `apps_not_available`.

#### 27. `src/tree-store-artifacts.ts` (Create; Workers-only)

*   **Type / Scope**: Artifacts implementation.
*   **Proposed Changes**: One repo per app, created by its first commit. Reads through the binding (`readFile`, `readTree`, `log`). Commits with isomorphic-git inside `AppDO`, pushing with the expected head. The commit message is built entirely here: a fixed subject and the three Bellman trailers, with no agent-supplied text. Diff through `diffText`. `purge` deletes the repo and confirms only once a read returns not found.

#### 28. `src/apps/app-do.ts` (Create; Workers-only)

*   **Type / Scope**: Durable Object class `AppDO`, one per app, named by (room id, app key).
*   **Proposed Changes**: The single writer for the app's source (an in-object queue), calling `TreeStore.commit`; the Worker's `AppHost` is a stub to it. Holds the app's database in its own SQLite storage. Runs the gate on its alarm (PR 7). Purge deletes its storage. PR 6 adds the rest (item 41).

#### 29. `src/apps/manifest.ts` (Create)

*   **Type / Scope**: Runtime-free module.
*   **Proposed Changes**: The zod schema for `app.json` (entry files, compatibility date, `db` or `room` with scope, `ai` budget in tokens a month; phase B `hosts` and `secrets`). `capabilitySetOf`, `withinSet(requested, current)` implementing §7's subset rules, `writesRoom(set)`, the `db`-with-`room` refusal, the base set constant, `versionHash(files)`, and `capabilityHash(set)` using `canonical()`.

#### 30. `src/decision.ts` (Modify)

*   **Type / Scope**: Shared helper.
*   **Proposed Changes**: Export `canonical()` for `capabilityHash`.

#### 31. `src/types.ts`, `src/surface.ts`, `ui/src/types.ts`, `ui/src/canvas.ts` (Modify)

*   **Type / Scope**: The `app` surface kind.
*   **Proposed Changes**: `app` in the `SurfaceKind` union, in `SURFACE_KINDS` and in `PLACED_KINDS`, with a strict shape: `key` (the app key), `title`, `placement`, `app: { version }`. `html` keeps refusing `app` fields. The MCP App page draws an `app` item as an inert card with a link to the dash, as it does for `widget`. Until PR 7, `normalizeSurfaceWrite` and `normalizeSurfaceBatch` (`src/surface.ts`) return `{ ok: false, reason: "apps_not_enabled: …" }` for `app` items, and `checkProposal` (`src/rooms.ts`) refuses a proposal holding one. Removing an `app` item is refused from PR 5 on.

#### 32. `src/store.ts`, `src/store-do.ts`, `src/types.ts`, `src/auth.ts`, `src/tools/start.ts`, `src/stored-session.ts`, `tests/auth.test.ts` (Modify)

*   **Type / Scope**: App records and the per-room app cap.
*   **Proposed Changes**: An `app:<key>` row per app: app id and a `registered` flag, head version, provider ref, current approved set, version-to-bundle-hash map, verdicts, state and author per version, pending version with its surface item, app flag, and the `diverged` app state. Async methods in the contract suite:
    *   `createApp(sessionId, key, seat, audit)`: refuses past `appsCeiling`, and reserves the row and a 20-character lowercase hex app id in one transaction.
    *   `recordAppHead(sessionId, key, version, providerRef, files, audit)`: records the head and appends one `fs` event for the version (§4) and the audit entries in one transaction.
    *   `readApp(sessionId, key)` (the row plus the room's app flag) and `listApps(sessionId)`.
    *   New refusal codes, each in `RoomFailure` and mapped in `STATUS`: `apps_not_enabled` 403, `apps_not_available` 501, `diverged` 409 (PR 5); `not_checked` 409, `check_failed` 422 (with findings), `pending_approval` 202 (with `approver_role` and `link`) (PR 7).
    *   `RegistryDO` gains `registerAppId`, `resolveAppId` and (PR 8) `purgeAppIds(sessionId)`. A failed `registerAppId` is retried on the next write to that app.
    *   `appsPerRoom` on `Entitlements` (0 on `free`, 20 on the paid plans); `appsCeiling` on `Session`, stamped in `tools/start.ts` and defaulted to 0 in `hydrateStoredSession`.

#### 33. `src/tools/fs.ts`, `src/fs.ts`, `src/server.ts`, `src/worker.ts`, `src/app.ts`, `src/store-do.ts`, `src/http/rooms.ts`, `tests/helpers/harness.ts`, `tests/helpers/tool-lists.ts` (Modify)

*   **Type / Scope**: The app read and write paths and their wiring.
*   **Proposed Changes**: `buildServer` takes an optional `AppHost`; with none, every op on `/apps/**` answers `apps_not_available`, so the seven bridge tests that call `buildServer` need no change. `src/worker.ts` and `src/store-do.ts` pass the `AppDO` stub; `src/app.ts` and the two test helpers pass `MemoryAppHost`. `read`, `list` and `history` on `/apps/<key>/**` take `version` (a version hash) instead of `rev` and go through `AppHost`'s reads; `status` and `list` return the head version. The dash file routes (`PUT`/`DELETE /rooms/:id/files/*path`) refuse `/apps/**`. Writes under `/apps/<key>/` check the allowlist (§4), need `write_surface`, run #415's detectors (skipped until #415 lands), call `createApp` on the first write, then `AppHost.write` commits and `recordAppHead` records. A write behind the head applies when none of its paths changed since `base`. A head with Bellman trailers that the record does not name is adopted and audited as the trailer's seat; any other head marks the app `diverged` and refuses writes.

#### 34. `src/worker.ts`, `src/store-do.ts` (`BellmanEnv`), `wrangler.toml`, `worker-tests/wrangler.toml`, `worker-tests/vitest.config.ts` (Modify)

*   **Type / Scope**: Bindings and exports.
*   **Proposed Changes**: Export `AppDO`. Add the Artifacts binding and the `AppDO` Durable Object binding to `BellmanEnv` (which `WorkerEnv` extends). `wrangler.toml`: `[[durable_objects.bindings]]` for `AppDO` and migration tag `v4` with `new_sqlite_classes = ["AppDO"]`. The test config adds `AppDO` to its single `v1` migration list and passes the bindings.

#### 35. `tsconfig.json`, `tsconfig.test.json`, `package.json` (Modify)

*   **Type / Scope**: Build configuration and dependencies.
*   **Proposed Changes**: Exclude `src/tree-store-artifacts.ts` and `src/apps/app-do.ts` in both. Add `isomorphic-git`; record its bundle size in the PR.

#### 36. Tests for PR 5

*   `tests/helpers/tree-store-contract.ts` and `tests/tree-store.test.ts` (memory); a gated job for Artifacts that runs only with credentials.
*   `tests/apps-manifest.test.ts` (runtime-free): schema; the same files in any order give the same version hash and any byte change changes it; `withinSet` for each subset rule; `writesRoom`; the `db`/`room` refusal.
*   `tests/fs.test.ts` (on `MemoryAppHost`): `read`, `list` and `history` of app files at a version, and a diff between two versions; `list` returns the head version; one `fs` event per write, listing the changed files; app writes need `write_surface`; a room whose creator is not allowlisted is refused while `BELLMAN_APPS` is off; `check` on the Node host answers `apps_not_available`; removing an `app` item is refused; a server built without an `AppHost` answers `apps_not_available`; a secret refuses the write (when #415 is present); a behind-head write with no overlap applies; an overlapping one is refused; a room at its `appsCeiling` refuses a new app key; a free-plan room refuses the first app write; two concurrent writes to one app apply one after the other.
*   `tests/auth.test.ts`: `appsPerRoom` per plan.
*   `worker-tests/app-writes.test.ts`: two concurrent writes to one app apply one after the other; a commit whose record step fails is adopted from its trailers by the next write and audited; a head without trailers marks the app `diverged`; a commit message never contains text from the write.
*   `tests/working-surface.test.ts`: the `app` kind's shape; `html` refuses app fields; `app` items are refused through `writeSurface`, the batch path and a proposal until PR 7.

### PR 6: Runtime, phase A [B]

#### 37. `src/apps/bindings.ts` (Create)

*   **Type / Scope**: Runtime-free contract.
*   **Proposed Changes**: The binding contract apps are written against, as types and constants, versioned by the compatibility date in `app.json`. PR 9's guide documents this table.

    | Binding | Method | Returns | Notes |
    |---|---|---|---|
    | `env.DB` | `prepare(sql).bind(...values)` → statement with `all()`, `first(column?)`, `run()`, `raw()` | D1's result shapes (`results`, `meta`) | D1's statement API, over `AppDO`'s `ctx.storage.sql` |
    | `env.DB` | `batch(statements)` | one result per statement | one transaction |
    | `env.DB` | `exec(sql)` | `{ count }` | schema changes |
    | `env.ROOM.as(request)` | `readFile(path, rev?)`, `listFiles(prefix, cursor?)` | `bellman_fs`'s `read` and `list` wire shapes | read scope; memory rule with no own-account exemption |
    | `env.ROOM.as(request)` | `events({ kinds, after?, limit })` | `bellman_sync`'s event shapes through `readableEvent` | read scope; `limit` at most 100 |
    | `env.ROOM.as(request)` | `writeFile(path, content, base_rev?)`, `deleteFile(path, base_rev)` | `bellman_fs`'s write result | write scope; refused under `/members/`, `/apps/` and `/.bellman/` |
    | `env.ROOM.as(request)` | `send({ text })` | `{ cursor }` | write scope; a `message` event stamped `via: app:<key>@<version>` |
    | `env.AI.as(request)` | `run({ model, messages, max_tokens })` | `{ text, usage }` | `model` from an allowlist constant (starting with `claude-haiku-5-5` and `claude-sonnet-5-5`); input plus output tokens count against the budget |

    No other operation exists: never `vote`, `request_actions`, `respond_actions`, `govern` or `provision_*`. Every write is stamped `via: app:<key>@<version>`, a new optional `via` field on `SessionEvent` and `FsRow` (`src/types.ts`), shown by `src/projections.ts`. Errors are `{ code, message, retryAfter? }` with codes `db_error` (with SQLite's message), `db_full` (past 1 GB), `author_lacks_access`, `scope_refused`, `app_disabled`, `budget_exceeded`, `model_not_allowed`, `rate_limited` (with `retryAfter`), `token_expired`, and the `RoomFailure` codes a room write returns.

#### 38. `src/apps/viewer-assertion.ts` (Create), `src/oauth/tokens.ts` (Modify)

*   **Type / Scope**: Runtime-free module.
*   **Proposed Changes**: A narrow `AppClaims` type, signed and verified with `signJwt`/`verifyJwt` under `BELLMAN_TOKEN_SECRET` but never carrying `Claims`' `sub` (a user id) or `bellman` (`Identity`): the viewer assertion (audience `bellman:apps`; room, app, version, seat id, `preview`; single-use `jti`; expires 5 minutes after issue) and the request token (audience `bellman:apps-request`; room, app, version, seat id; expires 60 seconds after issue). `signJwt` requires `Claims`' `sub` and `bellman`, so `src/oauth/tokens.ts` (Modify) exports its `hmacKey` helper (`base64url` is already exported) and this file signs with them.

#### 39. `src/apps/worker.ts` (Create; Workers-only)

*   **Type / Scope**: The apps-domain request handler. The apps Worker is this handler inside Bellman's one Worker, chosen by hostname in `src/worker.ts`.
*   **Proposed Changes**:
    *   Resolve `<app id>.<apps domain>` and `p-<app id>.<apps domain>` (strip `p-`; a preview origin serves only previews) through `RegistryDO`, cached in memory.
    *   Serve `/__bellman/enter` (accepts `postMessage` only from `https://dash.bellman.sh`) and `/__bellman/session` (consumes the `jti` in `AppDO`, sets the `__Host-bellman_viewer` cookie with `Max-Age=300`, carrying the assertion's version).
    *   Refuse any request carrying `Service-Worker: script`.
    *   On every other request: check `BELLMAN_APPS` and the allowlist; make one `SessionDO` read for the app record and the app and room flags; verify the cookie and serve the version it names; remove that cookie and every cookie whose name lacks `__Host-`; replace any `x-bellman-request` with the request token; load the bundle from R2 with `LOADER.get("<room>:<app>:<version hash>:<capability hash>")` and the bindings the approved set allows, `globalOutbound` refusing everything.
    *   On the response: replace the CSP with §5's (with `worker-src 'none'`), and strip any `Set-Cookie` with a `Domain` attribute or the reserved name.
    *   A `stopped` version serves the paused page.
    *   Previews: same flow with `preview: true` on the preview origin, built in the request on first open, no `env.AI`, `env.ROOM` or network, the preview database (the session route counts the preview, item 43).

#### 40. `src/apps/room-binding.ts`, `src/apps/ai-binding.ts`, `src/apps/db-binding.ts` (Create; Workers-only), `src/types.ts`, `src/projections.ts` (Modify: the `via` field)

*   **Type / Scope**: Binding entrypoints, bound at load with props `{room, app, version, capability hash}`.
*   **Proposed Changes**: Each implements item 37's table and refuses calls on a request whose `SessionDO` read found a kill flag. `room-binding`: verifies the request token; checks the viewer seat and the version author's seat through `gateSeatRead` (item 41) and the verb check each operation needs, and the approved scope; event reads through `readableEvent`; memory reads through `seesMemory` for both seats with `ownAccount: false`; refuses writes under `/members/`, `/apps/` and `/.bellman/`; writes pass `admitSend` for the viewer seat in the write transaction; reads are capped at 120 a minute per app per viewer, counted in `AppDO`. `ai-binding`: verifies the token; checks the model allowlist; meters through the AI Gateway with `decideHostCharge`'s pattern, counted per app in `AppDO`; refuses past the budget. `db-binding`: calls the app's `AppDO` storage. The entrypoints that verify tokens are typed against `WorkerEnv`, which holds `BELLMAN_TOKEN_SECRET`.

#### 41. `src/rooms.ts`, `src/apps/app-do.ts` (Modify)

*   **Type / Scope**: Room operations; `AppDO`'s runtime duties.
*   **Proposed Changes**: `gateSeatRead(store, sessionId, memberId)`, written fresh rather than copied from `gateSeat`, taking no `Identity` (the bindings hold only seat ids): the room exists and is not closed, and the seat, read from `session.members` or `store.getMember` (not `findMember`, which requires an identity), has `leftAt === null`. No verb check, no frozen check (reads continue in a frozen room) and no `touchMember`. `AppDO` gains: consuming viewer-assertion `jti`s, serving `env.DB`, preview databases under a preview prefix deleted after 24 hours, the per-viewer read counters and the per-app `env.AI` usage.

#### 42. `src/apps/bundle.ts` (Create; Workers-only)

*   **Type / Scope**: Build.
*   **Proposed Changes**: Read the tree at a version, bundle with `@cloudflare/worker-bundler`, hash the bytes, refuse over 5 MB, store under `apps/<room>/<key>/<bundle hash>` in the app-bundle bucket, and record the version-to-bundle mapping with `recordAppBundle(sessionId, key, version, bundleHash)`.

#### 43. `src/http/apps.ts` (Create)

*   **Type / Scope**: HTTP routes for the dash, mounted in `roomRoutes` (`src/http/rooms.ts`).
*   **Proposed Changes**: Both routes check the allowlist (§4) and pick the acting seat by §7's seat rule (the account's oldest active seat, in `yourSeats`' order, whose role holds the verb the route needs). `POST /rooms/:id/apps/:key/run` records a Run click with `recordRun(sessionId, key, seat, setHash)`. `POST /rooms/:id/apps/:key/session` checks `hasRun` for the current set hash (or, for a preview, a seat whose role holds `write_surface`, counted by `countPreview`), and mints the assertion naming the version live now (or the previewed version). Both refuse when `who.via !== "cookie"` and pass `csrfRefusal`'s Origin check.

#### 44. `src/worker.ts`, `src/app.ts`, `src/host.ts`, `src/store.ts`, `src/store-do.ts` (Modify)

*   **Type / Scope**: Wiring, switches and counters.
*   **Proposed Changes**: `src/worker.ts` dispatches the apps domain to `src/apps/worker.ts` and exports the binding entrypoints. `src/app.ts` (the Node server) answers previews, serving and `call` with `apps_not_available`. `hostedSeatOn` and `hostedSeatUsers` are generalized to take the var's name, and `appsFor(creatorUserId, …)` (switch plus allowlist, checked against the room creator) sits beside `hostedSeatFor`. Store methods in the contract suite: `recordAppBundle`, `recordRun`/`hasRun`, `countPreview(sessionId)` (200 a day, refusing `rate_limited`).

#### 45. `src/store-do.ts` (`BellmanEnv`), `wrangler.toml`, `worker-tests/wrangler.toml`, `worker-tests/vitest.config.ts`, `tsconfig.json`, `tsconfig.test.json`, `package.json` (Modify)

*   **Type / Scope**: Bindings, configuration and dependencies.
*   **Proposed Changes**: The `worker_loaders` binding, the AI Gateway binding, one R2 bucket for app bundles, the reviewer and `env.AI` credential (`ANTHROPIC_API_KEY`, a secret, sent through AI Gateway), and the route `*.gettwin.xyz/*`. `wrangler.toml`'s route is the only place the literal domain appears; code reads the apps-domain var. The vars `BELLMAN_APPS` (default `off`), `BELLMAN_APPS_USERS` and the apps domain. Bindings go on `BellmanEnv` only. The same in the test config. Exclude PR 6's Workers-only files in both tsconfig files. Add `@cloudflare/worker-bundler`.

#### 46. Tests for PR 6

*   `tests/helpers/apps.ts` (Create): seeds `app:` rows directly (a live version with a bundle, a `stopped` version, a killed app) so these tests run before PRs 7 and 8 add the methods that produce those states.
*   `worker-tests/apps-runtime.test.ts` (miniflare `workerLoaders`): a `db`-only app serves and persists; two apps with the same bundle get separate databases; `fetch` is refused; `eval`, `new Function` and WebAssembly from bytes throw under the loader; every response carries §5's CSP even when the app sets its own; a service worker cannot register on the live or preview origin; a `Set-Cookie` with `Domain` is stripped; a cookie without the `__Host-` prefix never reaches app code; an incoming `x-bellman-request` is replaced; the viewer cookie never reaches app code; app code cannot serve `/__bellman/**`; the cookie's version is served, and a re-mint after a new live version serves the new one; a preview runs only on the `p-` origin; a killed app is refused on the next request; a stopped version serves the paused page; a new preview version serves new code.
*   `worker-tests/apps-room-binding.test.ts`: a call the viewer may make but the author may not is refused, and the reverse; an evicted author gives `author_lacks_access`; a memory read is refused unless every seat of that account grants, including when the viewer or author is that account; writes under `/members/`, `/apps/` and `/.bellman/` are refused; `vote` does not exist; writes carry `via`; a call does not mark the viewer present; a write past the send limit and a read past 120 a minute are refused; an expired request token is refused; a killed app's call is refused.
*   `worker-tests/apps-ai-binding.test.ts`: a call past the budget is refused; a model outside the allowlist is refused; usage is recorded in `AppDO`.
*   `worker-tests/apps-session-routes.test.ts`: `run` and `session` refuse bearer tokens and a request without an allowed Origin; `session` refuses a viewer with no Run click for the current set; the acting seat is the oldest holding the needed verb; a second use of a `jti` is refused; the enter page ignores messages from other origins.
*   `tests/viewer-assertion.test.ts`: expiry, wrong app, wrong version, wrong audience (an access token is refused), tampered signature, for both token kinds; neither payload contains a user id or `Identity`.
*   `tests/node-apps.test.ts` (Create): on the Node server, serving and previews answer `apps_not_available`.
*   `worker-tests/apps-bundle.test.ts`: a bundle over 5 MB is refused; keys include the room and app.

### PR 7: The gate and capability approval [B]

#### 47. `src/apps/gate.ts` (Create)

*   **Type / Scope**: Runtime-free gate stages.
*   **Proposed Changes**: Stages 1–4 with structured findings `{stage, rule, path, line, message, fix}`; an OSV (Open Source Vulnerabilities) client interface, whose Workers implementation, `src/apps/osv-workers.ts`, queries `api.osv.dev` in batch; the verdict record (analyzer, rule-set, model and prompt versions, OSV query date, skipped stages).

#### 48. `src/apps/review.ts` (Create)

*   **Type / Scope**: Stage 5.
*   **Proposed Changes**: The LLM review: Claude Haiku 5.5 (`claude-haiku-5-5`) through the AI Gateway, the prompt kept in this file with a version number, the source tree (not the bundle) up to 100,000 input tokens, structured output parsed into findings. Charged to the room.

#### 49. `src/apps/app-do.ts` (Modify)

*   **Type / Scope**: Gate runner.
*   **Proposed Changes**: `check` (through `AppHost.check`, after `startCheck`) queues the version in `AppDO` storage and sets the alarm if none is set; the alarm works through the queue one version at a time; the alarm reads the kill flags, builds the bundle, runs stages 1–5, and calls `recordVerdict`. A run that throws (not one that returns a failing verdict) retries once; a second throw records a `failed` verdict with the error.

#### 50. `src/store.ts`, `src/store-do.ts`, `src/rooms.ts`, `src/surface.ts`, `src/types.ts`, `src/attention.ts`, `tests/attention.test.ts` (Modify)

*   **Type / Scope**: Lifecycle, in the store transaction.
*   **Proposed Changes**: Async store methods in the contract suite, each taking its audit entries:
    *   `startCheck(sessionId, key, version)`: sets `checking`, counts the room's 100 a day, refuses `rate_limited`.
    *   `recordVerdict(sessionId, key, version, bundleHash, verdict, audit)`.
    *   `publishApp(sessionId, key, version, item, seat, audit)`, with `item` carrying the surface fields (`title`, `placement`), implementing §6 steps 4 and 5; it refuses a key that is not an app key.
    *   `approveApp(sessionId, key, version, approver, audit)`, which refuses inside its own transaction if the requesting seat's `leftAt` is set (the same test `gateSeatRead` makes).
    *   `denyApp(sessionId, key, version, approver, reason, audit)`; `revokeApp(sessionId, key, revoker, audit)`.

    `normalizeSurfaceWrite`/`normalizeSurfaceBatch` stop refusing `app` items in a single write; they refuse a batch that mixes an `app` item with other items, and `app` items in proposals. `writeSurface` and `writeSurfaceBatch` hand an `app` item to `publishApp`. The `app` event type (payload `{key, version, state, author}`, room-wide, with state `error` for PR 8's first-error event) is added to `EventType` and to `ATTENTION` as `"interrupt"`.

#### 51. `src/http/apps.ts` (Modify)

*   **Type / Scope**: HTTP routes for the dash.
*   **Proposed Changes**: `GET /rooms/:id/apps/:key/approval` (the capability change in plain words, the full `env.ROOM` scope when the set writes to the room, the author and the writing seat, the gate summary labelled advisory, the code diff); `POST` the same path with `approve` or `deny` (and a reason); `POST /rooms/:id/apps/:key/revoke`. Built with #414's route helpers; the acting seat is the account's oldest active seat whose role holds `govern` (§7's seat rule); refused when `who.via !== "cookie"`, and `csrfRefusal`'s Origin check applies.

#### 52. `src/tools/fs.ts` (Modify)

*   **Type / Scope**: MCP tool.
*   **Proposed Changes**: `check` (returns `checking`, or the cached verdict, which does not count toward the room's 100 a day) and `status` (each version's state, findings in the untrusted envelope, `pending_approval { approver_role, link }`, a denial's reason, and the preview URL).

#### 53. `src/apps/osv-workers.ts` (Create; Workers-only), `tsconfig.json`, `tsconfig.test.json` (Modify)

*   **Type / Scope**: The OSV client's Workers implementation; build configuration.
*   **Proposed Changes**: `osv-workers.ts` implements item 47's interface and is excluded in both tsconfig files; `gate.ts` and `review.ts` stay runtime-free except for the injected clients.

#### 54. Tests for PR 7

*   `tests/apps-gate.test.ts` with a fixture corpus under `tests/fixtures/apps/` (prompt-injection text in comments, disguised `eval`, a `db`-and-`room` request, a secret in a file, a tree over the review cap). The LLM stage is stubbed in `verify`; a nightly job runs it live.
*   `tests/apps-publish.test.ts`: `not_checked` without a verdict; refused when the bundle hash does not match; a set within the current one ships, the previous live version becomes `superseded`, and a pending version is superseded; a `stopped` app comes back by publishing again; a wider set waits; approval is refused when the requesting seat was evicted; a check past 100 a day is refused and a cached verdict is not counted; a second pending version replaces the first; a room-write version waits even with an unchanged set; approval writes the item authored by the requester and stamped `approved_by`; denial records the reason and writes nothing; revoke returns to the base set and stops a version that needs more; any set change asks viewers to Run again; rollback goes through the same checks; a single `app` item through the batch path goes through `publishApp`; a batch mixing an `app` item with other items is refused; a proposal holding an `app` item is refused.
*   `worker-tests/apps-gate-alarm.test.ts`: `check` returns `checking`; the alarm records a verdict and appends the `app` event; a run that throws retries once; a failing verdict is not retried.
*   `worker-tests/apps-approval-routes.test.ts`: a bearer token cannot approve, deny or revoke; a seat without `govern` cannot; a request without an allowed Origin cannot; `approved_by` is the oldest seat holding `govern`.
*   `tests/attention.test.ts`: covers `app`.

### PR 8: Operations and purge [B]

#### 55. `src/http/operator-apps.ts` (Create), `src/http/stats.ts`, `src/store.ts`, `src/store-do.ts` (Modify)

*   **Type / Scope**: Operator route, mounted in `src/http/stats.ts` beside `operator-rooms.ts`; the flag write.
*   **Proposed Changes**: Disable or enable one app or a room's apps through `setAppFlag(sessionId, key | null, disabled, audit)`, a store method in the contract suite, for `BELLMAN_OPERATORS` only. Each action audited. Disabling revokes secret injection (phase B).

#### 56. `src/apps/log-ring.ts` (Create; runtime-free), `src/apps/app-do.ts`, `src/tools/fs.ts` (Modify)

*   **Type / Scope**: Log ring in `AppDO` and the `logs` and `call` ops.
*   **Proposed Changes**: 200 entries per version, at most 2 KiB each, in the app's `AppDO`, sources `server`, `gate`, `egress`, tagged `{room, app, version, viewer seat}`; the first server error per version appends an `app` event with state `error`. `logs` reads entries in the untrusted envelope. `call` sends one request to a version as a preview and returns status, headers, the first 16 KiB of the body and its log entries; on the Node server it answers `apps_not_available`.

#### 57. `src/retention.ts`, `src/store-do.ts`, `src/stored-session.ts` (Modify)

*   **Type / Scope**: Purge and sweep.
*   **Proposed Changes**: A purge step per backend (repos through `TreeStore.purge`, `AppDO` storage including its log rings, R2 bundles, and `RegistryDO.purgeAppIds`), each confirmed before the room record is deleted. `reposSwept` retries like `blobsSwept`; an absent `reposSwept` reads as true, because rows written before PR 5 have no apps, and the first app write sets it to false. The close-time sweep removes repos no app record names; the purge audit entry lists what was deleted.

#### 58. (Removed in review round 3: shadow billing had no goal. The caps bound cost.)

#### 59. Tests for PR 8

*   `worker-tests/purge.test.ts`: purge waits for each new backend, deletes the room's `appid:` rows, and lists what it deleted.
*   `worker-tests/operator-apps-routes.test.ts`: only operators; after an app or room disable, the next page request, `env.AI` call, `env.ROOM` call and alarm are each refused.
*   `tests/log-ring.test.ts`: the bounds, the tags, the untrusted envelope on read.
*   `worker-tests/apps-call.test.ts`: `call` returns status, headers, a truncated body and the request's log entries, with no bindings beyond the preview's.
*   `tests/node-apps.test.ts`: `call` answers `apps_not_available`.

### PR 9: Docs and release [B]

#### 60. `docs-site/src/content/docs/guides/building-apps.md` (Create) and `src/governed-view.ts` (Modify)

*   **Type / Scope**: Docs; the `/.bellman/guide/apps.md` path, added to the renderer here as a constant.
*   **Proposed Changes**: Building an app from a chat client end to end; item 37's binding table; the gate; approval, revocation and click to run; the base set; previews and `call`; what an app with `env.ROOM` can show to viewers; name cookies `__Host-…`; inline scripts are blocked by the CSP.

#### 61. `docs-site/src/content/docs/concepts/trust.md` (Modify) and `docs-site/src/content/docs/concepts/privacy.md` (Create)

*   **Type / Scope**: Docs.
*   **Proposed Changes**: Trust: the apps domain, the separate preview origin, the viewer session, the request token, the CSP (with service workers blocked) and frame sandbox, WebRTC as a residual path. Privacy: app data is stored per app and purged with the room; no app storage is pinned to a region; Bellman cannot yet confirm that Artifacts snapshots are deleted; memory is room-readable while `read_context` is granted.

#### 62. `docs/runbooks/apps.md` (Create)

*   **Type / Scope**: Operations.
*   **Proposed Changes**: A malicious app, a runaway app, an Artifacts outage, a `diverged` app.

#### 63. Release steps (no file)

*   Submit `gettwin.xyz` to the Public Suffix List. Turn `BELLMAN_APPS` on for `BELLMAN_APPS_USERS` only. General availability is a separate owner decision once the list has accepted the domain and the caps have run in production.

### PR 10: Phase B egress [B]

#### 64. `src/apps/egress.ts` (Create; Workers-only) and `src/apps/egress-rules.ts` (Create; runtime-free)

*   **Type / Scope**: Egress Worker and its rules.
*   **Proposed Changes**: Rules: host + method + path prefix; refuse public-suffix and shared-hosting wildcards; refuse Bellman's hosts, private ranges and bare IPs. Worker: reads the capability record, `redirect: "manual"` with a re-check per hop, injects secrets per (host, method, path), scrubs them from responses, caps requests and bytes, answers refusals with the typed 403, writes `egress` entries to the log ring. An app with `room` read plus a host that accepts writes needs approval for every version. Excluded in both tsconfig files and exported from `src/worker.ts`.

#### 65. `src/apps/manifest.ts`, `src/apps/worker.ts`, `src/http/apps.ts` (Modify)

*   **Type / Scope**: Phase B wiring.
*   **Proposed Changes**: `hosts` and `secrets` in `app.json`; `globalOutbound` set to the egress Worker for approved sets; the approval screen marks hosts that accept writes, says a `GET` with a query string can carry data out, and states "This app can read room data and send to <host>" when that applies. Secrets held under #191's custody model.

#### 66. Tests for PR 10

*   `tests/egress-rules.test.ts`: the matcher, wildcards, private ranges, bare IPs.
*   `worker-tests/egress.test.ts`: a redirect to a refused host, DNS rebinding, byte caps, secret scrubbing, the typed refusal.

### Outside this repository

*   **bellman-sh/dash:** the Files tab (tree, preview, an editor that shows the changed content when a save is refused as stale, history and restore), the `/a/<room>/<key>` route and its frame, click to run, the approval and revoke screens, the preview link, and the operator controls. One dash issue per bellman PR that adds a route.
*   **Domain:** `gettwin.xyz`, already a zone on the Bellman Cloudflare account. Before PR 6 deploys: confirm the zone has no records or Workers on it. Before allowlisted users: submit it to the Public Suffix List (PR 9).

### Verification Plan

*   **Build and tests**: `npm run verify` on every PR (`typecheck:ui`, `typecheck`, `typecheck:worker`, `build`, `test`, `test:worker`, `test:mod`). `wrangler deploy --dry-run` on every PR that changes `wrangler.toml` or adds a binding.
*   **Static checks**: `npm run docs:gen` leaves no diff; `tests/extension.test.ts` and `tests/docs-reference.test.ts` pass.
*   **Positive controls**: each new refusal test is run once against a build with the check removed, to see it fail.
*   **Budget**: the tool listing re-measured after each PR that changes a tool's definition, recorded in ARCHITECTURE §11, and at most 11,840 tokens.
*   **Integration**: `npm run smoke` against `wrangler dev`; a gated job runs the `TreeStore` contract against real Artifacts; CUJs 1–5 run by hand on a staging deployment before `BELLMAN_APPS` is turned on for allowlisted users.
