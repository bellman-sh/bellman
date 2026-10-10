# ADR 0004 — The store is truth, the channel is transport

**Date:** 2026-10-06 · **Status:** accepted · **Recorded:** 2026-10-09 · **Closes:** #74, #82

## Context

MCP gives a server no way to wake a client (ADR 0003), so a room's events reach
a member through a `bellman_sync` long poll, a `/ws` frame, the bridge's channel
push or its Stop-hook queue (ADR 0005), and any of them can be late or dropped.
Two tool returns claimed more than that. `bellman_send` returned `delivered_to`,
a list of labels that read as a delivery when it meant that an event was
appended while those members were in the room (#82). `bellman_sync` derived
`session_status` from the record it read before a long poll of up to 25
seconds, so a room frozen during the wait still read `active`, and the first an
agent learned of the freeze was a refused send (#74). #82 also asked for the
axiom in the README and `CLAUDE.md`, as OpenRig writes "tmux is transport, not
truth".

## Decision

1. **A room is its event log, and `bellman_sync` from a cursor is the
   authoritative read.** Every other path is transport: a push is a
   convenience, and nothing depends on one arriving. Every surface works by
   polling (ARCHITECTURE.md §10, invariant 6).
2. **A tool's return says what the call established, never what it probably
   caused.** `bellman_send` returns `room_members`: the other active members the
   call read before appending, without the sender's own seat, and on a replayed
   send the roster at the retry. It is not a read receipt, and it does not say
   who can read the event: a member who left reads on and is not listed. It
   replaced `delivered_to` (#82, PR #176).
3. **`session_status` is read after the poll's wait.** A `bellman_sync` that
   could wait re-reads the session after its events, so the status is never
   older than they are (#74, PR #169). A poll that asked for no wait, and a
   removed member's poll, which never waits, keep the record the call began
   with. `active` means neither frozen nor closed, and says nothing about
   whether anyone is listening.
4. **What the log can answer is derived from it.** An `action_request` is
   outstanding, answered, declined or expired by a reading of the log, never by
   a stored status (#81), and `lastActionRequestAt` only decides whether to read
   the log at all. `removed: true` comes from the cut the record holds
   (`removedAtCursor`), never from a `member_evicted` found in the slice,
   because a client that reads it stops watching for good.

## Consequences

- The bridge moves its watcher's cursor before it delivers, and a failed
  channel push is logged and not retried: the event stays in the log for the
  agent's next `bellman_sync`. A `bellman_sync` the agent makes itself moves
  the watcher's cursor and discards queued copies (`seenThrough`,
  `discardThrough`), so nothing it has read is delivered again.
- An ambient event, such as a `progress` report, is not pushed into a channel
  session; it reaches the agent on its next `bellman_sync`.
- Peer content keeps its untrusted wrapper the whole way (ADR 0008): the poll
  wraps at the tool boundary, and the bridge renders every event with `<`
  escaped, whichever path brought it.
- A poll that waited costs one more session read.
- Renaming `delivered_to` was a breaking change to the tool surface, made
  before 1.0.
- `README.md` ("What a send proves") and `CLAUDE.md` state the rule, and the
  `bellman_send` description repeats it to the model.
