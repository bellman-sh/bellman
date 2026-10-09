# Room Housekeeping: the Server Observes and Proposes — Design

Issue: [#66](https://github.com/bellman-sh/bellman/issues/66)
Status: implemented on `mcfearsome/room-housekeeping`; plan: [room housekeeping](../plans/2026-10-08-room-housekeeping.md)
Depends on: [heartbeat events](2026-10-02-heartbeat-events-design.md) (D1 the server ticks, D5 the derived named alarm, D7 a member may not forge a server event, D9 attention on the wire, D10 when an alarm may fire), [the working surface](2026-10-06-working-surface-design.md) (D12: the scribe writes `plan`; housekeeping that acts stays here), [room manifests](2026-09-23-room-manifests-design.md) (where a room declares what it wants), [the hosted seat](2026-10-08-hosted-seat-design.md) (D5: who counts as a person)
Related: #65 (the record after close), #2 (verbs: nothing here is given one), #28 (the monitor, which may show these later)
Repos: `bellman-sh/bellman` only

## Problem

A room goes wrong quietly. A member stops answering mid-thread; an
`action_request` sits with no response; a room nobody has written to in a
day keeps its seats and its codes. The scribe design asked for an agent that
would notice and act, and set that aside because acting in a room that holds
another person's agent needs a trust model nobody had written. The noticing,
it turns out, needs no agent: every one of those conditions is arithmetic
over the log and the roster, and the server already owns a clock per room.

## Scope

In: three findings computed by the server on the room's own alarm; one
server-authored event type that carries a finding as a proposal; the
manifest field that turns housekeeping on, per threshold; the rule that a
finding is raised once per window and clears with its condition.

Out: any action by the server (no nudge is sent, no request is answered, no
room is closed, no member is removed); an acknowledgement that silences a
finding (v1 repeats by time only); the stale-open-question finding, which
needs judgment over `plan` and belongs to the agent variant that follows this;
the panel's and the monitor's rendering beyond the wire.

## Decisions

### D1 — Three findings, each a rule over the record.

- `member_quiet`: an active member whose last send is older than
  `quiet_after`. A send is an event the member appended; reads and polls are
  not sends, so a member who only watches is quiet. A room with a heartbeat
  cadence already asks its reporting members and names them silent; it
  rarely wants `quiet_after` as well, and nothing stops it.
- `request_unanswered`: an `action_request` with no `action_response` whose
  `ref_id` names its cursor, older than `answer_within`, while its sender is
  still in the room. Of one sender's open requests the three oldest are named,
  and the next once an older one is answered, so a member cannot fill every window
  by asking more; the record keeps them all.
- `room_idle`: no member event for `idle_after`. Server-authored events (a
  tick, a housekeeping proposal) are not activity.

Housekeeping counts people. The hosted seat (hosted seat D5) is Bellman's, not a person: it speaks
on its own clock, in answer to its two wake causes, so it is never named quiet, what it says is not
a member's activity (a room only it speaks in is idle), and a room with only the seat in it has
nobody to propose to. A proposal is not one of the seat's wake causes either, since waking spends
the room's host units on the server's initiative.

The stale open question is not here. "Has this thread been dropped" is a
judgment over `plan`, which is prose, and the agent that reads prose is the
follow-on that consumes these findings rather than the thing that computes them.

### D2 — A proposal is a server-authored event.

A new event type, `housekeeping`, appended by the room itself the way a tick
is: no member seat, no verb, `from` the room. Its payload is identifiers and
the server's numbers, never prose: `{ finding, about, since, repeat }`, where
`about` is `{ member_id }` for a quiet member, `{ cursor }` for an unanswered
request and absent for an idle room, `since` the moment the condition began,
and `repeat` how many times this finding has been raised. Attention is
`interrupt`, so a bridge pushes it. It carries nothing a reader needs to
distrust, and `publicEvent` hands the payload over as stored; the poll then wraps
every event type in its untrusted envelope, the tick's included, so a proposal
arrives wrapped as they do. `bellman_send` refuses `type: "housekeeping"` as it
refuses a forged tick (heartbeat D7).

### D3 — It never acts, and it says what to do by naming the condition.

The proposal is the whole of the server's part. The nudge is a member's
`bellman_send` to the quiet member; the answer is an `action_response`; the
end of an idle room is its members leaving, or 90 days with nobody in it. Each stays under the
verb the member already holds, approved by the human who holds it, which is
the trust model the issue asked for: the server has no authority in the room
and acquires none here.

### D4 — Once per window, cleared by the condition.

A finding has a key: the finding name plus the member or the cursor it is
about, or the name alone for `room_idle`. A key is raised once, then again
only after `repeat_after` (default: the threshold that raised it) has passed
since the last raise, and `repeat` counts up. The record keeps `raised`, a
map from key to the last raise, and drops a key the moment its condition no
longer holds: the member sends, the request is answered or its sender leaves,
the room sees an event. A condition that returns starts at `repeat: 1`.

### D5 — The manifest turns it on, per threshold.

```json
"housekeeping": { "quiet_after": "2h", "answer_within": "30m", "idle_after": "1d", "repeat_after": "4h" }
```

Each value is a duration in the form `heartbeat_on` takes, bounded between 5
minutes and 7 days; `repeat_after` is optional and defaults per finding to
that finding's threshold. An absent threshold disables its finding; an absent
object disables housekeeping. No built-in preset sets it (heartbeat D3's reason
holds: a shipped preset that starts naming members quiet changes what rooms
people already run), and a cited preset may add it as it adds `heartbeat_on`. A
preset a person saves ([room designer](2026-10-09-room-designer-design.md)) is
what an authored manifest is without its room and purpose, so it carries the
block as it carries `heartbeat_on`: stored as the keys it sets, null when it
sets none, and cited by `bellman_start` like any other field. A block beside
such a cite replaces the preset's whole, and an empty one turns it off; with no
block, or a null one, the cite keeps the preset's own, as it keeps its
`heartbeat_on`. A preset saved before the field existed has no such key, which
reads as none, as `host` does.

### D6 — The alarm is derived, and fires only when something is due.

`housekeep` joins `outbox`, `abandoned` and `heartbeat` as a handler on the room's one
alarm, derived from the record: the soonest of each member's last send plus
`quiet_after`, each open request's `at` plus `answer_within`, the last member
event's `at` plus `idle_after`, and each raised key's last raise plus its
`repeat_after`. A room with no housekeeping, a closed room and a frozen room
derive `null` (heartbeat D10). A firing computes the findings, appends one
event per key that is due, updates `raised`, and re-arms; it reads and writes
inside one object, so nothing here crosses the atomicity gap. An append that
brings that time forward re-arms after its commit: each one compares the time for
the record it wrote with the record it read, because a send that ends a raised
finding starts a new condition that is due at its own anchor, before the old
raise's window when `repeat_after` is the longer. A thaw restarts
the clocks, as heartbeat D10 refuses the tick its silence across a freeze: the
session records `thawedAt` and every base time (a member's last send, a
request's time, the last member event) is floored at it, so nothing the freeze
imposed is held against anyone and each finding comes back one threshold after
the thaw.

### D7 — No tool, no verb, no seat.

`VERBS` is unchanged, `extension/manifest.json` is unchanged, and
`bellman_sync` carries the new type as it carries every event. The MCP Apps
monitor and the panel may show "needs attention" later; the wire is enough
for this issue.

## Schema

```ts
// src/types.ts
type HousekeepingFinding = "member_quiet" | "request_unanswered" | "room_idle";
interface HousekeepingPayload {
  finding: HousekeepingFinding;
  about?: { member_id: string } | { cursor: number };
  since: number;        // ms epoch, the server's
  repeat: number;       // 1 on first raise
}
// EventType gains "housekeeping"; ATTENTION["housekeeping"] = "interrupt"

// RoomManifest
housekeeping: { quietAfterMs: number | null; answerWithinMs: number | null; idleAfterMs: number | null; repeatAfterMs: number | null } | null;

// StoredSession
raised: Record<string, { at: number; repeat: number; since: number }>;  // finding key -> last raise, and the `since` of the condition it was for
openRequests: Record<string, { at: number; fromMemberId: string }>;     // request cursor -> when asked, and by whom; kept at append
lastMemberEventAt: number | null;                                       // the last member event; kept at append
thawedAt: number | null;                                                // the last thaw; every clock is floored at it
// Member
lastSentAt?: number;          // the member's last appended event; set at append, absent until the first send

// src/housekeeping.ts (runtime-free, beside heartbeat.ts)
export function nextHousekeepAt(s: StoredSession, now: number): number | null;
export function dueFindings(s: StoredSession, now: number): Array<{ key: string; payload: HousekeepingPayload }>;
export function clearedKeys(s: StoredSession, now: number): string[];
```

A key is raised against a condition's `since`. A member who sends after being
named and goes quiet again before any firing has dropped the old key has a new
`since`, so the second condition is a new one and starts at `repeat: 1`, whether
or not the record still holds the first.

## Security

The server appends under its own name with no seat and no verb, and the
payload holds identifiers and numbers only, so a proposal can neither carry
peer prose nor be mistaken for a member's word. A member cannot forge one
(`bellman_send` refuses the type). Nothing acts: a proposal changes no
membership, no code, no row and no status. The thresholds are the creator's
declaration in the manifest, bounded, so a room cannot be made to raise a
finding every second.

## Testing

`tests/housekeeping.test.ts` (runtime-free): each rule against a built
session, each threshold at the boundary, `nextHousekeepAt` the soonest of the
anchors and `null` for a closed, frozen or undeclared room, `repeat_after`
defaulting per finding, keys cleared by each condition. `tests/manifest.test.ts`:
the field parses, each bound refuses with its message, no built-in preset carries
it, the enum of verbs is unchanged. `tests/tools/progress.test.ts`: `type:
"housekeeping"` refused. `tests/helpers/store-contract.ts`, for both stores: the
books. `lastSentAt` is set at append and not by a read, a request opens and
closes, a departure closes a leaver's requests, a thaw sets `thawedAt`.
`worker-tests`: what only a real Durable Object runs, because `MemoryStore` raises
nothing. A firing appends one event per due key with `repeat` counting and
`raised` persists; the derived alarm fires at the soonest anchor, once, and
re-arms; an append that ends a raised finding brings it forward; a firing that
comes late arms a window after itself; a frozen room fires nothing. Every test is
run once against the broken implementation before it counts.

## Files

`src/housekeeping.ts` (new), `src/types.ts`, `src/stored-session.ts` (an older
row reads with defaults), `src/attention.ts`, `src/manifest.ts`, `src/store.ts`
and `src/store-do.ts` (the handler, `lastSentAt`, `raised`, the re-arm),
`src/tools/send.ts` (a comment only: the refusal is `SEND_KINDS`, the closed list
of what a member may send, which does not name the type), `docs/ARCHITECTURE.md`
(§9, the alarm, and §8, the roadmap's B3), `README.md` (the manifest field), the
tests above. `src/public-event.ts` needed no change: it branches on type only
through `isAmbient`. The preview a joiner reads carries the thresholds:
`src/projections.ts`, the `Returns:` lines of `bellman_connect` and
`bellman_start`, and the join page in `ui/`. A saved preset carries the block too:
`src/presets.ts` and `src/tools/start.ts` (D5).

## Out of scope

The agent variant (an LLM seat that reads `plan` and these findings and
proposes with judgment); an acknowledgement; the stale-open-question finding;
any server action; rendering in the panel and the monitor; a per-member
opt-out from being named quiet.
