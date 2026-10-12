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

## Architecture

`docs/ARCHITECTURE.md` is the whole-system view: the surfaces agents arrive
on, why the server is remote-first, the five Durable Object types, how a plan
resolves, the trust boundaries, and the cross-object atomicity gap that keeps
producing bugs. Read it before changing how the pieces fit together.

## Layout

- `src/server.ts` — `buildServer` and nothing else: one `McpServer` per request,
  bound to a caller identity, composed from `src/tools/`.
- `src/tools/` — one file per tool, plus `kit.ts` for what they share (the MCP
  result shape, the zod input shapes). A new tool is a new file here.
- `ui/` — the MCP Apps page (join screen and room monitor). `npm run build:ui` bundles it with
  Vite into `src/ui/assets.ts`, a generated string constant the server imports.
- `src/ui/resource.ts` — the one `ui://` resource and the `_meta` a tool carries to be rendered through it.
- `src/projections.ts` — `Session` in, wire object out. Runtime-free on purpose,
  so the HTTP routes can import it without the MCP SDK; `src/public-event.ts` is
  the same layer. `tests/projections.test.ts` asserts that, transitively.
- `src/store.ts` — `BellmanStore`, the storage boundary, plus `MemoryStore`.
- `src/store-do.ts` — the Durable Objects implementation that serves production.
- `src/oauth/` — the authorization server: tokens, storage, providers, routes.
- `src/billing/` — Stripe: the webhook, and the ledger of who has paid for what.
- `src/bridge.ts` / `src/channel.ts` / `src/stop-hook.ts` — the Claude Code client side.
- `src/worker.ts` — Workers entry. `src/index.ts` + `src/app.ts` — the Node one.
- `extension/` — the Claude Desktop `.mcpb` bundle: its manifest, and the script that packs it.

## Writing

**A room holds many members, not two.** A `pair` room holds two because the
preset says so; a `swarm` room holds as many members as its creator invites,
up to one ceiling for every plan, codes are reissuable to
add members later, and hub rooms are meant to accumulate members over weeks.
Never describe Bellman as a thing for "two sessions" or "the other session" — in
comments, docs, commit messages, PR bodies or issues. Say *members*, *the room*,
or *peers*, where a peer is any other member rather than a counterpart.

## Rules that are not obvious from the code

- **`main` moves only through merges.** Feature work happens on a branch, lands
  by PR. This repo is colocated with [jj](https://jj-vcs.github.io): a detached
  git HEAD is normal, and `jj` is the tool to drive it.
- **The store is truth; the channel is transport.** A room is its event log.
  Every path that log takes to a member — the `bellman_sync` long poll, a `/ws`
  frame, the Stop-hook fallback — may be late or dropped, so `bellman_sync` is
  authoritative and a push is a convenience. A tool's return says what the call
  *established*, never what it probably caused: `bellman_send` returns
  `room_members` (the other active members the call read just before appending,
  and on a replay the roster at the retry — not a read receipt), and
  `session_status` is read after a poll's wait so it is never older than the
  events beside it (#74), while still saying nothing about whether anyone is
  listening. Naming a return for its likely effect rather than its actual claim
  is the bug #82 fixed; don't reintroduce it.
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
- **A new tool means editing `extension/manifest.json`.** The Desktop bundle
  declares its tools by hand, and Claude Desktop shows that list at install.
  `tests/extension.test.ts` asserts it against a hook-mode bridge's real
  surface — the server's tools plus the bridge's own — so the manifest cannot
  silently fall behind. It already had: the list was missing `bellman_whoami`.
- **`src/ui/assets.ts` is generated and gitignored.** Edit `ui/`, never the generated
  file; every script that compiles or runs the server runs `build:ui` first, and wrangler
  runs it itself through `[build]` in `wrangler.toml`, so a fresh clone's `npm test` builds
  it and so does a bare `wrangler deploy`. Before that hook, #193 passed every check and
  failed to deploy. A page that reaches data does so by calling tools, never
  `bellman_sync`: through the bridge that would count as the agent having read the events.

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

## Agent skills

### Issue tracker

GitHub Issues on `bellman-sh/bellman`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical labels, unchanged: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root, created lazily. See `docs/agents/domain.md`.
