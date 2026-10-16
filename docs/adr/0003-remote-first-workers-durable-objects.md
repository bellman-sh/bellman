# ADR 0003 — Remote-first, on Workers and Durable Objects

**Date:** 2026-09-16 · **Status:** accepted · **Recorded:** 2026-10-09 · **Closes:** #6

## Context

A Claude Code cloud session runs in Anthropic's infrastructure. Nobody passes it
flags, and no machine of its user's is there for it to open a socket back to: it
can reach an HTTPS endpoint and sign in with OAuth, and nothing else. A design
that coordinates agents through a daemon, a tmux session or a Unix socket cannot
reach it, nor an agent on a teammate's machine. The server imported on
2026-09-09 was already stateless Streamable HTTP over a store interface
(`QuoraiStore` then, `BellmanStore` from 2026-09-15), with `MemoryStore` in one
process's memory. #6 shaped the deployment around one
Durable Object per room, which natively holds long-poll connections, serialises
a room's calls and is placed near whoever created it.

## Decision

1. **Bellman is a hosted MCP server, and nothing local is required to use it.**
   Every request builds a fresh `McpServer` bound to the caller over a stateless
   transport, in `src/worker.ts` as in `src/app.ts`: the room lives in the
   store, not the transport. The local bridge is optional and adds push (ADR 0005).
2. **Production is a Cloudflare Worker over Durable Objects.** `src/worker.ts`
   serves `mcp.bellman.sh` through `DurableObjectStore` (`src/store-do.ts`), and
   CI runs `wrangler deploy` once `verify` passes on `main`. #11 names the long
   poll as the reason for the target: under `wrangler dev`, a wait held across
   the hop from Worker to object resolved 8 ms after the send.
3. **Each object type matches a scope in the data.** `SessionDO` is one per
   room. `RegistryDO` is a singleton for what resolves without a room in hand:
   join codes, connect tokens, plan grants and the indexes. `AuditDO` is per org,
   so a cross-org room writes into each org's own stream. `AuthDO` is a
   singleton for OAuth state and the Stripe ledger (ADR 0013, ADR 0014), and
   `HostDO` is one per hosted seat, keyed by the room's id (ADR 0002). All five
   are SQLite-backed.
4. **Every `BellmanStore` method is async** (#10). A join code resolves in one
   object and its room in another, and every hop is RPC, so a synchronous
   signature could be implemented only in memory.
5. **The Node server with `MemoryStore` is for local development.** `npm start`
   has no OAuth, no `/ws` and no billing, takes a static key map, and runs
   `sweep` and `tick` across every room on a 60-second timer, the work each
   `SessionDO`'s alarm does for its own room. `DurableObjectStore.sweep` is a
   no-op, because a namespace cannot be iterated.

## Consequences

- MCP gives a server no way to wake a client, so every surface has a long poll
  and push is a layer over it (ADR 0004, ADR 0005). No transaction spans two
  objects (ADR 0006).
- `tests/helpers/store-contract.ts` runs against `MemoryStore` in the root
  vitest program and against `DurableObjectStore` in workerd in `worker-tests/`
  (#12). Files importing `cloudflare:workers` stay out of the Node build.
- `/ws` reaches the object directly, because `MemoryStore` cannot hold a
  hibernating socket, so the Node server serves the long poll alone.
- A Worker with neither `BELLMAN_KEYS` nor OAuth answers 503 (`unconfigured`),
  and `resolveCaller` calls `resolveIdentity` only when a key map is set, so the
  dev key table `resolveIdentity` falls back to never serves a public URL (#9,
  #11).
- Durable Object storage has no schema and no migration step: a stored room is
  read through `hydrateStoredSession`, and a change that rewrites rows can rule
  out rolling back (ADR 0001).
