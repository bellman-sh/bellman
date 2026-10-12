# ADR 0012 — One connection per room for each identity on a machine, through the local bus

**Date:** 2026-10-03 · **Status:** accepted · **Recorded:** 2026-10-09 · **Closes:** #43 · **Spec:** `docs/superpowers/specs/2026-09-29-room-delivery-design.md`

## Context

Every Claude Code session spawns its own bridge, and each bridge long-polled
`bellman_sync` for every member it knew about, so five sessions in one room held
five connections carrying the same events (#43). A long poll keeps a Durable Object
resident, billing its 128 MB against the clock: about $4.05 a month for a room
watched around the clock (#99). #127 gave each room a hibernating WebSocket that
carries every event in it. A socket binds to one `SessionDO`, so a machine watching
three rooms holds three, and #43's one connection per machine is not reachable.

## Decision

1. **One upstream connection per room, for each identity on a machine.** The first
   bridge to reach the bus coordinates: it holds a room socket (`src/room-socket.ts`)
   for each room a member on the bus is watching, and the other bridges subscribe
   over a Unix socket at `~/.claude/bellman/bus/<hash>.sock` (`src/bus.ts`). The
   hash covers the server URL and the identity, a `BELLMAN_KEY` or the signed-in
   person and never the rotating token (`busCredentials`), so identities on one
   machine never share a bus. The socket is made 0600, in a directory created
   0700.
2. **The socket is the election.** A bridge connects to the bus path. If something
   answers, it subscribes. If nothing does, it removes any dead socket there and
   binds, and a bridge that loses the bind (`EADDRINUSE`, or `EEXIST` on macOS)
   connects to the winner. No lock file, no pid check (spec D8).
3. **The coordinator serves each subscriber a gapless stream from its cursor.** It
   keeps each room's last 500 events or 2 MB, addresses every event to each
   subscribing member less that member's own, and serves a cursor older than the
   window with a `bellman_sync` made as that member, whom the identity owns
   (spec D9, D10).
4. **Delivery stays in each bridge.** The bus carries bare events, and each bridge
   renders, escapes and writes its own session's channel or inbox (ADR 0008).
5. **The fallback is mandatory, in two layers.** A room whose socket fails three
   times running is long-polled by the coordinator until a socket opens again,
   and its subscribers cannot tell. Where the bus cannot be had (Windows, a path
   past the `sun_path` limit, a directory that cannot be made) or stops
   answering, each bridge polls for its own members with the `watch()` loop it
   ran before there was a bus (spec D11, ADR 0005).
6. **`BELLMAN_BUS=off` turns it off for a bridge.** It is read at launch, and a
   value that is neither on nor off reads as off and is logged.

## Consequences

- Connections follow rooms, not sessions, and the room stays on the server: a
  session with no bridge takes part over `/mcp` as before (ADR 0003, ADR 0004).
- The election can elect two coordinators, 1 race in 160 at a stale socket among
  eight processes on macOS. That costs part of the collapse until one exits, never
  an event; only a lock would close it, and D8 rejects one. Linux is unmeasured.
- A stopped coordinator still accepts connections. A subscriber gives up on one
  that leaves a subscribe unanswered for 10 seconds or sends nothing for 45 (its
  keepalive comes every 15) and polls for that member; it never unlinks the socket
  or claims the bus (#142).
- When the coordinator's session ends, its close removes the socket, a subscriber
  is elected in its place, and each resumes from its own cursor.
- A live socket vouches for every member of its identity in the room (#146), so a
  dead session's seat is held while a sibling session of the same identity still
  runs (ADR 0007).
