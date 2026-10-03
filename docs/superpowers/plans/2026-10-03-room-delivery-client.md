# Room Delivery, Client Half — Implementation Plan

> **For agentic workers:** one implementer per task, no per-task reviewer. One
> whole-branch review at the end. Steps use checkbox (`- [ ]`) syntax.

**Goal:** One upstream connection per (machine, room) instead of one long poll
per member per session, and that connection a hibernating WebSocket.

**Spec:** [`docs/superpowers/specs/2026-09-29-room-delivery-design.md`](../specs/2026-09-29-room-delivery-design.md) — D7 through D11 are this plan. D1–D6 and D12 landed in #127.

**Closes:** #43, and the client half of #99.

## What already exists

The server half is on `main`. `/ws` authenticates an upgrade exactly as `/mcp`
does, `SessionDO.fetch` attaches then accepts then replays from a cursor, and
`wake()` fans every event out to every socket in the room. A frame is
`publicEvent(event)` — the same projection the poll returns, so a bridge parses
one shape whichever path delivered it.

## Global Constraints

- **The fallback is today's `watch()` loop, kept not reimplemented** (D11). If
  the bus cannot be created the bridge polls exactly as it does now. This is an
  optimisation, never a dependency.
- **`deliver()` does not change.** A channel notification goes over its own
  session's stdio transport and a hook write goes to its own inbox
  (`inboxDirFor(process.ppid)`), so every bridge still delivers for itself.
  What changes is only where the event came from.
- **`departed` is respected.** `src/bridge.ts` keeps a set of handles whose
  membership ended, and `arm()` refuses them. A bus-backed path must refuse
  them identically, or #113 comes back: a bridge pushing a room's events to a
  member who was evicted from it.
- **Peer content stays untrusted across the bus.** `renderEvent` escapes `<` at
  `deliver()` time in each bridge, so the bus carries raw `PeerEvent`s and the
  escaping happens on the last hop (D9).
- **A room holds many members, not two.** Say *members*, *the room*, or *peers*.
- Both `npm run typecheck` and `npm run typecheck:worker` must pass; `npm run
  verify` also runs `build`, the Node suite and `test:worker`.
- **No new runtime dependency.** Node 22's global `WebSocket` accepts a
  non-standard `headers` option and the `Authorization` header arrives —
  measured, and recorded in D2. The subprotocol is the fallback if that breaks.

## Review Focus

Five input classes the spec implies that a happy path will not exercise.

1. **Two bridges racing to be coordinator.** Both see `ENOENT`, both `listen()`.
   One gets `EADDRINUSE` and must connect instead, not fall back to polling.
2. **The coordinator dies mid-stream.** Subscribers see the socket close and
   race again; the winner reconnects upstream from its own cursor and the DO
   replays exactly what was missed. No event may be lost or doubled.
3. **A subscriber arrives with a cursor older than the window.** The coordinator
   syncs upstream for it, and the subscriber must not be able to tell.
4. **A member evicted while the bus is live.** `departed` must stop its pushes,
   and the coordinator must stop serving that subscriber.
5. **`sun_path` over the limit, or a sandbox that refuses the socket.** Fallback
   to polling, with every member still served.

---

### Task 1: `src/bus.ts` — election, framing, and the window

**Files:** create `src/bus.ts`; create `tests/bus.test.ts`.

**Produces:** `openBus(opts) -> Promise<Coordinator | Subscriber>`, where the
caller cannot tell which it got beyond a `role` field; `{ subscribe, session_id,
member_id, cursor }` as the NDJSON request; raw `PeerEvent`s as the stream.

- [ ] **Step 1: The socket is the lock (D8).** Try `connect`. Success → subscriber.
  `ECONNREFUSED`/`ENOENT` → unlink, `listen()`. `EADDRINUSE` → connect again.
  No lockfile, no pid liveness check: connectability *is* liveness. Path is
  `~/.claude/bellman/bus/<hash>.sock`, mode `0600`, hash over server URL and
  credential. Test both race orders with real sockets in a temp dir.
- [ ] **Step 2: NDJSON framing**, one JSON object per line, and a subscriber
  registry holding `{ sessionId, memberId, sentThrough }`.
- [ ] **Step 3: The window (D10).** Per-room ring bounded by **both** 500 events
  and 2 MB, oldest dropped. `MAX_PAYLOAD_CHARS` is 20,000, so a count-only
  bound is a 10 MB worst case.
- [ ] **Step 4: The gapless invariant (D9).** The coordinator never sends a
  subscriber anything at or below its `sentThrough`. One monotonic guard covers
  the window, an upstream catch-up and the live stream, so a subscriber never
  buffers and never dedupes against a second source.
- [ ] **Step 5: Window miss.** On a cursor below the window, call an injected
  `syncFrom(sessionId, memberId, cursor)` and stream its result ahead of the
  window. Per-subscriber queueing, so one slow catch-up cannot stall others.
  Inject the callback; the bus must not know what an MCP client is.
- [ ] **Step 6: Controls.** For each of Steps 1, 4 and 5, break it and watch the
  intended test go red. A mutation that does not go red is a finding.
- [ ] **Step 7:** `npm test`, both typechecks, commit.

---

### Task 2: `src/room-socket.ts` — the upstream connection

**Files:** create `src/room-socket.ts`; create `tests/room-socket.test.ts`;
extend `tests/helpers/fake-bellman.ts` with a `/ws` endpoint.

**Produces:** `openRoomSocket({ url, credential, sessionId, cursor, onEvent, log })`,
and a `degraded` signal the coordinator can ignore.

- [ ] **Step 1:** Connect to `/ws?session=…&cursor=…` with
  `Authorization: Bearer …` via Node's global `WebSocket` `headers` option.
  Frames are `publicEvent` shape — the same the poll returns.
- [ ] **Step 2: Reconnect with full jitter**, `random(0, min(cap, base × 2^n))`.
  The storm is already divided by session count (one socket per room, not per
  member per session); jitter is what stops a fleet resynchronising after a
  deploy.
- [ ] **Step 3: Degrade, do not fail (D11).** If the socket cannot be
  established or drops for good, long-poll upstream and keep serving the bus.
  Subscribers must not be able to tell. #99 failing never costs #43's collapse.
- [ ] **Step 4:** A 409 means the room closed — stop, do not retry. A 401 means
  the credential is gone: report it, do not reconnect in a loop.
- [ ] **Step 5:** Controls, then `npm test`, both typechecks, commit.

---

### Task 3: `src/bridge.ts` — wire it in, keep the fallback

**Files:** modify `src/bridge.ts`, `src/channel.ts`; modify `tests/bridge.test.ts`.

- [ ] **Step 1:** On `arm()`, open the bus. Coordinator opens a room socket per
  room; subscriber subscribes. Either way events reach `deliver()`, which does
  not change.
- [ ] **Step 2: `watch()` stays, untouched**, as the fallback (D11). Do not
  refactor it. Its existing tests must pass unmodified.
- [ ] **Step 3: `departed` is honoured on both paths.** A handle whose membership
  ended gets no pushes, and the coordinator drops that subscriber. Read the
  docblock on `departed` before writing this — it explains why most disarms must
  NOT be treated as permanent.
- [ ] **Step 4:** `shutdown()` in `channel.ts` closes the bus and, if
  coordinator, unlinks the socket. A `SIGKILL`ed coordinator leaves an
  unconnectable path, which the next bridge unlinks (D8).
- [ ] **Step 5: The cursor seam.** The bus guarantees no gaps; the bridge keeps
  its existing per-event `cursor <= w.delivered` guard, because a manual
  `bellman_sync` can still advance `delivered` out of band. No new dedupe.
- [ ] **Step 6:** Controls, `npm run verify`, commit.

---

### Task 4: Prove it end to end, and correct the docs

**Files:** create `tests/bus-e2e.test.ts`; modify `docs/ARCHITECTURE.md`;
modify `docs/superpowers/specs/2026-09-29-room-delivery-design.md` (status line).

- [ ] **Step 1: Two bridges, one room, one upstream connection.** #43's own
  definition of done: both receive every event; killing the coordinator makes
  the other take over without losing an event; with the socket unavailable both
  fall back to independent polling. Drive real bridges over a real Unix socket
  against the fake server.
- [ ] **Step 2: ARCHITECTURE.md.** §4's "Two delivery paths" is future-tense
  about #43 — make it present. §2's diagram has no `/ws` node. §7's invariant
  says "the client does the wrapping" is a contract on code that did not exist;
  it does now, so point at it.
- [ ] **Step 3:** The spec's `Status:` line still says the client half is
  pending. Update it.
- [ ] **Step 4:** `npm run verify`, then `npm run smoke` against `wrangler dev`
  with two bridges. Commit.

---

## Done when

- [ ] `npm run verify` green.
- [ ] Two bridges in one room produce **one** upstream connection, and killing
      the one holding it loses no event.
- [ ] With the bus unavailable, both bridges poll independently and every member
      is still served.
- [ ] `watch()` is byte-for-byte unchanged and its tests pass unmodified.
- [ ] An evicted member receives nothing on either path.
- [ ] Every control step has actually been run.
