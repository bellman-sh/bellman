# Rooms Persist — Design

**Date:** 2026-10-07
**Status:** approved in conversation; implementation plan to follow
**Closes:** #18. Touches #45 (the max plan). Leaves #190 (creates) as it is.
**Repo:** `bellman-sh/bellman`, with one follow-up in `bellman-sh/bellman.sh` (see *Site*).

## Problem

Every room dies on a clock. `ENTITLEMENTS.sessionTtlMs` (`src/auth.ts`) gives
each plan a lifetime — 4 hours, 72 hours, 14 days, 30 days — `bellman_start`
stamps it into `Session.expiresAt`, and `SessionDO` closes the room when it
runs out. #18 says why that is wrong for the rooms Bellman is for: a hub room
accumulates members over weeks, and a clock ends it in the middle of being
useful. Watching a room costs nothing now — the sockets hibernate and the
object sleeps with them — so the clock no longer pays for anything.

Two facts decided it (#18, 2026-10-06): **rooms persist on every plan**, and
**a room ends when its last member leaves**. The site already says so
(`bellman.sh/pricing`, PR #14, merged). The server does not yet.

A second change was asked for beside the first: **no member cap above free**.
`maxMembers` (2 / 8 / 25 / 25) is a plan fact stamped into the room at
creation, and a persistent room capped at eight is a room somebody has to
recreate.

## Decisions

### D1 — The clock goes

`sessionTtlMs` leaves `Entitlements` and every plan. `expiresAt` leaves
`Session` and `StoredSession`. `bellman_start` stops returning
`session_expires_at`; nothing read it but its own description.

`hydrateStoredSession` (`src/stored-session.ts`) strips `expiresAt` from rows
written before this change, as it strips `joinCode`: the rooms alive at deploy
persist too, and a row keeps no field the type forbids. Nothing is backfilled,
because a missing clock is the new state.

### D2 — Abandonment replaces expiry, in the same seam

A room nobody has been in for **90 days** is abandoned, and an abandoned room
closes the way an expired one did. The constant is
`ABANDONED_AFTER_MS = 90 * 24 * 60 * 60 * 1000` in `src/presence.ts`, beside
`STALE_AFTER_MS`, because it is the same kind of fact: how long silence may
last before it means something.

"Been in" is presence, which the room already derives (`src/presence.ts`): a
member is present if a live socket vouches for it, or if it was heard from
inside the window (`lastSeenAt`, lifted from `joinedAt` by `lastSeen`). So:

```
abandonedAt(s)                 null if s.closed, s.frozenAt !== null, or no active member;
                               otherwise max(lastSeen(m) for active m) + ABANDONED_AFTER_MS

isAbandoned(s, now, connected) abandonedAt(s) !== null
                               && now > abandonedAt(s)
                               && no active member of s is in connected
```

Both live in `src/presence.ts`, pure and importable by both builds. The strict
`>` is `pastTtl`'s, kept so the boundary tests keep their shape.

Why 90 days: an abandoned room costs storage and nothing else, and the member a
hub room would most regret evicting is its quietest one. Why not never: a room
whose every member died with its laptop should not sit in a Durable Object for
good, and the sweep is also what retires its codes from the registry's index.

**Where it runs.** `SessionDO` has one derived alarm map, `#derivedDue()`
(`src/store-do.ts`): `{ ttl: expiresAt, heartbeat: nextTickAt(s) }`, and
`reArm()` picks the earliest. The `ttl` entry becomes **`abandoned:
abandonedAt(s)`**, set when non-null. Derived, as `ttl` was, so a rollback
strands nothing — the comment on that map says why. The alarm's `"ttl"` branch
becomes `"abandoned"` and calls `#closeIfAbandoned(s, now)`, which replaces
`#expireIfDue` and keeps its shape:

1. Read the sockets (`#attachedIds()`, synchronous, inside the transaction). If
   one vouches for an active member, the room is not abandoned whatever
   `lastSeenAt` says: **stamp `lastSeenAt = now` on the members it vouches
   for**, in one put, and return. `reArm()` then points the alarm 90 days
   ahead. This is the stamp `webSocketClose` already makes on a drop (#152),
   made on a schedule, and it is what keeps the alarm from firing back to back
   for a room held open on one socket for a quarter of a year.
2. Otherwise, if `isAbandoned`: close, drop every live code from the registry's
   index, and append `session_expired` — one transaction, as #124 made it.

**The readers agree with the alarm.** `pastTtl` and `readsClosed` are the one
rule `membersOf`, `fetch` (the socket accept) and `#tickIfDue` share with the
alarm, so a room reads closed before its alarm fires. They become
`isAbandoned(s, now, connected)`, with `connected` from `#attachedIds()`. The
lazy close on read stays: a read that finds the room abandoned calls
`#closeIfAbandoned`, as it called `#expireIfDue`.

**MemoryStore mirrors it.** `sweep(now)` and the lazy close in `getSession` and
`sessionsCreatedBy` call the same predicate, with `connected` from the socket
hook it already has (`attachedTo`), so the contract suite holds both stores to
one rule.

**The event.** `session_expired` stays — it is in the closed `EventType` set,
`attention.ts` gives it `interrupt`, and clients switch on it. Its payload
becomes `{ reason: "abandoned", last_seen_at: <ISO> }`: the fact the decision
was made on, so a client can say *closed — nobody since 9 July* rather than
*closed*.

**Frozen rooms are not swept.** `touchMember` refuses to stamp a frozen room,
so the sweep would be measuring the freeze and not the members; and the point
of freezing is that paying again gives back exactly what was there (README,
*Plans*). A thaw stamps `lastSeenAt = now` on every active member, beside the
report credit `clearSilence` already gives (#111 D10), so a thawed room gets a
full window rather than closing on the alarm the thaw re-arms.

**An empty room is not the sweep's.** `abandonedAt` is null with no active
member: `closeSessionIfEmpty` closes a room the moment it empties, from every
leave and eviction, and that remains the only path for one. A room left empty
and open by a leave that died half-way heals on the retry, as its comment says.

### D3 — A swarm room's size is a ceiling, not a plan

`maxMembers` leaves `Entitlements` and `Session`. Capacity is a function of the
manifest:

```ts
// src/store.ts
export const ROOM_MEMBER_CEILING = 100;
export const capacityOf = (manifest: RoomManifest): number =>
  manifest.mode === "pair" ? 2 : ROOM_MEMBER_CEILING;
```

A `pair` room holds two because the preset says so. A `swarm` room holds as
many members as its creator invites, up to the ceiling, on every plan that can
start one. Free stays pair-only, so "2 on free" is still true, and it is the
mode that says it.

Removed rather than kept as `number | null`, for the rule written on the
`Session` type: two fields for one fact can disagree. With no plan cap, a
room's capacity is its mode's, and a stored copy would be the stale mirror
that rule forbids. `hydrateStoredSession` strips `maxMembers` from old rows
along with `expiresAt`; a swarm room created under an 8- or 25-member cap holds
100 from its next read.

**Why a ceiling, and why 100.** A room is one value in SQLite-backed Durable
Object storage, members included (events and surface rows are separate, #25),
and a value holds 2 MB. A brief at the schema's maximum (`src/tools/kit.ts`:
goal 500, state 2,000, twenty constraints and twenty open questions of 300) is
14,710 characters; 100 members of those are 1.47 MB, under the limit with room
for the manifest and the codes. 250 would be 3.7 MB. Two-byte text at the
maximum in every brief of a full room is the remaining gap, and the
transaction turns it into one failed join rather than a broken room. The
ceiling is the same on every plan, is named as storage in its refusal (*this
room holds 100 members, Bellman's ceiling for one room*), and is the trigger
for moving members to rows of their own if anyone reaches it.

`seatVictims(members, cap, staleBefore, connected)` is unchanged; its callers
pass `capacityOf(s.manifest)`. `bellman_connect`'s preview returns
`max_members: capacityOf(manifest)` — 2 or 100, a number an agent can act on —
and its description says 100 is the ceiling, not a plan limit.
`bellman_invite`'s full-room refusal keeps its text for a pair room and uses
the ceiling's for a swarm.

### D4 — Max is coming soon

With no lifetime and no cap, `max` differs from `pro` by `monthlyCreates`
alone (2,000 against 500). It stays in `ENTITLEMENTS` — a hand grant still
works, and it is the shape hosted agents (#188, #189) attach their facet to —
but nothing sells it: no Stripe price names it (`planForPrice` would honour
one, which is why this is a rule and not a check), `STRIPE_PAYMENT_LINKS`
must carry no `max` entry, so `/upgrade/max` stays a 404, and the README's table marks
the row *coming soon*. The site's Max card already says so. The comment on
`ENTITLEMENTS.max` says this, replacing the one that promised 14-day rooms and
25 members. `tests/auth.test.ts` pins it: `max` and `pro` differ in
`monthlyCreates` and nothing else, so a facet landing is a deliberate edit to
that line.

### D5 — What the docs and panels say

- **README.** The plan table loses its `members` and `lifetime` columns and
  gains the *coming soon* note on `max`. *What a plan gates* says: a pair room
  holds two; a swarm room holds as many members as you invite, up to 100, a
  storage ceiling that is the same on every plan; rooms persist on every plan —
  a room ends when its last member leaves, or after 90 days in which nobody in
  it was seen. *Plans* drops "4 hour lifetime". The lapse paragraph drops
  "resolves itself as those sessions reach their TTL": those rooms persist like
  any other, and a lapse will not reach them.
- **`docs/ARCHITECTURE.md`.** Every mention of the TTL alarm, `expiresAt`,
  `expireIfDue` and "members, TTL" in the entitlements box becomes the
  abandonment alarm, `abandonedAt`, `closeIfAbandoned` and "modes, quota,
  audit". The named-alarms paragraph names `abandoned` and `heartbeat` as the
  two derived names.
- **`docs/adr/0001-rooms-persist.md`.** The first ADR, per
  `docs/agents/domain.md`: the two facts, the sweep, the ceiling, under a page.
- **Admin panel** (`src/oauth/routes.ts`): the *Members per session* and
  *Session lifetime* rows go; *Modes* stays.
- **Tool descriptions:** `bellman_start`'s *Returns* loses
  `session_expires_at`; `bellman_connect`'s gains the ceiling sentence.

## Error handling

| Case | Behaviour |
|---|---|
| Alarm fires, a socket vouches for an active member | stamp those members; no close; re-arm 90 days out |
| Alarm fires, silence past the window, no socket | close + drop codes + `session_expired {reason: "abandoned"}`, one transaction |
| Read lands between the window closing and the alarm | reads closed, and the read closes it (lazy), as today |
| Room frozen | not swept; the thaw stamps, so the window restarts |
| Room empty and open | not the sweep's; `closeSessionIfEmpty` on the next leave or evict retry |
| Swarm room at 100 | `seatMember` refuses `full`; `bellman_confirm`, `bellman_connect` and `bellman_invite` name the ceiling |
| Stored row carrying `expiresAt` or `maxMembers` | stripped on read; rewritten without them on the next mutation |
| Build rolled back after rows were rewritten | not supported, roll forward: the older build's `reArm()` calls `setAlarm(undefined)` for a row with no `expiresAt`, workerd rejects it, and the writes that re-arm commit and then fail (ADR 0001) |

## Testing

Every new assertion is run against a broken implementation before it counts,
and every assertion that pinned the clock is rewritten, not deleted.

**Pure (`tests/presence.test.ts`):** `abandonedAt` — null when closed, frozen or
empty; the max over active members only, so a departed member's late
`lastSeenAt` does not count. `isAbandoned` — false at the boundary, true one
millisecond past it, false with a connected active member.

**Contract suite (`tests/helpers/store-contract.ts`), both stores:** the three
TTL cases become abandonment cases — a room whose members were last seen
90 days + 1 ms ago closes on sweep with `joinCodes` empty, its code gone from
the index, and a `session_expired` whose payload is
`{ reason: "abandoned", last_seen_at }`; one event however many sweeps; closed
lazily on read. New: a member seen inside the window keeps it open; a connected
member keeps it open past the window (MemoryStore's socket hook); a frozen room
past the window stays frozen and open; a thaw stamps `lastSeenAt`. Capacity:
the seat cases that set `maxMembers` use a pair manifest where they need two
and a swarm fixture where they need the ceiling; a 100th member is seated, a
101st refused `full`.

**Worker (`worker-tests/`):** `alarms.test.ts` — the alarm is armed at
`lastSeen(creator) + ABANDONED_AFTER_MS`; a legacy row with `expiresAt`, no
`due:` row and an old `lastSeenAt` still closes; the alarm stays armed after a
firing with nothing to do; **new:** a firing with a socket open stamps and
re-arms instead of closing. `session-expiry-atomic.test.ts` — the same
interruption cases against `closeIfAbandoned`. `heartbeat-tick.test.ts` —
`lapseRoom` pushes `lastSeenAt` into the past instead of `expiresAt`.
`tests/store-do-wiring.test.ts` — the `expiresAt` cases (past its TTL, the
boundary, the re-arm) read `lastSeenAt` instead.

**Tools:** `bellman_start` returns no `session_expires_at`; `bellman_connect`
reports `max_members` 2 for pair and 100 for swarm; `tests/tools/max-plan.test.ts`
seats 30 on a max swarm (past both old caps) and keeps its org and audit
refusals; `tests/auth.test.ts` — the entitlement shape has four keys, and `max`
and `pro` differ only in `monthlyCreates`; `tests/tools/sync-status.test.ts`
parks the poll until a sweep at `abandonedAt + 1`. The admin panel renders
without the two rows.

## Files

| File | Change |
|---|---|
| `src/types.ts` | `Session.expiresAt`, `Session.maxMembers`, `Entitlements.maxMembers`, `Entitlements.sessionTtlMs` removed |
| `src/auth.ts` | the two fields off every plan; the `max` comment |
| `src/presence.ts` | `ABANDONED_AFTER_MS`, `abandonedAt`, `isAbandoned` |
| `src/store.ts` | `ROOM_MEMBER_CEILING`, `capacityOf`; `seatVictims` callers; sweep and lazy close through the predicate; thaw stamp |
| `src/store-do.ts` | `readsClosed`, `#derivedDue` (`abandoned`), `alarm()`, `#closeIfAbandoned`, `#tickIfDue` guard, `seatMember` cap, thaw stamp |
| `src/stored-session.ts` | strip `expiresAt`, `maxMembers` |
| `src/rooms.ts`, `src/tools/start.ts`, `src/tools/connect.ts` | capacity and refusals; no `session_expires_at`; descriptions |
| `src/oauth/routes.ts` | admin panel rows |
| `README.md`, `docs/ARCHITECTURE.md`, `docs/adr/0001-rooms-persist.md` | D5 |
| tests, as above | |

No new tool, so `extension/manifest.json` is untouched. `monthlyCreates` is
untouched (#190).

## Site (follow-up in `bellman-sh/bellman.sh`, after this merges)

`tools/pricing.config.json`: Pro, Max and Team `room_size` become *As many
people as you invite*; the FAQ gains *How big can a room be?* — a pair room
holds two; a swarm room holds as many people as you invite, up to 100 today, a
storage ceiling that is the same on every paid plan. The compare pages' member
facts, where they quote 8 or 25, follow. The Max card stays *Coming soon*.

## Out of scope

- **Hosted agents and hours** (#188, #189, #191): Max's facet.
- **Rate-limited creates** (#190): `monthlyCreates` stays as it is.
- **Members in rows of their own.** Lifts the ceiling; done when someone reaches it.
- **A per-room cap in the manifest.** Nothing asks for it yet; the manifest is where it would go.
- **Freeze detection.** Still unwired (README); the thaw rule above is ready for it.
