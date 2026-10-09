---
name: room-manifest
description: Author, review or fix a Bellman room manifest — the `.bellman/room.yaml` that declares a room's name, mode, roles and per-role permissions for cross-session agent collaboration over MCP. Use this whenever the user mentions room.yaml, a room manifest, the .bellman directory, bellman_start, declaring or setting up a Bellman room in a repo, the pair/swarm/review/social presets, a hosted seat or host block, or which verbs a role should hold. Also use it when they describe wanting several agents or people to work together in a repo under different permissions, or ask who should be allowed to invite, revoke or request actions — even if they never say "manifest" or "room.yaml".
---

# Bellman room manifests

A manifest declares what a room is and who may do what inside it. Put it at
`.bellman/room.yaml` and `bellman_start` picks it up when the call goes through
the bridge, so nobody has to pass a manifest by hand.

The whole file becomes the `manifest` argument. Nothing else goes in it — not
`org_only`, not `capabilities`, not a brief. Those are per-call, because they
differ per member and per session; the manifest is the part the repository
decides once.

## Step 1 — preset or authored?

Cite a preset unless a role in the room needs permissions no preset gives it.
A preset is three lines and it stays correct as Bellman adds verbs; authored
roles are yours to maintain.

| Want | Use |
|---|---|
| Two members, equal footing | `preset: pair` |
| Several members, one runs the room | `preset: swarm` |
| Someone brings work, someone else critiques it | `preset: review` |
| Several members, and Bellman asks the room a question each tick | `preset: social` |
| A role that holds a combination no preset offers | author roles |

Reach for authored roles when you can name the seat and the reason: "the CI
agent may send but must never invite", "auditors read and nothing else".

## Step 2a — cite a preset

```yaml
room: payments-migration
purpose: Port Stripe v2 to v3   # optional, ≤300 chars
preset: review                  # pair | swarm | review | social
```

That is the entire file. Adding `roles`, `mode`, `default_role` or
`creator_role` next to `preset` is rejected — the two forms are exclusive.

A preset saved in the panel (`dash.bellman.sh/presets`) is cited the same way,
but it works only for the person who saved it: `bellman_start` looks the name
up among the caller's own presets, so a teammate gets `unknown preset`. For a
shape the repo shares, use the panel's Copy room.yaml, which writes the roles
out in full.

What each preset expands to:

**`pair`** — mode `pair`. Holds two members because the preset says so.

| Role | Can | |
|---|---|---|
| `peer_a` | send, request_actions, respond_actions, invite, revoke, write_surface | creator |
| `peer_b` | send, request_actions, respond_actions | default |

**`swarm`** — mode `swarm`. Holds as many members as its creator invites, up to
100, Bellman's ceiling for one room, the same on every plan.

| Role | Can | |
|---|---|---|
| `lead` | send, invite, revoke, request_actions, respond_actions, write_surface | creator |
| `helper` | send, request_actions, respond_actions | default |
| `observer` | *(nothing)* | reads only |

**`review`** — mode `pair`.

| Role | Can | |
|---|---|---|
| `author` | send, invite, revoke, request_actions, respond_actions, write_surface | creator |
| `reviewer` | send, respond_actions | default |

`reviewer` answers action requests but cannot start one. That asymmetry is the
point of the preset: review flows one way.

**`social`** — mode `swarm`. A room with a hosted seat: Bellman runs `host`, which
asks the room a question each tick and answers in the thread. The beat is hourly;
`heartbeat_on` next to `preset` slows it, up to `24h`, and never speeds it. A
saved preset with a `host` block takes one too, from `1h` to `24h`. Next to any other preset
`heartbeat_on` is refused: only a host gives a cited room anything to tick for.

| Role | Can | |
|---|---|---|
| `lead` | send, invite, revoke, request_actions, respond_actions, write_surface | creator |
| `guest` | send | default |
| `host` | send | Bellman runs it |

## Step 2b — author roles

```yaml
room: payments-migration
purpose: Port Stripe v2 to v3
mode: swarm                     # pair | swarm
roles:
  lead:
    can: [send, invite, revoke, request_actions, respond_actions]
    description: Runs the room.         # optional, ≤300 chars
  helper:
    can: [send, request_actions, respond_actions]
  observer:
    can: []
default_role: helper
creator_role: lead
```

### The verbs

The set is closed. A role can hold any subset of these and nothing else:

| Verb | Permits |
|---|---|
| `send` | `bellman_send` — messages and action responses |
| `invite` | `bellman_invite` — issuing join codes |
| `revoke` | revoking a join code |
| `request_actions` | sending `action_request` events |
| `respond_actions` | sending `action_response` events |
| `write_surface` | `bellman_send` type `surface` — writing or removing an item on the room's working surface, and uploading the bytes a `file` or `image` item names (`POST /rooms/:id/blobs`; the bridge's `bellman_upload` does both) |

Every member can always `bellman_sync` and `bellman_leave`, whatever their
role. There is no verb for either, and none for reading — a seat with `can: []`
still sees everything in the room.

Reading the surface is never gated either: every member reads it on join and
on `bellman_sync`, and only a seat holding `write_surface` changes it. Every
preset gives it to the creator's seat alone, so a room has one writer unless
its manifest says otherwise.

There is no `audit` verb and no `close_room` verb, and adding either to a `can`
list fails. `bellman_audit` takes no session, so it is org-wide and no room role
can gate it. A room ends when its last member leaves, not on anyone's say-so.

### The rules the server enforces

- `room`: 1–80 characters, required.
- At least one role, at most **16**.
- Role keys match `[a-z][a-z0-9_]{0,30}` — lowercase, start with a letter,
  31 characters max. `__proto__`, `constructor` and `prototype` are refused.
- `default_role` and `creator_role` must each name a role defined in `roles`.
- No role may list the same verb twice.
- `mode` is `pair` or `swarm`. `pair` caps the room at two seats regardless of
  plan; `swarm` holds as many members as its creator invites, up to 100,
  Bellman's ceiling for one room, the same on every plan.

### Choosing default_role and creator_role

`creator_role` is the seat the person running `bellman_start` takes.
`default_role` is the seat handed out by the join code `bellman_start` returns,
so it is what an unknown joiner becomes. Give `default_role` the least
authority anyone needs, and issue a stronger role deliberately with
`bellman_invite`.

A `default_role` that can `invite` means anyone who gets the code can widen the
room.

### A hosted seat

A `host` block gives the room a seat Bellman runs: once a cadence, the room's
`heartbeat_on`, it asks the room a question, which starts its own thread, and it
answers replies that carry the question's cursor as `ref_id`, three at most. A
tick written because a reporting seat was due does not make it ask. It is
labelled `host@bellman` whatever its role is called. The `social` preset declares
one. An authored manifest adds the block and a role for it:

```yaml
room: build-club
purpose: What people are building this week
mode: swarm
heartbeat_on: 6h                # required with a host: 1h to 24h
roles:
  lead:
    can: [send, invite, revoke, write_surface]
  guest:
    can: [send]
  host:
    can: [send]
host:
  role: host                    # a role in roles that holds exactly [send]
  model: haiku                  # haiku | sonnet | opus; default haiku
  instructions: Ask about one thing someone shipped this week.   # optional, ≤300 chars
default_role: guest
creator_role: lead
```

The block has three fields:

- `role` names a role defined in `roles`. Its `can` must be exactly `[send]`,
  and it must not set `reports: true`. Bellman seats the host in it when the
  room is created; it never joins by code.
- `model` is `haiku`, `sonnet` or `opus`, and `haiku` when left out. Each wake
  is one model call and costs 1, 3 or 5 of the room's 3,000 units a month, so a
  heavier model wants a slower beat: an Opus host lasts the month at `24h`.
- `instructions` is optional, at most 300 characters, and follows Bellman's own
  rules in the host's prompt, which ends saying those rules outrank it. It shapes
  what the host asks; it cannot give the host a tool, another verb or another
  name.

Three refusals an author meets:

- **The floor.** A room with a host must set `heartbeat_on` to at least `1h`.
  Without it the server answers `a room with a host must set heartbeat_on (at
  least 1h)`; under it, `a room with a host must tick no faster than 1h (got
  "30m")`.
- **The plan.** `bellman_start` refuses a host on free and pro, `a hosted seat
  requires the max or team plan (you are on "pro")`. A plan's hosted rooms are the
  most open at once, three on max and five on team; with three open on max the
  answer is `hosted room limit reached: 3 hosted rooms open, the most the "max"
  plan allows. A hosted room that closes frees its slot.`
- **The pair room.** A host needs `mode: swarm`. With `mode: pair` the answer is
  `a pair room cannot have a host: its two seats are its members'`.

### A public room

`public: true` on either arm makes the room readable by anyone with its link:
its working surface and its log, never a brief. Joining still takes a code,
and a joiner is shown that the room is public before accepting. It is false
unless given. The creator can make the room private later, from dash; nothing
makes a room public again.

## Step 3 — check it

The bridge does not know the manifest schema; the server owns the only copy.
So a file that is valid YAML and parses to a mapping is sent even when the
manifest inside it is wrong, and the error comes back from the server naming the
field.

Call `bellman_start` and read the result. A manifest error names the problem
directly — an unrecognized key, an unknown preset, a `default_role` matching no
role. Fix and call again.

The bridge refuses the file locally, before anything leaves the machine, when it
is malformed YAML, not a mapping, over 64 KB, not a regular file, or a symlink
(as is `.bellman` itself). Those failures are about the file, not the manifest.

## Gotchas

- **The bridge reads the directory Claude Code started in.** It does not search
  parent directories. In a monorepo, a manifest at the root is invisible from a
  package subdirectory.
- **A `manifest` argument always wins over the file.** If a call passes one, the
  file is not read at all.
- **Swarm mode needs a paid plan.** On free, `bellman_start` with `mode: swarm`
  is refused at creation — including a manifest citing `preset: swarm`. Joining
  is free on every plan, so a free member can be invited into any room.
- **`mode: pair` is two seats even on team.** The cap comes from the mode, not
  the plan.
- **An empty or comment-only file is an error**, not an absent manifest. Delete
  the file instead.
- **Verbs are enforced, not advertised.** A call a seat's role does not permit is
  refused with an error naming the missing verb, and nothing is delivered or
  recorded. The `your_verbs` shown in a connect preview is the same list the
  server enforces.

## A worked example

> "Our release agent should be able to post status but never pull anyone else
> in. I want to be able to ask it to do things. Humans reviewing should be able
> to answer it but not start requests."

Three seats, and no preset gives that combination, so author it:

```yaml
room: release-train
purpose: Cut and verify the weekly release
mode: swarm
roles:
  conductor:
    can: [send, invite, revoke, request_actions, respond_actions, write_surface]
    description: Drives the release and decides who joins.
  release_agent:
    can: [send, respond_actions]
    description: Posts status and answers requests. Cannot widen the room.
  reviewer:
    can: [send, respond_actions]
    description: Signs off. Answers requests but does not initiate them.
default_role: reviewer
creator_role: conductor
```

`default_role: reviewer` means a leaked code costs a reviewer seat, not an
invite capability.
