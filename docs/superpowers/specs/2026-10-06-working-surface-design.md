# The Working Surface — Design

Issue: [#129 A room should carry a working surface, not only an event log](https://github.com/bellman-sh/bellman/issues/129)
Status: approved design, pending implementation plan
Supersedes: [room scribe](2026-09-25-room-scribe-design.md) — its summary becomes one item on this surface, and D4 and D7 there are reversed here (see D3)
Depends on: #2 (landed — [permission verbs](2026-09-25-permission-verbs-design.md)), #111 (landed — [heartbeat events](2026-10-02-heartbeat-events-design.md), for the attention posture)
Related: #65 (durable record — shrinks, see D11), #66 (the scribe as actor — builds on this), #84 (situational presets — would declare items), #28 and #49 (the surfaces that will render this)
Piece 1 of 4: this is the substrate. Blobs (documents, images), the canvas UI in `dash`, and sandboxed HTML artifacts are pieces 2, 3 and 4, each with its own spec.

## Problem

A room's durable state is an append-only event log. Nobody reads four hundred
events of agents working, so there is nothing to *return to* — only a transcript
to replay. A member joining at hour three reads the creator's brief from minute
zero; a member returning after a gap re-reads everything or polls across a large
cursor gap.

ChatGPT Space exposed the inverse architecture: the shared thing is an artifact,
each person brings their own agent to it, and progress is visible because you
watch the artifact fill in. Bellman shares the conversation and has no artifact.

The reframe, from #129: **a room should carry a working surface, not only a
log** — the current state of the thing being worked on, which members read, and
which outlives the session because it was always the point. The log becomes how
the surface got that way.

The prior art on disk is colony-nerve's canvas: placed objects
`{plugin_id, instance_key, placement, config}`, persisted then broadcast, last
write wins per object, connectors between objects, and agents as first-class
participants. That shape, not a single document, is what this adopts.

## Scope

**In scope — the substrate, usable over MCP alone:**

1. A surface of keyed, typed, optionally placed items on every room, stored in
   the room object and written through the existing send path.
2. Four kinds: `text`, `link`, `diagram`, `connector`. Enough for a plan, a
   decision list, a reference, an architecture sketch, and the lines between
   them.
3. A verb that gates writing. Reading is never gated.
4. The surface in every read path a member already has: the join preview, the
   confirm response, and the poll.

**Out of scope, each its own piece:**

- **Blobs** (piece 2): uploaded documents and images, an R2 bucket, upload and
  download routes, a bridge tool that uploads a local file, and `file` and
  `image` kinds that reference a blob. The event payload bound makes inline
  binary content a non-starter, and the room object's 2 MiB value bound rules
  out storing it there.
- **The canvas UI** (piece 3): pan and zoom, items and connectors rendered in
  `bellman-sh/dash`, over the HTTP room routes #49 adds.
- **HTML artifacts** (piece 4): an `html` kind stored as a blob and rendered in
  a sandboxed iframe. The trust boundary is that whole design.

## Decisions

### D1 — An item, not a document. Several, keyed.

The surface is a set of items. Each has a `key` — the same slug grammar as a
role key, `[a-z][a-z0-9_]{0,30}`, with the three prototype-reachable names
refused — a `kind`, and the fields that kind needs. The key is the address:
writing to a key that exists replaces that item.

One document was the scribe spec's shape, and #129 already doubted it. The
nerve canvas is the evidence: what a room accumulates is a plan, a decision
list, a diagram, a link to the PR, and the lines between them. Those are items.
A single document would hold them as sections nobody can address, place, or
connect.

Keys rather than generated ids, because a writer that says "replace `plan`"
needs no read first, and a reader that wants the plan knows where it is. An id
would make every rewrite a read-then-write.

### D2 — Four kinds now; a kind lands with its validator.

| kind | fields | what it is |
|---|---|---|
| `text` | `body` (markdown), `title?` | a plan, a decision list, notes |
| `link` | `body` (an `http` or `https` URL), `title?` | a PR, a doc, a dashboard |
| `diagram` | `body` (mermaid source), `title?` | an architecture sketch |
| `connector` | `ends: { from, to }`, `body?` (label) | a line between two items |

The set is closed, like `SEND_KINDS` and `VERBS`, and for the same reason: every
kind a client is shown maps to a shape the server validates. `file`, `image` and
`html` arrive with pieces 2 and 4, each with its validator, as a verb enters the
enum in the PR that adds its operation.

`diagram` is text with a different reader. It is a kind rather than a `text`
with a flag because a renderer has to know what it is looking at before it
tries, and because an agent asked to "draw the architecture" should have
somewhere to put it that is not a paragraph.

A `connector` names two keys. Both must exist and neither may be a connector,
checked at write time against the current rows. **Nothing cascades.** Removing
an item leaves a connector naming a key that is gone, and a reader renders it
dangling or ignores it. The alternative is a removal that writes several rows
and announces several events, for a case a reader can see for itself.

### D3 — The write is `bellman_send type: "surface"`, and it appends an event.

The scribe spec gave the summary its own tool (D4) and appended no event (D7).
Both are reversed here, deliberately.

**It is a send kind** because a surface write is what `brief_update` and
`progress` already are: a send that also writes state, in the event's own
transaction. `SEND_VERB` forces a verb per kind, the idempotency key, the
payload bounds, the depth check and the audit row all come for free, and the
tool count stays at nine — `tests/tools/surface.test.ts` pins that, and a tenth
tool is ~400 tokens on every request to describe something `bellman_send`
already describes in a line.

The scribe spec's objection was that a summary "must reach a joiner who has
never called `sync`", which fan-out cannot do. D5 answers that: the rows are the
state and the joiner reads the rows. Fan-out is how a *watcher* sees the change.

**It appends an event** because the event is the point. "The log becomes how the
surface got that way" is only true if every change is in the log; and a watcher
on a socket or a poll sees the plan fill in, which is the observability #129
wants, without a second read. The scribe spec avoided the event because its
staleness metric would never settle; this design has no such metric (D7), so
the objection does not apply. Every version of every item is therefore in the
log at its cursor, which is what makes D6's last-write-wins safe.

Payload, validated before the append so a refused write leaves no row and no
event:

```ts
// an item
{ key, kind, title?, body?, ends?, placement? }
// a removal
{ key, remove: true }
```

`placement` is `{ x, y, w?, h? }` of finite numbers, or absent. The canvas is
infinite: nothing bounds `x` or `y`. A connector has no placement — it is drawn
between its ends — and one that carries it is refused rather than ignored, the
`strictObject` rule.

Bounds: `body` ≤ 8,000 chars, `title` ≤ 120, a `link` body ≤ 2,048, at most 64
items per room. Every one of those is a `ponytail:` constant with a stated
ceiling: 64 items keeps a full read inside one tool response, and the first room
that needs more wants pagination, not a bigger number.

Two exemptions from `bellman_send`'s guards, both type-aware as `progress`'s
is. The "no other active members" refusal does not apply: the creator writes
`plan` before anyone has joined, which is exactly when a plan gets written. The
`receive_messages` capability check does not apply: a surface is addressed to
the room, not delivered to a member's context as a message.

### D4 — The event is `ambient`.

`ATTENTION.surface = "ambient"`, the `progress` reasoning: a peer that cares is
already looking, and a plan edit landing mid-turn in every member's context is
worse than silence. The bridge then queues it rather than pushing it, and a
hosted connector reads it on its next poll. A human watching the canvas is a
client that polls or holds a socket, and sees every change land.

### D5 — Rows in the room object, written in the event's transaction.

Each item is one row, `sf:<key>`, in `SessionDO` storage — beside the event
rows, not inside the session record. The record is read on every call, so
content there would be a tax on every poll; a row is read only by a path that
asked for the surface.

The row is written by `#writeEvent` in the transaction that stores the `surface`
event, through a new `AppendExtras.surface`, the `creditReport` pattern: the
caller says what to index, the store writes the event and the row together, and
an interruption leaves both or neither. `MemoryStore` keeps the same rows in a
map and applies the same rule.

The session record gains one number, **`surfaceCursor`**: the cursor of the last
event that changed a row. It moves in the same put, monotonically, and it is
what lets a poll say "the surface moved" for free (D7). Absent on rows written
before this landed; `hydrateStoredSession` lifts it to `0`, which is the honest
default for a room with no surface.

**This answers #129's third question.** Inside the room object is where it
lives, and that is not the archival problem it looked like: nothing in the store
ever deletes a closed room's storage, and `bellman_sync` reads stay open to a
closed room. A surface written here outlives the session's active life already.
What #65 still has to settle is who may read it who was never a member, and for
how long it is kept — see D11.

### D6 — Last write wins per key, monotonic by cursor. No compare-and-set.

A write to a key replaces the row if the event's cursor is higher than the
row's, and is a no-op otherwise. On a fresh append it is always higher. On an
idempotent replay, `appendEventOnce` re-applies the extra with the original
event, and the rule makes that a repair or a no-op and never a regression —
the same shape `creditReport` and `markRemoved` have.

Two writers in one room are the manifest's choice (D8), and when they race the
later append wins. **This is the one corner cut.** The scribe spec's D6 refused a
summary covering fewer events than the one it replaced; this design has no
coverage cursor to compare. What makes the cut safe is D3: the overwritten
version is still in the log at its own cursor, attributed, so a race loses
nothing and a reader can see what happened. The upgrade, when a race bites, is
an `expect_cursor` on the payload refused *inside the append transaction* — not
in the handler, where a read-then-append is the window
[ARCHITECTURE.md §9](../../ARCHITECTURE.md) exists to name.

A removal of a key that holds nothing appends its event and changes no row, and
`surfaceCursor` does not move for it: the cursor records changes, not attempts.

### D7 — Reads: an index on the preview, content on confirm and on request, one number on the poll.

| path | carries | why |
|---|---|---|
| `bellman_connect` | the index: `cursor`, and per item `key`, `kind`, `chars`, `cursor`, `at`, `by` | a code holder who never joins is shown that the room keeps a plan and a diagram, not their contents — the line that keeps joiners' briefs out of the preview, kept |
| `bellman_confirm` | every item in full, each in an untrusted envelope | the joiner is a member now, as `briefs` already treats them |
| `bellman_sync`, every poll | `surface_cursor` when nonzero | one integer, from the record already in hand; a watcher compares it with what it last read |
| `bellman_sync` with `surface: true` | every item in full | the on-demand read: a member that restarted with a saved cursor, or that wants the current state without replaying the log |
| `bellman_start` | nothing | the surface is empty at creation; the guidance lives in `bellman_send`'s description |

The per-poll cost is one number, present only when the surface has ever
changed, so a room that never uses this pays nothing on its poll. The scribe
spec's D9 shipped three metadata fields on every poll and had to invent a rule
for when the text rides along; here the text rides along as the `surface`
*event*, in `events[]`, for any poll whose cursor predates the write, and the
rule is the one every event already follows.

Staleness is the caller's arithmetic: `cursor - surface_cursor` is how many
events have landed since the surface last changed. No `events_since_summary`
field, no threshold the server has to hold.

A removed member (#113) reads its history up to its cut and nothing after, so a
`surface: true` read for one returns only items whose current cursor is at or
before the cut. An item rewritten after the cut is omitted; its earlier version
is still in the member's event history. The sync description says so.

On a poll that waits, the rows are read after the wait, as `session_status` is
(#74), so the surface a poll returns is never older than the events beside it.
`chars` in the index is the body's length, `0` for an item with none.

### D8 — A verb, `write_surface`, held by the creator seats.

`write_surface` joins `VERBS`. `pair`'s `peer_a`, `swarm`'s `lead` and
`review`'s `author` hold it; `peer_b`, `helper`, `reviewer` and `observer` do
not. A manifest may grant it to any seat, including several.

Single-writer by default, which is what #129 asked for: one seat maintains the
surface and every other member reads it, and the untrusted-content discipline
holds because the writer is one known seat. More than one writer is a choice
the room's author makes in the manifest and every joiner is shown in the
preview, where `your_verbs` already is.

Adding a verb to the creator seats changes what a shipped preset's creator may
do, additively. Unlike D3 of the heartbeat design, no room's behaviour changes
for a member that does nothing: no tick, no obligation, no event unless somebody
writes. The scribe spec made the same change for `summarize`.

Reading is never gated, as reading never is: a `can: []` observer reads the
surface, and the manifest skill says so.

`denyVerb` is the guard, at the top of the `surface` branch in `bellman_send`,
before the payload is examined — the D1 ordering of the verbs design: a seat
that may not write hears about its seat, not about its payload.

### D9 — Trust: prose inside the envelope, identifiers in the spine.

Every item a member reads arrives as
`untrusted({ memberId, label }, item)` with the writer as origin — the whole
item, placement included, because one shape is easier to hold than two. The
index on the preview carries no prose at all: `key` is regex-bounded, `kind` is
an enum value, and `chars`, `cursor`, `at` and `by` are the server's. A title is
author prose and is therefore **not** in the index; a joiner's human decides on
the index and reads the titles after joining.

The `surface` event is content and crosses as every event does, wrapped by the
poll at the tool boundary and by the bridge's `renderEvent` for a socket frame.
`structuredContent` carries no preamble, so on that channel the envelope is the
only marker, as the scribe spec and the manifest design both record.

The guard test: mutate the index projection to carry `title` and confirm a test
goes red. The manifest work showed a trust split with no dedicated guard test is
unprotected.

### D10 — `#writeEvent` learns to delete, and `memberRow` learns the surface.

`#writeEvent(txn, event, rows)` puts the event, the cursor and any extra rows in
one `put`. A removal needs a `delete` in the same transaction, so the extras
builder returns the rows to put and the keys to delete, and the writer applies
both inside the closure. `memberRow`, which today builds the `session` row the
`creditReport`, `markRemoved` and `stampActionRequest` extras owe, is renamed
`extraRows` and gains the surface row and the `surfaceCursor` bump; it stays a
free function, for the reason its comment gives.

### D11 — What this settles for #65.

#65 asked where a record lives after the room dies, who may read it, and for
how long. D5's finding takes the first question off the table: the room object
is not deleted at close, and the surface in it is readable by its members
through `bellman_sync` after the room has closed, today. What remains is the
read for someone who was never a member — the panel, an org admin — which is
#49's route plus #158's consent model, and a retention policy, which is an
operator decision about storage this design does not make. #65 is rewritten to
say that.

### D12 — The scribe (#66) writes `plan`.

The scribe spec's summary is a `text` item. Its instructions — summarise when
the room has moved — become "keep `plan` and `decisions` current", and its
trigger is D7's arithmetic. Spawning a sub-agent to do it stays the harness's
business, as that spec's D11 said. Housekeeping that *acts* on the room stays
#66, and needs the trust model that issue describes before any seat is given
the authority.

## Schema

### Stored (`src/types.ts`, `src/surface.ts`)

```ts
export type SurfaceKind = "text" | "link" | "diagram" | "connector";

export interface Placement { x: number; y: number; w?: number; h?: number }

/** An item as written: normalised, every optional field present as null. */
export interface SurfaceItem {
  key: string;
  kind: SurfaceKind;
  title: string | null;
  body: string | null;
  ends: { from: string; to: string } | null;
  placement: Placement | null;
}

/** An item as stored: the item plus the write that put it there. */
export interface SurfaceRow extends SurfaceItem {
  cursor: number;
  at: number;
  byMemberId: string;
  byLabel: string;
}
```

`EventType` gains `surface`. `Verb` gains `write_surface`. `StoredSession` gains
`surfaceCursor?: number`, lifted to `0` by `hydrateStoredSession`.

`src/surface.ts` is new and runtime-free, importable by both stores and both
test programs, like `heartbeat.ts`: the key shape, the four bounds, the kind
table, `applySurfaceWrite` (the monotonic rule, D6) and `surfaceCursor` (the
accessor over the optional field). It imports only types, so `store.ts` can
import it without the cycle that keeps `asked` and `clearSilence` in `store.ts`.

### Store (`src/store.ts`)

```ts
export interface AppendExtras {
  // ...
  /**
   * Write or remove one surface row in the event's own transaction (D5), under
   * the rule in applySurfaceWrite (D6). `item: null` removes `key`.
   */
  surface?: { key: string; item: SurfaceItem | null };
}

export interface BellmanStore {
  // ...
  /** Every surface row, sorted by key. An unknown session answers none. Detached copies. */
  surfaceOf(sessionId: string): Promise<SurfaceRow[]>;
}
```

One new method, one new extra. No new object, no new alarm, no cross-object
hop: a surface write is one transaction in one object.

### Manifest (`src/manifest.ts`)

`VERBS` gains `write_surface`. The three creator seats in `PRESETS` gain it.
`RoleKeyShape`'s regex and reserved set become a `slugShape(noun)` factory so
`SurfaceKeyShape` is the same grammar with its own error wording.

## The write path

```ts
bellman_send({
  session_id, member_id,
  type: "surface",
  payload: { key: "plan", kind: "text", title: "Plan", body: "..." },
  idempotency_key?,
})
-> { room_members, cursor, replayed? }   // cursor is the item's version
```

Rejections, in order, each before any write:

1. closed, frozen, not your handle — the guards every send has
2. the seat lacks `write_surface` — `denyVerb`'s sentence
3. the payload fails `SurfaceShape` — the kind's rule, named
4. a `connector` whose end is missing or is itself a connector
5. a new key past 64 items — "remove one with `{ key, remove: true }`"

Then: normalise, build the draft with the normalised item as its payload,
append with `extras.surface`, audit `sent_surface` with `{ key, kind, chars }`
or `{ key, removed: true }`.

That sequence — guard, validate, read the rows, append, audit — is one
operation, `writeSurface` in `src/rooms.ts`, the way `issueInvite` is. The
`surface` branch of `bellman_send` calls it and maps the `RoomResult`, and so
does piece 3's `PUT /rooms/:id/surface/:key`. Two transports, one write path:
the reason `rooms.ts` exists, applied before the second transport arrives
rather than after.

The count and the ends check read the rows first, one `surfaceOf` call, then
append. That is a read-then-write and the window is open: two writers can both
add a 64th item, or a connector can name a key removed a millisecond earlier.
Both are courtesy bounds — a 65th row costs nothing and a dangling connector is
D2's declared state — so neither moves into the store. The verb guard, the
frozen guard and the row write are not courtesies, and all three are where they
have to be.

## The read path

### `bellman_connect`

```ts
surface: {
  cursor: 412,
  items: [{ key: "plan", kind: "text", chars: 1840, cursor: 412,
            at: "2026-10-06T19:02:11Z", by: { member_id, label } }, ...],
}
```

Always present, empty for a room with no items. Beside `room` and
`creator_brief`.

### `bellman_confirm`, and `bellman_sync` with `surface: true`

```ts
surface: {
  cursor: 412,
  items: [untrusted({ memberId, label }, { key, kind, title, body, ends, placement, cursor, at }), ...],
}
```

Sorted by key. Arrays rather than key-indexed objects, so a projection never
builds an object from caller-chosen names, and so the shape matches `events[]`
and `members[]`.

### `bellman_sync`, every poll

```ts
{ events, cursor, session_status, surface_cursor?: 412, ... }
```

`surface_cursor` only when nonzero, the `outstanding` and `removed` convention:
a client that has never heard of it keeps working, and a room with no surface
does not grow a field.

## Security

The surface is the room's most-read content, and it is written by an agent that
has read untrusted peer content. The scribe spec named the laundering path and
the containment is the same here: the writer's instructions say never to carry
an instruction into an item, which is a prompt-level mitigation, and the
envelope marks every item as peer content whoever reads it, which is the
structural one. D9 is where it is enforced, and the guard test is what keeps it
enforced.

What a `link` can do is bounded at the door: `http` and `https` only, parsed,
2,048 chars. A renderer (piece 3) still treats it as an untrusted URL.

A `diagram` body is mermaid source, which is text here and executable in a
renderer. Rendering it safely is piece 3's problem, and the kind exists now so
the content has a home before the renderer does.

## Testing

Two programs, as always. The pure rules sit in `src/surface.ts` beside the code
that uses them.

- **`tests/working-surface.test.ts`** — the key shape refuses the three reserved names
  and the regex's edges; `applySurfaceWrite` applies a newer cursor, ignores an
  equal or older one, removes under the same rule; the index projection carries
  no prose (the D9 guard: put `title` in it and the assertion goes red).
- **`tests/helpers/store-contract.ts`** — an append with `surface` writes the
  row and moves `surfaceCursor`; a second write to the key replaces it; a
  replay through `appendEventOnce` returns the original cursor and neither
  duplicates nor regresses; a removal deletes the row and a removal of nothing
  moves no cursor; `surfaceOf` on an unknown session is empty; rows are
  detached; a frozen room writes neither event nor row. Runs against
  `MemoryStore` in the root program and `DurableObjectStore` in `worker-tests/`.
- **`tests/tools/working-surface.test.ts`** — write, replace, remove; each
  kind's validation, including a `link` with a `javascript:` scheme and a
  `connector` with a missing or connector end; placement refused on a
  connector; the 65th key and the 8,001st char; the lone creator may write; a
  seat without the verb is refused with the log unchanged (the verbs matrix
  rule); frozen and closed refuse; the event arrives `ambient` in a peer's
  poll; `surface_cursor` appears after the first write and not before;
  `surface: true` returns envelopes; `bellman_connect` shows the index and no
  title or body; `bellman_confirm` shows the envelopes; a removed member's read
  stops at its cut; the audit row names the key.
- **`tests/tools/verbs.test.ts`** — the matrix gains `surface → write_surface`.
- **`tests/attention.test.ts`** — the table is closed over `EventType`, so
  `surface` must declare `ambient` or the build stops; the test asserts the
  union.
- **`tests/tools/surface.test.ts`** — the tool count stays nine, and the
  `SEND_KINDS` pin gains `surface`.
- **`tests/room-manifest-skill.test.ts`** — forces the skill's verb and preset
  tables to carry `write_surface`.
- **`tests/extension.test.ts`** — the Desktop bundle's list is unchanged, and
  that is asserted.
- **`tests/projections.test.ts`** — `surface.ts` and the new projections stay
  runtime-free.

Two rules this repo has paid for, applying to every test above:

1. **Run each new assertion against a broken implementation before trusting
   it.** An assertion nobody has seen fail is not evidence.
2. **A check needs a positive control.** Make it fail on purpose before calling
   it verification.

## Files

| File | Change |
|---|---|
| `src/types.ts` | `EventType` += `surface`; `Verb` += `write_surface`; `SurfaceKind`, `Placement`, `SurfaceItem`, `SurfaceRow` |
| `src/surface.ts` | **new**, runtime-free — key shape, bounds, kind table, the payload shapes and `normalizeSurfaceWrite` (here and not in `kit.ts`, because `rooms.ts` needs them and `kit.ts` imports `rooms.ts`), `applySurfaceWrite`, `surfaceCursor` |
| `src/stored-session.ts` | `surfaceCursor?` on `StoredSession`, lifted to 0 in `hydrateStoredSession` |
| `src/manifest.ts` | `write_surface` in `VERBS` and the three creator seats; `slugShape` factory |
| `src/attention.ts` | `surface: "ambient"` |
| `src/store.ts` | `AppendExtras.surface`; `surfaceOf` on the interface and in `MemoryStore`; the extra applied in both appends |
| `src/store-do.ts` | `sf:` rows; `extraRows` (was `memberRow`) returns puts and deletes; `#writeEvent` applies both; `surfaceOf` on `SessionDO` and the facade |
| `src/tools/kit.ts` | `surface` in `SEND_KINDS`; `SEND_VERB.surface` |
| `src/tools/send.ts` | the `surface` branch calls `writeSurface` and maps its result; the two exemptions |
| `src/tools/sync.ts` | `surface_cursor`; the `surface` flag; the cut |
| `src/tools/connect.ts`, `src/tools/confirm.ts` | the index; the envelopes |
| `src/projections.ts` | `surfaceIndex`, `surfaceItem` |
| `src/rooms.ts` | `writeSurface` — guard, validate, count, ends, extras, audit — and `readSurface(store, session, cut?)`, for both transports |
| `skills/room-manifest/SKILL.md` | the verb row; the preset tables |
| `README.md` | the `bellman_send` row; the verbs line; a short "The working surface" section |
| `docs/ARCHITECTURE.md` | §5 a "The working surface" subsection; §8 the roadmap; §11 re-measured |
| `docs/superpowers/specs/2026-09-25-room-scribe-design.md` | one status line: superseded by this |
| `extension/manifest.json` | **unchanged**, asserted |
| `tests/working-surface.test.ts`, `tests/tools/working-surface.test.ts` | **new**, as above; the rest as above |

## Out of scope

- **Blobs, the canvas UI, HTML artifacts** — pieces 2, 3 and 4.
- **Compare-and-set** — D6 names the upgrade and where it has to live.
- **Items declared in the manifest** — a `surface:` block naming the entries a
  room keeps, shown in the preview and used by #84's situational presets. The
  mechanism works without it; the declaration is #84's work.
- **Housekeeping** — #66.
- **Reading a closed room's surface as a non-member, and retention** — #65 as
  rewritten by D11, over #49 and #158.
- **MCP Apps rendering** — #28.
- **Pagination past 64 items, z-order, grouping** — the first room that needs
  them.
- **Cascading removal of connectors** — D2.
- **Promoting an `artifact` send onto the surface** — a `file` kind is piece 2,
  and an artifact that should persist is written as a surface item instead.
