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

## Writing

**A room holds many members, not two.** A `pair` room holds two because the
preset says so; a `swarm` room fills to the plan's limit, codes are reissuable to
add members later, and hub rooms are meant to accumulate members over weeks.
Never describe Bellman as a thing for "two sessions" or "the other session" — in
comments, docs, commit messages, PR bodies or issues. Say *members*, *the room*,
or *peers*, where a peer is any other member rather than a counterpart.

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

<!-- dgc-policy-v11 -->
# Dual-Graph Context Policy

This project uses a local dual-graph MCP server for efficient context retrieval.

## MANDATORY: Always follow this order

1. **Call `graph_continue` first** — before any file exploration, grep, or code reading.

2. **If `graph_continue` returns `needs_project=true`**: call `graph_scan` with the
   current project directory (`pwd`). Do NOT ask the user.

3. **If `graph_continue` returns `skip=true`**: project has fewer than 5 files.
   Do NOT do broad or recursive exploration. Read only specific files if their names
   are mentioned, or ask the user what to work on.

4. **Read `recommended_files`** using `graph_read` — **one call per file**.
   - `graph_read` accepts a single `file` parameter (string). Call it separately for each
     recommended file. Do NOT pass an array or batch multiple files into one call.
   - `recommended_files` may contain `file::symbol` entries (e.g. `src/auth.ts::handleLogin`).
     Pass them verbatim to `graph_read(file: "src/auth.ts::handleLogin")` — it reads only
     that symbol's lines, not the full file.
   - Example: if `recommended_files` is `["src/auth.ts::handleLogin", "src/db.ts"]`,
     call `graph_read(file: "src/auth.ts::handleLogin")` and `graph_read(file: "src/db.ts")`
     as two separate calls (they can be parallel).

5. **Check `confidence` and obey the caps strictly:**
   - `confidence=high` -> Stop. Do NOT grep or explore further.
   - `confidence=medium` -> If recommended files are insufficient, call `fallback_rg`
     at most `max_supplementary_greps` time(s) with specific terms, then `graph_read`
     at most `max_supplementary_files` additional file(s). Then stop.
   - `confidence=low` -> Call `fallback_rg` at most `max_supplementary_greps` time(s),
     then `graph_read` at most `max_supplementary_files` file(s). Then stop.

## Token Usage

A `token-counter` MCP is available for tracking live token usage.

- To check how many tokens a large file or text will cost **before** reading it:
  `count_tokens({text: "<content>"})`
- To log actual usage after a task completes (if the user asks):
  `log_usage({input_tokens: <est>, output_tokens: <est>, description: "<task>"})`
- To show the user their running session cost:
  `get_session_stats()`

Live dashboard URL is printed at startup next to "Token usage".

## Rules

- Do NOT use `rg`, `grep`, or bash file exploration before calling `graph_continue`.
- Do NOT do broad/recursive exploration at any confidence level.
- `max_supplementary_greps` and `max_supplementary_files` are hard caps - never exceed them.
- Do NOT dump full chat history.
- Do NOT call `graph_retrieve` more than once per turn.
- After edits, call `graph_register_edit` with the changed files. Use `file::symbol` notation (e.g. `src/auth.ts::handleLogin`) when the edit targets a specific function, class, or hook.

## Context Store

Whenever you make a decision, identify a task, note a next step, fact, or blocker during a conversation, call `graph_add_memory`.

**To add an entry:**
```
graph_add_memory(type="decision|task|next|fact|blocker", content="one sentence max 15 words", tags=["topic"], files=["relevant/file.ts"])
```

**Do NOT write context-store.json directly** — always use `graph_add_memory`. It applies pruning and keeps the store healthy.

**Rules:**
- Only log things worth remembering across sessions (not every minor detail)
- `content` must be under 15 words
- `files` lists the files this decision/task relates to (can be empty)
- Log immediately when the item arises — not at session end

## Session End

When the user signals they are done (e.g. "bye", "done", "wrap up", "end session"), proactively update `CONTEXT.md` in the project root with:
- **Current Task**: one sentence on what was being worked on
- **Key Decisions**: bullet list, max 3 items
- **Next Steps**: bullet list, max 3 items

Keep `CONTEXT.md` under 20 lines total. Do NOT summarize the full conversation — only what's needed to resume next session.
