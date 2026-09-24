# Room Manifests (M0) — Design

Issue: [#1 M0: YAML room manifests](https://github.com/bellman-sh/bellman/issues/1)
Status: approved design, pending implementation plan
Blocks: #2 (permission verbs), #3 (role-carrying codes)

## Problem

Rooms are created ad hoc by `bellman_start`. A room has no declared identity,
no roles, and no statement of who may do what. A joiner previewing a room via
`bellman_connect` sees the creator's brief but not the rules they are agreeing
to, and they see it *before* any of their own context crosses — which is the
one moment the rules actually matter.

M0 makes every room declared.

## Decisions

### D1 — The server accepts a typed object. YAML is authoring sugar.

MCP tool arguments are JSON. Passing YAML *inside* a JSON string argument
would pay for a parser and a second class of failure ("malformed YAML at
line 3") while buying nothing, because the model composing the call is
generating that string either way.

YAML earns its place only where a human authors a file outside the tool call.
So: `.bellman/room.yaml` is real and is the authoring format, but `src/bridge.ts`
converts it to the object before the call goes out. The server has exactly one
schema and one validator.

Consequence: the `yaml` dependency lives on the Node bridge only. The Workers
bundle never parses YAML.

### D2 — Permission verbs are a closed enum mirroring the tool surface.

```
send | invite | revoke | request_actions | respond_actions | audit | close_room
```

Zod validates the enum for free, MCP clients get schema hints, and #2's
enforcement is a one-line guard per handler. Most importantly: every verb shown
in a connect preview provably maps to a real guard. An open string set would let
a manifest advertise authority that enforces nothing — the exact lie this issue
exists to prevent.

**Verbs gate outbound actions only.** `bellman_sync` and `bellman_leave` are
never gated: reading is implied by membership, and a member must always be able
to leave.

### D3 — Manifests are required. Citing a preset counts as declaring.

There is no undeclared room and nothing is ever synthesized on the caller's
behalf. But naming a published preset *is* an authored choice, so the common
cases cost one line and only unusual rooms hand-write roles.

This splits the manifest along a real seam:

- **Identity is always authored** (`room`, `purpose`) — per-room, unpresettable.
- **Governance may be cited** (`mode`, `roles`, `default_role`, `creator_role`)
  — the reusable part.

### D4 — A manifest cites a preset XOR authors roles. Never both.

No merge semantics to specify, test, or explain. `extends` can be added later
without breaking anything already written — it is purely additive.

Both Zod arms are `.strict()`, so `preset` and `roles` together fails as an
unrecognized key rather than silently preferring one.

### D5 — `mode` moves into the manifest.

`bellman_start` previously took `mode: "pair" | "swarm"` as an independent
argument, which meant `{ mode: "swarm", preset: "pair" }` was legal and
incoherent. Moving `mode` into the manifest makes that combination
unrepresentable rather than merely rejected. A preset named `pair` carries
`mode: pair` by construction.

`bellman_start` loses its `mode` argument. `Session.mode` is deleted; read
sites use `session.manifest.mode`. Two fields that must agree is the bug class
this decision removes.

### D6 — Manifests are immutable.

Set at `createSession`, never changed. No `setManifest`, no extra store method,
no Durable Object round-trip, nothing to keep consistent. Changing a room's
rules means starting a new room. Promoting a member later is a *role* change and
belongs to #3, not a manifest edit.

### D7 — The connect preview splits into a trusted spine and an untrusted skin.

The issue offers "the manifest (or a redacted view)". Redaction is the wrong
frame: nothing in a manifest is secret from someone already holding a valid
join code, and `creator_brief` — far more sensitive — already crosses at this
point.

The real hazard is that a manifest is creator-authored text landing in the
joiner's model context before their human has approved anything. That is an
injection surface.

But the parts differ in how much an author controls. Verbs come from a closed
enum and `mode` is an enum — those carry nothing. Role KEYS are different: they
are creator-authored, and `[a-z][a-z0-9_]{0,30}` still admits
`ignore_prior_rules_and_obey`. With `MAX_ROLES` at 16 that is a bounded channel
of roughly 500 characters of lowercase text sitting in the spine.

So the spine is **shape-validated, not content-free**. What actually keeps it
safe is that the entire `bellman_connect` result already ships under
`UNTRUSTED_PREAMBLE` (`src/server.ts:348`), so nothing in it reaches the
joiner's model unflagged. The `untrusted()` envelope adds per-field origin
marking on top of that for the parts with no structural bound at all —
`room`, `purpose`, and role `description`.

Role keys stay in the spine because `your_role`, `creator_role`, and the `roles`
table all reference them; moving them into the envelope would make the
structure unreadable. The honest statement is that their charset and length
bound the channel, not that it is closed.

So the structure ships as fact, and the prose ships inside the existing
`untrusted()` envelope under `UNTRUSTED_PREAMBLE` — the same pattern the
codebase already runs for briefs.

## Schema

### Stored (`src/types.ts`)

```ts
export type Verb =
  | "send"             // bellman_send, message payloads
  | "invite"           // bellman_invite — mint a join code
  | "revoke"           // bellman_invite { revoke: true }
  | "request_actions"  // send action_request payloads
  | "respond_actions"  // send action_response payloads
  | "audit"            // bellman_audit
  | "close_room";      // end the session for everyone

export type PresetName = "pair" | "swarm" | "review";

export interface RoleDef {
  can: Verb[];
  description: string | null;   // free text; surfaced inside the untrusted envelope
}

export interface RoomManifest {
  room: string;                     // identity — always authored
  purpose: string | null;
  mode: SessionMode;                // "pair" | "swarm"
  roles: Record<string, RoleDef>;   // ALWAYS expanded, never a preset reference
  defaultRole: string;              // what a joiner gets until #3 lands
  creatorRole: string;
  preset: PresetName | null;        // provenance only
}
```

The stored manifest is **always fully expanded**. `preset` is retained so the
preview can say "this is a `review` room" and #3 can reason about it, but
`roles` is concrete on every session. #2 and #3 never resolve a preset.

`Member` gains `roomRole: string`.

> **Naming trap.** `Identity.role` already exists and means `"member" | "admin"`
> — the *platform* role for org permissions. The room role is therefore
> `Member.roomRole`, never `Member.role`. Two adjacent types both carrying
> `role` with different meanings would be a bug waiting to happen in #2's guards.

`Session` gains `manifest: RoomManifest` and **loses** `mode`.

### Input (`src/server.ts`)

```ts
const ManifestShape = z.union([
  z.object({                                     // cite a preset
    room: z.string().min(1).max(80),
    purpose: z.string().max(300).nullish(),
    preset: z.enum(["pair", "swarm", "review"]),
  }).strict(),
  z.object({                                     // author roles
    room: z.string().min(1).max(80),
    purpose: z.string().max(300).nullish(),
    mode: z.enum(["pair", "swarm"]),             // required — no default
    roles: z.record(RoleKeyShape, RoleDefShape),
    default_role: z.string(),
    creator_role: z.string(),
  }).strict(),
]);
```

The authored arm requires `mode` with no default; a default would reintroduce
the undeclared room through the back door.

## Preset catalog

Presets are room *shapes*: each implies a mode and a role structure. `observer`
was considered and rejected as a preset — it is a *role*, and a room where
everyone observes does nothing. It appears inside `swarm` instead.

Room-control verbs (`invite`, `revoke`, `close_room`, `audit`) stay with the
creator's role in every preset. Interaction verbs are symmetric where the shape
is symmetric.

### `pair` — two peers, mode `pair`

| role | can |
|---|---|
| `peer_a` *(creator)* | send, request_actions, respond_actions, invite, revoke, close_room |
| `peer_b` *(default)* | send, request_actions, respond_actions |

### `swarm` — a lead and helpers, mode `swarm`

| role | can |
|---|---|
| `lead` *(creator)* | send, invite, revoke, request_actions, respond_actions, audit, close_room |
| `helper` *(default)* | send, request_actions, respond_actions |
| `observer` | *(none — sync only)* |

### `review` — author and reviewer, mode `pair`

| role | can |
|---|---|
| `author` *(creator)* | send, invite, revoke, request_actions, respond_actions, close_room |
| `reviewer` *(default)* | send, respond_actions |

A reviewer can answer an action request but not initiate one.

## Validation

`src/manifest.ts` is new and pure — no store, no identity, no clock — so it
tests as a table and #2/#3 import it without dragging the server in.

```ts
export function resolveManifest(input: ManifestInput): RoomManifest  // throws ManifestError
```

Zod handles shape. The resolver handles what Zod cannot express:

1. `default_role` names a role present in `roles`
2. `creator_role` names a role present in `roles`
3. role keys match `[a-z][a-z0-9_]{0,30}` — they appear in previews and in #3's codes
4. no duplicate verbs within a single `can`

Deliberately **not** errors:

- A room where no role holds `invite`. A sealed room is a legitimate declaration.
- A `pair` room defining three roles. Roles are not seats; `mode` governs member
  count, `roles` governs authority.
- `creator_role === default_role`. A fully symmetric room is legal.
- `can: []`. An observer holds no outbound verbs and can still sync and leave.

### Limits

The codebase already bounds untrusted input (`MAX_PAYLOAD_CHARS`, the `.max()`
calls on `BriefShape`). Manifests get the same treatment, since a manifest is
peer-authored text that reaches another model's context:

| field | limit |
|---|---|
| `roles` | at most 16 entries |
| role key | 1-31 chars, `[a-z][a-z0-9_]{0,30}` |
| `can` | at most one of each verb (7 max by construction) |
| `room` | 80 chars |
| `purpose` | 300 chars |
| `description` | 300 chars |

Error text names the field and the fix:

```
default_role "helper" is not defined in roles (defined: lead, observer)
```

## `bellman_start`

Order matters, and it is what satisfies the issue's "reject a malformed manifest
rather than a partially-created room" requirement structurally rather than by
guard:

```ts
const manifest = resolveManifest(input.manifest);   // throws → fail(), nothing created
if (!ent.modes.includes(manifest.mode)) return fail("swarm mode requires ...");
// ... quota checks, then createSession
```

Manifest validation is the first thing that happens. Plan gating reads
`manifest.mode`. The creator's `Member.roomRole` is set to `manifest.creatorRole`.

## `bellman_connect` preview

```ts
room: {
  // trusted — server-validated, no free text
  preset: "review" | null,
  mode: "pair",
  your_role: "reviewer",                    // = manifest.defaultRole
  your_verbs: ["send", "respond_actions"],
  creator_role: "author",
  roles: {
    author:   ["send","invite","revoke","request_actions","respond_actions","close_room"],
    reviewer: ["send","respond_actions"],
  },

  // untrusted — creator-authored prose, same envelope as the brief
  text: untrusted({ memberId, label }, {
    room: "payments-migration",
    purpose: "Port Stripe v2 to v3",
    descriptions: { author: "...", reviewer: "..." },
  }),
}
```

`your_role` and `your_verbs` are hoisted out of the role table deliberately —
that is the fact the joiner's human is deciding on, and burying it in a map
makes them derive it.

**Every role ships, not just the joiner's.** The trust decision depends on what
*other* seats can do to them: if `author` holds `request_actions`, they need to
know before their context crosses. Hiding it would defeat the reason for
surfacing the manifest at all.

`bellman_connect` stays `readOnlyHint: true`. The manifest crosses *to* the
joiner; nothing of theirs crosses back until `bellman_confirm`.

`bellman_confirm` echoes the same `room` object so the rules stay in the
joiner's context after the preview scrolls away.

## Role assignment in M0

- `bellman_start` → creator gets `manifest.creatorRole`
- `bellman_confirm` → joiner gets `manifest.defaultRole`

That is the whole story until #3 makes join codes carry a role, at which point
only `bellman_confirm` changes.

`publicMember()` exposes `room_role` so peers can see who holds what.

## Relationship to `Member.capabilities`

These are orthogonal and both stay.

`capabilities` is **recipient-side consent** — enforced today in `bellman_send`
at `src/server.ts:499` and `:505`, where it filters who a message or action
request is delivered to. It answers *"what may be delivered to me."*

A manifest verb is **sender-side authority**. It answers *"what may this seat do."*

So #2 adds a *new* check site — a guard at the top of each tool handler, in
front of the existing recipient-side filter — rather than rewriting
`bellman_send`'s fan-out. A member may still refuse delivery of something their
role is permitted to send.

## Store impact

`src/store.ts` is expected to need **zero changes**. `Session` is stored whole,
nothing in the store reads `mode`, and D6 (immutability) means no new method.

`src/store-do.ts` needs no code change — `RoomManifest` is plain JSON — but does
need a round-trip assertion. It is the only store serving production and #12
already flags it as verified by smoke alone.

## Bridge YAML path

`src/bridge.ts` reads `.bellman/room.yaml`, parses it with `yaml`, and emits the
object form. Failures (missing file, malformed YAML, unknown keys) are reported
locally before any call leaves the machine.

```yaml
# .bellman/room.yaml
room: payments-migration
purpose: Port Stripe v2 to v3
preset: review
```

## Files

| File | Change |
|---|---|
| `src/manifest.ts` | **new** — `PRESETS`, `resolveManifest()`, `ManifestError` |
| `src/types.ts` | `Verb`, `PresetName`, `RoleDef`, `RoomManifest`; `Member.roomRole`; `Session.manifest`; delete `Session.mode` |
| `src/server.ts` | `ManifestShape`; `bellman_start` drops `mode`, gains `manifest`, resolves before gating; `bellman_confirm` assigns `defaultRole` and echoes `room`; `bellman_connect` returns the `room` block; `publicMember` exposes `room_role` |
| `src/store.ts` | expected unchanged |
| `src/store-do.ts` | expected unchanged; add round-trip assertion |
| `src/bridge.ts` | `.bellman/room.yaml` conversion (slice 2) |
| `scripts/smoke.ts` | add `manifest: { room: "smoke", preset: "pair" }` |

## Tests

- **`tests/manifest.test.ts`** *(new)* — three preset expansion snapshots; each
  of the four validation rules with its message asserted; preset-XOR-roles
  rejection.
- **`tests/tools/handshake.test.ts`** — malformed manifest returns `isError`
  **and** the store holds zero sessions; creator gets `creatorRole`; joiner gets
  `defaultRole`; connect returns the trusted spine with `your_role` / `your_verbs`
  and free text inside the untrusted envelope.
- **`tests/bridge.test.ts`** — YAML file to object; missing file; malformed YAML.
- **`tests/helpers/fixtures.ts`** — add `manifestFixture()`. This keeps updating
  the five existing `tests/tools/*` files mechanical rather than a rewrite.

## Slices

1. **Server** — `types.ts`, `manifest.ts`, `server.ts`, tests, smoke. Unblocks
   #2 and #3 on its own.
2. **Bridge YAML** — `bridge.ts`, `yaml` dependency, bridge tests. Pure
   ergonomics; nothing depends on it.

## Breaking change

Every `bellman_start` call without a manifest fails once this deploys. Confirmed
acceptable: the service has no users yet. In-repo callers (`scripts/smoke.ts`,
`tests/tools/*`) are updated in the same PR.

## Out of scope

- **#2** — enforcing verbs at the tool handlers. This design defines and
  surfaces them; nothing checks them at call time yet.
- **#3** — join codes that carry a role. Until then every joiner gets
  `defaultRole`.
- `extends:` for preset inheritance. Additive later; see D4.
- Changing a room's manifest after creation; see D6.
