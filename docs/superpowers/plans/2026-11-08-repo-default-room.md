# Repo Default Room Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code session signed in as an account, started in a repo that account has bound to a room it
created, joins that room at launch with no join code, and leaves it when the session ends.

**Architecture:** The binding is a row in the account's home room (`rr`), beside the settings row (`hs`), written
only through dash-session routes. At launch the bridge reads the cwd's git remote and asks
`POST /me/repo-rooms/connect`, which re-checks the binding against the room and mints a pending connect exactly as
`bellman_connect` does; the bridge then calls `bellman_confirm` as the code join does, so every confirm-time check
(bans, org policy, capacity, frozen) is reused. A `keptOpen` flag on the room record makes `closeSessionIfEmpty`
leave a bound room open. The bridge leaves its bound seats in `close()`.

**Tech Stack:** TypeScript, vitest, Cloudflare Workers + Durable Objects, the MCP SDK.

**Spec:** `docs/superpowers/specs/2026-11-08-repo-default-room-design.md` (approved 2026-11-08).

## Global Constraints

- Every `BellmanStore` method is async, and both stores pass `tests/helpers/store-contract.ts` identically.
- Workers-only code lives in `src/workerd/`; anything a vitest test imports is runtime-free.
- Binding writes are dash-session only: a bearer gets 403 `dash_session_required`, and a write is CSRF-checked, as
  `PUT /me/memory` is (`meRoutes` in `src/http/me.ts`).
- A binding names only a room its account created (`session.createdBy === identity.userId`).
- A bound join never seats into a public room, a closed room, or for a banned account.
- No new MCP tool and no change to any tool's text: `extension/manifest.json`, `npm run docs:gen` and the tool budget
  are untouched. If a task finds it must change a tool, stop and ask.
- `BELLMAN_JOIN_CODE`, when set, wins: the bridge does not look for a binding.
- The bridge never prints or logs the connect token, and never passes the server's refusal text to the session (a
  refusal can name a peer), as `join` in `src/client/bridge.ts` does today.
- `npm run verify` before every commit. Commits with `jj commit -m`, on a branch, landed by PR.

## Review Focus

1. **ssh and https remotes of one repo.** `git@github.com:bellman-sh/bellman.git`,
   `https://github.com/bellman-sh/bellman`, `ssh://git@github.com/bellman-sh/bellman.git` and an upper-case host all
   bind to one row. Pinned in Task 3.
2. **The last bound seat leaving an otherwise empty room.** The room stays open, and the next bound session joins it.
   Pinned in Tasks 2 and 5.
3. **Deleting all memory.** `purgeHome` and `PUT /me/memory` leave bindings alone, since they are a separate row.
   Pinned in Task 1.
4. **A killed session.** No `close()` runs, so its seat stays; the next session takes a new seat and does not fail.
   Pinned in Task 6.
5. **A hand-joined seat in the same bridge.** `close()` leaves only seats taken through a binding. Pinned in Task 7.

---

### Task 1: The binding row in both stores

**Files:**
- Modify: `src/types.ts` (beside `HomeSettings`), `src/storage/store.ts` (beside `readHomeSettings`),
  `src/storage/memory-store.ts`, `src/workerd/store-do.ts` and the home-room handler that answers
  `readHomeSettings` in `src/workerd/` (follow `readHomeSettings` through both)
- Test: `tests/helpers/store-contract.ts`

**Interfaces:**
- Produces: `interface RepoRoom { remote: string; sessionId: string; role: string; createdAt: number }` in
  `src/types.ts`. `readRepoRooms(homeId: string): Promise<RepoRoom[]>` (empty when none; creates nothing) and
  `writeRepoRooms(homeId: string, rows: RepoRoom[]): Promise<void>` (replaces the row) on `BellmanStore`. The row's
  key is `rr`, in the home room, never read by `purgeHome` or the `hs` paths.

- [ ] **Step 1: Write the failing contract tests:** "repo rooms read empty for a home id never written", "repo rooms
  write and read back, detached from the caller's array", "purgeHome leaves repo rooms", "writeHomeSettings leaves
  repo rooms".
- [ ] **Step 2: Run `npx vitest run tests/` for the contract files; expected FAIL, `readRepoRooms is not a function`.**
- [ ] **Step 3: Implement both methods in `MemoryStore` (a `Map<string, RepoRoom[]>`, `detach` on read and write) and
  through the Durable Objects path exactly as `readHomeSettings`/`writeHomeSettings` travel.**
- [ ] **Step 4: Run the contract tests; expected PASS. Run `npm run typecheck:worker`; expected clean.**
- [ ] **Step 5: `npm run verify`, then `jj commit -m "Store: repo room bindings in the home room"`.**

### Task 2: A room kept open

**Files:**
- Modify: `src/types.ts` (`Session`: `keptOpen?: true`), `src/storage/store.ts`, `src/storage/memory-store.ts`
  (`closeSessionIfEmpty`), `src/workerd/session-do.ts` (`closeSessionIfEmpty`), `src/workerd/store-do.ts`
- Test: `tests/helpers/store-contract.ts`

**Interfaces:**
- Produces: `setKeptOpen(sessionId: string, kept: boolean): Promise<void>` on `BellmanStore` (no-op for an unknown or
  closed room; `false` removes the field). `closeSessionIfEmpty` answers `false` for a room with `keptOpen`, still
  inside its no-await / transaction rule.

- [ ] **Step 1: Write the failing contract tests:** "a kept room is not closed by closeSessionIfEmpty when its last
  member leaves", "setKeptOpen(false) lets it close on the next empty check", "closeSession still closes a kept room".
- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement.** In `MemoryStore.closeSessionIfEmpty`, check `s.keptOpen` beside `s.members.some(isActivePerson)`; the DO reads the
  same field in the same transaction.
- [ ] **Step 4: Run them; expected PASS. `npm run typecheck:worker` clean.**
- [ ] **Step 5: `npm run verify`, then `jj commit -m "Store: a room kept open is not closed when it empties"`.**

### Task 3: Remote normalization

**Files:**
- Create: `src/room/repo-room.ts` (runtime-free)
- Test: `tests/repo-room.test.ts`

**Interfaces:**
- Produces: `normalizeRemote(raw: string): string | null`, answering `host/owner/repo`, host lower-cased, owner and
  repo as given, no `.git`, no user or credentials, no trailing slash; null for anything that is not an ssh, scp-style
  or http(s) remote with at least two path segments.

- [ ] **Step 1: Write the failing tests:** each of the four forms in Review Focus 1 gives `github.com/bellman-sh/bellman`;
  `https://user:token@github.com/a/b.git` gives `github.com/a/b`; `""`, `"not a url"`, `"https://github.com/"` give null.
- [ ] **Step 2: Run `npx vitest run tests/repo-room.test.ts`; expected FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; expected PASS.**
- [ ] **Step 5: `jj commit -m "Repo room: normalize a git remote"`.**

### Task 4: Binding routes

**Files:**
- Modify: `src/room/repo-room.ts`, `src/http/me.ts` (`meRoutes`), `src/http/EGM.md`
- Test: `tests/http-app.test.ts` (beside the `/me/memory` cases)

**Interfaces:**
- Consumes: Task 1's store methods, Task 2's `setKeptOpen`, Task 3's `normalizeRemote`.
- Produces, in `src/room/repo-room.ts`:
  `bindRepoRoom(store, actor: Identity, input: { remote: string; sessionId: string; role: string }): Promise<RoomResult<RepoRoom>>`
  and `unbindRepoRoom(store, actor: Identity, remote: string): Promise<RoomResult<{ removed: boolean }>>`.
  Bind refuses `invalid_request` (remote does not normalize), `not_found` (no room, or closed), `not_creator`,
  `public_room`, `unknown_role` (not in the manifest's roles); replaces any row for the same remote; then
  `setKeptOpen(sessionId, true)`. Unbind removes the row, then `setKeptOpen(sessionId, false)` when no remaining row
  of the account names that room.
- Routes: `GET /me/repo-rooms` → 200 `{ repo_rooms: [{ remote, session_id, role, created_at }] }` (bearer allowed:
  the caller's own rows). `PUT /me/repo-rooms` body `{ remote, session_id, role }` → 200 the row, and
  `DELETE /me/repo-rooms?remote=` → 204 | 404 `not_found`; both cookie only and CSRF-checked.

- [ ] **Step 1: Write the failing tests:** a dash PUT binds and GET lists it; a bearer PUT and DELETE get 403
  `dash_session_required`; binding a room another account created gets 403 `not_creator`; a public room 409
  `public_room`; a role not in the manifest 400 `unknown_role`; a second PUT for the same remote in another URL form
  replaces the first; after DELETE of the only binding, the room closes when its last member leaves.
- [ ] **Step 2: Run them; expected FAIL with 404s.**
- [ ] **Step 3: Implement the two operations and the three routes. Add the routes to `src/http/EGM.md` with citations.**
- [ ] **Step 4: Run; expected PASS.**
- [ ] **Step 5: `npm run verify`, then `jj commit -m "Me routes: bind a repo to a room, dash only"`.**

### Task 5: Connect from a binding

**Files:**
- Modify: `src/types.ts` (`PendingConnect.via` and `Member.via` become `"permanent" | "binding"`),
  `src/room/repo-room.ts`, `src/http/me.ts`, `src/http/EGM.md`
- Test: `tests/http-app.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 4. `generateConnectToken`, `CONNECT_TOKEN_TTL`, `putPendingConnect` and `audit` as
  `src/tools/connect.ts` uses them.
- Produces: `connectFromBinding(store, actor: Identity, remote: string): Promise<RoomResult<{ connectToken: string; sessionId: string; role: string }>>`.
  Refuses `no_binding` (404), and, re-checked against the room now, `closed`, `public_room`, `not_creator`,
  `unknown_role` and `banned` (`isBannedByCreator`), each 409 with that code; capacity, org policy and frozen are left
  to `bellman_confirm`. Writes a pending connect with `via: "binding"` and audits `connect_previewed` as
  `bellman_connect` does. Route: `POST /me/repo-rooms/connect` body `{ remote }`, bearer allowed →
  200 `{ connect_token, session_id, role }`.
- Every reader of `via` compares `=== "permanent"` today (`src/room/send-limit.ts`), so a `"binding"` seat gets the
  member send limit; keep it that way.

- [ ] **Step 1: Write the failing tests:** a bound remote returns a token that `bellman_confirm` redeems into a seat
  with `via: "binding"` and the bound role; an unbound remote 404 `no_binding`; a room made public after binding 409
  `public_room`; a banned account 409 `banned`; a closed room 409 `closed`; two connects in a row both seat (a new
  seat each, Review Focus 4); with the room's only other member gone, the bound member leaving keeps the room open
  and a second connect seats again (Review Focus 2).
- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; expected PASS.**
- [ ] **Step 5: `npm run verify`, then `jj commit -m "Me routes: a connect token from a repo binding"`.**

### Task 6: The bridge joins from a binding

**Files:**
- Create: `src/client/repo-remote.ts`
- Modify: `src/client/bridge.ts` (beside `join`), `src/client/channel.ts` (the `BELLMAN_JOIN_CODE` launch line),
  `src/client/door-protocol.ts` (`DoorJoin`), `src/client/join-hook.ts` (`joinLine`, `main`), `mod/types/` (if it
  repeats `DoorJoin`), `src/client/EGM.md`
- Test: the bridge's existing join tests (find them by `BELLMAN_JOIN_CODE` under `tests/`), `tests/join-hook.test.ts`
  or wherever `joinLine` is tested

**Interfaces:**
- Consumes: Task 3's `normalizeRemote`, Task 5's route.
- Produces: `remoteOf(cwd: string): string | null` in `src/client/repo-remote.ts`: `git -C <cwd> remote get-url origin`,
  else `jj git remote list` run in `cwd` and its `origin` line, each through `execFileSync` with a 2-second timeout,
  normalized; null on any failure. `joinBound(remote: string, project: string): Promise<DoorJoin | undefined>` on
  the bridge: undefined (and `joined` left undefined, so nothing is printed) on 404 `no_binding`; otherwise the
  `join` flow from `bellman_confirm` onward, with the same brief, recording the seat in a `boundSeats: Set<string>`
  of member ids. `DoorJoin` gains `from: "code" | "repo"`. A POST helper beside `readOwn`, with its 401 handling.
- On every outcome but "no binding", push one channel notification (`notifications/claude/channel`, as `deliver`
  does) whose content is `joinLine(joined)`, so the session hears it without the plugin.
- `joinLine` says "from this repo's default room" for `from: "repo"`, and the hook's `main` asks the door when no
  code is set, printing only when a join is reported.

- [ ] **Step 1: Write the failing tests:** `remoteOf` on a temp git repo with an ssh origin; `remoteOf` on a temp dir
  with no repo is null; `joinBound` with a stubbed server seats and arms a watch; on `no_binding` it reports nothing
  and pushes nothing; on a 409 it reports `refused` with the bridge's own words, not the server's; with
  `BELLMAN_JOIN_CODE` set, channel.ts calls `join` and not `joinBound`; `joinLine` for each `from`.
- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement. In `channel.ts`: `if (joinCode) void bridge.join(...) else { const r = remoteOf(process.cwd()); if (r) void bridge.joinBound(r, basename(process.cwd())); }`, before the door is awaited, for the reason the code join is.**
- [ ] **Step 4: Run; expected PASS.**
- [ ] **Step 5: `npm run verify`, then `jj commit -m "Bridge: join a repo's default room at launch"`.**

### Task 7: The bridge leaves its bound seats

**Files:**
- Modify: `src/client/bridge.ts` (`close`), `src/client/EGM.md`
- Test: the bridge's tests

**Interfaces:**
- Consumes: Task 6's `boundSeats`.
- Produces: `close()` calls `bellman_leave` `{ session_id, member_id }` through `live` (never `remote()`) for each
  member in `boundSeats` still watched, in parallel, bounded at 3 seconds in all, before `link?.close()`; a failure is
  logged and does not stop the close.

- [ ] **Step 1: Write the failing tests:** a bridge holding one bound and one hand-joined seat calls `bellman_leave`
  for the bound one only (Review Focus 5); a `bellman_leave` that never answers does not hold `close()` past 3 seconds
  (fake timers); a bridge with no live connection closes without trying.
- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; expected PASS.**
- [ ] **Step 5: `npm run verify`, then `jj commit -m "Bridge: leave bound seats on shutdown"`.**

### Task 8: End to end and the dash follow-up

**Files:**
- Modify: `scripts/` smoke (if it has a join section; otherwise none), `docs-site/src/content/docs/` (the connect
  page: one section, "A repo's default room")

- [ ] **Step 1: In `npm run dev:worker`, bind a room with a dash cookie, start `node dist/client/channel.js` in a
  checkout of this repo, and confirm the seat appears with `via: "binding"`; kill it with SIGTERM and confirm
  `member_left`; confirm the empty room is still open.**
- [ ] **Step 2: Write the docs-site section; `npm --prefix docs-site run build` passes.**
- [ ] **Step 3: File the dash issue on `bellman-sh/dash`: a "Repo default rooms" list on the account page and a
  "Make this a repo's default room" control on a room the account created, over Task 4's routes.**
- [ ] **Step 4: `npm run verify`, `jj commit -m "Docs: a repo's default room"`, push, open the PR.**
