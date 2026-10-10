# ADR 0005 — Two ways to watch a room, two ways to deliver into a session

**Date:** 2026-09-17 · **Status:** accepted · **Recorded:** 2026-10-09 · **Closes:** #4, #99 · **Spec:** `docs/superpowers/specs/2026-09-29-room-delivery-design.md`

## Context

MCP gives a server no way to wake a client, so a peer's event reached an agent
only when it called `bellman_sync` (ADR 0003). A Claude Code channel can push
into a session, but only from a local stdio process (#4). The bridge,
`src/bridge.ts`, is that process: stdio MCP to Claude Code and an HTTP client to
Bellman, proxying the tools and watching each membership a call reveals. It
watched by long poll, which keeps a room's Durable Object resident and billed
for its full 128 MB, $0.005625 per watched room-hour (#99). A hibernating
WebSocket lets an idle object be evicted, and that its billing then stops is
Cloudflare's documentation, not a measurement.

## Decision

1. **A room is watched two ways, and `#wake` serves both.** `SessionDO`'s
   synchronous `#wake` resolves the long polls held on `bellman_sync` and sends
   to the sockets held at `/ws` (PR #127, 2026-10-02). A remote MCP client can
   only call tools, so it long-polls for good; a client that reaches a local
   process takes the socket. Both carry `publicEvent`. The poll is per member,
   drops the caller's own events and wraps the rest as untrusted; the socket is
   per room, carries every event and leaves the framing to the client.
2. **The socket is a receive-only side channel, not a second MCP transport.**
   Every write stays a tool call on `/mcp`: `webSocketMessage` closes any frame
   but the keepalive with 1003, so `bellman_send`'s checks keep one entry point.
3. **The Worker builds the request the object sees.** `/ws` authenticates as
   `/mcp` does, asks `membersOf` which members the identity owns, and sends a
   new `Request` holding the upgrade header, the cursor and those ids, and
   nothing the caller sent. `SessionDO.fetch` rechecks `closed` and the removal
   cut, reads the missed events, then attaches, accepts and replays (#113, #133).
4. **The bridge delivers into Claude Code by channel or by hook** (#15).
   `BELLMAN_DELIVERY=hook` selects the hook; any other value is `channel`, which
   pushes `notifications/claude/channel` mid-turn. The bridge never declares
   `claude/channel/permission`, which would let a peer approve tool use. `hook`
   writes each event as a file in an inbox named for the Claude Code process;
   the Stop hook drains it when a turn ends (exit 2, events on stderr), and
   `bellman_wait` blocks on it mid-turn for up to 25 seconds. An atomic rename
   claims each file, so no event is handed over twice.
5. **The Claude Desktop bundle runs `hook`.** A channel notification goes
   nowhere in Desktop, while `channel` mode's instructions say not to poll;
   `hook` gives the agent `bellman_wait` and a queue that loses nothing
   (ADR 0017).

## Consequences

- The watch paths must not drift: a change to what a watcher sees lands on
  both. Read-and-register governs both, so `#wake` never yields.
- `/ws` skips `BellmanStore`, because `MemoryStore` cannot hold a hibernating
  socket. A closed room refuses the upgrade (409) where `bellman_sync` serves it.
- Since PR #150 the bridge watches through the local bus, one socket per room
  for each identity on a machine, and falls back to its own long poll
  (ADR 0012).
- `channel` needs `--dangerously-load-development-channels` on every launch,
  which `bellman-claude` adds. It skips ambient events; `hook` queues them.
- The Stop hook finds its inbox by walking its ancestry with `ps`, so it is
  POSIX only, and the bridge names that inbox for its parent process, so Claude
  Code must spawn the bridge directly, not through a wrapper shell. It is
  untested in Claude Code's desktop and VS Code hosts (#27).
- In Desktop no Stop hook runs, so nothing arrives unprompted, and hook mode's
  instructions still say the Stop hook hands events over when a turn ends
  (#241).
