# ADR 0007 — Presence is derived, membership is stored

**Date:** 2026-10-02 · **Status:** accepted · **Recorded:** 2026-10-09 · **Closes:** #103, #140, #146, #152

## Context

`leftAt` records a goodbye: a `bellman_leave` or an eviction. A crashed session
never says one, so its member stayed active for the life of the room, and a
`pair` room whose peer's laptop closed read as full for good, with nothing in
the store able to remove the member (#103). `bellman_sync` already long-polled
about every 25 seconds. Then members fed by a room socket or the local bus
stopped polling (ADR 0005, ADR 0012), and a member that only listens sends
nothing (#146).

## Decision

1. **Membership is stored and presence is derived on read.** `presenceOf`
   (`src/presence.ts`) reads a member as `present`, `stale` or `departed` from
   `leftAt`, `lastSeenAt` and the room's live sockets. No field or event payload
   holds the answer: `storedMember`, which events carry, has `active` only.
2. **Liveness is a side effect of calls a member already makes.** `touchMember`
   stamps `lastSeenAt` from `bellman_sync`, `bellman_send` and every verb-gated
   room operation (`gateSeat`), at most once per half-window, because in
   `SessionDO` the stamp rewrites the session record. `STALE_AFTER_MS` is ten
   minutes, 24 polls. The `heartbeat` event (#111) carries reports, not liveness.
3. **An open socket is liveness.** A member is present when `leftAt` is null
   and `lastSeenAt` is inside the window or a live socket vouches for it (PR
   #150; #139 read the window alone). `connectedAmong` widens a socket's ids to
   every undeparted member of its identity, since through the bus one socket
   carries members that joined after it opened.
   `webSocketClose` stamps the members a closing socket vouched for, a drop
   included, so its end leaves a full window (#152, PR #157).
4. **Staleness becomes a write only when a seat is contested.** `seatMember`
   decides it in the transaction that seats the joiner, called from
   `bellman_confirm` alone. `seatVictims`, one pure rule for both stores, takes
   the longest-quiet stale member, one seat per joiner, never one a socket
   vouches for and never the hosted seat (ADR 0002), and refuses rather than
   free part of what a joiner needs. It refuses in a frozen or closed room and
   never closes one. `announceReclaimed` writes `member_timed_out` for the seats
   the store says it took, audited to the removed member's org.
5. **Two readings of one roster, kept apart.** `activeMembers` (`leftAt` null)
   decides when a room has emptied; `seatedMembers` (present) decides capacity,
   and `bellman_connect` and `issueInvite` count with it and write nothing.

## Consequences

- A dead session's seat goes to the first joiner that needs it once its member
  has been silent ten minutes.
- Going quiet writes nothing, so it is reversible: a member that calls anything
  is present again with the same `memberId` and history. Counting staleness in
  `activeMembers` would close a room whose members all went quiet.
- A reclaimed member reads on and needs a fresh code to write; only an eviction
  cuts what a member reads (#113).
- A member whose session died stays present while another member of its
  identity holds a socket in the room: a seat held too long, not taken too soon.
- A socket the runtime never reports leaves its member on a `lastSeenAt` that
  may date from its join.
- `bellman_sync` keeps `readOnlyHint: true` although it writes `lastSeenAt`,
  because the write keeps only its own caller present.
- Abandonment is the same reading over the whole room (ADR 0001). A `heartbeat`
  tick holds measurements at its own `at`, never a claim about now.
