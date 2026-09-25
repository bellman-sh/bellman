# Bellman

Cross-session, cross-provider agent collaboration over MCP. A server (`src/`),
a local bridge for Claude Code (`src/bridge.ts`), and one deployment target
(Cloudflare Workers + Durable Objects).

## Commands

```bash
npm run verify        # typecheck + build + test — run before every commit
npm run typecheck:worker   # the Worker program; separate from the Node one
npm start             # local Node server on :3900 (MemoryStore)
npm run smoke         # end-to-end; BELLMAN_URL points it at any deployment
npm run dev:worker    # wrangler dev, real Durable Objects
```

## Layout

- `src/server.ts` — the tools. One `McpServer` per request, bound to a caller identity.
- `src/store.ts` — `BellmanStore`, the storage boundary, plus `MemoryStore`.
- `src/store-do.ts` — the Durable Objects implementation that serves production.
- `src/oauth/` — the authorization server: tokens, storage, providers, routes.
- `src/billing/` — Stripe: the webhook, and the ledger of who has paid for what.
- `src/bridge.ts` / `src/channel.ts` / `src/stop-hook.ts` — the Claude Code client side.
- `src/worker.ts` — Workers entry. `src/index.ts` + `src/app.ts` — the Node one.

## Rules that are not obvious from the code

- **`main` moves only through merges.** Feature work happens on a branch, lands
  by PR. This repo is colocated with [jj](https://jj-vcs.github.io): a detached
  git HEAD is normal, and `jj` is the tool to drive it.
- **Every `BellmanStore` method is async**, including ones `MemoryStore` answers
  instantly. A Durable Objects port resolves a join code in one object and the
  session in another, and every cross-object hop is RPC. A synchronous signature
  would be implementable only in memory.
- **Read and register in the same turn.** `waitForEvents` must not `await`
  between reading events and registering a waiter, or an event arriving in the
  gap wakes an empty list and the poll hangs to its timeout. There is a test.
- **Peer content is untrusted, everywhere.** It crosses wrapped, it is rendered
  with `<` escaped so it cannot break out of a channel tag, and action requests
  are approved by the receiving *human*. Any change that weakens this needs to
  say so out loud in the PR.
- **Workers-only files are excluded from the Node build** (`src/worker.ts`,
  `src/store-do.ts`, `src/oauth/store.ts`). They import `cloudflare:workers`,
  and their types otherwise leak into the Node program.
- **Two test programs.** Anything importing `cloudflare:workers` cannot be
  imported by a vitest test; put the shape in a runtime-free module beside it
  (see `src/oauth/storage.ts`).

## Testing

`tests/helpers/store-contract.ts` is the conformance suite every `BellmanStore`
implementation must pass identically — that is what makes the interface a seam
rather than a comment. Tool tests drive the real handlers through an in-memory
MCP client (`tests/helpers/harness.ts`).
